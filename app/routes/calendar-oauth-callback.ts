import { type RouterContextProvider, redirect } from "react-router";
import {
  CalendarOAuthService,
  type DirectCalendarProviderName,
} from "~/modules/calendars/calendar-oauth.server";
import {
  CALENDAR_OAUTH_COOKIE,
  calendarOAuthCallbackFailure,
  clearedCalendarOAuthCookie,
} from "~/modules/calendars/calendar-oauth-callback.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

function cookieValue(request: Request, name: string) {
  for (const item of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = item.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(value.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

export async function loader({
  request,
  context,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
}) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
    "submitter",
    "speaker",
  ]);
  const url = new URL(request.url);
  const state = url.searchParams.get("state");
  const code = url.searchParams.get("code");
  const providerError = url.searchParams.get("error");
  const production = String(env.APP_ENV) === "production";
  const nonce = cookieValue(request, CALENDAR_OAUTH_COOKIE);
  if (providerError) {
    const state = url.searchParams.get("state");
    if (!state || !nonce)
      throw new Response("Calendar OAuth error is missing required state.", {
        status: 400,
        headers: { "set-cookie": clearedCalendarOAuthCookie(production) },
      });
    try {
      await new CalendarOAuthService(env).validateState(viewer, {
        state,
        nonce,
      });
    } catch (error) {
      throw calendarOAuthCallbackFailure(error, env, viewer.eventId);
    }
    const description = url.searchParams.get("error_description");
    throw new Response(
      description
        ? `Calendar consent was not completed: ${description.slice(0, 300)}`
        : `Calendar consent was not completed: ${providerError}`,
      {
        status: 422,
        headers: { "set-cookie": clearedCalendarOAuthCookie(production) },
      },
    );
  }
  if (!state || !code || !nonce)
    throw new Response("Calendar OAuth callback is missing required state.", {
      status: 400,
      headers: { "set-cookie": clearedCalendarOAuthCookie(production) },
    });
  let connected: Awaited<ReturnType<CalendarOAuthService["callback"]>>;
  try {
    connected = await new CalendarOAuthService(env).callback(viewer, {
      state,
      code,
      nonce,
    });
  } catch (error) {
    throw calendarOAuthCallbackFailure(error, env, viewer.eventId);
  }
  const destination = new URL(connected.returnTo, url.origin);
  destination.searchParams.set(
    "calendarConnected",
    connected.provider satisfies DirectCalendarProviderName,
  );
  destination.searchParams.set("account", connected.account);
  return redirect(`${destination.pathname}${destination.search}`, {
    headers: {
      "set-cookie": clearedCalendarOAuthCookie(production),
      "cache-control": "private, no-store",
    },
  });
}

export function action() {
  return new Response("Method not allowed", {
    status: 405,
    headers: { allow: "GET" },
  });
}
