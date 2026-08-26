import { Button } from "~/components/ui/button";
import type { ApplicantFormStep } from "~/modules/submissions/submission-schema";

export function ApplicantFormStepStatus({
  steps,
  currentStepId,
}: {
  steps: readonly ApplicantFormStep[];
  currentStepId: string;
}) {
  const index = steps.findIndex((step) => step.id === currentStepId);
  const current = steps[index];
  if (!current || index < 0) return null;
  return (
    <p className="application-form-step-status" aria-live="polite">
      Step {index + 1} of {steps.length}: {current.title}
    </p>
  );
}

export function ApplicantFormStepNav({
  steps,
  currentStepId,
  onBack,
  onContinue,
  backDisabled = false,
  continueDisabled = false,
  showContinue = true,
}: {
  steps: readonly ApplicantFormStep[];
  currentStepId: string;
  onBack(): void;
  onContinue(): void;
  backDisabled?: boolean;
  continueDisabled?: boolean;
  showContinue?: boolean;
}) {
  const index = steps.findIndex((step) => step.id === currentStepId);
  const isFirst = index <= 0;
  const isLast = index === steps.length - 1;
  return (
    <div className="page-actions application-form-step-nav">
      <Button type="button" onClick={onBack} disabled={isFirst || backDisabled}>
        Back
      </Button>
      {showContinue && !isLast ? (
        <Button
          variant="primary"
          type="button"
          onClick={onContinue}
          disabled={continueDisabled}
        >
          Continue
        </Button>
      ) : null}
    </div>
  );
}
