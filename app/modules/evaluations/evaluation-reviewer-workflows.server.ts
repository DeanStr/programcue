import { reviewerVisibleAnswers } from "~/modules/submissions/submission-schema";
import type { Viewer } from "~/platform/auth/authorize.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import { EvaluationAssignmentWorkflows } from "./evaluation-assignment-workflows.server";
import {
  EvaluationRevisionConflictError,
  EvaluationStateError,
  EvaluationValidationError,
} from "./evaluation-errors";
import { calculateRubricWeightedScore } from "./evaluation-rules";
import {
  conflictDeclarationSchema,
  moderationSchema,
  reviewDraftSchema,
  reviewReopenSchema,
} from "./evaluation-schema";
import {
  parseSubmittedSnapshot,
  requireSessionReviewSnapshot,
  requireSubmittedSnapshot,
  reviewerCanSeeSubmissionAttachment,
  summaryAnswer,
  type Criterion,
} from "./evaluation-service-foundation.server";

export abstract class EvaluationReviewerWorkflows extends EvaluationAssignmentWorkflows {
  async getReviewerWorkspace(viewer: Viewer, selectedAssignmentId?: string) {
    return this.readAuthoritative(viewer, () =>
      this.getReviewerWorkspaceD1(viewer, selectedAssignmentId),
    );
  }

  async getReviewerWorkbench(viewer: Viewer, selectedAssignmentId?: string) {
    return this.readAuthoritative(viewer, async () => {
      let workspace;
      try {
        workspace = await this.getReviewerWorkspaceD1(
          viewer,
          selectedAssignmentId,
        );
      } catch (error) {
        if (
          !(error instanceof Response) ||
          error.status !== 404 ||
          selectedAssignmentId === undefined
        ) {
          throw error;
        }
        const recused = await this.env.DB.prepare(
          `SELECT 1
             FROM evaluator_assignments assignment
             JOIN events event
               ON event.id = assignment.event_id
              AND event.organisation_id = ?
            WHERE assignment.id = ? AND assignment.event_id = ?
              AND assignment.evaluator_person_id = ?
              AND assignment.status = 'recused'`,
        )
          .bind(
            viewer.organisationId,
            selectedAssignmentId,
            viewer.eventId,
            viewer.personId,
          )
          .first();
        if (recused) return { kind: "selection_recused" as const };
        throw error;
      }

      const event = await this.env.DB.prepare(
        `SELECT name
           FROM events
          WHERE id = ? AND organisation_id = ?`,
      )
        .bind(viewer.eventId, viewer.organisationId)
        .first<{ name: string }>();
      if (!event) throw new Response("Event not found", { status: 404 });
      return {
        kind: "ready" as const,
        eventName: event.name,
        workspace,
      };
    });
  }

