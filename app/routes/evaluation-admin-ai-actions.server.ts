import { requireValue } from "~/lib/required-value";
import { AiReviewAssessmentService } from "~/modules/ai/ai-review-assessment.server";
import { ReviewerAiSuggestionService } from "~/modules/ai/reviewer-ai-suggestion.server";
import type { EvaluationAdminActionContext } from "./evaluation-admin-action-shared.server";

export async function handleEvaluationAdminAiIntent(
  context: EvaluationAdminActionContext,
) {
  const { env, viewer, values } = context;
  if (values.get("intent") === "update-reviewer-ai-setting") {
    const setting = await new ReviewerAiSuggestionService(env).updateSetting(
      viewer,
      {
        enabled: values.get("enabled") === "true",
        revision: values.get("revision"),
      },
    );
    return {
      ok: true,
      message: setting.enabled
        ? "Reviewer AI suggestions enabled for this event."
        : "Reviewer AI suggestions disabled for this event.",
    };
  }

  if (values.get("intent") === "reconcile-ai-review-assessment") {
    const result = await new AiReviewAssessmentService(
      env,
    ).reconcileGenerationAttempt(viewer, {
      operationId: values.get("operationId"),
    });
    return result.status === "completed"
      ? {
          ok: true,
          message: `Recovered AI first-pass assessment saved at ${result.assessment.score.toFixed(1)} / 5.`,
        }
      : {
          ok: true,
          message:
            "The expired AI attempt was reconciled as failed. Review its failure before explicitly retrying.",
        };
  }

  if (values.get("intent") === "generate-ai-review-assessment") {
    const assessment = await new AiReviewAssessmentService(env).generate(
      viewer,
      {
        generationIntentId: values.get("generationIntentId"),
        roundId: values.get("roundId"),
        submissionId: values.get("submissionId"),
        confirmed: values.get("confirmed") === "true" ? true : undefined,
      },
    );
    return {
      ok: true,
      message: `AI first-pass assessment saved at ${assessment.score.toFixed(1)} / 5.`,
    };
  }

  if (values.get("intent") === "retry-ai-review-assessment") {
    const assessment = await new AiReviewAssessmentService(env).generate(
      viewer,
      {
        generationIntentId: values.get("generationIntentId"),
        roundId: values.get("roundId"),
        submissionId: values.get("submissionId"),
        retryFailedOperationId: values.get("failedOperationId"),
        duplicateRiskAcknowledged:
          values.get("duplicateRiskAcknowledged") === "true" ? true : undefined,
        confirmed: values.get("confirmed") === "true" ? true : undefined,
      },
    );
    return {
      ok: true,
      message: `Retried AI first-pass assessment saved at ${assessment.score.toFixed(1)} / 5.`,
    };
  }

  if (values.get("intent") === "override-ai-review-assessment") {
    const assessment = await new AiReviewAssessmentService(env).override(
      viewer,
      {
        assessmentId: values.get("assessmentId"),
        expectedRevision: values.get("expectedRevision"),
        score: values.get("score"),
        rationale: values.get("rationale"),
        confirmed: values.get("confirmed") === "true" ? true : undefined,
      },
    );
    return {
      ok: true,
      message: `Human assessment of the AI advisory saved at ${requireValue(
        assessment.overrideScore,
        "A saved human assessment must include its score.",
      ).toFixed(1)} / 5.`,
    };
  }

  return null;
}
