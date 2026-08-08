export const IMPACT_WEIGHT = Object.freeze({ critical: 4, high: 3, medium: 2, low: 1 });

export function calculateWeightedReadiness(tasks) {
  if (!Array.isArray(tasks)) throw new Error('Tasks must be an array.');
  if (tasks.length === 0) return 100;

  let achieved = 0;
  let possible = 0;
  for (const task of tasks) {
    if (!task || typeof task !== 'object') throw new Error('Every task must be an object.');
    const impact = String(task.impact || '').toLowerCase();
    const weight = IMPACT_WEIGHT[impact];
    if (!weight) throw new Error(`Unknown impact: ${task.impact}.`);

    const readiness = Number(task.readiness);
    if (!Number.isFinite(readiness) || readiness < 0 || readiness > 100) {
      throw new Error(`Readiness for ${task.id || task.task || 'task'} must be between 0 and 100.`);
    }
    achieved += readiness * weight;
    possible += 100 * weight;
  }
  return Math.round((achieved / possible) * 100);
}
