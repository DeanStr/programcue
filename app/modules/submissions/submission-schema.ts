import { z } from "zod";

export const fieldTypeSchema = z.enum([
  "short_text",
  "long_text",
  "select",
  "multi_select",
  "url",
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
    options: z.array(z.string().trim().min(1).max(80)).max(30).default([]),
    reviewVisibility: z.enum(["reviewers", "administrators_only"]).optional(),
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
  });

export type FormField = z.infer<typeof formFieldSchema>;

export const formSchemaSchema = z
  .object({
    introduction: z.string().trim().max(2_000).default(""),
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
  });

export type SubmissionFormSchema = z.infer<typeof formSchemaSchema>;

export const routingSchema = z.object({
  categories: z.record(z.string(), z.string().trim().max(120)).default({}),
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
    minSpeakers: z.coerce.number().int().min(1).max(20),
    maxSpeakers: nullablePositiveInteger,
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
      !input.routing.passwordHash
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
  });

export type SaveFormInput = z.infer<typeof saveFormSchema>;

export const speakerInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
});

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
    .max(20)
    .superRefine((speakers, context) => {
      const emails = speakers.map((speaker) => speaker.email);
      if (new Set(emails).size !== emails.length) {
        context.addIssue({
          code: "custom",
          message: "Each speaker must use a different email address",
        });
      }
    }),
});

export type DraftPayload = z.infer<typeof draftPayloadSchema>;

export const submittedSnapshotSchema = z.object({
  formVersionId: z.string().min(1).max(100),
  versionNumber: z.number().int().positive(),
  schema: formSchemaSchema,
  answers: draftPayloadSchema.shape.answers,
  speakers: draftPayloadSchema.shape.speakers,
});

export type SubmittedSnapshot = z.infer<typeof submittedSnapshotSchema>;

export type FieldErrors = Record<string, string[]>;

export function validateAnswerShapes(
  schema: SubmissionFormSchema,
  answers: Record<string, string | string[]>,
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
  return errors;
}

export function visibleFields(
  schema: SubmissionFormSchema,
  answers: Record<string, string | string[]>,
) {
  return schema.fields.filter((field) => {
    if (!field.condition) return true;
    const dependency = answers[field.condition.fieldId];
    return Array.isArray(dependency)
      ? dependency.includes(field.condition.equals)
      : dependency === field.condition.equals;
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
  return Object.fromEntries(
    schema.fields
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
) {
  const errors: FieldErrors = {};
  for (const field of visibleFields(schema, answers)) {
    const answer = answers[field.id];
    const missing = Array.isArray(answer)
      ? answer.length === 0
      : !String(answer ?? "").trim();
    if (field.required && missing)
      errors[field.id] = [`${field.label} is required`];
    if (
      !missing &&
      (field.type === "select" || field.type === "multi_select")
    ) {
      const values = Array.isArray(answer) ? answer : [answer];
      if (values.some((value) => !field.options.includes(value))) {
        errors[field.id] = [`${field.label} contains an invalid choice`];
      }
    }
    if (!missing && field.type === "url") {
      try {
        new URL(String(answer));
      } catch {
        errors[field.id] = [`${field.label} must be a valid URL`];
      }
    }
  }

  if (speakers.length < minSpeakers)
    errors.speakers = [
      `Add at least ${minSpeakers} speaker${minSpeakers === 1 ? "" : "s"}`,
    ];
  if (maxSpeakers !== null && speakers.length > maxSpeakers)
    errors.speakers = [`This form allows at most ${maxSpeakers} speakers`];
  const emails = speakers.map((speaker) => speaker.email.toLowerCase());
  if (new Set(emails).size !== emails.length)
    errors.speakers = ["Each speaker must use a different email address"];
  return errors;
}

export const DEFAULT_FORM_SCHEMA: SubmissionFormSchema = {
  introduction:
    "Share a practical session that gives attendees something useful to take away.",
  fields: [
    {
      id: "title",
      label: "Session title",
      type: "short_text",
      required: true,
      help: "Use a clear, attendee-focused title.",
      options: [],
      reviewVisibility: "reviewers",
      condition: null,
    },
    {
      id: "description",
      label: "Session description",
      type: "long_text",
      required: true,
      help: "What will attendees learn?",
      options: [],
      reviewVisibility: "reviewers",
      condition: null,
    },
    {
      id: "category",
      label: "Session category",
      type: "select",
      required: true,
      help: "",
      options: ["AI & Innovation", "Event Operations", "Experience Design"],
      reviewVisibility: "reviewers",
      condition: null,
    },
    {
      id: "format",
      label: "Format",
      type: "select",
      required: true,
      help: "",
      options: ["Workshop", "Presentation", "Panel", "Keynote"],
      reviewVisibility: "reviewers",
      condition: null,
    },
    {
      id: "materials",
      label: "Materials and room setup",
      type: "long_text",
      required: true,
      help: "List any equipment or setup required.",
      options: [],
      reviewVisibility: "reviewers",
      condition: { fieldId: "format", equals: "Workshop" },
    },
    {
      id: "video",
      label: "Optional pitch video",
      type: "url",
      required: false,
      help: "Link to a private or unlisted video.",
      options: [],
      reviewVisibility: "reviewers",
      condition: null,
    },
  ],
};
