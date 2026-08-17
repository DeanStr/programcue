import type { LoaderFunctionArgs } from "react-router";
import { z } from "zod";
import { requireValue } from "~/lib/required-value";
import { AiReviewAssessmentService } from "~/modules/ai/ai-review-assessment.server";
import { ReviewerAiSuggestionService } from "~/modules/ai/reviewer-ai-suggestion.server";
import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
import {
  EVALUATION_RESULT_PRESETS,
  type EvaluationResultPreset,
  evaluationResultFlags,
  matchesEvaluationResultPreset,
} from "~/modules/evaluations/evaluation-result-workbench";
import { decisionDraftEffectPreviewSchema } from "~/modules/evaluations/evaluation-schema";
import { EvaluationService } from "~/modules/evaluations/evaluation-service.server";
import { EventService } from "~/modules/events/event-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { canReleaseEvaluationDecisions } from "./evaluation-admin-outcomes";

const historicalEvidenceIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value, "must not have outer whitespace");
const historicalReviewScoresSchema = z.record(
  historicalEvidenceIdSchema,
  z.union([z.string(), z.number(), z.boolean()]),
);
const historicalReviewContentSchema = z.object({
  recommendation: z.string().nullable().optional(),
  confidence: z.number().nullable().optional(),
  submitterFeedback: z.string().optional(),
  privateNotes: z.string().optional(),
  reopenReason: z.string().optional(),
});
const historicalCriteriaSchema = z
  .array(
    z.object({
      id: historicalEvidenceIdSchema,
      name: z
        .string()
        .min(1)
        .max(500)
        .refine(
          (value) => value.trim() === value,
          "must not have outer whitespace",
        ),
    }),
  )
  .min(1);

function parseRevisionEvidence<T>(
  revisionId: string,
  field: string,
  raw: string,
  schema: z.ZodType<T>,
) {
  try {
    return schema.parse(JSON.parse(raw));
  } catch {
    throw new Error(
      `Review revision ${revisionId} contains invalid ${field} evidence.`,
    );
  }
}

export function parseHistoricalReviewRevision(input: {
  id: string;
  scoresJson: string;
  contentJson: string;
  scorecardId: string | null;
  scorecardVersion: number | null;
  criteriaSnapshotJson: string | null;
}) {
  const scores = parseRevisionEvidence(
    input.id,
    "scores",
    input.scoresJson,
    historicalReviewScoresSchema,
  );
  const content = parseRevisionEvidence(
    input.id,
    "content",
    input.contentJson,
    historicalReviewContentSchema,
  );
  const evidencePresence = [
    input.scorecardId !== null,
    input.scorecardVersion !== null,
    input.criteriaSnapshotJson !== null,
  ];
  if (evidencePresence.some(Boolean) && !evidencePresence.every(Boolean)) {
    throw new Error(
      `Review revision ${input.id} contains incomplete scorecard evidence.`,
    );
  }
  if (!evidencePresence.some(Boolean)) {
    return { scores, content, criteria: null };
  }
  if (
    !historicalEvidenceIdSchema.safeParse(input.scorecardId).success ||
    !Number.isInteger(input.scorecardVersion) ||
    requireValue(
      input.scorecardVersion,
      "Required input.scorecardVersion is unavailable.",
    ) < 1
  ) {
    throw new Error(
      `Review revision ${input.id} contains invalid scorecard identity evidence.`,
    );
  }
  const criteria = parseRevisionEvidence(
    input.id,
    "criteria",
    requireValue(
      input.criteriaSnapshotJson,
      "Required input.criteriaSnapshotJson is unavailable.",
    ),
    historicalCriteriaSchema,
  );
  const criterionIds = criteria.map((criterion) => criterion.id);
  if (new Set(criterionIds).size !== criterionIds.length) {
    throw new Error(
      `Review revision ${input.id} contains duplicate criterion evidence.`,
    );
  }
  const knownCriteria = new Set(criterionIds);
  const missingCriterion = Object.keys(scores).find(
    (criterionId) => !knownCriteria.has(criterionId),
  );
  if (missingCriterion) {
    throw new Error(
      `Review revision ${input.id} contains a score without matching criterion evidence.`,
    );
  }
  return { scores, content, criteria };
}

