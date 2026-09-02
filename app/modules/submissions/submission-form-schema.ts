import { z } from "zod";

export const fieldTypeSchema = z.enum([
  "short_text",
  "long_text",
  "select",
  "multi_select",
  "url",
  "video",
]);

const legacyFormFieldSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9_]{1,39}$/, "Use a stable lowercase field ID"),
    label: z.string().trim().min(1).max(120),
    type: fieldTypeSchema,
    required: z.boolean().default(false),
    help: z.string().trim().max(300).default(""),
    example: z.string().trim().max(300).default(""),
    options: z.array(z.string().trim().min(1).max(80)).max(100).default([]),
    reviewVisibility: z.enum(["reviewers", "administrators_only"]).optional(),
    /**
     * Blind review is fail-closed: a field must be explicitly classified as
     * content before it can be returned to a blinded reviewer.
     */
    blindReviewVisibility: z.enum(["content", "identity"]).optional(),
    condition: z
      .object({
        fieldId: z.string(),
        equals: z.string().max(120),
      })
      .nullable()
      .default(null),
  })
  .strict()
  .superRefine((field, context) => {
    if (
      (field.type === "select" || field.type === "multi_select") &&
      field.options.length < 1
    ) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "Choice fields need at least one option",
      });
    }
    if (
      new Set(field.options.map((option) => option.toLocaleLowerCase()))
        .size !== field.options.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "Choice options must be unique",
      });
    }
  });

export const formFieldSchema = legacyFormFieldSchema.safeExtend({
  sectionId: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,39}$/, "Use a stable lowercase section ID"),
});

export type FormField = z.infer<typeof formFieldSchema>;
export type LegacyFormField = z.infer<typeof legacyFormFieldSchema>;
export type StoredFormField = LegacyFormField | FormField;

export function isPlaceholderOnlyFieldExample(value: string) {
  const text = value.trim();
  if (!text) return false;
  return /^https?:\/\/[.…]{0,8}$/iu.test(text) || /^[.…]{1,8}$/u.test(text);
}

const optionalHttpsUrl = z
  .string()
  .trim()
  .max(2_048)
  .refine((value) => {
    if (value === "") return true;
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        Boolean(url.hostname) &&
        !url.username &&
        !url.password
      );
    } catch {
      return false;
    }
  }, "Enter a valid URL beginning with https://");

export const heroImagePathSchema = z
  .string()
  .trim()
  .max(300)
  .refine(
    (value) =>
      value === "" ||
      (/^\/images\/[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u.test(value) &&
        !value.includes("..")),
    "Use a same-origin path below /images/",
  )
  .default("");

export const formPresentationSchema = z
  .object({
    heroImagePath: heroImagePathSchema,
    invitationHeading: z.string().trim().max(160).default(""),
    invitationText: z.string().trim().max(2_000).default(""),
    organizerName: z.string().trim().max(120).default(""),
    organizerRole: z.string().trim().max(180).default(""),
    eventWebsiteUrl: optionalHttpsUrl.default(""),
    estimatedMinutes: z.number().int().min(1).max(120).default(10),
    showFeaturedSpeakers: z.boolean().default(false),
  })
  .superRefine((presentation, context) => {
    if (presentation.organizerRole && !presentation.organizerName) {
      context.addIssue({
        code: "custom",
        path: ["organizerName"],
        message: "Add an organiser name before its role or context",
      });
    }
  });

export type FormPresentation = z.infer<typeof formPresentationSchema>;

export const MAX_FORM_FIELDS = 50;
export const MAX_FORM_SECTIONS = 20;

export const DEFAULT_FORM_PRESENTATION: FormPresentation = {
  heroImagePath: "",
  invitationHeading: "",
  invitationText: "",
  organizerName: "",
  organizerRole: "",
  eventWebsiteUrl: "",
  estimatedMinutes: 10,
  showFeaturedSpeakers: false,
};

function validateFormFields(
  schema: { fields: StoredFormField[] },
  context: z.RefinementCtx,
  orderedFields: StoredFormField[] = schema.fields,
) {
  const ids = new Set<string>();
  schema.fields.forEach((field, index) => {
    if (ids.has(field.id)) {
      context.addIssue({
        code: "custom",
        path: ["fields", index, "id"],
        message: "Field IDs must be unique",
      });
    }
    ids.add(field.id);
  });

  orderedFields.forEach((field, index) => {
    if (!field.condition) return;
    const schemaIndex = schema.fields.findIndex(
      (candidate) => candidate.id === field.id,
    );
    const dependencyIndex = orderedFields.findIndex(
      (candidate) => candidate.id === field.condition?.fieldId,
    );
    if (dependencyIndex < 0 || dependencyIndex >= index) {
      context.addIssue({
        code: "custom",
        path: ["fields", schemaIndex, "condition"],
        message: "Conditional fields must depend on an earlier field",
      });
    } else {
      const dependency = orderedFields[dependencyIndex];
      if (
        dependency &&
        dependency.type !== "select" &&
        dependency.type !== "multi_select"
      ) {
        context.addIssue({
          code: "custom",
          path: ["fields", schemaIndex, "condition"],
          message: "Conditional fields must depend on a choice field",
        });
      } else if (
        dependency &&
        !dependency.options.includes(field.condition.equals)
      ) {
        context.addIssue({
          code: "custom",
          path: ["fields", schemaIndex, "condition"],
          message: "Conditional values must match an available choice",
        });
      }
    }
  });

  for (const requiredId of ["title", "category", "format"] as const) {
    if (!ids.has(requiredId)) {
      context.addIssue({
        code: "custom",
        path: ["fields"],
        message: `The ${requiredId} field is required`,
      });
    }
  }

  if (schema.fields.filter((field) => field.type === "video").length > 1) {
    context.addIssue({
      code: "custom",
      path: ["fields"],
      message: "A form can contain at most one native video upload field",
    });
  }
}

const legacyFormSchemaSchema = z
  .object({
    introduction: z.string().trim().max(2_000).default(""),
    presentation: formPresentationSchema.default(DEFAULT_FORM_PRESENTATION),
    fields: z.array(legacyFormFieldSchema).min(1).max(MAX_FORM_FIELDS),
  })
  .strict()
  .superRefine(validateFormFields);

export const formSectionSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9_]{1,39}$/, "Use a stable lowercase section ID"),
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).default(""),
  })
  .strict();

