import { z } from "zod";

import {
  ResponseBodyTooLargeError,
  readBoundedResponseText,
} from "~/platform/http/read-response";

const MAX_PROFILE_BYTES = 512_000;

export class SessionizeProfileImportError extends Error {
  constructor(
    message: string,
    readonly kind: "input" | "provider",
  ) {
    super(message);
    this.name = "SessionizeProfileImportError";
  }
}

function decodeHtml(value: string) {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    hellip: "…",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };
  const numericEntity = (entity: string, radix: number, offset: number) => {
    const codePoint = Number.parseInt(entity.slice(offset), radix);
    return Number.isInteger(codePoint) &&
      codePoint >= 0 &&
      codePoint <= 0x10ffff &&
      !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      ? String.fromCodePoint(codePoint)
      : "�";
  };
  return value
    .replace(/<[^>]*>/gu, " ")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (match, entity: string) => {
      if (entity.startsWith("#x")) {
        return numericEntity(entity, 16, 2);
      }
      if (entity.startsWith("#")) {
        return numericEntity(entity, 10, 1);
      }
      return named[entity.toLowerCase()] ?? match;
    })
    .replace(/\s+/gu, " ")
    .trim();
}

function classText(html: string, tag: string, className: string) {
  const pattern = new RegExp(
    `<${tag}[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/${tag}>`,
    "iu",
  );
  const match = pattern.exec(html);
  return match ? decodeHtml(match[1] ?? "") : "";
}

function biographyText(html: string) {
  const opening =
    /<div\b[^>]*class=["'][^"']*\bc-s-speaker-info__bio\b[^"']*["'][^>]*>/iu.exec(
      html,
    );
  if (!opening) return "";

  const divTag = /<\/?div\b[^>]*>/giu;
  divTag.lastIndex = opening.index;
  let depth = 0;
  for (let match = divTag.exec(html); match; match = divTag.exec(html)) {
    const tag = match[0];
    if (/^<\/div\b/iu.test(tag)) {
      depth -= 1;
      if (depth === 0) {
        const contentStart = opening.index + opening[0].length;
        return decodeHtml(html.slice(contentStart, match.index));
      }
    } else if (!/\/\s*>$/u.test(tag)) {
      depth += 1;
    }
  }

  // An incomplete provider container must not be accepted as a partial bio.
  return "";
}

export function parseSessionizeProfileHtml(html: string) {
  const name = classText(html, "h1", "c-s-speaker-info__name");
  const tagline = classText(html, "p", "c-s-speaker-info__tagline");
  const biography = biographyText(html);
  if (!name) {
    throw new SessionizeProfileImportError(
      "Sessionize did not return a recognizable public speaker profile.",
      "provider",
    );
  }
  if (!biography) {
    throw new SessionizeProfileImportError(
      "That Sessionize profile does not include a public biography to import.",
      "provider",
    );
  }
  const parsed = z
    .object({
      name: z.string().trim().min(1).max(120),
      tagline: z.string().trim().max(180),
      biography: z.string().trim().max(5_000),
    })
    .safeParse({ name, tagline, biography });
  if (!parsed.success) {
    throw new SessionizeProfileImportError(
      "The public Sessionize profile contains details that are too long to import.",
      "provider",
    );
  }
  return parsed.data;
}

export function normalizeSessionizeProfileUrl(input: string) {
  const trimmed = input.trim();
  const candidate = /^[a-zA-Z0-9_-]{2,80}$/u.test(trimmed)
    ? `https://sessionize.com/${trimmed}/`
    : trimmed;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new SessionizeProfileImportError(
      "Enter a Sessionize public-profile URL or vanity name.",
      "input",
    );
  }
  const segments = url.pathname.split("/").filter(Boolean);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "sessionize.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    segments.length !== 1 ||
    !/^[a-zA-Z0-9_-]{2,80}$/u.test(segments[0] ?? "")
  ) {
    throw new SessionizeProfileImportError(
      "Use a public profile directly below https://sessionize.com/.",
      "input",
    );
  }
  return `https://sessionize.com/${segments[0]}/`;
}

export async function importSessionizeProfile(
  input: string,
  fetcher: typeof fetch = fetch,
) {
  const sourceUrl = normalizeSessionizeProfileUrl(input);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    let response: Response;
    try {
      response = await fetcher(sourceUrl, {
        headers: {
          accept: "text/html",
          "user-agent": "ProgramCue-Sessionize-Profile-Import/1.0",
        },
        redirect: "error",
        signal: controller.signal,
      });
    } catch (error) {
      if (
        error instanceof TypeError ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        throw new SessionizeProfileImportError(
          "Sessionize could not be reached. No profile details were changed.",
          "provider",
        );
      }
      throw error;
    }
    if (!response.ok) {
      throw new SessionizeProfileImportError(
        response.status === 404
          ? "That public Sessionize profile was not found."
          : "Sessionize did not return the public profile.",
        "provider",
      );
    }
    if (!response.headers.get("content-type")?.includes("text/html")) {
      throw new SessionizeProfileImportError(
        "Sessionize returned an unsupported profile response.",
        "provider",
      );
    }
    let html: string;
    try {
      html = await readBoundedResponseText(response, MAX_PROFILE_BYTES);
    } catch (error) {
      if (error instanceof ResponseBodyTooLargeError) {
        throw new SessionizeProfileImportError(
          "The Sessionize profile response is too large to import safely.",
          "provider",
        );
      }
      throw error;
    }
    return {
      ...parseSessionizeProfileHtml(html),
      sourceUrl,
    };
  } finally {
    clearTimeout(timeout);
  }
}
