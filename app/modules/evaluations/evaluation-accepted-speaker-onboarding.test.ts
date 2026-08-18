import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_EVENT_BRAND_ACCENT } from "~/lib/brand";
import type { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { processCommunicationSend } from "../../../workers/queue/communication-send";
import { EvaluationDecisionService } from "./evaluation-decision-service.server";
import {
  EvaluationRevisionConflictError,
  EvaluationService,
  EvaluationStateError,
} from "./evaluation-service.server";
import { ensureEvaluationDecisionTemplateFixture } from "./evaluation-test-fixtures";

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

function withSuppressedStatement(
  testEnv: CloudflareEnvironment,
  pattern: RegExp,
) {
  let suppressed = 0;
  const faultingDb = new Proxy(testEnv.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          if (!pattern.test(query)) return target.prepare(query);
          suppressed += 1;
          const noOp = target.prepare(
            "UPDATE submissions SET status = status WHERE 0",
          );
          return new Proxy(noOp, {
            get(statement, statementProperty) {
              if (statementProperty === "bind") return () => noOp;
              const value = Reflect.get(statement, statementProperty);
              return typeof value === "function"
                ? value.bind(statement)
                : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    env: new Proxy(testEnv, {
      get(target, property) {
        return property === "DB" ? faultingDb : Reflect.get(target, property);
      },
    }),
    suppressed: () => suppressed,
  };
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
    env.DB.prepare(
      `DELETE FROM communications
        WHERE event_id = ?
          AND json_extract(audience_json, '$.type') = 'decision'
          AND json_extract(audience_json, '$.submissionId') = 'eval-test-submission'`,
    ).bind(admin.eventId),
    env.DB.prepare(
      `DELETE FROM operation_jobs
        WHERE event_id = ? AND type = 'decision.notification'
          AND json_extract(payload_json, '$.payload.decisionId') NOT IN (
            SELECT id FROM submission_decisions WHERE event_id = ?
          )`,
    ).bind(admin.eventId, admin.eventId),
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
    await ensureEvaluationDecisionTemplateFixture(
      env.DB,
      admin.eventId,
      admin.personId,
    );
    await env.DB.batch([
      env.DB.prepare(
        `DELETE FROM task_instances
          WHERE event_id = ? AND owner_person_id = 'person-sbek-speaker'`,
      ).bind(admin.eventId),
      env.DB.prepare(
        `DELETE FROM memberships
          WHERE event_id = ? AND person_id = 'person-sbek-speaker'
            AND role = 'speaker'`,
      ).bind(admin.eventId),
      env.DB.prepare(
        `UPDATE submission_speakers
            SET person_id = 'person-demo-submitter',
                email = 'alex.submitter@example.com',
                display_name = 'Alex Morgan'
          WHERE event_id = ? AND submission_id = 'eval-test-submission'`,
      ).bind(admin.eventId),
      env.DB.prepare(
        `UPDATE people SET email = 'alex.submitter@example.com'
          WHERE id = 'person-demo-submitter'`,
      ),
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

  describe("decision and accepted-speaker workflows", () => {
    it("rejects accepted-session release when submitted track identity is missing", async () => {
      await resetEvaluationFixture();
      await env.DB.prepare(
        `DELETE FROM submission_track_selections
          WHERE submission_id = 'eval-test-submission' AND event_id = ?`,
      )
        .bind(admin.eventId)
        .run();

      await expect(
        new EvaluationService(evaluationEnvironment()).decide(admin, {
          submissionId: "eval-test-submission",
          decision: "accepted",
          sessionTrackId: "demo-track-operations",
          sessionFormatKey: "presentation",
          rationale: "A trackless acceptance must not be released.",
          release: true,
          confirmedWithoutReview: true,
          sessionDurationMinutes: 60,
        }),
      ).rejects.toThrow(/choose one of the tracks submitted/i);
      await expect(
        env.DB.prepare(
          `SELECT status,
                  (SELECT COUNT(*) FROM submission_decisions
                    WHERE submission_id = submissions.id) AS decisionCount,
                  (SELECT COUNT(*) FROM sessions
                    WHERE source_submission_id = submissions.id) AS sessionCount
             FROM submissions WHERE id = 'eval-test-submission' AND event_id = ?`,
        )
          .bind(admin.eventId)
          .first(),
      ).resolves.toEqual({
        status: "submitted",
        decisionCount: 0,
        sessionCount: 0,
      });
    });

    it("uses the explicitly confirmed track for a multi-track acceptance", async () => {
      await resetEvaluationFixture();
      try {
        await env.DB.batch([
          env.DB.prepare(
            `INSERT INTO submission_track_selections (
                 submission_id, event_id, track_id, track_name_snapshot, position
               ) VALUES ('eval-test-submission', ?, 'demo-track-ai', 'AI & Innovation', 1)`,
          ).bind(admin.eventId),
          env.DB.prepare(
            `UPDATE tracks SET name = 'AI Programme'
                WHERE id = 'demo-track-ai' AND event_id = ?`,
          ).bind(admin.eventId),
        ]);

        const service = new EvaluationService(evaluationEnvironment());
        await expect(
          service
            .getAdminWorkspace(admin)
            .then((workspace) =>
              workspace.submissions
                .find((submission) => submission.id === "eval-test-submission")
                ?.tracks.find((track) => track.id === "demo-track-ai"),
            ),
        ).resolves.toMatchObject({
          name: "AI Programme",
          submittedName: "AI & Innovation",
        });

        const result = await service.decide(admin, {
          submissionId: "eval-test-submission",
          decision: "accepted",
          sessionTrackId: "demo-track-ai",
          sessionFormatKey: "presentation",
          rationale: "The programme track is an explicit acceptance choice.",
          release: true,
          confirmedWithoutReview: true,
          sessionDurationMinutes: 60,
        });
        const accepted = await env.DB.prepare(
          `SELECT session.track_id AS trackId,
                    decision.effect_preview_json AS effectPreviewJson
               FROM sessions session
               JOIN submission_decisions decision
                 ON decision.id = ? AND decision.event_id = session.event_id
              WHERE session.id = ? AND session.event_id = ?`,
        )
          .bind(result.decisionId, result.sessionId, admin.eventId)
          .first<{ trackId: string; effectPreviewJson: string }>();

        expect(accepted?.trackId).toBe("demo-track-ai");
        expect(JSON.parse(accepted!.effectPreviewJson)).toMatchObject({
          sessionTrackId: "demo-track-ai",
          sessionTrackName: "AI Programme",
        });
      } finally {
        await env.DB.prepare(
          `UPDATE tracks SET name = 'AI & Innovation'
              WHERE id = 'demo-track-ai' AND event_id = ?`,
        )
          .bind(admin.eventId)
          .run();
      }
    });

    it("fails acceptance when the confirmed programme track is renamed before commit", async () => {
      await resetEvaluationFixture();
      const originalTrack = await env.DB.prepare(
        `SELECT name FROM tracks
            WHERE id = 'demo-track-operations' AND event_id = ?`,
      )
        .bind(admin.eventId)
        .first<{ name: string }>();
      expect(originalTrack).not.toBeNull();
      try {
        const racingEnvironment = withBatchRace(
          evaluationEnvironment(),
          async () => {
            await env.DB.prepare(
              `UPDATE tracks SET name = 'Renamed during acceptance'
                  WHERE id = 'demo-track-operations' AND event_id = ?`,
            )
              .bind(admin.eventId)
              .run();
          },
        );
        await expect(
          new EvaluationService(racingEnvironment).decide(admin, {
            submissionId: "eval-test-submission",
            decision: "accepted",
            sessionTrackId: "demo-track-operations",
            sessionFormatKey: "presentation",
            rationale: "This preview must not commit with a stale track name.",
            release: true,
            confirmedWithoutReview: true,
            sessionDurationMinutes: 60,
          }),
        ).rejects.toThrow(/renamed after the decision preview/i);
        await expect(
          env.DB.prepare(
            `SELECT status,
                      (SELECT COUNT(*) FROM submission_decisions
                        WHERE submission_id = submissions.id) AS decisionCount,
                      (SELECT COUNT(*) FROM sessions
                        WHERE source_submission_id = submissions.id) AS sessionCount
                 FROM submissions
                WHERE id = 'eval-test-submission' AND event_id = ?`,
          )
            .bind(admin.eventId)
            .first(),
        ).resolves.toEqual({
          status: "submitted",
          decisionCount: 0,
          sessionCount: 0,
        });
      } finally {
        await env.DB.prepare(
          `UPDATE tracks SET name = ?
              WHERE id = 'demo-track-operations' AND event_id = ?`,
        )
          .bind(originalTrack!.name, admin.eventId)
          .run();
      }
    });

    it("publishes an accepted decision atomically and records honest notification state", async () => {
      await resetEvaluationFixture();
      const service = new EvaluationService(evaluationEnvironment());
      await env.DB.prepare(
        `DELETE FROM memberships
          WHERE event_id = ? AND person_id = 'person-demo-submitter'
            AND role = 'speaker'`,
      )
        .bind(admin.eventId)
        .run();
      await env.DB.prepare(
        `UPDATE submissions SET title = 'Changed live title', format = 'Changed live format'
          WHERE id = 'eval-test-submission' AND event_id = ?`,
      )
        .bind(admin.eventId)
        .run();
      await expect(
        service.decide(admin, {
          submissionId: "eval-test-submission",
          decision: "accepted",
          sessionTrackId: "demo-track-operations",
          sessionFormatKey: "presentation",
          rationale: "Strong programme fit.",
          release: true,
        }),
      ).rejects.toThrow(/confirm the review-evidence override/i);
      const result = await service.decide(admin, {
        submissionId: "eval-test-submission",
        decision: "accepted",
        sessionTrackId: "demo-track-operations",
        sessionFormatKey: "presentation",
        rationale: "Strong programme fit.",
        release: true,
        confirmedWithoutReview: true,
        sessionDurationMinutes: 60,
      });
      expect(result.sessionId).toBeTruthy();
      expect(result.notificationStatus).toBe("queued");
      await expect(
        env.DB.prepare(
          `SELECT decision.notification_operation_id AS linkedOperationId,
                  operation.status AS operationStatus,
                  communication.id AS communicationId,
                  communication.status AS communicationStatus,
                  delivery.id AS deliveryId,
                  delivery.status AS deliveryStatus,
                  delivery.recipient_address AS recipientAddress,
                  delivery.rendered_subject AS renderedSubject,
                  delivery.rendered_body_sha256 AS renderedBodySha256,
                  json_extract(operation.payload_json, '$.communicationId') AS payloadCommunicationId
             FROM submission_decisions decision
             JOIN operation_jobs operation
               ON operation.id = decision.notification_operation_id
             JOIN communications communication
               ON communication.operation_id = operation.id
             JOIN communication_deliveries delivery
               ON delivery.communication_id = communication.id
            WHERE decision.id = ? AND decision.event_id = ?`,
        )
          .bind(result.decisionId, admin.eventId)
          .first(),
      ).resolves.toMatchObject({
        linkedOperationId: result.notificationOperationId,
        operationStatus: "queued",
        communicationId: expect.any(String),
        communicationStatus: "queued",
        deliveryId: expect.any(String),
        deliveryStatus: "queued",
        recipientAddress: "alex.submitter@example.com",
        renderedSubject: expect.any(String),
        renderedBodySha256: expect.stringMatching(/^[a-f0-9]{64}$/u),
        payloadCommunicationId: expect.any(String),
      });
      expect(result.speakerInvitationStatus).toBe("demo_not_sent");
      expect(result.speakerInvitationCount).toBe(1);
      const [submission, session, audit, speakerMembership] = await Promise.all(
        [
          env.DB.prepare(
            "SELECT status FROM submissions WHERE id = 'eval-test-submission'",
          ).first<{ status: string }>(),
          env.DB.prepare(
            "SELECT source_submission_id AS sourceSubmissionId, track_id AS trackId, title, format, duration_minutes AS durationMinutes, status, description FROM sessions WHERE id = ?",
          )
            .bind(result.sessionId)
            .first<{
              sourceSubmissionId: string;
              trackId: string;
              title: string;
              format: string;
              durationMinutes: number;
              status: string;
              description: string;
            }>(),
          env.DB.prepare("SELECT action FROM audit_events WHERE entity_id = ?")
            .bind(result.decisionId)
            .first<{ action: string }>(),
          env.DB.prepare(
            `SELECT membership.id, membership.accepted_at AS acceptedAt,
                  membership.revoked_at AS revokedAt,
                  membership.invitation_expires_at AS expiresAt,
                  (SELECT COUNT(*) FROM audit_events audit
                    WHERE audit.entity_id = membership.id
                      AND audit.action = 'membership.speaker.invited') AS auditCount
             FROM memberships membership
            WHERE membership.event_id = ?
              AND membership.person_id = 'person-demo-submitter'
              AND membership.role = 'speaker'`,
          )
            .bind(admin.eventId)
            .first<{
              id: string;
              acceptedAt: number | null;
              revokedAt: number | null;
              expiresAt: number;
              auditCount: number;
            }>(),
        ],
      );
      expect(submission?.status).toBe("accepted");
      expect(session).toEqual({
        sourceSubmissionId: "eval-test-submission",
        trackId: "demo-track-operations",
        title: "A practical event proposal",
        format: "presentation",
        durationMinutes: 60,
        status: "unscheduled",
        description: "A practical description for the public programme.",
      });
      expect(audit?.action).toBe("decision.published");
      expect(speakerMembership).toMatchObject({
        id: expect.any(String),
        acceptedAt: null,
        revokedAt: null,
        auditCount: 1,
      });
      expect(speakerMembership!.expiresAt).toBeGreaterThan(
        Math.floor(Date.now() / 1_000),
      );

      await expect(
        service.decide(admin, {
          submissionId: "eval-test-submission",
          decision: "rejected",
          rationale: "A late reversal must use an explicit reopen workflow.",
          release: true,
        }),
      ).rejects.toThrow(/reopen an eligible released outcome/i);
      await expect(
        service.decide(admin, {
          submissionId: "eval-test-submission",
          decision: "waitlisted",
          rationale: "A draft cannot replace a released decision either.",
          release: false,
        }),
      ).rejects.toThrow(/reopen an eligible released outcome/i);
      const finalState = await env.DB.prepare(
        `
        SELECT s.status,
               (SELECT COUNT(*) FROM submission_decisions d WHERE d.submission_id = s.id) AS decisionCount,
               (SELECT COUNT(*) FROM sessions candidate WHERE candidate.source_submission_id = s.id) AS sessionCount
          FROM submissions s WHERE s.id = 'eval-test-submission'
      `,
      ).first<{
        status: string;
        decisionCount: number;
        sessionCount: number;
      }>();
      expect(finalState).toEqual({
        status: "accepted",
        decisionCount: 1,
        sessionCount: 1,
      });
    });

    it("activates the exact SBEK speaker after an accepted decision", async () => {
      await resetEvaluationFixture();
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE submission_speakers
              SET person_id = 'person-sbek-speaker',
                  email = 'sbek-speaker@example.com',
                  display_name = 'Priya Raman'
            WHERE event_id = ? AND submission_id = 'eval-test-submission'`,
        ).bind(admin.eventId),
        env.DB.prepare(
          `DELETE FROM memberships
            WHERE event_id = ? AND person_id = 'person-sbek-speaker'
              AND role = 'speaker'`,
        ).bind(admin.eventId),
      ]);
      const service = new EvaluationService(evaluationEnvironment());

      const result = await service.decide(admin, {
        submissionId: "eval-test-submission",
        decision: "accepted",
        sessionTrackId: "demo-track-operations",
        sessionFormatKey: "presentation",
        rationale: "Strong programme fit.",
        release: true,
        confirmedWithoutReview: true,
      });

      expect(result.speakerInvitationStatus).toBe("demo_not_sent");
      expect(result.speakerInvitationCount).toBe(1);
      await expect(
        env.DB.prepare(
          `SELECT accepted_at IS NOT NULL AS accepted,
                  invitation_expires_at AS expiresAt,
                  (SELECT COUNT(*) FROM audit_events audit
                    WHERE audit.entity_id = membership.id
                      AND audit.action = 'membership.demo_fixture_activated') AS activationAuditCount
             FROM memberships membership
            WHERE event_id = ? AND person_id = 'person-sbek-speaker'
              AND role = 'speaker'`,
        )
          .bind(admin.eventId)
          .first(),
      ).resolves.toEqual({
        accepted: 1,
        expiresAt: null,
        activationAuditCount: 1,
      });

      await env.DB.prepare(
        `UPDATE memberships
            SET accepted_at = NULL, invitation_expires_at = unixepoch() - 1
          WHERE event_id = ? AND person_id = 'person-sbek-speaker'
            AND role = 'speaker'`,
      )
        .bind(admin.eventId)
        .run();
      const recovered = await new EvaluationDecisionService(
        evaluationEnvironment(),
      ).decide(
        admin,
        {
          submissionId: "eval-test-submission",
          decision: "accepted",
          sessionTrackId: "demo-track-operations",
          sessionFormatKey: "presentation",
          rationale: "Strong programme fit.",
          release: true,
          confirmedWithoutReview: true,
        },
        result.decisionId,
      );
      expect(recovered.speakerInvitationStatus).toBe("demo_activation_failed");
    });

    it("snapshots selected applicant-facing reviewer feedback for the decision email", async () => {
      await resetEvaluationFixture();
      const token = crypto.randomUUID();
      const planId = `feedback-plan-${token}`;
      const roundId = `feedback-round-${token}`;
      const assignmentId = `feedback-assignment-${token}`;
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO evaluation_plans (id, event_id, name, status)
           VALUES (?, ?, 'Decision feedback plan', 'active')`,
        ).bind(planId, admin.eventId),
        env.DB.prepare(
          `INSERT INTO evaluation_rounds (
             id, event_id, plan_id, round_number, name, status, scorecard_id
           ) VALUES (?, ?, ?, 1, 'Completed review round', 'active', ?)`,
        ).bind(roundId, admin.eventId, planId, roundId),
        env.DB.prepare(
          `INSERT INTO evaluator_assignments (
             id, event_id, round_id, submission_id, evaluator_person_id,
             status, assigned_at, submitted_at
           ) VALUES (?, ?, ?, 'eval-test-submission', 'person-demo-evaluator',
                     'submitted', unixepoch(), unixepoch())`,
        ).bind(assignmentId, admin.eventId, roundId),
        env.DB.prepare(
          `INSERT INTO reviews (
             id, event_id, assignment_id, status, scores_json,
             recommendation, confidence, submitter_feedback, submitted_at
           ) VALUES (?, ?, ?, 'submitted', '{}', 'minor_changes', 4, ?, unixepoch())`,
        ).bind(
          `feedback-review-${token}`,
          admin.eventId,
          assignmentId,
          "Clarify the intended experience level in the final description.",
        ),
      ]);
      const result = await new EvaluationService(
        evaluationEnvironment(),
      ).decide(admin, {
        submissionId: "eval-test-submission",
        decision: "rejected",
        rationale: "The programme is already full in this area.",
        includeReviewerFeedback: true,
        release: true,
      });
      await expect(
        env.DB.prepare(
          `SELECT rationale,
                  notification_feedback_json AS notificationFeedbackJson
             FROM submission_decisions WHERE id = ? AND event_id = ?`,
        )
          .bind(result.decisionId, admin.eventId)
          .first(),
      ).resolves.toEqual({
        rationale: "The programme is already full in this area.",
        notificationFeedbackJson: JSON.stringify([
          "Clarify the intended experience level in the final description.",
        ]),
      });
    });

    it("rejects selected reviewer feedback that changes at the release boundary", async () => {
      await resetEvaluationFixture();
      const token = crypto.randomUUID();
      const planId = `feedback-race-plan-${token}`;
      const roundId = `feedback-race-round-${token}`;
      const firstAssignmentId = `feedback-race-assignment-a-${token}`;
      const secondAssignmentId = `feedback-race-assignment-b-${token}`;
      const firstReviewId = `feedback-race-review-a-${token}`;
      const secondReviewId = `feedback-race-review-b-${token}`;
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO evaluation_plans (id, event_id, name, status)
           VALUES (?, ?, 'Decision feedback race plan', 'active')`,
        ).bind(planId, admin.eventId),
        env.DB.prepare(
          `INSERT INTO evaluation_rounds (
             id, event_id, plan_id, round_number, name, status, scorecard_id
           ) VALUES (?, ?, ?, 1, 'Feedback race round', 'active', ?)`,
        ).bind(roundId, admin.eventId, planId, roundId),
        ...[
          [firstAssignmentId, firstReviewId, "First applicant-facing note."],
          [secondAssignmentId, secondReviewId, "Second applicant-facing note."],
        ].flatMap(([assignmentId, reviewId, feedback], index) => [
          env.DB.prepare(
            `INSERT INTO evaluator_assignments (
               id, event_id, round_id, submission_id, evaluator_person_id,
               status, assigned_at, submitted_at
             ) VALUES (?, ?, ?, 'eval-test-submission', ?, 'submitted', ?, unixepoch())`,
          ).bind(
            assignmentId,
            admin.eventId,
            roundId,
            index === 0 ? "person-demo-evaluator" : "person-demo-admin",
            1_700_000_000 + index,
          ),
          env.DB.prepare(
            `INSERT INTO reviews (
               id, event_id, assignment_id, status, scores_json,
               recommendation, confidence, submitter_feedback, submitted_at
             ) VALUES (?, ?, ?, 'submitted', '{}', 'minor_changes', 4, ?, unixepoch())`,
          ).bind(reviewId, admin.eventId, assignmentId, feedback),
        ]),
      ]);
      const racedEnvironment = withBatchRace(
        evaluationEnvironment(),
        async () => {
          await env.DB.prepare(
            `UPDATE reviews
                SET status = 'reopened', revision = revision + 1,
                    submitter_feedback = 'Withdrawn feedback',
                    updated_at = unixepoch()
              WHERE id = ? AND event_id = ?`,
          )
            .bind(firstReviewId, admin.eventId)
            .run();
        },
      );
      await expect(
        new EvaluationDecisionService(racedEnvironment).decide(admin, {
          submissionId: "eval-test-submission",
          decision: "rejected",
          rationale: "The programme is already full in this area.",
          includeReviewerFeedback: true,
          release: true,
        }),
      ).rejects.toThrow(/changed before the decision was saved/i);
      await expect(
        env.DB.prepare(
          `SELECT COUNT(*) AS total FROM submission_decisions
            WHERE event_id = ? AND submission_id = 'eval-test-submission'
              AND status = 'published'`,
        )
          .bind(admin.eventId)
          .first(),
      ).resolves.toEqual({ total: 0 });
    });

    it("rolls back release when a notification graph write is suppressed", async () => {
      await resetEvaluationFixture();
      const fault = withSuppressedStatement(
        evaluationEnvironment(),
        /INSERT INTO operation_items/u,
      );
      await expect(
        new EvaluationDecisionService(fault.env).decide(admin, {
          submissionId: "eval-test-submission",
          decision: "rejected",
          rationale: "The programme is already full in this area.",
          release: true,
          confirmedWithoutReview: true,
        }),
      ).rejects.toThrow(
        /published decision requires a complete durable notification graph/i,
      );
      expect(fault.suppressed()).toBe(1);
      await expect(
        env.DB.prepare(
          `SELECT submission.status,
                  (SELECT COUNT(*) FROM submission_decisions decision
                    WHERE decision.event_id = submission.event_id
                      AND decision.submission_id = submission.id) AS decisions,
                  (SELECT COUNT(*) FROM operation_jobs operation
                    WHERE operation.event_id = submission.event_id
                      AND operation.type = 'decision.notification') AS operations
             FROM submissions submission
            WHERE submission.id = 'eval-test-submission' AND submission.event_id = ?`,
        )
          .bind(admin.eventId)
          .first(),
      ).resolves.toEqual({
        status: "submitted",
        decisions: 0,
        operations: 0,
      });
    });

    it("persists accepted-speaker sign-in intent before Queue delivery and recovers it exactly", async () => {
      await resetEvaluationFixture();
      const deliveryEmail = "alex.submitter@programcue.dev";
      await env.DB.prepare(
        `UPDATE people SET email = ? WHERE id = 'person-demo-submitter'`,
      )
        .bind(deliveryEmail)
        .run();
      await env.DB.prepare(
        `DELETE FROM memberships
          WHERE event_id = ? AND person_id = 'person-demo-submitter'
            AND role = 'speaker'`,
      )
        .bind(admin.eventId)
        .run();
      await env.DB.prepare(
        `INSERT INTO sender_profiles (
           id, event_id, name, from_name, from_email, provider, status,
           created_at, updated_at
         ) VALUES (?, ?, 'Accepted speaker invitations', 'Program Cue',
                   'speakers@example.com', 'resend', 'verified',
                   unixepoch(), unixepoch())`,
      )
        .bind(`accepted-speaker-sender-${crypto.randomUUID()}`, admin.eventId)
        .run();
      const queued: unknown[] = [];
      const productionLike = {
        ...(env as unknown as CloudflareEnvironment),
        DEMO_MODE: "false",
        APP_ENV: "production",
        BETTER_AUTH_URL: "https://programcue.test",
        OPERATIONS_QUEUE: {
          send: async (message: unknown) => {
            queued.push(message);
          },
        },
      } as unknown as CloudflareEnvironment;
      const commandId = `accepted-invitation-${crypto.randomUUID()}`;
      const input = {
        submissionId: "eval-test-submission",
        decision: "accepted" as const,
        sessionTrackId: "demo-track-operations",
        sessionFormatKey: "presentation",
        rationale: "Strong programme fit.",
        release: true,
        confirmedWithoutReview: true,
        sessionDurationMinutes: 60,
      };
      const service = new EvaluationDecisionService(productionLike);
      const result = await service.decide(admin, input, commandId);
      expect(result.speakerInvitationStatus).toBe("queued");
      expect(result.speakerInvitationCount).toBe(1);
      expect(queued).toEqual([
        expect.objectContaining({ type: "decision.notification" }),
        expect.objectContaining({ type: "communication.send" }),
      ]);
      const intent = await env.DB.prepare(
        `SELECT operation.status, communication.content_snapshot_json AS snapshot,
                delivery.source_id AS membershipId,
                verification.identifier, verification.value
           FROM communications communication
           JOIN operation_jobs operation ON operation.id = communication.operation_id
           JOIN communication_deliveries delivery
             ON delivery.communication_id = communication.id
           JOIN verification_tokens verification
             ON verification.id LIKE 'asi-v:%'
          WHERE communication.event_id = ?
            AND json_extract(communication.audience_json, '$.decisionId') = ?
          ORDER BY verification.created_at DESC LIMIT 1`,
      )
        .bind(admin.eventId, commandId)
        .first<{
          status: string;
          snapshot: string;
          membershipId: string;
          identifier: string;
          value: string;
        }>();
      expect(intent).not.toBeNull();
      expect(intent?.status).toBe("queued");
      expect(intent?.membershipId).toBeTruthy();
      const invitationSnapshot = JSON.parse(intent!.snapshot) as {
        content: { buttonUrl: string };
      };
      expect(invitationSnapshot).toMatchObject({
        category: "accepted_speaker_invitation",
        event: { brandAccent: DEFAULT_EVENT_BRAND_ACCENT },
      });
      const invitationUrl = new URL(invitationSnapshot.content.buttonUrl);
      const callbackUrl = new URL(
        invitationUrl.searchParams.get("callbackURL")!,
        "https://programcue.test",
      );
      expect(callbackUrl.pathname).toBe("/events/select");
      expect(callbackUrl.searchParams.get("eventId")).toBe(admin.eventId);
      expect(callbackUrl.searchParams.get("returnTo")).toBe(
        "/participant/dashboard",
      );
      expect(intent?.identifier).not.toContain("person-demo-submitter");
      expect(JSON.parse(intent!.value)).toEqual({
        email: deliveryEmail,
      });

      const replay = await service.decide(admin, input, commandId);
      expect(replay.speakerInvitationStatus).toBe("queued");
      expect(replay.speakerInvitationCount).toBe(1);
      expect(queued).toHaveLength(2);

      await env.DB.prepare(
        `UPDATE memberships SET revoked_at = unixepoch()
          WHERE id = ? AND event_id = ?`,
      )
        .bind(intent!.membershipId, admin.eventId)
        .run();
      let providerCalls = 0;
      await processCommunicationSend(queued[1], productionLike, {
        email: {
          name: "resend",
          async send() {
            providerCalls += 1;
            return { provider: "resend", messageId: "should-not-send" };
          },
        },
      });
      expect(providerCalls).toBe(0);
      await expect(
        env.DB.prepare(
          `SELECT status, failure_code AS failureCode
             FROM communication_deliveries
            WHERE communication_id = (
              SELECT id FROM communications
               WHERE event_id = ?
                 AND json_extract(audience_json, '$.decisionId') = ?
            )`,
        )
          .bind(admin.eventId, commandId)
          .first(),
      ).resolves.toEqual({
        status: "suppressed",
        failureCode: "invitation_unavailable",
      });
    });

    it("rotates and durably requeues an expired accepted-speaker invitation", async () => {
      await resetEvaluationFixture();
      await env.DB.prepare(
        `UPDATE people SET email = 'alex.submitter@programcue.dev'
          WHERE id = 'person-demo-submitter'`,
      ).run();
      await env.DB.prepare(
        `DELETE FROM memberships
          WHERE event_id = ? AND person_id = 'person-demo-submitter'
            AND role = 'speaker'`,
      )
        .bind(admin.eventId)
        .run();
      await env.DB.prepare(
        `INSERT INTO sender_profiles (
           id, event_id, name, from_name, from_email, provider, status,
           created_at, updated_at
         ) VALUES (?, ?, 'Accepted speaker resend', 'Program Cue',
                   'speakers@example.com', 'resend', 'verified',
                   unixepoch(), unixepoch())`,
      )
        .bind(`accepted-speaker-resend-${crypto.randomUUID()}`, admin.eventId)
        .run();
      const queued: unknown[] = [];
      const productionLike = {
        ...(env as unknown as CloudflareEnvironment),
        DEMO_MODE: "false",
        APP_ENV: "production",
        BETTER_AUTH_URL: "https://programcue.test",
        OPERATIONS_QUEUE: {
          send: async (message: unknown) => {
            queued.push(message);
          },
        },
      } as unknown as CloudflareEnvironment;
      const commandId = `accepted-resend-${crypto.randomUUID()}`;
      const released = await new EvaluationDecisionService(
        productionLike,
      ).decide(
        admin,
        {
          submissionId: "eval-test-submission",
          decision: "accepted",
          sessionTrackId: "demo-track-operations",
          sessionFormatKey: "presentation",
          rationale: "Strong programme fit.",
          release: true,
          confirmedWithoutReview: true,
          sessionDurationMinutes: 60,
        },
        commandId,
      );
      expect(released.sessionId).toBeTruthy();
      expect(queued).toHaveLength(2);
      const original = await env.DB.prepare(
        `SELECT membership.id AS membershipId,
                membership.invitation_expires_at AS expiresAt,
                communication.id AS communicationId,
                communication.content_snapshot_json AS snapshotJson
           FROM memberships membership
           JOIN communications communication
             ON communication.event_id = membership.event_id
            AND json_extract(communication.audience_json, '$.decisionId') = ?
            AND json_extract(communication.audience_json, '$.membershipId') = membership.id
          WHERE membership.event_id = ? AND membership.person_id = 'person-demo-submitter'
            AND membership.role = 'speaker'`,
      )
        .bind(commandId, admin.eventId)
        .first<{
          membershipId: string;
          expiresAt: number;
          communicationId: string;
          snapshotJson: string;
        }>();
      expect(original).not.toBeNull();
      const originalIdentifier = await invitationTokenIdentifier(
        original!.snapshotJson,
      );
      const expiredAt = Math.floor(Date.now() / 1_000) - 60;
      await env.DB.prepare(
        `UPDATE memberships SET invitation_expires_at = ?
          WHERE id = ? AND event_id = ?`,
      )
        .bind(expiredAt, original!.membershipId, admin.eventId)
        .run();

      await expect(
        new EvaluationService({
          ...productionLike,
          OPERATIONS_QUEUE: undefined,
        } as unknown as CloudflareEnvironment).resendAcceptedSpeakerInvitation(
          admin,
          {
            decisionId: commandId,
            membershipId: original!.membershipId,
            expectedExpiresAt: expiredAt,
          },
        ),
      ).rejects.toThrow("Required OPERATIONS_QUEUE binding is unavailable");
      await expect(
        env.DB.prepare(
          `SELECT invitation_expires_at AS expiresAt
             FROM memberships WHERE id = ? AND event_id = ?`,
        )
          .bind(original!.membershipId, admin.eventId)
          .first(),
      ).resolves.toEqual({ expiresAt: expiredAt });

      const result = await new EvaluationService(
        productionLike,
      ).resendAcceptedSpeakerInvitation(admin, {
        decisionId: commandId,
        membershipId: original!.membershipId,
        expectedExpiresAt: expiredAt,
      });
      expect(result).toMatchObject({
        status: "queued",
        replayed: false,
        operationId: expect.stringMatching(/^asi-ro:/u),
      });
      expect(result.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1_000));
      expect(queued).toHaveLength(3);
      expect(queued[2]).toMatchObject({
        type: "communication.send",
        operationId: result.operationId,
        communicationId: result.communicationId,
      });

      const renewed = await env.DB.prepare(
        `SELECT membership.invitation_expires_at AS expiresAt,
                membership.last_operation_id AS operationId,
                previous_communication.status AS previousCommunicationStatus,
                previous_delivery.status AS previousDeliveryStatus,
                previous_operation.status AS previousOperationStatus,
                renewal_audit.action AS auditAction
           FROM memberships membership
           JOIN communications previous_communication
             ON previous_communication.id = ?
            AND previous_communication.event_id = membership.event_id
           JOIN communication_deliveries previous_delivery
             ON previous_delivery.communication_id = previous_communication.id
           JOIN operation_jobs previous_operation
             ON previous_operation.id = previous_communication.operation_id
           JOIN audit_events renewal_audit
             ON renewal_audit.correlation_id = membership.last_operation_id
            AND renewal_audit.action = 'membership.speaker.invitation.renewed'
          WHERE membership.id = ? AND membership.event_id = ?`,
      )
        .bind(original!.communicationId, original!.membershipId, admin.eventId)
        .first<{
          expiresAt: number;
          operationId: string;
          previousCommunicationStatus: string;
          previousDeliveryStatus: string;
          previousOperationStatus: string;
          auditAction: string;
        }>();
      expect(renewed).toMatchObject({
        expiresAt: result.expiresAt,
        operationId: result.operationId,
        previousCommunicationStatus: "cancelled",
        previousDeliveryStatus: "cancelled",
        previousOperationStatus: "cancelled",
        auditAction: "membership.speaker.invitation.renewed",
      });
      const replacement = await env.DB.prepare(
        `SELECT communication.content_snapshot_json AS snapshotJson
           FROM communications communication
          WHERE communication.id = ? AND communication.event_id = ?`,
      )
        .bind(result.communicationId, admin.eventId)
        .first<{ snapshotJson: string }>();
      const replacementIdentifier = await invitationTokenIdentifier(
        replacement!.snapshotJson,
      );
      expect(replacementIdentifier).not.toBe(originalIdentifier);
      await expect(
        env.DB.prepare(
          `SELECT COUNT(*) AS count FROM verification_tokens
            WHERE identifier = ? AND expires_at = ?`,
        )
          .bind(replacementIdentifier, result.expiresAt)
          .first(),
      ).resolves.toEqual({ count: 1 });

      const replay = await new EvaluationService(
        productionLike,
      ).resendAcceptedSpeakerInvitation(admin, {
        decisionId: commandId,
        membershipId: original!.membershipId,
        expectedExpiresAt: expiredAt,
      });
      expect(replay).toMatchObject({
        operationId: result.operationId,
        communicationId: result.communicationId,
        status: "queued",
        replayed: true,
      });
      expect(queued).toHaveLength(3);
    });

    it("requires the operations Queue before mutating a released decision", async () => {
      await resetEvaluationFixture();
      const unavailableEnvironment = {
        ...(env as unknown as CloudflareEnvironment),
        OPERATIONS_QUEUE: undefined,
      } as unknown as CloudflareEnvironment;

      await expect(
        new EvaluationService(unavailableEnvironment).decide(admin, {
          submissionId: "eval-test-submission",
          decision: "rejected",
          rationale: "A released decision requires notification dispatch.",
          release: true,
          confirmedWithoutReview: true,
        }),
      ).rejects.toThrow("Required OPERATIONS_QUEUE binding is unavailable");
      await expect(
        env.DB.prepare(
          `SELECT status,
                  (SELECT COUNT(*) FROM submission_decisions decision
                    WHERE decision.submission_id = submissions.id) AS decisionCount
             FROM submissions WHERE id = 'eval-test-submission'`,
        ).first(),
      ).resolves.toEqual({ status: "submitted", decisionCount: 0 });
    });

    it("atomically materialises the configured acceptance task graph for every supported scope", async () => {
      await resetEvaluationFixture();
      const token = crypto.randomUUID();
      const prerequisiteTemplateId = `acceptance-prerequisite-${token}`;
      const speakerTemplateId = `acceptance-speaker-${token}`;
      const sessionTemplateId = `acceptance-session-${token}`;
      const eventTemplateId = `acceptance-event-${token}`;
      const existingEventTaskId = `acceptance-event-task-${token}`;
      const fixedDueAt = Math.floor(Date.now() / 1_000) + 86_400;
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO task_templates (
             id,event_id,name,target_type,task_type,impact,evidence_mode,due_anchor,
             auto_assign_on_acceptance,status
           ) VALUES (?,?,'Acceptance prerequisite','speaker','checklist','high',
                     'checkbox','none',0,'active')`,
        ).bind(prerequisiteTemplateId, admin.eventId),
        env.DB.prepare(
          `INSERT INTO task_templates (
             id,event_id,name,target_type,task_type,impact,evidence_mode,due_anchor,
             auto_assign_on_acceptance,status
           ) VALUES (?,?,'Acceptance speaker task','speaker','checklist','high',
                     'checkbox','none',1,'active')`,
        ).bind(speakerTemplateId, admin.eventId),
        env.DB.prepare(
          `INSERT INTO task_template_dependencies (
             template_id,depends_on_template_id,created_at
           ) VALUES (?,?,unixepoch())`,
        ).bind(speakerTemplateId, prerequisiteTemplateId),
        env.DB.prepare(
          `INSERT INTO task_templates (
             id,event_id,name,target_type,task_type,impact,evidence_mode,due_anchor,
             due_offset_minutes,auto_assign_on_acceptance,status
           ) VALUES (?,?,'Acceptance session task','session','administrator_only',
                     'medium','none','acceptance',2880,1,'active')`,
        ).bind(sessionTemplateId, admin.eventId),
        env.DB.prepare(
          `INSERT INTO task_templates (
             id,event_id,name,target_type,task_type,impact,evidence_mode,due_anchor,
             fixed_due_at,auto_assign_on_acceptance,status
           ) VALUES (?,?,'Acceptance event task','event','administrator_only',
                     'low','none','fixed',?,1,'active')`,
        ).bind(eventTemplateId, admin.eventId, fixedDueAt),
        env.DB.prepare(
          `INSERT INTO task_instances (
             id,event_id,template_id,target_type,target_id,owner_person_id,title,
             task_type,impact,status,readiness_state,readiness_percent,revision,
             due_at,created_at,updated_at
           ) VALUES (?,?,?,'event',?,NULL,'Existing event task',
                     'administrator_only','low','completed','on_track',100,1,?,
                     unixepoch(),unixepoch())`,
        ).bind(
          existingEventTaskId,
          admin.eventId,
          eventTemplateId,
          admin.eventId,
          fixedDueAt,
        ),
      ]);

      const result = await new EvaluationService(
        evaluationEnvironment(),
      ).decide(admin, {
        submissionId: "eval-test-submission",
        decision: "accepted",
        sessionTrackId: "demo-track-operations",
        sessionFormatKey: "presentation",
        rationale: "Create the configured onboarding plan.",
        release: true,
        confirmedWithoutReview: true,
        sessionDurationMinutes: 60,
      });

      const tasks = await env.DB.prepare(
        `SELECT id,template_id AS templateId,target_type AS targetType,
                target_id AS targetId,owner_person_id AS ownerPersonId,status,
                last_operation_id AS lastOperationId,due_at AS dueAt
           FROM task_instances
          WHERE template_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
          ORDER BY template_id`,
      )
        .bind(
          JSON.stringify([
            prerequisiteTemplateId,
            speakerTemplateId,
            sessionTemplateId,
            eventTemplateId,
          ]),
        )
        .all<{
          id: string;
          templateId: string;
          targetType: string;
          targetId: string;
          ownerPersonId: string | null;
          status: string;
          lastOperationId: string | null;
          dueAt: number | null;
        }>();
      expect(tasks.results).toHaveLength(4);
      expect(
        tasks.results.find(
          (task) => task.templateId === prerequisiteTemplateId,
        ),
      ).toMatchObject({
        targetType: "speaker",
        targetId: "person-demo-submitter",
        ownerPersonId: "person-demo-submitter",
        status: "not_started",
        lastOperationId: result.decisionId,
      });
      expect(
        tasks.results.find((task) => task.templateId === speakerTemplateId),
      ).toMatchObject({
        targetType: "speaker",
        targetId: "person-demo-submitter",
        ownerPersonId: "person-demo-submitter",
        status: "blocked",
        lastOperationId: result.decisionId,
      });
      const sessionTask = tasks.results.find(
        (task) => task.templateId === sessionTemplateId,
      );
      expect(sessionTask).toMatchObject({
        targetType: "session",
        targetId: result.sessionId,
        ownerPersonId: null,
        status: "not_started",
        lastOperationId: result.decisionId,
      });
      expect(sessionTask!.dueAt).toBeGreaterThanOrEqual(
        Math.floor(Date.now() / 1_000) + 172_790,
      );
      expect(
        tasks.results.find((task) => task.templateId === eventTemplateId),
      ).toEqual({
        id: existingEventTaskId,
        templateId: eventTemplateId,
        targetType: "event",
        targetId: admin.eventId,
        ownerPersonId: null,
        status: "completed",
        lastOperationId: null,
        dueAt: fixedDueAt,
      });
      const dependency = await env.DB.prepare(
        `SELECT dependent.template_id AS templateId,
                prerequisite.template_id AS prerequisiteTemplateId
           FROM task_instance_dependencies edge
           JOIN task_instances dependent ON dependent.id = edge.task_id
           JOIN task_instances prerequisite ON prerequisite.id = edge.depends_on_task_id
          WHERE dependent.template_id = ?`,
      )
        .bind(speakerTemplateId)
        .first();
      expect(dependency).toEqual({
        templateId: speakerTemplateId,
        prerequisiteTemplateId,
      });
      expect(
        await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM audit_events
            WHERE action = 'task.assigned'
              AND json_extract(metadata_json,'$.decisionId') = ?`,
        )
          .bind(result.decisionId)
          .first(),
      ).toEqual({ count: 3 });
      await env.DB.prepare(
        `UPDATE task_templates SET auto_assign_on_acceptance = 0
          WHERE id IN (?,?,?,?)`,
      )
        .bind(
          prerequisiteTemplateId,
          speakerTemplateId,
          sessionTemplateId,
          eventTemplateId,
        )
        .run();
    });

    it("rolls back acceptance when its automatic task graph changes to an invalid state", async () => {
      await resetEvaluationFixture();
      const token = crypto.randomUUID();
      const prerequisiteTemplateId = `acceptance-race-prerequisite-${token}`;
      const templateId = `acceptance-race-task-${token}`;
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO task_templates (
             id,event_id,name,target_type,task_type,impact,evidence_mode,due_anchor,
             auto_assign_on_acceptance,status
           ) VALUES (?,?,'Race prerequisite','speaker','checklist','high',
                     'checkbox','none',0,'active')`,
        ).bind(prerequisiteTemplateId, admin.eventId),
        env.DB.prepare(
          `INSERT INTO task_templates (
             id,event_id,name,target_type,task_type,impact,evidence_mode,due_anchor,
             auto_assign_on_acceptance,status
           ) VALUES (?,?,'Race task','speaker','checklist','high',
                     'checkbox','none',1,'active')`,
        ).bind(templateId, admin.eventId),
        env.DB.prepare(
          `INSERT INTO task_template_dependencies (
             template_id,depends_on_template_id,created_at
           ) VALUES (?,?,unixepoch())`,
        ).bind(templateId, prerequisiteTemplateId),
      ]);
      const racingEnv = withBatchRace(evaluationEnvironment(), async () => {
        await env.DB.prepare(
          "UPDATE task_templates SET status = 'archived' WHERE id = ? AND event_id = ?",
        )
          .bind(prerequisiteTemplateId, admin.eventId)
          .run();
      });
      try {
        await expect(
          new EvaluationService(racingEnv).decide(admin, {
            submissionId: "eval-test-submission",
            decision: "accepted",
            sessionTrackId: "demo-track-operations",
            sessionFormatKey: "presentation",
            rationale: "This plan must be committed as one unit.",
            release: true,
            confirmedWithoutReview: true,
            sessionDurationMinutes: 60,
          }),
        ).rejects.toBeInstanceOf(EvaluationStateError);
        expect(
          await env.DB.prepare(
            `SELECT status,
                    (SELECT COUNT(*) FROM submission_decisions
                      WHERE submission_id = submissions.id) AS decisionCount,
                    (SELECT COUNT(*) FROM sessions
                      WHERE source_submission_id = submissions.id) AS sessionCount,
                    (SELECT COUNT(*) FROM task_instances
                      WHERE template_id IN (?,?)) AS taskCount
               FROM submissions WHERE id = 'eval-test-submission'`,
          )
            .bind(templateId, prerequisiteTemplateId)
            .first(),
        ).toEqual({
          status: "submitted",
          decisionCount: 0,
          sessionCount: 0,
          taskCount: 0,
        });
      } finally {
        await env.DB.prepare("DELETE FROM task_templates WHERE id IN (?,?)")
          .bind(templateId, prerequisiteTemplateId)
          .run();
      }
    });

    it("materialises an accepted session with its configured format default", async () => {
      await resetEvaluationFixture();
      const service = new EvaluationService(evaluationEnvironment());
      const event = await env.DB.prepare(
        "SELECT session_formats_json AS sessionFormatsJson FROM events WHERE id = ? AND organisation_id = ?",
      )
        .bind(admin.eventId, admin.organisationId)
        .first<{ sessionFormatsJson: string }>();
      expect(event).not.toBeNull();
      const configuredFormats = JSON.parse(event!.sessionFormatsJson) as Array<
        Record<string, unknown>
      >;
      configuredFormats.push({
        key: "round-table",
        label: "Round Table",
        defaultDurationMinutes: 75,
        position: configuredFormats.length,
      });
      try {
        await env.DB.batch([
          env.DB.prepare(
            "UPDATE events SET session_formats_json = ? WHERE id = ? AND organisation_id = ?",
          ).bind(
            JSON.stringify(configuredFormats),
            admin.eventId,
            admin.organisationId,
          ),
          env.DB.prepare(
            `UPDATE submissions
                SET format = 'Round Table', submitted_snapshot_json = ?
              WHERE id = 'eval-test-submission' AND event_id = ?`,
          ).bind(
            submittedSnapshot({
              format: "Round Table",
              description: "A configured round table.",
            }),
            admin.eventId,
          ),
        ]);

        const result = await service.decide(admin, {
          submissionId: "eval-test-submission",
          decision: "accepted",
          sessionTrackId: "demo-track-operations",
          sessionFormatKey: "round-table",
          rationale: "Strong programme fit.",
          release: true,
          confirmedWithoutReview: true,
        });
        await expect(
          env.DB.prepare(
            "SELECT format, duration_minutes AS durationMinutes FROM sessions WHERE id = ? AND event_id = ?",
          )
            .bind(result.sessionId, admin.eventId)
            .first(),
        ).resolves.toEqual({ format: "round-table", durationMinutes: 75 });
      } finally {
        await env.DB.prepare(
          "UPDATE events SET session_formats_json = ? WHERE id = ? AND organisation_id = ?",
        )
          .bind(event!.sessionFormatsJson, admin.eventId, admin.organisationId)
          .run();
      }
    });

    it("maps a legacy submitted format to an explicitly selected current format", async () => {
      await resetEvaluationFixture();
      const service = new EvaluationService(evaluationEnvironment());
      const event = await env.DB.prepare(
        "SELECT session_formats_json AS sessionFormatsJson FROM events WHERE id = ? AND organisation_id = ?",
      )
        .bind(admin.eventId, admin.organisationId)
        .first<{ sessionFormatsJson: string }>();
      expect(event).not.toBeNull();
      const configuredFormats = (
        JSON.parse(event!.sessionFormatsJson) as Array<Record<string, unknown>>
      )
        .filter((format) => format.key !== "presentation")
        .concat({
          key: "talk",
          label: "Talk",
          defaultDurationMinutes: 50,
          position: 1,
        });
      try {
        await env.DB.prepare(
          "UPDATE events SET session_formats_json = ? WHERE id = ? AND organisation_id = ?",
        )
          .bind(
            JSON.stringify(configuredFormats),
            admin.eventId,
            admin.organisationId,
          )
          .run();

        await expect(
          service.decide(admin, {
            submissionId: "eval-test-submission",
            decision: "accepted",
            sessionTrackId: "demo-track-operations",
            rationale: "Legacy format needs a current mapping.",
            release: true,
            confirmedWithoutReview: true,
          }),
        ).rejects.toThrow(/choose the current session format/i);

        const result = await service.decide(admin, {
          submissionId: "eval-test-submission",
          decision: "accepted",
          sessionTrackId: "demo-track-operations",
          sessionFormatKey: "talk",
          rationale: "Legacy format mapped to the current Talk format.",
          release: true,
          confirmedWithoutReview: true,
        });
        await expect(
          env.DB.prepare(
            "SELECT format, duration_minutes AS durationMinutes FROM sessions WHERE id = ? AND event_id = ?",
          )
            .bind(result.sessionId, admin.eventId)
            .first(),
        ).resolves.toEqual({ format: "talk", durationMinutes: 50 });
      } finally {
        await env.DB.prepare(
          "UPDATE events SET session_formats_json = ? WHERE id = ? AND organisation_id = ?",
        )
          .bind(event!.sessionFormatsJson, admin.eventId, admin.organisationId)
          .run();
      }
    });

    it("refuses release before mutation when no active decision template exists", async () => {
      await resetEvaluationFixture();
      await env.DB.prepare(
        "DELETE FROM communication_templates WHERE event_id = ? AND category = 'decision'",
      )
        .bind(admin.eventId)
        .run();
      const service = new EvaluationService(evaluationEnvironment());

      await expect(
        service.decide(admin, {
          submissionId: "eval-test-submission",
          decision: "rejected",
          rationale: "A release must have an applicant notification path.",
          release: true,
          confirmedWithoutReview: true,
        }),
      ).rejects.toThrow(/publish and activate a decision email template/i);
      await expect(
        env.DB.prepare(
          `SELECT status,
                  (SELECT COUNT(*) FROM submission_decisions decision
                    WHERE decision.submission_id = submissions.id) AS decisionCount
             FROM submissions WHERE id = 'eval-test-submission'`,
        ).first(),
      ).resolves.toEqual({ status: "submitted", decisionCount: 0 });
    });

    it("refuses release before mutation when the decision sender is unavailable", async () => {
      await resetEvaluationFixture();
      await env.DB.prepare(
        "UPDATE sender_profiles SET status = 'disabled' WHERE event_id = ?",
      )
        .bind(admin.eventId)
        .run();

      await expect(
        new EvaluationService(evaluationEnvironment()).decide(admin, {
          submissionId: "eval-test-submission",
          decision: "rejected",
          rationale: "A release must have a verified sender.",
          release: true,
          confirmedWithoutReview: true,
        }),
      ).rejects.toThrow(/verified sender profile is required/i);
      await expect(
        env.DB.prepare(
          `SELECT status,
                  (SELECT COUNT(*) FROM submission_decisions decision
                    WHERE decision.submission_id = submissions.id) AS decisionCount
             FROM submissions WHERE id = 'eval-test-submission'`,
        ).first(),
      ).resolves.toEqual({ status: "submitted", decisionCount: 0 });
    });

    it("refuses release before mutation when the recipient email is invalid", async () => {
      await resetEvaluationFixture();
      await env.DB.prepare(
        `UPDATE people SET email = 'not-an-email'
          WHERE id = 'person-demo-submitter'`,
      ).run();

      await expect(
        new EvaluationService(evaluationEnvironment()).decide(admin, {
          submissionId: "eval-test-submission",
          decision: "rejected",
          rationale: "A release must have a deliverable recipient.",
          release: true,
          confirmedWithoutReview: true,
        }),
      ).rejects.toThrow(/valid verified email address/i);
      await expect(
        env.DB.prepare(
          `SELECT status,
                  (SELECT COUNT(*) FROM submission_decisions decision
                    WHERE decision.submission_id = submissions.id) AS decisionCount
             FROM submissions WHERE id = 'eval-test-submission'`,
        ).first(),
      ).resolves.toEqual({ status: "submitted", decisionCount: 0 });
    });

    it("refuses release before mutation when the email provider is unconfigured", async () => {
      await resetEvaluationFixture();
      const unconfigured = {
        ...evaluationEnvironment(),
        EMAIL_PROVIDER: undefined,
      } as unknown as CloudflareEnvironment;

      await expect(
        new EvaluationService(unconfigured).decide(admin, {
          submissionId: "eval-test-submission",
          decision: "rejected",
          rationale: "A release must have a configured delivery provider.",
          release: true,
          confirmedWithoutReview: true,
        }),
      ).rejects.toThrow(/EMAIL_PROVIDER must be explicitly configured/i);
      await expect(
        env.DB.prepare(
          `SELECT status,
                  (SELECT COUNT(*) FROM submission_decisions decision
                    WHERE decision.submission_id = submissions.id) AS decisionCount
             FROM submissions WHERE id = 'eval-test-submission'`,
        ).first(),
      ).resolves.toEqual({ status: "submitted", decisionCount: 0 });
    });

    it("reopens a released rejection for an explicit corrected decision", async () => {
      await resetEvaluationFixture();
      const service = new EvaluationService(evaluationEnvironment());
      const released = await service.decide(admin, {
        submissionId: "eval-test-submission",
        decision: "rejected",
        rationale: "Initial outcome based on incomplete evidence.",
        release: true,
        confirmedWithoutReview: true,
      });

      const executeIdempotent = vi.fn(
        async (
          _viewer: unknown,
          _command: unknown,
          execute: () => Promise<unknown>,
        ) => execute(),
      );
      const correctionService = new EvaluationService(evaluationEnvironment(), {
        airtable: {
          executeIdempotent,
        } as unknown as AirtableProviderBoundary,
      });
      const reopened = await correctionService.reopenDecision(admin, {
        submissionId: "eval-test-submission",
        reason: "The committee received material correcting evidence.",
        confirmed: true,
      });
      expect(reopened.notificationOutcome).toBe("cancelled_before_delivery");
      expect(executeIdempotent).toHaveBeenCalledWith(
        expect.objectContaining({ eventId: admin.eventId }),
        expect.objectContaining({ operation: "evaluation.decision.reopen" }),
        expect.any(Function),
      );

      await expect(
        env.DB.prepare(
          `SELECT submission.status, decision.status AS decisionStatus,
                  (SELECT operation.status FROM operation_jobs operation
                    WHERE operation.id = ?) AS notificationStatus,
                  (SELECT communication.status FROM communications communication
                    WHERE communication.operation_id = ?
                      AND communication.event_id = decision.event_id) AS communicationStatus,
                  (SELECT delivery.status FROM communication_deliveries delivery
                    JOIN communications communication
                      ON communication.id = delivery.communication_id
                     AND communication.event_id = delivery.event_id
                     AND communication.operation_id = ?) AS deliveryStatus,
                  (SELECT item.status FROM operation_items item
                    WHERE item.operation_id = ?) AS itemStatus,
                  (SELECT COUNT(*) FROM audit_events audit
                    WHERE audit.entity_id = decision.id
                      AND audit.action = 'decision.reopened') AS reopenAuditCount
             FROM submissions submission
             JOIN submission_decisions decision
               ON decision.submission_id = submission.id
            WHERE submission.id = 'eval-test-submission'
              AND decision.id = ?`,
        )
          .bind(
            released.notificationOperationId,
            released.notificationOperationId,
            released.notificationOperationId,
            released.notificationOperationId,
            released.decisionId,
          )
          .first(),
      ).resolves.toEqual({
        status: "decision_ready",
        decisionStatus: "superseded",
        notificationStatus: "cancelled",
        communicationStatus: "cancelled",
        deliveryStatus: "cancelled",
        itemStatus: "skipped",
        reopenAuditCount: 1,
      });

      const corrected = await service.decide(admin, {
        submissionId: "eval-test-submission",
        decision: "accepted",
        sessionTrackId: "demo-track-operations",
        sessionFormatKey: "presentation",
        rationale: "Corrected outcome after reviewing the new evidence.",
        release: true,
        confirmedWithoutReview: true,
      });
      expect(corrected.sessionId).toBeTruthy();
    });

    it("fails closed when the original decision notification is already sending", async () => {
      await resetEvaluationFixture();
      const service = new EvaluationService(evaluationEnvironment());
      const released = await service.decide(admin, {
        submissionId: "eval-test-submission",
        decision: "rejected",
        rationale: "Initial outcome before the correction request.",
        release: true,
        confirmedWithoutReview: true,
      });
      await env.DB.prepare(
        `UPDATE operation_jobs
            SET status = 'running', claim_token = 'active-decision-send',
                claim_expires_at = unixepoch() + 60
          WHERE id = ? AND event_id = ?`,
      )
        .bind(released.notificationOperationId, admin.eventId)
        .run();

      await expect(
        service.reopenDecision(admin, {
          submissionId: "eval-test-submission",
          reason: "Material correcting evidence arrived during delivery.",
          confirmed: true,
        }),
      ).rejects.toThrow(/changed before it could be reopened/i);
      await expect(
        env.DB.prepare(
          `SELECT submission.status, decision.status AS decisionStatus,
                  operation.status AS notificationStatus
             FROM submissions submission
             JOIN submission_decisions decision
               ON decision.submission_id = submission.id
              AND decision.event_id = submission.event_id
             JOIN operation_jobs operation ON operation.id = ?
            WHERE submission.id = 'eval-test-submission'
              AND decision.id = ?`,
        )
          .bind(released.notificationOperationId, released.decisionId)
          .first(),
      ).resolves.toEqual({
        status: "rejected",
        decisionStatus: "published",
        notificationStatus: "running",
      });
    });

    it("reopens a released rejection after its notification has already been delivered", async () => {
      await resetEvaluationFixture();
      const service = new EvaluationService(evaluationEnvironment());
      const released = await service.decide(admin, {
        submissionId: "eval-test-submission",
        decision: "rejected",
        rationale: "Initial outcome before delivery completed.",
        release: true,
        confirmedWithoutReview: true,
      });
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE operation_jobs
              SET status = 'completed', completed_at = unixepoch(),
                  updated_at = unixepoch()
            WHERE id = ? AND event_id = ?`,
        ).bind(released.notificationOperationId, admin.eventId),
        env.DB.prepare(
          `UPDATE communications
              SET status = 'sent', sent_at = unixepoch(), updated_at = unixepoch()
            WHERE operation_id = ? AND event_id = ?`,
        ).bind(released.notificationOperationId, admin.eventId),
        env.DB.prepare(
          `UPDATE communication_deliveries
              SET status = 'sent', updated_at = unixepoch()
            WHERE event_id = ? AND communication_id IN (
              SELECT communication.id FROM communications communication
               WHERE communication.operation_id = ?
                 AND communication.event_id = communication_deliveries.event_id
            )`,
        ).bind(admin.eventId, released.notificationOperationId),
        env.DB.prepare(
          `UPDATE operation_items
              SET status = 'completed', completed_at = unixepoch(),
                  updated_at = unixepoch()
            WHERE operation_id = ?`,
        ).bind(released.notificationOperationId),
      ]);

      const reopened = await service.reopenDecision(admin, {
        submissionId: "eval-test-submission",
        reason: "The committee received material correcting evidence.",
        confirmed: true,
      });
      expect(reopened.notificationOutcome).toBe("already_delivered");
      await expect(
        env.DB.prepare(
          `SELECT submission.status, decision.status AS decisionStatus,
                  (SELECT operation.status FROM operation_jobs operation
                    WHERE operation.id = ?) AS notificationStatus,
                  (SELECT communication.status FROM communications communication
                    WHERE communication.operation_id = ?
                      AND communication.event_id = decision.event_id) AS communicationStatus,
                  (SELECT delivery.status FROM communication_deliveries delivery
                    JOIN communications communication
                      ON communication.id = delivery.communication_id
                     AND communication.event_id = delivery.event_id
                     AND communication.operation_id = ?) AS deliveryStatus,
                  (SELECT item.status FROM operation_items item
                    WHERE item.operation_id = ?) AS itemStatus
             FROM submissions submission
             JOIN submission_decisions decision
               ON decision.submission_id = submission.id
            WHERE submission.id = 'eval-test-submission'
              AND decision.id = ?`,
        )
          .bind(
            released.notificationOperationId,
            released.notificationOperationId,
            released.notificationOperationId,
            released.notificationOperationId,
            released.decisionId,
          )
          .first(),
      ).resolves.toEqual({
        status: "decision_ready",
        decisionStatus: "superseded",
        notificationStatus: "completed",
        communicationStatus: "sent",
        deliveryStatus: "sent",
        itemStatus: "completed",
      });
    });

    it("fails closed when a released decision has no notification link or legacy marker", async () => {
      await resetEvaluationFixture();
      const decisionId = "eval-unlinked-decision";
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO submission_decisions (
             id, event_id, submission_id, revision_number, status, decision,
             decided_by_person_id, rationale, notification_feedback_json,
             effect_preview_json, decided_at, published_at
           ) VALUES (?, ?, 'eval-test-submission', 1, 'published', 'rejected',
                     ?, 'Unlinked fixture outcome', '[]', '{}',
                     unixepoch(), unixepoch())`,
        ).bind(decisionId, admin.eventId, admin.personId),
        env.DB.prepare(
          `UPDATE submissions
              SET status = 'rejected', updated_at = unixepoch()
            WHERE id = 'eval-test-submission' AND event_id = ?`,
        ).bind(admin.eventId),
      ]);

      await expect(
        new EvaluationService(evaluationEnvironment()).reopenDecision(admin, {
          submissionId: "eval-test-submission",
          reason: "The committee received material correcting evidence.",
          confirmed: true,
        }),
      ).rejects.toThrow(
        /missing its notification operation without the migration audit marker/i,
      );
      await expect(
        env.DB.prepare(
          `SELECT submission.status, decision.status AS decisionStatus,
                  decision.notification_operation_id AS notificationOperationId,
                  (SELECT COUNT(*) FROM audit_events audit
                    WHERE audit.entity_id = decision.id
                      AND audit.action = 'decision.reopened') AS reopenAuditCount
             FROM submissions submission
             JOIN submission_decisions decision
               ON decision.submission_id = submission.id
              AND decision.event_id = submission.event_id
            WHERE submission.id = 'eval-test-submission'
              AND decision.id = ?`,
        )
          .bind(decisionId)
          .first(),
      ).resolves.toEqual({
        status: "rejected",
        decisionStatus: "published",
        notificationOperationId: null,
        reopenAuditCount: 0,
      });
    });

    it("fails closed when a linked notification operation has no communication graph", async () => {
      await resetEvaluationFixture();
      const decisionId = "eval-missing-graph-decision";
      const operationId = "eval-missing-graph-operation";
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO operation_jobs (
             id, organisation_id, event_id, requested_by_person_id, type,
             idempotency_key, correlation_id, status, payload_json,
             created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'decision.notification', ?, ?, 'queued',
                     '{}', unixepoch(), unixepoch())`,
        ).bind(
          operationId,
          admin.organisationId,
          admin.eventId,
          admin.personId,
          `eval-missing-graph:${operationId}`,
          operationId,
        ),
        env.DB.prepare(
          `INSERT INTO submission_decisions (
             id, event_id, submission_id, revision_number, status, decision,
             decided_by_person_id, rationale, notification_feedback_json,
             effect_preview_json, notification_operation_id, decided_at,
             published_at
           ) VALUES (?, ?, 'eval-test-submission', 1, 'published', 'rejected',
                     ?, 'Missing graph fixture outcome', '[]', '{}', ?,
                     unixepoch(), unixepoch())`,
        ).bind(decisionId, admin.eventId, admin.personId, operationId),
        env.DB.prepare(
          `UPDATE submissions
              SET status = 'rejected', updated_at = unixepoch()
            WHERE id = 'eval-test-submission' AND event_id = ?`,
        ).bind(admin.eventId),
      ]);

      await expect(
        new EvaluationService(evaluationEnvironment()).reopenDecision(admin, {
          submissionId: "eval-test-submission",
          reason: "The committee received material correcting evidence.",
          confirmed: true,
        }),
      ).rejects.toThrow(
        /complete audit, decision, submission, change, and notification evidence|changed before it could be reopened/i,
      );
      await expect(
        env.DB.prepare(
          `SELECT submission.status, decision.status AS decisionStatus,
                  (SELECT COUNT(*) FROM audit_events audit
                    WHERE audit.entity_id = decision.id
                      AND audit.action = 'decision.reopened') AS reopenAuditCount
             FROM submissions submission
             JOIN submission_decisions decision
               ON decision.submission_id = submission.id
              AND decision.event_id = submission.event_id
            WHERE submission.id = 'eval-test-submission'
              AND decision.id = ?`,
        )
          .bind(decisionId)
          .first(),
      ).resolves.toEqual({
        status: "rejected",
        decisionStatus: "published",
        reopenAuditCount: 0,
      });
    });

    it("reopens a documented pre-migration unlinked decision", async () => {
      await resetEvaluationFixture();
      const decisionId = "eval-legacy-unlinked-decision";
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO submission_decisions (
             id, event_id, submission_id, revision_number, status, decision,
             decided_by_person_id, rationale, notification_feedback_json,
             effect_preview_json, decided_at, published_at
           ) VALUES (?, ?, 'eval-test-submission', 1, 'published', 'rejected',
                     ?, 'Legacy unlinked fixture outcome', '[]', '{}',
                     unixepoch(), unixepoch())`,
        ).bind(decisionId, admin.eventId, admin.personId),
        env.DB.prepare(
          `UPDATE submissions
              SET status = 'rejected', updated_at = unixepoch()
            WHERE id = 'eval-test-submission' AND event_id = ?`,
        ).bind(admin.eventId),
      ]);
      await env.DB.exec(
        "DROP TRIGGER decision_notification_legacy_unlinked_set_closed",
      );
      try {
        await env.DB.prepare(
          `INSERT INTO audit_events (
             id, actor_kind, origin, metadata_version, organisation_id, event_id,
             action, entity_type, entity_id, metadata_json, created_at
           ) VALUES (?, 'system', 'internal', 1, ?, ?,
                     'decision.notification.legacy_unlinked',
                     'submission_decision', ?,
                     '{"reason":"release predates pinned notification evidence","deliveryOutcome":"not asserted by migration"}',
                     unixepoch())`,
        )
          .bind(
            `migration-0041-decision-notification-unlinked:${decisionId}`,
            admin.organisationId,
            admin.eventId,
            decisionId,
          )
          .run();
      } finally {
        await env.DB.prepare(
          `CREATE TRIGGER decision_notification_legacy_unlinked_set_closed
           BEFORE INSERT ON audit_events
           WHEN NEW.action = 'decision.notification.legacy_unlinked'
           BEGIN
             SELECT RAISE(ABORT, 'legacy unlinked decision notification set is closed');
           END`,
        ).run();
      }

      const reopened = await new EvaluationService(
        evaluationEnvironment(),
      ).reopenDecision(admin, {
        submissionId: "eval-test-submission",
        reason: "The committee received material correcting evidence.",
        confirmed: true,
      });
      expect(reopened.notificationOutcome).toBe("legacy_unverified");
      await expect(
        env.DB.prepare(
          `SELECT submission.status, decision.status AS decisionStatus
             FROM submissions submission
             JOIN submission_decisions decision
               ON decision.submission_id = submission.id
              AND decision.event_id = submission.event_id
            WHERE submission.id = 'eval-test-submission'
              AND decision.id = ?`,
        )
          .bind(decisionId)
          .first(),
      ).resolves.toEqual({
        status: "decision_ready",
        decisionStatus: "superseded",
      });
    });

    it.each([
      [
        "audit insertion",
        /INSERT INTO audit_events[\s\S]*'decision\.reopened'/u,
      ],
      [
        "communication cancellation",
        /UPDATE communications\s+SET status = 'cancelled'/u,
      ],
      [
        "delivery cancellation",
        /UPDATE communication_deliveries\s+SET status = 'cancelled'/u,
      ],
      [
        "operation-item skipping",
        /UPDATE operation_items\s+SET status = 'skipped'/u,
      ],
      [
        "decision supersession",
        /UPDATE submission_decisions\s+SET status = 'superseded'/u,
      ],
      [
        "submission transition",
        /UPDATE submissions\s+SET status = 'decision_ready'/u,
      ],
      [
        "event-change insertion",
        /INSERT INTO event_changes[\s\S]*'submission_decision'/u,
      ],
    ])(
      "rolls back decision reopen when its %s is suppressed",
      async (_label, pattern) => {
        await resetEvaluationFixture();
        const service = new EvaluationService(evaluationEnvironment());
        const released = await service.decide(admin, {
          submissionId: "eval-test-submission",
          decision: "rejected",
          rationale: "Initial outcome before the atomic reopen check.",
          release: true,
          confirmedWithoutReview: true,
        });
        const before = await env.DB.prepare(
          `SELECT submission.status AS submissionStatus, submission.revision,
                  decision.status AS decisionStatus,
                  (SELECT COUNT(*) FROM audit_events audit
                    WHERE audit.entity_id = decision.id
                      AND audit.action = 'decision.reopened') AS reopenAuditCount,
                  (SELECT operation.status FROM operation_jobs operation
                    WHERE operation.id = ?) AS notificationStatus,
                  (SELECT communication.status FROM communications communication
                    WHERE communication.operation_id = ?
                      AND communication.event_id = decision.event_id) AS communicationStatus
             FROM submissions submission
             JOIN submission_decisions decision
               ON decision.submission_id = submission.id
              AND decision.event_id = submission.event_id
            WHERE submission.id = 'eval-test-submission'
              AND decision.id = ?`,
        )
          .bind(
            released.notificationOperationId,
            released.notificationOperationId,
            released.decisionId,
          )
          .first();
        expect(before).toMatchObject({
          submissionStatus: "rejected",
          decisionStatus: "published",
          reopenAuditCount: 0,
          notificationStatus: "queued",
          communicationStatus: "queued",
        });
        const fault = withSuppressedStatement(evaluationEnvironment(), pattern);

        await expect(
          new EvaluationService(fault.env).reopenDecision(admin, {
            submissionId: "eval-test-submission",
            reason: "The committee received material correcting evidence.",
            confirmed: true,
          }),
        ).rejects.toThrow(
          /complete audit, decision, submission, change, and notification evidence|changed before it could be reopened/i,
        );
        expect(fault.suppressed()).toBe(1);
        await expect(
          env.DB.prepare(
            `SELECT submission.status AS submissionStatus, submission.revision,
                    decision.status AS decisionStatus,
                    (SELECT COUNT(*) FROM audit_events audit
                      WHERE audit.entity_id = decision.id
                        AND audit.action = 'decision.reopened') AS reopenAuditCount,
                    (SELECT operation.status FROM operation_jobs operation
                      WHERE operation.id = ?) AS notificationStatus,
                    (SELECT communication.status FROM communications communication
                      WHERE communication.operation_id = ?
                        AND communication.event_id = decision.event_id) AS communicationStatus
               FROM submissions submission
               JOIN submission_decisions decision
                 ON decision.submission_id = submission.id
                AND decision.event_id = submission.event_id
              WHERE submission.id = 'eval-test-submission'
                AND decision.id = ?`,
          )
            .bind(
              released.notificationOperationId,
              released.notificationOperationId,
              released.decisionId,
            )
            .first(),
        ).resolves.toEqual(before);
      },
    );

    it("fails accepted release if the claimed speaker set changes before provisioning", async () => {
      await resetEvaluationFixture();
      const latePersonId = `eval-late-speaker-${crypto.randomUUID()}`;
      await env.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, email_verified, profile_status,
           created_at, updated_at
         ) VALUES (?, ?, 'Late Speaker', 1, 'draft', unixepoch(), unixepoch())`,
      )
        .bind(latePersonId, `${latePersonId}@example.com`)
        .run();
      const racingEnv = withBatchRace(evaluationEnvironment(), async () => {
        await env.DB.prepare(
          `INSERT INTO submission_speakers (
               id, event_id, submission_id, person_id, email, display_name,
               position, invitation_status, is_primary, claimed_at,
               created_at, updated_at
             ) VALUES (?, ?, 'eval-test-submission', ?, ?, 'Late Speaker', 1,
                       'claimed', 0, unixepoch(), unixepoch(), unixepoch())`,
        )
          .bind(
            crypto.randomUUID(),
            admin.eventId,
            latePersonId,
            `${latePersonId}@example.com`,
          )
          .run();
      });
      try {
        await expect(
          new EvaluationService(racingEnv).decide(admin, {
            submissionId: "eval-test-submission",
            decision: "accepted",
            sessionTrackId: "demo-track-operations",
            sessionFormatKey: "presentation",
            rationale: "The full speaker set must be provisioned together.",
            release: true,
            confirmedWithoutReview: true,
            sessionDurationMinutes: 60,
          }),
        ).rejects.toBeInstanceOf(EvaluationRevisionConflictError);
        expect(
          await env.DB.prepare(
            `SELECT status,
                    (SELECT COUNT(*) FROM sessions
                      WHERE source_submission_id = submissions.id) AS sessionCount
               FROM submissions WHERE id = 'eval-test-submission'`,
          ).first(),
        ).toEqual({ status: "submitted", sessionCount: 0 });
        expect(
          await env.DB.prepare(
            `SELECT COUNT(*) AS count FROM memberships
              WHERE event_id = ? AND person_id = ? AND role = 'speaker'`,
          )
            .bind(admin.eventId, latePersonId)
            .first(),
        ).toEqual({ count: 0 });
      } finally {
        await env.DB.prepare(
          "DELETE FROM submission_speakers WHERE submission_id = 'eval-test-submission' AND person_id = ?",
        )
          .bind(latePersonId)
          .run();
        await env.DB.prepare("DELETE FROM people WHERE id = ?")
          .bind(latePersonId)
          .run();
      }
    });

    it("blocks accepted release until every co-speaker has claimed an identity", async () => {
      await env.DB.batch([
        env.DB.prepare(
          `
          INSERT INTO submissions (
            id, event_id, form_version_id, submitter_person_id, submitter_email,
            public_reference, title, category, format, status, answers_json,
            submitted_snapshot_json, revision, submitted_at, created_at, updated_at
          ) VALUES (
            'eval-unclaimed-submission', ?, 'eval-test-form-v1',
            'person-demo-submitter', 'alex.submitter@example.com',
            'SUB-EVAL-UNCLAIMED', 'Proposal with pending co-speaker',
            'Operations', 'Presentation', 'submitted', '{}', ?, 1,
            unixepoch(), unixepoch(), unixepoch()
          )
        `,
        ).bind(admin.eventId, submittedSnapshot()),
        env.DB.prepare(
          `
          INSERT INTO submission_speakers (
            id, event_id, submission_id, person_id, email, display_name, position,
            invitation_status, is_primary, claimed_at, created_at, updated_at
          ) VALUES (
            'eval-unclaimed-primary', ?, 'eval-unclaimed-submission',
            'person-demo-submitter', 'alex.submitter@example.com', 'Alex Morgan',
            0, 'claimed', 1, unixepoch(), unixepoch(), unixepoch()
          )
        `,
        ).bind(admin.eventId),
        env.DB.prepare(
          `
          INSERT INTO submission_speakers (
            id, event_id, submission_id, person_id, email, display_name, position,
            invitation_status, is_primary, created_at, updated_at
          ) VALUES (
            'eval-unclaimed-co-speaker', ?, 'eval-unclaimed-submission', NULL,
            'pending.co-speaker@example.com', 'Pending Co-speaker', 1,
            'pending', 0, unixepoch(), unixepoch()
          )
        `,
        ).bind(admin.eventId),
        env.DB.prepare(
          `INSERT INTO submission_track_selections (
             submission_id, event_id, track_id, track_name_snapshot, position
           ) VALUES (
             'eval-unclaimed-submission', ?,
             'demo-track-operations', 'Operations', 0
           )`,
        ).bind(admin.eventId),
      ]);

      const service = new EvaluationService(evaluationEnvironment());
      await expect(
        service.decide(admin, {
          submissionId: "eval-unclaimed-submission",
          decision: "accepted",
          sessionTrackId: "demo-track-operations",
          sessionFormatKey: "presentation",
          rationale: "Strong proposal.",
          release: true,
          confirmedWithoutReview: true,
          sessionDurationMinutes: 60,
        }),
      ).rejects.toThrow(/claim every co-speaker/i);

      expect(
        await env.DB.prepare(
          `
          SELECT s.status,
                 (SELECT COUNT(*) FROM submission_decisions d WHERE d.submission_id = s.id) AS decisionCount,
                 (SELECT COUNT(*) FROM sessions candidate WHERE candidate.source_submission_id = s.id) AS sessionCount
            FROM submissions s WHERE s.id = 'eval-unclaimed-submission'
        `,
        ).first(),
      ).toEqual({ status: "submitted", decisionCount: 0, sessionCount: 0 });
    });

    it("cancels active review work when a decision is released", async () => {
      const service = new EvaluationService(evaluationEnvironment());
      let adminWorkspace = await service.getAdminWorkspace(admin);
      if (!adminWorkspace.plan?.rounds[0]) {
        await service.savePlan(admin, {
          revision: 0,
          name: "Decision assignment plan",
          status: "active",
          rounds: [
            {
              id: "eval-decision-assignment-round",
              name: "Initial review",
              anonymous: false,
              criteria,
            },
          ],
        });
        adminWorkspace = await service.getAdminWorkspace(admin);
      }
      await addRoundReviewer(adminWorkspace.plan!.rounds[0]!.id);
      await env.DB.prepare(
        `
        INSERT OR IGNORE INTO submissions (
          id, event_id, form_version_id, submitter_person_id, submitter_email,
          public_reference, title, category, format, status, answers_json,
          submitted_snapshot_json, revision, submitted_at, created_at, updated_at
        ) VALUES (
          'eval-active-decision-submission', ?, 'eval-test-form-v1',
          'person-demo-submitter', 'alex.submitter@example.com',
          'SUB-EVAL-ACTIVE-DECISION', 'Active review decision proposal',
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
           'eval-active-decision-submission', ?,
           'demo-track-operations', 'Operations', 0
         )`,
      )
        .bind(admin.eventId)
        .run();
      await service.assign(admin, {
        roundId: adminWorkspace.plan!.rounds[0]!.id,
        targetType: "submission",
        targetIds: ["eval-active-decision-submission"],
        evaluatorPersonIds: [evaluator.personId],
      });
      const queue = await service.getReviewerWorkspace(evaluator);
      const assignment = queue.assignments.find(
        (candidate) =>
          candidate.submissionId === "eval-active-decision-submission",
      )!;

      await service.decide(admin, {
        submissionId: "eval-active-decision-submission",
        decision: "rejected",
        rationale: "The programme is now final.",
        release: true,
        confirmedWithoutReview: true,
      });
      const stored = await env.DB.prepare(
        `
        SELECT status FROM evaluator_assignments WHERE id = ?
      `,
      )
        .bind(assignment.id)
        .first<{ status: string }>();
      expect(stored?.status).toBe("cancelled");
      await expect(
        service.saveReview(
          evaluator,
          {
            assignmentId: assignment.id,
            revision: 0,
            scores: Object.fromEntries(
              criteria.map((criterion) => [criterion.id, 4]),
            ),
            recommendation: null,
            confidence: null,
            submitterFeedback: "",
            privateNotes: "",
            intent: "save",
          },
          "participant_ui",
        ),
      ).rejects.toThrow(/unavailable|already submitted/);
    });
  });
});
