import {
  data,
  Form,
  redirect,
  useActionData,
  useNavigation,
} from "react-router";
import { z } from "zod";

import type { Route } from "./+types/sign-in";
import { TurnstileWidget } from "~/components/turnstile-widget";
import {
  createAuth,
  ParticipantOAuthConfigurationError,
  participantOAuthConfiguration,
} from "~/platform/auth/auth.server";
import { safeReturnTo } from "~/platform/auth/return-to";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  AbuseProtectionConfigurationError,
  AbuseRateLimitError,
  enforcePublicAbuseProtection,
  publicAbuseClientConfiguration,
  TurnstileRejectedError,
  TurnstileUnavailableError,
} from "~/platform/http/public-abuse-protection.server";
import { requestCorrelationId } from "~/platform/observability/request-correlation";
import { sourceRevisionForLog } from "~/platform/observability/source-revision.server";

const ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/u;
const MICROSOFT_ACCOUNT_NOT_LINKED = "account_not_linked";

function logAuthenticationFailure(
  env: CloudflareEnvironment,
  request: Request,
  event: string,
  error: unknown,
) {
  const candidate =
    error instanceof Error ? (error.constructor?.name ?? "") : "UnknownError";
  const errorName = ERROR_NAME_PATTERN.test(candidate) ? candidate : "Error";
  console.error(
    JSON.stringify({
      level: "error",
      sourceRevision: sourceRevisionForLog(env),
      subsystem: "authentication",
      event,
      correlationId: requestCorrelationId(request),
      errorName,
      message: "An authentication request dependency failed.",
    }),
  );
}

export const meta: Route.MetaFunction = () => [
  { title: "Sign in · Program Cue" },
];

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  if (String(env.DEMO_MODE) === "true") return redirect("/demo");
  const url = new URL(request.url);
  const returnTo = safeReturnTo(url.searchParams.get("returnTo"));
  const oauthProvider =
    url.searchParams.get("provider") === "microsoft" ? "microsoft" : null;
  const oauthError = url.searchParams.get("error");
  const requestedLinkProvider =
    url.searchParams.get("linkProvider") === "microsoft" ? "microsoft" : null;
  let participantOAuth: ReturnType<typeof participantOAuthConfiguration>;
  try {
    participantOAuth = participantOAuthConfiguration(env);
  } catch (error) {
    if (error instanceof ParticipantOAuthConfigurationError) {
      logAuthenticationFailure(
        env,
        request,
        "participant-oauth-configuration-invalid",
        error,
      );
      throw new Response(
        "Social sign-in is temporarily unavailable because a provider is misconfigured.",
        {
          status: 503,
          statusText: "Authentication provider configuration unavailable",
        },
      );
    }
    throw error;
  }
  const session = await createAuth(env).api.getSession({
    headers: request.headers,
  });
  if (session?.user && !requestedLinkProvider) return redirect(returnTo);
  return {
    returnTo,
    oauthError: oauthError !== null,
    microsoftNeedsEmailProof:
      oauthProvider === "microsoft" &&
      oauthError === MICROSOFT_ACCOUNT_NOT_LINKED,
    linkRequest:
      session?.user && requestedLinkProvider === "microsoft"
        ? {
            provider: "microsoft" as const,
            email: session.user.email,
            failed: url.searchParams.has("linkError"),
          }
        : null,
    socialProviders: {
      google: participantOAuth.google !== null,
      microsoft: participantOAuth.microsoft !== null,
    },
    turnstileSiteKey: publicAbuseClientConfiguration(env).turnstileSiteKey,
  };
}

const socialSignInSchema = z.object({
  provider: z.enum(["google", "microsoft"]),
  returnTo: z.string(),
});

