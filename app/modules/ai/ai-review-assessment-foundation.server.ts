import { parsePersistedRubricOptions } from "~/modules/evaluations/evaluation-service-foundation.server";
import { reviewableSubmissionSql } from "~/modules/evaluations/evaluation-submission-review-eligibility.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  AiReviewAssessmentIntentConflictError,
  AiReviewAssessmentStateError,
} from "./ai-review-assessment-errors";
import { AiReviewAssessmentOperationStore } from "./ai-review-assessment-operation-store.server";
import {
  type AiReviewAssessmentGenerationAttempt,
  AiReviewAssessmentReader,
} from "./ai-review-assessment-reader.server";
import {
  type AiReviewAssessmentDependencies,
  type AiReviewAssessmentRow,
  assessmentFromRow,
  type GenerationTarget,
  type PersistedCriterion,
  sha256,
} from "./ai-review-assessment-support.server";

export class AiReviewAssessmentFoundation {
  protected readonly now: () => Date;
  protected readonly reader: AiReviewAssessmentReader;
  protected readonly operations: AiReviewAssessmentOperationStore;

  constructor(
    protected readonly env: CloudflareEnvironment,
    protected readonly dependencies: AiReviewAssessmentDependencies = {},
  ) {
    this.now = dependencies.now ?? (() => new Date());
    this.reader = new AiReviewAssessmentReader(env, this.now);
    this.operations = new AiReviewAssessmentOperationStore(
      env,
      this.now,
      (viewer, assessmentId) => this.getById(viewer, assessmentId),
      (viewer) => this.assertViewerEvent(viewer),
    );
  }