export async function loader({ request, context }: LoaderFunctionArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
    "committee_chair",
  ]);
  await ensureDemoEvaluationData(env);
  const canPrepareReviewerReminders =
    viewer.role === "owner" || viewer.role === "administrator";
  const evaluationService = new EvaluationService(env);
  const [workspace, event, reviewerReminderTemplateRows, reviewerAiSetting] =
    await Promise.all([
      evaluationService.getAdminWorkspace(viewer),
      new EventService(env).getSetup(viewer),
      canPrepareReviewerReminders
        ? env.DB.prepare(
            `SELECT version.id, version.name, version.version_number AS versionNumber,
                  version.subject_template AS subject
             FROM communication_template_versions version
             JOIN communication_templates template
               ON template.id = version.template_id
              AND template.event_id = version.event_id
             JOIN events event
               ON event.id = version.event_id AND event.organisation_id = ?
            WHERE version.event_id = ? AND version.category = 'ad_hoc'
              AND version.channel = 'email' AND version.status = 'published'
              AND template.status = 'active'
            ORDER BY template.updated_at DESC, version.version_number DESC`,
          )
            .bind(viewer.organisationId, viewer.eventId)
            .all<{
              id: string;
              name: string;
              versionNumber: number;
              subject: string;
            }>()
        : Promise.resolve({ results: [] }),
      new ReviewerAiSuggestionService(env).setting(viewer),
    ]);
  const aiReviewAssessmentsSupported = event.repositoryProvider === "d1";
  const canManageAiAssessments =
    canPrepareReviewerReminders && aiReviewAssessmentsSupported;
  const aiAssessmentService = new AiReviewAssessmentService(env);
  const [aiReviewAssessments, aiReviewAssessmentGenerationAttempts] =
    await Promise.all([
      aiReviewAssessmentsSupported
        ? aiAssessmentService.listForEvent(viewer)
        : Promise.resolve([]),
      canManageAiAssessments
        ? aiAssessmentService.listGenerationAttempts(viewer)
        : Promise.resolve([]),
    ]);
  const search = new URL(request.url).searchParams;
  const requestedPreset = search.get("preset") ?? "all";
  if (!EVALUATION_RESULT_PRESETS.some((preset) => preset === requestedPreset)) {
    throw new Response("Invalid evaluation results preset", { status: 400 });
  }
  const resultPreset = requestedPreset as EvaluationResultPreset;
  const requestedPage = search.get("page") ?? "1";
  const resultsPage = Number(requestedPage);
  if (
    !/^\d+$/u.test(requestedPage) ||
    !Number.isSafeInteger(resultsPage) ||
    resultsPage < 1 ||
    resultsPage > 100_000
  ) {
    throw new Response("Invalid evaluation results page", { status: 400 });
  }
  const resultsPageSize = 25;
  const requestedFilter = search.get("filter") ?? "";
  if (
    requestedFilter &&
    !["unassigned", "incomplete"].includes(requestedFilter)
  ) {
    throw new Response("Invalid evaluation review filter", { status: 400 });
  }
  const reviewFilter =
    requestedFilter === "unassigned" || requestedFilter === "incomplete"
      ? requestedFilter
      : null;
  const unassignedOnly = reviewFilter === "unassigned";
  const incompleteOnly = reviewFilter === "incomplete";
  const focusedSubmissionId = search.get("submission")?.trim() ?? "";
  const focusedSessionId = search.get("session")?.trim() ?? "";
  if (focusedSubmissionId.length > 200 || focusedSessionId.length > 200) {
    throw new Response("Invalid evaluation discussion focus", { status: 400 });
  }
  if (focusedSubmissionId && focusedSessionId) {
    throw new Response("Choose one evaluation discussion target", {
      status: 400,
    });
  }
  if (
    focusedSubmissionId &&
    !workspace.submissions.some(
      (submission) => submission.id === focusedSubmissionId,
    )
  ) {
    throw new Response("Submission not found in this event's evaluation", {
      status: 404,
    });
  }
  if (focusedSubmissionId && !workspace.plan) {
    throw new Response(
      "Create an evaluation plan before opening a submission in Review.",
      { status: 409 },
    );
  }
  if (
    focusedSessionId &&
    !workspace.sessions.some((session) => session.id === focusedSessionId)
  ) {
    throw new Response("Session not found in this event's evaluation", {
      status: 404,
    });
  }
  if (focusedSessionId && !workspace.plan) {
    throw new Response(
      "Create an evaluation plan before opening a session in Review.",
      { status: 409 },
    );
  }
  const requestedSort = search.get("sort") ?? "score_desc";
  const resultSortOptions = [
    "score_desc",
    "score_asc",
    "title_asc",
    "completion_desc",
  ] as const;
  if (!resultSortOptions.some((option) => option === requestedSort)) {
    throw new Response("Invalid evaluation results sort", { status: 400 });
  }
  const resultSort = requestedSort as (typeof resultSortOptions)[number];
  const requestedRoundId = search.get("round")?.trim() ?? "";
  if (requestedRoundId.length > 200)
    throw new Response("Invalid evaluation round focus", { status: 400 });
  if (
    requestedRoundId &&
    !workspace.plan?.rounds.some((round) => round.id === requestedRoundId)
  )
    throw new Response("Evaluation round not found in this event", {
      status: 404,
    });
  const requestedResultsRoundId = search.get("resultsRound")?.trim() ?? "";
  if (requestedResultsRoundId.length > 200) {
    throw new Response("Invalid evaluation results round", { status: 400 });
  }
  if (
    requestedResultsRoundId &&
    !workspace.plan?.rounds.some(
      (round) => round.id === requestedResultsRoundId,
    )
  ) {
    throw new Response("Evaluation results round not found in this event", {
      status: 404,
    });
  }
  const resultsRoundId =
    requestedResultsRoundId ||
    workspace.plan?.rounds.find((round) => round.status === "active")?.id ||
    workspace.plan?.rounds.at(-1)?.id ||
    null;
  const submissionResults = new Map<
    string,
    {
      assignmentCount: number;
      completedReviewCount: number;
      scoredReviewCount: number;
      scoreTotal: number;
      minimumScore: number | null;
      maximumScore: number | null;
      recusedCount: number;
      recommendations: Record<string, number>;
      reviews: Array<{
        reviewId: string;
        assignmentId: string;
        evaluatorName: string;
        weightedScore: number | null;
        recommendation: string | null;
        privateNotes: string | null;
        submitterFeedback: string | null;
        scores: Record<string, string | number | boolean>;
      }>;
    }
  >();
  const sessionResults = new Map<
    string,
    {
      assignmentCount: number;
      completedReviewCount: number;
      scoredReviewCount: number;
      scoreTotal: number;
      minimumScore: number | null;
      maximumScore: number | null;
      recusedCount: number;
      recommendations: Record<string, number>;
      reviews: Array<{
        reviewId: string;
        assignmentId: string;
        evaluatorName: string;
        weightedScore: number | null;
        recommendation: string | null;
        privateNotes: string | null;
        submitterFeedback: string | null;
        scores: Record<string, string | number | boolean>;
      }>;
    }
  >();
  if (resultsRoundId) {
    for (const assignment of workspace.assignments) {
      if (
        assignment.roundId !== resultsRoundId ||
        assignment.status === "cancelled"
      ) {
        continue;
      }
      const targetResults = assignment.submissionId
        ? submissionResults
        : sessionResults;
      const targetId = assignment.submissionId ?? assignment.sessionId;
      if (!targetId) {
        throw new Error("An evaluation assignment has no review target.");
      }
      const aggregate = targetResults.get(targetId) ?? {
        assignmentCount: 0,
        completedReviewCount: 0,
        scoredReviewCount: 0,
        scoreTotal: 0,
        minimumScore: null,
        maximumScore: null,
        recusedCount: 0,
        recommendations: {},
        reviews: [],
      };
      if (assignment.status === "recused") {
        aggregate.recusedCount += 1;
        targetResults.set(targetId, aggregate);
        continue;
      }
      aggregate.assignmentCount += 1;
      if (
        assignment.reviewStatus === "submitted" ||
        assignment.reviewStatus === "locked"
      ) {
        aggregate.completedReviewCount += 1;
        if (assignment.weightedScore !== null) {
          aggregate.scoredReviewCount += 1;
          aggregate.scoreTotal += assignment.weightedScore;
          aggregate.minimumScore =
            aggregate.minimumScore === null
              ? assignment.weightedScore
              : Math.min(aggregate.minimumScore, assignment.weightedScore);
          aggregate.maximumScore =
            aggregate.maximumScore === null
              ? assignment.weightedScore
              : Math.max(aggregate.maximumScore, assignment.weightedScore);
        }
        if (assignment.recommendation) {
          aggregate.recommendations[assignment.recommendation] =
            (aggregate.recommendations[assignment.recommendation] ?? 0) + 1;
        }
        let scores: Record<string, string | number | boolean> = {};
        if (assignment.scoresJson !== null) {
          const parsed: unknown = JSON.parse(assignment.scoresJson);
          if (
            !parsed ||
            typeof parsed !== "object" ||
            Array.isArray(parsed) ||
            Object.values(parsed).some(
              (value) =>
                typeof value !== "string" &&
                typeof value !== "number" &&
                typeof value !== "boolean",
            )
          ) {
            throw new Error(
              `Submitted review ${assignment.reviewId ?? assignment.id} has invalid persisted criterion responses.`,
            );
          }
          scores = parsed as Record<string, string | number | boolean>;
        }
        aggregate.reviews.push({
          reviewId: requireValue(
            assignment.reviewId,
            "Required assignment.reviewId is unavailable.",
          ),
          assignmentId: assignment.id,
          evaluatorName: assignment.evaluatorName,
          weightedScore: assignment.weightedScore,
          recommendation: assignment.recommendation,
          privateNotes: assignment.privateNotes,
          submitterFeedback: assignment.submitterFeedback,
          scores,
        });
      }
      targetResults.set(targetId, aggregate);
    }
  }
  const roundScopedSubmissions = workspace.submissions.map((submission) => {
    const aggregate = submissionResults.get(submission.id);
    return {
      ...submission,
      assignmentCount: aggregate?.assignmentCount ?? 0,
      completedReviewCount: aggregate?.completedReviewCount ?? 0,
      averageScore:
        aggregate && aggregate.scoredReviewCount > 0
          ? aggregate.scoreTotal / aggregate.scoredReviewCount
          : null,
      minimumScore: aggregate?.minimumScore ?? null,
      maximumScore: aggregate?.maximumScore ?? null,
      recusedCount: aggregate?.recusedCount ?? 0,
      recommendations: aggregate?.recommendations ?? {},
      reviews: aggregate?.reviews ?? [],
    };
  });
  const matchesReviewFilter = (target: {
    assignmentCount: number;
    completedReviewCount: number;
  }) =>
    unassignedOnly
      ? target.assignmentCount === 0
      : incompleteOnly
        ? target.assignmentCount > 0 &&
          target.completedReviewCount < target.assignmentCount
        : true;
  const visibleSubmissions = roundScopedSubmissions.filter(matchesReviewFilter);
  const roundScopedSessions = workspace.sessions.map((session) => {
    const aggregate = sessionResults.get(session.id);
    return {
      ...session,
      assignmentCount: aggregate?.assignmentCount ?? 0,
      completedReviewCount: aggregate?.completedReviewCount ?? 0,
      averageScore:
        aggregate && aggregate.scoredReviewCount > 0
          ? aggregate.scoreTotal / aggregate.scoredReviewCount
          : null,
      minimumScore: aggregate?.minimumScore ?? null,
      maximumScore: aggregate?.maximumScore ?? null,
      recusedCount: aggregate?.recusedCount ?? 0,
      recommendations: aggregate?.recommendations ?? {},
      reviews: aggregate?.reviews ?? [],
    };
  });
  const visibleSessions = roundScopedSessions.filter(matchesReviewFilter);
  const compareResults = (
    left: {
      id: string;
      title: string;
      assignmentCount: number;
      completedReviewCount: number;
      averageScore: number | null;
    },
    right: {
      id: string;
      title: string;
      assignmentCount: number;
      completedReviewCount: number;
      averageScore: number | null;
    },
  ) => {
    if (resultSort === "title_asc") {
      return (
        left.title.localeCompare(right.title, undefined, {
          sensitivity: "base",
        }) || left.id.localeCompare(right.id)
      );
    }
    if (resultSort === "completion_desc") {
      const leftCompletion = left.assignmentCount
        ? left.completedReviewCount / left.assignmentCount
        : -1;
      const rightCompletion = right.assignmentCount
        ? right.completedReviewCount / right.assignmentCount
        : -1;
      return (
        rightCompletion - leftCompletion ||
        left.title.localeCompare(right.title, undefined, {
          sensitivity: "base",
        }) ||
        left.id.localeCompare(right.id)
      );
    }
    if (left.averageScore === null || right.averageScore === null) {
      if (left.averageScore === right.averageScore) {
        return (
          left.title.localeCompare(right.title, undefined, {
            sensitivity: "base",
          }) || left.id.localeCompare(right.id)
        );
      }
      return left.averageScore === null ? 1 : -1;
    }
    const scoreOrder =
      resultSort === "score_asc"
        ? left.averageScore - right.averageScore
        : right.averageScore - left.averageScore;
    return (
      scoreOrder ||
      left.title.localeCompare(right.title, undefined, {
        sensitivity: "base",
      }) ||
      left.id.localeCompare(right.id)
    );
  };
  const sortedSubmissions = [...visibleSubmissions].sort(compareResults);
  const selectedResultsRound = workspace.plan?.rounds.find(
    (round) => round.id === resultsRoundId,
  );
  const resultCriterionNames = Object.fromEntries(
    (selectedResultsRound?.criteria ?? []).map((criterion) => [
      criterion.id,
      criterion.name,
    ]),
  );
  const rawDecisionHistoryRows = resultsRoundId
    ? await env.DB.prepare(
        `SELECT decision.id, decision.submission_id AS submissionId,
                decision.revision_number AS revisionNumber,
                decision.status, decision.decision, decision.rationale,
                decision.decided_at AS decidedAt,
                decision.published_at AS publishedAt,
                person.display_name AS decidedByName,
                decision.notification_operation_id AS notificationOperationId,
                operation.id AS notificationOperationRecordId,
                operation.status AS notificationOperationStatus,
                operation.last_error AS notificationOperationError,
                communication.id AS communicationId,
                communication.status AS communicationStatus,
                delivery.id AS deliveryId,
                delivery.status AS deliveryStatus,
                delivery.recipient_address AS recipientAddress,
                delivery.recipient_name AS recipientName,
                delivery.provider AS deliveryProvider,
                delivery.rendered_subject AS renderedSubject,
                delivery.rendered_body_sha256 AS renderedBodySha256,
                delivery.provider_message_id AS providerMessageId,
                delivery.failure_code AS failureCode,
                delivery.failure_message AS failureMessage,
                delivery.updated_at AS deliveryUpdatedAt,
                json_extract(communication.audience_json, '$.decisionId')
                  AS audienceDecisionId,
                json_extract(communication.audience_json, '$.submissionId')
                  AS audienceSubmissionId,
                delivery.source_id AS deliverySourceId,
                json_extract(communication.content_snapshot_json, '$.template.id')
                  AS templateVersionId,
                json_extract(communication.content_snapshot_json, '$.template.name')
                  AS templateName,
                json_extract(communication.content_snapshot_json, '$.template.versionNumber')
                  AS templateVersionNumber,
                json_extract(communication.content_snapshot_json, '$.sender.id')
                  AS senderProfileId,
                json_extract(communication.content_snapshot_json, '$.sender.fromName')
                  AS senderFromName,
                json_extract(communication.content_snapshot_json, '$.sender.fromEmail')
                  AS senderFromEmail,
                event.participant_retention_completed_at
                  AS participantRetentionCompletedAt
           FROM submission_decisions decision
           JOIN events event
             ON event.id = decision.event_id AND event.organisation_id = ?
           JOIN people person ON person.id = decision.decided_by_person_id
           LEFT JOIN operation_jobs operation
             ON operation.id = decision.notification_operation_id
            AND operation.event_id = decision.event_id
            AND operation.type = 'decision.notification'
           LEFT JOIN communications communication
             ON communication.operation_id = operation.id
            AND communication.event_id = decision.event_id
           LEFT JOIN communication_deliveries delivery
             ON delivery.communication_id = communication.id
            AND delivery.event_id = decision.event_id
          WHERE decision.event_id = ?
            AND (decision.round_id = ? OR decision.round_id IS NULL)
          ORDER BY decision.submission_id, decision.revision_number DESC`,
      )
        .bind(viewer.organisationId, viewer.eventId, resultsRoundId)
        .all<{
          id: string;
          submissionId: string;
          revisionNumber: number;
          status: string;
          decision: string;
          rationale: string | null;
          decidedAt: number;
          publishedAt: number | null;
          decidedByName: string;
          notificationOperationId: string | null;
          notificationOperationRecordId: string | null;
          notificationOperationStatus: string | null;
          notificationOperationError: string | null;
          communicationId: string | null;
          communicationStatus: string | null;
          deliveryId: string | null;
          deliveryStatus: string | null;
          recipientAddress: string | null;
          recipientName: string | null;
          deliveryProvider: string | null;
          renderedSubject: string | null;
          renderedBodySha256: string | null;
          providerMessageId: string | null;
          failureCode: string | null;
          failureMessage: string | null;
          deliveryUpdatedAt: number | null;
          audienceDecisionId: string | null;
          audienceSubmissionId: string | null;
          deliverySourceId: string | null;
          templateVersionId: string | null;
          templateName: string | null;
          templateVersionNumber: number | null;
          senderProfileId: string | null;
          senderFromName: string | null;
          senderFromEmail: string | null;
          participantRetentionCompletedAt: number | null;
        }>()
    : { results: [] };
  const releasedDecisionRowCounts = new Map<string, number>();
  for (const row of rawDecisionHistoryRows.results) {
    if (
      row.publishedAt === null ||
      !["published", "superseded", "revoked"].includes(row.status)
    ) {
      continue;
    }
    releasedDecisionRowCounts.set(
      row.id,
      (releasedDecisionRowCounts.get(row.id) ?? 0) + 1,
    );
  }
  const duplicatedDecisionEvidence = [...releasedDecisionRowCounts].find(
    ([, count]) => count !== 1,
  );
  if (duplicatedDecisionEvidence) {
    throw new Error(
      `Released decision ${duplicatedDecisionEvidence[0]} has an invalid number of notification evidence rows.`,
    );
  }
  const decisionHistoryRows = {
    results: rawDecisionHistoryRows.results.map((row) => {
      if (
        row.publishedAt === null ||
        !["published", "superseded", "revoked"].includes(row.status)
      ) {
        return { ...row, notificationEvidenceState: "not_applicable" as const };
      }
      if (row.notificationOperationId === null) {
        return { ...row, notificationEvidenceState: "legacy" as const };
      }
      const evidencePrefix = `Released decision ${row.id} has incomplete notification evidence`;
      requireValue(
        row.notificationOperationRecordId,
        `${evidencePrefix}: operation record is missing.`,
      );
      const notificationOperationStatus = requireValue(
        row.notificationOperationStatus,
        `${evidencePrefix}: operation status is missing.`,
      );
      const communicationId = requireValue(
        row.communicationId,
        `${evidencePrefix}: communication is missing.`,
      );
      const communicationStatus = requireValue(
        row.communicationStatus,
        `${evidencePrefix}: communication status is missing.`,
      );
      const deliveryId = requireValue(
        row.deliveryId,
        `${evidencePrefix}: recipient delivery is missing.`,
      );
      const deliveryStatus = requireValue(
        row.deliveryStatus,
        `${evidencePrefix}: recipient delivery status is missing.`,
      );
      const deliveryUpdatedAt = requireValue(
        row.deliveryUpdatedAt,
        `${evidencePrefix}: recipient delivery state timestamp is missing.`,
      );
      if (row.participantRetentionCompletedAt !== null) {
        return {
          ...row,
          notificationOperationId: row.notificationOperationId,
          notificationOperationStatus,
          communicationId,
          communicationStatus,
          deliveryId,
          deliveryStatus,
          deliveryUpdatedAt,
          notificationEvidenceState: "retained" as const,
        };
      }
      if (
        row.audienceDecisionId !== row.id ||
        row.audienceSubmissionId !== row.submissionId
      ) {
        throw new Error(
          `${evidencePrefix}: communication audience does not match the released decision.`,
        );
      }
      if (row.deliverySourceId !== row.submissionId) {
        throw new Error(
          `${evidencePrefix}: recipient delivery source does not match the released submission.`,
        );
      }
      const recipientAddress = requireValue(
        row.recipientAddress,
        `${evidencePrefix}: recipient address is missing.`,
      );
      const recipientName = requireValue(
        row.recipientName,
        `${evidencePrefix}: recipient name is missing.`,
      );
      const deliveryProvider = requireValue(
        row.deliveryProvider,
        `${evidencePrefix}: provider is missing.`,
      );
      const renderedSubject = requireValue(
        row.renderedSubject,
        `${evidencePrefix}: rendered subject is missing.`,
      );
      const renderedBodySha256 = requireValue(
        row.renderedBodySha256,
        `${evidencePrefix}: message integrity evidence is missing.`,
      );
      if (!/^[0-9a-f]{64}$/.test(renderedBodySha256)) {
        throw new Error(
          `${evidencePrefix}: message integrity evidence is invalid.`,
        );
      }
      const templateVersionId = requireValue(
        row.templateVersionId,
        `${evidencePrefix}: template version is missing.`,
      );
      const templateName = requireValue(
        row.templateName,
        `${evidencePrefix}: template name is missing.`,
      );
      const templateVersionNumber = requireValue(
        row.templateVersionNumber,
        `${evidencePrefix}: template version number is missing.`,
      );
      const senderProfileId = requireValue(
        row.senderProfileId,
        `${evidencePrefix}: sender profile is missing.`,
      );
      const senderFromName = requireValue(
        row.senderFromName,
        `${evidencePrefix}: sender name is missing.`,
      );
      const senderFromEmail = requireValue(
        row.senderFromEmail,
        `${evidencePrefix}: sender address is missing.`,
      );
      return {
        ...row,
        notificationOperationId: row.notificationOperationId,
        notificationOperationStatus,
        communicationId,
        communicationStatus,
        deliveryId,
        deliveryStatus,
        deliveryUpdatedAt,
        recipientAddress,
        recipientName,
        deliveryProvider,
        renderedSubject,
        renderedBodySha256,
        templateVersionId,
        templateName,
        templateVersionNumber,
        senderProfileId,
        senderFromName,
        senderFromEmail,
        notificationEvidenceState: "available" as const,
      };
    }),
  };
  const decisionDraftRows = await env.DB.prepare(
    `SELECT decision.submission_id AS submissionId,
            decision.revision_number AS revisionNumber,
            decision.decision, decision.rationale,
            decision.effect_preview_json AS effectPreviewJson
       FROM submission_decisions decision
       JOIN events event
         ON event.id = decision.event_id AND event.organisation_id = ?
      WHERE decision.event_id = ? AND decision.status = 'draft'
      ORDER BY decision.submission_id, decision.revision_number DESC`,
  )
    .bind(viewer.organisationId, viewer.eventId)
    .all<{
      submissionId: string;
      revisionNumber: number;
      decision: "accepted" | "rejected" | "waitlisted";
      rationale: string | null;
      effectPreviewJson: string;
    }>();
  const decisionDraftBySubmission = new Map<
    string,
    {
      revisionNumber: number;
      decision: "accepted" | "rejected" | "waitlisted";
      rationale: string;
      includeReviewerFeedback: boolean;
      sessionTrackId: string | null;
      sessionFormatKey: string | null;
      sessionDurationMinutes: number | null;
    }
  >();
  for (const row of decisionDraftRows.results) {
    if (decisionDraftBySubmission.has(row.submissionId)) continue;
    const effectPreview = decisionDraftEffectPreviewSchema.safeParse(
      JSON.parse(row.effectPreviewJson),
    );
    if (!effectPreview.success) {
      throw new Error(
        `Decision draft ${row.submissionId} has invalid persisted preview data.`,
      );
    }
    decisionDraftBySubmission.set(row.submissionId, {
      revisionNumber: row.revisionNumber,
      decision: row.decision,
      rationale: row.rationale ?? "",
      ...effectPreview.data,
    });
  }
  const allResults = [
    ...roundScopedSubmissions.map((submission) => ({
      targetType: "proposal" as const,
      id: submission.id,
      reference: submission.reference,
      title: submission.title,
      state: submission.status,
      assignmentCount: submission.assignmentCount,
      completedReviewCount: submission.completedReviewCount,
      averageScore: submission.averageScore,
      minimumScore: submission.minimumScore,
      maximumScore: submission.maximumScore,
      recusedCount: submission.recusedCount,
      recommendations: submission.recommendations,
      reviews: submission.reviews,
      moderation:
        workspace.moderations.find(
          (moderation) =>
            moderation.roundId === resultsRoundId &&
            moderation.submissionId === submission.id,
        ) ?? null,
      aiAssessment:
        aiReviewAssessments.find(
          (assessment) =>
            assessment.roundId === resultsRoundId &&
            assessment.submissionId === submission.id,
        ) ?? null,
      decisionHistory: decisionHistoryRows.results.filter(
        (decision) => decision.submissionId === submission.id,
      ),
    })),
    ...roundScopedSessions.map((session) => ({
      targetType: "session" as const,
      id: session.id,
      reference: session.reference,
      title: session.title,
      state: session.status,
      assignmentCount: session.assignmentCount,
      completedReviewCount: session.completedReviewCount,
      averageScore: session.averageScore,
      minimumScore: session.minimumScore,
      maximumScore: session.maximumScore,
      recusedCount: session.recusedCount,
      recommendations: session.recommendations,
      reviews: session.reviews,
      moderation: null,
      aiAssessment: null,
      decisionHistory: [],
    })),
  ]
    .filter(matchesReviewFilter)
    .map((result) => {
      const { mixedRecommendations, incomplete, decisionReady } =
        evaluationResultFlags({
          assignmentCount: result.assignmentCount,
          completedReviewCount: result.completedReviewCount,
          recusedCount: result.recusedCount,
          recommendationCounts: result.recommendations,
          moderationStatus: result.moderation?.status ?? null,
        });
      return {
        ...result,
        mixedRecommendations,
        incomplete,
        decisionReady,
      };
    })
    .filter((result) => {
      return matchesEvaluationResultPreset(resultPreset, {
        assignmentCount: result.assignmentCount,
        completedReviewCount: result.completedReviewCount,
        recusedCount: result.recusedCount,
        recommendationCounts: result.recommendations,
        moderationStatus: result.moderation?.status ?? null,
      });
    })
    .sort(compareResults);
  const resultsTotal = allResults.length;
  const resultsPageCount = Math.max(
    1,
    Math.ceil(resultsTotal / resultsPageSize),
  );
  if (resultsPage > resultsPageCount) {
    throw new Response("Evaluation results page not found", { status: 404 });
  }
  const pagedResults = allResults.slice(
    (resultsPage - 1) * resultsPageSize,
    resultsPage * resultsPageSize,
  );
  const pageReviewIds = pagedResults.flatMap((result) =>
    result.reviews.map((review) => review.reviewId),
  );
  const reviewRevisionRows = pageReviewIds.length
    ? await env.DB.prepare(
        `SELECT revision.id, revision.review_id AS reviewId,
                revision.revision_number AS revisionNumber,
                revision.save_kind AS saveKind,
                revision.scores_json AS scoresJson,
                revision.content_json AS contentJson,
                revision.scorecard_id AS scorecardId,
                revision.scorecard_version AS scorecardVersion,
                revision.criteria_snapshot_json AS criteriaSnapshotJson,
                revision.created_at AS createdAt,
                person.display_name AS savedByName
           FROM review_revisions revision
           JOIN reviews review
             ON review.id = revision.review_id
            AND review.event_id = revision.event_id
           JOIN events event
             ON event.id = review.event_id AND event.organisation_id = ?
           JOIN people person ON person.id = revision.saved_by_person_id
          WHERE revision.event_id = ?
            AND revision.review_id IN (${pageReviewIds.map(() => "?").join(",")})
          ORDER BY revision.review_id, revision.revision_number DESC`,
      )
        .bind(viewer.organisationId, viewer.eventId, ...pageReviewIds)
        .all<{
          id: string;
          reviewId: string;
          revisionNumber: number;
          saveKind: "autosave" | "manual" | "submitted" | "reopened";
          scoresJson: string;
          contentJson: string;
          scorecardId: string | null;
          scorecardVersion: number | null;
          criteriaSnapshotJson: string | null;
          createdAt: number;
          savedByName: string;
        }>()
    : { results: [] };
  const results = pagedResults.map((result) => ({
    ...result,
    reviews: result.reviews.map((review) => ({
      ...review,
      history: reviewRevisionRows.results
        .filter((revision) => revision.reviewId === review.reviewId)
        .map(
          ({ scoresJson, contentJson, criteriaSnapshotJson, ...revision }) => ({
            ...revision,
            ...parseHistoricalReviewRevision({
              id: revision.id,
              scoresJson,
              contentJson,
              scorecardId: revision.scorecardId,
              scorecardVersion: revision.scorecardVersion,
              criteriaSnapshotJson,
            }),
          }),
        ),
    })),
  }));
  const discussionTarget = focusedSubmissionId
    ? ({ targetType: "submission", targetId: focusedSubmissionId } as const)
    : focusedSessionId
      ? ({ targetType: "session", targetId: focusedSessionId } as const)
      : null;
  const reviewDiscussion =
    discussionTarget && resultsRoundId
      ? await evaluationService.listDiscussion(viewer, {
          roundId: resultsRoundId,
          ...discussionTarget,
        })
      : null;
  let reviewDiscussionTitle: string | null = null;
  if (discussionTarget) {
    const titledTarget =
      discussionTarget.targetType === "submission"
        ? roundScopedSubmissions.find(
            (submission) => submission.id === discussionTarget.targetId,
          )
        : roundScopedSessions.find(
            (session) => session.id === discussionTarget.targetId,
          );
    if (!titledTarget) {
      throw new Error(
        "The validated evaluation discussion target is missing from the review workspace.",
      );
    }
    reviewDiscussionTitle = titledTarget.title;
  }
  return {
    ...workspace,
    demoMode: viewer.demo,
    canReleaseDecisions: canReleaseEvaluationDecisions(
      viewer.role,
      workspace.plan,
    ),
    canAssessAiAdvisories:
      aiReviewAssessmentsSupported &&
      canReleaseEvaluationDecisions(viewer.role, workspace.plan),
    canManageEvaluationAccess:
      viewer.role === "owner" || viewer.role === "administrator",
    canPrepareReviewerReminders,
    canManageAiAssessments,
    reviewerAiSetting,
    aiReviewAssessmentsSupported,
    reviewerReminderTemplates: reviewerReminderTemplateRows.results,
    aiReviewAssessments,
    aiReviewAssessmentGenerationAttempts,
    submissions: sortedSubmissions.map((submission) => ({
      ...submission,
      decisionDraft: decisionDraftBySubmission.get(submission.id) ?? null,
      aiAssessmentGenerationIntent: crypto.randomUUID(),
    })),
    sessions: visibleSessions,
    results,
    reviewFilter,
    unassignedOnly,
    incompleteOnly,
    focusedSubmissionId: focusedSubmissionId || null,
    focusedSessionId: focusedSessionId || null,
    reviewDiscussion,
    reviewDiscussionTitle,
    resultSort,
    resultPreset,
    resultsRoundId,
    resultsPage,
    resultsPageSize,
    resultsTotal,
    resultsPageCount,
    resultCriterionNames,
    resultsExportIntent: crypto.randomUUID(),
    focusedRoundId: requestedRoundId || null,
    eventTimezone: event.timezone,
    sessionFormats: event.sessionFormats,
    acceptedSpeakerInvitationResendEnabled: String(env.DEMO_MODE) !== "true",
  };
}

export { action } from "./evaluation-admin-action.server";