  protected async getReviewerWorkspaceD1(
    viewer: Viewer,
    selectedAssignmentId?: string,
  ) {
    await this.assertViewerEvent(viewer);
    const assignments = await this.env.DB.prepare(
      `
      SELECT a.id, a.status, a.revision, a.due_at AS dueAt,
             a.submission_id AS submissionId, a.session_id AS sessionId,
             submission.public_reference AS submissionReference,
             submission.submitted_snapshot_json AS submissionSnapshotJson,
             session.slug AS sessionReference,
             a.session_snapshot_json AS sessionSnapshotJson,
             p.blinded_reviewing AS blindedReviewing
        FROM evaluator_assignments a
        LEFT JOIN submissions submission
          ON submission.id = a.submission_id
         AND submission.event_id = a.event_id
        LEFT JOIN sessions session
          ON session.id = a.session_id AND session.event_id = a.event_id
        JOIN evaluation_rounds r ON r.id = a.round_id AND r.event_id = a.event_id
        JOIN evaluation_plans p ON p.id = r.plan_id AND p.event_id = r.event_id
       WHERE a.event_id = ? AND a.evaluator_person_id = ?
         AND a.status NOT IN ('recused','cancelled')
       ORDER BY CASE a.status WHEN 'in_progress' THEN 0 WHEN 'reopened' THEN 0 WHEN 'assigned' THEN 1 ELSE 2 END,
                a.due_at, a.assigned_at
    `,
    )
      .bind(viewer.eventId, viewer.personId)
      .all<{
        id: string;
        status: string;
        revision: number;
        dueAt: number | null;
        submissionId: string | null;
        sessionId: string | null;
        submissionReference: string | null;
        submissionSnapshotJson: string | null;
        sessionReference: string | null;
        sessionSnapshotJson: string | null;
        blindedReviewing: number | boolean;
      }>();
    const reviewerAssignments = assignments.results.map(
      ({ submissionSnapshotJson, sessionSnapshotJson, ...assignment }) => {
        const blindedReviewing = Boolean(assignment.blindedReviewing);
        if (assignment.submissionId) {
          const snapshot = requireSubmittedSnapshot(
            assignment.submissionId,
            submissionSnapshotJson,
          );
          const answers = reviewerVisibleAnswers(
            snapshot.schema,
            snapshot.answers,
          );
          return {
            ...assignment,
            targetType: "submission" as const,
            targetId: assignment.submissionId,
            reference: assignment.submissionReference!,
            title:
              summaryAnswer(answers.title) ??
              (blindedReviewing
                ? "Blinded proposal"
                : "Proposal title restricted"),
            category: summaryAnswer(answers.category),
            format: summaryAnswer(answers.format),
            blindedReviewing,
          };
        }
        if (!assignment.sessionId) {
          throw new Error(
            `Evaluation assignment ${assignment.id} has no source target.`,
          );
        }
        const snapshot = requireSessionReviewSnapshot(
          assignment.id,
          sessionSnapshotJson,
        );
        return {
          ...assignment,
          targetType: "session" as const,
          targetId: assignment.sessionId,
          reference: `Session · ${assignment.sessionReference!}`,
          title: snapshot.title,
          category: snapshot.trackName,
          format: snapshot.format,
          blindedReviewing,
        };
      },
    );
    const selected =
      selectedAssignmentId === undefined
        ? (reviewerAssignments[0] ?? null)
        : (reviewerAssignments.find(
            (assignment) => assignment.id === selectedAssignmentId,
          ) ?? null);
    if (selectedAssignmentId !== undefined && !selected) {
      throw new Response("Review assignment not found", { status: 404 });
    }
    if (!selected)
      return {
        assignments: [],
        selected: null,
        criteria: [],
        submission: null,
        review: null,
        attachments: [],
      };
    const [criteria, source, review, attachments] = await Promise.all([
      this.env.DB.prepare(
        `
        SELECT c.id, c.name, c.description, c.input_type AS inputType,
               c.weight_percent AS weightPercent, c.required, c.position
          FROM evaluation_criteria c JOIN evaluator_assignments a ON a.round_id = c.round_id AND a.event_id = c.event_id
         WHERE a.id = ? AND a.event_id = ? ORDER BY c.position
      `,
      )
        .bind(selected.id, viewer.eventId)
        .all<Criterion>(),
      this.env.DB.prepare(
        `
        SELECT a.submission_id AS submissionId, a.session_id AS sessionId,
               submission.submitted_snapshot_json AS submissionSnapshotJson,
               a.session_snapshot_json AS sessionSnapshotJson
          FROM evaluator_assignments a
          LEFT JOIN submissions submission
            ON submission.id = a.submission_id
           AND submission.event_id = a.event_id
         WHERE a.id = ? AND a.event_id = ? AND a.evaluator_person_id = ?
      `,
      )
        .bind(selected.id, viewer.eventId, viewer.personId)
        .first<{
          submissionId: string | null;
          sessionId: string | null;
          submissionSnapshotJson: string | null;
          sessionSnapshotJson: string | null;
        }>(),
      this.env.DB.prepare(
        `
        SELECT r.id, r.status, r.scores_json AS scoresJson, r.weighted_score AS weightedScore,
               r.recommendation, r.confidence, r.submitter_feedback AS submitterFeedback,
               r.private_notes AS privateNotes, r.revision
          FROM reviews r JOIN evaluator_assignments a ON a.id = r.assignment_id AND a.event_id = r.event_id
         WHERE r.assignment_id = ? AND r.event_id = ? AND a.evaluator_person_id = ?
      `,
      )
        .bind(selected.id, viewer.eventId, viewer.personId)
        .first<{
          id: string;
          status: string;
          scoresJson: string;
          weightedScore: number | null;
          recommendation: string | null;
          confidence: number | null;
          submitterFeedback: string | null;
          privateNotes: string | null;
          revision: number;
        }>(),
      this.env.DB.prepare(
        `
        SELECT fa.id, fv.id AS versionId, fa.asset_kind AS kind,
               fv.original_filename AS filename,
               COALESCE(fv.detected_content_type, fv.declared_content_type) AS contentType,
               fv.size_bytes AS sizeBytes
          FROM file_assets fa
          JOIN file_versions fv
            ON fv.id = fa.current_version_id AND fv.event_id = fa.event_id
          JOIN evaluator_assignments a
            ON a.event_id = fa.event_id
           AND (
             (fa.target_type = 'submission' AND a.submission_id = fa.target_id)
             OR
             (fa.target_type = 'session' AND a.session_id = fa.target_id)
           )
         WHERE a.id = ? AND a.event_id = ? AND a.evaluator_person_id = ?
           AND a.status NOT IN ('recused','cancelled')
           AND fa.status = 'active'
           AND fv.upload_status = 'uploaded'
           AND fv.signature_status = 'valid' AND fv.scan_status = 'clean'
           AND fv.released_at IS NOT NULL AND fv.deleted_at IS NULL
         ORDER BY fa.created_at, fa.id
      `,
      )
        .bind(selected.id, viewer.eventId, viewer.personId)
        .all<{
          id: string;
          versionId: string;
          kind: string;
          filename: string;
          contentType: string;
          sizeBytes: number;
        }>(),
    ]);
    if (!source) {
      throw new Error(
        `Evaluation assignment ${selected.id} lost its source target.`,
      );
    }
    let submissionView;
    let selectedSubmissionSnapshot: ReturnType<
      typeof requireSubmittedSnapshot
    > | null = null;
    if (source.submissionId) {
      const snapshot = requireSubmittedSnapshot(
        source.submissionId,
        source.submissionSnapshotJson,
      );
      selectedSubmissionSnapshot = snapshot;
      const answers = reviewerVisibleAnswers(snapshot.schema, snapshot.answers);
      submissionView = {
        sourceType: "submission" as const,
        id: source.submissionId,
        title:
          summaryAnswer(answers.title) ??
          (selected.blindedReviewing
            ? "Blinded proposal"
            : "Proposal title restricted"),
        category: summaryAnswer(answers.category),
        format: summaryAnswer(answers.format),
        answers,
        answerFields: snapshot.schema.fields
          .filter((field) => Object.hasOwn(answers, field.id))
          .map((field) => ({
            id: field.id,
            label: field.label,
            value: answers[field.id],
          })),
        blindedReviewing: Boolean(selected.blindedReviewing),
        submitterEmail: selected.blindedReviewing
          ? null
          : (snapshot.speakers[0]?.email ?? null),
        speakerNames: selected.blindedReviewing
          ? []
          : snapshot.speakers.map((speaker) => speaker.name),
      };
    } else if (source.sessionId) {
      const snapshot = requireSessionReviewSnapshot(
        selected.id,
        source.sessionSnapshotJson,
      );
      const sessionAnswers = {
        description: snapshot.description ?? "",
        format: snapshot.format,
        durationMinutes: snapshot.durationMinutes,
        track: snapshot.trackName ?? "Unassigned",
      };
      submissionView = {
        sourceType: "session" as const,
        id: source.sessionId,
        title: snapshot.title,
        category: snapshot.trackName,
        format: snapshot.format,
        answers: sessionAnswers,
        answerFields: [
          {
            id: "description",
            label: "Description",
            value: sessionAnswers.description,
          },
          { id: "format", label: "Format", value: sessionAnswers.format },
          {
            id: "durationMinutes",
            label: "Duration",
            value: `${sessionAnswers.durationMinutes} minutes`,
          },
          { id: "track", label: "Track", value: sessionAnswers.track },
        ],
        blindedReviewing: Boolean(selected.blindedReviewing),
        submitterEmail: null,
        speakerNames: selected.blindedReviewing
          ? []
          : snapshot.speakers.map((speaker) => speaker.name),
      };
    } else {
      throw new Error(
        `Evaluation assignment ${selected.id} has no source target.`,
      );
    }
    return {
      assignments: reviewerAssignments,
      selected,
      criteria: criteria.results.map((criterion) => ({
        ...criterion,
        required: Boolean(criterion.required),
      })),
      submission: submissionView,
      review: review
        ? {
            ...review,
            scores: JSON.parse(review.scoresJson) as Record<
              string,
              string | number | boolean
            >,
          }
        : null,
      attachments: attachments.results
        .filter(
          (attachment) =>
            !selectedSubmissionSnapshot ||
            reviewerCanSeeSubmissionAttachment(
              selectedSubmissionSnapshot,
              attachment.id,
              attachment.versionId,
            ),
        )
        .map(({ versionId: _versionId, ...attachment }) => ({
          ...attachment,
          downloadHref: `/review/files/${encodeURIComponent(attachment.id)}`,
        })),
    };
  }

