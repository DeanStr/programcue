import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  EvaluationRevisionConflictError,
  EvaluationService,
} from "./evaluation-service.server";

const admin: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

const evaluator: Viewer = {
  personId: "person-demo-evaluator",
  name: "Jordan Lee",
  email: "jordan.evaluator@example.com",
  role: "evaluator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

const criteria = [
  {
    id: "eval-test-relevance",
    name: "Relevance",
    description: "",
    inputType: "scale_5",
    weightPercent: 25,
    required: true,
    position: 0,
  },
  {
    id: "eval-test-originality",
    name: "Originality",
    description: "",
    inputType: "scale_5",
    weightPercent: 20,
    required: true,
    position: 1,
  },
  {
    id: "eval-test-quality",
    name: "Quality",
    description: "",
    inputType: "scale_5",
    weightPercent: 25,
    required: true,
    position: 2,
  },
  {
    id: "eval-test-practical",
    name: "Practical",
    description: "",
    inputType: "scale_5",
    weightPercent: 20,
    required: true,
    position: 3,
  },
  {
    id: "eval-test-expertise",
    name: "Expertise",
    description: "",
    inputType: "scale_5",
    weightPercent: 10,
    required: true,
    position: 4,
  },
] as const;

function submittedSnapshot(
  answers: Record<string, string | string[]> = {},
  formVersionId = "eval-test-form-v1",
  coreReviewVisibility?: "reviewers" | "administrators_only",
) {
  return JSON.stringify({
    formVersionId,
    versionNumber: 1,
    schema: {
      introduction: "",
      fields: [
        {
          id: "title",
          label: "Title",
          type: "short_text",
          required: true,
          help: "",
          options: [],
          reviewVisibility: coreReviewVisibility,
          blindReviewVisibility:
            coreReviewVisibility === "reviewers" ? "content" : "identity",
          condition: null,
        },
        {
          id: "category",
          label: "Category",
          type: "short_text",
          required: true,
          help: "",
          options: [],
          reviewVisibility: coreReviewVisibility,
          blindReviewVisibility:
            coreReviewVisibility === "reviewers" ? "content" : "identity",
          condition: null,
        },
        {
          id: "format",
          label: "Format",
          type: "short_text",
          required: true,
          help: "",
          options: [],
          reviewVisibility: coreReviewVisibility,
          blindReviewVisibility:
            coreReviewVisibility === "reviewers" ? "content" : "identity",
          condition: null,
        },
        {
          id: "description",
          label: "Description",
          type: "long_text",
          required: true,
          help: "",
          options: [],
          reviewVisibility: "reviewers",
          blindReviewVisibility: "content",
          condition: null,
        },
        {
          id: "biography",
          label: "Speaker biography",
          type: "long_text",
          required: false,
          help: "",
          options: [],
          reviewVisibility: "administrators_only",
          condition: null,
        },
      ],
    },
    answers: {
      title: "A practical event proposal",
      category: "Operations",
      format: "Presentation",
      ...answers,
    },
    speakers: [{ name: "Alex Morgan", email: "alex.submitter@example.com" }],
  });
}

function withBatchRace(
  testEnv: CloudflareEnvironment,
  race: () => Promise<void>,
) {
  let injectRace = true;
  const racingDb = new Proxy(testEnv.DB, {
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
  return new Proxy(testEnv, {
    get(target, property) {
      return property === "DB" ? racingDb : Reflect.get(target, property);
    },
  });
}

async function resetEvaluationFixture() {
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM submissions WHERE id = 'eval-multi-round-not-advanced'",
    ),
    env.DB.prepare(
      "DELETE FROM sessions WHERE event_id = ? AND source_submission_id = 'eval-test-submission'",
    ).bind(admin.eventId),
    env.DB.prepare(
      "DELETE FROM submission_decisions WHERE event_id = ? AND submission_id = 'eval-test-submission'",
    ).bind(admin.eventId),
    env.DB.prepare("DELETE FROM evaluation_plans WHERE event_id = ?").bind(
      admin.eventId,
    ),
    env.DB.prepare("DELETE FROM evaluation_teams WHERE event_id = ?").bind(
      admin.eventId,
    ),
    env.DB.prepare(
      `UPDATE submissions SET status = 'submitted', title = 'A practical event proposal',
              form_version_id = 'eval-test-form-v1', category = 'Operations',
              format = 'Presentation', answers_json = ?,
              submitted_snapshot_json = ?, last_operation_id = NULL,
              revision = revision + 1, updated_at = unixepoch()
        WHERE id = 'eval-test-submission' AND event_id = ?`,
    ).bind(
      JSON.stringify({
        abstract: "A clear, useful proposal.",
        description: "A practical description for the public programme.",
        biography: "Alex Morgan is the identifying speaker biography.",
      }),
      submittedSnapshot({
        abstract: "A clear, useful proposal.",
        description: "A practical description for the public programme.",
        biography: "Alex Morgan is the identifying speaker biography.",
      }),
      admin.eventId,
    ),
    env.DB.prepare(
      `UPDATE memberships SET revoked_at = NULL, accepted_at = COALESCE(accepted_at, unixepoch())
        WHERE event_id = ? AND person_id = ? AND role = 'evaluator'`,
    ).bind(admin.eventId, evaluator.personId),
  ]);
}