export type FormSection = z.infer<typeof formSectionSchema>;

export const formLayoutSchema = z.enum(["single_page", "steps"]);
export type FormLayout = z.infer<typeof formLayoutSchema>;

export const formSchemaSchema = z
  .object({
    schemaVersion: z.literal(2),
    layout: formLayoutSchema.default("single_page"),
    introduction: z.string().trim().max(2_000).default(""),
    presentation: formPresentationSchema.default(DEFAULT_FORM_PRESENTATION),
    sections: z.array(formSectionSchema).min(1).max(MAX_FORM_SECTIONS),
    fields: z.array(formFieldSchema).min(1).max(MAX_FORM_FIELDS),
  })
  .strict()
  .superRefine((schema, context) => {
    const sectionIds = new Set<string>();
    schema.sections.forEach((section, index) => {
      if (sectionIds.has(section.id)) {
        context.addIssue({
          code: "custom",
          path: ["sections", index, "id"],
          message: "Section IDs must be unique",
        });
      }
      sectionIds.add(section.id);
    });
    schema.fields.forEach((field, index) => {
      if (!sectionIds.has(field.sectionId)) {
        context.addIssue({
          code: "custom",
          path: ["fields", index, "sectionId"],
          message: "Every field must reference an existing section",
        });
      }
    });
    const orderedFields = schema.sections.flatMap((section) =>
      schema.fields.filter((field) => field.sectionId === section.id),
    );
    validateFormFields(schema, context, orderedFields);
  });

export type SubmissionFormSchema = z.infer<typeof formSchemaSchema>;
export type LegacySubmissionFormSchema = z.infer<typeof legacyFormSchemaSchema>;
export type StoredSubmissionFormSchema =
  | LegacySubmissionFormSchema
  | SubmissionFormSchema;

export const storedFormSchemaSchema = z.union([
  formSchemaSchema,
  legacyFormSchemaSchema,
]);

export function storedFormSchemaVersion(schema: StoredSubmissionFormSchema) {
  return "schemaVersion" in schema ? 2 : 1;
}

export function upgradeStoredFormSchema(
  schema: StoredSubmissionFormSchema,
): SubmissionFormSchema {
  if ("schemaVersion" in schema) return schema;
  const section = {
    id: "proposal",
    title: "Application",
    description: "",
  };
  return formSchemaSchema.parse({
    schemaVersion: 2,
    layout: "single_page",
    introduction: schema.introduction,
    presentation: schema.presentation,
    sections: [section],
    fields: schema.fields.map((field) => ({
      ...field,
      sectionId: section.id,
    })),
  });
}

export const routingSchema = z.object({
  categories: z
    .record(z.string(), z.string().trim().min(1).max(100))
    .default({}),
  trackIds: z.record(z.string(), z.string().trim().min(1).max(100)),
  trackNames: z.record(z.string(), z.string().trim().min(1).max(120)),
  formatKeys: z.record(z.string(), z.string().trim().min(1).max(80)).optional(),
  teamNames: z
    .record(z.string(), z.string().trim().min(1).max(120))
    .default({}),
  directSessionDurationMinutes: z
    .number()
    .int()
    .min(5)
    .max(480)
    .nullable()
    .default(null),
  passwordHash: z.string().nullable().default(null),
});

