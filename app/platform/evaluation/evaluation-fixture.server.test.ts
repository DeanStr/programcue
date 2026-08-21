import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  DEMO_IDENTITIES,
  SBEK_FIXTURE_PEOPLE,
} from "~/platform/demo/demo-identities";
import {
  acquireEvaluationFixtureReset,
  completeEvaluationFixtureReset,
  EVALUATION_FIXTURE_RESET_OPERATION_ID,
  markEvaluationFixtureResetFailed,
} from "~/platform/evaluation/evaluation-fixture-reset-lock.server";
import {
  resetProductionEvaluationFixture,
  resetProductionEvaluationFixtureForEvaluator,
} from "./evaluation-fixture.server";
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
      "Future of Events 2027",
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
      fixtureOrganisationAdministrators: 1,
      fixtureOrganisationMemberships: 2,
      fixtureAuxiliaryMemberships: 0,
      fixtureApplicantMemberships: 0,
      nonDiscardedExtraEvents: 0,
    });
    const verifiedSenders = await environment.DB.prepare(
      `SELECT id, from_email AS fromEmail
         FROM sender_profiles
        WHERE event_id = 'evt-foe-2025'
          AND provider = 'resend' AND status = 'verified'`,
    ).all<{ id: string; fromEmail: string }>();
    expect(verifiedSenders.results).toEqual([
      {
        id: "sender-production-evaluation-fixture",
        fromEmail: "auth@programcue.com",
      },
    ]);
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
      "Future of Events 2027",
      verifiedDomains,
    );

    await expect(
      readEvaluationSession(sessionRequest, environment),
    ).resolves.toBeNull();
  });

  it("removes an activated clean-applicant membership on the next reset", async () => {
    const environment = productionEnvironment();
    await resetProductionEvaluationFixture(
      environment,
      "Future of Events 2027",
      verifiedDomains,
    );
    await environment.DB.prepare(
      `INSERT INTO memberships (
         id, organisation_id, event_id, person_id, role,
         invited_at, accepted_at, revoked_at, last_operation_id, created_at
       ) VALUES ('membership-production-evaluation-applicant-event',
                 'org-future-events', 'evt-foe-2025', ?, 'submitter', NULL,
                 unixepoch(), NULL, 'evaluation-account:test-generation',
                 unixepoch())`,
    )
      .bind(SBEK_FIXTURE_PEOPLE.speaker.personId)
      .run();
    await expect(
      environment.DB.prepare(
        `SELECT id FROM memberships
          WHERE id = 'membership-production-evaluation-applicant-event'`,
      ).first(),
    ).resolves.toBeTruthy();

    const reset = await resetProductionEvaluationFixture(
      environment,
      "Future of Events 2027",
      verifiedDomains,
    );

    expect(reset.evidence.fixtureApplicantMemberships).toBe(0);
    await expect(
      environment.DB.prepare(
        `SELECT id FROM memberships
          WHERE id = 'membership-production-evaluation-applicant-event'`,
      ).first(),
    ).resolves.toBeNull();
  });

  it("retires evaluator-created events and auxiliary contacts so resets remain repeatable", async () => {
    const environment = productionEnvironment();
    await resetProductionEvaluationFixture(
      environment,
      "Future of Events 2027",
      verifiedDomains,
    );
    await environment.DB.batch([
      environment.DB.prepare(
        `INSERT INTO events (
           id, organisation_id, name, slug, timezone, starts_at, ends_at,
           file_policy_json, activation_status
         ) SELECT 'evaluation-extra-event', organisation_id,
                  'DevFlow Conf 2027', 'devflow-conf-2027', timezone,
                  starts_at + 31536000, ends_at + 31536000,
                  file_policy_json, 'active'
             FROM events WHERE id = 'evt-foe-2025'`,
      ),
      environment.DB.prepare(
        `INSERT INTO events (
           id, organisation_id, name, slug, timezone, starts_at, ends_at,
           file_policy_json, activation_status, revision, last_operation_id
         ) SELECT 'evaluation-malformed-retired-event', organisation_id,
                  'Previously discarded event',
                  'previously-discarded-event', timezone,
                  starts_at + 94608000, ends_at + 94608000,
                  file_policy_json, 'discarded', 3,
                  'evaluation-fixture-retire:legacy'
             FROM events WHERE id = 'evt-foe-2025'`,
      ),
      environment.DB.prepare(
        `INSERT INTO events (
           id, organisation_id, name, slug, timezone, starts_at, ends_at,
           file_policy_json, activation_status, revision, last_operation_id
         ) SELECT 'evaluation-second-extra-event', organisation_id,
                  'Retired evaluation event',
                  'discarded:evaluation:evaluation-second-extra-event', timezone,
                  starts_at + 63072000, ends_at + 63072000,
                  file_policy_json, 'discarded', 7,
                  'evaluation-fixture-retire:existing'
             FROM events WHERE id = 'evt-foe-2025'`,
      ),
      environment.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, email_verified, created_at, updated_at
         ) VALUES ('evaluation-imported-person',
                   'marcus.speaker@sbek-test.example.com', 'Marcus Okafor', 0,
                   unixepoch() + 1, unixepoch() + 1)`,
      ),
      environment.DB.prepare(
        `INSERT INTO organisation_contacts (
           organisation_id, person_id, source, status, created_at, updated_at
         ) VALUES ('org-future-events', 'evaluation-imported-person',
                   'import', 'active', unixepoch(), unixepoch())`,
      ),
      environment.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, email_verified, created_at, updated_at
         ) VALUES ('evaluation-second-imported-person',
                   'second-imported@programcue.com', 'Second import', 0,
                   unixepoch() + 1, unixepoch() + 1)`,
      ),
      environment.DB.prepare(
        `INSERT INTO organisation_contacts (
           organisation_id, person_id, source, status, created_at, updated_at
         ) VALUES ('org-future-events', 'evaluation-second-imported-person',
                   'import', 'active', unixepoch(), unixepoch())`,
      ),
      environment.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         ) VALUES ('evaluation-extra-event-audit', 'person', 'internal', 1, 'org-future-events',
                   'evaluation-extra-event', ?, 'event.created', 'event',
                   'evaluation-extra-event', '{}', unixepoch())`,
      ).bind(SBEK_FIXTURE_PEOPLE.organizer.personId),
      environment.DB.prepare(
        `INSERT INTO event_brand_assets (
           id, organisation_id, event_id, kind, object_key, object_etag,
           original_filename, content_type, size_bytes, width_px, height_px,
           normalizer_version, normalized_at, created_by_person_id
         ) VALUES (
           'evaluation-extra-brand', 'org-future-events',
           'evaluation-extra-event', 'logo',
           'private/events/evaluation-extra-event/branding/logo/evaluation-extra-brand',
           '"evaluation-extra-brand"', 'brand.webp', 'image/webp', 7, 1, 1,
           'cloudflare-images-webp-v1', unixepoch(), ?
         )`,
      ).bind(SBEK_FIXTURE_PEOPLE.organizer.personId),
      environment.DB.prepare(
        `UPDATE events SET brand_logo_asset_id = 'evaluation-extra-brand'
          WHERE id = 'evaluation-extra-event'`,
      ),
    ]);
    await environment.FILES.put(
      "private/events/evaluation-extra-event/headshot.png",
      "fixture",
    );
    await environment.FILES.put(
      "private/events/evaluation-second-extra-event/slides.pdf",
      "fixture",
    );
    await environment.FILES.put(
      "private/events/evaluation-extra-event/branding/logo/evaluation-extra-brand",
      "fixture",
    );

    await resetProductionEvaluationFixture(
      environment,
      "Future of Events 2027",
      verifiedDomains,
    );

    const retired = await environment.DB.prepare(
      `SELECT activation_status AS activationStatus, slug, revision,
              last_operation_id AS lastOperationId
         FROM events WHERE id = 'evaluation-extra-event'`,
    ).first<{
      activationStatus: string;
      slug: string;
      revision: number;
      lastOperationId: string | null;
    }>();
    expect(retired).toMatchObject({
      activationStatus: "discarded",
      slug: "discarded:evaluation:evaluation-extra-event",
    });
    await expect(
      environment.DB.prepare(
        `SELECT activation_status AS activationStatus, slug, revision,
                last_operation_id AS lastOperationId
           FROM events WHERE id = 'evaluation-second-extra-event'`,
      ).first(),
    ).resolves.toEqual({
      activationStatus: "discarded",
      slug: "discarded:evaluation:evaluation-second-extra-event",
      revision: 7,
      lastOperationId: "evaluation-fixture-retire:existing",
    });
    const normalisedRetired = await environment.DB.prepare(
      `SELECT activation_status AS activationStatus, slug, revision,
              last_operation_id AS lastOperationId
         FROM events WHERE id = 'evaluation-malformed-retired-event'`,
    ).first<{
      activationStatus: string;
      slug: string;
      revision: number;
      lastOperationId: string | null;
    }>();
    expect(normalisedRetired).toMatchObject({
      activationStatus: "discarded",
      slug: "discarded:evaluation:evaluation-malformed-retired-event",
      revision: 4,
    });
    await expect(
      environment.DB.prepare(
        `SELECT json_extract(metadata_json, '$.retiredEventCount') AS retiredEventCount,
                json_extract(metadata_json, '$.removedAuxiliaryPersonCount')
                  AS removedAuxiliaryPersonCount,
                json_extract(metadata_json, '$.retainedAuxiliaryPersonCount')
                  AS retainedAuxiliaryPersonCount,
                json_extract(metadata_json, '$.removedFixtureMembershipCount')
                  AS removedFixtureMembershipCount
           FROM audit_events
          WHERE action = 'evaluation.fixture.reset'
          ORDER BY rowid DESC LIMIT 1`,
      ).first(),
    ).resolves.toEqual({
      retiredEventCount: 2,
      removedAuxiliaryPersonCount: 2,
      retainedAuxiliaryPersonCount: 0,
      removedFixtureMembershipCount: 0,
    });
    await expect(
      environment.DB.prepare(
        "SELECT id FROM audit_events WHERE id = 'evaluation-extra-event-audit'",
      ).first(),
    ).resolves.toBeTruthy();
    await expect(
      environment.DB.prepare(
        "SELECT id FROM people WHERE id = 'evaluation-imported-person'",
      ).first(),
    ).resolves.toBeNull();
    await expect(
      environment.DB.prepare(
        "SELECT id FROM people WHERE id = 'evaluation-second-imported-person'",
      ).first(),
    ).resolves.toBeNull();
    await expect(
      environment.FILES.head(
        "private/events/evaluation-extra-event/headshot.png",
      ),
    ).resolves.toBeNull();
    await expect(
      environment.FILES.head(
        "private/events/evaluation-second-extra-event/slides.pdf",
      ),
    ).resolves.toBeNull();
    await expect(
      environment.DB.prepare(
        "SELECT id FROM event_brand_assets WHERE id = 'evaluation-extra-brand'",
      ).first(),
    ).resolves.toBeNull();
    await expect(
      environment.FILES.head(
        "private/events/evaluation-extra-event/branding/logo/evaluation-extra-brand",
      ),
    ).resolves.toBeNull();

    await expect(
      resetProductionEvaluationFixture(
        environment,
        "Future of Events 2027",
        verifiedDomains,
      ),
    ).resolves.toMatchObject({
      evidence: { fixtureOrganisationAdministrators: 1 },
    });
    await expect(
      environment.DB.prepare(
        `SELECT activation_status AS activationStatus, slug, revision,
                last_operation_id AS lastOperationId
           FROM events WHERE id = 'evaluation-extra-event'`,
      ).first(),
    ).resolves.toEqual(retired);
    await expect(
      environment.DB.prepare(
        `SELECT activation_status AS activationStatus, slug, revision,
                last_operation_id AS lastOperationId
           FROM events WHERE id = 'evaluation-malformed-retired-event'`,
      ).first(),
    ).resolves.toEqual(normalisedRetired);
    await expect(
      environment.DB.prepare(
        `SELECT json_extract(metadata_json, '$.retiredEventCount') AS retiredEventCount
           FROM audit_events
          WHERE action = 'evaluation.fixture.reset'
          ORDER BY rowid DESC LIMIT 1`,
      ).first(),
    ).resolves.toEqual({ retiredEventCount: 0 });
  });

  it("rechecks extra-event active work immediately before retiring it", async () => {
    const environment = productionEnvironment();
    await resetProductionEvaluationFixture(
      environment,
      "Future of Events 2027",
      verifiedDomains,
    );
    await environment.DB.prepare(
      `INSERT INTO events (
         id, organisation_id, name, slug, timezone, starts_at, ends_at,
         file_policy_json, activation_status
       ) SELECT 'evaluation-boundary-race-event', organisation_id,
                'Boundary race event', 'evaluation-boundary-race-event', timezone,
                starts_at + 31536000, ends_at + 31536000,
                file_policy_json, 'active'
           FROM events WHERE id = 'evt-foe-2025'`,
    ).run();
    const objectKey =
      "private/events/evaluation-boundary-race-event/sentinel.txt";
    await environment.FILES.put(objectKey, "sentinel");

    let injected = false;
    const wrapStatement = (
      statement: D1PreparedStatement,
      isStartMarker: boolean,
    ): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, property) {
          if (property === "bind") {
            return (...values: unknown[]) =>
              wrapStatement(target.bind(...values), isStartMarker);
          }
          if (property === "run" && isStartMarker) {
            return async () => {
              const result = await target.run();
              if (!injected) {
                injected = true;
                await environment.DB.prepare(
                  `INSERT INTO operation_jobs (
                     id, organisation_id, event_id, requested_by_person_id,
                     type, idempotency_key, correlation_id, status, payload_json,
                     progress_total, progress_completed, progress_failed,
                     created_at, updated_at
                   ) VALUES (
                     'evaluation-boundary-active-operation',
                     'org-future-events', 'evaluation-boundary-race-event', ?,
                     'evaluation.test', 'evaluation-boundary-active-operation',
                     'evaluation-boundary-active-operation', 'running', '{}',
                     1, 0, 0, unixepoch(), unixepoch()
                   )`,
                )
                  .bind(SBEK_FIXTURE_PEOPLE.organizer.personId)
                  .run();
              }
              return result;
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    const boundaryDb = new Proxy(environment.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (query: string) =>
            wrapStatement(
              target.prepare(query),
              query.includes("'evaluation.fixture.reset.started'"),
            );
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    try {
      await expect(
        resetProductionEvaluationFixture(
          productionEnvironment({ DB: boundaryDb }),
          "Future of Events 2027",
          verifiedDomains,
        ),
      ).rejects.toThrow(/extra events have active work/iu);

      expect(injected).toBe(true);
      await expect(
        environment.DB.prepare(
          `SELECT activation_status AS activationStatus, slug
             FROM events WHERE id = 'evaluation-boundary-race-event'`,
        ).first(),
      ).resolves.toEqual({
        activationStatus: "active",
        slug: "evaluation-boundary-race-event",
      });
      await expect(
        environment.DB.prepare(
          `SELECT status FROM operation_jobs
            WHERE id = 'evaluation-boundary-active-operation'`,
        ).first(),
      ).resolves.toEqual({ status: "running" });
      await expect(environment.FILES.head(objectKey)).resolves.not.toBeNull();
    } finally {
      await environment.DB.prepare(
        `DELETE FROM operation_jobs
          WHERE id = 'evaluation-boundary-active-operation'`,
      ).run();
      await environment.FILES.delete(objectKey);
      await environment.DB.prepare(
        "DELETE FROM events WHERE id = 'evaluation-boundary-race-event'",
      ).run();
    }
  });

  it("rejects an overlapping live reset and exposes no generation until its owner completes", async () => {
    const environment = productionEnvironment();
    await resetProductionEvaluationFixture(
      environment,
      "Future of Events 2027",
      verifiedDomains,
    );
    const priorCookie = await evaluationSessionCookie(environment, "organizer");
    const priorRequest = new Request("https://app.programcue.com/evaluate", {
      headers: { cookie: priorCookie.split(";", 1)[0]! },
    });
    const priorGeneration = await environment.DB.prepare(
      `SELECT id
         FROM audit_events
        WHERE action = 'evaluation.fixture.reset'
        ORDER BY rowid DESC LIMIT 1`,
    ).first<{ id: string }>();

    let releaseOwner!: () => void;
    const ownerReleased = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    let ownerStarted!: () => void;
    const ownerStartRecorded = new Promise<void>((resolve) => {
      ownerStarted = resolve;
    });
    let blocked = false;
    const wrapStatement = (
      statement: D1PreparedStatement,
      isStartMarker: boolean,
    ): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, property) {
          if (property === "bind") {
            return (...values: unknown[]) =>
              wrapStatement(target.bind(...values), isStartMarker);
          }
          if (property === "run" && isStartMarker) {
            return async () => {
              const result = await target.run();
              if (!blocked) {
                blocked = true;
                ownerStarted();
                await ownerReleased;
              }
              return result;
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    const blockingDb = new Proxy(environment.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (query: string) =>
            wrapStatement(
              target.prepare(query),
              query.includes("'evaluation.fixture.reset.started'"),
            );
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const owningReset = resetProductionEvaluationFixture(
      productionEnvironment({ DB: blockingDb }),
      "Future of Events 2027",
      verifiedDomains,
    );
    await ownerStartRecorded;

    try {
      await expect(
        resetProductionEvaluationFixture(
          environment,
          "Future of Events 2027",
          verifiedDomains,
        ),
      ).rejects.toThrow(/already in progress/iu);
      await expect(
        evaluationSessionCookie(environment, "organizer"),
      ).rejects.toMatchObject({ status: 503 });
      await expect(
        readEvaluationSession(priorRequest, environment),
      ).rejects.toMatchObject({ status: 503 });
      await expect(
        environment.DB.prepare(
          `SELECT id
             FROM audit_events
            WHERE action = 'evaluation.fixture.reset'
            ORDER BY rowid DESC LIMIT 1`,
        ).first(),
      ).resolves.toEqual(priorGeneration);
    } finally {
      releaseOwner();
    }

    await expect(owningReset).resolves.toMatchObject({
      evidence: { fixtureOrganisationAdministrators: 1 },
    });
    await expect(
      readEvaluationSession(priorRequest, environment),
    ).resolves.toBeNull();
    const currentGeneration = await environment.DB.prepare(
      `SELECT id
         FROM audit_events
        WHERE action = 'evaluation.fixture.reset'
        ORDER BY rowid DESC LIMIT 1`,
    ).first<{ id: string }>();
    expect(currentGeneration?.id).not.toBe(priorGeneration?.id);
    await expect(
      evaluationSessionCookie(environment, "organizer"),
    ).resolves.toContain("__Host-program_cue_evaluation=");
  });

  it("recovers an expired reset lease while keeping the stale generation unavailable", async () => {
    const environment = productionEnvironment();
    await resetProductionEvaluationFixture(
      environment,
      "Future of Events 2027",
      verifiedDomains,
    );
    const priorGeneration = await environment.DB.prepare(
      `SELECT id
         FROM audit_events
        WHERE action = 'evaluation.fixture.reset'
        ORDER BY rowid DESC LIMIT 1`,
    ).first<{ id: string }>();
    await environment.DB.prepare(
      `UPDATE operation_jobs
          SET status = 'running', payload_json = ?, result_json = NULL,
              progress_completed = 0, progress_failed = 0,
              claim_token = 'terminated-reset-owner',
              claim_expires_at = unixepoch() - 1,
              completed_at = NULL, updated_at = unixepoch() - 1
        WHERE id = ?`,
    )
      .bind(
        JSON.stringify({ attemptId: "terminated-reset-owner" }),
        EVALUATION_FIXTURE_RESET_OPERATION_ID,
      )
      .run();

    await expect(
      evaluationSessionCookie(environment, "organizer"),
    ).rejects.toMatchObject({ status: 503 });

    await expect(
      resetProductionEvaluationFixture(
        environment,
        "Future of Events 2027",
        verifiedDomains,
      ),
    ).resolves.toMatchObject({
      evidence: { fixtureOrganisationAdministrators: 1 },
    });
    const state = await environment.DB.prepare(
      `SELECT status, claim_token AS claimToken,
              claim_expires_at AS claimExpiresAt,
              json_extract(result_json, '$.fixtureGeneration') AS fixtureGeneration
         FROM operation_jobs WHERE id = ?`,
    )
      .bind(EVALUATION_FIXTURE_RESET_OPERATION_ID)
      .first<{
        status: string;
        claimToken: string | null;
        claimExpiresAt: number | null;
        fixtureGeneration: string;
      }>();
    expect(state).toMatchObject({
      status: "completed",
      claimToken: null,
      claimExpiresAt: null,
    });
    expect(state?.fixtureGeneration).not.toBe(priorGeneration?.id);
    await expect(
      evaluationSessionCookie(environment, "organizer"),
    ).resolves.toContain("__Host-program_cue_evaluation=");
  });

  it("prevents an expired owner from publishing completion after a new owner claims the reset", async () => {
    const environment = productionEnvironment();
    await resetProductionEvaluationFixture(
      environment,
      "Future of Events 2027",
      verifiedDomains,
    );
    await environment.DB.prepare(
      `UPDATE operation_jobs
          SET status = 'running', payload_json = ?, result_json = NULL,
              progress_completed = 0, progress_failed = 0,
              claim_token = 'expired-reset-owner',
              claim_expires_at = unixepoch() - 1,
              completed_at = NULL, updated_at = unixepoch() - 1
        WHERE id = ?`,
    )
      .bind(
        JSON.stringify({ attemptId: "expired-reset-owner" }),
        EVALUATION_FIXTURE_RESET_OPERATION_ID,
      )
      .run();
    await acquireEvaluationFixtureReset(environment, "replacement-reset-owner");

    await expect(
      completeEvaluationFixtureReset(
        environment,
        "expired-reset-owner",
        "stale-fixture-generation",
        {},
      ),
    ).rejects.toThrow(/lost its ownership claim/iu);
    await expect(
      environment.DB.prepare(
        "SELECT id FROM audit_events WHERE id = 'stale-fixture-generation'",
      ).first(),
    ).resolves.toBeNull();
    await expect(
      evaluationSessionCookie(environment, "organizer"),
    ).rejects.toMatchObject({ status: 503 });
    await expect(
      environment.DB.prepare(
        `SELECT status, claim_token AS claimToken
           FROM operation_jobs WHERE id = ?`,
      )
        .bind(EVALUATION_FIXTURE_RESET_OPERATION_ID)
        .first(),
    ).resolves.toEqual({
      status: "running",
      claimToken: "replacement-reset-owner",
    });

    await markEvaluationFixtureResetFailed(
      environment,
      "replacement-reset-owner",
      new Error("Test cleanup."),
    );
  });

  it("prevents a session revoked by another reset from claiming a routine reset", async () => {
    const environment = productionEnvironment();
    await resetProductionEvaluationFixture(
      environment,
      "Future of Events 2027",
      verifiedDomains,
    );
    const prior = await environment.DB.prepare(
      `SELECT json_extract(result_json, '$.fixtureGeneration') AS fixtureGeneration
         FROM operation_jobs WHERE id = ?`,
    )
      .bind(EVALUATION_FIXTURE_RESET_OPERATION_ID)
      .first<{ fixtureGeneration: string }>();
    if (!prior?.fixtureGeneration) {
      throw new Error("The fixture reset did not publish a generation.");
    }
    const newerOwner = crypto.randomUUID();
    const newerGeneration = crypto.randomUUID();
    await acquireEvaluationFixtureReset(environment, newerOwner);
    await completeEvaluationFixtureReset(
      environment,
      newerOwner,
      newerGeneration,
      { authority: "test-concurrent-reset" },
    );

    await expect(
      acquireEvaluationFixtureReset(
        environment,
        crypto.randomUUID(),
        prior.fixtureGeneration,
      ),
    ).rejects.toThrow(
      "Evaluation access expired because another fixture reset completed. Enter the access code again.",
    );
    await expect(
      environment.DB.prepare(
        `SELECT status,
                json_extract(result_json, '$.fixtureGeneration') AS fixtureGeneration
           FROM operation_jobs WHERE id = ?`,
      )
        .bind(EVALUATION_FIXTURE_RESET_OPERATION_ID)
        .first(),
    ).resolves.toEqual({
      status: "completed",
      fixtureGeneration: newerGeneration,
    });
  });

  it("fails before reset when the fixed organisation-admin membership ID has drifted", async () => {
    const environment = productionEnvironment();
    await resetProductionEvaluationFixture(
      environment,
      "Future of Events 2027",
      verifiedDomains,
    );
    await environment.DB.batch([
      environment.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, email_verified, created_at, updated_at
         ) VALUES ('membership-collision-person',
                   'membership-collision@programcue.com', 'Collision', 0,
                   unixepoch(), unixepoch())`,
      ),
      environment.DB.prepare(
        `UPDATE memberships SET person_id = 'membership-collision-person'
          WHERE id = 'membership-production-evaluation-organizer-org'`,
      ),
    ]);

    try {
      await expect(
        resetProductionEvaluationFixture(
          environment,
          "Future of Events 2027",
          verifiedDomains,
        ),
      ).rejects.toThrow(
        /organiser membership ID belongs to another identity/iu,
      );
    } finally {
      await environment.DB.prepare(
        `UPDATE memberships SET person_id = ?
          WHERE id = 'membership-production-evaluation-organizer-org'`,
      )
        .bind(SBEK_FIXTURE_PEOPLE.organizer.personId)
        .run();
    }
  });

  it("rejects reserved, duplicate and incomplete evaluator identities before reset", async () => {
    await expect(
      resetProductionEvaluationFixture(
        productionEnvironment({
          EVALUATOR_SPEAKER_EMAIL: "eval-organizer@programcue.com",
        }),
        "Future of Events 2027",
        verifiedDomains,
      ),
    ).rejects.toThrow(/distinct/u);

    await expect(
      resetProductionEvaluationFixture(
        productionEnvironment({
          EVALUATOR_REVIEWER_EMAIL: "reviewer@example.com",
        }),
        "Future of Events 2027",
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
      resetProductionEvaluationFixture(environment, "Future of Events 2027", {
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
      "Future of Events 2027",
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
        "Future of Events 2027",
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
    await expect(
      environment.DB.prepare(
        `SELECT status, claim_token AS claimToken,
                claim_expires_at AS claimExpiresAt
           FROM operation_jobs WHERE id = ?`,
      )
        .bind(EVALUATION_FIXTURE_RESET_OPERATION_ID)
        .first(),
    ).resolves.toEqual({
      status: "failed",
      claimToken: null,
      claimExpiresAt: null,
    });

    await expect(
      resetProductionEvaluationFixture(
        environment,
        "Future of Events 2027",
        verifiedDomains,
      ),
    ).resolves.toMatchObject({
      evidence: { fixtureOrganisationAdministrators: 1 },
    });
    await expect(
      evaluationSessionCookie(environment, "organizer"),
    ).resolves.toContain("__Host-program_cue_evaluation=");
  });

  it("fails promptly when fixture storage deletion makes no progress", async () => {
    const environment = productionEnvironment();
    await resetProductionEvaluationFixture(
      environment,
      "Future of Events 2027",
      verifiedDomains,
    );
    await environment.DB.prepare(
      `INSERT INTO events (
         id, organisation_id, name, slug, timezone, starts_at, ends_at,
         file_policy_json, activation_status
       ) SELECT 'evaluation-stuck-storage-event', organisation_id,
                'Stuck storage event', 'stuck-storage-event', timezone,
                starts_at + 31536000, ends_at + 31536000,
                file_policy_json, 'active'
           FROM events WHERE id = ?`,
    )
      .bind("evt-foe-2025")
      .run();
    const listedPrefixes: string[] = [];
    let deleteCalls = 0;
    const stuckPrefix = "private/events/evaluation-stuck-storage-event/";
    const stuckFiles = {
      list: async ({ prefix }: { prefix: string }) => {
        if (prefix !== stuckPrefix) return { objects: [] };
        listedPrefixes.push(prefix);
        return { objects: [{ key: `${prefix}stuck-object` }] };
      },
      delete: async () => {
        deleteCalls += 1;
      },
    } as unknown as R2Bucket;

    await expect(
      resetProductionEvaluationFixture(
        productionEnvironment({ FILES: stuckFiles }),
        "Future of Events 2027",
        verifiedDomains,
      ),
    ).rejects.toThrow(/did not make progress/iu);
    expect(listedPrefixes).toEqual(Array(4).fill(stuckPrefix) as string[]);
    expect(deleteCalls).toBe(3);
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
          "Future of Events 2027",
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

  it.each([
    "submission_speaker",
    "speaker_workflow",
    "public_site_attribution",
  ] as const)(
    "fails before mutating a fixed identity linked by an outside %s",
    async (relationship) => {
      const environment = productionEnvironment();
      await resetProductionEvaluationFixture(
        environment,
        "Future of Events 2027",
        verifiedDomains,
      );
      const suffix = relationship.replace("_", "-");
      const organisationId = `evaluation-outside-${suffix}`;
      const eventId = `evaluation-outside-event-${suffix}`;
      await environment.DB.batch([
        environment.DB.prepare(
          `INSERT INTO organisations (id, name, slug, created_at, updated_at)
           VALUES (?, 'Outside organisation', ?, unixepoch(), unixepoch())`,
        ).bind(organisationId, organisationId),
        environment.DB.prepare(
          `INSERT INTO events (
             id, organisation_id, name, slug, timezone, starts_at, ends_at,
             file_policy_json, activation_status
           ) SELECT ?, ?, 'Outside event', ?, timezone, starts_at, ends_at,
                    file_policy_json, 'active'
               FROM events WHERE id = 'evt-foe-2025'`,
        ).bind(eventId, organisationId, eventId),
      ]);
      if (relationship === "submission_speaker") {
        await environment.DB.batch([
          environment.DB.prepare(
            `INSERT INTO submissions (
               id, event_id, public_reference, title, status,
               created_at, updated_at
             ) VALUES (?, ?, ?, 'Outside proposal', 'draft',
                       unixepoch(), unixepoch())`,
          ).bind(`outside-submission-${suffix}`, eventId, `OUTSIDE-${suffix}`),
          environment.DB.prepare(
            `INSERT INTO submission_speakers (
               id, event_id, submission_id, person_id, email, display_name,
               position, invitation_status, is_primary, created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', 0,
                       unixepoch(), unixepoch())`,
          ).bind(
            `outside-speaker-${suffix}`,
            eventId,
            `outside-submission-${suffix}`,
            SBEK_FIXTURE_PEOPLE.speaker2.personId,
            SBEK_FIXTURE_PEOPLE.speaker2.email,
            SBEK_FIXTURE_PEOPLE.speaker2.name,
          ),
        ]);
      } else if (relationship === "speaker_workflow") {
        await environment.DB.prepare(
          `INSERT INTO event_speaker_workflows (
             event_id, person_id, status, source, last_operation_id,
             updated_by_person_id, created_at, updated_at
           ) VALUES (?, ?, 'prospect', 'manual', ?, ?,
                     unixepoch(), unixepoch())`,
        )
          .bind(
            eventId,
            SBEK_FIXTURE_PEOPLE.speaker2.personId,
            `outside-workflow-${suffix}`,
            SBEK_FIXTURE_PEOPLE.organizer.personId,
          )
          .run();
      } else {
        await environment.DB.prepare(
          `INSERT INTO event_public_sites (
             event_id, organisation_id, draft_json, draft_revision,
             last_updated_by_person_id, last_operation_id,
             created_at, updated_at
           ) VALUES (?, ?, '{}', 1, ?, ?, unixepoch(), unixepoch())`,
        )
          .bind(
            eventId,
            organisationId,
            SBEK_FIXTURE_PEOPLE.speaker2.personId,
            `outside-public-site-${suffix}`,
          )
          .run();
      }
      await environment.DB.prepare(
        "UPDATE events SET name = 'Cross-tenant preflight sentinel' WHERE id = 'evt-foe-2025'",
      ).run();

      try {
        await expect(
          resetProductionEvaluationFixture(
            environment,
            "Future of Events 2027",
            verifiedDomains,
          ),
        ).rejects.toThrow(/linked outside/iu);
        await expect(
          environment.DB.prepare(
            "SELECT name FROM events WHERE id = 'evt-foe-2025'",
          ).first(),
        ).resolves.toEqual({ name: "Cross-tenant preflight sentinel" });
      } finally {
        await environment.DB.prepare("DELETE FROM events WHERE id = ?")
          .bind(eventId)
          .run();
        await environment.DB.prepare("DELETE FROM organisations WHERE id = ?")
          .bind(organisationId)
          .run();
        await environment.DB.prepare(
          "UPDATE events SET name = 'Future of Events 2027' WHERE id = 'evt-foe-2025'",
        ).run();
      }
    },
  );

  it("retains an ordinary auxiliary identity with legitimate outside-organisation state", async () => {
    const environment = productionEnvironment();
    await resetProductionEvaluationFixture(
      environment,
      "Future of Events 2027",
      verifiedDomains,
    );
    await environment.DB.batch([
      environment.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, email_verified, created_at, updated_at
         ) VALUES ('evaluation-auxiliary-saved-view',
                   'auxiliary.saved-view@programcue.com', 'Auxiliary person', 0,
                   unixepoch() + 1, unixepoch() + 1)`,
      ),
      environment.DB.prepare(
        `INSERT INTO organisation_contacts (
           organisation_id, person_id, source, status, created_at, updated_at
         ) VALUES ('org-future-events', 'evaluation-auxiliary-saved-view',
                   'manual', 'active', unixepoch(), unixepoch())`,
      ),
      environment.DB.prepare(
        `INSERT INTO organisations (id, name, slug, created_at, updated_at)
         VALUES ('evaluation-saved-view-org', 'Saved view org',
                 'evaluation-saved-view-org', unixepoch(), unixepoch())`,
      ),
      environment.DB.prepare(
        `INSERT INTO events (
           id, organisation_id, name, slug, timezone, starts_at, ends_at,
           file_policy_json, activation_status
         ) SELECT 'evaluation-saved-view-event', 'evaluation-saved-view-org',
                  'Saved view event', 'evaluation-saved-view-event', timezone,
                  starts_at, ends_at, file_policy_json, 'active'
             FROM events WHERE id = 'evt-foe-2025'`,
      ),
      environment.DB.prepare(
        `INSERT INTO saved_views (
           id, event_id, owner_person_id, area, name, query_json,
           visibility, created_at, updated_at
         ) VALUES ('evaluation-outside-saved-view',
                   'evaluation-saved-view-event',
                   'evaluation-auxiliary-saved-view', 'speakers',
                   'Outside saved view', '{}', 'private',
                   unixepoch(), unixepoch())`,
      ),
    ]);

    await resetProductionEvaluationFixture(
      environment,
      "Future of Events 2027",
      verifiedDomains,
    );
    await expect(
      environment.DB.prepare(
        "SELECT id FROM people WHERE id = 'evaluation-auxiliary-saved-view'",
      ).first(),
    ).resolves.toBeTruthy();
    await expect(
      environment.DB.prepare(
        "SELECT id FROM saved_views WHERE id = 'evaluation-outside-saved-view'",
      ).first(),
    ).resolves.toBeTruthy();
    await expect(
      environment.DB.prepare(
        `SELECT 1 FROM organisation_contacts
          WHERE organisation_id = 'org-future-events'
            AND person_id = 'evaluation-auxiliary-saved-view'`,
      ).first(),
    ).resolves.toBeNull();
    await expect(
      environment.DB.prepare(
        `SELECT json_extract(metadata_json, '$.removedAuxiliaryPersonCount')
                  AS removedAuxiliaryPersonCount,
                json_extract(metadata_json, '$.retainedAuxiliaryPersonCount')
                  AS retainedAuxiliaryPersonCount
           FROM audit_events
          WHERE action = 'evaluation.fixture.reset'
          ORDER BY rowid DESC LIMIT 1`,
      ).first(),
    ).resolves.toEqual({
      removedAuxiliaryPersonCount: 0,
      retainedAuxiliaryPersonCount: 1,
    });
  });

  it.each([
    ["speaker task target", "task_instances"],
    ["person file target", "file_assets"],
    ["speaker profile subject", "speaker_profile_revisions"],
    ["speaker profile recorder", "speaker_profile_revisions"],
  ] as const)(
    "retains an auxiliary identity referenced as an outside %s",
    async (relationship, table) => {
      const environment = productionEnvironment();
      await resetProductionEvaluationFixture(
        environment,
        "Future of Events 2027",
        verifiedDomains,
      );
      const suffix = relationship.replaceAll(" ", "-");
      const personId = `evaluation-auxiliary-${suffix}`;
      const organisationId = `evaluation-outside-${suffix}`;
      const eventId = `evaluation-outside-event-${suffix}`;
      const recordId = `evaluation-outside-record-${suffix}`;
      await environment.DB.batch([
        environment.DB.prepare(
          `INSERT INTO people (
             id, email, display_name, email_verified, created_at, updated_at
           ) VALUES (?, ?, 'Auxiliary person', 0, unixepoch(), unixepoch())`,
        ).bind(personId, `${suffix}@programcue.com`),
        environment.DB.prepare(
          `INSERT INTO organisation_contacts (
             organisation_id, person_id, source, status, created_at, updated_at
           ) VALUES ('org-future-events', ?, 'manual', 'active',
                     unixepoch(), unixepoch())`,
        ).bind(personId),
        environment.DB.prepare(
          `INSERT INTO organisations (id, name, slug, created_at, updated_at)
           VALUES (?, 'Outside organisation', ?, unixepoch(), unixepoch())`,
        ).bind(organisationId, organisationId),
        environment.DB.prepare(
          `INSERT INTO events (
             id, organisation_id, name, slug, timezone, starts_at, ends_at,
             file_policy_json, activation_status
           ) SELECT ?, ?, 'Outside event', ?, timezone, starts_at, ends_at,
                    file_policy_json, 'active'
               FROM events WHERE id = 'evt-foe-2025'`,
        ).bind(eventId, organisationId, eventId),
      ]);

      if (relationship === "speaker task target") {
        await environment.DB.prepare(
          `INSERT INTO task_instances (
             id, event_id, target_type, target_id, title, impact
           ) VALUES (?, ?, 'speaker', ?, 'Outside task', 'low')`,
        )
          .bind(recordId, eventId, personId)
          .run();
      } else if (relationship === "person file target") {
        await environment.DB.prepare(
          `INSERT INTO file_assets (
             id, event_id, target_type, target_id, asset_kind
           ) VALUES (?, ?, 'person', ?, 'headshot')`,
        )
          .bind(recordId, eventId, personId)
          .run();
      } else {
        const isRecorder = relationship === "speaker profile recorder";
        await environment.DB.prepare(
          `INSERT INTO speaker_profile_revisions (
             id, organisation_id, event_id, person_id, source,
             profile_revision, display_name, publication_status,
             recorded_by_person_id, correlation_id
           ) VALUES (?, ?, ?, ?, 'canonical_person', 1,
                     'Outside speaker', 'draft', ?, ?)`,
        )
          .bind(
            recordId,
            organisationId,
            eventId,
            isRecorder ? `outside-profile-subject-${suffix}` : personId,
            isRecorder ? personId : null,
            `outside-profile-correlation-${suffix}`,
          )
          .run();
      }

      await resetProductionEvaluationFixture(
        environment,
        "Future of Events 2027",
        verifiedDomains,
      );

      await expect(
        environment.DB.prepare("SELECT id FROM people WHERE id = ?")
          .bind(personId)
          .first(),
      ).resolves.toEqual({ id: personId });
      await expect(
        environment.DB.prepare(`SELECT id FROM ${table} WHERE id = ?`)
          .bind(recordId)
          .first(),
      ).resolves.toEqual({ id: recordId });
      await expect(
        environment.DB.prepare(
          `SELECT 1 FROM organisation_contacts
            WHERE organisation_id = 'org-future-events'
              AND person_id = ?`,
        )
          .bind(personId)
          .first(),
      ).resolves.toBeNull();
    },
  );

  it("removes fixture access while preserving a durable controlled-inbox identity", async () => {
    const environment = productionEnvironment();
    await resetProductionEvaluationFixture(
      environment,
      "Future of Events 2027",
      verifiedDomains,
    );
    const personId = "evaluation-controlled-inbox-person";
    const email = "controlled-inbox@programcue.com";
    await environment.DB.batch([
      environment.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, email_verified, created_at, updated_at
         ) VALUES (?, ?, 'Controlled inbox reviewer', 1,
                   unixepoch(), unixepoch())`,
      ).bind(personId, email),
      environment.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role, invited_at,
           invitation_expires_at, accepted_at, revoked_at, created_at
         ) VALUES ('evaluation-controlled-inbox-membership',
                   'org-future-events', 'evt-foe-2025', ?, 'evaluator',
                   unixepoch(), unixepoch() + 604800, unixepoch(), NULL,
                   unixepoch())`,
      ).bind(personId),
      environment.DB.prepare(
        `INSERT INTO evaluation_team_members (
           team_id, event_id, person_id, role, joined_at, removed_at
         )
         SELECT id, event_id, ?, 'evaluator', unixepoch(), NULL
           FROM evaluation_teams
          WHERE event_id = 'evt-foe-2025'
          ORDER BY id LIMIT 1`,
      ).bind(personId),
      environment.DB.prepare(
        `INSERT INTO auth_sessions (
           id, person_id, token, expires_at, created_at, updated_at
         ) VALUES ('evaluation-controlled-inbox-session', ?,
                   'evaluation-controlled-inbox-session-token',
                   unixepoch() + 3600, unixepoch(), unixepoch())`,
      ).bind(personId),
      environment.DB.prepare(
        `INSERT INTO auth_accounts (
           id, person_id, provider_id, account_id, created_at, updated_at
         ) VALUES ('evaluation-controlled-inbox-account', ?, 'credential', ?,
                   unixepoch(), unixepoch())`,
      ).bind(personId, email),
      environment.DB.prepare(
        `INSERT INTO verification_tokens (
           id, identifier, value, expires_at, created_at, updated_at
         ) VALUES ('evaluation-controlled-inbox-token',
                   'controlled-inbox-token', ?, unixepoch() + 300,
                   unixepoch(), unixepoch())`,
      ).bind(JSON.stringify({ email })),
      environment.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id,
           actor_person_id, action, entity_type, entity_id, metadata_json,
           created_at
         ) VALUES ('evaluation-controlled-inbox-acceptance', 'person',
                   'admin_ui', 1, 'org-future-events', 'evt-foe-2025', ?,
                   'membership.accepted', 'membership',
                   'evaluation-controlled-inbox-membership',
                   '{"role":"evaluator"}', unixepoch())`,
      ).bind(personId),
      environment.DB.prepare(
        `INSERT INTO organisations (id, name, slug, created_at, updated_at)
         VALUES ('evaluation-controlled-outside-org', 'Outside organisation',
                 'evaluation-controlled-outside-org', unixepoch(), unixepoch())`,
      ),
      environment.DB.prepare(
        `INSERT INTO events (
           id, organisation_id, name, slug, timezone, starts_at, ends_at,
           file_policy_json, activation_status
         ) SELECT 'evaluation-controlled-outside-event',
                  'evaluation-controlled-outside-org', 'Outside event',
                  'evaluation-controlled-outside-event', timezone, starts_at,
                  ends_at, file_policy_json, 'active'
             FROM events WHERE id = 'evt-foe-2025'`,
      ),
      environment.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role, accepted_at,
           created_at
         ) VALUES ('evaluation-controlled-outside-membership',
                   'evaluation-controlled-outside-org',
                   'evaluation-controlled-outside-event', ?, 'evaluator',
                   unixepoch(), unixepoch())`,
      ).bind(personId),
    ]);

    const reset = await resetProductionEvaluationFixture(
      environment,
      "Future of Events 2027",
      verifiedDomains,
    );

    expect(reset.evidence.fixtureAuxiliaryMemberships).toBe(0);
    await expect(
      environment.DB.prepare("SELECT id, email FROM people WHERE id = ?")
        .bind(personId)
        .first(),
    ).resolves.toEqual({ id: personId, email });
    for (const [table, id] of [
      ["auth_sessions", "evaluation-controlled-inbox-session"],
      ["auth_accounts", "evaluation-controlled-inbox-account"],
      ["verification_tokens", "evaluation-controlled-inbox-token"],
      ["audit_events", "evaluation-controlled-inbox-acceptance"],
      ["memberships", "evaluation-controlled-outside-membership"],
    ] as const) {
      await expect(
        environment.DB.prepare(`SELECT id FROM ${table} WHERE id = ?`)
          .bind(id)
          .first(),
      ).resolves.toBeTruthy();
    }
    await expect(
      environment.DB.prepare(
        "SELECT id FROM memberships WHERE id = 'evaluation-controlled-inbox-membership'",
      ).first(),
    ).resolves.toBeNull();
    await expect(
      environment.DB.prepare(
        `SELECT person_id AS personId FROM evaluation_team_members
          WHERE event_id = 'evt-foe-2025' AND person_id = ?`,
      )
        .bind(personId)
        .first(),
    ).resolves.toBeNull();
    const resetAudit = await environment.DB.prepare(
      `SELECT metadata_json AS metadataJson
         FROM audit_events
        WHERE action = 'evaluation.fixture.reset'
        ORDER BY rowid DESC LIMIT 1`,
    ).first<{ metadataJson: string }>();
    expect(resetAudit).not.toBeNull();
    if (!resetAudit) {
      throw new Error("The completed evaluation reset audit is missing.");
    }
    expect(JSON.parse(resetAudit.metadataJson)).toMatchObject({
      removedAuxiliaryPersonCount: 0,
      retainedAuxiliaryPersonCount: 1,
      removedFixtureMembershipCount: 1,
    });
    expect(resetAudit.metadataJson).not.toContain(personId);
    expect(resetAudit.metadataJson).not.toContain(email);

    await expect(
      resetProductionEvaluationFixture(
        environment,
        "Future of Events 2027",
        verifiedDomains,
      ),
    ).resolves.toMatchObject({
      evidence: { fixtureAuxiliaryMemberships: 0 },
    });
  });

  it("revokes showcase authentication, calendar and account-link credentials", async () => {
    const environment = productionEnvironment();
    await resetProductionEvaluationFixture(
      environment,
      "Future of Events 2027",
      verifiedDomains,
    );
    await environment.DB.prepare(
      "UPDATE people SET email = 'previous-showcase@programcue.com' WHERE id = ?",
    )
      .bind(DEMO_IDENTITIES.evaluator.personId)
      .run();
    await environment.DB.batch([
      environment.DB.prepare(
        `INSERT INTO auth_sessions (
           id, person_id, token, expires_at, created_at, updated_at
         ) VALUES ('evaluation-showcase-session', ?, 'showcase-session-token',
                   unixepoch() + 3600, unixepoch(), unixepoch())`,
      ).bind(DEMO_IDENTITIES.evaluator.personId),
      environment.DB.prepare(
        `INSERT INTO auth_accounts (
           id, person_id, provider_id, account_id, access_token,
           created_at, updated_at
         ) VALUES ('evaluation-showcase-account', ?, 'google',
                   'showcase-google-account', 'showcase-access-token',
                   unixepoch(), unixepoch())`,
      ).bind(DEMO_IDENTITIES.evaluator.personId),
      environment.DB.prepare(
        `INSERT INTO calendar_connections (
           id, organisation_id, event_id, person_id, provider,
           account_reference, encrypted_credentials, scopes_json, status,
           expires_at, created_at, updated_at
         ) VALUES ('evaluation-showcase-calendar', 'org-future-events', NULL, ?,
                   'google', 'showcase-calendar-account', 'encrypted', '[]',
                   'connected', unixepoch() + 3600, unixepoch(), unixepoch())`,
      ).bind(DEMO_IDENTITIES.evaluator.personId),
      environment.DB.prepare(
        `INSERT INTO verification_tokens (
           id, identifier, value, expires_at, created_at, updated_at
         ) VALUES ('evaluation-old-magic-link', 'hashed-magic-link', ?,
                   unixepoch() + 300, unixepoch(), unixepoch())`,
      ).bind(JSON.stringify({ email: "eval-organizer@programcue.com" })),
      environment.DB.prepare(
        `INSERT INTO verification_tokens (
           id, identifier, value, expires_at, created_at, updated_at
         ) VALUES ('evaluation-showcase-token', ?, '{}',
                   unixepoch() + 300, unixepoch(), unixepoch())`,
      ).bind("previous-showcase@programcue.com"),
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
      "Future of Events 2027",
      verifiedDomains,
    );

    const remaining = await environment.DB.prepare(
      `SELECT id FROM verification_tokens
        WHERE id IN ('evaluation-old-magic-link', 'evaluation-old-account-link',
                     'evaluation-showcase-token', 'unrelated-token')
        ORDER BY id`,
    ).all<{ id: string }>();
    expect(remaining.results).toEqual([{ id: "unrelated-token" }]);
    for (const [table, id] of [
      ["auth_sessions", "evaluation-showcase-session"],
      ["auth_accounts", "evaluation-showcase-account"],
      ["calendar_connections", "evaluation-showcase-calendar"],
    ] as const) {
      await expect(
        environment.DB.prepare(`SELECT id FROM ${table} WHERE id = ?`)
          .bind(id)
          .first(),
      ).resolves.toBeNull();
    }
  });

  it("removes fixture calendar credentials and rejects cross-tenant connections", async () => {
    const environment = productionEnvironment();
    await resetProductionEvaluationFixture(
      environment,
      "Future of Events 2027",
      verifiedDomains,
    );
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
      "Future of Events 2027",
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
          "Future of Events 2027",
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

  it("fails before mutation when routine reset provisioning has drifted", async () => {
    const environment = productionEnvironment();
    await resetProductionEvaluationFixture(
      environment,
      "Future of Events 2027",
      verifiedDomains,
    );
    const completionsBefore = await environment.DB.prepare(
      `SELECT COUNT(*) AS count FROM audit_events
        WHERE action = 'evaluation.fixture.reset'`,
    ).first<{ count: number }>();
    await environment.DB.prepare(
      `DELETE FROM sender_profiles
        WHERE id = 'sender-production-evaluation-fixture'`,
    ).run();

    await expect(
      resetProductionEvaluationFixtureForEvaluator(
        {
          ...environment,
          EVALUATOR_ORGANIZER_EMAIL: undefined,
          EVALUATOR_SPEAKER_EMAIL: undefined,
          EVALUATOR_SECOND_SPEAKER_EMAIL: undefined,
          EVALUATOR_REVIEWER_EMAIL: undefined,
          EVALUATION_RESEND_API_KEY: undefined,
        } as CloudflareEnvironment,
        "Future of Events 2027",
        "organizer",
        "test-generation-not-reached-before-provisioning-check",
      ),
    ).rejects.toThrow(
      "The provisioned evaluation sender no longer matches AUTH_EMAIL_FROM. Run the operator fixture reset.",
    );
    await expect(
      environment.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
          WHERE action = 'evaluation.fixture.reset'`,
      ).first<{ count: number }>(),
    ).resolves.toEqual(completionsBefore);
  });
});
