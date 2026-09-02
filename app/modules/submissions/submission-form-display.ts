import type { UploadReference } from "./submission-application-schema";
import type {
  FormField,
  FormLayout,
  LegacyFormField,
  LegacySubmissionFormSchema,
  StoredFormField,
  StoredSubmissionFormSchema,
  SubmissionFormSchema,
} from "./submission-form-schema";

export type FieldErrors = Record<string, string[]>;

export function validateAnswerShapes(
  schema: StoredSubmissionFormSchema,
  answers: Record<string, string | string[]>,
  uploads: Record<string, UploadReference> = {},
) {
  const errors: FieldErrors = {};
  for (const field of schema.fields) {
    if (!Object.hasOwn(answers, field.id)) continue;
    const answer = answers[field.id];
    if (field.type === "multi_select") {
      if (!Array.isArray(answer)) {
        errors[field.id] = [`${field.label} must contain a list of choices`];
      }
      continue;
    }
    if (Array.isArray(answer)) {
      errors[field.id] = [`${field.label} must contain a single value`];
      continue;
    }
    if (field.id === "title" && answer.length > 180) {
      errors[field.id] = ["Session title must contain at most 180 characters"];
    }
  }
  for (const fieldId of Object.keys(uploads)) {
    const field = schema.fields.find((candidate) => candidate.id === fieldId);
    if (field?.type !== "video") {
      errors[fieldId] = ["This field does not accept a native video upload"];
    }
  }
  return errors;
}

export function visibleFields(
  schema: StoredSubmissionFormSchema,
  answers: Record<string, string | string[]>,
) {
  const visibleIds = new Set<string>();
  const orderedFields = formFieldsInDisplayOrder(schema);
  return orderedFields.filter((field) => {
    if (!field.condition) {
      visibleIds.add(field.id);
      return true;
    }
    if (!visibleIds.has(field.condition.fieldId)) return false;
    const dependency = answers[field.condition.fieldId];
    const visible = Array.isArray(dependency)
      ? dependency.includes(field.condition.equals)
      : dependency === field.condition.equals;
    if (visible) visibleIds.add(field.id);
    return visible;
  });
}

type FormSectionForDisplay<Field extends StoredFormField> = {
  id: string;
  title: string | null;
  description: string | null;
  fields: Field[];
};

export function formFieldsInDisplayOrder(
  schema: SubmissionFormSchema,
): FormField[];
export function formFieldsInDisplayOrder(
  schema: LegacySubmissionFormSchema,
): LegacyFormField[];
export function formFieldsInDisplayOrder(
  schema: StoredSubmissionFormSchema,
): StoredFormField[];
export function formFieldsInDisplayOrder(
  schema: StoredSubmissionFormSchema,
): StoredFormField[] {
  if (!("schemaVersion" in schema)) return schema.fields;
  const sectionIds = new Set(schema.sections.map((section) => section.id));
  for (const field of schema.fields) {
    if (!("sectionId" in field) || !sectionIds.has(field.sectionId)) {
      throw new Error(
        `Form field ${field.id} must reference an existing schema v2 section`,
      );
    }
  }
  return schema.sections.flatMap((section) =>
    schema.fields.filter((field) => field.sectionId === section.id),
  );
}

export function formSectionsForDisplay(
  schema: SubmissionFormSchema,
  fields?: FormField[],
): Array<FormSectionForDisplay<FormField>>;
export function formSectionsForDisplay(
  schema: LegacySubmissionFormSchema,
  fields?: LegacyFormField[],
): Array<FormSectionForDisplay<LegacyFormField>>;
export function formSectionsForDisplay(
  schema: StoredSubmissionFormSchema,
  fields?: StoredFormField[],
): Array<FormSectionForDisplay<StoredFormField>>;
export function formSectionsForDisplay(
  schema: StoredSubmissionFormSchema,
  fields: StoredFormField[] = schema.fields,
): Array<FormSectionForDisplay<StoredFormField>> {
  if (!("schemaVersion" in schema)) {
    return [
      {
        id: "legacy_application",
        title: null,
        description: null,
        fields,
      },
    ];
  }
  const sectionIds = new Set(schema.sections.map((section) => section.id));
  const versionTwoFields = fields.map((field) => {
    if (!("sectionId" in field) || !sectionIds.has(field.sectionId)) {
      throw new Error(
        `Form field ${field.id} must reference an existing schema v2 section`,
      );
    }
    return field;
  });
  return schema.sections
    .map((section) => ({
      ...section,
      fields: versionTwoFields.filter(
        (field) => field.sectionId === section.id,
      ),
    }))
    .filter((section) => section.fields.length > 0);
}

export function formSectionsForAuthoring(schema: SubmissionFormSchema) {
  const orderedFields = formFieldsInDisplayOrder(schema);
  return schema.sections.map((section) => ({
    ...section,
    fields: orderedFields.filter((field) => field.sectionId === section.id),
  }));
}

/** Runtime-only; outside the section/field ID grammar so it cannot collide. */
export const APPLICANT_SPEAKERS_STEP_ID = "__applicant_speakers";

export type ApplicantFormStep =
  | {
      kind: "section";
      id: string;
      title: string;
      description: string;
    }
  | {
      kind: "speakers";
      id: typeof APPLICANT_SPEAKERS_STEP_ID;
      title: "Speakers";
      description: string;
    };

