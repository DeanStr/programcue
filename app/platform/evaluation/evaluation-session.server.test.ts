import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { ensureDemoData } from "~/platform/demo/seed.server";

import {
  EVALUATION_SESSION_COOKIE,
  activateEvaluationApplicantAccount,
  evaluationAccessCodeMatches,
  evaluationPersonForSession,
  evaluationSessionCookie,
  readEvaluationSession,
  renewedEvaluationSessionCookie,
  requireEvaluationMode,
  resolveEvaluationPerson,
  selectedEvaluationPerson,
} from "./evaluation-session.server";

function environment() {
  return {
    ...(env as unknown as CloudflareEnvironment),
    APP_ENV: "production",
    DEMO_MODE: "false",
    EVALUATION_MODE: "true",
    EVALUATION_ACCESS_CODE: "evaluation-access-code-2026",
    EVALUATION_SESSION_SECRET:
      "evaluation-session-secret-with-more-than-thirty-two-characters",
  } as CloudflareEnvironment;
}

async function recordFixtureReset(
  testEnv: CloudflareEnvironment,
  fixtureGeneration: string = crypto.randomUUID(),
  status: "started" | "completed" = "completed",
) {
  await ensureDemoData(env as unknown as CloudflareEnvironment);
  await testEnv.DB.prepare(
    `INSERT INTO audit_events (
       id, organisation_id, event_id, actor_id, action,
       entity_type, entity_id, metadata_json, created_at
     ) VALUES (?, 'org-future-events', 'evt-foe-2025', 'test-operator',
               ?, 'event', 'evt-foe-2025', ?,
               unixepoch())`,
  )
    .bind(
      fixtureGeneration,
      status === "completed"
        ? "evaluation.fixture.reset"
        : "evaluation.fixture.reset.started",
      JSON.stringify({ status }),
    )
    .run();
  return fixtureGeneration;
}

function cookieHeader(setCookie: string) {
  return setCookie.split(";", 1)[0]!;
}

