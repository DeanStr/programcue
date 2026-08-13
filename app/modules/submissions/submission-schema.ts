import { z } from "zod";

export const fieldTypeSchema = z.enum([
  "short_text",
  "long_text",
  "select",
  "multi_select",
  "url",
  "video",
]);

export const formFieldSchema = z
  .object({
    id: z
      .string()
      .regex(/^[a-z][a-z0-9_]{1,39}$/, "Use a stable lowercase field ID"),
    label: z.string().trim().min(1).max(120),
    type: fieldTypeSchema,
    required: z.boolean().default(false),
    help: z.string().trim().max(300).default(""),
    example: z.string().trim().max(300).default(""),
    options: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
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
    if (new Set(field.options).size !== field.options.length) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "Choice options must be unique",
      });
    }
  });

export type FormField = z.infer<typeof formFieldSchema>;

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
  }, "Use a complete HTTPS URL without embedded credentials");

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

export const formSchemaSchema = z
  .object({
    introduction: z.string().trim().max(2_000).default(""),
    presentation: formPresentationSchema.default(DEFAULT_FORM_PRESENTATION),
    fields: z.array(formFieldSchema).min(1).max(50),
  })
  .superRefine((schema, context) => {
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

    schema.fields.forEach((field, index) => {
      if (!field.condition) return;
      const dependencyIndex = schema.fields.findIndex(
        (candidate) => candidate.id === field.condition?.fieldId,
      );
      if (dependencyIndex < 0 || dependencyIndex >= index) {
        context.addIssue({
          code: "custom",
          path: ["fields", index, "condition"],
          message: "Conditional fields must depend on an earlier field",
        });
      } else {
        const dependency = schema.fields[dependencyIndex];
        if (
          dependency &&
          dependency.type !== "select" &&
          dependency.type !== "multi_select"
        ) {
          context.addIssue({
            code: "custom",
            path: ["fields", index, "condition"],
            message: "Conditional fields must depend on a choice field",
          });
        } else if (
          dependency &&
          !dependency.options.includes(field.condition.equals)
        ) {
          context.addIssue({
            code: "custom",
            path: ["fields", index, "condition"],
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
  });

export type SubmissionFormSchema = z.infer<typeof formSchemaSchema>;

export const routingSchema = z.object({
  categories: z
    .record(z.string(), z.string().trim().min(1).max(100))
    .default({}),
  trackIds: z.record(z.string(), z.string().trim().min(1).max(100)),
  trackNames: z.record(z.string(), z.string().trim().min(1).max(120)),
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
    if (input.kind === "direct_session") {
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
            "Direct-session formats must be an always-visible required select with at least one option",
        });
      }
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

export const submittedSnapshotSchema = z.object({
  formVersionId: z.string().min(1).max(100),
  versionNumber: z.number().int().positive(),
  schema: formSchemaSchema,
  answers: draftPayloadSchema.shape.answers,
  speakers: draftPayloadSchema.shape.speakers,
  uploads: draftPayloadSchema.shape.uploads,
});

export type SubmittedSnapshot = z.infer<typeof submittedSnapshotSchema>;

export type FieldErrors = Record<string, string[]>;

export function validateAnswerShapes(
  schema: SubmissionFormSchema,
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
  schema: SubmissionFormSchema,
  answers: Record<string, string | string[]>,
) {
  const visibleIds = new Set<string>();
  return schema.fields.filter((field) => {
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

export function visibleAnswers(
  schema: SubmissionFormSchema,
  answers: Record<string, string | string[]>,
) {
  return Object.fromEntries(
    visibleFields(schema, answers)
      .filter((field) => Object.hasOwn(answers, field.id))
      .map((field) => [field.id, answers[field.id]]),
  );
}

export function reviewerVisibleAnswers(
  schema: SubmissionFormSchema,
  answers: Record<string, string | string[]>,
) {
  const visible = new Set(
    visibleFields(schema, answers).map((field) => field.id),
  );
  return Object.fromEntries(
    schema.fields
      .filter((field) => visible.has(field.id))
      .filter((field) => field.reviewVisibility === "reviewers")
      .filter((field) => Object.hasOwn(answers, field.id))
      .map((field) => [field.id, answers[field.id]]),
  );
}

export function validateFinalAnswers(
  schema: SubmissionFormSchema,
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
      try {
        const url = new URL(String(answer));
        if (url.protocol !== "https:") throw new Error("unsupported protocol");
      } catch {
        errors[field.id] = [`${field.label} must be a valid HTTPS URL`];
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
  const emails = speakers.map((speaker) => speaker.email.toLowerCase());
  if (new Set(emails).size !== emails.length)
    errors.speakers = ["Each speaker must use a different email address"];
  return errors;
}

export const DEFAULT_FORM_SCHEMA: SubmissionFormSchema = {
  introduction:
    "Share a practical session that gives attendees something useful to take away.",
  presentation: DEFAULT_FORM_PRESENTATION,
  fields: [
    {
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
      id: "video",
      label: "Optional pitch video",
      type: "video",
      required: false,
      help: "Upload an MP4/WebM file or link to a private or unlisted HTTPS video.",
      example: "https://…",
      options: [],
      reviewVisibility: "reviewers",
      blindReviewVisibility: "content",
      condition: null,
    },
  ],
};
