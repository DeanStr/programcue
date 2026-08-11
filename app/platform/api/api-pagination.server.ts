import { z, type ZodType } from "zod";

import { ApiError } from "./api.server";

const privateCursorSchema = z
  .object({
    version: z.literal(1),
    sort: z.number().int().nonnegative(),
    id: z.string().min(1).max(200),
  })
  .strict();

const publicCursorSchema = z
  .object({
    version: z.literal(2),
    collectionRevision: z.string().regex(/^[a-f0-9]{64}$/u),
    offset: z.number().int().nonnegative(),
  })
  .strict();

function encode(value: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decode(value: string) {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new ApiError(
      422,
      "INVALID_CURSOR",
      "cursor is invalid or no longer supported",
    );
  }
}

export function encodePrivateCursor(sort: number, id: string) {
  return encode({ version: 1, sort, id });
}

export function decodePrivateCursor(value: string) {
  const result = privateCursorSchema.safeParse(decode(value));
  if (!result.success) {
    throw new ApiError(
      422,
      "INVALID_CURSOR",
      "cursor is invalid or no longer supported",
    );
  }
  return result.data;
}

export function encodePublicCursor(collectionRevision: string, offset: number) {
  return encode({ version: 2, collectionRevision, offset });
}

export function decodePublicCursor(value: string, collectionRevision: string) {
  const result = publicCursorSchema.safeParse(decode(value));
  if (!result.success) {
    throw new ApiError(
      422,
      "INVALID_CURSOR",
      "cursor is invalid or no longer supported",
    );
  }
  if (result.data.collectionRevision !== collectionRevision) {
    throw new ApiError(
      409,
      "PUBLICATION_CHANGED",
      "The published collection or its filters changed; restart pagination without a cursor",
    );
  }
  return result.data.offset;
}

export function parseStrictQuery<T>(
  request: Request,
  schema: ZodType<T>,
  message = "The query parameters are invalid",
): T {
  const search = new URL(request.url).searchParams;
  const values: Record<string, string> = {};
  for (const key of new Set(search.keys())) {
    const entries = search.getAll(key);
    if (entries.length !== 1) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        `${key} may only be supplied once`,
      );
    }
    values[key] = entries[0]!;
  }
  const parsed = schema.safeParse(values);
  if (!parsed.success) {
    throw new ApiError(422, "VALIDATION_ERROR", message, parsed.error.issues);
  }
  return parsed.data;
}

export function isoTimestamp(value: number | null) {
  return value === null ? null : new Date(value * 1_000).toISOString();
}
