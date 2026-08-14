import { env } from "cloudflare:test";
import { serializeSignedCookie } from "better-call";
import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { requireAuthenticatedPerson } from "~/platform/auth/authorize.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { action, loader } from "./evaluation-guide";
import { action as signOut } from "./sign-out";

function context(environment: CloudflareEnvironment) {
  const routerContext = new RouterContextProvider();
  routerContext.set(cloudflareContext, {
    env: environment,
    ctx: {} as ExecutionContext,
  });
  return routerContext;
}

function productionEnvironment() {
  return {
    ...(env as unknown as CloudflareEnvironment),
    APP_ENV: "production",
    DEMO_MODE: "false",
    EVALUATION_MODE: "true",
    BETTER_AUTH_SECRET:
      "evaluation-route-better-auth-secret-with-thirty-two-characters",
    BETTER_AUTH_URL: "https://app.programcue.com",
    EVALUATION_ACCESS_CODE: "evaluation-access-code-2026",
    EVALUATION_SESSION_SECRET:
      "evaluation-session-secret-with-more-than-thirty-two-characters",
  } as CloudflareEnvironment;
}

function request(
  body: Record<string, string>,
  options: { cookie?: string; ip?: string } = {},
) {
  return new Request("https://app.programcue.com/evaluate", {
    method: "POST",
    headers: {
      origin: "https://app.programcue.com",
      "cf-connecting-ip": options.ip ?? "203.0.113.150",
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: new URLSearchParams(body),
  });
}

function responseCookieHeader(response: Response) {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const values = headers.getSetCookie?.() ?? [headers.get("set-cookie") ?? ""];
  return values
    .filter(Boolean)
    .map((value) => value.split(";", 1)[0])
    .join("; ");
}

async function recordFixtureReset(environment: CloudflareEnvironment) {
  const fixtureGeneration = crypto.randomUUID();
  await environment.DB.prepare(
    `INSERT INTO audit_events (
       id, organisation_id, event_id, actor_id, action,
       entity_type, entity_id, metadata_json, created_at
     ) VALUES (?, 'org-future-events', 'evt-foe-2025', 'test-operator',
               'evaluation.fixture.reset', 'event', 'evt-foe-2025', '{}',
               unixepoch())`,
  )
    .bind(fixtureGeneration)
    .run();
  return fixtureGeneration;
}

function withActivationBatchRace(
  environment: CloudflareEnvironment,
  race: () => Promise<void>,
) {
  let injectRace = true;
  const racingDb = new Proxy(environment.DB, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (injectRace) {
            injectRace = false;
            await race();
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(environment, {
    get(target, property) {
      return property === "DB" ? racingDb : Reflect.get(target, property);
    },
  });
}

describe("production evaluation guide", () => {
  it("is absent outside the exact production evaluation mode", async () => {
    await expect(
      loader({
        request: new Request("http://localhost/evaluate"),
        params: {},
        context: context(env as unknown as CloudflareEnvironment),
      } as never),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("unlocks a fixed persona and authenticates it through normal server authorization", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const environment = productionEnvironment();
    await recordFixtureReset(environment);
    const unlocked = await action({
      request: request({
        _intent: "unlock",
        accessCode: "evaluation-access-code-2026",
      }),
      params: {},
      context: context(environment),
    } as never);
    expect(unlocked).toBeInstanceOf(Response);
    expect((unlocked as Response).status).toBe(303);
    expect((unlocked as Response).headers.get("location")).toBe("/evaluate");
    const unlockedCookies = responseCookieHeader(unlocked as Response);
    const unlockedGuide = await loader({
      request: new Request("https://app.programcue.com/evaluate", {
        headers: { cookie: unlockedCookies },
      }),
      params: {},
      context: context(environment),
    } as never);
    expect(unlockedGuide).toMatchObject({
      unlocked: true,
      eventName: "Future of Events 2027",
    });
    expect(
      unlockedGuide.identities
        .filter((identity) => identity.group === "scenario")
        .map((identity) => identity.key),
    ).toEqual(["sbek_applicant", "sbek_reviewer"]);
    expect(
      unlockedGuide.identities.map((identity) => String(identity.key)),
    ).not.toContain("sbek_second_speaker");

    const selected = await action({
      request: request(
        { _intent: "select_identity", identity: "organizer" },
        { cookie: unlockedCookies },
      ),
      params: {},
      context: context(environment),
    } as never);
    expect(selected).toBeInstanceOf(Response);
    expect((selected as Response).status).toBe(303);
    expect((selected as Response).headers.get("location")).toBe(
      "/admin/command",
    );
    expect((selected as Response).headers.get("x-remix-reload-document")).toBe(
      "true",
    );
    const selectedCookies = responseCookieHeader(selected as Response);
    await expect(
      requireAuthenticatedPerson(
        new Request("https://app.programcue.com/admin/command", {
          headers: { cookie: selectedCookies },
        }),
        environment,
      ),
    ).resolves.toMatchObject({
      personId: "person-demo-admin",
      evaluation: true,
      demo: false,
    });

    const betterAuthToken = `evaluation-dual-session-${crypto.randomUUID()}`;
    await environment.DB.prepare(
      `INSERT INTO auth_sessions (
         id, person_id, token, expires_at, created_at, updated_at
       ) VALUES (?, 'person-demo-owner', ?, unixepoch() + 3600,
                 unixepoch(), unixepoch())`,
    )
      .bind(crypto.randomUUID(), betterAuthToken)
      .run();
    const betterAuthCookie = await serializeSignedCookie(
      "__Secure-better-auth.session_token",
      betterAuthToken,
      String(environment.BETTER_AUTH_SECRET),
    );
    await expect(
      requireAuthenticatedPerson(
        new Request("https://app.programcue.com/admin/command", {
          headers: { cookie: betterAuthCookie },
        }),
        environment,
      ),
    ).resolves.toMatchObject({
      personId: "person-demo-owner",
      evaluation: false,
    });
    await expect(
      requireAuthenticatedPerson(
        new Request("https://app.programcue.com/admin/command", {
          headers: { cookie: `${unlockedCookies}; ${betterAuthCookie}` },
        }),
        environment,
        "response",
      ),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      requireAuthenticatedPerson(
        new Request("https://app.programcue.com/admin/command", {
          headers: { cookie: `${selectedCookies}; ${betterAuthCookie}` },
        }),
        environment,
      ),
    ).resolves.toMatchObject({
      personId: "person-demo-admin",
      evaluation: true,
    });

    const signedOut = await signOut({
      request: new Request("https://app.programcue.com/sign-out", {
        method: "POST",
        headers: {
          origin: "https://app.programcue.com",
          cookie: `${selectedCookies}; ${betterAuthCookie}`,
        },
      }),
      params: {},
      context: context(environment),
    } as never);
    expect(signedOut.status).toBe(303);
    expect(signedOut.headers.get("location")).toBe("/evaluate");
    expect(signedOut.headers.get("set-cookie")).toContain(
      "better-auth.session_token=",
    );
    await expect(
      environment.DB.prepare("SELECT id FROM auth_sessions WHERE token = ?")
        .bind(betterAuthToken)
        .first(),
    ).resolves.toBeNull();
    const rolePickerCookies = responseCookieHeader(signedOut);
    await expect(
      loader({
        request: new Request("https://app.programcue.com/evaluate", {
          headers: { cookie: rolePickerCookies },
        }),
        params: {},
        context: context(environment),
      } as never),
    ).resolves.toMatchObject({ unlocked: true, selected: null });
    const unauthorised = await requireAuthenticatedPerson(
      new Request("https://app.programcue.com/admin/command", {
        headers: { cookie: rolePickerCookies },
      }),
      environment,
    ).catch((error: unknown) => error);
    expect(unauthorised).toBeInstanceOf(Response);
    if (!(unauthorised instanceof Response)) {
      throw new Error("A cleared evaluator persona retained private access.");
    }
    expect(unauthorised.status).toBe(302);
    expect(unauthorised.headers.get("location")).toBe("/evaluate");
  });

  it("explicitly activates and audits the clean evaluator submitter account", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const environment = productionEnvironment();
    await recordFixtureReset(environment);
    const unlocked = await action({
      request: request({
        _intent: "unlock",
        accessCode: "evaluation-access-code-2026",
      }),
      params: {},
      context: context(environment),
    } as never);
    const unlockedCookies = responseCookieHeader(unlocked as Response);
    const before = await environment.DB.prepare(
      `SELECT email_verified AS emailVerified
         FROM people WHERE id = 'person-sbek-speaker'`,
    ).first<{ emailVerified: number }>();

    const activated = await action({
      request: request(
        { _intent: "activate_account", identity: "sbek_applicant" },
        { cookie: unlockedCookies },
      ),
      params: {},
      context: context(environment),
    } as never);
    expect(activated).toBeInstanceOf(Response);
    expect((activated as Response).status).toBe(303);
    expect((activated as Response).headers.get("location")).toBe("/apply/form");
    const selectedCookies = responseCookieHeader(activated as Response);
    await expect(
      requireAuthenticatedPerson(
        new Request("https://app.programcue.com/apply/form", {
          headers: { cookie: selectedCookies },
        }),
        environment,
      ),
    ).resolves.toMatchObject({
      personId: "person-sbek-speaker",
      evaluation: true,
      demo: false,
    });
    await expect(
      environment.DB.prepare(
        `SELECT action, metadata_json AS metadataJson
           FROM audit_events
          WHERE actor_id = 'production-evaluation-access'
            AND entity_id = 'person-sbek-speaker'
            AND action = 'evaluation.account.activated'
          ORDER BY rowid DESC LIMIT 1`,
      ).first<{ action: string; metadataJson: string }>(),
    ).resolves.toMatchObject({
      action: "evaluation.account.activated",
      metadataJson: expect.stringContaining(
        '"fixed_fixture_submitter_membership"',
      ),
    });
    await expect(
      environment.DB.prepare(
        `SELECT organisation_id AS organisationId, event_id AS eventId,
        person_id AS personId, role, accepted_at AS acceptedAt,
                invited_at AS invitedAt, revoked_at AS revokedAt
           FROM memberships
          WHERE id = 'membership-production-evaluation-applicant-event'`,
      ).first<{
        organisationId: string;
        eventId: string;
        personId: string;
        role: string;
        acceptedAt: number;
        invitedAt: number | null;
        revokedAt: number | null;
      }>(),
    ).resolves.toMatchObject({
      organisationId: "org-future-events",
      eventId: "evt-foe-2025",
      personId: "person-sbek-speaker",
      role: "submitter",
      acceptedAt: expect.any(Number),
      invitedAt: null,
      revokedAt: null,
    });
    await expect(
      environment.DB.prepare(
        `SELECT email_verified AS emailVerified
           FROM people WHERE id = 'person-sbek-speaker'`,
      ).first<{ emailVerified: number }>(),
    ).resolves.toEqual(before);
  });

  it("fails fast when the selected clean applicant loses its activated membership", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const environment = productionEnvironment();
    await recordFixtureReset(environment);
    const unlocked = await action({
      request: request({
        _intent: "unlock",
        accessCode: "evaluation-access-code-2026",
      }),
      params: {},
      context: context(environment),
    } as never);
    const activated = await action({
      request: request(
        { _intent: "activate_account", identity: "sbek_applicant" },
        { cookie: responseCookieHeader(unlocked as Response) },
      ),
      params: {},
      context: context(environment),
    } as never);
    await environment.DB.prepare(
      `UPDATE memberships SET revoked_at = unixepoch()
        WHERE id = 'membership-production-evaluation-applicant-event'`,
    ).run();

    const rejected = await loader({
      request: new Request("https://app.programcue.com/evaluate", {
        headers: { cookie: responseCookieHeader(activated as Response) },
      }),
      params: {},
      context: context(environment),
    } as never).catch((error: unknown) => error);

    expect(rejected).toBeInstanceOf(Response);
    expect((rejected as Response).status).toBe(503);
    expect((rejected as Response).headers.get("cache-control")).toBe(
      "no-store",
    );
  });

  it("explicitly activates the clean applicant and clears canonical event context before event selection", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const environment = productionEnvironment();
    await recordFixtureReset(environment);
    const unlocked = await action({
      request: request({
        _intent: "unlock",
        accessCode: "evaluation-access-code-2026",
      }),
      params: {},
      context: context(environment),
    } as never);
    const unlockedCookies = responseCookieHeader(unlocked as Response);
    const selected = await action({
      request: request(
        {
          _intent: "activate_account_and_choose_event",
          identity: "sbek_applicant",
        },
        {
          cookie: `${unlockedCookies}; __Host-program_cue_event=evt-foe-2025`,
        },
      ),
      params: {},
      context: context(environment),
    } as never);

    expect(selected).toBeInstanceOf(Response);
    expect((selected as Response).status).toBe(303);
    expect((selected as Response).headers.get("location")).toBe(
      "/events/select",
    );
    expect((selected as Response).headers.get("set-cookie")).toContain(
      "__Host-program_cue_event=; Max-Age=0",
    );
    await expect(
      requireAuthenticatedPerson(
        new Request("https://app.programcue.com/events/select", {
          headers: {
            cookie: responseCookieHeader(selected as Response),
          },
        }),
        environment,
      ),
    ).resolves.toMatchObject({
      personId: "person-sbek-speaker",
      evaluation: true,
    });
  });

  it("replays the exact evaluator account activation without another write or audit", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const environment = productionEnvironment();
    const fixtureGeneration = await recordFixtureReset(environment);
    const unlocked = await action({
      request: request({
        _intent: "unlock",
        accessCode: "evaluation-access-code-2026",
      }),
      params: {},
      context: context(environment),
    } as never);
    const unlockedCookies = responseCookieHeader(unlocked as Response);
    const activationRequest = () =>
      action({
        request: request(
          { _intent: "activate_account", identity: "sbek_applicant" },
          { cookie: unlockedCookies },
        ),
        params: {},
        context: context(environment),
      } as never);

    await expect(activationRequest()).resolves.toBeInstanceOf(Response);
    const evaluationAuditCount = await environment.DB.prepare(
      `SELECT COUNT(*) AS count FROM audit_events
        WHERE actor_id = 'production-evaluation-access'
          AND entity_id = 'person-sbek-speaker'`,
    ).first<{ count: number }>();
    await environment.DB.prepare(
      `UPDATE memberships SET accepted_at = 123456789
        WHERE id = 'membership-production-evaluation-applicant-event'`,
    ).run();
    await expect(activationRequest()).resolves.toBeInstanceOf(Response);

    await expect(
      environment.DB.prepare(
        `SELECT membership.accepted_at AS acceptedAt,
                membership.last_operation_id AS lastOperationId,
                (SELECT COUNT(*) FROM audit_events audit
                  WHERE audit.action = 'evaluation.account.activated'
                    AND audit.correlation_id = ?) AS activationAuditCount
           FROM memberships membership
          WHERE membership.id = 'membership-production-evaluation-applicant-event'`,
      )
        .bind(`evaluation-account:${fixtureGeneration}`)
        .first(),
    ).resolves.toEqual({
      acceptedAt: 123456789,
      lastOperationId: `evaluation-account:${fixtureGeneration}`,
      activationAuditCount: 1,
    });
    await expect(
      environment.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
          WHERE actor_id = 'production-evaluation-access'
            AND entity_id = 'person-sbek-speaker'`,
      ).first<{ count: number }>(),
    ).resolves.toEqual(evaluationAuditCount);
  });

  it("rejects a fixture generation that changes at the activation batch boundary", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const environment = productionEnvironment();
    const staleGeneration = await recordFixtureReset(environment);
    const unlocked = await action({
      request: request({
        _intent: "unlock",
        accessCode: "evaluation-access-code-2026",
      }),
      params: {},
      context: context(environment),
    } as never);
    const racingEnvironment = withActivationBatchRace(environment, async () => {
      await recordFixtureReset(environment);
    });

    await expect(
      action({
        request: request(
          { _intent: "activate_account", identity: "sbek_applicant" },
          { cookie: responseCookieHeader(unlocked as Response) },
        ),
        params: {},
        context: context(racingEnvironment),
      } as never),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      environment.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM memberships
             WHERE id = 'membership-production-evaluation-applicant-event'
               AND last_operation_id = ?) AS membershipCount,
           (SELECT COUNT(*) FROM audit_events
             WHERE action = 'evaluation.account.activated'
               AND correlation_id = ?) AS activationAuditCount`,
      )
        .bind(
          `evaluation-account:${staleGeneration}`,
          `evaluation-account:${staleGeneration}`,
        )
        .first(),
    ).resolves.toEqual({ membershipCount: 0, activationAuditCount: 0 });
  });

  it("rejects account activation for every non-applicant fixture persona", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const environment = productionEnvironment();
    await recordFixtureReset(environment);
    const unlocked = await action({
      request: request({
        _intent: "unlock",
        accessCode: "evaluation-access-code-2026",
      }),
      params: {},
      context: context(environment),
    } as never);
    const result = await action({
      request: request(
        { _intent: "activate_account", identity: "organizer" },
        { cookie: responseCookieHeader(unlocked as Response) },
      ),
      params: {},
      context: context(environment),
    } as never);
    if (result instanceof Response) {
      throw new Error("Invalid activation returned a raw response.");
    }
    expect(result.init?.status).toBe(400);
  });

  it("rejects generic identity selection for the activation-only applicant", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const environment = productionEnvironment();
    await recordFixtureReset(environment);
    const unlocked = await action({
      request: request({
        _intent: "unlock",
        accessCode: "evaluation-access-code-2026",
      }),
      params: {},
      context: context(environment),
    } as never);
    const activationAuditsBefore = await environment.DB.prepare(
      `SELECT COUNT(*) AS count FROM audit_events
        WHERE action = 'evaluation.account.activated'
          AND entity_id = 'person-sbek-speaker'`,
    ).first<{ count: number }>();
    const result = await action({
      request: request(
        { _intent: "select_identity", identity: "sbek_applicant" },
        { cookie: responseCookieHeader(unlocked as Response) },
      ),
      params: {},
      context: context(environment),
    } as never);
    if (result instanceof Response) {
      throw new Error("Invalid applicant selection returned a raw response.");
    }
    expect(result.init?.status).toBe(400);
    await expect(
      environment.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
          WHERE action = 'evaluation.account.activated'
            AND entity_id = 'person-sbek-speaker'`,
      ).first<{ count: number }>(),
    ).resolves.toEqual(activationAuditsBefore);
  });

  it("rate-limits repeated access-code attempts", async () => {
    const environment = productionEnvironment();
    const ip = "203.0.113.151";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await action({
        request: request(
          { _intent: "unlock", accessCode: `wrong-code-${attempt}` },
          { ip },
        ),
        params: {},
        context: context(environment),
      } as never);
      if (result instanceof Response) {
        throw new Error("Invalid evaluation code returned a raw response.");
      }
      expect(result.init?.status).toBe(401);
    }
    const limited = await action({
      request: request(
        { _intent: "unlock", accessCode: "one-attempt-too-many" },
        { ip },
      ),
      params: {},
      context: context(environment),
    } as never);
    if (limited instanceof Response) {
      throw new Error(
        "Rate-limited evaluation access returned a raw response.",
      );
    }
    expect(limited.init?.status).toBe(429);
    expect(new Headers(limited.init?.headers).get("retry-after")).toBeTruthy();
  });
});