  async downloadReviewerAttachment(viewer: Viewer, assetId: string) {
    return this.readAuthoritative(viewer, () =>
      this.downloadReviewerAttachmentD1(viewer, assetId),
    );
  }

  protected async downloadReviewerAttachmentD1(
    viewer: Viewer,
    assetId: string,
  ) {
    await this.assertViewerEvent(viewer);
    const manager =
      viewer.role === "owner" ||
      viewer.role === "administrator" ||
      viewer.role === "committee_chair";
    const version = await this.env.DB.prepare(
      `
      SELECT fv.id AS versionId, fv.object_key AS objectKey,
             fv.object_etag AS objectEtag, fa.target_type AS targetType,
             fa.target_id AS targetId,
             submission.submitted_snapshot_json AS submissionSnapshotJson,
             fv.original_filename AS filename,
             COALESCE(fv.detected_content_type, fv.declared_content_type) AS contentType
        FROM file_assets fa
        JOIN file_versions fv
          ON fv.id = fa.current_version_id AND fv.event_id = fa.event_id
        JOIN events e ON e.id = fa.event_id AND e.organisation_id = ?
        LEFT JOIN submissions submission
          ON submission.id = fa.target_id
         AND submission.event_id = fa.event_id
         AND fa.target_type = 'submission'
       WHERE fa.id = ? AND fa.event_id = ?
         AND fa.target_type IN ('submission','session')
         AND fa.status = 'active' AND fv.upload_status = 'uploaded'
         AND fv.signature_status = 'valid' AND fv.scan_status = 'clean'
         AND fv.released_at IS NOT NULL AND fv.deleted_at IS NULL
         AND (
           ? = 1 OR EXISTS (
             SELECT 1 FROM evaluator_assignments a
              WHERE a.event_id = fa.event_id
                AND (
                  (fa.target_type = 'submission'
                   AND a.submission_id = fa.target_id)
                  OR
                  (fa.target_type = 'session' AND a.session_id = fa.target_id)
                )
                AND a.evaluator_person_id = ?
                AND a.status NOT IN ('recused','cancelled')
           )
         )
    `,
    )
      .bind(
        viewer.organisationId,
        assetId,
        viewer.eventId,
        manager ? 1 : 0,
        viewer.personId,
      )
      .first<{
        versionId: string;
        objectKey: string;
        objectEtag: string | null;
        targetType: "submission" | "session";
        targetId: string;
        submissionSnapshotJson: string | null;
        filename: string;
        contentType: string;
      }>();
    if (!version) {
      throw new Response("Review attachment not found.", { status: 404 });
    }
    if (!manager && version.targetType === "submission") {
      const snapshot = parseSubmittedSnapshot(version.submissionSnapshotJson);
      if (
        !snapshot ||
        !reviewerCanSeeSubmissionAttachment(
          snapshot,
          assetId,
          version.versionId,
        )
      ) {
        throw new Response("Review attachment not found.", { status: 404 });
      }
    }
    const object = await this.env.FILES.get(version.objectKey);
    if (
      !object ||
      !version.objectEtag ||
      object.httpEtag !== version.objectEtag
    ) {
      throw new Error(
        `Released review attachment ${assetId} is missing or differs from its scanned object.`,
      );
    }
    const filename = version.filename.replace(/[\r\n"\\]/gu, "_");
    const headers = new Headers();
    headers.set("Content-Type", version.contentType);
    headers.set(
      "Content-Disposition",
      `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(version.filename)}`,
    );
    headers.set("Cache-Control", "private, no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    if (object.httpEtag) headers.set("ETag", object.httpEtag);
    return new Response(object.body, { headers });
  }

  async saveReview(viewer: Viewer, input: unknown) {
    return this.projectCommand(
      viewer,
      "evaluation.review.save",
      input,
      undefined,
      () => this.saveReviewD1(viewer, input),
    );
  }

  protected async saveReviewD1(viewer: Viewer, input: unknown) {
    await this.assertViewerEvent(viewer);
    const parsed = reviewDraftSchema.parse(input);
    const assignment = await this.env.DB.prepare(
      `
      SELECT a.id, a.status, a.revision,
             a.submission_id AS submissionId, a.session_id AS sessionId,
             a.round_id AS roundId
        FROM evaluator_assignments a
        JOIN evaluation_rounds r ON r.id = a.round_id AND r.event_id = a.event_id
        LEFT JOIN submissions submission
          ON submission.id = a.submission_id
         AND submission.event_id = a.event_id
        LEFT JOIN sessions session
          ON session.id = a.session_id AND session.event_id = a.event_id
       WHERE a.id = ? AND a.event_id = ? AND a.evaluator_person_id = ? AND a.status IN ('assigned','in_progress','reopened') AND r.status = 'active'
         AND (
           (a.submission_id IS NOT NULL
            AND submission.status IN ('submitted','assigned','in_review','decision_ready'))
           OR
           (a.session_id IS NOT NULL
            AND session.status NOT IN ('cancelled','archived'))
         )
    `,
    )
      .bind(parsed.assignmentId, viewer.eventId, viewer.personId)
      .first<{
        id: string;
        status: string;
        revision: number;
        submissionId: string | null;
        sessionId: string | null;
        roundId: string;
      }>();
    if (!assignment)
      throw new EvaluationStateError(
        "This assignment is unavailable or already submitted.",
      );
    const criteria = await this.env.DB.prepare(
      `SELECT id, input_type AS inputType, weight_percent AS weightPercent, required FROM evaluation_criteria WHERE event_id = ? AND round_id = ? ORDER BY position`,
    )
      .bind(viewer.eventId, assignment.roundId)
      .all<{
        id: string;
        inputType: "scale_5" | "scale_10" | "yes_no" | "free_text";
        weightPercent: number;
        required: number | boolean;
      }>();
    const criterionIds = new Set(
      criteria.results.map((criterion) => criterion.id),
    );
    const unknownScoreIds = Object.keys(parsed.scores).filter(
      (criterionId) => !criterionIds.has(criterionId),
    );
    if (unknownScoreIds.length) {
      throw new EvaluationValidationError(
        "The review contains scores for criteria that are not in this evaluation round. Refresh before saving.",
      );
    }
    const responses: Record<string, string | number | boolean> = {};
    for (const criterion of criteria.results) {
      const raw = parsed.scores[criterion.id];
      const empty =
        raw === undefined || (typeof raw === "string" && raw.trim() === "");
      if (empty) {
        if (parsed.intent === "submit" && Boolean(criterion.required)) {
          throw new EvaluationValidationError(
            "Complete every required rubric criterion before submitting the review.",
          );
        }
        continue;
      }
      if (
        criterion.inputType === "scale_5" ||
        criterion.inputType === "scale_10"
      ) {
        const value = typeof raw === "number" ? raw : Number(raw);
        const maximum = criterion.inputType === "scale_10" ? 10 : 5;
        if (!Number.isInteger(value) || value < 1 || value > maximum) {
          throw new EvaluationValidationError(
            `A rubric score must be a whole number from 1 to ${maximum}.`,
          );
        }
        responses[criterion.id] = value;
      } else if (criterion.inputType === "yes_no") {
        if (raw !== "yes" && raw !== "no" && typeof raw !== "boolean") {
          throw new EvaluationValidationError(
            "A yes/no rubric response must be yes or no.",
          );
        }
        responses[criterion.id] =
          typeof raw === "boolean" ? raw : raw === "yes";
      } else {
        if (typeof raw !== "string") {
          throw new EvaluationValidationError(
            "A free-text rubric response must be text.",
          );
        }
        responses[criterion.id] = raw.trim();
      }
    }
    const scaledCriteria = criteria.results
      .filter(
        (criterion) =>
          criterion.inputType === "scale_5" ||
          criterion.inputType === "scale_10",
      )
      .map((criterion) => ({
        id: criterion.id,
        weightPercent: criterion.weightPercent,
        inputType: criterion.inputType as "scale_5" | "scale_10",
      }));
    const weightedScore =
      parsed.intent === "submit"
        ? calculateRubricWeightedScore(scaledCriteria, responses)
        : null;
    const existing = await this.env.DB.prepare(
      "SELECT id, revision, status FROM reviews WHERE event_id = ? AND assignment_id = ?",
    )
      .bind(viewer.eventId, assignment.id)
      .first<{ id: string; revision: number; status: string }>();
    if ((existing?.revision ?? 0) !== parsed.revision)
      throw new EvaluationRevisionConflictError();
    const reviewId = existing?.id ?? crypto.randomUUID();
    const nextRevision = parsed.revision + 1;
    const operationId = crypto.randomUUID();
    const status = parsed.intent === "submit" ? "submitted" : "draft";
    const auditEventId = crypto.randomUUID();
    const webhookService = new WebhookService(this.env);
    const preparedWebhook =
      parsed.intent === "submit"
        ? await webhookService.prepareEventForAudit(
            viewer,
            {
              eventType: "review.submitted",
              entityType: "review",
              entityId: reviewId,
              idempotencyKey: `review.submitted:${reviewId}:${nextRevision}`,
              correlationId: operationId,
              data: {
                assignmentId: assignment.id,
                revision: nextRevision,
                weightedScore,
              },
            },
            auditEventId,
          )
        : null;
    const reviewMutation = existing
      ? this.env.DB.prepare(
          `
      UPDATE reviews SET status = ?, scores_json = ?, weighted_score = ?, recommendation = ?, confidence = ?,
             submitter_feedback = ?, private_notes = ?, revision = revision + 1, last_operation_id = ?,
             updated_at = unixepoch(), submitted_at = CASE WHEN ? = 'submitted' THEN unixepoch() ELSE submitted_at END,
             locked_at = CASE WHEN ? = 'submitted' THEN unixepoch() ELSE locked_at END
       WHERE id = ? AND event_id = ? AND revision = ? AND status IN ('draft','reopened')
         AND EXISTS (
           SELECT 1 FROM evaluator_assignments assignment
           LEFT JOIN submissions active_submission
             ON active_submission.id = assignment.submission_id
            AND active_submission.event_id = assignment.event_id
           LEFT JOIN sessions active_session
             ON active_session.id = assignment.session_id
            AND active_session.event_id = assignment.event_id
            WHERE assignment.id = ? AND assignment.event_id = ?
              AND assignment.evaluator_person_id = ? AND assignment.revision = ?
              AND assignment.status IN ('assigned','in_progress','reopened')
              AND (
                (assignment.submission_id IS NOT NULL
                 AND active_submission.status IN ('submitted','assigned','in_review','decision_ready'))
                OR
                (assignment.session_id IS NOT NULL
                 AND active_session.status NOT IN ('cancelled','archived'))
              )
         )
    `,
        ).bind(
          status,
          JSON.stringify(responses),
          weightedScore,
          parsed.recommendation,
          parsed.confidence,
          parsed.submitterFeedback || null,
          parsed.privateNotes || null,
          operationId,
          status,
          status,
          reviewId,
          viewer.eventId,
          parsed.revision,
          assignment.id,
          viewer.eventId,
          viewer.personId,
          assignment.revision,
        )
      : this.env.DB.prepare(
          `
      INSERT INTO reviews (id, event_id, assignment_id, status, scores_json, weighted_score, recommendation, confidence, submitter_feedback, private_notes, revision, last_operation_id, created_at, updated_at, submitted_at, locked_at)
      SELECT ?, ?, assignment.id, ?, ?, ?, ?, ?, ?, ?, 1, ?, unixepoch(), unixepoch(),
             CASE WHEN ? = 'submitted' THEN unixepoch() END,
             CASE WHEN ? = 'submitted' THEN unixepoch() END
        FROM evaluator_assignments assignment
        LEFT JOIN submissions active_submission
          ON active_submission.id = assignment.submission_id
         AND active_submission.event_id = assignment.event_id
        LEFT JOIN sessions active_session
          ON active_session.id = assignment.session_id
         AND active_session.event_id = assignment.event_id
       WHERE assignment.id = ? AND assignment.event_id = ?
         AND assignment.evaluator_person_id = ? AND assignment.revision = ?
         AND assignment.status IN ('assigned','in_progress','reopened')
         AND (
           (assignment.submission_id IS NOT NULL
            AND active_submission.status IN ('submitted','assigned','in_review','decision_ready'))
           OR
           (assignment.session_id IS NOT NULL
            AND active_session.status NOT IN ('cancelled','archived'))
         )
    `,
        ).bind(
          reviewId,
          viewer.eventId,
          status,
          JSON.stringify(responses),
          weightedScore,
          parsed.recommendation,
          parsed.confidence,
          parsed.submitterFeedback || null,
          parsed.privateNotes || null,
          operationId,
          status,
          status,
          assignment.id,
          viewer.eventId,
          viewer.personId,
          assignment.revision,
        );
    const [saved, assignmentUpdated] = await this.env.DB.batch([
      reviewMutation,
      this.env.DB.prepare(
        `
        UPDATE evaluator_assignments
           SET status = ?, revision = revision + 1, last_operation_id = ?,
               submitted_at = CASE WHEN ? = 'submitted' THEN unixepoch() ELSE submitted_at END
         WHERE id = ? AND event_id = ? AND evaluator_person_id = ? AND revision = ?
           AND status IN ('assigned','in_progress','reopened')
           AND EXISTS (SELECT 1 FROM reviews WHERE id = ? AND last_operation_id = ?)
      `,
      ).bind(
        parsed.intent === "submit" ? "submitted" : "in_progress",
        operationId,
        status,
        assignment.id,
        viewer.eventId,
        viewer.personId,
        assignment.revision,
        reviewId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO review_revisions (id, event_id, review_id, revision_number, scores_json, content_json, save_kind, saved_by_person_id, idempotency_key, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch()
         WHERE EXISTS (SELECT 1 FROM reviews WHERE id = ? AND last_operation_id = ?)
           AND EXISTS (SELECT 1 FROM evaluator_assignments WHERE id = ? AND last_operation_id = ?)
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.eventId,
        reviewId,
        nextRevision,
        JSON.stringify(responses),
        JSON.stringify({
          recommendation: parsed.recommendation,
          confidence: parsed.confidence,
          submitterFeedback: parsed.submitterFeedback,
          privateNotes: parsed.privateNotes,
        }),
        parsed.intent === "submit" ? "submitted" : "manual",
        viewer.personId,
        operationId,
        reviewId,
        operationId,
        assignment.id,
        operationId,
      ),
      this.env.DB.prepare(
        `UPDATE submissions SET status = 'in_review', revision = revision + 1, updated_at = unixepoch() WHERE id = ? AND event_id = ? AND status IN ('assigned','submitted') AND EXISTS (SELECT 1 FROM reviews WHERE id = ? AND last_operation_id = ?) AND EXISTS (SELECT 1 FROM evaluator_assignments WHERE id = ? AND last_operation_id = ?)`,
      ).bind(
        assignment.submissionId,
        viewer.eventId,
        reviewId,
        operationId,
        assignment.id,
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at) SELECT ?, ?, ?, ?, ?, 'review', ?, ?, unixepoch() WHERE EXISTS (SELECT 1 FROM reviews WHERE id = ? AND last_operation_id = ?) AND EXISTS (SELECT 1 FROM evaluator_assignments WHERE id = ? AND last_operation_id = ?)`,
      ).bind(
        auditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.intent === "submit" ? "review.submitted" : "review.saved",
        reviewId,
        JSON.stringify({ revision: nextRevision }),
        reviewId,
        operationId,
        assignment.id,
        operationId,
      ),
      ...(preparedWebhook?.statements ?? []),
    ]);
    if (
      (saved.meta.changes ?? 0) !== 1 ||
      (assignmentUpdated.meta.changes ?? 0) !== 1
    )
      throw new EvaluationRevisionConflictError();
    const webhookDeliveries = preparedWebhook
      ? await webhookService.dispatchPreparedEvent(preparedWebhook)
      : [];
    const nextAssignment =
      parsed.intent === "submit"
        ? await this.env.DB.prepare(
            `
            SELECT a.id
              FROM evaluator_assignments a
              JOIN evaluation_rounds r
                ON r.id = a.round_id AND r.event_id = a.event_id
             WHERE a.event_id = ? AND a.evaluator_person_id = ?
               AND a.id <> ? AND a.status IN ('assigned','in_progress','reopened')
               AND r.status = 'active'
             ORDER BY CASE a.status WHEN 'in_progress' THEN 0 WHEN 'reopened' THEN 1 ELSE 2 END,
                      a.due_at, a.assigned_at
             LIMIT 1
          `,
          )
            .bind(viewer.eventId, viewer.personId, assignment.id)
            .first<{ id: string }>()
        : null;
    return {
      reviewId,
      revision: nextRevision,
      weightedScore,
      nextAssignmentId: nextAssignment?.id ?? null,
      webhookDeliveries,
    };
  }

  async declareConflict(viewer: Viewer, input: unknown) {
    return this.projectCommand(
      viewer,
      "evaluation.conflict.declare",
      input,
      undefined,
      () => this.declareConflictD1(viewer, input),
    );
  }

  protected async declareConflictD1(viewer: Viewer, input: unknown) {
    await this.assertViewerEvent(viewer);
    const parsed = conflictDeclarationSchema.parse(input);
    const assignment = await this.env.DB.prepare(
      `SELECT id, revision, round_id AS roundId,
              submission_id AS submissionId, session_id AS sessionId
         FROM evaluator_assignments
        WHERE id = ? AND event_id = ? AND evaluator_person_id = ?
          AND status IN ('assigned','in_progress')`,
    )
      .bind(parsed.assignmentId, viewer.eventId, viewer.personId)
      .first<{
        id: string;
        revision: number;
        roundId: string;
        submissionId: string | null;
        sessionId: string | null;
      }>();
    if (!assignment)
      throw new EvaluationStateError(
        "Assignment not found or cannot be recused.",
      );
    const operationId = crypto.randomUUID();
    const conflictTargetColumn = assignment.submissionId
      ? "submission_id"
      : "session_id";
    const conflictTargetId = assignment.submissionId ?? assignment.sessionId;
    if (!conflictTargetId) {
      throw new Error(`Evaluation assignment ${assignment.id} has no target.`);
    }
    const [recused] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE evaluator_assignments
           SET status = 'recused', conflict_declared_at = unixepoch(),
               revision = revision + 1, last_operation_id = ?
         WHERE id = ? AND event_id = ? AND evaluator_person_id = ?
           AND revision = ? AND status IN ('assigned','in_progress')
      `,
      ).bind(
        operationId,
        assignment.id,
        viewer.eventId,
        viewer.personId,
        assignment.revision,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO evaluator_conflicts (
          id, event_id, round_id, submission_id, session_id,
          evaluator_person_id,
          relationship, notes, status, declared_at
        )
        SELECT ?, ?, ?, ?, ?, ?, 'declared', ?, 'recused', unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM evaluator_assignments
            WHERE id = ? AND event_id = ? AND last_operation_id = ?
         )
        ON CONFLICT(round_id, ${conflictTargetColumn}, evaluator_person_id)
        WHERE ${conflictTargetColumn} IS NOT NULL DO UPDATE SET
          notes = excluded.notes, status = 'recused', declared_at = unixepoch()
        WHERE EXISTS (
          SELECT 1 FROM evaluator_assignments
           WHERE id = ? AND event_id = ? AND last_operation_id = ?
        )
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.eventId,
        assignment.roundId,
        assignment.submissionId,
        assignment.sessionId,
        viewer.personId,
        parsed.reason,
        assignment.id,
        viewer.eventId,
        operationId,
        assignment.id,
        viewer.eventId,
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at) SELECT ?, ?, ?, ?, 'review.conflict.declared', 'evaluator_assignment', ?, '{}', unixepoch() WHERE EXISTS (SELECT 1 FROM evaluator_assignments WHERE id = ? AND event_id = ? AND last_operation_id = ?)`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        assignment.id,
        assignment.id,
        viewer.eventId,
        operationId,
      ),
    ]);
    if ((recused.meta.changes ?? 0) !== 1) {
      throw new EvaluationRevisionConflictError(
        "This assignment changed before the conflict could be recorded.",
      );
    }
  }

  async moderate(viewer: Viewer, input: unknown) {
    return this.projectCommand(
      viewer,
      "evaluation.review.moderate",
      input,
      undefined,
      () => this.moderateD1(viewer, input),
    );
  }

  protected async moderateD1(viewer: Viewer, input: unknown) {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationManager(viewer);
    const parsed = moderationSchema.parse(input);
    if (parsed.status === "confirmed" && !parsed.confirmed) {
      throw new EvaluationValidationError(
        "Confirm the moderation effect before locking it.",
      );
    }
    const current = await this.env.DB.prepare(
      `
      SELECT id, status FROM review_moderations
       WHERE event_id = ? AND round_id = ? AND submission_id = ?
         AND status IN ('draft','confirmed')
    `,
    )
      .bind(viewer.eventId, parsed.roundId, parsed.submissionId)
      .first<{ id: string; status: "draft" | "confirmed" }>();
    if ((current?.id ?? null) !== parsed.expectedModerationId) {
      throw new EvaluationRevisionConflictError(
        "The moderation changed after it was loaded. Refresh before saving again.",
      );
    }
    if (
      current?.status === "confirmed" &&
      (parsed.status !== "confirmed" || !parsed.confirmed)
    ) {
      throw new EvaluationStateError(
        "A confirmed moderation can only be replaced by another explicitly confirmed moderation.",
      );
    }
    const moderationId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const currentPredicate = current
      ? `EXISTS (
           SELECT 1 FROM review_moderations current_moderation
            WHERE current_moderation.id = ?
              AND current_moderation.event_id = events.id
              AND current_moderation.round_id = ?
              AND current_moderation.submission_id = ?
              AND current_moderation.status IN ('draft','confirmed')
         )`
      : `NOT EXISTS (
           SELECT 1 FROM review_moderations current_moderation
            WHERE current_moderation.event_id = events.id
              AND current_moderation.round_id = ?
              AND current_moderation.submission_id = ?
              AND current_moderation.status IN ('draft','confirmed')
         )`;
    const currentBindings = current
      ? [current.id, parsed.roundId, parsed.submissionId]
      : [parsed.roundId, parsed.submissionId];
    const [claimed] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE events SET last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND organisation_id = ?
           AND EXISTS (
             SELECT 1 FROM evaluation_rounds active_round
              WHERE active_round.id = ? AND active_round.event_id = events.id
                AND active_round.status = 'active'
           )
           AND EXISTS (
             SELECT 1 FROM submissions candidate
              WHERE candidate.id = ? AND candidate.event_id = events.id
                AND candidate.status IN ('assigned','in_review','decision_ready')
           )
           AND EXISTS (
             SELECT 1 FROM evaluator_assignments assignment
             JOIN reviews completed_review
               ON completed_review.assignment_id = assignment.id
              AND completed_review.event_id = assignment.event_id
              AND completed_review.status IN ('submitted','locked')
              WHERE assignment.event_id = events.id
                AND assignment.round_id = ?
                AND assignment.submission_id = ?
           )
           AND ${currentPredicate}
      `,
      ).bind(
        operationId,
        viewer.eventId,
        viewer.organisationId,
        parsed.roundId,
        parsed.submissionId,
        parsed.roundId,
        parsed.submissionId,
        ...currentBindings,
      ),
      this.env.DB.prepare(
        `
        UPDATE review_moderations SET status = 'superseded',
               updated_at = unixepoch()
         WHERE event_id = ? AND round_id = ? AND submission_id = ?
           AND status IN ('draft','confirmed')
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        viewer.eventId,
        parsed.roundId,
        parsed.submissionId,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO review_moderations (
          id, event_id, round_id, submission_id, moderator_person_id,
          status, recommendation, moderated_score, notes,
          created_at, updated_at, confirmed_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch(),
               CASE WHEN ? = 'confirmed' THEN unixepoch() END
         WHERE EXISTS (
           SELECT 1 FROM events
            WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
         )
      `,
      ).bind(
        moderationId,
        viewer.eventId,
        parsed.roundId,
        parsed.submissionId,
        viewer.personId,
        parsed.status,
        parsed.recommendation,
        parsed.moderatedScore,
        parsed.notes,
        parsed.status,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        UPDATE submissions SET status = 'decision_ready',
               revision = revision + 1, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND status IN ('assigned','in_review')
           AND ? = 'confirmed'
           AND EXISTS (
             SELECT 1 FROM review_moderations
              WHERE id = ? AND event_id = ? AND status = 'confirmed'
           )
      `,
      ).bind(
        parsed.submissionId,
        viewer.eventId,
        parsed.status,
        moderationId,
        viewer.eventId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, ?, 'review_moderation', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM review_moderations WHERE id = ? AND event_id = ?
         )
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.status === "confirmed"
          ? "review.moderation.confirmed"
          : "review.moderation.saved",
        moderationId,
        JSON.stringify({
          submissionId: parsed.submissionId,
          roundId: parsed.roundId,
          recommendation: parsed.recommendation,
          supersededModerationId: current?.id ?? null,
        }),
        moderationId,
        viewer.eventId,
      ),
    ]);
    if ((claimed.meta.changes ?? 0) !== 1) {
      throw new EvaluationRevisionConflictError(
        "The round, submission, reviews, or moderation changed before the moderation could be saved.",
      );
    }
    return moderationId;
  }

  async reopenReview(viewer: Viewer, input: unknown) {
    return this.projectCommand(
      viewer,
      "evaluation.review.reopen",
      input,
      undefined,
      () => this.reopenReviewD1(viewer, input),
    );
  }

  protected async reopenReviewD1(viewer: Viewer, input: unknown) {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationManager(viewer);
    const parsed = reviewReopenSchema.parse(input);
    const state = await this.env.DB.prepare(
      `
      SELECT a.id, a.revision AS assignmentRevision,
             a.round_id AS roundId, a.submission_id AS submissionId,
             r.id AS reviewId, r.revision AS reviewRevision,
             r.scores_json AS scoresJson, r.recommendation, r.confidence,
             r.submitter_feedback AS submitterFeedback,
             r.private_notes AS privateNotes
        FROM evaluator_assignments a
        JOIN reviews r ON r.assignment_id = a.id AND r.event_id = a.event_id
        JOIN evaluation_rounds round
          ON round.id = a.round_id AND round.event_id = a.event_id
       WHERE a.id = ? AND a.event_id = ?
         AND a.status = 'submitted' AND r.status IN ('submitted','locked')
         AND round.status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM submission_decisions final_decision
            WHERE final_decision.event_id = a.event_id
              AND final_decision.submission_id = a.submission_id
              AND final_decision.status = 'published'
         )
    `,
    )
      .bind(parsed.assignmentId, viewer.eventId)
      .first<{
        id: string;
        assignmentRevision: number;
        roundId: string;
        submissionId: string | null;
        reviewId: string;
        reviewRevision: number;
        scoresJson: string;
        recommendation: string | null;
        confidence: number | null;
        submitterFeedback: string | null;
        privateNotes: string | null;
      }>();
    if (!state) {
      throw new EvaluationStateError(
        "Only a submitted review in the active round can be reopened, and released decisions remain final.",
      );
    }
    const operationId = crypto.randomUUID();
    const nextRevision = state.reviewRevision + 1;
    const auditEventId = crypto.randomUUID();
    const webhookService = new WebhookService(this.env);
    const preparedWebhook = await webhookService.prepareEventForAudit(
      viewer,
      {
        eventType: "review.reopened",
        entityType: "review",
        entityId: state.reviewId,
        idempotencyKey: `review.reopened:${state.reviewId}:${nextRevision}`,
        correlationId: operationId,
        data: { assignmentId: state.id, revision: nextRevision },
      },
      auditEventId,
    );
    const [assignmentUpdated, reviewUpdated] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE evaluator_assignments
           SET status = 'reopened', revision = revision + 1,
               last_operation_id = ?
         WHERE id = ? AND event_id = ? AND revision = ? AND status = 'submitted'
           AND EXISTS (
             SELECT 1 FROM evaluation_rounds
              WHERE id = ? AND event_id = ? AND status = 'active'
           )
           AND NOT EXISTS (
             SELECT 1 FROM submission_decisions
              WHERE event_id = ? AND submission_id = ? AND status = 'published'
           )
      `,
      ).bind(
        operationId,
        state.id,
        viewer.eventId,
        state.assignmentRevision,
        state.roundId,
        viewer.eventId,
        viewer.eventId,
        state.submissionId,
      ),
      this.env.DB.prepare(
        `
        UPDATE reviews SET status = 'reopened', revision = revision + 1,
               locked_at = NULL, last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND revision = ?
           AND status IN ('submitted','locked')
           AND EXISTS (
             SELECT 1 FROM evaluator_assignments
              WHERE id = ? AND event_id = ? AND status = 'reopened'
                AND last_operation_id = ?
           )
      `,
      ).bind(
        operationId,
        state.reviewId,
        viewer.eventId,
        state.reviewRevision,
        state.id,
        viewer.eventId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO review_revisions (
          id, event_id, review_id, revision_number, scores_json,
          content_json, save_kind, saved_by_person_id, idempotency_key,
          created_at
        )
        SELECT ?, ?, ?, ?, ?, ?, 'reopened', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM reviews
            WHERE id = ? AND event_id = ? AND status = 'reopened'
              AND revision = ? AND last_operation_id = ?
         )
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.eventId,
        state.reviewId,
        nextRevision,
        state.scoresJson,
        JSON.stringify({
          recommendation: state.recommendation,
          confidence: state.confidence,
          submitterFeedback: state.submitterFeedback,
          privateNotes: state.privateNotes,
          reopenReason: parsed.reason,
        }),
        viewer.personId,
        operationId,
        state.reviewId,
        viewer.eventId,
        nextRevision,
        operationId,
      ),
      this.env.DB.prepare(
        `
        UPDATE review_moderations SET status = 'superseded',
               updated_at = unixepoch()
         WHERE event_id = ? AND round_id = ? AND submission_id = ?
           AND status IN ('draft','confirmed')
           AND EXISTS (
             SELECT 1 FROM reviews
              WHERE id = ? AND event_id = ? AND status = 'reopened'
                AND last_operation_id = ?
           )
      `,
      ).bind(
        viewer.eventId,
        state.roundId,
        state.submissionId,
        state.reviewId,
        viewer.eventId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        UPDATE submissions SET status = 'in_review',
               revision = revision + 1, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND status = 'decision_ready'
           AND EXISTS (
             SELECT 1 FROM reviews
              WHERE id = ? AND event_id = ? AND status = 'reopened'
                AND last_operation_id = ?
           )
      `,
      ).bind(
        state.submissionId,
        viewer.eventId,
        state.reviewId,
        viewer.eventId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, 'review.reopened', 'review', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM reviews
            WHERE id = ? AND event_id = ? AND status = 'reopened'
              AND last_operation_id = ?
         )
      `,
      ).bind(
        auditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        state.reviewId,
        JSON.stringify({
          assignmentId: state.id,
          reason: parsed.reason,
          revision: nextRevision,
        }),
        state.reviewId,
        viewer.eventId,
        operationId,
      ),
      ...preparedWebhook.statements,
    ]);
    if (
      (assignmentUpdated.meta.changes ?? 0) !== 1 ||
      (reviewUpdated.meta.changes ?? 0) !== 1
    ) {
      throw new EvaluationRevisionConflictError(
        "The review or assignment changed before it could be reopened.",
      );
    }
    const webhookDeliveries =
      await webhookService.dispatchPreparedEvent(preparedWebhook);
    return {
      reviewId: state.reviewId,
      revision: nextRevision,
      webhookDeliveries,
    };
  }
}
