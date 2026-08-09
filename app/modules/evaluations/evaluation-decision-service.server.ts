import type { Viewer } from "~/platform/auth/authorize.server";
import { materializePublishedResourceAcknowledgementsForSession } from "~/modules/resources/resource-service.server";
import { submittedSnapshotSchema } from "~/modules/submissions/submission-schema";
import {
  EvaluationDecisionAuthorityError,
  EvaluationDecisionFinalError,
  EvaluationRevisionConflictError,
  EvaluationStateError,
} from "./evaluation-errors";
import { decisionSchema } from "./evaluation-schema";

type DecisionSubmission = {
  id: string;
  title: string;
  reference: string;
  format: string | null;
  category: string | null;
  status: string;
  revision: number;
  snapshotJson: string | null;
};

function buildDecisionStatements(input: {
  env: CloudflareEnvironment;
  viewer: Viewer;
  parsed: ReturnType<typeof decisionSchema.parse>;
  submission: DecisionSubmission;
  revision: number;
  decisionId: string;
  status: "published" | "draft";
  submissionStatus: string;
  sessionId: string | null;
  sessionDescription: string;
  slug: string;
  format: string;
  notificationOperationId: string | null;
}) {
  const {
    env,
    viewer,
    parsed,
    submission,
    revision,
    decisionId,
    status,
    submissionStatus,
    sessionId,
    sessionDescription,
    slug,
    format,
    notificationOperationId,
  } = input;
  return [
    env.DB.prepare(
      `
        UPDATE submissions
           SET status = ?, revision = revision + 1, last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND revision = ?
           AND status IN ('submitted','assigned','in_review','decision_ready')
           AND (
             ? <> 'published' OR ? <> 'accepted'
             OR NOT EXISTS (
               SELECT 1 FROM submission_speakers pending_speaker
                WHERE pending_speaker.event_id = submissions.event_id
                  AND pending_speaker.submission_id = submissions.id
                  AND pending_speaker.person_id IS NULL
             )
           )
           AND (
             ? <> 'published'
             OR ? IN ('owner','administrator')
             OR (
               ? = 'committee_chair'
               AND EXISTS (
                 SELECT 1 FROM evaluation_plans authority_plan
                  WHERE authority_plan.event_id = submissions.event_id
                    AND authority_plan.status = 'active'
                    AND authority_plan.decision_role = 'committee_chair'
               )
             )
           )
      `,
    ).bind(
      submissionStatus,
      decisionId,
      submission.id,
      viewer.eventId,
      submission.revision,
      status,
      parsed.decision,
      status,
      viewer.role,
      viewer.role,
    ),
    env.DB.prepare(
      `
        UPDATE submission_decisions SET status = 'superseded'
         WHERE event_id = ? AND submission_id = ? AND status = 'draft'
           AND EXISTS (
             SELECT 1 FROM submissions
              WHERE id = ? AND event_id = ? AND last_operation_id = ?
           )
      `,
    ).bind(
      viewer.eventId,
      submission.id,
      submission.id,
      viewer.eventId,
      decisionId,
    ),
    env.DB.prepare(
      `
        UPDATE evaluator_assignments
           SET status = 'cancelled', revision = revision + 1,
               last_operation_id = ?
         WHERE event_id = ? AND submission_id = ?
           AND status IN ('assigned','in_progress','reopened')
           AND ? = 'published'
           AND EXISTS (
             SELECT 1 FROM submissions
              WHERE id = ? AND event_id = ? AND last_operation_id = ?
           )
      `,
    ).bind(
      decisionId,
      viewer.eventId,
      submission.id,
      status,
      submission.id,
      viewer.eventId,
      decisionId,
    ),
    env.DB.prepare(
      `
        INSERT INTO submission_decisions (
          id, event_id, submission_id, revision_number, status, decision,
          decided_by_person_id, rationale, effect_preview_json, idempotency_key,
          decided_at, published_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(),
               CASE WHEN ? = 'published' THEN unixepoch() END
         WHERE EXISTS (
           SELECT 1 FROM submissions
            WHERE id = ? AND event_id = ? AND last_operation_id = ?
         )
      `,
    ).bind(
      decisionId,
      viewer.eventId,
      submission.id,
      revision,
      status,
      parsed.decision,
      viewer.personId,
      parsed.rationale || null,
      JSON.stringify({
        createsSession: Boolean(sessionId),
        queuesNotification: Boolean(notificationOperationId),
      }),
      `decision:${submission.id}:${revision}`,
      status,
      submission.id,
      viewer.eventId,
      decisionId,
    ),
    ...(sessionId
      ? [
          env.DB.prepare(
            `
          INSERT INTO sessions (
            id, event_id, source_submission_id, title, slug, description, format,
            duration_minutes, status, visibility, revision, created_at, updated_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, 60, 'unscheduled', 'public', 1, unixepoch(), unixepoch()
           WHERE EXISTS (
             SELECT 1 FROM submission_decisions
              WHERE id = ? AND event_id = ? AND status = 'published' AND decision = 'accepted'
           )
        `,
          ).bind(
            sessionId,
            viewer.eventId,
            submission.id,
            submission.title,
            slug,
            sessionDescription,
            format,
            decisionId,
            viewer.eventId,
          ),
          env.DB.prepare(
            `
          INSERT INTO session_speakers (session_id, event_id, person_id, position, role_label, visibility)
          SELECT ?, event_id, person_id, position,
                 CASE WHEN is_primary = 1 THEN 'Primary speaker' ELSE 'Co-speaker' END, 'public'
            FROM submission_speakers
           WHERE submission_id = ? AND event_id = ? AND person_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND event_id = ?)
        `,
          ).bind(
            sessionId,
            submission.id,
            viewer.eventId,
            sessionId,
            viewer.eventId,
          ),
          ...materializePublishedResourceAcknowledgementsForSession(
            env,
            viewer.eventId,
            sessionId,
          ),
        ]
      : []),
    ...(notificationOperationId
      ? [
          env.DB.prepare(
            `
        INSERT INTO operation_jobs (
          id, organisation_id, event_id, requested_by_person_id, type,
          idempotency_key, correlation_id, status, payload_json,
          progress_completed, progress_total, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, 'decision.notification', ?, ?, 'queued', ?, 0, 1, unixepoch(), unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM submission_decisions
            WHERE id = ? AND event_id = ? AND status = 'published'
         )
      `,
          ).bind(
            notificationOperationId,
            viewer.organisationId,
            viewer.eventId,
            viewer.personId,
            `decision-notification:${decisionId}`,
            crypto.randomUUID(),
            JSON.stringify({
              operationId: notificationOperationId,
              eventId: viewer.eventId,
              organisationId: viewer.organisationId,
              type: "decision.notification",
              idempotencyKey: `decision-notification:${decisionId}`,
              payload: { decisionId },
            }),
            decisionId,
            viewer.eventId,
          ),
        ]
      : []),
    env.DB.prepare(
      `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, ?, 'submission_decision', ?, ?, unixepoch()
         WHERE EXISTS (SELECT 1 FROM submission_decisions WHERE id = ? AND event_id = ?)
      `,
    ).bind(
      crypto.randomUUID(),
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      parsed.release ? "decision.published" : "decision.drafted",
      decisionId,
      JSON.stringify({
        decision: parsed.decision,
        sessionId,
        notificationOperationId,
      }),
      decisionId,
      viewer.eventId,
    ),
  ];
}

