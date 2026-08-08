const EPSILON = 1e-6;

function finiteNumber(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${field} must be a finite number.`);
  return number;
}

export function validateRubric(criteria) {
  if (!Array.isArray(criteria) || criteria.length === 0) {
    throw new Error('Rubric must include at least one criterion.');
  }

  const ids = new Set();
  let total = 0;
  for (const item of criteria) {
    if (!item || typeof item !== 'object') throw new Error('Every criterion must be an object.');
    if (typeof item.id !== 'string' || !item.id.trim()) throw new Error('Every criterion requires an id.');
    if (ids.has(item.id)) throw new Error(`Duplicate criterion id: ${item.id}.`);
    ids.add(item.id);
    if (typeof item.name !== 'string' || !item.name.trim()) throw new Error('Every criterion requires a name.');

    const weight = finiteNumber(item.weight, `Weight for ${item.name}`);
    if (weight <= 0 || weight > 100) throw new Error(`Weight for ${item.name} must be greater than 0 and at most 100.`);
    total += weight;

    const rating = finiteNumber(item.rating, `Rating for ${item.name}`);
    if (rating < 0 || rating > 5) throw new Error(`Rating for ${item.name} must be between 0 and 5.`);
  }

  if (Math.abs(total - 100) > EPSILON) {
    throw new Error(`Rubric weights must total 100; received ${Number(total.toFixed(6))}.`);
  }
  return true;
}

export function calculateWeightedReview(criteria) {
  validateRubric(criteria);
  const score = criteria.reduce((sum, item) => sum + (Number(item.weight) * Number(item.rating)) / 100, 0);
  return { score: Number(score.toFixed(2)), percentage: Math.round(score * 20) };
}
