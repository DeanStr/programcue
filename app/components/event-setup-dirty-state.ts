const eventSetupBaselineExcludedFields = new Set([
  "_intent",
  "revision",
  "rooms",
  "tracks",
  "sessionFormats",
]);

export function eventSetupFieldValues(form: HTMLFormElement) {
  const fields = new Map<string, string[]>();
  for (const [name, value] of new FormData(form)) {
    if (eventSetupBaselineExcludedFields.has(name)) continue;
    if (typeof value !== "string") {
      throw new Error(
        `Event Setup field ${name} unexpectedly contains a file. Files require an explicit dirty-state comparison.`,
      );
    }
    const values = fields.get(name);
    if (values) values.push(value);
    else fields.set(name, [value]);
  }
  return fields;
}

/* The count is what the operator is shown, so it counts fields rather than
   keystrokes. An unchecked box leaves the form data entirely, which is why a
   name present on one side only is a change and not an absence. */
export function countChangedFields(
  saved: ReadonlyMap<string, string[]>,
  current: ReadonlyMap<string, string[]>,
) {
  let changed = 0;
  for (const name of new Set([...saved.keys(), ...current.keys()])) {
    const savedValues = saved.get(name);
    const currentValues = current.get(name);
    if (
      !savedValues ||
      !currentValues ||
      savedValues.length !== currentValues.length ||
      savedValues.some((value, index) => value !== currentValues[index])
    )
      changed += 1;
  }
  return changed;
}

/* Rooms, tracks and formats keep their loaded order, so an index-wise
   comparison sees an edited record as one change and an added or removed one
   as one more. */
export function countChangedRecords(
  saved: readonly unknown[],
  current: readonly unknown[],
) {
  let changed = Math.abs(saved.length - current.length);
  for (let index = 0; index < Math.min(saved.length, current.length); index++) {
    if (JSON.stringify(saved[index]) !== JSON.stringify(current[index]))
      changed += 1;
  }
  return changed;
}
