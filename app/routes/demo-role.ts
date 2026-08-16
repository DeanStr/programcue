import { redirect } from "react-router";
import { currentEventCookie } from "~/platform/auth/current-event.server";
import { safeReturnTo } from "~/platform/auth/return-to";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  DEMO_EVENT_ID,
  DEMO_IDENTITY_COOKIE,
  isDemoIdentityKey,
} from "~/platform/demo/demo-identities";
import { resolveDemoIdentityState } from "~/platform/demo/demo-identity.server";
import type { Route } from "./+types/demo-role";

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    throw new Response("Method not allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }
  const { env } = getCloudflareContext(context);
  if (
    String(env.DEMO_MODE) !== "true" ||
    env.APP_ENV === "production" ||
    env.DEFAULT_EVENT_ID !== DEMO_EVENT_ID
  ) {
    throw new Response("Demo identity switching is disabled", { status: 404 });
  }
  const formData = await request.formData();
  const identityKey = formData.get("identity");
  if (typeof identityKey !== "string" || !isDemoIdentityKey(identityKey)) {
    throw new Response("Demo identity is invalid", { status: 400 });
  }
  const headers = new Headers();
  headers.append(
    "set-cookie",
    `${DEMO_IDENTITY_COOKIE}=${identityKey}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
  );
  // Each demo identity starts from the canonical judged event. This prevents
  // an administrator's cloned-event selection leaking into another identity.
  headers.append("set-cookie", currentEventCookie(DEMO_EVENT_ID, env));
  const identityState = await resolveDemoIdentityState(env, identityKey);
  let destination: string = identityState.destination;
  const requestedDestination = formData.get("returnTo");
  if (requestedDestination !== null) {
    const safeDestination = safeReturnTo(requestedDestination);
    if (safeDestination === "/" && requestedDestination !== "/") {
      throw new Response("Demo destination is invalid", { status: 400 });
    }
    destination = safeDestination;
  }
  return redirect(destination, { headers });
}
