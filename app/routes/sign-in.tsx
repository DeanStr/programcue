import { data, Form, redirect, useActionData, useNavigation } from "react-router";
import { z } from "zod";

import type { Route } from "./+types/sign-in";
import { createAuth } from "~/platform/auth/auth.server";
import { safeReturnTo } from "~/platform/auth/return-to";
import { getCloudflareContext } from "~/platform/cloudflare-context";

export const meta: Route.MetaFunction = () => [{ title: "Sign in · Program Cue" }];

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  if (String(env.DEMO_MODE) === "true") return redirect("/admin/event");
  const returnTo = safeReturnTo(new URL(request.url).searchParams.get("returnTo"));
  const session = await createAuth(env).api.getSession({ headers: request.headers });
  if (session?.user) return redirect(returnTo);
  return { returnTo };
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: { allow: "POST" } });
  }
  const { env } = getCloudflareContext(context);
  const formData = await request.formData();
  const result = z.object({ email: z.email(), returnTo: z.string() }).safeParse({
    email: formData.get("email"),
    returnTo: safeReturnTo(formData.get("returnTo")),
  });
  if (!result.success) return data({ ok: false, message: "Enter a valid email address." }, { status: 422 });

  try {
    await createAuth(env).api.signInMagicLink({
      body: { email: result.data.email, callbackURL: result.data.returnTo },
      headers: request.headers,
    });
    return data({ ok: true, message: "If this address is eligible, a one-time sign-in link will arrive shortly." });
  } catch (error) {
    console.error("Sign-in email request failed", error);
    return data({ ok: false, message: "Sign-in email could not be requested right now. Please try again later." }, { status: 503 });
  }
}

export default function SignIn({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  return <main className="design-board" id="main" style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}><section className="card pad" style={{ width: "min(460px, calc(100vw - 32px))" }}><div className="brand" style={{ color: "var(--ink)", padding: 0 }}><span className="brand-mark">P</span><span>Program Cue</span></div><h1>Sign in</h1><p className="subtle">Use your invited email address. The link expires after five minutes.</p>{actionData ? <p className={`validation-item ${actionData.ok ? "ok" : "error"}`} role={actionData.ok ? "status" : "alert"}>{actionData.message}</p> : null}<Form method="post"><input type="hidden" name="returnTo" value={loaderData.returnTo} /><label className="label">Email address<input className="field" name="email" type="email" autoComplete="email" required style={{ width: "100%" }} /></label><button className="btn primary mt" type="submit" disabled={navigation.state === "submitting"} style={{ width: "100%" }}>{navigation.state === "submitting" ? "Sending…" : "Email me a sign-in link"}</button></Form></section></main>;
}
