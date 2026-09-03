export const IMPACT_WEIGHTS = {
  critical: 4,
  high: 3,
  medium: 2,
  low: 1,
} as const;

export type ReadinessTask = {
  id: string;
  impact: keyof typeof IMPACT_WEIGHTS;
  readinessPercent: number;
  blocking?: boolean;
};

export type WorkflowReadiness = {
  key: string;
  score: number;
};

export type ReadinessActionCandidate = {
  key: string;
  severity: "danger" | "warning";
};

const READINESS_ACTION_PRIORITY = [
  "schedule_conflicts",
  "overdue_tasks",
  "critical_tasks",
  "delivery_failures",
  "integration_failures",
  "operation_failures",
  "due_soon_tasks",
  "speaker_assets",
  "unassigned_reviews",
  "unscheduled_sessions",
  "unpublished_schedule",
] as const;

const readinessActionRank = new Map<string, number>(
  READINESS_ACTION_PRIORITY.map((key, index) => [key, index]),
);

/**
 * Choose one stable next action without asking AI to reinterpret operational
 * state. Unknown future conditions still sort after declared critical ones and
 * before warnings, then by key so the result never depends on query order.
 */
export function selectTopReadinessAction<T extends ReadinessActionCandidate>(
  conditions: ReadonlyArray<T>,
): T | null {
  return (
    [...conditions].sort((left, right) => {
      if (left.severity !== right.severity) {
        return left.severity === "danger" ? -1 : 1;
      }
      const leftRank = readinessActionRank.get(left.key);
      const rightRank = readinessActionRank.get(right.key);
      if (leftRank !== undefined || rightRank !== undefined) {
        return (
          (leftRank ?? READINESS_ACTION_PRIORITY.length) -
          (rightRank ?? READINESS_ACTION_PRIORITY.length)
        );
      }
      return left.key.localeCompare(right.key);
    })[0] ?? null
  );
}

export type OperationalReadinessStatus =
  | "ready"
  | "on_track"
  | "at_risk"
  | "needs_attention";

export function summarizeReadinessConditions(
  conditions: ReadonlyArray<{ severity: "danger" | "warning" }>,
) {
  return {
    criticalConditionCount: conditions.filter(
      (condition) => condition.severity === "danger",
    ).length,
    warningConditionCount: conditions.filter(
      (condition) => condition.severity === "warning",
    ).length,
  };
}

export function calculateReadiness(tasks: ReadonlyArray<ReadinessTask>) {
  if (!tasks.length) return { percentage: 100, blockers: 0 };
  let achieved = 0;
  let possible = 0;
  let blockers = 0;
  for (const task of tasks) {
    const weight = IMPACT_WEIGHTS[task.impact];
    if (
      !Number.isFinite(task.readinessPercent) ||
      task.readinessPercent < 0 ||
      task.readinessPercent > 100
    ) {
      throw new Error(`Readiness for ${task.id} must be between 0 and 100.`);
    }
    achieved += task.readinessPercent * weight;
    possible += 100 * weight;
    if (task.blocking && task.readinessPercent < 100) blockers += 1;
  }
  return { percentage: Math.round((achieved / possible) * 100), blockers };
}

export function calculateOverallReadiness(
  workflows: ReadonlyArray<WorkflowReadiness>,
  activeConditionCount: number,
) {
  if (!Number.isInteger(activeConditionCount) || activeConditionCount < 0) {
    throw new Error("Active conditions must be a non-negative integer.");
  }
  if (!workflows.length) return activeConditionCount > 0 ? 0 : 100;
  const total = workflows.reduce((sum, workflow) => {
    if (
      !Number.isFinite(workflow.score) ||
      workflow.score < 0 ||
      workflow.score > 100
    ) {
      throw new Error(
        `Readiness for ${workflow.key} must be between 0 and 100.`,
      );
    }
    return sum + workflow.score;
  }, 0);
  const average = Math.round(total / workflows.length);
  return activeConditionCount > 0 ? Math.min(99, average) : average;
}

export function operationalReadinessStatus(input: {
  percentage: number;
  criticalConditionCount: number;
  warningConditionCount: number;
}): OperationalReadinessStatus {
  const { percentage, criticalConditionCount, warningConditionCount } = input;
  if (!Number.isFinite(percentage) || percentage < 0 || percentage > 100) {
    throw new Error("Overall readiness must be between 0 and 100.");
  }
  for (const [label, count] of [
    ["Critical conditions", criticalConditionCount],
    ["Warning conditions", warningConditionCount],
  ] as const) {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`${label} must be a non-negative integer.`);
    }
  }
  if (criticalConditionCount > 0) return "needs_attention";
  if (percentage < 75) return "at_risk";
  if (percentage === 100 && warningConditionCount === 0) return "ready";
  return "on_track";
}
