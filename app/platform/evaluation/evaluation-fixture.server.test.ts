import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { SBEK_FIXTURE_PEOPLE } from "~/platform/demo/demo-identities";
import { resetProductionEvaluationFixture } from "./evaluation-fixture.server";
import {
  evaluationSessionCookie,
  readEvaluationSession,
} from "./evaluation-session.server";

function productionEnvironment(overrides: Partial<CloudflareEnvironment> = {}) {
  return {
    ...(env as unknown as CloudflareEnvironment),
    APP_ENV: "production",
    DEMO_MODE: "false",
    EVALUATION_MODE: "true",
    EVALUATION_ACCESS_CODE: "evaluation-access-code-2026",
    EVALUATION_SESSION_SECRET:
      "evaluation-session-secret-with-more-than-thirty-two-characters",
    AUTH_EMAIL_FROM: "Program Cue <auth@programcue.com>",
    EMAIL_PROVIDER: "resend",
    RESEND_API_KEY: "test-resend-key",
    AI: {} as Ai,
    EVALUATOR_ORGANIZER_EMAIL: "eval-organizer@programcue.com",
    EVALUATOR_SPEAKER_EMAIL: "eval-speaker@programcue.com",
    EVALUATOR_SECOND_SPEAKER_EMAIL: "eval-speaker-2@programcue.com",
    EVALUATOR_REVIEWER_EMAIL: "eval-reviewer@programcue.com",
    ...overrides,
  } as CloudflareEnvironment;
}

const verifiedDomains = {
  list: async () => [
    {
      id: "resend-domain-programcue",
      name: "programcue.com",
      status: "verified",
    },
  ],
};