describe.sequential("production evaluation sessions", () => {
  it("fails fast when access is attempted before the fixture has a reset generation", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    await expect(
      evaluationSessionCookie(environment(), "organizer", 1_000),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("accepts the configured code without exposing it in the session cookie", async () => {
    const testEnv = environment();
    await recordFixtureReset(testEnv);
    await expect(
      evaluationAccessCodeMatches(testEnv, "evaluation-access-code-2026"),
    ).resolves.toBe(true);
    await expect(
      evaluationAccessCodeMatches(testEnv, "incorrect-access-code"),
    ).resolves.toBe(false);
    const cookie = await evaluationSessionCookie(testEnv, "organizer", 1_000);
    expect(cookie).not.toContain("evaluation-access-code-2026");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
  });

  it("verifies, expires and rejects tampered fixed-identity sessions", async () => {
    const testEnv = environment();
    await recordFixtureReset(testEnv);
    const cookie = cookieHeader(
      await evaluationSessionCookie(testEnv, "reviewer", 1_000),
    );
    const request = new Request("https://app.programcue.com/evaluate", {
      headers: { cookie },
    });
    await expect(
      readEvaluationSession(request, testEnv, 1_001),
    ).resolves.toMatchObject({ identityKey: "reviewer", version: 1 });
    await expect(
      readEvaluationSession(request, testEnv, 40_000),
    ).resolves.toBeNull();
    const tampered = new Request("https://app.programcue.com/evaluate", {
      headers: { cookie: `${cookie}x` },
    });
    await expect(
      readEvaluationSession(tampered, testEnv, 1_001),
    ).resolves.toBeNull();
    await expect(
      readEvaluationSession(
        new Request("https://app.programcue.com/evaluate", {
          headers: {
            cookie: `__Host-program_cue_evaluation=${"a".repeat(1_025)}`,
          },
        }),
        testEnv,
        1_001,
      ),
    ).resolves.toBeNull();
  });

  it("invalidates every existing evaluator session when the fixture is reset", async () => {
    const testEnv = environment();
    await recordFixtureReset(testEnv, "fixture-generation-one");
    const cookie = cookieHeader(
      await evaluationSessionCookie(testEnv, "organizer", 1_000),
    );
    const request = new Request("https://app.programcue.com/evaluate", {
      headers: { cookie },
    });
    await expect(
      readEvaluationSession(request, testEnv, 1_001),
    ).resolves.toMatchObject({
      identityKey: "organizer",
      fixtureGeneration: "fixture-generation-one",
    });

    await recordFixtureReset(testEnv, "fixture-generation-two");

    await expect(
      readEvaluationSession(request, testEnv, 1_001),
    ).resolves.toBeNull();
  });

  it("keeps the already-validated fixture generation when a session is renewed across a reset race", async () => {
    const testEnv = environment();
    await recordFixtureReset(testEnv, "fixture-generation-before-renewal");
    const unlockedCookie = cookieHeader(
      await evaluationSessionCookie(testEnv, null, 1_000),
    );
    const unlockedRequest = new Request("https://app.programcue.com/evaluate", {
      headers: { cookie: unlockedCookie },
    });
    const unlockedSession = await readEvaluationSession(
      unlockedRequest,
      testEnv,
      1_001,
    );
    expect(unlockedSession).toMatchObject({
      fixtureGeneration: "fixture-generation-before-renewal",
      identityKey: null,
    });

    await recordFixtureReset(testEnv, "fixture-generation-after-renewal");
    const renewedCookie = cookieHeader(
      await renewedEvaluationSessionCookie(
        testEnv,
        unlockedSession!,
        "organizer",
        1_002,
      ),
    );

    await expect(
      readEvaluationSession(
        new Request("https://app.programcue.com/evaluate", {
          headers: { cookie: renewedCookie },
        }),
        testEnv,
        1_003,
      ),
    ).resolves.toBeNull();
    const freshCookie = cookieHeader(
      await evaluationSessionCookie(testEnv, "organizer", 1_002),
    );
    await expect(
      readEvaluationSession(
        new Request("https://app.programcue.com/evaluate", {
          headers: { cookie: freshCookie },
        }),
        testEnv,
        1_003,
      ),
    ).resolves.toMatchObject({
      fixtureGeneration: "fixture-generation-after-renewal",
    });
  });

  it("fails closed while the latest fixture reset is incomplete", async () => {
    const testEnv = environment();
    await recordFixtureReset(testEnv, "completed-fixture-generation");
    const cookie = cookieHeader(
      await evaluationSessionCookie(testEnv, "organizer", 1_000),
    );
    const request = new Request("https://app.programcue.com/evaluate", {
      headers: { cookie },
    });

    await recordFixtureReset(testEnv, "pending-fixture-generation", "started");

    await expect(
      evaluationSessionCookie(testEnv, "organizer", 1_001),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      readEvaluationSession(request, testEnv, 1_001),
    ).rejects.toMatchObject({ status: 503 });
  });

  it.each([
    ["owner", "membership-demo-owner"],
    ["organizer", "membership-demo-admin"],
    ["chair", "membership-demo-committee_chair"],
    ["reviewer", "membership-demo-evaluator"],
    ["applicant", "membership-demo-submitter"],
    ["speaker", "membership-demo-speaker"],
  ] as const)(
    "rejects showcase identity %s when its expected membership is revoked",
    async (identityKey, membershipId) => {
      const testEnv = environment();
      await recordFixtureReset(testEnv);
      await testEnv.DB.prepare(
        "UPDATE memberships SET revoked_at = unixepoch() WHERE id = ?",
      )
        .bind(membershipId)
        .run();

      const rejected = await resolveEvaluationPerson(
        testEnv,
        identityKey,
      ).catch((error: unknown) => error);
      expect(rejected).toBeInstanceOf(Response);
      expect((rejected as Response).status).toBe(503);
      expect((rejected as Response).headers.get("cache-control")).toBe(
        "no-store",
      );
    },
  );

  it("requires a showcase persona's exact role and event scope", async () => {
    const testEnv = environment();
    await recordFixtureReset(testEnv);
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `UPDATE memberships SET role = 'speaker'
          WHERE id = 'membership-demo-evaluator'`,
      ),
      testEnv.DB.prepare(
        `UPDATE memberships SET event_id = ?
          WHERE id = 'membership-demo-owner'`,
      ).bind("evt-foe-2025"),
    ]);

    await expect(
      resolveEvaluationPerson(testEnv, "reviewer"),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      resolveEvaluationPerson(testEnv, "owner"),
    ).rejects.toMatchObject({ status: 503 });
  });

  it("keeps the clean applicant and reviewer resolvable before scenario membership exists", async () => {
    const testEnv = environment();
    await recordFixtureReset(testEnv);

    await expect(
      resolveEvaluationPerson(testEnv, "sbek_applicant"),
    ).resolves.toMatchObject({ personId: "person-sbek-speaker" });
    await expect(
      resolveEvaluationPerson(testEnv, "sbek_reviewer"),
    ).resolves.toMatchObject({ personId: "person-sbek-reviewer" });
  });

  it("fails fast when a selected applicant loses its activated membership", async () => {
    const testEnv = environment();
    const fixtureGeneration = await recordFixtureReset(testEnv);
    await activateEvaluationApplicantAccount(testEnv, fixtureGeneration);
    const cookie = cookieHeader(
      await evaluationSessionCookie(testEnv, "sbek_applicant"),
    );
    await testEnv.DB.prepare(
      `DELETE FROM memberships
        WHERE id = 'membership-production-evaluation-applicant-event'`,
    ).run();

    const rejected = await selectedEvaluationPerson(
      new Request("https://app.programcue.com/apply/form", {
        headers: { cookie },
      }),
      testEnv,
    ).catch((error: unknown) => error);
    expect(rejected).toBeInstanceOf(Response);
    expect((rejected as Response).status).toBe(503);
    expect((rejected as Response).headers.get("cache-control")).toBe(
      "no-store",
    );
  });

  it("keeps a gate-only evaluator session anonymous", async () => {
    const testEnv = environment();
    const fixtureGeneration = await recordFixtureReset(testEnv);

    await expect(
      evaluationPersonForSession(testEnv, {
        version: 1,
        identityKey: null,
        fixtureGeneration,
        expiresAt: 2_000,
      }),
    ).resolves.toBeNull();
  });

  it("does not turn missing evaluator secrets into ordinary access failures", async () => {
    await expect(
      evaluationAccessCodeMatches(
        {
          ...environment(),
          EVALUATION_ACCESS_CODE: "short",
        } as CloudflareEnvironment,
        "short",
      ),
    ).rejects.toThrow(/EVALUATION_ACCESS_CODE/);
    await expect(
      readEvaluationSession(
        new Request("https://app.programcue.com/evaluate", {
          headers: {
            cookie: `${EVALUATION_SESSION_COOKIE}=payload.signature`,
          },
        }),
        {
          ...environment(),
          EVALUATION_SESSION_SECRET: "short",
        } as CloudflareEnvironment,
      ),
    ).rejects.toThrow(/EVALUATION_SESSION_SECRET/);
  });

  it("is unavailable outside the exact production evaluation runtime", () => {
    expect(() =>
      requireEvaluationMode({
        ...environment(),
        APP_ENV: "demo",
        DEMO_MODE: "true",
        EVALUATION_MODE: "false",
      } as unknown as CloudflareEnvironment),
    ).toThrow();
  });
});
