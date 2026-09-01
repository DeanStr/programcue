import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { CalendarAdministrationService } from "./calendar-administration-service.server";
import { CalendarOAuthService } from "./calendar-oauth.server";
import {
  calendarCredentialGeneration,
  decryptCalendarCredentials,
  encryptCalendarCredentials,
} from "./calendar-providers.server";

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

const credentialKey = btoa(
  String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index + 1)),
);
const rotatedCredentialKey = btoa(
  String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index + 65)),
);

async function oauthEnvironment(fetcher: typeof fetch) {
  const testEnv = {
    ...(env as unknown as CloudflareEnvironment),
    DB: env.DB,
    APP_ENV: "production",
    BETTER_AUTH_URL: "https://programcue.test",
    CALENDAR_CREDENTIALS_KEY: credentialKey,
    GOOGLE_CALENDAR_CLIENT_ID: "google-client",
    GOOGLE_CALENDAR_CLIENT_SECRET: "google-secret",
    MICROSOFT_CALENDAR_CLIENT_ID: "microsoft-client",
    MICROSOFT_CALENDAR_CLIENT_SECRET: "microsoft-secret",
  } as unknown as CloudflareEnvironment & {
    GOOGLE_CALENDAR_CLIENT_ID: string;
    GOOGLE_CALENDAR_CLIENT_SECRET: string;
    MICROSOFT_CALENDAR_CLIENT_ID: string;
    MICROSOFT_CALENDAR_CLIENT_SECRET: string;
  };
  await ensureDemoData(testEnv);
  return {
    testEnv,
    service: new CalendarOAuthService(testEnv, fetcher),
  };
}

