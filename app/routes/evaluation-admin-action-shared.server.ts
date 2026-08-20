import { communicationScheduledEpoch } from "~/modules/communications/communication-time";
import type { DecisionReopenResult } from "~/modules/evaluations/evaluation-decision-service.server";
import {
  type EvaluationService,
  EvaluationValidationError,
} from "~/modules/evaluations/evaluation-service.server";
import type { requireCurrentEventRole } from "~/platform/auth/current-event.server";

export type EvaluationAdminActionContext = {
  env: CloudflareEnvironment;
  viewer: Awaited<ReturnType<typeof requireCurrentEventRole>>;
  values: FormData;
  service: EvaluationService;
};

export function decisionReopenFlash(result: DecisionReopenResult) {
  if (result.notificationOutcome === "cancelled_before_delivery") {
    return "Decision reopened for correction and its pending notification was cancelled. Messages already sent cannot be recalled; record and release the corrected outcome explicitly.";
  }
  if (result.notificationOutcome === "legacy_unverified") {
    return "Decision reopened for correction. This release predates pinned notification evidence, so delivery is not asserted. Messages that were sent cannot be recalled; record and release the corrected outcome explicitly.";
  }
  const deliveryStatus = result.deliveryStatus;
  if (
    deliveryStatus === "failed" ||
    deliveryStatus === "bounced" ||
    deliveryStatus === "suppressed"
  ) {
    return `Decision reopened for correction. The original decision email had already been accepted by the provider and later reported as ${deliveryStatus}. Messages already sent cannot be recalled; record and release the corrected outcome explicitly.`;
  }
  return "Decision reopened for correction. The original decision email had already been accepted by the provider. Messages already sent cannot be recalled; record and release the corrected outcome explicitly.";
}

export function readRubricCriteria(values: FormData) {
  const ids = values.getAll("criterionId").map(String);
  const names = values.getAll("criterionName").map(String);
  const descriptions = values.getAll("criterionDescription").map(String);
  const inputTypes = values.getAll("criterionInputType").map(String);
  const options = values.getAll("criterionOptions").map(String);
  const weights = values.getAll("criterionWeight").map(String);
  const required = values.getAll("criterionRequired").map(String);
  return names
    .map((name, index) => ({
      id: ids[index]?.trim() || crypto.randomUUID(),
      name,
      description: descriptions[index],
      inputType: inputTypes[index],
      options: (options[index] ?? "")
        .split(/[\n,]/u)
        .map((option) => option.trim())
        .filter(Boolean),
      weightPercent: weights[index],
      required:
        required[index] === "true"
          ? true
          : required[index] === "false"
            ? false
            : undefined,
      position: index,
    }))
    .filter((criterion) => criterion.name.trim())
    .map((criterion, position) => ({ ...criterion, position }));
}

export function readRecommendationChoices(values: FormData) {
  const ids = values.getAll("recommendationChoiceId").map(String);
  const labels = values.getAll("recommendationChoiceLabel").map(String);
  if (
    ids.length !== labels.length ||
    ids.some((id) => id.trim().length === 0)
  ) {
    throw new EvaluationValidationError(
      "Recommendation choice identities are missing or inconsistent. Refresh and try again.",
    );
  }
  return ids.map((id, index) => {
    const label = labels[index];
    if (label === undefined) {
      throw new EvaluationValidationError(
        "Recommendation choice identities are missing or inconsistent. Refresh and try again.",
      );
    }
    return { id: id.trim(), label };
  });
}

export function readRoundDateTime(
  values: FormData,
  field: string,
  eventTimezone: string,
) {
  const value = String(values.get(field) ?? "").trim();
  if (!value) return null;
  try {
    return new Date(
      communicationScheduledEpoch(value, eventTimezone) * 1_000,
    ).toISOString();
  } catch (error) {
    throw new EvaluationValidationError(
      error instanceof Error
        ? error.message
        : "Enter a valid round date and time.",
    );
  }
}