async function beginSocialSignIn(
  env: CloudflareEnvironment,
  request: Request,
  formData: FormData,
) {
  const parsed = socialSignInSchema.safeParse({
    provider: formData.get("provider"),
    returnTo: safeReturnTo(formData.get("returnTo")),
  });
  if (!parsed.success) {
    return data(
      { ok: false, message: "Choose a valid sign-in provider." },
      { status: 422 },
    );
  }

  try {
    const configured = participantOAuthConfiguration(env);
    if (!configured[parsed.data.provider]) {
      return data(
        {
          ok: false,
          message: `${parsed.data.provider === "google" ? "Google" : "Microsoft"} sign-in is not configured.`,
        },
        { status: 503 },
      );
    }
    await enforcePublicAbuseProtection({
      env,
      request,
      action: "social_sign_in",
      tenantId: "program-cue-authentication",
      email: `provider:${parsed.data.provider}`,
      turnstileToken: String(formData.get("turnstile-token") ?? ""),
    });
    const errorCallbackURL = `/sign-in?${new URLSearchParams({
      returnTo: parsed.data.returnTo,
      provider: parsed.data.provider,
    })}`;
    const { headers, response } = await createAuth(env).api.signInSocial({
      body: {
        provider: parsed.data.provider,
        callbackURL: parsed.data.returnTo,
        newUserCallbackURL: "/",
        errorCallbackURL,
      },
      headers: request.headers,
      returnHeaders: true,
    });
    if (!response.redirect || !response.url) {
      throw new Error("The authentication provider did not return a redirect.");
    }
    headers.set("location", response.url);
    return new Response(null, { status: 302, headers });
  } catch (error) {
    if (error instanceof Response) throw error;
    if (error instanceof AbuseRateLimitError) {
      return data(
        { ok: false, message: error.message },
        {
          status: 429,
          headers: { "retry-after": String(error.retryAfterSeconds) },
        },
      );
    }
    if (error instanceof TurnstileRejectedError) {
      return data({ ok: false, message: error.message }, { status: 422 });
    }
    logAuthenticationFailure(
      env,
      request,
      error instanceof ParticipantOAuthConfigurationError
        ? "participant-oauth-configuration-invalid"
        : error instanceof AbuseProtectionConfigurationError ||
            error instanceof TurnstileUnavailableError
          ? "social-sign-in-protection-unavailable"
          : "social-sign-in-start-failed",
      error,
    );
    return data(
      {
        ok: false,
        message:
          error instanceof AbuseProtectionConfigurationError ||
          error instanceof TurnstileUnavailableError
            ? "Sign-in security is temporarily unavailable. Try again later."
            : "Social sign-in could not be started right now. Please try again later.",
      },
      { status: 503 },
    );
  }
}

