export const SCHEDULE_REVIEW_PREVIEW_NOT_FOUND_MESSAGE =
  "That page does not exist, or the link has changed.";

export function scheduleReviewPreviewHeaders(): Record<string, string> {
  return {
    "cache-control": "private, no-store",
    "x-robots-tag": "noindex, nofollow",
    "referrer-policy": "no-referrer",
  };
}

export function composeScheduleReviewPreviewHeaders(
  source?: Headers | null,
): Headers {
  const headers = new Headers(source ?? undefined);
  for (const [name, value] of Object.entries(scheduleReviewPreviewHeaders())) {
    headers.set(name, value);
  }
  return headers;
}

export function isScheduleReviewPreviewPath(pathname: string) {
  return (
    pathname === "/programme-preview" ||
    pathname === "/programme-preview.data" ||
    pathname.startsWith("/programme-preview/")
  );
}

export function scheduleReviewPreviewNotFound(): never {
  throw new Response(SCHEDULE_REVIEW_PREVIEW_NOT_FOUND_MESSAGE, {
    status: 404,
    statusText: "Not Found",
    headers: scheduleReviewPreviewHeaders(),
  });
}
