export const EVALUATION_ACCESS_CODE_HEX_LENGTH = 32;

const evaluationAccessCodePattern = /^[0-9a-f]{32}$/u;

export function configuredEvaluationAccessCode(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return evaluationAccessCodePattern.test(normalized) ? normalized : null;
}
