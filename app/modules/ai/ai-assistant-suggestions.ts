export const READINESS_SUGGESTED_REQUEST =
  "Call get_event_readiness exactly once, then answer without calling another tool. Cite only the returned records and rank at most three returned blockers by operational impact.";

export const READINESS_TASK_SUGGESTED_REQUEST =
  "Call get_event_readiness exactly once. If it returns a blocker, call propose_task exactly once for the current event to address the highest-impact blocker, using taskType administrator_only with no owner, due date or dependencies. Save only the preview, then answer without calling another tool. If there is no blocker, answer without proposing a task.";

export type FixedAssistantToolPlan = {
  kind: "readiness" | "readiness_task";
  steps: readonly string[];
  requiredSteps: number;
};

const FIXED_TOOL_PLANS = new Map<string, FixedAssistantToolPlan>([
  [
    READINESS_SUGGESTED_REQUEST,
    {
      kind: "readiness",
      steps: ["get_event_readiness"],
      requiredSteps: 1,
    },
  ],
  [
    READINESS_TASK_SUGGESTED_REQUEST,
    {
      kind: "readiness_task",
      steps: ["get_event_readiness", "propose_task"],
      requiredSteps: 1,
    },
  ],
]);

export function fixedAssistantToolPlan(prompt: string) {
  return FIXED_TOOL_PLANS.get(prompt) ?? null;
}

export function fixedAssistantToolLimitAfterReadiness(
  plan: FixedAssistantToolPlan,
  output: unknown,
) {
  if (plan.kind !== "readiness_task") return plan.steps.length;
  const blockers =
    output && typeof output === "object"
      ? Reflect.get(output, "blockers")
      : null;
  if (!Array.isArray(blockers)) {
    throw new Error(
      "The authoritative readiness tool returned an invalid blocker collection.",
    );
  }
  return blockers.length > 0 ? 2 : 1;
}

export function assistantSuggestedPrompts(eventName: string) {
  return [
    {
      label:
        "What is blocking event readiness? Cite the exact records and rank the next three actions.",
      request: READINESS_SUGGESTED_REQUEST,
    },
    {
      label:
        "Find speakers with incomplete tasks and draft a reminder. Do not send it.",
      request:
        "Find speakers with incomplete tasks and draft a reminder. Do not send it.",
    },
    {
      label: `Propose one event task for ${eventName} that addresses the highest readiness blocker. Save a preview only.`,
      request: READINESS_TASK_SUGGESTED_REQUEST,
    },
    {
      label:
        "Explain current schedule conflicts and distinguish recorded facts from your inference.",
      request:
        "Explain current schedule conflicts and distinguish recorded facts from your inference.",
    },
    {
      label:
        "Inspect the current form configuration and propose a new application form draft. Do not publish it.",
      request:
        "Inspect the current form configuration and propose a new application form draft. Do not publish it.",
    },
    {
      label:
        "Inspect the draft evaluation round and propose an exact rubric update with valid weights. Do not activate or assign it.",
      request:
        "Inspect the draft evaluation round and propose an exact rubric update with valid weights. Do not activate or assign it.",
    },
    {
      label:
        "Inspect the active evaluation round and propose reviewer assignments for currently unassigned targets. Preview every target and reviewer.",
      request:
        "Inspect the active evaluation round and propose reviewer assignments for currently unassigned targets. Preview every target and reviewer.",
    },
    {
      label:
        "Prepare an editable email template draft for the next speaker briefing. Do not publish or send it.",
      request:
        "Prepare an editable email template draft for the next speaker briefing. Do not publish or send it.",
    },
    {
      label:
        "Inspect the draft schedule and propose one conflict-free placement for an unscheduled session. Do not publish it.",
      request:
        "Inspect the draft schedule and propose one conflict-free placement for an unscheduled session. Do not publish it.",
    },
    {
      label:
        "Preview the exact Accelevents export plan as a dry run. Do not contact the provider until I approve.",
      request:
        "Preview the exact Accelevents export plan as a dry run. Do not contact the provider until I approve.",
    },
  ];
}
