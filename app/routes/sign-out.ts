import { redirect } from "react-router";

import type { Route } from "./+types/sign-out";
import { signOutSession } from "~/platform/auth/auth.server";
import { clearCurrentEventCookie } from "~/platform/auth/current-event.server";
import { safeReturnTo } from "~/platform/auth/return-to";
import { getCloudflareContext } from "~/platform/cloudflare-context";

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  }
  const { env } = getCloudflareContext(context);
  if (String(env.DEMO_MODE) === "true") {
    throw new Response("Sign-out is disabled in demo mode", { status: 404 });
  }

  const formData = await request.formData();
  const returnTo = safeReturnTo(formData.get("returnTo"));
  const result = await signOutSession(env, request);
  if (!result.ok) return result;
  const destination = `/sign-in?${new URLSearchParams({ returnTo })}`;
  const headers = new Headers(result.headers);
  headers.append("set-cookie", clearCurrentEventCookie(env));
  return redirect(destination, { status: 303, headers });
}
