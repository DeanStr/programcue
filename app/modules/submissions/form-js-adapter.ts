import { z } from "zod";

import {
  formSchemaSchema,
  type FormField,
  type SubmissionFormSchema,
} from "./submission-schema";

const ADAPTER_VERSION = 1 as const;
const INTRODUCTION_ID = "ProgramCue_Introduction";

export const PROGRAM_CUE_FORM_JS_TYPES = {
  title: "programcue_title",
  category: "programcue_category",
  format: "programcue_format",
  url: "programcue_url",
  video: "programcue_video",
} as const;

const supportedComponentTypes = z.enum([
  "text",
  "textfield",
  "textarea",
  "select",
  "checklist",
  ...Object.values(PROGRAM_CUE_FORM_JS_TYPES),
]);

const formJsValueSchema = z
  .object({
    label: z.string().min(1).max(80),
    value: z.string().min(1).max(80),
  })
  .strict();

const formJsConditionSchema = z
  .object({ hide: z.string().min(1).max(300) })
  .strict();

const formJsValidationSchema = z
  .object({ required: z.boolean().optional() })
  .strict();

const formJsLayoutSchema = z
  .object({
    row: z.string().max(100).optional(),
    columns: z.null().optional(),
  })
  .strict();

const programCueFieldMetadataSchema = z
  .object({
    fieldType: z.enum([
      "short_text",
      "long_text",
      "select",
      "multi_select",
      "url",
      "video",
    ]),
    reviewVisibility: z.enum(["reviewers", "administrators_only"]),
    example: z.string().max(300).optional(),
  })
  .strict();

const formJsComponentSchema = z
  .object({
    id: z.string().min(1).max(120),
    type: supportedComponentTypes,
    key: z.string().max(100).optional(),
    label: z.string().max(120).optional(),
    text: z.string().max(2_000).optional(),
    description: z.string().max(300).optional(),
    validate: formJsValidationSchema.optional(),
    values: z.array(formJsValueSchema).max(30).optional(),
    conditional: formJsConditionSchema.optional(),
    layout: formJsLayoutSchema.optional(),
    programCue: programCueFieldMetadataSchema.optional(),
  })
  .strict();

const formJsSchemaSchema = z
  .object({
    id: z.string().min(1).max(120),
    type: z.literal("default"),
    components: z.array(formJsComponentSchema).max(51),
    schemaVersion: z.number().int().positive().optional(),
    exporter: z.record(z.string(), z.unknown()).optional(),
    $schema: z.string().optional(),
    programCue: z
      .object({ adapterVersion: z.literal(ADAPTER_VERSION) })
      .strict(),
  })
  .strict();

export type ProgramCueFormJsSchema = z.infer<typeof formJsSchemaSchema>;

export class FormJsAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormJsAdapterError";
  }
}

function componentTypeFor(field: FormField) {
  if (field.id === "title") return PROGRAM_CUE_FORM_JS_TYPES.title;
  if (field.id === "category") return PROGRAM_CUE_FORM_JS_TYPES.category;
  if (field.id === "format") return PROGRAM_CUE_FORM_JS_TYPES.format;
  if (field.type === "url") return PROGRAM_CUE_FORM_JS_TYPES.url;
  if (field.type === "video") return PROGRAM_CUE_FORM_JS_TYPES.video;
  if (field.type === "long_text") return "textarea" as const;
  if (field.type === "select") return "select" as const;
  if (field.type === "multi_select") return "checklist" as const;
  return "textfield" as const;
}

function conditionToFeel(condition: NonNullable<FormField["condition"]>) {
  return `=${condition.fieldId} != ${JSON.stringify(condition.equals)}`;
}

function conditionFromFeel(expression: string) {
  const match = expression.match(
    /^=([a-z][a-z0-9_]{1,39}) != ("(?:[^"\\]|\\.)*")$/,
  );
  if (!match) {
    throw new FormJsAdapterError(
      'Program Cue conditions must use the supported equality form, for example =category != "Workshop".',
    );
  }
  let equals: unknown;
  try {
    equals = JSON.parse(match[2]);
  } catch {
    throw new FormJsAdapterError(
      "The conditional comparison value is not a valid quoted string.",
    );
  }
  if (typeof equals !== "string") {
    throw new FormJsAdapterError(
      "The conditional comparison value must be a quoted string.",
    );
  }
  return { fieldId: match[1], equals };
}

function fieldTypeFor(
  component: z.infer<typeof formJsComponentSchema>,
): FormField["type"] {
  if (component.id.startsWith("ProgramCue_Field_") && !component.programCue) {
    throw new FormJsAdapterError(
      `Existing field ${component.key ?? component.id} is missing its Program Cue access metadata.`,
    );
  }
  const inferred =
    component.type === "textarea"
      ? "long_text"
      : component.type === "select" ||
          component.type === PROGRAM_CUE_FORM_JS_TYPES.format
        ? "select"
        : component.type === "checklist" ||
            component.type === PROGRAM_CUE_FORM_JS_TYPES.category
          ? "multi_select"
          : component.type === PROGRAM_CUE_FORM_JS_TYPES.url
            ? "url"
            : component.type === PROGRAM_CUE_FORM_JS_TYPES.video
              ? "video"
              : "short_text";

  if (component.programCue && component.programCue.fieldType !== inferred) {
    throw new FormJsAdapterError(
      `Field ${component.key ?? component.id} has incompatible Program Cue and form-js field types.`,
    );
  }
  return inferred;
}