  protected async assertViewerEvent(viewer: Viewer) {
    const event = await this.env.DB.prepare(
      `SELECT id, repository_provider AS repositoryProvider,
            participant_retention_completed_at AS retentionCompletedAt
       FROM events WHERE id = ? AND organisation_id = ?`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{
        id: string;
        repositoryProvider: string;
        retentionCompletedAt: number | null;
      }>();
    if (!event) {
      throw new Error("Event not found in the authorised organisation.");
    }
    if (event.repositoryProvider === "airtable") {
      throw new AiReviewAssessmentStateError(
        "AI first-pass assessments are unavailable while Airtable is the authoritative event repository.",
      );
    }
    if (event.repositoryProvider !== "d1") {
      throw new Error("The event repository provider is invalid.");
    }
    return event;
  }

  protected assessmentQuery(where: string) {
    return `SELECT assessment.id, assessment.event_id AS eventId,
                 assessment.round_id AS roundId, round.name AS roundName,
                 assessment.submission_id AS submissionId,
                 submission.title AS submissionTitle,
                 submission.public_reference AS submissionReference,
                 assessment.scorecard_id AS scorecardId,
                 assessment.scorecard_version AS scorecardVersion,
                 assessment.round_revision AS roundRevision,
                 assessment.submission_revision_id AS submissionRevisionId,
                 source_revision.revision_number AS submissionRevisionNumber,
                 assessment.source_snapshot_sha256 AS sourceSnapshotSha256,
                 assessment.model_input_sha256 AS modelInputSha256,
                 assessment.prompt_version AS promptVersion,
                 assessment.score, assessment.rationale,
                 assessment.provider, assessment.model,
                 assessment.provider_response_id AS providerResponseId,
                 assessment.generated_by_person_id AS generatedByPersonId,
                 generator.display_name AS generatedByName,
                 assessment.generated_at AS generatedAt,
                 assessment.override_score AS overrideScore,
                 assessment.override_rationale AS overrideRationale,
                 assessment.override_by_person_id AS overrideByPersonId,
                 overrider.display_name AS overrideByName,
                 assessment.override_at AS overrideAt,
                 assessment.revision, assessment.updated_at AS updatedAt
            FROM ai_review_assessments assessment
            JOIN evaluation_rounds round
              ON round.id = assessment.round_id
             AND round.event_id = assessment.event_id
            JOIN submissions submission
              ON submission.id = assessment.submission_id
             AND submission.event_id = assessment.event_id
            LEFT JOIN submission_revisions source_revision
              ON source_revision.id = assessment.submission_revision_id
             AND source_revision.event_id = assessment.event_id
             AND source_revision.submission_id = assessment.submission_id
            JOIN people generator
              ON generator.id = assessment.generated_by_person_id
            LEFT JOIN people overrider
              ON overrider.id = assessment.override_by_person_id
            JOIN events event
              ON event.id = assessment.event_id
             AND event.organisation_id = ?
           WHERE assessment.event_id = ? AND ${where}`;
  }

  listForEvent(viewer: Viewer) {
    return this.reader.listForEvent(viewer);
  }

  listGenerationAttempts(
    viewer: Viewer,
  ): Promise<AiReviewAssessmentGenerationAttempt[]> {
    return this.reader.listGenerationAttempts(viewer);
  }

  protected async getById(viewer: Viewer, assessmentId: string) {
    const row = await this.env.DB.prepare(
      this.assessmentQuery("assessment.id = ?"),
    )
      .bind(viewer.organisationId, viewer.eventId, assessmentId)
      .first<AiReviewAssessmentRow>();
    return row ? assessmentFromRow(row) : null;
  }

  protected async loadGenerationTarget(
    viewer: Viewer,
    roundId: string,
    submissionId: string,
  ) {
    const target = await this.env.DB.prepare(
      `SELECT round.id AS roundId, round.name AS roundName,
            round.status AS roundStatus,
            round.blinded_reviewing AS blindedReviewing,
            round.scorecard_id AS scorecardId,
            round.scorecard_version AS scorecardVersion,
            round.revision AS roundRevision,
            submission.id AS submissionId,
            submission.title AS submissionTitle,
            submission.public_reference AS submissionReference,
            submission.status AS submissionStatus,
            submission.submitted_at AS submittedAt,
            submission.submitted_snapshot_json AS submittedSnapshotJson,
            (SELECT revision.id
               FROM submission_revisions revision
              WHERE revision.event_id = submission.event_id
                AND revision.submission_id = submission.id
                AND revision.save_kind = 'submitted'
              ORDER BY revision.revision_number DESC, revision.id DESC
              LIMIT 1) AS submissionRevisionId,
            (SELECT revision.revision_number
               FROM submission_revisions revision
              WHERE revision.event_id = submission.event_id
                AND revision.submission_id = submission.id
                AND revision.save_kind = 'submitted'
              ORDER BY revision.revision_number DESC, revision.id DESC
              LIMIT 1) AS submissionRevisionNumber,
            assessment.id AS existingAssessmentId
       FROM evaluation_rounds round
       JOIN events event
         ON event.id = round.event_id AND event.organisation_id = ?
       JOIN submissions submission
         ON submission.event_id = round.event_id AND submission.id = ?
       LEFT JOIN ai_review_assessments assessment
         ON assessment.event_id = round.event_id
        AND assessment.round_id = round.id
        AND assessment.submission_id = submission.id
      WHERE round.id = ? AND round.event_id = ?
        AND ${reviewableSubmissionSql("submission", "review")}`,
    )
      .bind(viewer.organisationId, submissionId, roundId, viewer.eventId)
      .first<GenerationTarget>();
    if (!target) {
      throw new Response("Evaluation round or submission not found.", {
        status: 404,
      });
    }
    if (target.roundStatus !== "active" && target.roundStatus !== "closed") {
      throw new AiReviewAssessmentStateError(
        "AI first-pass assessment requires an active or closed evaluation round.",
      );
    }
    if (target.submittedAt === null) {
      throw new AiReviewAssessmentStateError(
        "AI first-pass assessment requires a submitted proposal eligible for the current review cycle.",
      );
    }
    if (
      !target.submissionRevisionId ||
      target.submissionRevisionNumber === null
    ) {
      throw new AiReviewAssessmentStateError(
        "AI first-pass assessment requires an immutable submitted revision.",
      );
    }
    return target;
  }

  protected async loadRubric(viewer: Viewer, target: GenerationTarget) {
    const rows = await this.env.DB.prepare(
      `SELECT criterion.id, criterion.name, criterion.description,
            criterion.input_type AS inputType,
            criterion.options_json AS optionsJson,
            criterion.weight_percent AS weightPercent,
            criterion.required, criterion.position
       FROM evaluation_criteria criterion
       JOIN evaluation_rounds round
         ON round.id = criterion.round_id
        AND round.event_id = criterion.event_id
       JOIN events event
         ON event.id = criterion.event_id AND event.organisation_id = ?
      WHERE criterion.event_id = ? AND criterion.round_id = ?
        AND round.revision = ?
        AND round.scorecard_id = ? AND round.scorecard_version = ?
      ORDER BY criterion.position, criterion.id`,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        target.roundId,
        target.roundRevision,
        target.scorecardId,
        target.scorecardVersion,
      )
      .all<PersistedCriterion>();
    if (!rows.results.length) {
      throw new AiReviewAssessmentStateError(
        "The selected evaluation round has no persisted rubric.",
      );
    }
    const rubric = rows.results.map((criterion) => ({
      id: criterion.id,
      name: criterion.name,
      description: criterion.description,
      inputType: criterion.inputType,
      options: parsePersistedRubricOptions(
        criterion.optionsJson,
        criterion.name,
        criterion.inputType,
      ),
      weightPercent: criterion.weightPercent,
      required: Boolean(criterion.required),
      position: criterion.position,
    }));
    if (
      !rubric.some(
        (criterion) =>
          criterion.inputType === "scale_5" ||
          criterion.inputType === "scale_10",
      )
    ) {
      throw new AiReviewAssessmentStateError(
        "AI first-pass assessment requires at least one scored rubric criterion.",
      );
    }
    return rubric;
  }

  protected async generationRequestHash(
    input: { roundId: string; submissionId: string },
    target: Pick<
      GenerationTarget,
      "roundRevision" | "scorecardId" | "scorecardVersion"
    > & {
      submissionRevisionId: string;
      submissionRevisionNumber: number;
      sourceSnapshotJson: string;
      sourceSnapshotSha256: string;
      modelInputSha256: string;
      promptVersion: number;
      provider: string;
      model: string;
    },
  ) {
    if (
      (await sha256(target.sourceSnapshotJson)) !== target.sourceSnapshotSha256
    ) {
      throw new AiReviewAssessmentIntentConflictError();
    }
    return sha256(
      JSON.stringify({
        roundId: input.roundId,
        submissionId: input.submissionId,
        roundRevision: target.roundRevision,
        scorecardId: target.scorecardId,
        scorecardVersion: target.scorecardVersion,
        submissionRevisionId: target.submissionRevisionId,
        submissionRevisionNumber: target.submissionRevisionNumber,
        sourceSnapshotSha256: target.sourceSnapshotSha256,
        modelInputSha256: target.modelInputSha256,
        promptVersion: target.promptVersion,
        provider: target.provider,
        model: target.model,
      }),
    );
  }

  protected async generationTargetKey(
    target: Pick<
      GenerationTarget,
      | "roundId"
      | "submissionId"
      | "roundRevision"
      | "scorecardId"
      | "scorecardVersion"
    > & {
      sourceSnapshotSha256: string;
      modelInputSha256: string;
      promptVersion: number;
    },
  ) {
    return `ai-review-assessment-target:${await sha256(
      `${target.roundId}\u0000${target.submissionId}\u0000${target.roundRevision}\u0000${target.scorecardId}\u0000${target.scorecardVersion}\u0000${target.sourceSnapshotSha256}\u0000${target.modelInputSha256}\u0000${target.promptVersion}`,
    )}`;
  }
}