describe("evaluation vertical slice", () => {
  beforeEach(async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO form_definitions (id, event_id, name, kind, status, public_slug, min_speakers, max_speakers, access_mode, revision, created_by_person_id, created_at, updated_at) VALUES ('eval-test-form', ?, 'Evaluation fixture', 'submission', 'published', 'eval-test-form', 1, 4, 'email_verified', 1, ?, unixepoch(), unixepoch())`,
      ).bind(admin.eventId, admin.personId),
      env.DB.prepare(
        `INSERT OR IGNORE INTO form_versions (id, event_id, form_id, version_number, schema_json, routing_json, settings_snapshot_json, status, revision, published_at, created_by_person_id, created_at, updated_at) VALUES ('eval-test-form-v1', ?, 'eval-test-form', 1, '[]', '{"categories":{},"trackIds":{"Operations":"demo-track-operations"},"trackNames":{"demo-track-operations":"Operations"},"teamNames":{},"directSessionDurationMinutes":null,"passwordHash":null}', '{}', 'published', 1, unixepoch(), ?, unixepoch(), unixepoch())`,
      ).bind(admin.eventId, admin.personId),
      env.DB.prepare(
        `INSERT OR IGNORE INTO submissions (id, event_id, form_version_id, submitter_person_id, submitter_email, public_reference, title, category, format, status, answers_json, submitted_snapshot_json, revision, submitted_at, created_at, updated_at) VALUES ('eval-test-submission', ?, 'eval-test-form-v1', 'person-demo-submitter', 'alex.submitter@example.com', 'SUB-EVAL-1', 'A practical event proposal', 'Operations', 'Presentation', 'submitted', ?, ?, 1, unixepoch(), unixepoch(), unixepoch())`,
      ).bind(
        admin.eventId,
        JSON.stringify({
          abstract: "A clear, useful proposal.",
          description: "A practical description for the public programme.",
          biography: "Alex Morgan is the identifying speaker biography.",
        }),
        submittedSnapshot({
          abstract: "A clear, useful proposal.",
          description: "A practical description for the public programme.",
          biography: "Alex Morgan is the identifying speaker biography.",
        }),
      ),
      env.DB.prepare(
        `INSERT OR IGNORE INTO submission_speakers (id, event_id, submission_id, person_id, email, display_name, position, invitation_status, is_primary, claimed_at, created_at, updated_at) VALUES ('eval-test-speaker', ?, 'eval-test-submission', 'person-demo-submitter', 'alex.submitter@example.com', 'Alex Morgan', 0, 'claimed', 1, unixepoch(), unixepoch(), unixepoch())`,
      ).bind(admin.eventId),
      env.DB.prepare(
        `INSERT OR IGNORE INTO submission_track_selections (
             submission_id, event_id, track_id, track_name_snapshot, position
           ) VALUES ('eval-test-submission', ?, 'demo-track-operations', 'Operations', 0)`,
      ).bind(admin.eventId),
    ]);
  });

  describe("additional workflow coverage", () => {
    it("allows only one current plan when two creators race", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      const token = crypto.randomUUID();
      const eventId = `eval-plan-creation-event-${token}`;
      const eventViewer = { ...admin, eventId };
      await testEnv.DB.prepare(
        `
        INSERT INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json
        ) VALUES (?, ?, 'Plan creation race', ?, 'UTC', 2_000_000_000, 2_000_086_400,
                  '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}')
      `,
      )
        .bind(eventId, admin.organisationId, `plan-creation-race-${token}`)
        .run();
      const winningRoundId = `eval-winning-round-${token}`;
      const losingRoundId = `eval-losing-round-${token}`;
      const racingEnv = withBatchRace(testEnv, async () => {
        await new EvaluationService(testEnv).savePlan(eventViewer, {
          revision: 0,
          name: "Winning plan",
          status: "active",
          rounds: [
            {
              id: winningRoundId,
              name: "Winning round",
              anonymous: false,
              criteria: criteria.map((criterion) => ({
                ...criterion,
                id: `${criterion.id}-${token}-winner`,
              })),
            },
          ],
        });
      });

      await expect(
        new EvaluationService(racingEnv).savePlan(eventViewer, {
          revision: 0,
          name: "Losing plan",
          status: "active",
          rounds: [
            {
              id: losingRoundId,
              name: "Losing round",
              anonymous: false,
              criteria: criteria.map((criterion) => ({
                ...criterion,
                id: `${criterion.id}-${token}-loser`,
              })),
            },
          ],
        }),
      ).rejects.toBeInstanceOf(EvaluationRevisionConflictError);

      const state = await testEnv.DB.prepare(
        `
        SELECT
          (SELECT COUNT(*) FROM evaluation_plans
            WHERE event_id = ? AND status <> 'archived') AS currentPlanCount,
          (SELECT COUNT(*) FROM evaluation_plans
            WHERE event_id = ? AND name = 'Winning plan') AS winningPlanCount,
          (SELECT COUNT(*) FROM evaluation_rounds
            WHERE event_id = ? AND id = ?) AS winningRoundCount,
          (SELECT COUNT(*) FROM evaluation_rounds
            WHERE event_id = ? AND id = ?) AS losingRoundCount,
          (SELECT COUNT(*) FROM audit_events
            WHERE event_id = ? AND action = 'evaluation.plan.saved') AS auditCount
      `,
      )
        .bind(
          eventId,
          eventId,
          eventId,
          winningRoundId,
          eventId,
          losingRoundId,
          eventId,
        )
        .first<{
          currentPlanCount: number;
          winningPlanCount: number;
          winningRoundCount: number;
          losingRoundCount: number;
          auditCount: number;
        }>();
      expect(state).toEqual({
        currentPlanCount: 1,
        winningPlanCount: 1,
        winningRoundCount: 1,
        losingRoundCount: 0,
        auditCount: 1,
      });
    });
  });

  describe("additional workflow coverage", () => {
    it("does not expose an event through another organisation", async () => {
      const service = new EvaluationService(
        env as unknown as CloudflareEnvironment,
      );
      await expect(
        service.getAdminWorkspace({
          ...admin,
          organisationId: "org-not-authorised",
        }),
      ).rejects.toThrow(/authorised organisation/);
    });
  });

  describe("additional workflow coverage", () => {
    it("records API-key actors for admin-safe evaluation commands", async () => {
      await resetEvaluationFixture();
      const service = new EvaluationService(
        env as unknown as CloudflareEnvironment,
      );
      const apiActor = {
        kind: "api_key" as const,
        organisationId: admin.organisationId,
        eventId: admin.eventId,
        personId: null,
        actorId: "api_key:evaluation-test",
      };
      const planInput = {
        revision: 0,
        name: "API evaluation plan",
        status: "active" as const,
        rounds: [
          {
            id: "eval-api-round",
            name: "API review",
            anonymous: false,
            criteria,
          },
        ],
      };
      const planCommand = {
        idempotencyKey: "evaluation-plan-key",
        requestHash: "evaluation-plan-hash",
      };
      const [planId, concurrentPlanId] = await Promise.all([
        service.savePlan(apiActor, planInput, planCommand),
        service.savePlan(apiActor, planInput, planCommand),
      ]);
      expect(concurrentPlanId).toBe(planId);
      await expect(
        service.savePlan(apiActor, planInput, planCommand),
      ).resolves.toBe(planId);
      await expect(
        service.savePlan(apiActor, planInput, {
          ...planCommand,
          requestHash: "different-plan-hash",
        }),
      ).rejects.toThrow(/different evaluation request/);
      await env.DB.prepare(
        `INSERT INTO evaluation_round_reviewers
           (id, event_id, round_id, person_id, added_by_person_id)
         VALUES (?, ?, ?, ?, ?)`,
      )
        .bind(
          "eval-api-round-reviewer",
          admin.eventId,
          "eval-api-round",
          evaluator.personId,
          admin.personId,
        )
        .run();
      const roundInput = {
        planId,
        planRevision: 1,
        name: "API final review",
        dueAt: null,
        cloneRoundId: "eval-api-round",
      };
      const roundCommand = {
        idempotencyKey: "evaluation-round-key",
        requestHash: "evaluation-round-hash",
      };
      const nextRoundId = await service.addNextRound(
        apiActor,
        roundInput,
        roundCommand,
      );
      await expect(
        service.addNextRound(apiActor, roundInput, roundCommand),
      ).resolves.toBe(nextRoundId);
      const assignmentInput = {
        roundId: "eval-api-round",
        targetType: "submission" as const,
        targetIds: ["eval-test-submission"],
        evaluatorPersonIds: [evaluator.personId],
      };
      const assignmentCommand = {
        idempotencyKey: "evaluation-assignment-key",
        requestHash: "evaluation-assignment-hash",
      };
      const assignment = await service.assign(
        apiActor,
        assignmentInput,
        assignmentCommand,
      );
      await expect(
        service.assign(apiActor, assignmentInput, assignmentCommand),
      ).resolves.toEqual(assignment);
      const auditActors = await env.DB.prepare(
        `SELECT action, actor_person_id AS actorPersonId, actor_id AS actorId
           FROM audit_events
          WHERE event_id = ? AND actor_id = ?
          ORDER BY action`,
      )
        .bind(admin.eventId, apiActor.actorId)
        .all<{
          action: string;
          actorPersonId: string | null;
          actorId: string;
        }>();
      expect(auditActors.results).toEqual([
        {
          action: "evaluation.assignments.created",
          actorPersonId: null,
          actorId: apiActor.actorId,
        },
        {
          action: "evaluation.plan.saved",
          actorPersonId: null,
          actorId: apiActor.actorId,
        },
        {
          action: "evaluation.round.created",
          actorPersonId: null,
          actorId: apiActor.actorId,
        },
      ]);
    });
  });
});
