import { requireValue } from "~/lib/required-value";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  type FailedGenerationResult,
  parseCompletedGenerationResult,
  parseFailedGenerationResult,
  parseGenerationOperationPayload,
  parseStagedGenerationResult,
} from "./ai-review-assessment-durable-state";
import { AiReviewAssessmentStateError } from "./ai-review-assessment-errors";
import {
  type AiReviewAssessmentRow,
  assessmentFromRow,
  type ProviderKey,
  providerLabels,
} from "./ai-review-assessment-support.server";
import type { AiModelProvider } from "./openai-responses-provider.server";

export type { AiReviewAssessment } from "./ai-review-assessment-support.server";

type AiReviewAssessmentGenerationAttemptBase = {
  operationId: string;
  roundId: string;
  submissionId: string;
  roundRevision: number;
  scorecardId: string;
  scorecardVersion: number;
  provider: ProviderKey;
  providerLabel: AiModelProvider["providerName"];
  model: string;
  retryOfOperationId: string | null;
};

export type AiReviewAssessmentGenerationAttempt =
  | (AiReviewAssessmentGenerationAttemptBase & {
      status: "running";
      requestedByName: string;
      startedAt: number;
      recoveryRequired: boolean;
    })
  | (AiReviewAssessmentGenerationAttemptBase & {
      status: "failed";
      lastError: string;
      providerRequestId: string | null;
      failedAt: number;
    });

function assertAssessmentReader(viewer: Viewer) {
  if (
    viewer.role !== "owner" &&
    viewer.role !== "administrator" &&
    viewer.role !== "committee_chair"
  ) {
    throw new Response("AI review assessment access is not authorised.", {
      status: 403,
    });
  }
}

function assertAssessmentAdministrator(viewer: Viewer) {
  if (viewer.role !== "owner" && viewer.role !== "administrator") {
    throw new Response("AI review assessment changes are not authorised.", {
      status: 403,
    });
  }
}

function epochSeconds(value: Date) {
  const epoch = Math.floor(value.getTime() / 1_000);
  if (!Number.isFinite(epoch)) {
    throw new Error("AI assessment time source returned an invalid date.");
  }
  return epoch;
}

export class AiReviewAssessmentReader {
  private readonly now: () => Date;

  constructor(
    private readonly env: CloudflareEnvironment,
    now: () => Date = () => new Date(),
  ) {
    this.now = now;
  }