export function formLayout(schema: StoredSubmissionFormSchema): FormLayout {
  if (!("schemaVersion" in schema)) return "single_page";
  return "layout" in schema && schema.layout === "steps"
    ? "steps"
    : "single_page";
}

export function formApplicantSteps(
  schema: StoredSubmissionFormSchema,
  answers: Record<string, string | string[]>,
): ApplicantFormStep[] {
  if (formLayout(schema) !== "steps") return [];
  const sections = formSectionsForDisplay(
    schema,
    visibleFields(schema, answers),
  );
  return [
    ...sections.map((section) => ({
      kind: "section" as const,
      id: section.id,
      title: section.title ?? "Application",
      description: section.description ?? "",
    })),
    {
      kind: "speakers" as const,
      id: APPLICANT_SPEAKERS_STEP_ID,
      title: "Speakers",
      description:
        "The first speaker is primary. Additional speakers receive a pending claim relationship and an expiring invitation after final submission.",
    },
  ];
}

/** If the current section is hidden, keep the next visible schema section,
 *  else the nearest prior section, else Speakers. Speakers is last because it
 *  is chrome, not a schema section; the prior section usually holds the
 *  controlling field. An empty current id is uninitialized, not vanished, so
 *  it resolves to the first visible step. */
export function resolveApplicantFormStepId(
  schema: StoredSubmissionFormSchema,
  answers: Record<string, string | string[]>,
  currentId: string,
): string {
  const steps = formApplicantSteps(schema, answers);
  if (steps.length === 0) return currentId;
  if (steps.some((step) => step.id === currentId)) return currentId;
  if (!currentId) return steps[0]?.id ?? currentId;

  const sectionOrder =
    "schemaVersion" in schema
      ? schema.sections.map((section) => section.id)
      : [];
  const currentIndex = sectionOrder.indexOf(currentId);
  if (currentIndex >= 0) {
    for (
      let index = currentIndex + 1;
      index < sectionOrder.length;
      index += 1
    ) {
      const nextId = sectionOrder[index];
      if (nextId && steps.some((step) => step.id === nextId)) return nextId;
    }
    for (let index = currentIndex - 1; index >= 0; index -= 1) {
      const priorId = sectionOrder[index];
      if (priorId && steps.some((step) => step.id === priorId)) return priorId;
    }
  }
  const speakers = steps.find((step) => step.kind === "speakers");
  return speakers?.id ?? steps[0]?.id ?? currentId;
}

export function applicantFormStepIdForField(
  schema: StoredSubmissionFormSchema,
  fieldId: string,
): string | null {
  if (!("schemaVersion" in schema)) return "legacy_application";
  const field = schema.fields.find((candidate) => candidate.id === fieldId);
  if (!field || !("sectionId" in field)) return null;
  return field.sectionId;
}

export function applicantFormStepIdForHref(
  schema: StoredSubmissionFormSchema,
  href: string,
): string | null {
  if (href === "#application-speakers") return APPLICANT_SPEAKERS_STEP_ID;
  if (href.startsWith("#answer-")) {
    return applicantFormStepIdForField(schema, href.slice("#answer-".length));
  }
  return null;
}

export function applicantFormStepIdForErrors(
  schema: StoredSubmissionFormSchema,
  errors?: Record<string, string[]>,
): string | null {
  if (!errors) return null;
  for (const field of formFieldsInDisplayOrder(schema)) {
    if (errors[field.id]?.length) {
      return applicantFormStepIdForField(schema, field.id);
    }
  }
  if (errors.speakers?.length) return APPLICANT_SPEAKERS_STEP_ID;
  const first = Object.keys(errors).find((key) => errors[key]?.length);
  return first ? applicantFormStepIdForField(schema, first) : null;
}

export function incompleteRequiredVisibleFields(
  schema: StoredSubmissionFormSchema,
  answers: Record<string, string | string[]>,
  uploads: Record<string, UploadReference> = {},
) {
  return visibleFields(schema, answers).filter((field) => {
    if (!field.required) return false;
    if (field.type === "video" && uploads[field.id]) return false;
    const value = answers[field.id];
    return Array.isArray(value)
      ? value.length === 0
      : !String(value ?? "").trim();
  });
}

/** First visible section for a new or reopened application. Failed
 *  submissions pass errors and land on the first invalid step. */
export function deriveInitialApplicantFormStepId({
  schema,
  answers,
  errors,
}: {
  schema: StoredSubmissionFormSchema;
  answers: Record<string, string | string[]>;
  errors?: Record<string, string[]>;
}): string {
  const steps = formApplicantSteps(schema, answers);
  if (steps.length === 0) return "";

  const errorStepId = applicantFormStepIdForErrors(schema, errors);
  if (errorStepId) {
    return resolveApplicantFormStepId(schema, answers, errorStepId);
  }

  return steps[0]?.id ?? "";
}

export function visibleAnswers(
  schema: StoredSubmissionFormSchema,
  answers: Record<string, string | string[]>,
) {
  return Object.fromEntries(
    visibleFields(schema, answers)
      .filter((field) => Object.hasOwn(answers, field.id))
      .map((field) => [field.id, answers[field.id]]),
  );
}

export function reviewerVisibleAnswers(
  schema: StoredSubmissionFormSchema,
  answers: Record<string, string | string[]>,
) {
  return Object.fromEntries(
    visibleFields(schema, answers)
      .filter((field) => field.reviewVisibility === "reviewers")
      .filter((field) => Object.hasOwn(answers, field.id))
      .map((field) => [field.id, answers[field.id]]),
  );
}