function optionsFor(
  component: z.infer<typeof formJsComponentSchema>,
  type: FormField["type"],
) {
  if (type !== "select" && type !== "multi_select") {
    if (component.values !== undefined) {
      throw new FormJsAdapterError(
        `Field ${component.key ?? component.id} cannot define choice options.`,
      );
    }
    return [];
  }
  if (!component.values?.length) {
    throw new FormJsAdapterError(
      `Choice field ${component.key ?? component.id} needs at least one static option.`,
    );
  }
  return component.values.map((option) => {
    if (option.label !== option.value) {
      throw new FormJsAdapterError(
        `Choice field ${component.key ?? component.id} must use the same stored value and visible label.`,
      );
    }
    return option.value;
  });
}

function assertComponentProperties(
  component: z.infer<typeof formJsComponentSchema>,
) {
  if (component.type === "text") {
    const unsupportedProperty = [
      "key",
      "label",
      "description",
      "validate",
      "values",
      "conditional",
      "programCue",
    ].find(
      (property) => component[property as keyof typeof component] !== undefined,
    );
    if (unsupportedProperty) {
      throw new FormJsAdapterError(
        `The Program Cue introduction cannot define ${unsupportedProperty}.`,
      );
    }
    return;
  }

  if (component.text !== undefined) {
    throw new FormJsAdapterError(
      `Field ${component.key ?? component.id} cannot define text-block content.`,
    );
  }
}

function assertProtectedConferenceType(
  component: z.infer<typeof formJsComponentSchema>,
) {
  const protectedKeys: Partial<
    Record<
      (typeof PROGRAM_CUE_FORM_JS_TYPES)[keyof typeof PROGRAM_CUE_FORM_JS_TYPES],
      string
    >
  > = {
    [PROGRAM_CUE_FORM_JS_TYPES.title]: "title",
    [PROGRAM_CUE_FORM_JS_TYPES.category]: "category",
    [PROGRAM_CUE_FORM_JS_TYPES.format]: "format",
  };
  const requiredKey =
    protectedKeys[component.type as keyof typeof protectedKeys];
  if (requiredKey && component.key !== requiredKey) {
    throw new FormJsAdapterError(
      `${component.type} is reserved for the ${requiredKey} conference field.`,
    );
  }
}

export function toFormJsSchema(
  schema: SubmissionFormSchema,
): ProgramCueFormJsSchema {
  const parsed = formSchemaSchema.parse(schema);
  return {
    id: "ProgramCue_Form",
    type: "default",
    programCue: { adapterVersion: ADAPTER_VERSION },
    components: [
      {
        id: INTRODUCTION_ID,
        type: "text",
        text: parsed.introduction,
      },
      ...parsed.fields.map((field) => ({
        id: `ProgramCue_Field_${field.id}`,
        key: field.id,
        label: field.label,
        type: componentTypeFor(field),
        description: field.help || undefined,
        validate: field.required ? { required: true } : undefined,
        values:
          field.type === "select" || field.type === "multi_select"
            ? field.options.map((option) => ({ label: option, value: option }))
            : undefined,
        conditional: field.condition
          ? { hide: conditionToFeel(field.condition) }
          : undefined,
        programCue: {
          fieldType: field.type,
          reviewVisibility: field.reviewVisibility ?? "administrators_only",
          example: field.example || undefined,
        },
      })),
    ],
  };
}

export function fromFormJsSchema(
  input: unknown,
  presentation: SubmissionFormSchema["presentation"],
): SubmissionFormSchema {
  const parsed = formJsSchemaSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new FormJsAdapterError(
      issue
        ? `Unsupported form-js schema at ${issue.path.join(".") || "root"}: ${issue.message}`
        : "The form-js schema is invalid.",
    );
  }

  const introductionComponents = parsed.data.components.filter(
    (component) => component.type === "text",
  );
  if (
    introductionComponents.length !== 1 ||
    introductionComponents[0]?.id !== INTRODUCTION_ID
  ) {
    throw new FormJsAdapterError(
      "The visual form must retain exactly one Program Cue introduction block.",
    );
  }
  parsed.data.components.forEach(assertComponentProperties);

  const fields = parsed.data.components
    .filter((component) => component.type !== "text")
    .map((component): FormField => {
      assertProtectedConferenceType(component);
      if (!component.key) {
        throw new FormJsAdapterError(
          `Field ${component.id} needs a stable Program Cue key.`,
        );
      }
      if (!component.label) {
        throw new FormJsAdapterError(
          `Field ${component.key} needs a visible label.`,
        );
      }
      const type = fieldTypeFor(component);
      return {
        id: component.key,
        label: component.label,
        type,
        required: component.validate?.required ?? false,
        help: component.description ?? "",
        example: component.programCue?.example ?? "",
        options: optionsFor(component, type),
        reviewVisibility:
          component.programCue?.reviewVisibility ?? "administrators_only",
        condition: component.conditional
          ? conditionFromFeel(component.conditional.hide)
          : null,
      };
    });

  const normalized = formSchemaSchema.safeParse({
    introduction: introductionComponents[0]?.text ?? "",
    presentation,
    fields,
  });
  if (!normalized.success) {
    const issue = normalized.error.issues[0];
    throw new FormJsAdapterError(
      issue?.message ?? "The visual form violates Program Cue form rules.",
    );
  }
  return normalized.data;
}