  private async assertViewerEvent(viewer: Viewer) {
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

  private assessmentQuery(where: string) {
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

  async listForEvent(viewer: Viewer) {
    assertAssessmentReader(viewer);
    await this.assertViewerEvent(viewer);
    const rows = await this.env.DB.prepare(
      `${this.assessmentQuery("1 = 1")}
       ORDER BY round.round_number, submission.title COLLATE NOCASE,
                assessment.id`,
    )
      .bind(viewer.organisationId, viewer.eventId)
      .all<AiReviewAssessmentRow>();
    return rows.results.map(assessmentFromRow);
  }

  async listGenerationAttempts(
    viewer: Viewer,
  ): Promise<AiReviewAssessmentGenerationAttempt[]> {
    assertAssessmentAdministrator(viewer);
    const event = await this.assertViewerEvent(viewer);
    if (event.retentionCompletedAt !== null) return [];
    const rows = await this.env.DB.prepare(
      `SELECT operation.id, operation.payload_json AS payloadJson,
              operation.status,
              operation.result_json AS resultJson,
              operation.last_error AS lastError,
              operation.requested_by_person_id AS requestedByPersonId,
              requester.display_name AS requestedByName,
              operation.started_at AS startedAt,
              operation.claim_token AS claimToken,
              operation.claim_expires_at AS claimExpiresAt,
              operation.completed_at AS completedAt,
              completed_assessment.id AS completedAssessmentId
         FROM operation_jobs operation
         JOIN events event
           ON event.id = operation.event_id AND event.organisation_id = ?
         LEFT JOIN people requester
           ON requester.id = operation.requested_by_person_id
         LEFT JOIN ai_review_assessments completed_assessment
           ON completed_assessment.event_id = operation.event_id
          AND completed_assessment.id =
                json_extract(operation.payload_json, '$.assessmentId')
        WHERE operation.event_id = ?
          AND operation.type = 'ai.review_assessment.generate'
        ORDER BY operation.created_at DESC, operation.id DESC`,
    )
      .bind(viewer.organisationId, viewer.eventId)
      .all<{
        id: string;
        payloadJson: string;
        status: string;
        resultJson: string | null;
        lastError: string | null;
        requestedByPersonId: string | null;
        requestedByName: string | null;
        startedAt: number | null;
        claimToken: string | null;
        claimExpiresAt: number | null;
        completedAt: number | null;
        completedAssessmentId: string | null;
      }>();
    const attempts = rows.results.map((row) => ({
      ...row,
      payload: parseGenerationOperationPayload(row.payloadJson, row.id),
    }));
    const failedResults = new Map<string, FailedGenerationResult>();
    for (const attempt of attempts) {
      if (attempt.status === "completed") {
        if (
          !attempt.resultJson ||
          attempt.completedAt === null ||
          !attempt.completedAssessmentId
        ) {
          throw new Error(
            `Completed AI assessment operation ${attempt.id} is missing its durable result or persisted assessment.`,
          );
        }
        const result = parseCompletedGenerationResult(
          attempt.resultJson,
          attempt.id,
        );
        if (
          result.assessmentId !== attempt.payload.assessmentId ||
          result.assessmentId !== attempt.completedAssessmentId
        ) {
          throw new Error(
            `Completed AI assessment operation ${attempt.id} has an inconsistent assessment identity.`,
          );
        }
        continue;
      }
      if (attempt.status === "running") {
        if (
          !attempt.requestedByPersonId ||
          !attempt.requestedByName ||
          attempt.startedAt === null ||
          !attempt.claimToken ||
          attempt.claimExpiresAt === null
        ) {
          throw new Error(
            `Running AI assessment operation ${attempt.id} is missing its requester, start time or provider claim.`,
          );
        }
        if (attempt.resultJson) {
          const staged = parseStagedGenerationResult(
            attempt.resultJson,
            attempt.id,
          );
          if (staged.assessmentId !== attempt.payload.assessmentId) {
            throw new Error(
              `Running AI assessment operation ${attempt.id} has an inconsistent staged assessment identity.`,
            );
          }
        }
        continue;
      }
      if (attempt.status !== "failed") {
        throw new Error(
          `AI assessment operation ${attempt.id} has unsupported ${attempt.status} status.`,
        );
      }
      if (
        !attempt.resultJson ||
        !attempt.lastError ||
        attempt.completedAt === null
      ) {
        throw new Error(
          `Failed AI assessment operation ${attempt.id} is missing its durable failure evidence.`,
        );
      }
      failedResults.set(
        attempt.id,
        parseFailedGenerationResult(attempt.resultJson, attempt.id),
      );
    }

    const attemptById = new Map(
      attempts.map((attempt) => [attempt.id, attempt]),
    );
    const retryByParentId = new Map<string, (typeof attempts)[number]>();
    for (const attempt of attempts) {
      const parentId = attempt.payload.retryOfOperationId;
      if (!parentId) continue;
      const parent = attemptById.get(parentId);
      if (!parent) {
        throw new Error(
          `AI assessment retry operation ${attempt.id} references missing operation ${parentId}.`,
        );
      }
      if (parent.payload.targetKey !== attempt.payload.targetKey) {
        throw new Error(
          `AI assessment retry operation ${attempt.id} references a different assessment target.`,
        );
      }
      if (parent.status !== "failed") {
        throw new Error(
          `AI assessment retry operation ${attempt.id} references a non-failed operation.`,
        );
      }
      if (retryByParentId.has(parentId)) {
        throw new Error(
          `AI assessment operation ${parentId} has multiple retry children.`,
        );
      }
      retryByParentId.set(parentId, attempt);
    }
    const traversedOperationIds = new Set<string>();
    for (const attempt of attempts) {
      if (traversedOperationIds.has(attempt.id)) continue;
      const pathOperationIds = new Set<string>();
      let current: (typeof attempts)[number] | undefined = attempt;
      while (current && !traversedOperationIds.has(current.id)) {
        if (pathOperationIds.has(current.id)) {
          throw new Error(
            `AI assessment retry chain for target ${attempt.payload.targetKey} contains a cycle.`,
          );
        }
        pathOperationIds.add(current.id);
        current = retryByParentId.get(current.id);
      }
      for (const operationId of pathOperationIds) {
        traversedOperationIds.add(operationId);
      }
    }

    const leafByTarget = new Map<string, (typeof attempts)[number]>();
    for (const attempt of attempts) {
      // All attempt states form one durable retry chain. Choose its leaf so a
      // running or completed retry suppresses its failed parent.
      if (retryByParentId.has(attempt.id)) continue;
      const { payload } = attempt;
      if (leafByTarget.has(payload.targetKey)) {
        throw new Error(
          `AI assessment target ${payload.targetKey} has multiple retry leaves.`,
        );
      }
      leafByTarget.set(payload.targetKey, attempt);
    }
    const visibleAttempts: AiReviewAssessmentGenerationAttempt[] = [];
    for (const attempt of leafByTarget.values()) {
      const { payload } = attempt;
      const base = {
        operationId: attempt.id,
        roundId: payload.roundId,
        submissionId: payload.submissionId,
        roundRevision: payload.roundRevision,
        scorecardId: payload.scorecardId,
        scorecardVersion: payload.scorecardVersion,
        provider: payload.provider,
        providerLabel: providerLabels[payload.provider],
        model: payload.model,
        retryOfOperationId: payload.retryOfOperationId,
      } satisfies AiReviewAssessmentGenerationAttemptBase;
      if (attempt.status === "completed") continue;
      if (attempt.status === "running") {
        visibleAttempts.push({
          ...base,
          status: "running",
          requestedByName: requireValue(
            attempt.requestedByName,
            "Required attempt.requestedByName is unavailable.",
          ),
          startedAt: requireValue(
            attempt.startedAt,
            "Required attempt.startedAt is unavailable.",
          ),
          recoveryRequired:
            attempt.resultJson !== null ||
            requireValue(
              attempt.claimExpiresAt,
              "Required attempt.claimExpiresAt is unavailable.",
            ) <= epochSeconds(this.now()),
        });
        continue;
      }
      const failure = failedResults.get(attempt.id);
      if (!failure) {
        throw new Error(
          `Failed AI assessment operation ${attempt.id} was not validated.`,
        );
      }
      visibleAttempts.push({
        ...base,
        status: "failed",
        lastError: requireValue(
          attempt.lastError,
          "Required attempt.lastError is unavailable.",
        ),
        providerRequestId: failure.providerRequestId ?? null,
        failedAt: requireValue(
          attempt.completedAt,
          "Required attempt.completedAt is unavailable.",
        ),
      });
    }
    return visibleAttempts;
  }
}
