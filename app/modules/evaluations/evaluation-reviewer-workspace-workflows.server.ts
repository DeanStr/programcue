import {
  formFieldsInDisplayOrder,
  reviewerVisibleAnswers,
} from "~/modules/submissions/submission-schema";
import type { Viewer } from "~/platform/auth/authorize.server";
import { EvaluationStateError } from "./evaluation-errors";
import { parseRecommendationChoicesJson } from "./evaluation-recommendation-choices";
import {
  blindReviewerVisibleAnswers,
  type Criterion,
  EvaluationServiceFoundation,
  parseSubmittedSnapshot,
  requireSessionReviewSnapshot,
  requireSubmittedSnapshot,
  reviewerCanSeeSubmissionAttachment,
  summaryAnswer,
} from "./evaluation-service-foundation.server";
import { reviewableSubmissionSql } from "./evaluation-submission-review-eligibility.server";

function reviewerAssignmentVisibleSql(
  assignmentAlias: "a",
  planAlias: "plan",
  roundAlias: "r" | "round",
  submissionAlias: "submission",
  sessionAlias: "session",
) {
  return `(
    ${assignmentAlias}.status = 'submitted'
    OR (
      ${planAlias}.status = 'active'
      AND ${roundAlias}.status = 'active'
      AND (${roundAlias}.opens_at IS NULL OR ${roundAlias}.opens_at <= unixepoch())
      AND (${roundAlias}.closes_at IS NULL OR ${roundAlias}.closes_at > unixepoch())
      AND (
        (${assignmentAlias}.submission_id IS NOT NULL
         AND ${reviewableSubmissionSql(submissionAlias, "review")})
        OR (${assignmentAlias}.session_id IS NOT NULL
            AND ${sessionAlias}.status NOT IN ('cancelled','archived'))
      )
    )
  )`;
}

function parseReviewerCriterionOptions(
  value: string,
  criterionId: string,
  inputType: string,
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new EvaluationStateError(
      `Criterion ${criterionId} has invalid persisted dropdown options.`,
    );
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((option) => typeof option !== "string" || !option.trim())
  ) {
    throw new EvaluationStateError(
      `Criterion ${criterionId} has invalid persisted dropdown options.`,
    );
  }
  if (inputType === "dropdown" && parsed.length === 0) {
    throw new EvaluationStateError(
      `Criterion ${criterionId} has no persisted dropdown options.`,
    );
  }
  if (inputType !== "dropdown" && parsed.length > 0) {
    throw new EvaluationStateError(
      `Criterion ${criterionId} has options but is not a dropdown.`,
    );
  }
  return parsed as string[];
}

function parseReviewAiCriterionIds(
  value: string,
  reviewId: string,
  field: "imported" | "confirmed",
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`Review ${reviewId} has invalid ${field} AI provenance.`);
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > 30 ||
    parsed.some(
      (item) =>
        typeof item !== "string" || item.length === 0 || item.length > 200,
    ) ||
    new Set(parsed).size !== parsed.length
  ) {
    throw new Error(`Review ${reviewId} has invalid ${field} AI provenance.`);
  }
  return parsed as string[];
}

export class EvaluationReviewerWorkspaceWorkflows extends EvaluationServiceFoundation {
  async getReviewerWorkspace(viewer: Viewer, selectedAssignmentId?: string) {
    return this.readAuthoritative(viewer, () =>
      this.getReviewerWorkspaceD1(viewer, selectedAssignmentId),
    );
  }

