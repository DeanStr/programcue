import { createAuth } from "~/platform/auth/auth.server";
import {
  EVALUATION_ORGANISATION_ID,
  evaluationPersonForSession,
  readEvaluationSession,
} from "~/platform/evaluation/evaluation-session.server";
import { requireRuntimeMode } from "~/platform/runtime-environment.server";
import type { ItineraryIdentity } from "./public-itinerary-service.server";
import { readCookie } from "./public-programme-service.server";
import {
  signItineraryBrowserCookie,
  verifyItineraryBrowserCookie,
} from "./public-itinerary-token.server";

export const PUBLIC_ITINERARY_COOKIE = "program_cue_itinerary";

export async function itineraryCookie(
  env: CloudflareEnvironment,
  token: string,
  requestUrl: string,
  now = Math.floor(Date.now() / 1_000),
) {
  const secure = new URL(requestUrl).protocol === "https:" ? "; Secure" : "";
  const signed = await signItineraryBrowserCookie(env, token, now);
  const lifetime = `; Expires=${new Date(signed.expiresAt * 1_000).toUTCString()}; Max-Age=${signed.expiresAt - now}`;
  return `${PUBLIC_ITINERARY_COOKIE}=${encodeURIComponent(signed.value)}; Path=/; HttpOnly; SameSite=Lax${lifetime}${secure}`;
}

async function readItineraryBrowserId(
  request: Request,
  env: CloudflareEnvironment,
) {
  return verifyItineraryBrowserCookie(
    env,
    readCookie(request, PUBLIC_ITINERARY_COOKIE),
  );
}

export async function publicItineraryIdentity(
  request: Request,
  env: CloudflareEnvironment,
  eventId: string,
): Promise<ItineraryIdentity> {
  const visitorToken = await readItineraryBrowserId(request, env);
  const runtime = requireRuntimeMode(env);
  if (runtime.demo) {
    return { personId: null, visitorToken };
  }
  if (runtime.evaluation) {
    const evaluationSession = await readEvaluationSession(request, env);
    if (evaluationSession) {
      if (!evaluationSession.identityKey) {
        return { personId: null, visitorToken };
      }
      const fixtureEvent = await env.DB.prepare(
        `SELECT 1 FROM events
          WHERE id = ? AND organisation_id = ?
            AND activation_status = 'active'`,
      )
        .bind(eventId, EVALUATION_ORGANISATION_ID)
        .first();
      if (!fixtureEvent) return { personId: null, visitorToken };
      const evaluationPerson = await evaluationPersonForSession(
        env,
        evaluationSession,
      );
      return {
        personId: evaluationPerson?.personId ?? null,
        visitorToken,
      };
    }
  }
  const session = await createAuth(env).api.getSession({
    headers: request.headers,
  });
  return { personId: session?.user.id ?? null, visitorToken };
}
