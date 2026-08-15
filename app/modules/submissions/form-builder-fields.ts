import { MAX_FORM_FIELDS, type FormField } from "./submission-schema";

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

export function createFormField(
  fields: FormField[],
  type: FormField["type"],
): FormField {
  const ids = new Set(fields.map((field) => field.id));
  let index = fields.length + 1;
  while (ids.has(`field_${index}`)) index += 1;

  return {
    id: `field_${index}`,
    label: formFieldTypeLabel(type),
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