  async getReviewerWorkbench(viewer: Viewer, selectedAssignmentId?: string) {
    return this.readAuthoritative(viewer, async () => {
      let workspace: Awaited<ReturnType<typeof this.getReviewerWorkspaceD1>>;
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
        `SELECT name, timezone
           FROM events
          WHERE id = ? AND organisation_id = ?`,
      )
        .bind(viewer.eventId, viewer.organisationId)
        .first<{ name: string; timezone: string }>();
      if (!event) {
        throw new Response("This event could not be found.", { status: 404 });
      }
      return {
        kind: "ready" as const,
        eventName: event.name,
        eventTimezone: event.timezone,
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
      SELECT a.id, a.round_id AS roundId, a.status, a.revision, a.due_at AS dueAt,
             a.submission_id AS submissionId, a.session_id AS sessionId,
             submission.public_reference AS submissionReference,
             submission.submitted_snapshot_json AS submissionSnapshotJson,
             session.slug AS sessionReference,
             a.session_snapshot_json AS sessionSnapshotJson,
             r.blinded_reviewing AS blindedReviewing,
             r.scorecard_id AS scorecardId,
             r.scorecard_version AS scorecardVersion,
             r.recommendation_choices_json AS recommendationChoicesJson,
             r.opens_at AS opensAt, r.closes_at AS closesAt
        FROM evaluator_assignments a
        LEFT JOIN submissions submission
          ON submission.id = a.submission_id
         AND submission.event_id = a.event_id
        LEFT JOIN sessions session
          ON session.id = a.session_id AND session.event_id = a.event_id
        JOIN evaluation_rounds r ON r.id = a.round_id AND r.event_id = a.event_id
        JOIN evaluation_plans plan
          ON plan.id = r.plan_id AND plan.event_id = r.event_id
        JOIN evaluation_round_reviewers pool
          ON pool.event_id = a.event_id
         AND pool.round_id = a.round_id
         AND pool.person_id = a.evaluator_person_id
        JOIN memberships reviewer_membership
          ON reviewer_membership.event_id = a.event_id
         AND reviewer_membership.person_id = a.evaluator_person_id
         AND reviewer_membership.accepted_at IS NOT NULL
         AND reviewer_membership.revoked_at IS NULL
         AND reviewer_membership.role IN ('evaluator','committee_chair')
        JOIN events event ON event.id = a.event_id AND event.organisation_id = ?
       WHERE a.event_id = ? AND a.evaluator_person_id = ?
         AND a.status NOT IN ('recused','cancelled')
         AND ${reviewerAssignmentVisibleSql("a", "plan", "r", "submission", "session")}
       ORDER BY CASE a.status WHEN 'in_progress' THEN 0 WHEN 'reopened' THEN 0 WHEN 'assigned' THEN 1 ELSE 2 END,
                a.due_at, a.assigned_at
    `,
    )
      .bind(viewer.organisationId, viewer.eventId, viewer.personId)
      .all<{
        id: string;
        roundId: string;
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
        scorecardId: string;
        scorecardVersion: number;
        recommendationChoicesJson: string;
        opensAt: number | null;
        closesAt: number | null;
      }>();
    const reviewerAssignments = assignments.results.map(
      ({
        submissionSnapshotJson,
        sessionSnapshotJson,
        submissionReference,
        sessionReference,
        recommendationChoicesJson,
        ...assignment
      }) => {
        const recommendationChoices = parseRecommendationChoicesJson(
          recommendationChoicesJson,
          `Evaluation round ${assignment.roundId}`,
        );
        const blindedReviewing = Boolean(assignment.blindedReviewing);
        if (assignment.submissionId) {
          const snapshot = requireSubmittedSnapshot(
            assignment.submissionId,
            submissionSnapshotJson,
          );
          const answers = blindedReviewing
            ? blindReviewerVisibleAnswers(snapshot)
            : reviewerVisibleAnswers(snapshot.schema, snapshot.answers);
          return {
            ...assignment,
            ...(blindedReviewing ? {} : { submissionReference }),
            targetType: "submission" as const,
            targetId: assignment.submissionId,
            reference: blindedReviewing
              ? "Proposal · blinded"
              : submissionReference,
            title:
              summaryAnswer(answers.title) ??
              (blindedReviewing
                ? "Blinded proposal"
                : "Proposal title restricted"),
            category: summaryAnswer(answers.category),
            format: summaryAnswer(answers.format),
            blindedReviewing,
            recommendationChoices,
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
          ...(blindedReviewing ? {} : { sessionReference }),
          targetType: "session" as const,
          targetId: assignment.sessionId,
          reference: blindedReviewing
            ? "Session · blinded"
            : `Session · ${sessionReference}`,
          title: blindedReviewing ? "Blinded session" : snapshot.title,
          category: blindedReviewing ? null : snapshot.trackName,
          format: blindedReviewing ? null : snapshot.format,
          blindedReviewing,
          recommendationChoices,
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
        recommendationChoices: [],
        attachments: [],
      };
    const [criteria, source, review, attachments] = await Promise.all([
      this.env.DB.prepare(
        `
        SELECT c.id, c.name, c.description, c.input_type AS inputType,
               c.options_json AS optionsJson, c.weight_percent AS weightPercent,
               c.required, c.position
          FROM evaluation_criteria c
          JOIN evaluator_assignments a
            ON a.round_id = c.round_id AND a.event_id = c.event_id
          JOIN evaluation_rounds round
            ON round.id = a.round_id AND round.event_id = a.event_id
          JOIN evaluation_plans plan
            ON plan.id = round.plan_id AND plan.event_id = round.event_id
          JOIN evaluation_round_reviewers pool
            ON pool.round_id = a.round_id
           AND pool.event_id = a.event_id
           AND pool.person_id = a.evaluator_person_id
          JOIN events event ON event.id = a.event_id AND event.organisation_id = ?
         WHERE a.id = ? AND a.event_id = ? AND a.evaluator_person_id = ?
           AND (
             a.status = 'submitted'
             OR (plan.status = 'active' AND round.status = 'active')
           )
         ORDER BY c.position
      `,
      )
        .bind(
          viewer.organisationId,
          selected.id,
          viewer.eventId,
          viewer.personId,
        )
        .all<Omit<Criterion, "options"> & { optionsJson: string }>(),
      this.env.DB.prepare(
        `
        SELECT a.submission_id AS submissionId, a.session_id AS sessionId,
               submission.submitted_snapshot_json AS submissionSnapshotJson,
               a.session_snapshot_json AS sessionSnapshotJson
          FROM evaluator_assignments a
          LEFT JOIN submissions submission
            ON submission.id = a.submission_id
           AND submission.event_id = a.event_id
          LEFT JOIN sessions session
            ON session.id = a.session_id
           AND session.event_id = a.event_id
         JOIN evaluation_rounds round
           ON round.id = a.round_id AND round.event_id = a.event_id
         JOIN evaluation_plans plan
           ON plan.id = round.plan_id AND plan.event_id = round.event_id
         JOIN evaluation_round_reviewers pool
           ON pool.round_id = a.round_id
          AND pool.event_id = a.event_id
          AND pool.person_id = a.evaluator_person_id
         JOIN events event ON event.id = a.event_id AND event.organisation_id = ?
         WHERE a.id = ? AND a.event_id = ? AND a.evaluator_person_id = ?
           AND ${reviewerAssignmentVisibleSql("a", "plan", "round", "submission", "session")}
      `,
      )
        .bind(
          viewer.organisationId,
          selected.id,
          viewer.eventId,
          viewer.personId,
        )
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
               r.private_notes AS privateNotes,
               r.conflict_affirmed_at AS conflictAffirmedAt, r.revision,
               r.ai_suggestion_id AS aiSuggestionId,
               r.imported_criterion_ids_json AS importedCriterionIdsJson,
               r.confirmed_ai_criterion_ids_json AS confirmedAiCriterionIdsJson,
               r.recommendation_choices_snapshot_json AS recommendationChoicesSnapshotJson
          FROM reviews r
          JOIN evaluator_assignments a
            ON a.id = r.assignment_id AND a.event_id = r.event_id
          JOIN evaluation_rounds round
            ON round.id = a.round_id AND round.event_id = a.event_id
          JOIN evaluation_plans plan
            ON plan.id = round.plan_id AND plan.event_id = round.event_id
          JOIN evaluation_round_reviewers pool
            ON pool.event_id = a.event_id
           AND pool.round_id = a.round_id
           AND pool.person_id = a.evaluator_person_id
          JOIN events event ON event.id = a.event_id AND event.organisation_id = ?
         WHERE r.assignment_id = ? AND r.event_id = ? AND a.evaluator_person_id = ?
           AND (
             a.status = 'submitted'
             OR (plan.status = 'active' AND round.status = 'active')
           )
      `,
      )
        .bind(
          viewer.organisationId,
          selected.id,
          viewer.eventId,
          viewer.personId,
        )
        .first<{
          id: string;
          status: string;
          scoresJson: string;
          weightedScore: number | null;
          recommendation: string | null;
          confidence: number | null;
          submitterFeedback: string | null;
          privateNotes: string | null;
          conflictAffirmedAt: number | null;
          revision: number;
          aiSuggestionId: string | null;
          importedCriterionIdsJson: string;
          confirmedAiCriterionIdsJson: string;
          recommendationChoicesSnapshotJson: string;
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
          JOIN evaluation_rounds round
            ON round.id = a.round_id AND round.event_id = a.event_id
          JOIN evaluation_plans plan
            ON plan.id = round.plan_id AND plan.event_id = round.event_id
          LEFT JOIN submissions submission
            ON submission.id = a.submission_id
           AND submission.event_id = a.event_id
          LEFT JOIN sessions session
            ON session.id = a.session_id
           AND session.event_id = a.event_id
          JOIN evaluation_round_reviewers pool
            ON pool.event_id = a.event_id
           AND pool.round_id = a.round_id
           AND pool.person_id = a.evaluator_person_id
          JOIN events event ON event.id = a.event_id AND event.organisation_id = ?
         WHERE a.id = ? AND a.event_id = ? AND a.evaluator_person_id = ?
           AND a.status NOT IN ('recused','cancelled')
           AND round.blinded_reviewing = 0
           AND ${reviewerAssignmentVisibleSql("a", "plan", "round", "submission", "session")}
           AND fa.status = 'active'
           AND fv.upload_status = 'uploaded'
           AND fv.signature_status = 'valid' AND fv.scan_status = 'clean'
           AND fv.released_at IS NOT NULL AND fv.deleted_at IS NULL
         ORDER BY fa.created_at, fa.id
      `,
      )
        .bind(
          viewer.organisationId,
          selected.id,
          viewer.eventId,
          viewer.personId,
        )
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
    if (review) {
      const snapshot = parseRecommendationChoicesJson(
        review.recommendationChoicesSnapshotJson,
        `Review ${review.id}`,
      );
      if (
        JSON.stringify(snapshot) !==
        JSON.stringify(selected.recommendationChoices)
      ) {
        throw new EvaluationStateError(
          `Review ${review.id} does not match its assigned recommendation choices.`,
        );
      }
      if (
        review.recommendation !== null &&
        !snapshot.some((choice) => choice.id === review.recommendation)
      ) {
        throw new EvaluationStateError(
          `Review ${review.id} has an invalid persisted recommendation.`,
        );
      }
    }
    let selectedSubmissionSnapshot: ReturnType<
      typeof requireSubmittedSnapshot
    > | null = null;
    const submissionView = (() => {
      if (source.submissionId) {
        const snapshot = requireSubmittedSnapshot(
          source.submissionId,
          source.submissionSnapshotJson,
        );
        selectedSubmissionSnapshot = snapshot;
        const answers = selected.blindedReviewing
          ? blindReviewerVisibleAnswers(snapshot)
          : reviewerVisibleAnswers(snapshot.schema, snapshot.answers);
        return {
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
          answerFields: formFieldsInDisplayOrder(snapshot.schema)
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
      }
      if (source.sessionId) {
        const snapshot = requireSessionReviewSnapshot(
          selected.id,
          source.sessionSnapshotJson,
        );
        const sessionAnswers = selected.blindedReviewing
          ? {}
          : {
              description: snapshot.description ?? "",
              format: snapshot.format,
              durationMinutes: snapshot.durationMinutes,
              track: snapshot.trackName ?? "Unassigned",
            };
        return {
          sourceType: "session" as const,
          id: source.sessionId,
          title: selected.blindedReviewing ? "Blinded session" : snapshot.title,
          category: selected.blindedReviewing ? null : snapshot.trackName,
          format: selected.blindedReviewing ? null : snapshot.format,
          answers: sessionAnswers,
          answerFields: selected.blindedReviewing
            ? []
            : [
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
      }
      throw new Error(
        `Evaluation assignment ${selected.id} has no source target.`,
      );
    })();
    return {
      assignments: reviewerAssignments,
      selected,
      recommendationChoices: selected.recommendationChoices,
      criteria: criteria.results.map(({ optionsJson, ...criterion }) => ({
        ...criterion,
        options: parseReviewerCriterionOptions(
          optionsJson,
          criterion.id,
          criterion.inputType,
        ),
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
            importedCriterionIds: parseReviewAiCriterionIds(
              review.importedCriterionIdsJson,
              review.id,
              "imported",
            ),
            confirmedAiCriterionIds: parseReviewAiCriterionIds(
              review.confirmedAiCriterionIdsJson,
              review.id,
              "confirmed",
            ),
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
              JOIN evaluation_rounds round
                ON round.id = a.round_id AND round.event_id = a.event_id
              JOIN evaluation_plans plan
                ON plan.id = round.plan_id AND plan.event_id = round.event_id
              JOIN evaluation_round_reviewers pool
                ON pool.event_id = a.event_id
               AND pool.round_id = a.round_id
               AND pool.person_id = a.evaluator_person_id
              JOIN events assignment_event
                ON assignment_event.id = a.event_id
               AND assignment_event.organisation_id = ?
              WHERE a.event_id = fa.event_id
                AND (
                  (fa.target_type = 'submission'
                   AND a.submission_id = fa.target_id)
                  OR
                  (fa.target_type = 'session' AND a.session_id = fa.target_id)
                )
                AND a.evaluator_person_id = ?
                AND a.status NOT IN ('recused','cancelled')
                AND round.blinded_reviewing = 0
                AND (
                  a.status = 'submitted'
                  OR (
                    plan.status = 'active'
                    AND round.status = 'active'
                    AND (round.opens_at IS NULL OR round.opens_at <= unixepoch())
                    AND (round.closes_at IS NULL OR round.closes_at > unixepoch())
                    AND (
                      (
                        fa.target_type = 'session'
                        AND EXISTS (
                          SELECT 1 FROM sessions active_session
                           WHERE active_session.id = fa.target_id
                             AND active_session.event_id = fa.event_id
                             AND active_session.status NOT IN ('cancelled','archived')
                        )
                      )
                      OR (
                        fa.target_type = 'submission'
                        AND ${reviewableSubmissionSql("submission", "review")}
                      )
                    )
                  )
                )
           )
         )
    `,
    )
      .bind(
        viewer.organisationId,
        assetId,
        viewer.eventId,
        manager ? 1 : 0,
        viewer.organisationId,
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
