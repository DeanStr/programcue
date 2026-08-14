import { createAuth } from "~/platform/auth/auth.server";
import { selectedEvaluationPerson } from "~/platform/evaluation/evaluation-session.server";
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
): Promise<ItineraryIdentity> {
  const visitorToken = await readItineraryBrowserId(request, env);
  if (String(env.DEMO_MODE) === "true") {
    return { personId: null, visitorToken };
  }
  const evaluationPerson = await selectedEvaluationPerson(request, env);
  if (evaluationPerson) {
    return { personId: evaluationPerson.personId, visitorToken };
  }
  const session = await createAuth(env).api.getSession({
    headers: request.headers,
  });
  return { personId: session?.user.id ?? null, visitorToken };
}
