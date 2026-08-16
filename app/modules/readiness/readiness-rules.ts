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
  declaredBlockers: number,
) {
  if (!Number.isInteger(declaredBlockers) || declaredBlockers < 0) {
    throw new Error("Declared blockers must be a non-negative integer.");
  }
  if (!workflows.length) return declaredBlockers > 0 ? 0 : 100;
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
  return declaredBlockers > 0 ? Math.min(99, average) : average;
}
