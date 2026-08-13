import { createAuth } from "~/platform/auth/auth.server";
import { selectedEvaluationPerson } from "~/platform/evaluation/evaluation-session.server";
import type { ItineraryIdentity } from "./public-itinerary-service.server";
import { readCookie } from "./public-programme-service.server";

export const PUBLIC_ITINERARY_COOKIE = "program_cue_itinerary";

export function itineraryCookie(
  token: string,
  expiresAt: number | null,
  requestUrl: string,
  now = Math.floor(Date.now() / 1_000),
) {
  const secure = new URL(requestUrl).protocol === "https:" ? "; Secure" : "";
  const lifetime =
    expiresAt === null
      ? ""
      : `; Expires=${new Date(expiresAt * 1_000).toUTCString()}; Max-Age=${Math.max(0, expiresAt - now)}`;
  return `${PUBLIC_ITINERARY_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax${lifetime}${secure}`;
}

export async function publicItineraryIdentity(
  request: Request,
  env: CloudflareEnvironment,
): Promise<ItineraryIdentity> {
  const visitorToken = readCookie(request, PUBLIC_ITINERARY_COOKIE);
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