export class EvaluationDecisionService {
  constructor(private readonly env: CloudflareEnvironment) {}

  private async assertViewerEvent(viewer: Viewer) {
    const event = await this.env.DB.prepare(
      "SELECT id FROM events WHERE id = ? AND organisation_id = ?",
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first();
    if (!event) {
      throw new Error("Event not found in the authorised organisation.");
    }
  }

  async decide(viewer: Viewer, input: unknown) {
    await this.assertViewerEvent(viewer);
    const parsed = decisionSchema.parse(input);
    if (
      parsed.release &&
      viewer.role !== "owner" &&
      viewer.role !== "administrator"
    ) {
      const plan = await this.env.DB.prepare(
        `
        SELECT decision_role AS decisionRole
          FROM evaluation_plans
         WHERE event_id = ? AND status = 'active'
         ORDER BY created_at DESC LIMIT 1
      `,
      )
        .bind(viewer.eventId)
        .first<{ decisionRole: string }>();
      if (
        viewer.role !== "committee_chair" ||
        plan?.decisionRole !== "committee_chair"
      ) {
        throw new EvaluationDecisionAuthorityError();
      }
    }
    const submission = await this.env.DB.prepare(
      `
      SELECT s.id, s.title, s.public_reference AS reference, s.format, s.category,
             s.status, s.revision, s.submitted_snapshot_json AS snapshotJson
        FROM submissions s JOIN events e ON e.id = s.event_id
       WHERE s.id = ? AND s.event_id = ? AND e.organisation_id = ? AND s.status NOT IN ('draft','withdrawn')
    `,
    )
      .bind(parsed.submissionId, viewer.eventId, viewer.organisationId)
      .first<DecisionSubmission>();
    if (!submission)
      throw new EvaluationStateError(
        "Submission not found or cannot be decided.",
      );
    const terminalStatuses = new Set(["accepted", "waitlisted", "rejected"]);
    const prior = await this.env.DB.prepare(
      `
      SELECT COALESCE(MAX(revision_number), 0) AS revision,
             COALESCE(MAX(CASE WHEN status = 'published' THEN 1 ELSE 0 END), 0) AS hasPublished
        FROM submission_decisions WHERE event_id = ? AND submission_id = ?
    `,
    )
      .bind(viewer.eventId, submission.id)
      .first<{ revision: number; hasPublished: number }>();
    if (
      terminalStatuses.has(submission.status) ||
      Number(prior?.hasPublished ?? 0) > 0
    ) {
      throw new EvaluationDecisionFinalError();
    }
    const revision = (prior?.revision ?? 0) + 1;
    const decisionId = crypto.randomUUID();
    const sessionId =
      parsed.release && parsed.decision === "accepted"
        ? crypto.randomUUID()
        : null;
    let sessionDescription = "";
    if (sessionId) {
      let rawSnapshot: unknown;
      try {
        rawSnapshot = JSON.parse(submission.snapshotJson ?? "null");
      } catch {
        rawSnapshot = null;
      }
      const snapshot = submittedSnapshotSchema.safeParse(rawSnapshot);
      if (!snapshot.success) {
        throw new EvaluationStateError(
          "The accepted submission is missing its valid immutable snapshot.",
        );
      }
      const description = snapshot.data.answers.description;
      sessionDescription =
        typeof description === "string" ? description.trim() : "";
    }
    const notificationOperationId = parsed.release ? crypto.randomUUID() : null;
    const status = parsed.release ? "published" : "draft";
    const submissionStatus = parsed.release
      ? parsed.decision
      : "decision_ready";
    const slug = `${
      submission.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 80) || "session"
    }-${submission.reference.toLowerCase()}`;
    const allowedFormats = new Set([
      "keynote",
      "presentation",
      "panel",
      "workshop",
      "breakout",
      "break",
      "other",
    ]);
    const format = allowedFormats.has((submission.format ?? "").toLowerCase())
      ? submission.format!.toLowerCase()
      : "other";
    const statements = buildDecisionStatements({
      env: this.env,
      viewer,
      parsed,
      submission,
      revision,
      decisionId,
      status,
      submissionStatus,
      sessionId,
      sessionDescription,
      slug,
      format,
      notificationOperationId,
    });
    const [updated] = await this.env.DB.batch(statements);
    if ((updated.meta.changes ?? 0) !== 1) {
      if (sessionId) {
        const pendingSpeaker = await this.env.DB.prepare(
          `
          SELECT 1 FROM submission_speakers
           WHERE event_id = ? AND submission_id = ? AND person_id IS NULL
           LIMIT 1
        `,
        )
          .bind(viewer.eventId, submission.id)
          .first();
        if (pendingSpeaker) {
          throw new EvaluationStateError(
            "Claim every co-speaker before releasing an accepted decision. No speaker will be silently omitted from the session.",
          );
        }
      }
      if (parsed.release && viewer.role === "committee_chair") {
        const authority = await this.env.DB.prepare(
          `
          SELECT 1 FROM evaluation_plans
           WHERE event_id = ? AND status = 'active'
             AND decision_role = 'committee_chair'
           LIMIT 1
        `,
        )
          .bind(viewer.eventId)
          .first();
        if (!authority) throw new EvaluationDecisionAuthorityError();
      }
      throw new EvaluationRevisionConflictError(
        "This submission changed before the decision was saved. Refresh before trying again.",
      );
    }
    let notificationStatus: "not_requested" | "queued" | "queue_failed" =
      notificationOperationId ? "queued" : "not_requested";
    if (notificationOperationId) {
      const message = {
        operationId: notificationOperationId,
        eventId: viewer.eventId,
        organisationId: viewer.organisationId,
        type: "decision.notification",
        idempotencyKey: `decision-notification:${decisionId}`,
        payload: { decisionId },
      };
      try {
        await this.env.OPERATIONS_QUEUE.send(message);
      } catch (error) {
        notificationStatus = "queue_failed";
        await this.env.DB.prepare(
          "UPDATE operation_jobs SET status = 'queue_failed', last_error = ?, updated_at = unixepoch() WHERE id = ?",
        )
          .bind(
            error instanceof Error ? error.message : String(error),
            notificationOperationId,
          )
          .run();
      }
    }
    return {
      decisionId,
      sessionId,
      notificationOperationId,
      notificationStatus,
    };
  }
}
