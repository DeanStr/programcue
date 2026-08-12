import { redirect, type RouterContextProvider } from "react-router";
import { z } from "zod";

import { CalendarOAuthService } from "~/modules/calendars/calendar-oauth.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

const providerSchema = z.enum(["google", "microsoft"]);
const OAUTH_COOKIE = "program_cue_calendar_oauth";

export async function loader({
  request,
  context,
  params,
}: {
  request: Request;
  context: Readonly<RouterContextProvider>;
  params: { provider?: string };
}) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
    "submitter",
    "speaker",
  ]);
  const provider = providerSchema.safeParse(params.provider);
  if (!provider.success)
    throw new Response("Calendar provider was not found.", { status: 404 });
  const started = await new CalendarOAuthService(env).start(
    viewer,
    provider.data,
    viewer.role === "speaker" || viewer.role === "submitter"
      ? "/participant/dashboard"
      : "/admin/communications",
  );
  const secure = String(env.APP_ENV) === "production" ? "; Secure" : "";
  return redirect(started.authorizationUrl, {
    headers: {
      "set-cookie": `${OAUTH_COOKIE}=${encodeURIComponent(started.nonce)}; Max-Age=600; Path=/oauth/calendar/callback; HttpOnly; SameSite=Lax${secure}`,
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
