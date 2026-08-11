import {
  CalendarProviderConfigurationError,
  CalendarProviderRequestError,
} from "~/modules/calendars/calendar-providers.server";
import { sourceRevisionForLog } from "~/platform/observability/source-revision.server";

export const CALENDAR_OAUTH_COOKIE = "program_cue_calendar_oauth";

export function clearedCalendarOAuthCookie(production: boolean) {
  return `${CALENDAR_OAUTH_COOKIE}=; Max-Age=0; Path=/oauth/calendar/callback; HttpOnly; SameSite=Lax${production ? "; Secure" : ""}`;
}

export function calendarOAuthCallbackFailure(
  error: unknown,
  env: CloudflareEnvironment,
  eventId: string,
) {
  console.error(
    JSON.stringify({
      level: "error",
      sourceRevision: sourceRevisionForLog(env),
      subsystem: "calendar-oauth",
      event: "callback-failed",
      eventId,
      provider:
        error instanceof CalendarProviderRequestError &&
        (error.provider === "google" || error.provider === "microsoft")
          ? error.provider
          : "calendar",
      errorName:
        error instanceof CalendarProviderConfigurationError ||
        error instanceof CalendarProviderRequestError
          ? error.name
          : "UnknownError",
      message: "The calendar OAuth callback failed.",
    }),
  );
  const production = String(env.APP_ENV) === "production";
  const headers = {
    "set-cookie": clearedCalendarOAuthCookie(production),
  };
  if (error instanceof CalendarProviderConfigurationError)
    return new Response(error.message, { status: 422, headers });
  if (error instanceof CalendarProviderRequestError)
    return new Response(
      "The calendar provider did not complete the connection. Start consent again.",
      { status: 502, headers },
    );
  return new Response(
    "Calendar connection could not be completed. Start consent again.",
    { status: 500, headers },
  );
}
