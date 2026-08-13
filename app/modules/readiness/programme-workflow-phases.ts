export type ProgrammeSetupStepKey =
  | "event-details"
  | "application-form"
  | "review-plan"
  | "participant-tasks"
  | "communications"
  | "publication";

export type ProgrammeSetupStep = {
  key: ProgrammeSetupStepKey;
  label: string;
  description: string;
  href: string;
  complete: boolean;
};

export const PROGRAMME_WORKFLOW_PHASES = [
  {
    key: "setup",
    label: "Set up",
    description: "Define the event and open participant intake.",
    setupStepKeys: ["event-details", "application-form"],
  },
  {
    key: "decide",
    label: "Collect and decide",
    description: "Run structured review and turn decisions into a programme.",
    setupStepKeys: ["review-plan"],
  },
  {
    key: "prepare",
    label: "Prepare speakers",
    description: "Set expectations and keep participant work moving.",
    setupStepKeys: ["participant-tasks", "communications"],
  },
  {
    key: "publish",
    label: "Publish and verify",
    description: "Clear schedule conflicts and publish deliberately.",
    setupStepKeys: ["publication"],
  },
] as const satisfies ReadonlyArray<{
  key: string;
  label: string;
  description: string;
  setupStepKeys: ReadonlyArray<ProgrammeSetupStepKey>;
}>;

export type ProgrammeWorkflowPhaseKey =
  (typeof PROGRAMME_WORKFLOW_PHASES)[number]["key"];

export function groupProgrammeSetupSteps(
  steps: ReadonlyArray<ProgrammeSetupStep>,
) {
  const byKey = new Map(steps.map((step) => [step.key, step]));
  if (byKey.size !== steps.length) {
    throw new Error("Programme setup steps contain a duplicate key.");
  }

  const assignedKeys = new Set<ProgrammeSetupStepKey>();
  const phases = PROGRAMME_WORKFLOW_PHASES.map((phase) => {
    const phaseSteps = phase.setupStepKeys.map((key) => {
      if (assignedKeys.has(key)) {
        throw new Error(
          `The programme setup step "${key}" is assigned to more than one phase.`,
        );
      }
      assignedKeys.add(key);
      const step = byKey.get(key);
      if (!step)
        throw new Error(`The programme setup step "${key}" is missing.`);
      return step;
    });
    return {
      ...phase,
      steps: phaseSteps,
      complete: phaseSteps.every((step) => step.complete),
    };
  });

  const unassignedStep = steps.find((step) => !assignedKeys.has(step.key));
  if (unassignedStep) {
    throw new Error(
      `The programme setup step "${unassignedStep.key}" is not assigned to a phase.`,
    );
  }

  return phases;
}
