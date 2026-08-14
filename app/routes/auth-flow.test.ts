import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { serializeSignedCookie } from "better-call";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDemoSubmissionForm } from "~/modules/submissions/demo-submissions.server";
import {
  createAuth,
  ParticipantOAuthConfigurationError,
  participantOAuthConfiguration,
  participantOAuthProviderOptions,
  trustedParticipantOAuthProviders,
} from "~/platform/auth/auth.server";
import {
  currentEventCookie,
  resolveCurrentEventId,
} from "~/platform/auth/current-event.server";
import { safeReturnTo } from "~/platform/auth/return-to";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { evaluationSessionCookie } from "~/platform/evaluation/evaluation-session.server";
import { action as applicationAction } from "./application-form";
import { action as authApiAction, loader as authApiLoader } from "./auth-api";
import { loader as homeLoader } from "./home";
import { action as signInAction, loader as signInLoader } from "./sign-in";
import { action as signOutAction } from "./sign-out";

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

function validatedProductionEnv() {
  return productionEnv();
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
       id, organisation_id, event_id, actor_id, action,
       entity_type, entity_id, metadata_json, created_at
     ) VALUES (?, 'org-future-events', 'evt-foe-2025', 'test-operator',
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
  });

  it.each([
    [
      "google",
      {
        GOOGLE_AUTH_CLIENT_ID: "google-auth-client",
        GOOGLE_AUTH_CLIENT_SECRET: "google-auth-secret",
      },
      "accounts.google.com",
    ],
    [
      "microsoft",
      {
        MICROSOFT_AUTH_CLIENT_ID: "microsoft-auth-client",
        MICROSOFT_AUTH_CLIENT_SECRET: "microsoft-auth-secret",
      },
      "login.microsoftonline.com",
    ],
  ] as const)(
    "starts %s participant OAuth with state and identity-only scopes",
    async (provider, override, expectedHost) => {
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

  it("creates a hashed magic-link verification for an invited person and calls the configured delivery boundary", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    const delivery = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "email-test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", delivery);

    await createAuth(testEnv).api.signInMagicLink({
      body: {
        email: "sbek-organizer@example.com",
        callbackURL: "/admin/event",
      },
      headers: new Headers({ origin: "http://localhost" }),
    });

    expect(delivery).toHaveBeenCalledOnce();
    const [url, init] = delivery.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers).toMatchObject({
      authorization: "Bearer test-resend-key",
    });
    const email = JSON.parse(String(init.body)) as {
      to: string[];
      text: string;
    };
    expect(email.to).toEqual(["sbek-organizer@example.com"]);
    const deliveredToken = new URL(
      email.text.match(/https?:\/\/\S+/)?.[0] ?? "http://invalid",
    ).searchParams.get("token");
    expect(deliveredToken).toBeTruthy();

    const verification = await env.DB.prepare(
      `
      SELECT identifier, value
        FROM verification_tokens
       ORDER BY created_at DESC
       LIMIT 1
    `,
    ).first<{ identifier: string; value: string }>();
    expect(verification).not.toBeNull();
    expect(verification?.identifier).not.toBe(deliveredToken);
    expect(verification?.value).not.toBe(deliveredToken);
  });

  it("accepts only safe same-origin return paths", () => {
    expect(safeReturnTo("/participant/dashboard?tab=files")).toBe(
      "/participant/dashboard?tab=files",
    );
    expect(safeReturnTo("https://attacker.example/path")).toBe("/");
    expect(safeReturnTo("//attacker.example/path")).toBe("/");
    expect(safeReturnTo("/\\attacker.example/path")).toBe("/");
    expect(safeReturnTo("/\t/attacker.example/path")).toBe("/");
    expect(safeReturnTo("/sign-in?returnTo=/sign-in")).toBe("/");
    expect(safeReturnTo("/api/auth/sign-out")).toBe("/");
  });

  it("keeps eligible and unknown sign-in requests observationally identical", async () => {
    const delivery = vi.fn(
      async (input: RequestInfo | URL) =>
        new Response(
          JSON.stringify(
            String(input).includes("siteverify")
              ? { success: true, hostname: "localhost", action: "sign_in" }
              : { id: "email-test" },
          ),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", delivery);
    const testContext = context(productionEnv());
    const unknownEmail = `unknown-${crypto.randomUUID()}@example.com`;

    const eligible = await signInAction({
      request: formRequest(
        "http://localhost/sign-in",
        {
          _intent: "email_magic_link",
          email: "sbek-organizer@example.com",
          returnTo: "/participant/dashboard?tab=files",
          "turnstile-token": "turnstile-token",
        },
        { "cf-connecting-ip": "203.0.113.10" },
      ),
      params: {},
      context: testContext,
    } as never);
    const unknown = await signInAction({
      request: formRequest(
        "http://localhost/sign-in",
        {
          _intent: "email_magic_link",
          email: unknownEmail,
          returnTo: "/participant/dashboard?tab=files",
          "turnstile-token": "turnstile-token",
        },
        { "cf-connecting-ip": "203.0.113.11" },
      ),
      params: {},
      context: testContext,
    } as never);

    if (eligible instanceof Response || unknown instanceof Response) {
      throw new Error(
        "A valid sign-in request unexpectedly returned a raw response.",
      );
    }
    expect(eligible.data).toEqual(unknown.data);
    expect(eligible.data).toEqual({
      ok: true,
      message: "A one-time sign-in link will arrive shortly.",
    });
    const emailCalls = (
      delivery.mock.calls as unknown as Array<[string, RequestInit]>
    ).filter(([url]) => !String(url).includes("siteverify"));
    expect(emailCalls).toHaveLength(2);
    for (const [, init] of emailCalls) {
      const delivered = JSON.parse(String(init.body)) as { text: string };
      const link = delivered.text.match(/https?:\/\/\S+/)?.[0];
      expect(new URL(link!).searchParams.get("callbackURL")).toBe(
        "/participant/dashboard?tab=files",
      );
      expect(new URL(link!).searchParams.get("newUserCallbackURL")).toBe("/");
    }
    const unknownDelivery = JSON.parse(String(emailCalls[1]![1].body)) as {
      text: string;
    };
    const unknownLink = unknownDelivery.text.match(/https?:\/\/\S+/u)?.[0];
    const verified = await authApiLoader({
      request: new Request(unknownLink!),
      params: { "*": "magic-link/verify" },
      context: testContext,
    } as never);
    expect(verified.status).toBe(302);
    expect(new URL(verified.headers.get("location")!).pathname).toBe("/");
    await expect(
      env.DB.prepare(
        "SELECT email_verified AS emailVerified FROM people WHERE email = ?",
      )
        .bind(unknownEmail)
        .first<{ emailVerified: number }>(),
    ).resolves.toEqual({ emailVerified: 1 });
  });

  it("does not disclose provider errors and rejects non-POST sign-in requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("siteverify")
          ? Response.json({
              success: true,
              hostname: "localhost",
              action: "sign_in",
            })
          : new Response("provider-secret-detail", { status: 500 }),
      ),
    );
    const logging = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const testContext = context(productionEnv());
    const failed = await signInAction({
      request: formRequest(
        "http://localhost/sign-in",
        {
          _intent: "email_magic_link",
          email: "sbek-organizer@example.com",
          returnTo: "/admin/event",
          "turnstile-token": "turnstile-token",
        },
        { "cf-connecting-ip": "203.0.113.12" },
      ),
      params: {},
      context: testContext,
    } as never);

    if (failed instanceof Response) {
      throw new Error(
        "The provider failure unexpectedly returned a raw response.",
      );
    }
    expect(failed.init?.status).toBe(503);
    expect(failed.data).toEqual({
      ok: false,
      message:
        "Sign-in email could not be requested right now. Please try again later.",
    });
    expect(JSON.stringify(failed.data)).not.toContain("provider-secret-detail");
    expect(logging).toHaveBeenCalledOnce();
    const output = String(logging.mock.calls[0]?.[0]);
    expect(JSON.parse(output)).toMatchObject({
      subsystem: "authentication",
      event: "magic-link-request-failed",
      errorName: "ResendDeliveryError",
    });
    expect(output).not.toContain("provider-secret-detail");
    expect(output).not.toContain("sbek-organizer@example.com");

    const rejected = await signInAction({
      request: new Request("http://localhost/sign-in", { method: "PUT" }),
      params: {},
      context: testContext,
    } as never);
    if (!(rejected instanceof Response)) {
      throw new Error(
        "A non-POST sign-in request was not rejected as a response.",
      );
    }
    expect(rejected.status).toBe(405);
    expect(rejected.headers.get("allow")).toBe("POST");
  });

  it("routes each authenticated event role to its own surface", async () => {
    const testEnv = validatedProductionEnv();
    for (const [personId, expected] of [
      ["person-demo-admin", "/admin/event"],
      ["person-demo-evaluator", "/review/workbench"],
      ["person-demo-speaker", "/participant/dashboard"],
      ["person-demo-submitter", "/participant/dashboard"],
    ] as const) {
      const { cookie } = await sessionCookie(personId);
      const eventCookie = currentEventCookie("evt-foe-2025", testEnv).split(
        ";",
        1,
      )[0];
      const response = await homeLoader({
        request: new Request("http://localhost/", {
          headers: { cookie: `${cookie}; ${eventCookie}` },
        }),
        params: {},
        context: context(testEnv),
      } as never);
      expect(response).toBeInstanceOf(Response);
      expect((response as Response).status).toBe(302);
      expect((response as Response).headers.get("location")).toBe(expected);
    }
  });

  it("establishes the sole event while routing home without repeating authentication", async () => {
    const testEnv = validatedProductionEnv();
    const { cookie } = await sessionCookie("person-demo-admin");
    const response = await homeLoader({
      request: new Request("http://localhost/", {
        headers: { cookie },
      }),
      params: {},
      context: context(testEnv),
    } as never);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(302);
    expect((response as Response).headers.get("location")).toBe("/admin/event");
    expect((response as Response).headers.get("set-cookie")).toContain(
      "__Host-program_cue_event=evt-foe-2025",
    );
  });

  it("keeps an authenticated identity without memberships outside private workspaces", async () => {
    const personId = `person-no-access-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO people (
         id, email, display_name, email_verified, profile_status
       ) VALUES (?, ?, 'No access', 1, 'draft')`,
    )
      .bind(personId, `${personId}@example.com`)
      .run();
    const { cookie } = await sessionCookie(personId);
    const request = new Request("http://localhost/", { headers: { cookie } });

    await expect(
      homeLoader({
        request,
        params: {},
        context: context(validatedProductionEnv()),
      } as never),
    ).resolves.toEqual({ hasWorkspaceAccess: false });
    await expect(
      resolveCurrentEventId(
        new Request("http://localhost/admin/event", { headers: { cookie } }),
        validatedProductionEnv(),
        ["owner", "administrator"],
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("establishes an initial event only on safe navigation and never during a mutation", async () => {
    const testEnv = validatedProductionEnv();
    const { cookie } = await sessionCookie("person-demo-admin");
    const initial = await resolveCurrentEventId(
      new Request("http://localhost/admin/event", { headers: { cookie } }),
      testEnv,
      ["administrator"],
    ).catch((error: unknown) => error);
    expect(initial).toBeInstanceOf(Response);
    expect((initial as Response).status).toBe(302);
    expect((initial as Response).headers.get("location")).toBe("/admin/event");
    expect((initial as Response).headers.get("set-cookie")).toContain(
      "__Host-program_cue_event=evt-foe-2025",
    );

    await expect(
      resolveCurrentEventId(
        new Request("http://localhost/admin/event", {
          method: "POST",
          headers: { cookie, origin: "http://localhost" },
        }),
        testEnv,
        ["administrator"],
      ),
    ).rejects.toMatchObject({ status: 428 });
  });

  it("redirects a sole pending invitation to explicit selection without accepting it during navigation", async () => {
    const testEnv = validatedProductionEnv();
    const { cookie } = await sessionCookie("person-demo-evaluator");
    await env.DB.prepare(
      `UPDATE memberships
          SET accepted_at = NULL, invited_at = unixepoch(),
              invitation_expires_at = unixepoch() + 300, revoked_at = NULL
        WHERE id = 'membership-demo-evaluator'`,
    ).run();
    const auditBefore = await env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM audit_events
        WHERE entity_id = 'membership-demo-evaluator'
          AND action = 'membership.accepted'`,
    ).first<{ count: number }>();

    const result = await resolveCurrentEventId(
      new Request("http://localhost/review/workbench", {
        headers: { cookie },
      }),
      testEnv,
      ["evaluator"],
    ).catch((error: unknown) => error);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(302);
    expect((result as Response).headers.get("location")).toBe(
      "/events/select?returnTo=%2Freview%2Fworkbench",
    );
    expect((result as Response).headers.has("set-cookie")).toBe(false);
    expect(
      await env.DB.prepare(
        `SELECT accepted_at AS acceptedAt
           FROM memberships
          WHERE id = 'membership-demo-evaluator'`,
      ).first<{ acceptedAt: number | null }>(),
    ).toEqual({ acceptedAt: null });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count
           FROM audit_events
          WHERE entity_id = 'membership-demo-evaluator'
            AND action = 'membership.accepted'`,
      ).first<{ count: number }>(),
    ).toEqual(auditBefore);
  });

  it("deletes the durable session through a same-origin POST sign-out", async () => {
    const testEnv = validatedProductionEnv();
    const { token, cookie } = await sessionCookie("person-demo-admin");
    const response = await signOutAction({
      request: formRequest(
        "http://localhost/sign-out",
        { returnTo: "/admin/tasks" },
        { cookie },
      ),
      params: {},
      context: context(testEnv),
    } as never);

    if (!(response instanceof Response)) {
      throw new Error("Account sign-out did not return a redirect response.");
    }
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "/sign-in?returnTo=%2Fadmin%2Ftasks",
    );
    expect(response.headers.get("set-cookie")).toContain(
      "better-auth.session_token=",
    );
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("set-cookie")).toContain(
      "__Host-program_cue_event=",
    );
    expect(
      await env.DB.prepare("SELECT id FROM auth_sessions WHERE token = ?")
        .bind(token)
        .first(),
    ).toBeNull();
  });

  it("returns a selected demo identity to a genuinely anonymous browser", async () => {
    const response = await signOutAction({
      request: formRequest(
        "http://localhost/sign-out",
        {},
        {
          cookie:
            "program_cue_demo_identity=administrator; program_cue_event=evt-foe-2025",
        },
      ),
      params: {},
      context: context(env as unknown as CloudflareEnvironment),
    } as never);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/demo");
    expect(response.headers.get("set-cookie")).toContain(
      "program_cue_demo_identity=;",
    );
    expect(response.headers.get("set-cookie")).toContain("program_cue_event=;");
  });

  it("rejects cross-origin and non-POST sign-out attempts without deleting the session", async () => {
    const testEnv = productionEnv();
    const { token, cookie } = await sessionCookie("person-demo-admin");
    const crossOrigin = await signOutAction({
      request: formRequest(
        "http://localhost/sign-out",
        { returnTo: "/admin/event" },
        { cookie, origin: "https://attacker.example" },
      ),
      params: {},
      context: context(testEnv),
    } as never);
    expect(crossOrigin.status).toBe(403);
    expect(
      await env.DB.prepare("SELECT id FROM auth_sessions WHERE token = ?")
        .bind(token)
        .first(),
    ).not.toBeNull();

    const wrongMethod = await signOutAction({
      request: new Request("http://localhost/sign-out", { method: "DELETE" }),
      params: {},
      context: context(testEnv),
    } as never);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");
  });

  it("signs Better Auth users out from an account-required application", async () => {
    await env.DB.prepare(
      `
      UPDATE form_definitions SET access_mode = 'account_required'
       WHERE event_id = 'evt-foe-2025' AND public_slug = 'form'
    `,
    ).run();
    await env.DB.prepare(
      `
      UPDATE form_versions
         SET settings_snapshot_json = json_set(
           settings_snapshot_json, '$.accessMode', 'account_required'
         )
       WHERE event_id = 'evt-foe-2025' AND status = 'published'
         AND form_id = (
           SELECT id FROM form_definitions
            WHERE event_id = 'evt-foe-2025' AND public_slug = 'form'
         )
    `,
    ).run();
    const testEnv = productionEnv();
    const { token, cookie } = await sessionCookie("person-demo-submitter");
    const response = await applicationAction({
      request: formRequest(
        "http://localhost/apply/form",
        { _intent: "sign_out" },
        { cookie },
      ),
      params: { slug: "form" },
      context: context(testEnv),
    } as never);

    if (!(response instanceof Response)) {
      throw new Error(
        "Application sign-out did not return a redirect response.",
      );
    }
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "/sign-in?returnTo=%2Fapply%2Fform",
    );
    expect(
      await env.DB.prepare("SELECT id FROM auth_sessions WHERE token = ?")
        .bind(token)
        .first(),
    ).toBeNull();
  });
});
