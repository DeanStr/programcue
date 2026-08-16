import { type FormField, MAX_FORM_FIELDS } from "./submission-schema";

function fieldIdFromLabel(fields: FormField[], label: string) {
  const existing = new Set(fields.map((field) => field.id));
  const base = label
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLocaleLowerCase("en")
    .replace(/[^a-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .slice(0, 36)
    .replace(/_+$/gu, "");
  if (!base) {
    throw new Error(
      `Form field label “${label}” cannot produce a stable identifier.`,
    );
  }
  let candidate = /^[a-z]/u.test(base) ? base : `field_${base}`;
  let suffix = 2;
  while (existing.has(candidate)) {
    candidate = `${base.slice(0, 36 - String(suffix).length)}_${suffix}`;
    suffix += 1;
  }
  return candidate;
}

const FORM_FIELD_TYPE_LABELS = {
  short_text: "Short text",
  long_text: "Long text",
  select: "Dropdown",
  multi_select: "Multiple choice",
  url: "URL",
  video: "Video upload or URL",
} satisfies Record<FormField["type"], string>;

export const FORM_FIELD_TYPES = Object.entries(FORM_FIELD_TYPE_LABELS).map(
  ([value, label]) => ({ value: value as FormField["type"], label }),
);

export function formFieldTypeLabel(type: FormField["type"]) {
  return FORM_FIELD_TYPE_LABELS[type];
}

export function formConditionSourceLabel(fields: FormField[], fieldId: string) {
  const source = fields.find((field) => field.id === fieldId);
  return source?.label ?? `Missing field “${fieldId}”`;
}

export function formFieldCreationIssue(
  fields: FormField[],
  type: FormField["type"],
) {
  if (fields.length >= MAX_FORM_FIELDS) {
    return `A form can contain at most ${MAX_FORM_FIELDS} fields.`;
  }
  if (type === "video" && fields.some((field) => field.type === "video")) {
    return "A form can contain at most one native video upload field.";
  }
  return null;
}

export function conditionalFieldOrderIssue(fields: FormField[]) {
  const positions = new Map(
    fields.map((field, index) => [field.id, index] as const),
  );
  for (const [index, field] of fields.entries()) {
    if (!field.condition) continue;
    const dependencyIndex = positions.get(field.condition.fieldId);
    if (dependencyIndex === undefined) {
      return `Cannot reorder fields: “${field.label}” depends on the missing field “${field.condition.fieldId}”.`;
    }
    if (dependencyIndex >= index) {
      const dependency = fields[dependencyIndex]!;
      return `Cannot reorder fields: “${field.label}” must remain after “${dependency.label}” because its condition depends on that field.`;
    }
  }
  return null;
}

export function formFieldInsertionSectionId(
  fields: FormField[],
  targetIndex: number,
  emptyFormSectionId: string,
) {
  if (
    !Number.isSafeInteger(targetIndex) ||
    targetIndex < 0 ||
    targetIndex > fields.length
  ) {
    throw new Error("The form field insertion position is invalid.");
  }
  return (
    fields[targetIndex]?.sectionId ??
    fields[targetIndex - 1]?.sectionId ??
    emptyFormSectionId
  );
}

export function moveFormFieldToInsertion(
  fields: FormField[],
  fieldId: string,
  targetIndex: number,
  emptyFormSectionId: string,
) {
  const targetSectionId = formFieldInsertionSectionId(
    fields,
    targetIndex,
    emptyFormSectionId,
  );
  const sourceIndex = fields.findIndex((field) => field.id === fieldId);
  if (sourceIndex < 0) {
    throw new Error(`Cannot move missing form field “${fieldId}”.`);
  }
  const nextFields = [...fields];
  const [field] = nextFields.splice(sourceIndex, 1);
  if (!field) throw new Error(`Cannot move missing form field “${fieldId}”.`);
  const insertionIndex =
    targetIndex > sourceIndex ? targetIndex - 1 : targetIndex;
  if (insertionIndex === sourceIndex && field.sectionId === targetSectionId) {
    return null;
  }
  nextFields.splice(insertionIndex, 0, {
    ...field,
    sectionId: targetSectionId,
  });
  return nextFields;
}

export function createFormField(
  fields: FormField[],
  type: FormField["type"],
  sectionId: string,
): FormField {
  const label = formFieldTypeLabel(type);

  return {
    sectionId,
    id: fieldIdFromLabel(fields, label),
    label,
    type,
    required: false,
    help: "",
    example: "",
    options:
      type === "select" || type === "multi_select"
        ? ["Option 1", "Option 2"]
        : [],
    reviewVisibility: "administrators_only",
    blindReviewVisibility: "identity",
    condition: null,
  };
}
