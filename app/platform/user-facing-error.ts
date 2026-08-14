/**
 * Separates the two kinds of error message this product produces.
 *
 * A `UserFacingError` message was written for the person on the screen: it
 * names things they recognise and, where possible, what to do next. Every other
 * error is a diagnostic written for whoever is on call — binding names, env var
 * names, provider HTTP codes, JSON parse failures — and must never be rendered.
 *
 * Rendering surfaces therefore never read `error.message` directly. They call
 * `userFacingMessage(error, fallback)`, which returns the fallback unless the
 * error was explicitly classified as safe to show.
 */
export class UserFacingError extends Error {
  /**
   * A branded property rather than a bare `instanceof` check: route modules,
   * the Worker entry and the browser bundle can each hold their own copy of
   * this class, and identity comparison fails across those boundaries.
   */
  readonly userFacing = true as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "UserFacingError";
  }
}

export function isUserFacingError(error: unknown): error is UserFacingError {
  return (
    error instanceof Error &&
    (error as Partial<UserFacingError>).userFacing === true
  );
}

/**
 * The message to render for `error`. Unclassified errors yield `fallback`, so a
 * new internal failure mode degrades to generic copy instead of leaking.
 */
export function userFacingMessage(error: unknown, fallback: string): string {
  if (!isUserFacingError(error)) return fallback;
  const message = error.message.trim();
  return message.length > 0 ? message : fallback;
}
