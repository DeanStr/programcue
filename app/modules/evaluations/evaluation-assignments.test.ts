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

async function addRoundReviewer(
  roundId: string,
  personId = evaluator.personId,
) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO evaluation_round_reviewers
       (id, event_id, round_id, person_id, added_by_person_id)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      `test-round-reviewer-${roundId}-${personId}`,
      admin.eventId,
      roundId,
      personId,
      admin.personId,
    )
    .run();
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

  describe("assignment workflows", () => {
    it("assigns sessions from an immutable snapshot and supports review, reopen and recusal", async () => {
      await resetEvaluationFixture();
      const service = new EvaluationService(
        env as unknown as CloudflareEnvironment,
      );
      await env.DB.batch([
        env.DB.prepare("DELETE FROM sessions WHERE id IN (?, ?)").bind(
          "eval-session-target",
          "eval-session-conflict-target",
        ),
        env.DB.prepare(
          `INSERT INTO sessions (
             id, event_id, title, slug, description, format, duration_minutes,
             status, revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'workshop', 75, 'unscheduled', 1,
                     unixepoch(), unixepoch())`,
        ).bind(
          "eval-session-target",
          admin.eventId,
          "Immutable session source",
          "immutable-session-source",
          "The source description captured for reviewers.",
        ),
        env.DB.prepare(
          `INSERT INTO sessions (
             id, event_id, title, slug, description, format, duration_minutes,
             status, revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, 'panel', 45, 'unscheduled', 1,
                     unixepoch(), unixepoch())`,
        ).bind(
          "eval-session-conflict-target",
          admin.eventId,
          "Conflict session",
          "conflict-session",
          "A second direct session.",
        ),
        env.DB.prepare(
          `INSERT INTO session_speakers (
             session_id, event_id, person_id, position, role_label,
             participation_status, participation_confirmed_at, visibility
           ) VALUES (?, ?, 'person-demo-submitter', 0, 'Facilitator',
                     'confirmed', unixepoch(), 'public')`,
        ).bind("eval-session-target", admin.eventId),
      ]);
      try {
        const sessionOrder = (await service.getAdminWorkspace(admin)).sessions
          .filter((session) =>
            ["eval-session-target", "eval-session-conflict-target"].includes(
              session.id,
            ),
          )
          .map((session) => session.id);
        expect(sessionOrder).toEqual([
          "eval-session-conflict-target",
          "eval-session-target",
        ]);
        await service.savePlan(admin, {
          revision: 0,
          name: "Direct session review plan",
          status: "active",
          rounds: [
            {
              id: "eval-session-round",
              name: "Session quality review",
              anonymous: false,
              criteria,
            },
          ],
        });
        await addRoundReviewer("eval-session-round");
        const assigned = await service.assign(admin, {
          roundId: "eval-session-round",
          targetType: "session",
          targetIds: ["eval-session-target", "eval-session-conflict-target"],
          evaluatorPersonIds: [evaluator.personId],
        });
        expect(assigned.createdAssignmentCount).toBe(2);
        await env.DB.prepare(
          `UPDATE sessions
              SET title = 'Changed after assignment',
                  description = 'This later edit is not reviewer evidence.',
                  duration_minutes = 30, revision = revision + 1
            WHERE id = ? AND event_id = ?`,
        )
          .bind("eval-session-target", admin.eventId)
          .run();

        const queue = await service.getReviewerWorkspace(evaluator);
        const targetAssignment = queue.assignments.find(
          (assignment) => assignment.sessionId === "eval-session-target",
        );
        expect(targetAssignment).toMatchObject({
          targetType: "session",
          targetId: "eval-session-target",
          title: "Immutable session source",
          format: "workshop",
        });
        const workspace = await service.getReviewerWorkspace(
          evaluator,
          targetAssignment!.id,
        );
        expect(workspace.submission).toMatchObject({
          sourceType: "session",
          id: "eval-session-target",
          title: "Immutable session source",
          speakerNames: ["Alex Morgan"],
          answers: {
            description: "The source description captured for reviewers.",
            durationMinutes: 75,
          },
        });
        expect(JSON.stringify(workspace.submission)).not.toContain(
          "This later edit is not reviewer evidence.",
        );
        const scores = Object.fromEntries(
          criteria.map((criterion) => [criterion.id, 4]),
        );
        const submitted = await service.saveReview(evaluator, {
          assignmentId: targetAssignment!.id,
          revision: 0,
          scores,
          recommendation: "accept",
          confidence: 4,
          submitterFeedback: "Strong session.",
          privateNotes: "Ready.",
          conflictAffirmed: true,
          intent: "submit",
        });
        expect(submitted.weightedScore).toBe(4);
        expect(
          await env.DB.prepare(
            "SELECT status FROM sessions WHERE id = 'eval-session-target'",
          ).first(),
        ).toEqual({ status: "unscheduled" });

        const reopened = await service.reopenReview(admin, {
          assignmentId: targetAssignment!.id,
          reason: "The evaluator needs to correct a material factual error.",
          confirmed: true,
        });
        expect(reopened.revision).toBe(2);
        await service.saveReview(evaluator, {
          assignmentId: targetAssignment!.id,
          revision: reopened.revision,
          scores,
          recommendation: "accept",
          confidence: 5,
          submitterFeedback: "Corrected session review.",
          privateNotes: "Ready.",
          conflictAffirmed: true,
          intent: "submit",
        });

        const conflictAssignment = queue.assignments.find(
          (assignment) =>
            assignment.sessionId === "eval-session-conflict-target",
        );
        await service.saveReview(evaluator, {
          assignmentId: conflictAssignment!.id,
          revision: 0,
          scores,
          recommendation: "reject",
          confidence: 4,
          submitterFeedback: "This needs another reviewer.",
          privateNotes: "A conflict became apparent after submission.",
          conflictAffirmed: true,
          intent: "submit",
        });
        await service.reopenReview(admin, {
          assignmentId: conflictAssignment!.id,
          reason: "The evaluator disclosed a conflict after submitting.",
          confirmed: true,
        });
        await service.declareConflict(evaluator, {
          assignmentId: conflictAssignment!.id,
          reason: "I have a close working relationship with the session owner.",
        });
        expect(
          await env.DB.prepare(
            `SELECT submission_id AS submissionId, session_id AS sessionId,
                    status
               FROM evaluator_conflicts
              WHERE round_id = ? AND session_id = ?`,
          )
            .bind("eval-session-round", "eval-session-conflict-target")
            .first(),
        ).toEqual({
          submissionId: null,
          sessionId: "eval-session-conflict-target",
          status: "recused",
        });
      } finally {
        await env.DB.prepare(
          "DELETE FROM evaluation_plans WHERE id = 'eval-session-round' OR name = 'Direct session review plan'",
        ).run();
        await env.DB.prepare("DELETE FROM sessions WHERE id IN (?, ?)")
          .bind("eval-session-target", "eval-session-conflict-target")
          .run();
      }
    });

    it("excludes cancelled and archived sessions from the review queue and next assignment", async () => {
      await resetEvaluationFixture();
      const service = new EvaluationService(
        env as unknown as CloudflareEnvironment,
      );
      const sessionIds = [
        "eval-session-current",
        "eval-session-cancelled",
        "eval-session-archived",
      ];
      await env.DB.batch(
        sessionIds.map((sessionId) =>
          env.DB.prepare(
            `INSERT INTO sessions (
                 id, event_id, title, slug, description, format,
                 duration_minutes, status, revision, created_at, updated_at
               ) VALUES (
                 ?, ?, ?, ?, 'A direct session review target.', 'presentation',
                 45, 'unscheduled', 1, unixepoch(), unixepoch()
               )`,
          ).bind(
            sessionId,
            admin.eventId,
            sessionId.replaceAll("-", " "),
            sessionId,
          ),
        ),
      );
      try {
        await service.savePlan(admin, {
          revision: 0,
          name: "Session state boundary plan",
          status: "active",
          rounds: [
            {
              id: "eval-session-state-round",
              name: "Session review",
              anonymous: false,
              criteria,
            },
          ],
        });
        await addRoundReviewer("eval-session-state-round");
        await service.assign(admin, {
          roundId: "eval-session-state-round",
          targetType: "session",
          targetIds: sessionIds,
          evaluatorPersonIds: [evaluator.personId],
        });

        const assignmentRows = await env.DB.prepare(
          `SELECT id, session_id AS sessionId
             FROM evaluator_assignments
            WHERE event_id = ? AND round_id = 'eval-session-state-round'`,
        )
          .bind(admin.eventId)
          .all<{ id: string; sessionId: string }>();
        const assignmentBySession = new Map(
          assignmentRows.results.map((assignment) => [
            assignment.sessionId,
            assignment.id,
          ]),
        );
        expect(assignmentBySession.size).toBe(3);
        const attachmentBody = "cancelled session attachment";
        const attachmentObject = await env.FILES.put(
          "evaluation-test/cancelled-session-attachment.txt",
          attachmentBody,
        );
        if (!attachmentObject) {
          throw new Error("The cancelled-session attachment was not stored.");
        }
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO file_assets (
               id, event_id, owner_person_id, target_type, target_id,
               asset_kind, status, created_at, updated_at
             ) VALUES (
               'eval-cancelled-session-attachment', ?, ?, 'session',
               'eval-session-cancelled', 'supporting_document', 'active',
               unixepoch(), unixepoch()
             )`,
          ).bind(admin.eventId, admin.personId),
          env.DB.prepare(
            `INSERT INTO file_versions (
               id, event_id, asset_id, version_number, object_key,
               original_filename, declared_content_type,
               detected_content_type, size_bytes, object_etag, upload_status,
               signature_status, scan_status, created_by_person_id,
               created_at, uploaded_at, scanned_at, released_at
             ) VALUES (
               'eval-cancelled-session-attachment-v1', ?,
               'eval-cancelled-session-attachment', 1,
               'evaluation-test/cancelled-session-attachment.txt',
               'session-evidence.txt', 'text/plain', 'text/plain', ?, ?,
               'uploaded', 'valid', 'clean', ?, unixepoch(), unixepoch(),
               unixepoch(), unixepoch()
             )`,
          ).bind(
            admin.eventId,
            new TextEncoder().encode(attachmentBody).byteLength,
            attachmentObject.httpEtag,
            admin.personId,
          ),
          env.DB.prepare(
            `UPDATE file_assets
                SET current_version_id = 'eval-cancelled-session-attachment-v1'
              WHERE id = 'eval-cancelled-session-attachment' AND event_id = ?`,
          ).bind(admin.eventId),
        ]);
        await expect(
          service
            .downloadReviewerAttachment(
              evaluator,
              "eval-cancelled-session-attachment",
            )
            .then((response) => response.text()),
        ).resolves.toBe(attachmentBody);
        await env.DB.batch([
          env.DB.prepare(
            `UPDATE sessions SET status = 'cancelled', revision = revision + 1
              WHERE id = 'eval-session-cancelled' AND event_id = ?`,
          ).bind(admin.eventId),
          env.DB.prepare(
            `UPDATE sessions SET status = 'archived', revision = revision + 1
              WHERE id = 'eval-session-archived' AND event_id = ?`,
          ).bind(admin.eventId),
        ]);

        const queue = await service.getReviewerWorkspace(evaluator);
        expect(
          queue.assignments.map((assignment) => assignment.sessionId),
        ).toEqual(["eval-session-current"]);
        await expect(
          service.getReviewerWorkspace(
            evaluator,
            assignmentBySession.get("eval-session-cancelled"),
          ),
        ).rejects.toMatchObject({ status: 404 });
        await expect(
          service.getReviewerWorkspace(
            evaluator,
            assignmentBySession.get("eval-session-archived"),
          ),
        ).rejects.toMatchObject({ status: 404 });

        const adminWorkspace = await service.getAdminWorkspace(admin);
        const visibleRoundAssignmentSessions = adminWorkspace.assignments
          .filter(
            (assignment) => assignment.roundId === "eval-session-state-round",
          )
          .map((assignment) => assignment.sessionId);
        expect(visibleRoundAssignmentSessions).toEqual([
          "eval-session-current",
        ]);
        await expect(
          service.downloadReviewerAttachment(
            evaluator,
            "eval-cancelled-session-attachment",
          ),
        ).rejects.toMatchObject({ status: 404 });
        await expect(
          service
            .downloadReviewerAttachment(
              admin,
              "eval-cancelled-session-attachment",
            )
            .then((response) => response.text()),
        ).resolves.toBe(attachmentBody);
        await expect(
          service.declareConflict(evaluator, {
            assignmentId: assignmentBySession.get("eval-session-cancelled"),
            reason: "This stale assignment must remain immutable.",
          }),
        ).rejects.toBeInstanceOf(EvaluationStateError);
        await expect(
          service.saveReview(evaluator, {
            assignmentId: assignmentBySession.get("eval-session-archived"),
            revision: 0,
            scores: {},
            recommendation: "reject",
            confidence: 1,
            submitterFeedback: "No longer reviewable.",
            privateNotes: "The session is archived.",
            intent: "save",
          }),
        ).rejects.toBeInstanceOf(EvaluationStateError);
        await expect(
          env.DB.prepare(
            `SELECT COUNT(*) AS count FROM evaluator_assignments
              WHERE id IN (?, ?) AND event_id = ? AND status = 'assigned'`,
          )
            .bind(
              assignmentBySession.get("eval-session-cancelled"),
              assignmentBySession.get("eval-session-archived"),
              admin.eventId,
            )
            .first<{ count: number }>(),
        ).resolves.toEqual({ count: 2 });

        const currentAssignmentId = assignmentBySession.get(
          "eval-session-current",
        );
        const current = await service.getReviewerWorkspace(
          evaluator,
          currentAssignmentId,
        );
        const result = await service.saveReview(evaluator, {
          assignmentId: currentAssignmentId,
          revision: 0,
          scores: Object.fromEntries(
            current.criteria.map((criterion) => [criterion.id, 4]),
          ),
          recommendation: "accept",
          confidence: 4,
          submitterFeedback: "Ready for the programme.",
          privateNotes: "No concerns.",
          conflictAffirmed: true,
          intent: "submit",
        });
        expect(result.nextAssignmentId).toBeNull();
      } finally {
        await env.DB.prepare(
          `DELETE FROM file_assets
            WHERE id = 'eval-cancelled-session-attachment' AND event_id = ?`,
        )
          .bind(admin.eventId)
          .run();
        await env.FILES.delete(
          "evaluation-test/cancelled-session-attachment.txt",
        );
        await env.DB.prepare(
          "DELETE FROM evaluation_plans WHERE id = 'eval-session-state-round' OR name = 'Session state boundary plan'",
        ).run();
        await env.DB.prepare(
          `DELETE FROM sessions
            WHERE id IN (
              'eval-session-current',
              'eval-session-cancelled',
              'eval-session-archived'
            )`,
        ).run();
      }
    });

    it("rejects an explicit unknown assignment instead of opening another review", async () => {
      const service = new EvaluationService(
        env as unknown as CloudflareEnvironment,
      );
      let adminWorkspace = await service.getAdminWorkspace(admin);
      if (!adminWorkspace.plan?.rounds[0]) {
        await service.savePlan(admin, {
          revision: 0,
          name: "Explicit selection plan",
          status: "active",
          rounds: [
            {
              id: "eval-explicit-selection-round",
              name: "Initial review",
              anonymous: false,
              criteria,
            },
          ],
        });
        adminWorkspace = await service.getAdminWorkspace(admin);
      }
      const roundId =
        adminWorkspace.plan!.rounds.find((round) => round.status === "active")
          ?.id ?? adminWorkspace.plan!.rounds[0]!.id;
      await addRoundReviewer(roundId);
      await env.DB.prepare(
        "UPDATE evaluation_rounds SET status = 'active' WHERE id = ? AND event_id = ?",
      )
        .bind(roundId, admin.eventId)
        .run();
      await env.DB.prepare(
        `
        INSERT OR IGNORE INTO submissions (
          id, event_id, form_version_id, submitter_person_id, submitter_email,
          public_reference, title, status, answers_json, submitted_snapshot_json,
          revision, submitted_at, created_at, updated_at
        ) VALUES (
          'eval-explicit-selection-submission', ?, 'eval-test-form-v1',
          'person-demo-submitter', 'alex.submitter@example.com',
          'SUB-EVAL-EXPLICIT-SELECTION', 'Explicit selection proposal', 'submitted',
          '{}', ?, 1, unixepoch(), unixepoch(), unixepoch()
        )
      `,
      )
        .bind(admin.eventId, submittedSnapshot())
        .run();
      await env.DB.prepare(
        `INSERT OR IGNORE INTO submission_track_selections (
           submission_id, event_id, track_id, track_name_snapshot, position
         ) VALUES (
           'eval-explicit-selection-submission', ?,
           'demo-track-operations', 'Operations', 0
         )`,
      )
        .bind(admin.eventId)
        .run();
      await service.assign(admin, {
        roundId,
        targetType: "submission",
        targetIds: ["eval-explicit-selection-submission"],
        evaluatorPersonIds: [evaluator.personId],
      });

      await expect(
        service.getReviewerWorkspace(evaluator, "missing-assignment"),
      ).rejects.toMatchObject({ status: 404 });
    });

    it("removes a recused assignment from the evaluator workspace", async () => {
      const service = new EvaluationService(
        env as unknown as CloudflareEnvironment,
      );
      await env.DB.batch([
        env.DB.prepare(
          `
          INSERT INTO evaluation_plans (
            id, event_id, name, status, decision_role, revision,
            created_by_person_id, created_at, updated_at
          ) VALUES (
            'eval-recused-access-plan', ?, 'Recused access plan', 'active',
            'administrator', 1, ?, unixepoch(), unixepoch()
          )
        `,
        ).bind(admin.eventId, admin.personId),
        env.DB.prepare(
          `
          INSERT INTO evaluation_rounds (
            id, event_id, plan_id, round_number, name, status, scorecard_id, revision,
            created_at, updated_at
          ) VALUES (
            'eval-recused-access-round', ?, 'eval-recused-access-plan', 1,
            'Initial review', 'active', 'eval-recused-access-round', 1, unixepoch(), unixepoch()
          )
        `,
        ).bind(admin.eventId),
        env.DB.prepare(
          `
          INSERT INTO evaluator_assignments (
            id, event_id, round_id, submission_id, evaluator_person_id,
            status, revision, conflict_declared_at, assigned_at
          ) VALUES (
            'eval-recused-access-assignment', ?, 'eval-recused-access-round',
            'eval-test-submission', ?, 'recused', 2, unixepoch(), unixepoch()
          )
        `,
        ).bind(admin.eventId, evaluator.personId),
      ]);
      try {
        const workspace = await service.getReviewerWorkspace(evaluator);
        expect(
          workspace.assignments.map((assignment) => assignment.id),
        ).not.toContain("eval-recused-access-assignment");
        await expect(
          service.getReviewerWorkspace(
            evaluator,
            "eval-recused-access-assignment",
          ),
        ).rejects.toMatchObject({ status: 404 });
        await expect(
          service.getReviewerWorkbench(
            evaluator,
            "eval-recused-access-assignment",
          ),
        ).resolves.toEqual({ kind: "selection_recused" });
      } finally {
        await env.DB.prepare(
          "DELETE FROM evaluation_plans WHERE id = 'eval-recused-access-plan'",
        ).run();
      }
    });
  });

  describe("assignment workflows", () => {
    it("does not list or assign a revoked evaluator", async () => {
      const service = new EvaluationService(
        env as unknown as CloudflareEnvironment,
      );
      await env.DB.prepare(
        `
        UPDATE memberships SET revoked_at = unixepoch()
         WHERE event_id = ? AND person_id = ? AND role = 'evaluator'
      `,
      )
        .bind(admin.eventId, evaluator.personId)
        .run();
      let workspace = await service.getAdminWorkspace(admin);
      expect(
        workspace.evaluators.some(
          (candidate) => candidate.id === evaluator.personId,
        ),
      ).toBe(false);
      if (!workspace.plan?.rounds[0]) {
        await service.savePlan(admin, {
          revision: 0,
          name: "Revocation test plan",
          status: "active",
          rounds: [
            {
              id: "eval-revoked-round",
              name: "Initial review",
              anonymous: false,
              criteria,
            },
          ],
        });
        workspace = await service.getAdminWorkspace(admin);
      }
      await env.DB.prepare(
        `
        INSERT OR IGNORE INTO submissions (
          id, event_id, form_version_id, submitter_person_id, submitter_email,
          public_reference, title, category, format, status, answers_json,
          submitted_snapshot_json, revision, submitted_at, created_at, updated_at
        ) VALUES (
          'eval-revoked-submission', ?, 'eval-test-form-v1', 'person-demo-submitter',
          'alex.submitter@example.com', 'SUB-EVAL-REVOKED', 'Revoked evaluator test',
          'Operations', 'Presentation', 'submitted', '{}', ?, 1,
          unixepoch(), unixepoch(), unixepoch()
        )
      `,
      )
        .bind(admin.eventId, submittedSnapshot())
        .run();
      await env.DB.prepare(
        `INSERT OR IGNORE INTO submission_track_selections (
           submission_id, event_id, track_id, track_name_snapshot, position
         ) VALUES (
           'eval-revoked-submission', ?,
           'demo-track-operations', 'Operations', 0
         )`,
      )
        .bind(admin.eventId)
        .run();
      await expect(
        service.assign(admin, {
          roundId: workspace.plan!.rounds[0]!.id,
          targetType: "submission",
          targetIds: ["eval-revoked-submission"],
          evaluatorPersonIds: [evaluator.personId],
        }),
      ).rejects.toThrow(/not authorised/);
    });
  });

  describe("assignment workflows", () => {
    it("keeps submission-time routing names after a team is renamed", async () => {
      await resetEvaluationFixture();
      const teamId = `eval-routing-snapshot-${crypto.randomUUID()}`;
      const originalRouting = await env.DB.prepare(
        `SELECT routing_json AS routingJson FROM form_versions
            WHERE id = 'eval-test-form-v1' AND event_id = ?`,
      )
        .bind(admin.eventId)
        .first<{ routingJson: string }>();
      expect(originalRouting).not.toBeNull();
      const routingSnapshot = {
        ...JSON.parse(originalRouting!.routingJson),
        teamNames: { [teamId]: "Original review team" },
      };
      try {
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO evaluation_teams (id, event_id, name, status)
               VALUES (?, ?, 'Renamed review team', 'active')`,
          ).bind(teamId, admin.eventId),
          env.DB.prepare(
            `INSERT INTO submission_routing_teams (submission_id, event_id, team_id)
               VALUES ('eval-test-submission', ?, ?)`,
          ).bind(admin.eventId, teamId),
          env.DB.prepare(
            `UPDATE form_versions SET routing_json = ?
                WHERE id = 'eval-test-form-v1' AND event_id = ?`,
          ).bind(JSON.stringify(routingSnapshot), admin.eventId),
        ]);

        const workspace = await new EvaluationService(
          evaluationEnvironment(),
        ).getAdminWorkspace(admin);
        expect(
          workspace.submissions.find(
            (submission) => submission.id === "eval-test-submission",
          ),
        ).toMatchObject({
          routedTeamIds: [teamId],
          routedTeamName: "Original review team",
        });
        expect(workspace.teams).toContainEqual(
          expect.objectContaining({
            id: teamId,
            name: "Renamed review team",
          }),
        );
      } finally {
        await env.DB.batch([
          env.DB.prepare(
            `DELETE FROM submission_routing_teams
                WHERE submission_id = 'eval-test-submission' AND event_id = ?
                  AND team_id = ?`,
          ).bind(admin.eventId, teamId),
          env.DB.prepare(
            `UPDATE form_versions SET routing_json = ?
                WHERE id = 'eval-test-form-v1' AND event_id = ?`,
          ).bind(originalRouting!.routingJson, admin.eventId),
          env.DB.prepare(
            `DELETE FROM evaluation_teams WHERE id = ? AND event_id = ?`,
          ).bind(teamId, admin.eventId),
        ]);
      }
    });

    it("projects persisted participant role labels into the organiser queue", async () => {
      await resetEvaluationFixture();
      await env.DB.prepare(
        `UPDATE submission_speakers
            SET role_label = 'Co-presenter'
          WHERE id = 'eval-test-speaker' AND event_id = ?`,
      )
        .bind(admin.eventId)
        .run();

      const workspace = await new EvaluationService(
        evaluationEnvironment(),
      ).getAdminWorkspace(admin);
      expect(
        workspace.submissions.find(
          (submission) => submission.id === "eval-test-submission",
        )?.speakers,
      ).toContainEqual({
        name: "Alex Morgan",
        email: "alex.submitter@example.com",
        roleLabel: "Co-presenter",
      });
    });

    it("fails the admin queue when a submission lacks authoritative tracks", async () => {
      await resetEvaluationFixture();
      await env.DB.prepare(
        `DELETE FROM submission_track_selections
          WHERE submission_id = 'eval-test-submission' AND event_id = ?`,
      )
        .bind(admin.eventId)
        .run();

      await expect(
        new EvaluationService(evaluationEnvironment()).getAdminWorkspace(admin),
      ).rejects.toThrow(/missing persisted track selections/i);
    });

    it("fails the admin queue when a submission lacks its immutable routing snapshot", async () => {
      await resetEvaluationFixture();
      try {
        await env.DB.prepare(
          `UPDATE submissions
                SET form_version_id = NULL, submitted_snapshot_json = '{}'
              WHERE id = 'eval-test-submission' AND event_id = ?`,
        )
          .bind(admin.eventId)
          .run();

        await expect(
          new EvaluationService(evaluationEnvironment()).getAdminWorkspace(
            admin,
          ),
        ).rejects.toThrow(/missing its immutable routing snapshot/i);
      } finally {
        await resetEvaluationFixture();
      }
    });

    it("replays an assistant assignment command for the authenticated administrator", async () => {
      await resetEvaluationFixture();
      const service = new EvaluationService(
        env as unknown as CloudflareEnvironment,
      );
      await service.savePlan(admin, {
        revision: 0,
        name: "Assistant assignment plan",
        status: "active",
        rounds: [
          {
            id: "eval-assistant-assignment-round",
            name: "Assistant assignment round",
            anonymous: false,
            criteria,
          },
        ],
      });
      await addRoundReviewer("eval-assistant-assignment-round");
      const input = {
        roundId: "eval-assistant-assignment-round",
        targetType: "submission" as const,
        targetIds: ["eval-test-submission"],
        evaluatorPersonIds: [evaluator.personId],
      };
      const command = {
        actorId: `assistant:${admin.personId}`,
        idempotencyKey: `assistant:${crypto.randomUUID()}`,
        requestHash: "a".repeat(64),
      };
      const assigned = await service.assign(admin, input, command);
      await expect(service.assign(admin, input, command)).resolves.toEqual(
        assigned,
      );
      expect(assigned).toMatchObject({
        createdAssignmentCount: 1,
        requestedAssignmentCount: 1,
        undoOperationId: expect.any(String),
      });
    });

    it("undoes only a fresh untouched assignment operation", async () => {
      await resetEvaluationFixture();
      const service = new EvaluationService(
        env as unknown as CloudflareEnvironment,
      );
      await service.savePlan(admin, {
        revision: 0,
        name: "Undoable assignment plan",
        status: "active",
        rounds: [
          {
            id: "eval-undo-round",
            name: "Initial review",
            anonymous: false,
            criteria,
          },
        ],
      });
      await addRoundReviewer("eval-undo-round");
      const assigned = await service.assign(admin, {
        roundId: "eval-undo-round",
        targetType: "submission",
        targetIds: ["eval-test-submission"],
        evaluatorPersonIds: [evaluator.personId],
      });
      expect(assigned.undoOperationId).toEqual(expect.any(String));

      await expect(
        service.undoAssignments(admin, {
          operationId: assigned.undoOperationId,
          confirmed: true,
        }),
      ).resolves.toEqual({ undoneAssignmentCount: 1 });
      expect(
        await env.DB.prepare(
          `SELECT status,
                  (SELECT COUNT(*) FROM evaluator_assignments
                    WHERE event_id = submissions.event_id
                      AND submission_id = submissions.id) AS assignmentCount
             FROM submissions WHERE id = 'eval-test-submission' AND event_id = ?`,
        )
          .bind(admin.eventId)
          .first(),
      ).toEqual({ status: "submitted", assignmentCount: 0 });

      const reassigned = await service.assign(admin, {
        roundId: "eval-undo-round",
        targetType: "submission",
        targetIds: ["eval-test-submission"],
        evaluatorPersonIds: [evaluator.personId],
      });
      const reviewerWorkspace = await service.getReviewerWorkspace(evaluator);
      await service.saveReview(evaluator, {
        assignmentId: reviewerWorkspace.selected!.id,
        revision: 0,
        scores: {},
        recommendation: null,
        confidence: null,
        submitterFeedback: "",
        privateNotes: "Started reviewing.",
        intent: "save",
      });
      await expect(
        service.undoAssignments(admin, {
          operationId: reassigned.undoOperationId,
          confirmed: true,
        }),
      ).rejects.toThrow(/review work started/);
    });
  });
});
