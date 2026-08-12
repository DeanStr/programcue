import { env } from "cloudflare:test";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { formSchemaSchema } from "~/modules/submissions/submission-schema";
import { ensureDemoEvaluationData } from "./demo.server";
import { processCommunicationSend } from "../../../workers/queue/communication-send";
import { EvaluationDecisionService } from "./evaluation-decision-service.server";
import {
  EvaluationRevisionConflictError,
  EvaluationService,
  EvaluationStateError,
  EvaluationValidationError,
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

const committeeChair: Viewer = {
  ...admin,
  personId: admin.personId,
  name: "Casey Chair",
  email: "casey.chair@example.com",
  role: "committee_chair",
};

function evaluationEnvironment(base = env as unknown as CloudflareEnvironment) {
  return {
    ...base,
    OPERATIONS_QUEUE: { send: async () => undefined },
  } as unknown as CloudflareEnvironment;
}

async function invitationTokenIdentifier(snapshotJson: string) {
  const body = JSON.parse(snapshotJson).content.body as string;
  const token = new URL(
    body.match(/https?:\/\/\S+/u)?.[0] ?? "",
  ).searchParams.get("token");
  if (!token) throw new Error("The invitation snapshot is missing its token.");
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
  );
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

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

  describe("round workflows", () => {
    it("does not replace plan rounds when an assignment appears after the precheck", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      const token = crypto.randomUUID();
      const eventId = `eval-plan-assignment-event-${token}`;
      const eventViewer = { ...admin, eventId };
      const formId = `eval-plan-assignment-form-${token}`;
      const versionId = `eval-plan-assignment-version-${token}`;
      const submissionId = `eval-plan-assignment-submission-${token}`;
      const roundId = `eval-plan-assignment-round-${token}`;
      const replacementRoundId = `eval-plan-replacement-round-${token}`;
      const assignmentId = `eval-plan-assignment-${token}`;
      await testEnv.DB.batch([
        testEnv.DB.prepare(
          `
          INSERT INTO events (
            id, organisation_id, name, slug, timezone, starts_at, ends_at,
            file_policy_json
          ) VALUES (?, ?, 'Plan assignment race', ?, 'UTC', 2_000_000_000, 2_000_086_400,
                    '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}')
        `,
        ).bind(eventId, admin.organisationId, `plan-assignment-race-${token}`),
        testEnv.DB.prepare(
          `
          INSERT INTO form_definitions (
            id, event_id, name, kind, status, public_slug, min_speakers,
            max_speakers, access_mode, revision, created_by_person_id,
            created_at, updated_at
          ) VALUES (?, ?, 'Evaluation fixture', 'submission', 'published', ?,
                    1, 4, 'email_verified', 1, ?, unixepoch(), unixepoch())
        `,
        ).bind(formId, eventId, `evaluation-fixture-${token}`, admin.personId),
        testEnv.DB.prepare(
          `
          INSERT INTO form_versions (
            id, event_id, form_id, version_number, schema_json, routing_json,
            settings_snapshot_json, status, revision, published_at,
            created_by_person_id, created_at, updated_at
          ) VALUES (?, ?, ?, 1, '[]', '{}', '{}', 'published', 1,
                    unixepoch(), ?, unixepoch(), unixepoch())
        `,
        ).bind(versionId, eventId, formId, admin.personId),
        testEnv.DB.prepare(
          `
          INSERT INTO submissions (
            id, event_id, form_version_id, submitter_person_id, submitter_email,
            public_reference, title, status, answers_json,
            submitted_snapshot_json, revision, submitted_at, created_at, updated_at
          ) VALUES (?, ?, ?, 'person-demo-submitter', 'alex.submitter@example.com',
                    ?, 'Plan assignment boundary proposal', 'submitted', '{}',
                    ?, 1, unixepoch(), unixepoch(), unixepoch())
        `,
        ).bind(
          submissionId,
          eventId,
          versionId,
          `SUB-${token}`,
          submittedSnapshot({}, versionId),
        ),
      ]);
      const service = new EvaluationService(testEnv);
      await service.savePlan(eventViewer, {
        revision: 0,
        name: "Stable assigned plan",
        status: "active",
        rounds: [
          {
            id: roundId,
            name: "Original round",
            anonymous: false,
            criteria: criteria.map((criterion) => ({
              ...criterion,
              id: `${criterion.id}-${token}-original`,
            })),
          },
        ],
      });
      const racingEnv = withBatchRace(testEnv, async () => {
        await testEnv.DB.prepare(
          `
          INSERT INTO evaluator_assignments (
            id, event_id, round_id, submission_id, evaluator_person_id,
            status, revision, assigned_at
          ) VALUES (
            ?, ?, ?, ?, ?,
            'assigned', 1, unixepoch()
          )
        `,
        )
          .bind(
            assignmentId,
            eventId,
            roundId,
            submissionId,
            evaluator.personId,
          )
          .run();
      });

      await expect(
        new EvaluationService(racingEnv).savePlan(eventViewer, {
          revision: 1,
          name: "Unsafe replacement",
          status: "active",
          rounds: [
            {
              id: replacementRoundId,
              name: "Replacement round",
              anonymous: false,
              criteria: criteria.map((criterion) => ({
                ...criterion,
                id: `${criterion.id}-replacement`,
              })),
            },
          ],
        }),
      ).rejects.toThrow(/plan with assignments cannot/i);

      const plan = await testEnv.DB.prepare(
        `
        SELECT name, revision,
               (SELECT COUNT(*) FROM evaluation_rounds current_round
                 WHERE current_round.plan_id = evaluation_plans.id
                   AND current_round.id = ?) AS originalRoundCount,
               (SELECT COUNT(*) FROM evaluation_rounds replacement_round
                 WHERE replacement_round.plan_id = evaluation_plans.id
                   AND replacement_round.id = ?) AS replacementRoundCount
          FROM evaluation_plans
         WHERE event_id = ? AND status <> 'archived'
      `,
      )
        .bind(roundId, replacementRoundId, eventId)
        .first<{
          name: string;
          revision: number;
          originalRoundCount: number;
          replacementRoundCount: number;
        }>();
      expect(plan).toEqual({
        name: "Stable assigned plan",
        revision: 1,
        originalRoundCount: 1,
        replacementRoundCount: 0,
      });
    });
  });

  describe("round workflows", () => {
    it("closes a completed round, locks its review and advances a shortlist atomically", async () => {
      await resetEvaluationFixture();
      const service = new EvaluationService(
        env as unknown as CloudflareEnvironment,
      );
      const planId = await service.savePlan(admin, {
        revision: 0,
        name: "Two-round plan",
        status: "active",
        rounds: [
          {
            id: "eval-multi-round-one",
            name: "Initial review",
            anonymous: false,
            criteria,
          },
        ],
      });
      const nextRoundId = await service.addNextRound(admin, {
        planId,
        planRevision: 1,
        name: "Final review draft",
        dueAt: null,
        cloneRoundId: "eval-multi-round-one",
      });
      const draftRoundUpdate = {
        roundId: nextRoundId,
        revision: 1,
        name: "Final review",
        dueAt: null,
        criteria: criteria.map((criterion) => ({
          ...criterion,
          id: `${criterion.id}-final`,
        })),
      };
      const roundOperation = {
        operationId: `assistant:${crypto.randomUUID()}`,
        auditId: `assistant-rubric-audit:${crypto.randomUUID()}`,
      };
      await service.updateDraftRound(admin, draftRoundUpdate, roundOperation);
      await expect(
        service.updateDraftRound(admin, draftRoundUpdate, roundOperation),
      ).resolves.toBeUndefined();
      await env.DB.prepare(
        `
        INSERT INTO submissions (
          id, event_id, form_version_id, submitter_person_id, submitter_email,
          public_reference, title, category, format, status, answers_json,
          submitted_snapshot_json, revision, submitted_at, created_at, updated_at
        ) VALUES (
          'eval-multi-round-not-advanced', ?, 'eval-test-form-v1',
          'person-demo-submitter', 'alex.submitter@example.com',
          'SUB-EVAL-NOT-ADVANCED', 'Proposal not shortlisted', 'Operations',
          'Presentation', 'submitted', '{}', ?, 1,
          unixepoch(), unixepoch(), unixepoch()
        )
      `,
      )
        .bind(admin.eventId, submittedSnapshot())
        .run();
      await service.assign(admin, {
        roundId: "eval-multi-round-one",
        targetType: "submission",
        targetIds: ["eval-test-submission", "eval-multi-round-not-advanced"],
        evaluatorPersonIds: [evaluator.personId],
      });
      const queue = await service.getReviewerWorkspace(evaluator);
      const firstWorkspace = await service.getReviewerWorkspace(
        evaluator,
        queue.assignments.find(
          (assignment) => assignment.submissionId === "eval-test-submission",
        )!.id,
      );
      const submitted = await service.saveReview(evaluator, {
        assignmentId: firstWorkspace.selected!.id,
        revision: 0,
        scores: Object.fromEntries(
          firstWorkspace.criteria.map((criterion) => [criterion.id, 5]),
        ),
        recommendation: "accept",
        confidence: 5,
        submitterFeedback: "Strong proposal.",
        privateNotes: "Advance to the final round.",
        intent: "submit",
      });
      const nonAdvancedWorkspace = await service.getReviewerWorkspace(
        evaluator,
        queue.assignments.find(
          (assignment) =>
            assignment.submissionId === "eval-multi-round-not-advanced",
        )!.id,
      );
      await service.saveReview(evaluator, {
        assignmentId: nonAdvancedWorkspace.selected!.id,
        revision: 0,
        scores: Object.fromEntries(
          nonAdvancedWorkspace.criteria.map((criterion) => [criterion.id, 3]),
        ),
        recommendation: "reject",
        confidence: 4,
        submitterFeedback: "Not selected for the final round.",
        privateNotes: "Conclude after the first round.",
        intent: "submit",
      });

      const advanceInput = {
        fromRoundId: "eval-multi-round-one",
        fromRoundRevision: 1,
        toRoundId: nextRoundId,
        toRoundRevision: 2,
        submissionIds: ["eval-test-submission"],
        evaluatorPersonIds: [evaluator.personId],
        teamId: null,
        confirmed: true as const,
      };
      const advanceActor = {
        kind: "api_key" as const,
        organisationId: admin.organisationId,
        eventId: admin.eventId,
        personId: null,
        actorId: "api_key:evaluation-advance-test",
      };
      const advanceCommand = {
        idempotencyKey: "evaluation-advance-key",
        requestHash: "evaluation-advance-hash",
      };
      const result = await service.advanceRound(
        advanceActor,
        advanceInput,
        advanceCommand,
      );
      expect(result).toEqual({
        advancedSubmissionCount: 1,
        assignmentCount: 1,
      });
      await expect(
        service.advanceRound(advanceActor, advanceInput, advanceCommand),
      ).resolves.toEqual(result);
      const state = await env.DB.prepare(
        `
        SELECT
          (SELECT status FROM evaluation_rounds WHERE id = 'eval-multi-round-one') AS firstStatus,
          (SELECT status FROM evaluation_rounds WHERE id = ?) AS secondStatus,
          (SELECT status FROM reviews WHERE id = ?) AS reviewStatus,
          (SELECT status FROM submissions WHERE id = 'eval-test-submission') AS submissionStatus,
          (SELECT status FROM submissions
            WHERE id = 'eval-multi-round-not-advanced') AS nonAdvancedSubmissionStatus,
          (SELECT COUNT(*) FROM evaluator_assignments
            WHERE round_id = ?
              AND submission_id = 'eval-test-submission'
              AND status = 'assigned') AS nextAssignmentCount,
          (SELECT COUNT(*) FROM evaluator_assignments
            WHERE round_id = ?
              AND submission_id = 'eval-multi-round-not-advanced') AS nonAdvancedAssignmentCount
      `,
      )
        .bind(nextRoundId, submitted.reviewId, nextRoundId, nextRoundId)
        .first();
      expect(state).toEqual({
        firstStatus: "closed",
        secondStatus: "active",
        reviewStatus: "locked",
        submissionStatus: "assigned",
        nonAdvancedSubmissionStatus: "decision_ready",
        nextAssignmentCount: 1,
        nonAdvancedAssignmentCount: 0,
      });
      const nextWorkspace = await service.getReviewerWorkspace(evaluator);
      expect(nextWorkspace.selected).toMatchObject({
        submissionId: "eval-test-submission",
        status: "assigned",
      });
    });

    it("supports mixed rubric inputs, confirmed moderation and explicit review reopening", async () => {
      await resetEvaluationFixture();
      const service = new EvaluationService(
        env as unknown as CloudflareEnvironment,
      );
      await service.savePlan(admin, {
        revision: 0,
        name: "Moderated mixed rubric",
        status: "active",
        rounds: [
          {
            id: "eval-moderation-round",
            name: "Panel review",
            anonymous: false,
            criteria: [
              {
                id: "eval-scale-ten",
                name: "Programme fit",
                description: "Score from one to ten.",
                inputType: "scale_10",
                weightPercent: 100,
                required: true,
                position: 0,
              },
              {
                id: "eval-yes-no",
                name: "Evidence supplied",
                description: "Confirm the evidence is present.",
                inputType: "yes_no",
                weightPercent: 0,
                required: true,
                position: 1,
              },
              {
                id: "eval-free-text",
                name: "Panel context",
                description: "Record supporting context.",
                inputType: "free_text",
                weightPercent: 0,
                required: false,
                position: 2,
              },
            ],
          },
        ],
      });
      await service.assign(admin, {
        roundId: "eval-moderation-round",
        targetType: "submission",
        targetIds: ["eval-test-submission"],
        evaluatorPersonIds: [evaluator.personId],
      });
      const hiddenVideoSnapshot = JSON.parse(
        submittedSnapshot(
          {
            title: "Immutable submitted title",
            category: "Immutable submitted category",
            format: "Immutable submitted format",
            description: "A practical description for the public programme.",
            biography: "Alex Morgan is the identifying speaker biography.",
          },
          "eval-test-form-v1",
          "reviewers",
        ),
      ) as {
        schema: { fields: Array<Record<string, unknown>> };
        uploads: Record<string, { assetId: string; versionId: string }>;
      };
      hiddenVideoSnapshot.schema.fields.push({
        id: "private_video",
        label: "Private pitch video",
        type: "video",
        required: false,
        help: "",
        options: [],
        reviewVisibility: "administrators_only",
        condition: null,
      });
      hiddenVideoSnapshot.uploads = {
        private_video: {
          assetId: "eval-private-review-video",
          versionId: "eval-private-review-video-v1",
        },
      };
      await env.DB.prepare(
        `
        UPDATE submissions
           SET title = 'Changed live title', category = 'Changed live category',
               format = 'Changed live format', submitted_snapshot_json = ?
         WHERE id = 'eval-test-submission' AND event_id = ?
      `,
      )
        .bind(JSON.stringify(hiddenVideoSnapshot), admin.eventId)
        .run();
      const uploadedAttachment = await env.FILES.put(
        "evaluation-test/reviewer-attachment.txt",
        "reviewer attachment",
      );
      const hiddenVideo = await env.FILES.put(
        "evaluation-test/private-review-video.mp4",
        "private pitch video",
      );
      if (!uploadedAttachment || !hiddenVideo) {
        throw new Error("Evaluation attachment fixtures were not stored.");
      }
      await env.DB.batch([
        env.DB.prepare(
          `
          INSERT INTO file_assets (
            id, event_id, owner_person_id, target_type, target_id,
            asset_kind, status, created_at, updated_at
          ) VALUES (
            'eval-review-attachment', ?, 'person-demo-submitter', 'submission',
            'eval-test-submission', 'supporting_document', 'active',
            unixepoch(), unixepoch()
          )
        `,
        ).bind(admin.eventId),
        env.DB.prepare(
          `
          INSERT INTO file_versions (
            id, event_id, asset_id, version_number, object_key,
            original_filename, declared_content_type, detected_content_type,
            size_bytes, object_etag, upload_status, signature_status, scan_status,
            created_by_person_id, created_at, uploaded_at, scanned_at, released_at
          ) VALUES (
            'eval-review-attachment-v1', ?, 'eval-review-attachment', 1,
            'evaluation-test/reviewer-attachment.txt', 'evidence.txt',
            'text/plain', 'text/plain', 19, ?, 'uploaded', 'valid', 'clean',
            'person-demo-submitter', unixepoch(), unixepoch(), unixepoch(),
            unixepoch()
          )
        `,
        ).bind(admin.eventId, uploadedAttachment.httpEtag),
        env.DB.prepare(
          `UPDATE file_assets SET current_version_id = 'eval-review-attachment-v1'
            WHERE id = 'eval-review-attachment' AND event_id = ?`,
        ).bind(admin.eventId),
        env.DB.prepare(
          `INSERT INTO file_assets (
             id, event_id, owner_person_id, target_type, target_id,
             asset_kind, status, created_at, updated_at
           ) VALUES (
             'eval-private-review-video', ?, 'person-demo-submitter',
             'submission', 'eval-test-submission', 'video', 'active',
             unixepoch(), unixepoch()
           )`,
        ).bind(admin.eventId),
        env.DB.prepare(
          `INSERT INTO file_versions (
             id, event_id, asset_id, version_number, object_key,
             original_filename, declared_content_type, detected_content_type,
             size_bytes, object_etag, upload_status, signature_status, scan_status,
             created_by_person_id, created_at, uploaded_at, scanned_at, released_at
           ) VALUES (
             'eval-private-review-video-v1', ?, 'eval-private-review-video', 1,
             'evaluation-test/private-review-video.mp4', 'private-pitch.mp4',
             'video/mp4', 'video/mp4', 19, ?, 'uploaded', 'valid', 'clean',
             'person-demo-submitter', unixepoch(), unixepoch(), unixepoch(),
             unixepoch()
           )`,
        ).bind(admin.eventId, hiddenVideo.httpEtag),
        env.DB.prepare(
          `UPDATE file_assets
              SET current_version_id = 'eval-private-review-video-v1'
            WHERE id = 'eval-private-review-video' AND event_id = ?`,
        ).bind(admin.eventId),
      ]);
      const reviewerWorkspace = await service.getReviewerWorkspace(evaluator);
      expect(reviewerWorkspace.submission).toMatchObject({
        title: "Immutable submitted title",
        category: "Immutable submitted category",
        format: "Immutable submitted format",
        speakerNames: ["Alex Morgan"],
      });
      expect(reviewerWorkspace.submission?.answers).not.toHaveProperty(
        "biography",
      );
      expect(
        reviewerWorkspace.submission?.answerFields.map((field) => field.id),
      ).toEqual(["title", "category", "format", "description"]);
      expect(reviewerWorkspace.attachments).toEqual([]);
      await expect(
        service.downloadReviewerAttachment(
          evaluator,
          "eval-private-review-video",
        ),
      ).rejects.toMatchObject({ status: 404 });
      const administratorVideo = await service.downloadReviewerAttachment(
        admin,
        "eval-private-review-video",
      );
      expect(
        new TextDecoder().decode(await administratorVideo.arrayBuffer()),
      ).toBe("private pitch video");
      await expect(
        service.downloadReviewerAttachment(evaluator, "eval-review-attachment"),
      ).rejects.toMatchObject({ status: 404 });

      const privateVideoField = hiddenVideoSnapshot.schema.fields.find(
        (field) => field.id === "private_video",
      );
      if (!privateVideoField)
        throw new Error("Private video field is missing.");
      privateVideoField.reviewVisibility = "reviewers";
      await env.DB.prepare(
        `UPDATE submissions SET submitted_snapshot_json = ?
          WHERE id = 'eval-test-submission' AND event_id = ?`,
      )
        .bind(JSON.stringify(hiddenVideoSnapshot), admin.eventId)
        .run();
      const visibleAttachmentWorkspace =
        await service.getReviewerWorkspace(evaluator);
      expect(visibleAttachmentWorkspace.attachments).toEqual([
        expect.objectContaining({
          id: "eval-private-review-video",
          filename: "private-pitch.mp4",
          downloadHref: "/review/files/eval-private-review-video",
        }),
      ]);
      const attachment = await service.downloadReviewerAttachment(
        evaluator,
        "eval-private-review-video",
      );
      expect(new TextDecoder().decode(await attachment.arrayBuffer())).toBe(
        "private pitch video",
      );
      expect(attachment.headers.get("Cache-Control")).toBe("private, no-store");
      await expect(
        service.downloadReviewerAttachment(
          { ...evaluator, personId: "person-without-assignment" },
          "eval-private-review-video",
        ),
      ).rejects.toMatchObject({ status: 404 });
      await env.FILES.put(
        "evaluation-test/private-review-video.mp4",
        "unscanned replacement",
      );
      await expect(
        service.downloadReviewerAttachment(
          evaluator,
          "eval-private-review-video",
        ),
      ).rejects.toThrow("differs from its scanned object");
      hiddenVideoSnapshot.uploads.private_video.versionId =
        "eval-private-review-video-stale";
      await env.DB.prepare(
        `UPDATE submissions SET submitted_snapshot_json = ?
          WHERE id = 'eval-test-submission' AND event_id = ?`,
      )
        .bind(JSON.stringify(hiddenVideoSnapshot), admin.eventId)
        .run();
      await expect(
        service.getReviewerWorkspace(evaluator),
      ).resolves.toMatchObject({ attachments: [] });
      await expect(
        service.downloadReviewerAttachment(
          evaluator,
          "eval-private-review-video",
        ),
      ).rejects.toMatchObject({ status: 404 });
      const submitted = await service.saveReview(evaluator, {
        assignmentId: reviewerWorkspace.selected!.id,
        revision: 0,
        scores: {
          "eval-scale-ten": "10",
          "eval-yes-no": "yes",
          "eval-free-text": "The evidence is clear.",
        },
        recommendation: "accept",
        confidence: 5,
        submitterFeedback: "Well evidenced.",
        privateNotes: "Ready for moderation.",
        intent: "submit",
      });
      expect(submitted.weightedScore).toBe(5);
      const savedResponses = await env.DB.prepare(
        "SELECT scores_json AS scoresJson FROM reviews WHERE id = ?",
      )
        .bind(submitted.reviewId)
        .first<{ scoresJson: string }>();
      expect(JSON.parse(savedResponses!.scoresJson)).toEqual({
        "eval-scale-ten": 10,
        "eval-yes-no": true,
        "eval-free-text": "The evidence is clear.",
      });

      const draftModerationId = await service.moderate(admin, {
        roundId: "eval-moderation-round",
        submissionId: "eval-test-submission",
        expectedModerationId: null,
        recommendation: "advance",
        moderatedScore: 4.75,
        notes: "The panel agrees this proposal should advance.",
        status: "draft",
        confirmed: false,
      });
      const confirmedModerationId = await service.moderate(admin, {
        roundId: "eval-moderation-round",
        submissionId: "eval-test-submission",
        expectedModerationId: draftModerationId,
        recommendation: "advance",
        moderatedScore: 4.75,
        notes: "The panel confirmed this outcome.",
        status: "confirmed",
        confirmed: true,
      });
      expect(confirmedModerationId).not.toBe(draftModerationId);

      const reopened = await service.reopenReview(admin, {
        assignmentId: reviewerWorkspace.selected!.id,
        reason: "The evaluator must correct a material factual error.",
        confirmed: true,
      });
      expect(reopened).toEqual({
        reviewId: submitted.reviewId,
        revision: 2,
        webhookDeliveries: [],
      });
      const state = await env.DB.prepare(
        `
        SELECT
          (SELECT status FROM evaluator_assignments WHERE id = ?) AS assignmentStatus,
          (SELECT status FROM reviews WHERE id = ?) AS reviewStatus,
          (SELECT status FROM review_moderations WHERE id = ?) AS moderationStatus,
          (SELECT status FROM submissions WHERE id = 'eval-test-submission') AS submissionStatus,
          (SELECT COUNT(*) FROM review_revisions
            WHERE review_id = ? AND save_kind = 'reopened') AS reopenRevisionCount
      `,
      )
        .bind(
          reviewerWorkspace.selected!.id,
          submitted.reviewId,
          confirmedModerationId,
          submitted.reviewId,
        )
        .first();
      expect(state).toEqual({
        assignmentStatus: "reopened",
        reviewStatus: "reopened",
        moderationStatus: "superseded",
        submissionStatus: "in_review",
        reopenRevisionCount: 1,
      });
      const reopenedWorkspace = await service.getReviewerWorkspace(evaluator);
      expect(reopenedWorkspace.review).toMatchObject({
        id: submitted.reviewId,
        status: "reopened",
        revision: 2,
      });
    });
  });
});
