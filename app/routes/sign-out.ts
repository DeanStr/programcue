import { redirect } from "react-router";

import type { Route } from "./+types/sign-out";
import { signOutSession } from "~/platform/auth/auth.server";
import { clearCurrentEventCookie } from "~/platform/auth/current-event.server";
import { safeReturnTo } from "~/platform/auth/return-to";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { DEMO_IDENTITY_COOKIE } from "~/platform/demo/demo-identities";
import {
  readEvaluationSession,
  renewedEvaluationSessionCookie,
} from "~/platform/evaluation/evaluation-session.server";
import { requireRuntimeMode } from "~/platform/runtime-environment.server";

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }
  const { env } = getCloudflareContext(context);
  const runtime = requireRuntimeMode(env);
  if (runtime.demo) {
    const headers = new Headers();
    headers.append(
      "set-cookie",
      `${DEMO_IDENTITY_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
    );
    headers.append("set-cookie", clearCurrentEventCookie(env));
    return redirect("/demo", { status: 303, headers });
  }

  const evaluationSession = runtime.evaluation
    ? await readEvaluationSession(request, env)
    : null;
  if (evaluationSession) {
    const result = await signOutSession(env, request);
    if (!result.ok) return result;
    const headers = new Headers(result.headers);
    headers.append(
      "set-cookie",
      await renewedEvaluationSessionCookie(env, evaluationSession, null),
    );
    headers.append("set-cookie", clearCurrentEventCookie(env));
    return redirect("/evaluate", { status: 303, headers });
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
