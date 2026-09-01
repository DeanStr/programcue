import { env } from "cloudflare:test";
import { serializeSignedCookie } from "better-call";
import { RouterContextProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDemoSubmissionForm } from "~/modules/submissions/demo-submissions.server";
import {
  createAuth,
  ParticipantOAuthConfigurationError,
  participantOAuthConfiguration,
  participantOAuthProviderOptions,
  trustedParticipantOAuthProviders,
} from "~/platform/auth/auth.server";
import { currentEventCookie } from "~/platform/auth/current-event.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { evaluationSessionCookie } from "~/platform/evaluation/evaluation-session.server";
import { action as administrationCommandAction } from "./api-administration-command";
import { action as apiSettingsAction } from "./api-settings";
import { action as authApiAction, loader as authApiLoader } from "./auth-api";
import { action as signInAction, loader as signInLoader } from "./sign-in";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    BETTER_AUTH_SECRET: string;
    AUTH_EMAIL_FROM: string;
    EMAIL_PROVIDER: string;
    RESEND_API_KEY: string;
  }
}

function productionEnv() {
  return {
    ...(env as unknown as CloudflareEnvironment),
    APP_ENV: "production",
    DEMO_MODE: "false",
    EMAIL_PROVIDER: "resend",
    TURNSTILE_SITE_KEY: "test-turnstile-site-key",
    TURNSTILE_SECRET_KEY: "test-turnstile-secret-key",
  } as CloudflareEnvironment;
}

function context(testEnv: CloudflareEnvironment) {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, {
    env: testEnv,
    ctx: {} as ExecutionContext,
  });
  return context;
}

async function sessionCookie(personId: string) {
  const token = `session-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `
    INSERT INTO auth_sessions (
      id, person_id, token, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, unixepoch() + 3600, unixepoch(), unixepoch())
  `,
  )
    .bind(crypto.randomUUID(), personId, token)
    .run();
  const cookie = await serializeSignedCookie(
    "better-auth.session_token",
    token,
    String((env as unknown as CloudflareEnvironment).BETTER_AUTH_SECRET),
  );
  return { token, cookie };
}

async function selectedEvaluationCookie(environment: CloudflareEnvironment) {
  await environment.DB.prepare(
    `INSERT INTO audit_events (
       id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_id, action,
       entity_type, entity_id, metadata_json, created_at
     ) VALUES (?, 'system', 'internal', 1, 'org-future-events', 'evt-foe-2025', 'test-operator',
               'evaluation.fixture.reset', 'event', 'evt-foe-2025', '{}',
               unixepoch())`,
  )
    .bind(crypto.randomUUID())
    .run();
  return (await evaluationSessionCookie(environment, "organizer")).split(
    ";",
    1,
  )[0];
}

function formRequest(
  url: string,
  values: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "http://localhost",
      ...headers,
    },
    body: new URLSearchParams(values),
  });
}

function unsignedIdToken(payload: Record<string, unknown>) {
  const encode = (value: Record<string, unknown>) =>
    btoa(JSON.stringify(value))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.signature`;
}

