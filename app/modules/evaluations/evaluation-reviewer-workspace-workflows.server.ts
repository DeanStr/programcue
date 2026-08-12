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

export abstract class EvaluationReviewerWorkspaceWorkflows extends EvaluationAssignmentWorkflows {
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
}
