import { env } from "cloudflare:test";
import { serializeSignedCookie } from "better-call";
import { RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { requireAuthenticatedPerson } from "~/platform/auth/authorize.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { resetProductionEvaluationFixture } from "~/platform/evaluation/evaluation-fixture.server";
import {
  acquireEvaluationFixtureReset,
  beginEvaluationFixtureResetDestructiveWork,
  completeEvaluationFixtureReset,
  EVALUATION_FIXTURE_RESET_OPERATION_ID,
} from "~/platform/evaluation/evaluation-fixture-reset-lock.server";
import { requireEvaluationGuideCount } from "~/platform/evaluation/evaluation-guide-state.server";
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
    EVALUATION_ACCESS_CODE: "0123456789abcdef0123456789abcdef",
    EVALUATION_SESSION_SECRET:
      "evaluation-session-secret-with-more-than-thirty-two-characters",
    AUTH_EMAIL_FROM: "Program Cue <auth@programcue.com>",
    EMAIL_PROVIDER: "resend",
    RESEND_API_KEY: "test-resend-key",
    AI: {} as Ai,
  } as CloudflareEnvironment;
}

async function provisionEvaluationFixture(environment: CloudflareEnvironment) {
  await resetProductionEvaluationFixture(
    {
      ...environment,
      EVALUATOR_ORGANIZER_EMAIL: "eval-organizer@programcue.com",
      EVALUATOR_SPEAKER_EMAIL: "eval-speaker@programcue.com",
      EVALUATOR_SECOND_SPEAKER_EMAIL: "eval-speaker-2@programcue.com",
      EVALUATOR_REVIEWER_EMAIL: "eval-reviewer@programcue.com",
      EVALUATOR_SHOWCASE_SUBMITTER_EMAIL:
        "eval-showcase-submitter@programcue.com",
      EVALUATOR_SHOWCASE_SPEAKER_EMAIL: "eval-showcase-speaker@programcue.com",
    } as CloudflareEnvironment,
    "Future of Events 2027",
    {
      list: async () => [
        {
          id: "resend-domain-programcue",
          name: "programcue.com",
          status: "verified",
        },
      ],
    },
  );
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
  const resetLock = await environment.DB.prepare(
    "SELECT id FROM operation_jobs WHERE id = ?",
  )
    .bind(EVALUATION_FIXTURE_RESET_OPERATION_ID)
    .first();
  if (resetLock) {
    const ownerToken = crypto.randomUUID();
    await acquireEvaluationFixtureReset(environment, ownerToken);
    await beginEvaluationFixtureResetDestructiveWork(environment, ownerToken);
    await completeEvaluationFixtureReset(
      environment,
      ownerToken,
      fixtureGeneration,
      { testFixtureGeneration: true },
      "test-operator",
    );
    return fixtureGeneration;
  }
  await environment.DB.prepare(
    `INSERT INTO audit_events (
       id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_id, action,
       entity_type, entity_id, metadata_json, created_at
     ) VALUES (?, 'system', 'internal', 1, 'org-future-events', 'evt-foe-2025', 'test-operator',
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

function withUnavailableRateLimitDatabase(environment: CloudflareEnvironment) {
  const unavailableDatabase = new Proxy(environment.DB, {
    get(target, property) {
      if (property === "batch") {
        return async () => {
          throw new Error("simulated rate-limit storage failure");
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(environment, {
    get(target, property) {
      return property === "DB"
        ? unavailableDatabase
        : Reflect.get(target, property);
    },
  });
}

describe("production evaluation guide", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fails instead of treating invalid guide counters as a clean baseline", () => {
    for (const value of [undefined, null, Number.NaN, -1, 1.5, "0"]) {
      expect(() =>
        requireEvaluationGuideCount(value, "applicant membership"),
      ).toThrow(
        "The evaluation guide received an invalid applicant membership count.",
      );
    }
    expect(requireEvaluationGuideCount(0, "applicant membership")).toBe(0);
  });

  it("is absent outside the exact production evaluation mode", async () => {
    await expect(
      loader({
        request: new Request("http://localhost/evaluate"),
        params: {},
        context: context(env as unknown as CloudflareEnvironment),
      } as never),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("loads the locked access gate without an authenticated session", async () => {
    await expect(
      loader({
        request: new Request("https://app.programcue.com/evaluate"),
        params: {},
        context: context(productionEnvironment()),
      } as never),
    ).resolves.toMatchObject({
      unlocked: false,
      selected: null,
      eventName: "Future of Events 2027",
    });
  });

  it("unlocks a fixed persona and authenticates it through normal server authorization", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const environment = productionEnvironment();
    await recordFixtureReset(environment);
    const unlocked = await action({
      request: request({
        _intent: "unlock",
        accessCode: "0123456789abcdef0123456789abcdef",
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
    expect(
      unlockedGuide.identities.find((identity) => identity.key === "organizer"),
    ).toMatchObject({
      whatToTry: expect.stringContaining(
        "enable reviewer AI in Review & selection",
      ),
    });
    const showcaseReviewer = unlockedGuide.identities.find(
      (identity) => identity.key === "reviewer",
    );
    expect(showcaseReviewer).toMatchObject({
      description: expect.stringContaining(
        "Reset baseline: a reviewer queue with completed scoring",
      ),
      whatToTry: expect.stringContaining(
        "If this baseline no longer matches the workspace, the shared fixture has progressed",
      ),
    });
    expect(showcaseReviewer?.whatToTry).toContain(
      "then switch to Clean reviewer",
    );

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

  it("does not make a valid access code depend on rate-limit storage", async () => {
    const environment = productionEnvironment();
    const unavailableEnvironment =
      withUnavailableRateLimitDatabase(environment);

    const unlocked = await action({
      request: request({
        _intent: "unlock",
        accessCode: "0123456789abcdef0123456789abcdef",
      }),
      params: {},
      context: context(unavailableEnvironment),
    } as never);

    expect(unlocked).toBeInstanceOf(Response);
    expect((unlocked as Response).status).toBe(303);
    expect((unlocked as Response).headers.get("location")).toBe("/evaluate");
    expect(responseCookieHeader(unlocked as Response)).toContain(
      "__Host-program_cue_evaluation=",
    );
  });

  it("still fails closed when an invalid code cannot be rate-limited", async () => {
    const environment = productionEnvironment();
    const unavailableEnvironment =
      withUnavailableRateLimitDatabase(environment);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await action({
      request: request({
        _intent: "unlock",
        accessCode: "wrong-evaluation-access-code",
      }),
      params: {},
      context: context(unavailableEnvironment),
    } as never);

    if (result instanceof Response) {
      throw new Error(
        "Unavailable rate-limit storage returned a raw response.",
      );
    }
    expect(result.init?.status).toBe(503);
    const headers = new Headers(result.init?.headers);
    expect(headers.get("cache-control")).toBe("no-store");
    expect(headers.has("set-cookie")).toBe(false);
    expect(result.data).toEqual({
      ok: false,
      message: "Evaluation access is temporarily unavailable. Try again.",
    });
    expect(errorLog).toHaveBeenCalledWith(
      expect.stringContaining('"event":"rate-limit-storage-failed"'),
    );
  });

  it("locks evaluation so the same browser can continue with its Better Auth identity", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const environment = productionEnvironment();
    await recordFixtureReset(environment);
    const unlocked = await action({
      request: request({
        _intent: "unlock",
        accessCode: "0123456789abcdef0123456789abcdef",
      }),
      params: {},
      context: context(environment),
    } as never);
    const betterAuthToken = `evaluation-lock-handoff-${crypto.randomUUID()}`;
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

    const locked = await action({
      request: request(
        { _intent: "lock" },
        {
          cookie: `${responseCookieHeader(unlocked as Response)}; ${betterAuthCookie}`,
        },
      ),
      params: {},
      context: context(environment),
    } as never);

    expect(locked).toBeInstanceOf(Response);
    expect((locked as Response).status).toBe(303);
    expect((locked as Response).headers.get("location")).toBe("/evaluate");
    const setCookies = (
      (locked as Response).headers as Headers & { getSetCookie(): string[] }
    ).getSetCookie();
    expect(setCookies).toEqual(
      expect.arrayContaining([
        expect.stringContaining("__Host-program_cue_evaluation="),
        expect.stringContaining("__Host-program_cue_event="),
      ]),
    );
    expect(setCookies.join("\n")).not.toContain("better-auth.session_token=");
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
      environment.DB.prepare("SELECT id FROM auth_sessions WHERE token = ?")
        .bind(betterAuthToken)
        .first(),
    ).resolves.toBeTruthy();
  });

  it("returns an actionable response when persona selection has a transient dependency failure", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const environment = productionEnvironment();
    await recordFixtureReset(environment);
    const unlocked = await action({
      request: request({
        _intent: "unlock",
        accessCode: "0123456789abcdef0123456789abcdef",
      }),
      params: {},
      context: context(environment),
    } as never);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const failingDatabase = new Proxy(environment.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (query: string) => {
            if (
              query.includes("INSERT INTO audit_events") &&
              query.includes("production-evaluation-access")
            ) {
              throw new Error("simulated transient D1 failure");
            }
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const failingEnvironment = new Proxy(environment, {
      get(target, property) {
        return property === "DB"
          ? failingDatabase
          : Reflect.get(target, property);
      },
    });

    const result = await action({
      request: request(
        { _intent: "select_identity", identity: "applicant" },
        { cookie: responseCookieHeader(unlocked as Response) },
      ),
      params: {},
      context: context(failingEnvironment),
    } as never);

    expect(result).not.toBeInstanceOf(Response);
    if (result instanceof Response) {
      throw new Error("Transient selection failure returned a redirect.");
    }
    expect(result.init?.status).toBe(503);
    expect(result.data).toEqual({
      ok: false,
      message: "Evaluation access is temporarily unavailable. Try again.",
    });
    expect(errorLog).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(errorLog.mock.calls[0]?.[0]))).toMatchObject({
      level: "error",
      subsystem: "evaluation-access",
      event: "identity-selection-failed",
      stage: "record-audit",
      errorName: "Error",
      message: "An evaluation access dependency failed.",
    });
  });

  it("resets provisioned evaluation data without reset-only secrets and returns to the unlocked role picker", async () => {
    const environment = productionEnvironment();
    await provisionEvaluationFixture(environment);
    expect([
      environment.EVALUATION_FIXTURE_SECRET,
      environment.EVALUATION_RESEND_API_KEY,
      environment.EVALUATOR_ORGANIZER_EMAIL,
      environment.EVALUATOR_SPEAKER_EMAIL,
      environment.EVALUATOR_SECOND_SPEAKER_EMAIL,
      environment.EVALUATOR_REVIEWER_EMAIL,
      environment.EVALUATOR_SHOWCASE_SUBMITTER_EMAIL,
      environment.EVALUATOR_SHOWCASE_SPEAKER_EMAIL,
    ]).toEqual([
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    const unlocked = await action({
      request: request({
        _intent: "unlock",
        accessCode: "0123456789abcdef0123456789abcdef",
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
    const oldCookies = responseCookieHeader(activated as Response);

    const result = await action({
      request: request(
        {
          _intent: "reset_fixture",
          confirmation: "Future of Events 2027",
        },
        { cookie: oldCookies },
      ),
      params: {},
      context: context(environment),
    } as never);
    if (result instanceof Response) {
      throw new Error("Evaluator reset unexpectedly returned a redirect.");
    }
    expect(result.data).toEqual({
      ok: true,
      message: "Evaluation data reset. Choose a fresh starting persona.",
    });
    const newCookies = responseCookieHeader(
      new Response(null, result.init ?? undefined),
    );
    await expect(
      loader({
        request: new Request("https://app.programcue.com/evaluate", {
          headers: { cookie: oldCookies },
        }),
        params: {},
        context: context(environment),
      } as never),
    ).resolves.toMatchObject({ unlocked: false, selected: null });
    await expect(
      loader({
        request: new Request("https://app.programcue.com/evaluate", {
          headers: { cookie: newCookies },
        }),
        params: {},
        context: context(environment),
      } as never),
    ).resolves.toMatchObject({ unlocked: true, selected: null });
    await expect(
      environment.DB.prepare(
        `SELECT id FROM memberships
          WHERE id = 'membership-production-evaluation-applicant-event'`,
      ).first(),
    ).resolves.toBeNull();
    const audit = await environment.DB.prepare(
      `SELECT actor_id AS actorId, metadata_json AS metadataJson
         FROM audit_events
        WHERE action = 'evaluation.fixture.reset'
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    ).first<{ actorId: string; metadataJson: string }>();
    expect(audit?.actorId).toBe("production-evaluation-access");
    expect(JSON.parse(audit?.metadataJson ?? "{}")).toMatchObject({
      authority: "evaluator",
      identityKey: "sbek_applicant",
      senderVerification: "persisted_sender_profile",
      status: "completed",
    });
  });

  it("requires the exact event name before an evaluator reset", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const environment = productionEnvironment();
    await recordFixtureReset(environment);
    const unlocked = await action({
      request: request({
        _intent: "unlock",
        accessCode: "0123456789abcdef0123456789abcdef",
      }),
      params: {},
      context: context(environment),
    } as never);
    const result = await action({
      request: request(
        { _intent: "reset_fixture", confirmation: "Future of Events" },
        { cookie: responseCookieHeader(unlocked as Response) },
      ),
      params: {},
      context: context(environment),
    } as never);
    if (result instanceof Response) {
      throw new Error("Invalid reset confirmation returned a redirect.");
    }
    expect(result.init?.status).toBe(409);
    expect(result.data).toEqual({
      ok: false,
      message: "Type Future of Events 2027 exactly to reset the fixture.",
    });
  });

  it("explicitly activates and audits the clean evaluator submitter account", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const environment = productionEnvironment();
    await recordFixtureReset(environment);
    const unlocked = await action({
      request: request({
        _intent: "unlock",
        accessCode: "0123456789abcdef0123456789abcdef",
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
        accessCode: "0123456789abcdef0123456789abcdef",
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
        accessCode: "0123456789abcdef0123456789abcdef",
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

  it("advances Priya from clean through activation, draft and submission", async () => {
    const environment = productionEnvironment();
    await provisionEvaluationFixture(environment);
    const unlocked = await action({
      request: request(
        {
          _intent: "unlock",
          accessCode: "0123456789abcdef0123456789abcdef",
        },
        { ip: "203.0.113.181" },
      ),
      params: {},
      context: context(environment),
    } as never);
    const cookie = responseCookieHeader(unlocked as Response);
    const readApplicant = async () => {
      const guide = await loader({
        request: new Request("https://app.programcue.com/evaluate", {
          headers: { cookie },
        }),
        params: {},
        context: context(environment),
      } as never);
      return guide.identities.find(
        (identity) => identity.key === "sbek_applicant",
      );
    };

    await expect(readApplicant()).resolves.toMatchObject({
      label: "Clean applicant",
      destination: "/apply/form",
      primaryActionLabel: "Create evaluator submitter account",
      progress: { clean: true, title: "Clean applicant baseline" },
    });

    await action({
      request: request(
        { _intent: "activate_account", identity: "sbek_applicant" },
        { cookie },
      ),
      params: {},
      context: context(environment),
    } as never);
    await expect(readApplicant()).resolves.toMatchObject({
      label: "Activated applicant",
      destination: "/apply/form",
      primaryActionLabel: "Start an application as Priya",
      progress: { clean: false, title: "Applicant account activated" },
    });

    await environment.DB.prepare(
      `INSERT INTO submissions (
         id, event_id, submitter_person_id, submitter_email,
         public_reference, title, status, answers_json, revision,
         created_at, updated_at
       ) VALUES (
         'evaluation-guide-priya-application', 'evt-foe-2025',
         'person-sbek-speaker', 'eval-speaker@programcue.com',
         'GUIDE-PRIYA', 'State-aware guide proposal', 'draft', '{}', 1,
         unixepoch(), unixepoch()
       )`,
    ).run();
    await expect(readApplicant()).resolves.toMatchObject({
      label: "Applicant with draft",
      destination: "/participant/applications",
      primaryActionLabel: "Continue Priya's application",
      progress: { clean: false, title: "Application draft in progress" },
    });

    await environment.DB.prepare(
      `UPDATE submissions
          SET status = 'submitted', submitted_snapshot_json = '{}',
              submitted_at = unixepoch(), updated_at = unixepoch()
        WHERE id = 'evaluation-guide-priya-application'`,
    ).run();
    await expect(readApplicant()).resolves.toMatchObject({
      label: "Submitted applicant",
      destination: "/participant/applications",
      primaryActionLabel: "Open Priya's applications",
      progress: { clean: false, title: "Application submitted" },
    });

    const selected = await action({
      request: request(
        { _intent: "activate_account", identity: "sbek_applicant" },
        { cookie },
      ),
      params: {},
      context: context(environment),
    } as never);
    expect(selected).toBeInstanceOf(Response);
    expect((selected as Response).headers.get("location")).toBe(
      "/participant/applications",
    );
  });

  it("advances Sam through invitation, acceptance, assignment and review", async () => {
    const environment = productionEnvironment();
    await provisionEvaluationFixture(environment);
    const unlocked = await action({
      request: request(
        {
          _intent: "unlock",
          accessCode: "0123456789abcdef0123456789abcdef",
        },
        { ip: "203.0.113.182" },
      ),
      params: {},
      context: context(environment),
    } as never);
    const cookie = responseCookieHeader(unlocked as Response);
    const readReviewer = async () => {
      const guide = await loader({
        request: new Request("https://app.programcue.com/evaluate", {
          headers: { cookie },
        }),
        params: {},
        context: context(environment),
      } as never);
      return guide.identities.find(
        (identity) => identity.key === "sbek_reviewer",
      );
    };

    await expect(readReviewer()).resolves.toMatchObject({
      label: "Clean reviewer",
      destination: "/events/select",
      primaryActionLabel: "Open as clean reviewer",
      progress: { clean: true, title: "Clean reviewer baseline" },
    });

    await environment.DB.prepare(
      `INSERT INTO memberships (
         id, organisation_id, event_id, person_id, role,
         invited_at, invitation_expires_at, accepted_at, revoked_at, created_at
       ) VALUES (
         'evaluation-guide-sam-membership', 'org-future-events',
         'evt-foe-2025', 'person-sbek-reviewer', 'evaluator',
         unixepoch(), unixepoch() + 604800, NULL, NULL, unixepoch()
       )`,
    ).run();
    await expect(readReviewer()).resolves.toMatchObject({
      label: "Invited reviewer",
      destination: "/events/select",
      primaryActionLabel: "Review invitation as Sam",
      progress: { clean: false, title: "Reviewer invitation pending" },
    });

    await environment.DB.prepare(
      `UPDATE memberships SET invitation_expires_at = unixepoch() - 1
        WHERE id = 'evaluation-guide-sam-membership'`,
    ).run();
    await expect(readReviewer()).resolves.toMatchObject({
      label: "Reviewer invitation expired",
      destination: "/events/select",
      primaryActionLabel: "Open Sam's event access",
      progress: { clean: false, title: "Reviewer invitation expired" },
    });

    await environment.DB.prepare(
      `UPDATE memberships
          SET invitation_expires_at = NULL, accepted_at = unixepoch()
        WHERE id = 'evaluation-guide-sam-membership'`,
    ).run();
    await expect(readReviewer()).resolves.toMatchObject({
      label: "Reviewer with event access",
      destination: "/review/workbench",
      primaryActionLabel: "Open Sam's reviewer workspace",
      progress: { clean: false, title: "Reviewer access accepted" },
    });

    await environment.DB.prepare(
      `INSERT INTO evaluator_assignments (
         id, event_id, round_id, submission_id, evaluator_person_id,
         status, revision, assigned_at
       ) VALUES (
         'evaluation-guide-sam-assignment', 'evt-foe-2025',
         'demo-evaluation-round', 'demo-evaluation-submission-calm',
         'person-sbek-reviewer', 'assigned', 1, unixepoch()
       )`,
    ).run();
    await expect(readReviewer()).resolves.toMatchObject({
      label: "Assigned reviewer",
      destination: "/review/workbench",
      whatToTry: expect.stringContaining("save an independent rubric response"),
      primaryActionLabel: "Open Sam's assigned review",
      progress: { clean: false, title: "Review assigned" },
    });

    await environment.DB.batch([
      environment.DB.prepare(
        `UPDATE evaluator_assignments SET status = 'in_progress'
          WHERE id = 'evaluation-guide-sam-assignment'`,
      ),
      environment.DB.prepare(
        `INSERT INTO reviews (
           id, event_id, assignment_id, status, scores_json,
           revision, created_at, updated_at
         ) VALUES (
           'evaluation-guide-sam-review', 'evt-foe-2025',
           'evaluation-guide-sam-assignment', 'draft', '{}', 1,
           unixepoch(), unixepoch()
         )`,
      ),
    ]);
    await expect(readReviewer()).resolves.toMatchObject({
      label: "Reviewer with draft review",
      destination: "/review/workbench",
      whatToTry: expect.stringContaining("Generate or inspect AI suggestions"),
      primaryActionLabel: "Continue Sam's review",
      progress: { clean: false, title: "Review draft in progress" },
    });

    await environment.DB.prepare(
      `UPDATE evaluator_assignments SET status = 'recused'
        WHERE id = 'evaluation-guide-sam-assignment'`,
    ).run();
    await expect(readReviewer()).resolves.toMatchObject({
      label: "Reviewer with event access",
      destination: "/review/workbench",
      primaryActionLabel: "Open Sam's reviewer workspace",
      progress: { clean: false, title: "Reviewer access accepted" },
    });

    await environment.DB.batch([
      environment.DB.prepare(
        `UPDATE evaluator_assignments
            SET status = 'submitted', submitted_at = unixepoch()
          WHERE id = 'evaluation-guide-sam-assignment'`,
      ),
      environment.DB.prepare(
        `UPDATE reviews SET status = 'submitted', submitted_at = unixepoch(),
                            updated_at = unixepoch()
          WHERE id = 'evaluation-guide-sam-review'`,
      ),
    ]);
    await expect(readReviewer()).resolves.toMatchObject({
      label: "Reviewer with submitted review",
      destination: "/review/workbench",
      primaryActionLabel: "Inspect Sam's submitted review",
      progress: { clean: false, title: "Review submitted" },
    });

    const selected = await action({
      request: request(
        { _intent: "select_identity", identity: "sbek_reviewer" },
        { cookie },
      ),
      params: {},
      context: context(environment),
    } as never);
    expect(selected).toBeInstanceOf(Response);
    expect((selected as Response).headers.get("location")).toBe(
      "/review/workbench",
    );
  });

  it("replays the exact evaluator account activation without another write or audit", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const environment = productionEnvironment();
    const fixtureGeneration = await recordFixtureReset(environment);
    const unlocked = await action({
      request: request({
        _intent: "unlock",
        accessCode: "0123456789abcdef0123456789abcdef",
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
        accessCode: "0123456789abcdef0123456789abcdef",
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
        accessCode: "0123456789abcdef0123456789abcdef",
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
        accessCode: "0123456789abcdef0123456789abcdef",
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

  it("rate-limits invalid access codes without blocking a valid code", async () => {
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
    expect(limited.data).toMatchObject({
      ok: false,
      retryAfterSeconds: expect.any(Number),
    });

    const unlocked = await action({
      request: request(
        {
          _intent: "unlock",
          accessCode: "0123456789abcdef0123456789abcdef",
        },
        { ip },
      ),
      params: {},
      context: context(environment),
    } as never);
    expect(unlocked).toBeInstanceOf(Response);
    expect((unlocked as Response).status).toBe(303);
    expect(responseCookieHeader(unlocked as Response)).toContain(
      "__Host-program_cue_evaluation=",
    );
  });
});