export type FormRouting = z.infer<typeof routingSchema>;

const nullablePositiveInteger = z.preprocess(
  (value) =>
    value === "" || value === null || value === undefined
      ? null
      : Number(value),
  z.number().int().positive().nullable(),
);

export const MAX_SUBMISSION_SPEAKERS = 20;

const optionalPositiveInteger = z.preprocess(
  (value) =>
    value === "" || value === null || value === undefined
      ? undefined
      : Number(value),
  z.number().int().positive().optional(),
);

export const saveFormSchema = z
  .object({
    id: z.string().min(1).max(100).optional(),
    revision: optionalPositiveInteger,
    draftRevision: optionalPositiveInteger,
    name: z.string().trim().min(3).max(160),
    kind: z.enum(["submission", "direct_session"]),
    publicSlug: z
      .string()
      .trim()
      .max(160)
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        "Use lowercase letters, numbers and hyphens",
      ),
    openDate: z.iso.date().nullable().optional(),
    closeDate: z.iso.date().nullable(),
    submissionLimit: nullablePositiveInteger,
    perPersonSubmissionLimit: nullablePositiveInteger.optional(),
    minSpeakers: z.coerce.number().int().min(1).max(MAX_SUBMISSION_SPEAKERS),
    maxSpeakers: nullablePositiveInteger.pipe(
      z.number().int().positive().max(MAX_SUBMISSION_SPEAKERS).nullable(),
    ),
    accessMode: z.enum([
      "email_verified",
      "account_required",
      "password_protected",
    ]),
    accessPassword: z.string().max(100).default(""),
    schema: formSchemaSchema,
    routing: routingSchema,
  })
  .superRefine((input, context) => {
    if (
      input.id &&
      (input.revision === undefined || input.draftRevision === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["revision"],
        message: "Refresh the form before saving it again",
      });
    }
    if (input.maxSpeakers !== null && input.maxSpeakers < input.minSpeakers) {
      context.addIssue({
        code: "custom",
        path: ["maxSpeakers"],
        message: "Maximum speakers cannot be below the minimum",
      });
    }
    if (input.openDate && input.closeDate && input.openDate > input.closeDate) {
      context.addIssue({
        code: "custom",
        path: ["closeDate"],
        message: "Closing date cannot be before the opening date",
      });
    }
    input.schema.fields.forEach((field, index) => {
      if (!isPlaceholderOnlyFieldExample(field.example)) return;
      context.addIssue({
        code: "custom",
        path: ["schema", "fields", index, "example"],
        message: "Give a complete example or leave the example empty",
      });
    });
    if (
      input.accessMode === "password_protected" &&
      !input.accessPassword &&
      !input.id
    ) {
      context.addIssue({
        code: "custom",
        path: ["accessPassword"],
        message: "Set a password for password-protected forms",
      });
    }
    if (input.accessPassword && input.accessPassword.length < 8) {
      context.addIssue({
        code: "custom",
        path: ["accessPassword"],
        message: "Form passwords must contain at least 8 characters",
      });
    }
    const categoryField = input.schema.fields.find(
      (field) => field.id === "category",
    );
    const titleField = input.schema.fields.find(
      (field) => field.id === "title",
    );
    if (
      titleField?.type !== "short_text" ||
      !titleField.required ||
      titleField.condition !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["schema", "fields"],
        message:
          "The session title must be an always-visible required short-text field",
      });
    }
    const expectedCategoryType =
      input.kind === "direct_session" ? "select" : "multi_select";
    if (categoryField?.type !== expectedCategoryType) {
      context.addIssue({
        code: "custom",
        path: ["schema", "fields"],
        message:
          input.kind === "direct_session"
            ? "The direct-session track field must allow exactly one choice"
            : "The application tracks field must allow one or more choices",
      });
    } else {
      if (categoryField.options.length === 0) {
        context.addIssue({
          code: "custom",
          path: ["schema", "fields"],
          message: "The tracks field must offer at least one event track",
        });
      }
      if (!categoryField.required || categoryField.condition !== null) {
        context.addIssue({
          code: "custom",
          path: ["schema", "fields"],
          message: "The tracks field must be always visible and required",
        });
      }
      for (const trackName of Object.keys(input.routing.categories)) {
        if (!categoryField.options.includes(trackName)) {
          context.addIssue({
            code: "custom",
            path: ["routing", "categories", trackName],
            message: "Review routes must match a current track option",
          });
        }
      }
    }
    const formatField = input.schema.fields.find(
      (field) => field.id === "format",
    );
    if (
      formatField?.type !== "select" ||
      !formatField.required ||
      formatField.condition !== null ||
      formatField.options.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["schema", "fields"],
        message:
          "Session formats must be an always-visible required select with at least one option",
      });
    }
  });

export type SaveFormInput = z.infer<typeof saveFormSchema>;