describe("production evaluation fixture", () => {
  it("resets the dedicated event while preserving ordinary production runtime behavior", async () => {
    const environment = productionEnvironment();
    const result = await resetProductionEvaluationFixture(
      environment,
      "Future of Events 2025",
      verifiedDomains,
    );

    expect(result.evidence).toEqual({
      fixturePeople: 4,
      fixtureVerifiedPeople: 0,
      fixtureSessions: 0,
      fixtureAccounts: 0,
      fixtureCalendarConnections: 0,
      fixtureVerificationTokens: 0,
      verifiedSenders: 1,
      workersAiSettings: 1,
    });
    const organizer = await environment.DB.prepare(
      "SELECT email, email_verified AS emailVerified FROM people WHERE id = ?",
    )
      .bind(SBEK_FIXTURE_PEOPLE.organizer.personId)
      .first<{ email: string; emailVerified: number }>();
    expect(organizer?.email).toBe("eval-organizer@programcue.com");
    expect(organizer?.emailVerified).toBe(0);
    const resetAudit = await environment.DB.prepare(
      `SELECT action, actor_person_id AS actorPersonId, actor_id AS actorId,
              json_extract(metadata_json, '$.status') AS resetStatus
         FROM audit_events
        WHERE action IN (
          'demo.reset',
          'evaluation.fixture.reset',
          'evaluation.fixture.reset.started'
        )
        ORDER BY action`,
    ).all<{
      action: string;
      actorPersonId: string | null;
      actorId: string | null;
      resetStatus: string | null;
    }>();
    expect(resetAudit.results).toEqual([
      {
        action: "demo.reset",
        actorPersonId: null,
        actorId: "production-evaluation-fixture-operator",
        resetStatus: null,
      },
      {
        action: "evaluation.fixture.reset",
        actorPersonId: null,
        actorId: "production-evaluation-fixture-operator",
        resetStatus: "completed",
      },
      {
        action: "evaluation.fixture.reset.started",
        actorPersonId: null,
        actorId: "production-evaluation-fixture-operator",
        resetStatus: "started",
      },
    ]);
    expect(environment.APP_ENV).toBe("production");
    expect(environment.DEMO_MODE).toBe("false");

    const sessionCookie = await evaluationSessionCookie(
      environment,
      "organizer",
    );
    const sessionRequest = new Request("https://app.programcue.com/evaluate", {
      headers: { cookie: sessionCookie.split(";", 1)[0]! },
    });
    await expect(
      readEvaluationSession(sessionRequest, environment),
    ).resolves.toMatchObject({ identityKey: "organizer" });

    await resetProductionEvaluationFixture(
      environment,
      "Future of Events 2025",
      verifiedDomains,
    );

    await expect(
      readEvaluationSession(sessionRequest, environment),
    ).resolves.toBeNull();
  });

  it("rejects reserved, duplicate and incomplete evaluator identities before reset", async () => {
    await expect(
      resetProductionEvaluationFixture(
        productionEnvironment({
          EVALUATOR_SPEAKER_EMAIL: "eval-organizer@programcue.com",
        }),
        "Future of Events 2025",
        verifiedDomains,
      ),
    ).rejects.toThrow(/distinct/u);

    await expect(
      resetProductionEvaluationFixture(
        productionEnvironment({
          EVALUATOR_REVIEWER_EMAIL: "reviewer@example.com",
        }),
        "Future of Events 2025",
        verifiedDomains,
      ),
    ).rejects.toThrow(/reserved/u);
  });

  it("verifies the live sender domain before destructive work", async () => {
    const environment = productionEnvironment();
    await environment.DB.prepare(
      "UPDATE events SET name = 'Provider preflight sentinel' WHERE id = 'evt-foe-2025'",
    ).run();
    await expect(
      resetProductionEvaluationFixture(environment, "Future of Events 2025", {
        list: async () => [],
      }),
    ).rejects.toThrow(/must report programcue.com as verified/u);
    const event = await environment.DB.prepare(
      "SELECT name FROM events WHERE id = 'evt-foe-2025'",
    ).first<{ name: string }>();
    expect(event?.name).toBe("Provider preflight sentinel");
  });

  it("fails closed from the start of a reset that later cannot clear fixture storage", async () => {
    const environment = productionEnvironment();
    await resetProductionEvaluationFixture(
      environment,
      "Future of Events 2025",
      verifiedDomains,
    );
    const sessionCookie = await evaluationSessionCookie(
      environment,
      "organizer",
    );
    const sessionRequest = new Request("https://app.programcue.com/evaluate", {
      headers: { cookie: sessionCookie.split(";", 1)[0]! },
    });
    const unavailableFiles = {
      list: async () => {
        throw new Error("fixture storage unavailable");
      },
    } as unknown as R2Bucket;

    await expect(
      resetProductionEvaluationFixture(
        productionEnvironment({ FILES: unavailableFiles }),
        "Future of Events 2025",
        verifiedDomains,
      ),
    ).rejects.toThrow(/fixture storage unavailable/u);

    await expect(
      evaluationSessionCookie(environment, "organizer"),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      readEvaluationSession(sessionRequest, environment),
    ).rejects.toMatchObject({ status: 503 });
    const latestReset = await environment.DB.prepare(
      `SELECT action
         FROM audit_events
        WHERE action IN (
          'evaluation.fixture.reset',
          'evaluation.fixture.reset.started'
        )
        ORDER BY rowid DESC
        LIMIT 1`,
    ).first<{ action: string }>();
    expect(latestReset?.action).toBe("evaluation.fixture.reset.started");
  });

  it("refuses to repurpose canonical IDs whose production identity has drifted", async () => {
    const environment = productionEnvironment();
    const before = await environment.DB.prepare(
      "SELECT name FROM events WHERE id = 'evt-foe-2025'",
    ).first<{ name: string }>();
    await environment.DB.prepare(
      "UPDATE organisations SET slug = 'unrelated-production-tenant' WHERE id = 'org-future-events'",
    ).run();
    try {
      await expect(
        resetProductionEvaluationFixture(
          environment,
          "Future of Events 2025",
          verifiedDomains,
        ),
      ).rejects.toThrow(/organisation identity is not dedicated/u);

      const event = await environment.DB.prepare(
        "SELECT name FROM events WHERE id = 'evt-foe-2025'",
      ).first<{ name: string }>();
      expect(event?.name).toBe(before?.name);
    } finally {
      await environment.DB.prepare(
        "UPDATE organisations SET slug = 'future-events-association' WHERE id = 'org-future-events'",
      ).run();
    }
  });

  it("revokes outstanding authentication and account-link tokens for fixture identities", async () => {
    const environment = productionEnvironment();
    await environment.DB.batch([
      environment.DB.prepare(
        `INSERT INTO verification_tokens (
           id, identifier, value, expires_at, created_at, updated_at
         ) VALUES ('evaluation-old-magic-link', 'hashed-magic-link', ?,
                   unixepoch() + 300, unixepoch(), unixepoch())`,
      ).bind(JSON.stringify({ email: "eval-organizer@programcue.com" })),
      environment.DB.prepare(
        `INSERT INTO verification_tokens (
           id, identifier, value, expires_at, created_at, updated_at
         ) VALUES ('evaluation-old-account-link', 'oauth-state', ?,
                   unixepoch() + 300, unixepoch(), unixepoch())`,
      ).bind(
        JSON.stringify({
          link: {
            email: "eval-reviewer@programcue.com",
            userId: SBEK_FIXTURE_PEOPLE.reviewer.personId,
          },
        }),
      ),
      environment.DB.prepare(
        `INSERT INTO verification_tokens (
           id, identifier, value, expires_at, created_at, updated_at
         ) VALUES ('unrelated-token', 'unrelated', ?,
                   unixepoch() + 300, unixepoch(), unixepoch())`,
      ).bind(JSON.stringify({ email: "someone-else@programcue.com" })),
    ]);

    await resetProductionEvaluationFixture(
      environment,
      "Future of Events 2025",
      verifiedDomains,
    );

    const remaining = await environment.DB.prepare(
      `SELECT id FROM verification_tokens
        WHERE id IN ('evaluation-old-magic-link',
                     'evaluation-old-account-link', 'unrelated-token')
        ORDER BY id`,
    ).all<{ id: string }>();
    expect(remaining.results).toEqual([{ id: "unrelated-token" }]);
  });

  it("removes fixture calendar credentials and rejects cross-tenant connections", async () => {
    const environment = productionEnvironment();
    await environment.DB.prepare(
      `INSERT INTO calendar_connections (
         id, organisation_id, event_id, person_id, provider,
         account_reference, encrypted_credentials, scopes_json, status,
         expires_at, created_at, updated_at
       ) VALUES ('evaluation-calendar', 'org-future-events', NULL, ?,
                 'google', 'evaluation-calendar-account', 'encrypted', '[]',
                 'connected', unixepoch() + 3600, unixepoch(), unixepoch())`,
    )
      .bind(SBEK_FIXTURE_PEOPLE.organizer.personId)
      .run();

    await resetProductionEvaluationFixture(
      environment,
      "Future of Events 2025",
      verifiedDomains,
    );
    const remaining = await environment.DB.prepare(
      "SELECT COUNT(*) AS count FROM calendar_connections WHERE id = 'evaluation-calendar'",
    ).first<{ count: number }>();
    expect(Number(remaining?.count)).toBe(0);

    await environment.DB.batch([
      environment.DB.prepare(
        `INSERT INTO organisations (id, name, slug, created_at, updated_at)
         VALUES ('evaluation-other-org', 'Other org', 'evaluation-other-org',
                 unixepoch(), unixepoch())`,
      ),
      environment.DB.prepare(
        `INSERT INTO calendar_connections (
           id, organisation_id, event_id, person_id, provider,
           account_reference, encrypted_credentials, scopes_json, status,
           expires_at, created_at, updated_at
         ) VALUES ('evaluation-cross-tenant-calendar', 'evaluation-other-org',
                   NULL, ?, 'google', 'cross-tenant-account', 'encrypted', '[]',
                   'connected', unixepoch() + 3600, unixepoch(), unixepoch())`,
      ).bind(SBEK_FIXTURE_PEOPLE.organizer.personId),
    ]);
    try {
      await expect(
        resetProductionEvaluationFixture(
          environment,
          "Future of Events 2025",
          verifiedDomains,
        ),
      ).rejects.toThrow(/linked outside/u);
    } finally {
      await environment.DB.prepare(
        "DELETE FROM calendar_connections WHERE id = 'evaluation-cross-tenant-calendar'",
      ).run();
      await environment.DB.prepare(
        "DELETE FROM organisations WHERE id = 'evaluation-other-org'",
      ).run();
    }
  });
});