async function beginSocialLink(
  env: CloudflareEnvironment,
  request: Request,
  formData: FormData,
) {
  const parsed = z
    .object({ provider: z.literal("microsoft"), returnTo: z.string() })
    .safeParse({
      provider: formData.get("provider"),
      returnTo: safeReturnTo(formData.get("returnTo")),
    });
  if (!parsed.success) {
    return data(
      { ok: false, message: "Choose a valid account to link." },
      { status: 422 },
    );
  }
  const configured = participantOAuthConfiguration(env);
  if (!configured.microsoft) {
    return data(
      { ok: false, message: "Microsoft sign-in is not configured." },
      { status: 503 },
    );
  }
  const auth = createAuth(env);
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session?.user) {
    return data(
      {
        ok: false,
        message: "Verify your invited email before linking Microsoft.",
      },
      { status: 401 },
    );
  }

  try {
    const callbackURL = parsed.data.returnTo;
    const errorCallbackURL = `/sign-in?${new URLSearchParams({
      returnTo: callbackURL,
      linkProvider: "microsoft",
      linkError: "true",
    })}`;
    const { headers, response } = await auth.api.linkSocialAccount({
      body: {
        provider: "microsoft",
        callbackURL,
        errorCallbackURL,
      },
      headers: request.headers,
      returnHeaders: true,
    });
    if (!response.redirect || !response.url) {
      throw new Error("Microsoft did not return an account-link redirect.");
    }
    headers.set("location", response.url);
    return new Response(null, { status: 302, headers });
  } catch (error) {
    if (error instanceof Response) throw error;
    logAuthenticationFailure(
      env,
      request,
      "social-account-link-start-failed",
      error,
    );
    return data(
      {
        ok: false,
        message: "Microsoft linking could not be started. Please try again.",
      },
      { status: 503 },
    );
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }
  const { env } = getCloudflareContext(context);
  const formData = await request.formData();
  const intent = formData.get("_intent");
  if (intent === "social_sign_in") {
    return beginSocialSignIn(env, request, formData);
  }
  if (intent === "link_social_account") {
    return beginSocialLink(env, request, formData);
  }
  if (intent !== "email_magic_link") {
    return data(
      { ok: false, message: "Choose a valid sign-in method." },
      { status: 422 },
    );
  }
  const result = z
    .object({ email: z.email(), returnTo: z.string() })
    .safeParse({
      email: formData.get("email"),
      returnTo: safeReturnTo(formData.get("returnTo")),
    });
  if (!result.success)
    return data(
      { ok: false, message: "Enter a valid email address." },
      { status: 422 },
    );

  try {
    await enforcePublicAbuseProtection({
      env,
      request,
      action: "sign_in",
      tenantId: "program-cue-authentication",
      email: result.data.email,
      turnstileToken: String(formData.get("turnstile-token") ?? ""),
    });
    const linkProviderAfterEmail =
      formData.get("linkProviderAfterEmail") === "microsoft"
        ? "microsoft"
        : null;
    const callbackURL = linkProviderAfterEmail
      ? `/sign-in?${new URLSearchParams({
          returnTo: result.data.returnTo,
          linkProvider: linkProviderAfterEmail,
        })}`
      : result.data.returnTo;
    await createAuth(env).api.signInMagicLink({
      body: {
        email: result.data.email,
        callbackURL,
        newUserCallbackURL: "/",
      },
      headers: request.headers,
    });
    return data({
      ok: true,
      message: "A one-time sign-in link will arrive shortly.",
    });
  } catch (error) {
    if (error instanceof AbuseRateLimitError) {
      return data(
        { ok: false, message: error.message },
        {
          status: 429,
          headers: { "retry-after": String(error.retryAfterSeconds) },
        },
      );
    }
    if (error instanceof TurnstileRejectedError) {
      return data({ ok: false, message: error.message }, { status: 422 });
    }
    if (
      error instanceof AbuseProtectionConfigurationError ||
      error instanceof TurnstileUnavailableError
    ) {
      logAuthenticationFailure(
        env,
        request,
        "magic-link-protection-unavailable",
        error,
      );
      return data(
        {
          ok: false,
          message:
            "Sign-in security is temporarily unavailable. Try again later.",
        },
        { status: 503 },
      );
    }
    logAuthenticationFailure(env, request, "magic-link-request-failed", error);
    return data(
      {
        ok: false,
        message:
          "Sign-in email could not be requested right now. Please try again later.",
      },
      { status: 503 },
    );
  }
}