beforeEach(async () => {
  const demoEnv = env as unknown as CloudflareEnvironment;
  await ensureDemoData(demoEnv);
  await ensureDemoSubmissionForm(demoEnv);
  await env.DB.prepare(
    `
    UPDATE form_definitions
       SET access_mode = 'email_verified', access_password_hash = NULL
     WHERE event_id = 'evt-foe-2025' AND public_slug = 'form'
  `,
  ).run();
  await env.DB.prepare(
    `
    UPDATE form_versions
       SET settings_snapshot_json = json_set(
         settings_snapshot_json, '$.accessMode', 'email_verified'
       )
     WHERE event_id = 'evt-foe-2025'
       AND form_id = (
         SELECT id FROM form_definitions
          WHERE event_id = 'evt-foe-2025' AND public_slug = 'form'
       )
  `,
  ).run();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("production authentication routes", () => {
  it.each([
    ["secret", { BETTER_AUTH_SECRET: undefined }],
    ["base URL", { BETTER_AUTH_URL: undefined }],
  ])("fails fast with 503 when the auth %s is missing", (_name, override) => {
    let thrown: unknown;
    try {
      createAuth({
        ...productionEnv(),
        ...override,
      } as unknown as CloudflareEnvironment);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(503);
    expect((thrown as Response).statusText).toBe(
      "Authentication configuration unavailable",
    );
  });

  it.each([
    [
      "Google",
      {
        GOOGLE_AUTH_CLIENT_ID: "google-auth-client",
        GOOGLE_AUTH_CLIENT_SECRET: undefined,
      },
      "GOOGLE_AUTH_CLIENT_ID",
      "GOOGLE_AUTH_CLIENT_SECRET",
    ],
    [
      "Microsoft",
      {
        MICROSOFT_AUTH_CLIENT_ID: undefined,
        MICROSOFT_AUTH_CLIENT_SECRET: "microsoft-auth-secret",
      },
      "MICROSOFT_AUTH_CLIENT_ID",
      "MICROSOFT_AUTH_CLIENT_SECRET",
    ],
  ])(
    "fails fast when the %s participant OAuth credential pair is partial",
    (_provider, override, clientIdName, clientSecretName) => {
      let thrown: unknown;
      try {
        participantOAuthConfiguration({
          ...productionEnv(),
          ...override,
        } as unknown as CloudflareEnvironment);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ParticipantOAuthConfigurationError);
      expect((thrown as Error).message).toContain(
        `${clientIdName} and ${clientSecretName}`,
      );
    },
  );

  it("trusts Microsoft only for state created by an authenticated explicit link", async () => {
    const testEnv = {
      ...productionEnv(),
      MICROSOFT_AUTH_CLIENT_ID: "microsoft-auth-client",
      MICROSOFT_AUTH_CLIENT_SECRET: "microsoft-auth-secret",
    } as unknown as CloudflareEnvironment;
    const { cookie } = await sessionCookie("person-demo-admin");
    const response = await signInAction({
      request: formRequest(
        "http://localhost/sign-in?linkProvider=microsoft",
        {
          _intent: "link_social_account",
          provider: "microsoft",
          returnTo: "/admin/crm",
        },
        { cookie },
      ),
      params: {},
      context: context(testEnv),
    } as never);

    expect(response).toBeInstanceOf(Response);
    const redirectResponse = response as Response;
    expect(redirectResponse.status).toBe(302);
    const destination = new URL(redirectResponse.headers.get("location")!);
    expect(destination.hostname).toBe("login.microsoftonline.com");
    expect(destination.searchParams.get("response_mode")).toBe("form_post");
    const state = destination.searchParams.get("state");
    expect(state).toMatch(/^[A-Za-z0-9_-]{20,256}$/u);

    const stored = await env.DB.prepare(
      "SELECT value FROM verification_tokens WHERE identifier = ?",
    )
      .bind(state)
      .first<{ value: string }>();
    const payload = JSON.parse(stored?.value ?? "null") as {
      link?: { email?: string; userId?: string };
    };
    expect(payload.link).toMatchObject({
      email: "sbek-organizer@example.com",
      userId: "person-demo-admin",
    });
    await expect(
      trustedParticipantOAuthProviders(
        testEnv,
        new Request(
          `http://localhost/api/auth/callback/microsoft?state=${state}`,
        ),
      ),
    ).resolves.toEqual(["microsoft"]);
    await expect(
      trustedParticipantOAuthProviders(
        testEnv,
        new Request(`http://localhost/api/auth/callback/google?state=${state}`),
      ),
    ).resolves.toEqual([]);
    await expect(
      trustedParticipantOAuthProviders(
        testEnv,
        new Request(
          "http://localhost/api/auth/callback/microsoft?state=caller-selected-state",
        ),
      ),
    ).resolves.toEqual([]);
  });

  it("keeps partial OAuth credential details out of the public sign-in response", async () => {
    const logging = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    let thrown: unknown;
    try {
      await signInLoader({
        request: new Request("http://localhost/sign-in"),
        params: {},
        context: context({
          ...productionEnv(),
          GOOGLE_AUTH_CLIENT_ID: "google-auth-client",
          GOOGLE_AUTH_CLIENT_SECRET: undefined,
        } as unknown as CloudflareEnvironment),
      } as never);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(503);
    const body = await (thrown as Response).text();
    expect(body).toContain("provider is misconfigured");
    expect(body).not.toContain("GOOGLE_AUTH_CLIENT");
    expect(logging).toHaveBeenCalledOnce();
    const logEntry = String(logging.mock.calls[0]?.[0]);
    expect(JSON.parse(logEntry)).toMatchObject({
      subsystem: "authentication",
      event: "participant-oauth-configuration-invalid",
      errorName: "ParticipantOAuthConfigurationError",
    });
    expect(logEntry).not.toContain("GOOGLE_AUTH_CLIENT");
  });

  it("allows social identity creation without granting workspace access", () => {
    expect(participantOAuthProviderOptions(productionEnv())).toEqual({});
    const providers = participantOAuthProviderOptions({
      ...productionEnv(),
      GOOGLE_AUTH_CLIENT_ID: "google-auth-client",
      GOOGLE_AUTH_CLIENT_SECRET: "google-auth-secret",
      MICROSOFT_AUTH_CLIENT_ID: "microsoft-auth-client",
      MICROSOFT_AUTH_CLIENT_SECRET: "microsoft-auth-secret",
    } as unknown as CloudflareEnvironment);
    expect(providers.google).toMatchObject({
      disableIdTokenSignIn: true,
      disableDefaultScope: true,
      scope: ["openid", "email", "profile"],
    });
    expect(providers.google).not.toHaveProperty("disableSignUp");
    expect(providers.microsoft).toMatchObject({
      disableIdTokenSignIn: true,
      disableDefaultScope: true,
      responseMode: "form_post",
      scope: ["openid", "email", "profile"],
    });
    expect(providers.microsoft).not.toHaveProperty("disableSignUp");
    const forced = participantOAuthProviderOptions(
      {
        ...productionEnv(),
        GOOGLE_AUTH_CLIENT_ID: "google-auth-client",
        GOOGLE_AUTH_CLIENT_SECRET: "google-auth-secret",
        MICROSOFT_AUTH_CLIENT_ID: "microsoft-auth-client",
        MICROSOFT_AUTH_CLIENT_SECRET: "microsoft-auth-secret",
      } as unknown as CloudflareEnvironment,
      true,
    );
    expect(forced).not.toHaveProperty("google");
    expect(forced.microsoft).toMatchObject({ prompt: "login" });
  });

  it.each([
    [
      "google",
      {
        GOOGLE_AUTH_CLIENT_ID: "google-auth-client",
        GOOGLE_AUTH_CLIENT_SECRET: "google-auth-secret",
      },
      "accounts.google.com",
      null,
    ],
    [
      "microsoft",
      {
        MICROSOFT_AUTH_CLIENT_ID: "microsoft-auth-client",
        MICROSOFT_AUTH_CLIENT_SECRET: "microsoft-auth-secret",
      },
      "login.microsoftonline.com",
      null,
    ],
  ] as const)(
    "starts %s participant OAuth with state and identity-only scopes",
    async (provider, override, expectedHost, expectedPrompt) => {
      const tokenValidation = vi.fn(async () =>
        Response.json({
          success: true,
          hostname: "localhost",
          action: "social_sign_in",
        }),
      );
      vi.stubGlobal("fetch", tokenValidation);
      const response = await signInAction({
        request: formRequest(
          "http://localhost/sign-in",
          {
            _intent: "social_sign_in",
            provider,
            returnTo: "/participant/dashboard?tab=calendar",
            "turnstile-token": "social-turnstile-token",
          },
          { "cf-connecting-ip": "203.0.113.13" },
        ),
        params: {},
        context: context({
          ...productionEnv(),
          ...override,
        } as unknown as CloudflareEnvironment),
      } as never);

      expect(response).toBeInstanceOf(Response);
      const redirectResponse = response as Response;
      expect(redirectResponse.status).toBe(302);
      const destination = new URL(redirectResponse.headers.get("location")!);
      expect(destination.hostname).toBe(expectedHost);
      expect(
        new Set(destination.searchParams.get("scope")?.split(" ")),
      ).toEqual(new Set(["openid", "email", "profile"]));
      expect(destination.searchParams.get("scope")).not.toMatch(
        /calendar|User\.Read|offline_access/i,
      );
      expect(destination.searchParams.get("prompt")).toBe(expectedPrompt);
      expect(destination.toString()).not.toContain("attacker.example");
      expect(redirectResponse.headers.get("set-cookie")).toContain(
        "better-auth.state",
      );
      expect(tokenValidation).toHaveBeenCalledOnce();
      if (provider === "microsoft") {
        expect(destination.searchParams.get("response_mode")).toBe("form_post");
        await expect(
          trustedParticipantOAuthProviders(
            { ...productionEnv(), ...override } as CloudflareEnvironment,
            new Request(
              `http://localhost/api/auth/callback/microsoft?state=${destination.searchParams.get("state")}`,
            ),
          ),
        ).resolves.toEqual([]);
      }
    },
  );

  it("derives Google step-up mode from the existing server session", async () => {
    const { token, cookie } = await sessionCookie("person-demo-admin");
    await env.DB.prepare(
      "UPDATE auth_sessions SET created_at = unixepoch() - 901 WHERE token = ?",
    )
      .bind(token)
      .run();
    const response = await signInAction({
      request: formRequest(
        "http://localhost/sign-in",
        {
          _intent: "social_sign_in",
          provider: "google",
          returnTo: "/admin/api",
          reauthenticate: "false",
          "turnstile-token": "unused",
        },
        { cookie },
      ),
      params: {},
      context: context({
        ...productionEnv(),
        GOOGLE_AUTH_CLIENT_ID: "google-auth-client",
        GOOGLE_AUTH_CLIENT_SECRET: "google-auth-secret",
      } as unknown as CloudflareEnvironment),
    } as never);

    if (response instanceof Response) {
      throw new Error("Unsupported Google reauthentication redirected.");
    }
    expect(response.init?.status).toBe(422);
    expect(response.data).toMatchObject({
      ok: false,
      message:
        "Use the email sign-in link or Microsoft to confirm your identity.",
    });
  });

  it("forces Microsoft login for an existing session despite a downgraded form", async () => {
    const { token, cookie } = await sessionCookie("person-demo-admin");
    await env.DB.prepare(
      "UPDATE auth_sessions SET created_at = unixepoch() - 901 WHERE token = ?",
    )
      .bind(token)
      .run();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          success: true,
          hostname: "localhost",
          action: "social_sign_in",
        }),
      ),
    );
    const response = await signInAction({
      request: formRequest(
        "http://localhost/sign-in",
        {
          _intent: "social_sign_in",
          provider: "microsoft",
          returnTo: "/admin/api",
          reauthenticate: "false",
          "turnstile-token": "social-turnstile-token",
        },
        { cookie, "cf-connecting-ip": "203.0.113.14" },
      ),
      params: {},
      context: context({
        ...productionEnv(),
        MICROSOFT_AUTH_CLIENT_ID: "microsoft-auth-client",
        MICROSOFT_AUTH_CLIENT_SECRET: "microsoft-auth-secret",
      } as unknown as CloudflareEnvironment),
    } as never);

    expect(response).toBeInstanceOf(Response);
    const destination = new URL(
      (response as Response).headers.get("location")!,
    );
    expect(destination.searchParams.get("prompt")).toBe("login");
  });

  it("links an unverified Microsoft email only after authenticated email proof", async () => {
    const testEnv = {
      ...productionEnv(),
      MICROSOFT_AUTH_CLIENT_ID: "microsoft-auth-client",
      MICROSOFT_AUTH_CLIENT_SECRET: "microsoft-auth-secret",
    } as unknown as CloudflareEnvironment;
    const { cookie } = await sessionCookie("person-demo-admin");
    const started = await signInAction({
      request: formRequest(
        "http://localhost/sign-in?linkProvider=microsoft",
        {
          _intent: "link_social_account",
          provider: "microsoft",
          returnTo: "/admin/crm",
        },
        { cookie },
      ),
      params: {},
      context: context(testEnv),
    } as never);
    expect(started).toBeInstanceOf(Response);
    const startedResponse = started as Response;
    const destination = new URL(startedResponse.headers.get("location")!);
    const state = destination.searchParams.get("state");
    const stateCookie =
      startedResponse.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    expect(state).toBeTruthy();
    expect(stateCookie).toContain("better-auth.state");
    expect(destination.searchParams.get("response_mode")).toBe("form_post");

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("/oauth2/v2.0/token")) {
          return Response.json({
            access_token: "microsoft-access-token",
            token_type: "Bearer",
            expires_in: 3600,
            scope: "openid email profile",
            id_token: unsignedIdToken({
              sub: "microsoft-person-123",
              name: "Olivia Chen",
              email: "sbek-organizer@example.com",
            }),
          });
        }
        if (url.includes("graph.microsoft.com")) {
          return new Response(null, { status: 404 });
        }
        if (url.includes("challenges.cloudflare.com")) {
          return Response.json({
            success: true,
            hostname: "localhost",
            action: "social_sign_in",
          });
        }
        throw new Error(`Unexpected Microsoft callback request to ${url}`);
      }),
    );
    const postedCallback = await authApiAction({
      request: formRequest(
        "http://localhost/api/auth/callback/microsoft",
        {
          state: state!,
          code: "microsoft-valid-code-123",
        },
        { origin: "https://login.microsoftonline.com" },
      ),
      params: { "*": "callback/microsoft" },
      context: context(testEnv),
    } as never);
    expect(postedCallback.status).toBe(303);
    expect(postedCallback.headers.get("cache-control")).toBe("no-store");
    expect(postedCallback.headers.get("referrer-policy")).toBe("no-referrer");
    const cleanCallbackURL = new URL(
      postedCallback.headers.get("location")!,
      "http://localhost",
    );
    expect(cleanCallbackURL.pathname).toBe("/api/auth/callback/microsoft");
    expect(cleanCallbackURL.searchParams.get("relay")).toMatch(
      /^[A-Za-z0-9_-]{32,64}$/u,
    );
    expect(cleanCallbackURL.searchParams.has("code")).toBe(false);
    expect(cleanCallbackURL.searchParams.has("state")).toBe(false);
    const encryptedRelay = await env.DB.prepare(
      "SELECT value FROM verification_tokens WHERE identifier = ?",
    )
      .bind(
        `microsoft-auth-callback-relay:${cleanCallbackURL.searchParams.get("relay")}`,
      )
      .first<{ value: string }>();
    expect(encryptedRelay?.value).not.toContain("microsoft-valid-code-123");
    expect(encryptedRelay?.value).not.toContain(state);

    const callback = await authApiLoader({
      request: new Request(cleanCallbackURL, {
        headers: { cookie: `${cookie}; ${stateCookie}` },
      }),
      params: { "*": "callback/microsoft" },
      context: context(testEnv),
    } as never);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe("/admin/crm");
    expect(
      await env.DB.prepare(
        `
          SELECT person_id AS personId, account_id AS accountId
            FROM auth_accounts
           WHERE provider_id = 'microsoft'
             AND account_id = 'microsoft-person-123'
        `,
      ).first<{ personId: string; accountId: string }>(),
    ).toEqual({
      personId: "person-demo-admin",
      accountId: "microsoft-person-123",
    });

    const futureStarted = await signInAction({
      request: formRequest(
        "http://localhost/sign-in",
        {
          _intent: "social_sign_in",
          provider: "microsoft",
          returnTo: "/admin/crm",
          "turnstile-token": "future-microsoft-turnstile",
        },
        { "cf-connecting-ip": "203.0.113.15" },
      ),
      params: {},
      context: context(testEnv),
    } as never);
    expect(futureStarted).toBeInstanceOf(Response);
    const futureStartedResponse = futureStarted as Response;
    const futureDestination = new URL(
      futureStartedResponse.headers.get("location")!,
    );
    const futureStateCookie =
      futureStartedResponse.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    expect(futureDestination.searchParams.get("response_mode")).toBe(
      "form_post",
    );
    const futurePostedCallback = await authApiAction({
      request: formRequest(
        "http://localhost/api/auth/callback/microsoft",
        {
          state: futureDestination.searchParams.get("state")!,
          code: "future-microsoft-valid-code-123",
        },
        { origin: "https://login.microsoftonline.com" },
      ),
      params: { "*": "callback/microsoft" },
      context: context(testEnv),
    } as never);
    expect(futurePostedCallback.status).toBe(303);
    const futureCleanCallbackURL = new URL(
      futurePostedCallback.headers.get("location")!,
      "http://localhost",
    );
    const duplicateRelayCallback = new URL(futureCleanCallbackURL);
    duplicateRelayCallback.searchParams.append(
      "relay",
      futureCleanCallbackURL.searchParams.get("relay")!,
    );
    const rejectedDuplicateRelay = await authApiLoader({
      request: new Request(duplicateRelayCallback, {
        headers: { cookie: futureStateCookie },
      }),
      params: { "*": "callback/microsoft" },
      context: context(testEnv),
    } as never);
    expect(rejectedDuplicateRelay.status).toBe(400);

    const futureCallback = await authApiLoader({
      request: new Request(futureCleanCallbackURL, {
        headers: { cookie: futureStateCookie },
      }),
      params: { "*": "callback/microsoft" },
      context: context(testEnv),
    } as never);
    expect(futureCallback.status).toBe(302);
    expect(futureCallback.headers.get("location")).toBe("/admin/crm");
    expect(futureCallback.headers.get("set-cookie")).toContain(
      "better-auth.session_token",
    );

    const replayedCallback = await authApiLoader({
      request: new Request(
        new URL(
          futurePostedCallback.headers.get("location")!,
          "http://localhost",
        ),
        { headers: { cookie: futureStateCookie } },
      ),
      params: { "*": "callback/microsoft" },
      context: context(testEnv),
    } as never);
    expect(replayedCallback.status).toBe(400);
    await expect(replayedCallback.text()).resolves.toContain(
      "invalid or expired",
    );
  });

  it("rejects Microsoft authorization codes delivered in the browser URL", async () => {
    const tokenExchange = vi.fn();
    vi.stubGlobal("fetch", tokenExchange);
    const response = await authApiLoader({
      request: new Request(
        "http://localhost/api/auth/callback/microsoft?state=browser-state-value-123456&code=browser-visible-authorization-code",
      ),
      params: { "*": "callback/microsoft" },
      context: context({
        ...productionEnv(),
        MICROSOFT_AUTH_CLIENT_ID: "microsoft-auth-client",
        MICROSOFT_AUTH_CLIENT_SECRET: "microsoft-auth-secret",
      } as unknown as CloudflareEnvironment),
    } as never);

    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.text()).resolves.toContain("invalid or expired");
    expect(tokenExchange).not.toHaveBeenCalled();
  });

  it("relays a Microsoft denial without putting error state in the browser URL", async () => {
    const providerRequests = vi.fn(async (input: string | URL | Request) => {
      if (String(input).includes("challenges.cloudflare.com")) {
        return Response.json({
          success: true,
          hostname: "localhost",
          action: "social_sign_in",
        });
      }
      throw new Error(`Unexpected provider request to ${String(input)}`);
    });
    vi.stubGlobal("fetch", providerRequests);
    const testEnv = {
      ...productionEnv(),
      MICROSOFT_AUTH_CLIENT_ID: "microsoft-auth-client",
      MICROSOFT_AUTH_CLIENT_SECRET: "microsoft-auth-secret",
    } as unknown as CloudflareEnvironment;
    const started = await signInAction({
      request: formRequest(
        "http://localhost/sign-in",
        {
          _intent: "social_sign_in",
          provider: "microsoft",
          returnTo: "/admin/crm",
          "turnstile-token": "microsoft-denial-turnstile",
        },
        { "cf-connecting-ip": "203.0.113.16" },
      ),
      params: {},
      context: context(testEnv),
    } as never);
    expect(started).toBeInstanceOf(Response);
    const startedResponse = started as Response;
    const authorizationURL = new URL(startedResponse.headers.get("location")!);
    const stateCookie =
      startedResponse.headers.get("set-cookie")?.split(";", 1)[0] ?? "";

    const posted = await authApiAction({
      request: formRequest(
        "http://localhost/api/auth/callback/microsoft",
        {
          state: authorizationURL.searchParams.get("state")!,
          error: "access_denied",
          error_description: "The user cancelled Microsoft sign-in.",
        },
        { origin: "https://login.microsoftonline.com" },
      ),
      params: { "*": "callback/microsoft" },
      context: context(testEnv),
    } as never);
    expect(posted.status).toBe(303);
    const cleanCallbackURL = new URL(
      posted.headers.get("location")!,
      "http://localhost",
    );
    expect(Array.from(cleanCallbackURL.searchParams.keys())).toEqual(["relay"]);

    const completed = await authApiLoader({
      request: new Request(cleanCallbackURL, {
        headers: { cookie: stateCookie },
      }),
      params: { "*": "callback/microsoft" },
      context: context(testEnv),
    } as never);
    expect(completed.status).toBe(302);
    const failureURL = new URL(
      completed.headers.get("location")!,
      "http://localhost",
    );
    expect(failureURL.pathname).toBe("/sign-in");
    expect(failureURL.searchParams.get("provider")).toBe("microsoft");
    expect(failureURL.searchParams.get("error")).toBe("access_denied");
    expect(providerRequests).toHaveBeenCalledOnce();
  });

  it("redacts OAuth state details reported by the authentication library", async () => {
    const logging = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const sensitiveState = "oauth-state-secret-that-must-not-be-logged";

    const response = await authApiLoader({
      request: new Request(
        `http://localhost/api/auth/callback/google?state=${sensitiveState}&code=invalid-code`,
      ),
      params: { "*": "callback/google" },
      context: context({
        ...productionEnv(),
        GOOGLE_AUTH_CLIENT_ID: "google-auth-client",
        GOOGLE_AUTH_CLIENT_SECRET: "google-auth-secret",
      } as unknown as CloudflareEnvironment),
    } as never);

    expect(response.status).toBe(302);
    expect(logging).toHaveBeenCalledOnce();
    const output = String(logging.mock.calls[0]?.[0]);
    expect(JSON.parse(output)).toMatchObject({
      subsystem: "better-auth",
      event: "library-report",
      errorName: "StateError",
    });
    expect(output).not.toContain(sensitiveState);
    expect(output).not.toContain("invalid-code");
  });

  it("reports only configured social providers to the sign-in interface", async () => {
    const loaded = await signInLoader({
      request: new Request("http://localhost/sign-in"),
      params: {},
      context: context({
        ...productionEnv(),
        GOOGLE_AUTH_CLIENT_ID: "google-auth-client",
        GOOGLE_AUTH_CLIENT_SECRET: "google-auth-secret",
      } as unknown as CloudflareEnvironment),
    } as never);
    if (loaded instanceof Response) {
      throw new Error("The anonymous sign-in loader unexpectedly redirected.");
    }
    expect(loaded.socialProviders).toEqual({
      google: true,
      microsoft: false,
    });
  });

  it("allows an authenticated person to complete an explicit sign-in-again step", async () => {
    const { cookie } = await sessionCookie("person-demo-admin");
    const loaded = await signInLoader({
      request: new Request(
        "http://localhost/sign-in?returnTo=%2Fadmin%2Fapi&reauthenticate=true",
        { headers: { cookie } },
      ),
      params: {},
      context: context(productionEnv()),
    } as never);
    if (loaded instanceof Response) {
      throw new Error("The explicit reauthentication page redirected away.");
    }
    expect(loaded).toMatchObject({
      returnTo: "/admin/api",
      reauthentication: true,
      sessionEmail: "sbek-organizer@example.com",
    });
  });

  it("hides Google when a fresh provider authentication cannot be required", async () => {
    const { cookie } = await sessionCookie("person-demo-admin");
    const loaded = await signInLoader({
      request: new Request(
        "http://localhost/sign-in?returnTo=%2Fadmin%2Fapi&reauthenticate=true",
        { headers: { cookie } },
      ),
      params: {},
      context: context({
        ...productionEnv(),
        GOOGLE_AUTH_CLIENT_ID: "google-auth-client",
        GOOGLE_AUTH_CLIENT_SECRET: "google-auth-secret",
      } as unknown as CloudflareEnvironment),
    } as never);
    if (loaded instanceof Response) {
      throw new Error("The explicit reauthentication page redirected away.");
    }
    expect(loaded.socialProviders.google).toBe(false);
  });

  it("requires a recent session on the real API settings mutation boundary", async () => {
    const testEnv = productionEnv();
    const { token, cookie } = await sessionCookie("person-demo-admin");
    await testEnv.DB.prepare(
      "UPDATE auth_sessions SET created_at = unixepoch() - 901 WHERE token = ?",
    )
      .bind(token)
      .run();
    const selectedEvent = currentEventCookie("evt-foe-2025", testEnv).split(
      ";",
      1,
    )[0];
    let response: Response | null = null;
    try {
      await apiSettingsAction({
        request: new Request("http://localhost/admin/api?tab=webhooks", {
          method: "POST",
          headers: { cookie: `${cookie}; ${selectedEvent}` },
        }),
        params: {},
        context: context(testEnv),
      } as never);
    } catch (error) {
      if (error instanceof Response) response = error;
      else throw error;
    }
    expect(response?.status).toBe(303);
    expect(response?.headers.get("location")).toBe(
      "/sign-in?returnTo=%2Fadmin%2Fapi%3Ftab%3Dwebhooks&reauthenticate=true",
    );
  });

  it.each(["save", "rotate-secret"])(
    "requires a recent session for webhook credential command %s",
    async (command) => {
      const testEnv = productionEnv();
      const { token, cookie } = await sessionCookie("person-demo-admin");
      await testEnv.DB.prepare(
        "UPDATE auth_sessions SET created_at = unixepoch() - 901 WHERE token = ?",
      )
        .bind(token)
        .run();
      const response = await administrationCommandAction({
        request: new Request(
          `http://localhost/api/v1/events/evt-foe-2025/administration/webhook-endpoints/${command === "save" ? "new" : "webhook-missing"}/${command}`,
          {
            method: "POST",
            headers: {
              cookie,
              origin: "http://localhost",
              "content-type": "application/json",
              "idempotency-key": `recent-auth-${command}`,
            },
            body: "{}",
          },
        ),
        params: {
          eventId: "evt-foe-2025",
          family: "webhook-endpoints",
          itemId: command === "save" ? "new" : "webhook-missing",
          command,
        },
        context: context(testEnv),
      } as never);

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "RECENT_AUTHENTICATION_REQUIRED",
          details: {
            reauthenticationPath:
              "/sign-in?returnTo=%2Fadmin%2Fapi%3Ftab%3Dwebhooks&reauthenticate=true",
          },
        },
      });
    },
  );

  it("turns Microsoft's unverified-email failure into an email-proof handoff", async () => {
    const testEnv = {
      ...productionEnv(),
      MICROSOFT_AUTH_CLIENT_ID: "microsoft-auth-client",
      MICROSOFT_AUTH_CLIENT_SECRET: "microsoft-auth-secret",
    } as unknown as CloudflareEnvironment;
    const loaded = await signInLoader({
      request: new Request(
        "http://localhost/sign-in?returnTo=%2Fadmin%2Fcrm&provider=microsoft&error=account_not_linked",
      ),
      params: {},
      context: context(testEnv),
    } as never);
    if (loaded instanceof Response) {
      throw new Error("The Microsoft handoff unexpectedly redirected.");
    }
    expect(loaded.microsoftNeedsEmailProof).toBe(true);
    expect(loaded.linkRequest).toBeNull();

    const delivery = vi.fn(
      async (input: RequestInfo | URL) =>
        new Response(
          JSON.stringify(
            String(input).includes("siteverify")
              ? { success: true, hostname: "localhost", action: "sign_in" }
              : { id: "microsoft-proof-email" },
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", delivery);
    const result = await signInAction({
      request: formRequest(
        "http://localhost/sign-in",
        {
          _intent: "email_magic_link",
          email: "sbek-organizer@example.com",
          returnTo: "/admin/crm",
          linkProviderAfterEmail: "microsoft",
          "turnstile-token": "turnstile-token",
        },
        { "cf-connecting-ip": "203.0.113.14" },
      ),
      params: {},
      context: context(testEnv),
    } as never);
    if (result instanceof Response) {
      throw new Error(
        "The Microsoft proof email unexpectedly returned raw HTTP.",
      );
    }
    expect(result.data).toMatchObject({ ok: true });
    const emailCall = (
      delivery.mock.calls as unknown as Array<[string, RequestInit]>
    ).find(([url]) => !String(url).includes("siteverify"));
    const delivered = JSON.parse(String(emailCall?.[1].body)) as {
      text: string;
    };
    const link = new URL(delivered.text.match(/https?:\/\/\S+/u)?.[0] ?? "");
    expect(link.searchParams.get("callbackURL")).toBe(
      "/sign-in?returnTo=%2Fadmin%2Fcrm&linkProvider=microsoft",
    );
    expect(link.searchParams.get("newUserCallbackURL")).toBe("/");
  });

  it("shows the explicit Microsoft link step only to an authenticated person", async () => {
    const testEnv = {
      ...productionEnv(),
      MICROSOFT_AUTH_CLIENT_ID: "microsoft-auth-client",
      MICROSOFT_AUTH_CLIENT_SECRET: "microsoft-auth-secret",
    } as unknown as CloudflareEnvironment;
    const anonymous = await signInLoader({
      request: new Request(
        "http://localhost/sign-in?returnTo=%2Fadmin%2Fcrm&linkProvider=microsoft",
      ),
      params: {},
      context: context(testEnv),
    } as never);
    if (anonymous instanceof Response) {
      throw new Error("The anonymous link page unexpectedly redirected.");
    }
    expect(anonymous.linkRequest).toBeNull();

    const { cookie } = await sessionCookie("person-demo-admin");
    const authenticated = await signInLoader({
      request: new Request(
        "http://localhost/sign-in?returnTo=%2Fadmin%2Fcrm&linkProvider=microsoft",
        { headers: { cookie } },
      ),
      params: {},
      context: context(testEnv),
    } as never);
    if (authenticated instanceof Response) {
      throw new Error("The authenticated link page unexpectedly redirected.");
    }
    expect(authenticated.linkRequest).toEqual({
      provider: "microsoft",
      email: "sbek-organizer@example.com",
      failed: false,
    });
  });

  it("keeps underlying account details out of the sign-in loader while evaluator access is active", async () => {
    const testEnv = {
      ...productionEnv(),
      EVALUATION_MODE: "true",
      EVALUATION_SESSION_SECRET:
        "sign-in-evaluation-session-secret-with-thirty-two-characters",
      MICROSOFT_AUTH_CLIENT_ID: "microsoft-auth-client",
      MICROSOFT_AUTH_CLIENT_SECRET: "microsoft-auth-secret",
    } as unknown as CloudflareEnvironment;
    const { cookie: accountCookie } = await sessionCookie("person-demo-admin");
    const evaluationCookie = await selectedEvaluationCookie(testEnv);

    const result = await signInLoader({
      request: new Request(
        "http://localhost/sign-in?returnTo=%2Fadmin%2Fcrm&linkProvider=microsoft",
        { headers: { cookie: `${evaluationCookie}; ${accountCookie}` } },
      ),
      params: {},
      context: context(testEnv),
    } as never);

    expect(result).toBeInstanceOf(Response);
    const response = result as Response;
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/evaluate");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    await expect(response.text()).resolves.not.toContain(
      "sbek-organizer@example.com",
    );
  });

  it("does not create account-link state while evaluator access is active", async () => {
    const testEnv = {
      ...productionEnv(),
      EVALUATION_MODE: "true",
      EVALUATION_SESSION_SECRET:
        "sign-in-evaluation-session-secret-with-thirty-two-characters",
      MICROSOFT_AUTH_CLIENT_ID: "microsoft-auth-client",
      MICROSOFT_AUTH_CLIENT_SECRET: "microsoft-auth-secret",
    } as unknown as CloudflareEnvironment;
    const { cookie: accountCookie } = await sessionCookie("person-demo-admin");
    const evaluationCookie = await selectedEvaluationCookie(testEnv);
    const before = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM verification_tokens) AS verificationCount,
         (SELECT COUNT(*) FROM auth_accounts) AS accountCount,
         (SELECT COUNT(*) FROM auth_sessions) AS sessionCount`,
    ).first<{
      verificationCount: number;
      accountCount: number;
      sessionCount: number;
    }>();

    const result = await signInAction({
      request: formRequest(
        "http://localhost/sign-in?linkProvider=microsoft",
        {
          _intent: "link_social_account",
          provider: "microsoft",
          returnTo: "/admin/crm",
        },
        { cookie: `${evaluationCookie}; ${accountCookie}` },
      ),
      params: {},
      context: context(testEnv),
    } as never);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(303);
    expect((result as Response).headers.get("location")).toBe("/evaluate");
    await expect(
      env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM verification_tokens) AS verificationCount,
           (SELECT COUNT(*) FROM auth_accounts) AS accountCount,
           (SELECT COUNT(*) FROM auth_sessions) AS sessionCount`,
      ).first(),
    ).resolves.toEqual(before);
  });
});