describe("direct-calendar OAuth", () => {
  it("uses PKCE and stores encrypted Google refresh credentials after callback", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const fetcher = async function (this: unknown, input, init) {
      if (this !== undefined)
        throw new TypeError("fetch received an invalid this reference");
      const url = String(input);
      requests.push({ url, body: String(init?.body ?? "") });
      if (url.includes("oauth2.googleapis.com/token"))
        return Response.json({
          access_token: "google-access-token",
          refresh_token: "google-refresh-token",
          expires_in: 3600,
          token_type: "Bearer",
        });
      if (url.includes("openidconnect.googleapis.com"))
        return Response.json({
          sub: "google-account-1",
          email: "calendar-owner@example.com",
        });
      return new Response("unexpected request", { status: 500 });
    } as typeof fetch;
    const { service, testEnv } = await oauthEnvironment(fetcher);
    const started = await service.start(viewer, "google");
    const authorization = new URL(started.authorizationUrl);
    expect(authorization.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(authorization.searchParams.get("scope")).toContain(
      "calendar.events",
    );

    const connected = await service.callback(viewer, {
      state: authorization.searchParams.get("state")!,
      code: "provider-code",
      nonce: started.nonce,
    });

    expect(connected).toEqual({
      provider: "google",
      account: "calendar-owner@example.com",
      returnTo: "/admin/communications",
    });
    const connection = await testEnv.DB.prepare(
      `SELECT id, encrypted_credentials AS encryptedCredentials, status,
              event_id AS eventId, expires_at AS expiresAt
         FROM calendar_connections
        WHERE organisation_id = ? AND person_id = ? AND provider = 'google'
          AND (event_id IS NULL OR event_id = ?)`,
    )
      .bind(viewer.organisationId, viewer.personId, viewer.eventId)
      .first<{
        id: string;
        encryptedCredentials: string | null;
        status: string;
        eventId: string | null;
        expiresAt: number;
      }>();
    expect(connection?.status).toBe("connected");
    expect(connection?.eventId).toBeNull();
    expect(connection?.encryptedCredentials).not.toContain(
      "google-refresh-token",
    );
    await expect(
      decryptCalendarCredentials(
        connection!.encryptedCredentials!,
        credentialKey,
        {
          connectionId: connection!.id,
          organisationId: viewer.organisationId,
          provider: "google",
        },
      ),
    ).resolves.toMatchObject({
      accessToken: "google-access-token",
      refreshToken: "google-refresh-token",
      calendarId: "primary",
    });
    expect(requests[0]?.body).toContain("code_verifier=");
    expect(requests[0]?.body).toContain(
      "redirect_uri=https%3A%2F%2Fprogramcue.test%2Foauth%2Fcalendar%2Fcallback",
    );

    await new CalendarAdministrationService(testEnv).disconnect(
      viewer,
      connection!.id,
    );
    await expect(
      testEnv.DB.prepare(
        `SELECT status, encrypted_credentials AS encryptedCredentials,
                expires_at AS expiresAt, scopes_json AS scopesJson
           FROM calendar_connections WHERE id = ?`,
      )
        .bind(connection!.id)
        .first(),
    ).resolves.toEqual({
      status: "disconnected",
      encryptedCredentials: null,
      expiresAt: null,
      scopesJson: "[]",
    });
    await expect(
      service.refreshConnection(viewer, connection!.id),
    ).rejects.toThrow("was not found");

    const reconnect = await service.start(viewer, "google");
    await service.callback(viewer, {
      state: new URL(reconnect.authorizationUrl).searchParams.get("state")!,
      code: "reconnect-code",
      nonce: reconnect.nonce,
    });
    await expect(
      testEnv.DB.prepare(
        "SELECT status, encrypted_credentials IS NOT NULL AS hasCredentials FROM calendar_connections WHERE id = ?",
      )
        .bind(connection!.id)
        .first(),
    ).resolves.toEqual({ status: "connected", hasCredentials: 1 });
  });

  it("uses Microsoft's mail address when a guest principal name is not an email", async () => {
    const requests: Array<{ url: string; body: string }> = [];
    const { service, testEnv } = await oauthEnvironment(async (input, init) => {
      const url = String(input);
      requests.push({ url, body: String(init?.body ?? "") });
      if (url.includes("/oauth2/v2.0/token"))
        return Response.json({
          access_token: "microsoft-calendar-access-token",
          refresh_token: "microsoft-calendar-refresh-token",
          expires_in: 3_600,
          token_type: "Bearer",
        });
      if (url.includes("graph.microsoft.com"))
        return Response.json({
          id: "microsoft-calendar-account-1",
          mail: "calendar-owner@example.com",
          userPrincipalName:
            "calendar-owner_example.com#EXT#@tenant.onmicrosoft.com",
        });
      return new Response("unexpected request", { status: 500 });
    });
    const started = await service.start(viewer, "microsoft");
    const authorization = new URL(started.authorizationUrl);
    expect(authorization.searchParams.get("scope")).toContain(
      "Calendars.ReadWrite",
    );

    await expect(
      service.callback(viewer, {
        state: authorization.searchParams.get("state")!,
        code: "microsoft-provider-code",
        nonce: started.nonce,
      }),
    ).resolves.toEqual({
      provider: "microsoft",
      account: "calendar-owner@example.com",
      returnTo: "/admin/communications",
    });
    const connection = await testEnv.DB.prepare(
      `SELECT id, encrypted_credentials AS encryptedCredentials, status
         FROM calendar_connections
        WHERE organisation_id = ? AND person_id = ? AND provider = 'microsoft'
          AND account_reference = ?`,
    )
      .bind(
        viewer.organisationId,
        viewer.personId,
        "microsoft-calendar-account-1",
      )
      .first<{ id: string; encryptedCredentials: string; status: string }>();
    expect(connection?.status).toBe("connected");
    expect(connection?.encryptedCredentials).not.toContain(
      "microsoft-calendar-refresh-token",
    );
    await expect(
      decryptCalendarCredentials(
        connection!.encryptedCredentials,
        credentialKey,
        {
          connectionId: connection!.id,
          organisationId: viewer.organisationId,
          provider: "microsoft",
        },
      ),
    ).resolves.toMatchObject({
      accessToken: "microsoft-calendar-access-token",
      refreshToken: "microsoft-calendar-refresh-token",
    });
    expect(requests[0]?.body).toContain("code_verifier=");
  });

  it("keeps pre-rotation OAuth state valid under the explicit previous key", async () => {
    const accountReference = `google-rotation-${crypto.randomUUID()}`;
    const fetcher = async (input: RequestInfo | URL) => {
      if (String(input).includes("oauth2.googleapis.com/token")) {
        return Response.json({
          access_token: "rotated-google-access-token",
          refresh_token: "rotated-google-refresh-token",
          expires_in: 3_600,
          token_type: "Bearer",
        });
      }
      return Response.json({
        sub: accountReference,
        email: "rotation-calendar@example.com",
      });
    };
    const { service, testEnv } = await oauthEnvironment(fetcher);
    const started = await service.start(viewer, "google");
    Object.assign(testEnv, {
      CALENDAR_CREDENTIALS_KEY: rotatedCredentialKey,
      CALENDAR_CREDENTIALS_PREVIOUS_KEY: credentialKey,
    });

    await expect(
      new CalendarOAuthService(testEnv, fetcher).callback(viewer, {
        state: new URL(started.authorizationUrl).searchParams.get("state")!,
        code: "post-rotation-provider-code",
        nonce: started.nonce,
      }),
    ).resolves.toMatchObject({ provider: "google" });

    const connection = await testEnv.DB.prepare(
      `SELECT id, encrypted_credentials AS encryptedCredentials
         FROM calendar_connections
        WHERE person_id = ? AND provider = 'google' AND account_reference = ?`,
    )
      .bind(viewer.personId, accountReference)
      .first<{ id: string; encryptedCredentials: string }>();
    await expect(
      decryptCalendarCredentials(
        connection!.encryptedCredentials,
        rotatedCredentialKey,
        {
          connectionId: connection!.id,
          organisationId: viewer.organisationId,
          provider: "google",
        },
      ),
    ).resolves.toMatchObject({
      refreshToken: "rotated-google-refresh-token",
    });
  });

  it("converges concurrent first callbacks on one decryptable account row", async () => {
    const accountReference = `google-concurrent-${crypto.randomUUID()}`;
    let profileCalls = 0;
    let releaseProfiles!: () => void;
    const profilesReady = new Promise<void>((resolve) => {
      releaseProfiles = resolve;
    });
    const fetcher = async (input: RequestInfo | URL) => {
      if (String(input).includes("oauth2.googleapis.com/token")) {
        return Response.json({
          access_token: `concurrent-access-${crypto.randomUUID()}`,
          refresh_token: `concurrent-refresh-${crypto.randomUUID()}`,
          expires_in: 3_600,
          token_type: "Bearer",
        });
      }
      profileCalls += 1;
      if (profileCalls === 2) releaseProfiles();
      await profilesReady;
      return Response.json({
        sub: accountReference,
        email: "concurrent-calendar@example.com",
      });
    };
    const { service, testEnv } = await oauthEnvironment(fetcher);
    const [first, second] = await Promise.all([
      service.start(viewer, "google"),
      service.start(viewer, "google"),
    ]);

    await Promise.all(
      [first, second].map((started, index) =>
        service.callback(viewer, {
          state: new URL(started.authorizationUrl).searchParams.get("state")!,
          code: `concurrent-provider-code-${index}`,
          nonce: started.nonce,
        }),
      ),
    );

    const rows = await testEnv.DB.prepare(
      `SELECT id, encrypted_credentials AS encryptedCredentials
         FROM calendar_connections
        WHERE person_id = ? AND provider = 'google' AND account_reference = ?`,
    )
      .bind(viewer.personId, accountReference)
      .all<{ id: string; encryptedCredentials: string }>();
    expect(rows.results).toHaveLength(1);
    await expect(
      decryptCalendarCredentials(
        rows.results[0]!.encryptedCredentials,
        credentialKey,
        {
          connectionId: rows.results[0]!.id,
          organisationId: viewer.organisationId,
          provider: "google",
        },
      ),
    ).resolves.toMatchObject({ tokenType: "Bearer" });
  });

  it("fails Microsoft account lookup explicitly when no usable email is returned", async () => {
    const { service } = await oauthEnvironment(async (input) => {
      if (String(input).includes("/oauth2/v2.0/token"))
        return Response.json({
          access_token: "microsoft-calendar-access-token",
          refresh_token: "microsoft-calendar-refresh-token",
          expires_in: 3_600,
          token_type: "Bearer",
        });
      return Response.json({
        id: "microsoft-calendar-account-without-email",
        mail: null,
        userPrincipalName:
          "calendar-owner_example.com#EXT#@tenant.onmicrosoft.com",
      });
    });
    const started = await service.start(viewer, "microsoft");

    await expect(
      service.callback(viewer, {
        state: new URL(started.authorizationUrl).searchParams.get("state")!,
        code: "microsoft-provider-code",
        nonce: started.nonce,
      }),
    ).rejects.toMatchObject({
      name: "CalendarProviderRequestError",
      provider: "microsoft",
      status: 200,
    });
  });

  it("classifies an unexpected production connection lookup without exposing its cause", async () => {
    const { service, testEnv } = await oauthEnvironment(async (input) => {
      if (String(input).includes("oauth2.googleapis.com/token"))
        return Response.json({
          access_token: "google-access-token",
          refresh_token: "google-refresh-token",
          expires_in: 3_600,
          token_type: "Bearer",
        });
      return Response.json({
        sub: "google-account-lookup-failure",
        email: "calendar-owner@example.com",
      });
    });
    const started = await service.start(viewer, "google");
    Object.assign(testEnv, {
      DB: {
        prepare() {
          throw new Error("sensitive production database detail");
        },
      } as unknown as D1Database,
    });

    await expect(
      service.callback(viewer, {
        state: new URL(started.authorizationUrl).searchParams.get("state")!,
        code: "google-provider-code",
        nonce: started.nonce,
      }),
    ).rejects.toMatchObject({
      name: "CalendarOAuthUnexpectedError",
      provider: "google",
      phase: "connection-lookup",
      message: "The calendar OAuth callback failed unexpectedly.",
    });
  });

  it("rejects a callback from a different browser nonce before token exchange", async () => {
    let providerCalls = 0;
    const { service } = await oauthEnvironment(async () => {
      providerCalls += 1;
      return new Response("should not be called", { status: 500 });
    });
    const started = await service.start(viewer, "microsoft");
    const state = new URL(started.authorizationUrl).searchParams.get("state")!;

    await expect(
      service.callback(viewer, {
        state,
        code: "provider-code",
        nonce: "a-different-browser-nonce",
      }),
    ).rejects.toThrow("browser state does not match");
    expect(providerCalls).toBe(0);
  });

  it("refreshes an expiring token and marks rejected refresh grants for attention", async () => {
    let rejectRefresh = false;
    let refreshCalls = 0;
    const { service, testEnv } = await oauthEnvironment(async () => {
      refreshCalls += 1;
      if (rejectRefresh)
        return Response.json(
          { error_description: "The refresh grant was revoked." },
          { status: 400 },
        );
      return Response.json({
        access_token: "refreshed-access-token",
        expires_in: 7200,
        token_type: "Bearer",
      });
    });
    const connectionId = crypto.randomUUID();
    const expiring = await encryptCalendarCredentials(
      {
        accessToken: "old-access-token",
        refreshToken: "durable-refresh-token",
        accessTokenExpiresAt: 1,
        tokenType: "Bearer",
        calendarId: "primary",
      },
      credentialKey,
      {
        connectionId,
        organisationId: viewer.organisationId,
        provider: "google",
      },
    );
    await testEnv.DB.prepare(
      `INSERT INTO calendar_connections (
         id, organisation_id, event_id, person_id, provider, account_reference,
         encrypted_credentials, scopes_json, status, expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'google', ?, ?, '[]', 'connected', 1, unixepoch(), unixepoch())`,
    )
      .bind(
        connectionId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        `refresh-${crypto.randomUUID()}`,
        expiring,
      )
      .run();

    await expect(
      service.refreshConnection(viewer, connectionId),
    ).resolves.toMatchObject({ refreshed: true });
    const refreshed = await testEnv.DB.prepare(
      "SELECT encrypted_credentials AS encryptedCredentials FROM calendar_connections WHERE id = ?",
    )
      .bind(connectionId)
      .first<{ encryptedCredentials: string }>();
    await expect(
      decryptCalendarCredentials(
        refreshed!.encryptedCredentials,
        credentialKey,
        {
          connectionId,
          organisationId: viewer.organisationId,
          provider: "google",
        },
      ),
    ).resolves.toMatchObject({
      accessToken: "refreshed-access-token",
      refreshToken: "durable-refresh-token",
    });
    expect(refreshCalls).toBe(1);

    await testEnv.DB.prepare(
      "UPDATE calendar_connections SET status = 'needs_attention' WHERE id = ?",
    )
      .bind(connectionId)
      .run();
    await expect(
      service.refreshConnection(viewer, connectionId),
    ).resolves.toMatchObject({ refreshed: true });
    expect(refreshCalls).toBe(2);

    await testEnv.DB.prepare(
      `UPDATE calendar_connections
          SET encrypted_credentials = ?, expires_at = 1
        WHERE id = ?`,
    )
      .bind(expiring, connectionId)
      .run();
    rejectRefresh = true;
    await expect(
      service.refreshConnection(viewer, connectionId),
    ).rejects.toThrow("refresh grant was revoked");
    await expect(
      testEnv.DB.prepare("SELECT status FROM calendar_connections WHERE id = ?")
        .bind(connectionId)
        .first(),
    ).resolves.toEqual({ status: "needs_attention" });
  });

  it("keeps a provider-rotated refresh token when key rewrapping races the refresh", async () => {
    let markRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    let releaseRefresh!: () => void;
    const refreshRelease = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    let refreshCalls = 0;
    const fetcher = async () => {
      refreshCalls += 1;
      markRefreshStarted();
      await refreshRelease;
      return Response.json({
        access_token: "rewrap-race-access-token",
        refresh_token: "rewrap-race-rotated-refresh-token",
        expires_in: 7_200,
        token_type: "Bearer",
      });
    };
    const { testEnv } = await oauthEnvironment(fetcher);
    const oldDeploymentEnvironment = {
      ...testEnv,
      CALENDAR_CREDENTIALS_KEY: rotatedCredentialKey,
      CALENDAR_CREDENTIALS_PREVIOUS_KEY: undefined,
    } as CloudflareEnvironment;
    const service = new CalendarOAuthService(oldDeploymentEnvironment, fetcher);
    const connectionId = crypto.randomUUID();
    const currentCredentials = {
      accessToken: "rewrap-race-old-access-token",
      refreshToken: "rewrap-race-old-refresh-token",
      accessTokenExpiresAt: 1,
      tokenType: "Bearer" as const,
      calendarId: "primary",
    };
    const context = {
      connectionId,
      organisationId: viewer.organisationId,
      provider: "google" as const,
    };
    const previousCiphertext = await encryptCalendarCredentials(
      currentCredentials,
      rotatedCredentialKey,
      context,
    );
    await testEnv.DB.prepare(
      `INSERT INTO calendar_connections (
         id, organisation_id, event_id, person_id, provider, account_reference,
         encrypted_credentials, scopes_json, status, expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'google', ?, ?, '[]', 'connected', 1, unixepoch(), unixepoch())`,
    )
      .bind(
        connectionId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        `rewrap-race-${crypto.randomUUID()}`,
        previousCiphertext,
      )
      .run();

    const refreshing = service.refreshConnection(viewer, connectionId);
    await refreshStarted;
    try {
      const activeCiphertext = await encryptCalendarCredentials(
        currentCredentials,
        credentialKey,
        context,
        await calendarCredentialGeneration(previousCiphertext),
      );
      await expect(
        testEnv.DB.prepare(
          `UPDATE calendar_connections
              SET encrypted_credentials = ?, updated_at = unixepoch()
            WHERE id = ? AND encrypted_credentials = ?`,
        )
          .bind(activeCiphertext, connectionId, previousCiphertext)
          .run(),
      ).resolves.toMatchObject({ meta: { changes: 1 } });
    } finally {
      releaseRefresh();
    }

    await expect(refreshing).resolves.toMatchObject({ refreshed: true });
    expect(refreshCalls).toBe(1);
    const stored = await testEnv.DB.prepare(
      `SELECT encrypted_credentials AS encryptedCredentials, status
         FROM calendar_connections WHERE id = ?`,
    )
      .bind(connectionId)
      .first<{ encryptedCredentials: string; status: string }>();
    expect(stored?.status).toBe("connected");
    await expect(
      decryptCalendarCredentials(
        stored!.encryptedCredentials,
        rotatedCredentialKey,
        context,
      ),
    ).resolves.toMatchObject({
      accessToken: "rewrap-race-access-token",
      refreshToken: "rewrap-race-rotated-refresh-token",
    });
  });

  it("does not let a stale refresh failure overwrite concurrently rotated credentials", async () => {
    let markRefreshStarted!: () => void;
    const refreshStarted = new Promise<void>((resolve) => {
      markRefreshStarted = resolve;
    });
    let releaseRefresh!: () => void;
    const refreshRelease = new Promise<void>((resolve) => {
      releaseRefresh = resolve;
    });
    const { service, testEnv } = await oauthEnvironment(async () => {
      markRefreshStarted();
      await refreshRelease;
      return Response.json(
        { error_description: "The old refresh grant was revoked." },
        { status: 400 },
      );
    });
    const connectionId = crypto.randomUUID();
    const staleCredentials = await encryptCalendarCredentials(
      {
        accessToken: "stale-access-token",
        refreshToken: "stale-refresh-token",
        accessTokenExpiresAt: 1,
        tokenType: "Bearer",
        calendarId: "primary",
      },
      credentialKey,
      {
        connectionId,
        organisationId: viewer.organisationId,
        provider: "google",
      },
    );
    const replacementExpiresAt = Math.floor(Date.now() / 1_000) + 7_200;
    const replacementCredentials = await encryptCalendarCredentials(
      {
        accessToken: "replacement-access-token",
        refreshToken: "replacement-refresh-token",
        accessTokenExpiresAt: replacementExpiresAt,
        tokenType: "Bearer",
        calendarId: "primary",
      },
      credentialKey,
      {
        connectionId,
        organisationId: viewer.organisationId,
        provider: "google",
      },
    );
    await testEnv.DB.prepare(
      `INSERT INTO calendar_connections (
         id, organisation_id, event_id, person_id, provider, account_reference,
         encrypted_credentials, scopes_json, status, expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'google', ?, ?, '[]', 'connected', 1, unixepoch(), unixepoch())`,
    )
      .bind(
        connectionId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        `stale-refresh-${crypto.randomUUID()}`,
        staleCredentials,
      )
      .run();

    const refreshing = service.refreshConnection(viewer, connectionId);
    await refreshStarted;
    await testEnv.DB.prepare(
      `UPDATE calendar_connections
          SET encrypted_credentials = ?, expires_at = ?, status = 'connected'
        WHERE id = ?`,
    )
      .bind(replacementCredentials, replacementExpiresAt, connectionId)
      .run();
    releaseRefresh();

    await expect(refreshing).rejects.toThrow("old refresh grant was revoked");
    await expect(
      testEnv.DB.prepare(
        `SELECT status, encrypted_credentials AS encryptedCredentials,
                expires_at AS expiresAt
           FROM calendar_connections WHERE id = ?`,
      )
        .bind(connectionId)
        .first(),
    ).resolves.toEqual({
      status: "connected",
      encryptedCredentials: replacementCredentials,
      expiresAt: replacementExpiresAt,
    });
  });

  it("rejects unsafe return paths and non-HTTPS production callback origins", async () => {
    const { service, testEnv } = await oauthEnvironment(async () =>
      Response.json({}),
    );
    await expect(
      service.start(viewer, "google", "//attacker.example"),
    ).rejects.toThrow("safe local application path");
    const insecure = {
      ...testEnv,
      BETTER_AUTH_URL: "http://programcue.test",
    } as unknown as CloudflareEnvironment;
    await expect(
      new CalendarOAuthService(insecure).start(viewer, "google"),
    ).rejects.toThrow("must use HTTPS");
  });

  it("rejects OAuth token responses that omit the required Bearer token type", async () => {
    const { service } = await oauthEnvironment(async (input) => {
      if (String(input).includes("/token"))
        return Response.json({
          access_token: "access-without-type",
          refresh_token: "refresh-without-type",
          expires_in: 3_600,
        });
      return Response.json({
        sub: "google-account-without-type",
        email: "owner@example.com",
      });
    });
    const started = await service.start(viewer, "google");
    await expect(
      service.callback(viewer, {
        state: new URL(started.authorizationUrl).searchParams.get("state")!,
        code: "provider-code",
        nonce: started.nonce,
      }),
    ).rejects.toThrow("did not return valid access-token data");
  });
});
