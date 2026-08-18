import { z } from "zod";

import { isCredentialFreeHttpsUrl } from "~/modules/events/https-url";

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

export const formSchemaSchema = z
  .object({
    schemaVersion: z.literal(2),
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
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        "Use lowercase letters, numbers and hyphens",
      ),
    closeDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable(),
    submissionLimit: nullablePositiveInteger,
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

export const speakerInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  biography: z.string().trim().max(5_000).optional(),
});

export const uploadReferenceSchema = z.object({
  assetId: z.string().min(1).max(180),
  versionId: z.string().min(1).max(180),
});

export type UploadReference = z.infer<typeof uploadReferenceSchema>;

export const draftPayloadSchema = z.object({
  submissionId: z.string().min(1).max(100),
  revision: z.coerce.number().int().nonnegative(),
  answers: z.record(
    z.string(),
    z.union([z.string().max(5_000), z.array(z.string().max(200)).max(30)]),
  ),
  speakers: z
    .array(speakerInputSchema)
    .min(1)
    .max(MAX_SUBMISSION_SPEAKERS)
    .superRefine((speakers, context) => {
      const emails = speakers.map((speaker) => speaker.email);
      if (new Set(emails).size !== emails.length) {
        context.addIssue({
          code: "custom",
          path: ["speakers"],
          message: "Each speaker must use a different email address",
        });
      }
    }),
  uploads: z
    .record(z.string().regex(/^[a-z][a-z0-9_]{1,39}$/), uploadReferenceSchema)
    .default({}),
});

export type DraftPayload = Omit<
  z.infer<typeof draftPayloadSchema>,
  "uploads"
> & {
  uploads?: Record<string, UploadReference>;
};

export const ADMIN_MANUAL_ENTRY_FORM_VERSION_ID = "manual-administrator-entry";

export const submittedSnapshotSchema = z.object({
  formVersionId: z.string().min(1).max(100),
  versionNumber: z.number().int().positive(),
  schema: storedFormSchemaSchema,
  answers: draftPayloadSchema.shape.answers,
  speakers: draftPayloadSchema.shape.speakers,
  uploads: draftPayloadSchema.shape.uploads,
});

export type SubmittedSnapshot = z.infer<typeof submittedSnapshotSchema>;

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

export function validateFinalAnswers(
  schema: StoredSubmissionFormSchema,
  answers: Record<string, string | string[]>,
  speakers: Array<{ name: string; email: string }>,
  minSpeakers: number,
  maxSpeakers: number | null,
  uploads: Record<string, UploadReference> = {},
) {
  const errors: FieldErrors = {};
  for (const field of visibleFields(schema, answers)) {
    const answer = answers[field.id];
    const missing = Array.isArray(answer)
      ? answer.length === 0
      : !String(answer ?? "").trim();
    if (field.required && missing && !uploads[field.id])
      errors[field.id] = [`${field.label} is required`];
    if (
      !missing &&
      (field.type === "select" || field.type === "multi_select")
    ) {
      const values = Array.isArray(answer) ? answer : [answer];
      if (new Set(values).size !== values.length) {
        errors[field.id] = [
          `${field.label} must not contain duplicate choices`,
        ];
      } else if (values.some((value) => !field.options.includes(value))) {
        errors[field.id] = [`${field.label} contains an invalid choice`];
      }
    }
    if (!missing && (field.type === "url" || field.type === "video")) {
      if (!isCredentialFreeHttpsUrl(String(answer))) {
        errors[field.id] = ["Enter a valid URL beginning with https://"];
      }
    }
  }

  if (speakers.length < minSpeakers)
    errors.speakers = [
      `Add at least ${minSpeakers} speaker${minSpeakers === 1 ? "" : "s"}`,
    ];
  const effectiveMaximum = Math.min(
    maxSpeakers ?? MAX_SUBMISSION_SPEAKERS,
    MAX_SUBMISSION_SPEAKERS,
  );
  if (speakers.length > effectiveMaximum)
    errors.speakers = [`This form allows at most ${effectiveMaximum} speakers`];
  if (
    speakers.some((speaker) => !speaker.name.trim() || !speaker.email.trim())
  ) {
    errors.speakers = ["Every speaker needs a name and email address"];
  } else if (
    speakers.some(
      (speaker) => !z.email().safeParse(speaker.email.trim()).success,
    )
  ) {
    errors.speakers = ["Every speaker needs a valid email address"];
  } else {
    const emails = speakers.map((speaker) =>
      speaker.email.trim().toLowerCase(),
    );
    if (new Set(emails).size !== emails.length)
      errors.speakers = ["Each speaker must use a different email address"];
  }
  return errors;
}

export const DEFAULT_FORM_SCHEMA: SubmissionFormSchema = {
  schemaVersion: 2,
  introduction:
    "Share a practical session that gives attendees something useful to take away.",
  presentation: DEFAULT_FORM_PRESENTATION,
  sections: [
    {
      id: "proposal",
      title: "Session proposal",
      description: "Tell us what you want to share with attendees.",
    },
  ],
  fields: [
    {
      sectionId: "proposal",
      id: "title",
      label: "Session title",
      type: "short_text",
      required: true,
      help: "Use a clear, attendee-focused title.",
      example: "How a small programme team removed three weeks of manual work",
      options: [],
      reviewVisibility: "reviewers",
      blindReviewVisibility: "content",
      condition: null,
    },
    {
      sectionId: "proposal",
      id: "description",
      label: "Session description",
      type: "long_text",
      required: true,
      help: "What will attendees learn?",
      example:
        "Describe the problem, what you tried, the outcome and what attendees can apply themselves.",
      options: [],
      reviewVisibility: "reviewers",
      blindReviewVisibility: "content",
      condition: null,
    },
    {
      sectionId: "proposal",
      id: "category",
      label: "Tracks",
      type: "multi_select",
      required: true,
      help: "Choose every programme track this proposal should be reviewed for.",
      example: "",
      options: ["AI & Innovation", "Event Operations", "Experience Design"],
      reviewVisibility: "reviewers",
      blindReviewVisibility: "content",
      condition: null,
    },
    {
      sectionId: "proposal",
      id: "format",
      label: "Format",
      type: "select",
      required: true,
      help: "",
      example: "",
      options: ["Workshop", "Presentation", "Panel", "Keynote"],
      reviewVisibility: "reviewers",
      blindReviewVisibility: "content",
      condition: null,
    },
    {
      sectionId: "proposal",
      id: "materials",
      label: "Materials and room setup",
      type: "long_text",
      required: true,
      help: "List any equipment or setup required.",
      example: "Moveable tables, a projector and space for groups of six.",
      options: [],
      reviewVisibility: "reviewers",
      blindReviewVisibility: "content",
      condition: { fieldId: "format", equals: "Workshop" },
    },
    {
      sectionId: "proposal",
      id: "video",
      label: "Optional pitch video",
      type: "video",
      required: false,
      help: "Upload an MP4/WebM file or link to a private or unlisted HTTPS video.",
      example: "",
      options: [],
      reviewVisibility: "reviewers",
      blindReviewVisibility: "content",
      condition: null,
    },
  ],
};
