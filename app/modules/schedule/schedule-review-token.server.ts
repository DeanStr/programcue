const encoder = new TextEncoder();

export const SCHEDULE_REVIEW_TOKEN_BYTE_LENGTH = 32;
export const SCHEDULE_REVIEW_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export function createScheduleReviewToken() {
  const bytes = crypto.getRandomValues(
    new Uint8Array(SCHEDULE_REVIEW_TOKEN_BYTE_LENGTH),
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function isScheduleReviewToken(value: string) {
  return SCHEDULE_REVIEW_TOKEN_PATTERN.test(value);
}

export async function hashScheduleReviewToken(token: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