export default function SignIn({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submittingIntent = navigation.formData?.get("_intent");
  const submittingProvider = navigation.formData?.get("provider");
  const submitting = navigation.state === "submitting";
  const hasSocialProvider =
    loaderData.socialProviders.google || loaderData.socialProviders.microsoft;
  if (loaderData.linkRequest) {
    return (
      <main
        className="design-board"
        id="main"
        style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}
      >
        <section
          className="card pad"
          style={{ width: "min(460px, calc(100vw - 32px))" }}
        >
          <div className="brand" style={{ color: "var(--ink)", padding: 0 }}>
            <span className="brand-mark">P</span>
            <span>Program Cue</span>
          </div>
          <h1>Link Microsoft</h1>
          <p className="validation-item ok" role="status">
            Email verified as {loaderData.linkRequest.email}.
          </p>
          <p className="subtle">
            Continue to Microsoft once to link this invited identity. Future
            Microsoft sign-ins will complete directly.
          </p>
          {loaderData.linkRequest.failed ? (
            <p className="validation-item error" role="alert">
              Microsoft linking did not complete. No account was linked.
            </p>
          ) : null}
          {actionData ? (
            <p
              className={`validation-item ${actionData.ok ? "ok" : "error"}`}
              role={actionData.ok ? "status" : "alert"}
            >
              {actionData.message}
            </p>
          ) : null}
          <Form method="post">
            <input type="hidden" name="_intent" value="link_social_account" />
            <input type="hidden" name="provider" value="microsoft" />
            <input type="hidden" name="returnTo" value={loaderData.returnTo} />
            <button
              className="btn primary"
              type="submit"
              disabled={submitting}
              style={{ width: "100%" }}
            >
              {submitting
                ? "Opening Microsoft…"
                : "Link Microsoft and continue"}
            </button>
          </Form>
          <a
            className="btn mt"
            href={loaderData.returnTo}
            style={{ width: "100%" }}
          >
            Continue without Microsoft
          </a>
        </section>
      </main>
    );
  }
  return (
    <main
      className="design-board"
      id="main"
      style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}
    >
      <section
        className="card pad"
        style={{ width: "min(460px, calc(100vw - 32px))" }}
      >
        <div className="brand" style={{ color: "var(--ink)", padding: 0 }}>
          <span className="brand-mark">P</span>
          <span>Program Cue</span>
        </div>
        <h1>Sign in</h1>
        <p className="subtle">
          Sign in or create an account. Email links expire after five minutes.
        </p>
        {actionData ? (
          <p
            className={`validation-item ${actionData.ok ? "ok" : "error"}`}
            role={actionData.ok ? "status" : "alert"}
          >
            {actionData.message}
          </p>
        ) : null}
        {!actionData && loaderData.microsoftNeedsEmailProof ? (
          <p className="validation-item error" role="alert">
            Microsoft needs a one-time email check before it can be linked.
            Enter your invited email below; after opening the link, you will
            return here to finish Microsoft setup.
          </p>
        ) : !actionData && loaderData.oauthError ? (
          <p className="validation-item error" role="alert">
            Social sign-in did not complete. Try again or use an email link.
          </p>
        ) : null}
        {hasSocialProvider ? (
          <div style={{ display: "grid", gap: 10 }}>
            <Form method="post" style={{ display: "grid", gap: 10 }}>
              <input type="hidden" name="_intent" value="social_sign_in" />
              <input
                type="hidden"
                name="returnTo"
                value={loaderData.returnTo}
              />
              {loaderData.socialProviders.google ? (
                <button
                  className="btn"
                  name="provider"
                  value="google"
                  type="submit"
                  disabled={submitting}
                  style={{ width: "100%" }}
                >
                  {submitting && submittingProvider === "google"
                    ? "Opening Google…"
                    : "Continue with Google"}
                </button>
              ) : null}
              {loaderData.socialProviders.microsoft ? (
                <button
                  className="btn"
                  name="provider"
                  value="microsoft"
                  type="submit"
                  disabled={submitting}
                  style={{ width: "100%" }}
                >
                  {submitting && submittingProvider === "microsoft"
                    ? "Opening Microsoft…"
                    : "Continue with Microsoft"}
                </button>
              ) : null}
              <TurnstileWidget
                siteKey={loaderData.turnstileSiteKey}
                action="social_sign_in"
                appearance="interaction-only"
              />
            </Form>
            <p
              className="subtle"
              style={{ margin: "2px 0 0", textAlign: "center" }}
            >
              Signing in creates an identity only. Private workspace access is
              granted separately.
            </p>
            <p
              className="subtle"
              aria-hidden="true"
              style={{ margin: 0, textAlign: "center" }}
            >
              or
            </p>
          </div>
        ) : null}
        <Form method="post">
          <input type="hidden" name="_intent" value="email_magic_link" />
          <input type="hidden" name="returnTo" value={loaderData.returnTo} />
          {loaderData.microsoftNeedsEmailProof ? (
            <input
              type="hidden"
              name="linkProviderAfterEmail"
              value="microsoft"
            />
          ) : null}
          <label className="label">
            Email address
            <input
              className="field"
              name="email"
              type="email"
              autoComplete="email"
              required
              style={{ width: "100%" }}
            />
          </label>
          <TurnstileWidget
            siteKey={loaderData.turnstileSiteKey}
            action="sign_in"
            appearance="interaction-only"
          />
          <button
            className="btn primary mt"
            type="submit"
            disabled={submitting}
            style={{ width: "100%" }}
          >
            {submitting && submittingIntent === "email_magic_link"
              ? "Sending…"
              : "Email me a sign-in link"}
          </button>
        </Form>
      </section>
    </main>
  );
}
