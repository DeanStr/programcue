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

export type FormFieldInsertionTarget = {
  sectionId: string;
  index: number;
};

function fieldsGroupedBySection(fields: FormField[], sectionIds: string[]) {
  const uniqueSectionIds = new Set(sectionIds);
  if (uniqueSectionIds.size !== sectionIds.length) {
    throw new Error("Form section IDs must be unique.");
  }
  const groups = new Map(sectionIds.map((sectionId) => [sectionId, []]));
  for (const field of fields) {
    const sectionFields = groups.get(field.sectionId);
    if (!sectionFields) {
      throw new Error(
        `Form field “${field.id}” references unknown section “${field.sectionId}”.`,
      );
    }
    sectionFields.push(field);
  }
  return groups;
}

function requireInsertionTarget(
  groups: Map<string, FormField[]>,
  target: FormFieldInsertionTarget,
) {
  const sectionFields = groups.get(target.sectionId);
  if (!sectionFields) {
    throw new Error(
      `Cannot insert into unknown form section “${target.sectionId}”.`,
    );
  }
  if (
    !Number.isSafeInteger(target.index) ||
    target.index < 0 ||
    target.index > sectionFields.length
  ) {
    throw new Error("The form field insertion position is invalid.");
  }
  return sectionFields;
}

function flattenSectionGroups(
  groups: Map<string, FormField[]>,
  sectionIds: string[],
) {
  return sectionIds.flatMap((sectionId) => groups.get(sectionId)!);
}

export function insertFormFieldAtTarget(
  fields: FormField[],
  field: FormField,
  target: FormFieldInsertionTarget,
  sectionIds: string[],
) {
  if (fields.some((candidate) => candidate.id === field.id)) {
    throw new Error(`Cannot insert duplicate form field “${field.id}”.`);
  }
  const groups = fieldsGroupedBySection(fields, sectionIds);
  const sectionFields = requireInsertionTarget(groups, target);
  sectionFields.splice(target.index, 0, {
    ...field,
    sectionId: target.sectionId,
  });
  return flattenSectionGroups(groups, sectionIds);
}

export function moveFormFieldToTarget(
  fields: FormField[],
  fieldId: string,
  target: FormFieldInsertionTarget,
  sectionIds: string[],
) {
  const groups = fieldsGroupedBySection(fields, sectionIds);
  const targetFields = requireInsertionTarget(groups, target);
  const sourceSectionId = sectionIds.find((sectionId) =>
    groups.get(sectionId)!.some((field) => field.id === fieldId),
  );
  if (!sourceSectionId) {
    throw new Error(`Cannot move missing form field “${fieldId}”.`);
  }
  const sourceFields = groups.get(sourceSectionId)!;
  const sourceIndex = sourceFields.findIndex((field) => field.id === fieldId);
  const [field] = sourceFields.splice(sourceIndex, 1);
  if (!field) throw new Error(`Cannot move missing form field “${fieldId}”.`);
  const insertionIndex =
    sourceSectionId === target.sectionId && target.index > sourceIndex
      ? target.index - 1
      : target.index;
  if (sourceSectionId === target.sectionId && insertionIndex === sourceIndex) {
    return null;
  }
  targetFields.splice(insertionIndex, 0, {
    ...field,
    sectionId: target.sectionId,
  });
  return flattenSectionGroups(groups, sectionIds);
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
