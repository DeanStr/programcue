/**
 * Human copy for a thrown route response.
 *
 * An HTTP status is a protocol detail: "403 Forbidden" tells the reader which
 * layer refused them, not what happened or what to do. Every boundary that
 * renders a route error resolves its heading through this table instead, so the
 * same refusal reads the same way wherever it surfaces.
 */
const STATUS_COPY: ReadonlyArray<{
  matches: (status: number) => boolean;
  title: string;
  message: string;
}> = [
  {
    matches: (status) => status === 400,
    title: "That request could not be read",
    message: "Some details were missing or malformed. Try again.",
  },
  {
    matches: (status) => status === 401,
    title: "Sign in to continue",
    message: "Your session has ended. Sign in again to pick up where you were.",
  },
  {
    matches: (status) => status === 403,
    title: "You do not have access",
    message:
      "Your account cannot open this page. Ask an event administrator if you need access.",
  },
  {
    matches: (status) => status === 404,
    title: "Page not found",
    message: "That page does not exist, or the link has changed.",
  },
  {
    matches: (status) => status === 409,
    title: "Someone else changed this first",
    message: "Reload to see the current version, then make your change again.",
  },
  {
    matches: (status) => status === 413,
    title: "That is too large to accept",
    message: "Reduce the size and try again.",
  },
  {
    matches: (status) => status === 428,
    title: "Choose an event first",
    message: "This page needs a current event before it can open.",
  },
  {
    matches: (status) => status === 429,
    title: "Too many attempts",
    message: "Wait a moment, then try again.",
  },
  {
    matches: (status) => status === 503,
    title: "Temporarily unavailable",
    message:
      "This part of Program Cue is not available right now. Try again shortly.",
  },
  {
    // Deliberately not "your work has not been lost": this copy is shared by
    // the root boundary, which discards unsaved editor state, and by failed
    // actions, where whether the write landed is exactly what is unknown.
    matches: (status) => status >= 500,
    title: "Something went wrong on our end",
    message:
      "The page failed to load. Check your latest changes before trying again.",
  },
  {
    matches: (status) => status >= 400,
    title: "That request could not be completed",
    message: "Try again, or reload the page if this keeps happening.",
  },
];

export const UNKNOWN_ROUTE_ERROR_TITLE = "Something went wrong";
export const UNKNOWN_ROUTE_ERROR_MESSAGE =
  "The request could not be completed.";

export function routeErrorCopy(status: number) {
  const entry = STATUS_COPY.find((candidate) => candidate.matches(status));
  return {
    title: entry?.title ?? UNKNOWN_ROUTE_ERROR_TITLE,
    message: entry?.message ?? UNKNOWN_ROUTE_ERROR_MESSAGE,
  };
}

/**
 * Below 500 a thrown `Response` body is written by our own route code and is
 * addressed to the reader, so it replaces the generic sentence. At and above
 * 500 the body is whatever failed, which is a diagnostic.
 */
export function routeErrorMessage(status: number, data: unknown) {
  const fallback = routeErrorCopy(status).message;
  if (status >= 500) return fallback;
  return typeof data === "string" && data.trim().length > 0
    ? data.trim()
    : fallback;
}
