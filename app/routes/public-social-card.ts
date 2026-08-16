import { requireValue } from "~/lib/required-value";
import { PublicProgrammeService } from "~/modules/programme/public-programme-service.server";
import { PublishedPublicSiteInvariantError } from "~/modules/public-site/public-site-errors";
import { publishedPublicSiteInvariantResponse } from "~/modules/public-site/public-site-presentation";
import { getValidatedPublishedPublicSite } from "~/modules/public-site/validated-public-site.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/public-social-card";

function xml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function wrap(value: string, maximum = 34) {
  const words = value.trim().split(/\s+/u);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    if (line && `${line} ${word}`.length > maximum) {
      lines.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

export function publishedSocialCardAccent(value: string) {
  if (!/^#[0-9a-f]{6}$/iu.test(value))
    throw new PublishedPublicSiteInvariantError(
      "The published event brand accent is invalid.",
    );
  return value;
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  if (!env.IMAGES)
    throw new Response("Social card generation is temporarily unavailable.", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  const slug = params.slug ?? "";
  const programme = await new PublicProgrammeService(env).getPublished(slug);
  const site = await getValidatedPublishedPublicSite(env, slug, programme);
  if (!site)
    throw new Response("Published public event site not found", {
      status: 404,
    });
  const searchParams = new URL(request.url).searchParams;
  for (const name of new Set(searchParams.keys())) {
    if (
      (name !== "speaker" && name !== "v") ||
      searchParams.getAll(name).length !== 1
    )
      throw new Response("Unsupported social-card parameter", { status: 400 });
  }
  const requestedVersion = searchParams.get("v");
  const currentVersion = programme
    ? `${programme.contentRevision}-${site.contentRevision}-${site.revision}`
    : `${site.contentRevision}-${site.revision}`;
  if (requestedVersion !== null && requestedVersion !== currentVersion)
    throw new Response("Social-card revision not found", { status: 404 });
  const speakerId = searchParams.get("speaker");
  const speaker =
    speakerId && programme
      ? programme.speakers.find((candidate) => candidate.id === speakerId)
      : null;
  if (speakerId && !speaker)
    throw new Response("Published speaker not found", { status: 404 });
  const session =
    speaker && programme
      ? programme.sessions.find((candidate) =>
          speaker.sessionIds.includes(candidate.id),
        )
      : null;
  if (speaker && !session)
    throw new Response(
      "The published speaker is not linked to a published session.",
      { status: 500, headers: { "cache-control": "no-store" } },
    );
  const title = speaker
    ? `${speaker.displayName} is speaking`
    : site.event.name;
  const subtitle = speaker
    ? requireValue(session, "Required session is unavailable.").title
    : site.configuration.tagline || site.event.description || "Public event";
  const place = [site.event.venue, site.event.city].filter(Boolean).join(" · ");
  const eventContext = [
    site.event.startDate === site.event.endDate
      ? site.event.startDate
      : `${site.event.startDate} – ${site.event.endDate}`,
    place,
  ]
    .filter(Boolean)
    .join(" · ");
  const titleLines = wrap(title, 30);
  const subtitleLines = wrap(subtitle, 58);
  let accent: string;
  try {
    accent = publishedSocialCardAccent(site.event.brandAccent);
  } catch (error) {
    if (error instanceof PublishedPublicSiteInvariantError)
      throw publishedPublicSiteInvariantResponse();
    throw error;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
    <rect width="1200" height="630" fill="#111c1b"/>
    <circle cx="1080" cy="-20" r="320" fill="${xml(accent)}" opacity="0.28"/>
    <rect x="72" y="68" width="14" height="494" rx="7" fill="${xml(accent)}"/>
    <text x="122" y="126" fill="#c9d4d2" font-family="Inter,Arial,sans-serif" font-size="30" font-weight="650">${xml(speaker ? site.event.name : eventContext)}</text>
    ${titleLines.map((line, index) => `<text x="122" y="${235 + index * 76}" fill="#ffffff" font-family="Inter,Arial,sans-serif" font-size="64" font-weight="800">${xml(line)}</text>`).join("")}
    ${subtitleLines.map((line, index) => `<text x="122" y="${445 + index * 42}" fill="#c9d4d2" font-family="Inter,Arial,sans-serif" font-size="30">${xml(line)}</text>`).join("")}
    <text x="122" y="570" fill="${xml(accent)}" font-family="Inter,Arial,sans-serif" font-size="24" font-weight="700">${programme ? "PUBLIC EVENT PROGRAMME" : "PUBLIC EVENT"}</text>
  </svg>`;
  try {
    const rendered = await env.IMAGES.input(
      new Blob([svg], { type: "image/svg+xml" }).stream(),
    ).output({ format: "image/webp", quality: 90, anim: false });
    if (rendered.contentType() !== "image/webp")
      throw new Error("Image rendering returned an unexpected content type.");
    return new Response(rendered.image(), {
      headers: {
        "content-type": "image/webp",
        "cache-control": requestedVersion
          ? "public, max-age=31536000, immutable"
          : "public, max-age=300, stale-while-revalidate=3600",
        "content-disposition": `inline; filename="${speaker ? "speaker" : "event"}-social-card.webp"`,
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    console.error("Public social-card rendering failed", error);
    throw new Response("The social card could not be rendered.", {
      status: 503,
      headers: { "cache-control": "no-store" },
    });
  }
}
