import { z } from "zod";

export const TEMPLATE_BODY_MAX_LENGTH = 100_000;
export const SUBMISSION_CONFIRMATION_MANAGEMENT_BODY_SUFFIX =
  "\n\nManage application: {{submission.url}}";

export const communicationCategorySchema = z.enum([
  "submission_confirmation",
  "decision",
  "task_reminder",
  "schedule",
  "calendar",
  "ad_hoc",
]);

export const audienceTypeSchema = z.enum([
  "submitted_applicants",
  "decision_recipients",
  "accepted_speakers",
  "active_speakers",
  "incomplete_speakers",
  "due_speakers",
  "overdue_speakers",
  "draft_applicants",
  "pending_participants",
  "event_administrators",
  "manual",
]);

export const templateContentSchema = z
  .object({
    body: z
      .string()
      .trim()
      .min(1, "Message body is required.")
      .max(TEMPLATE_BODY_MAX_LENGTH),
    physicalAddress: z
      .string()
      .trim()
      .min(1, "A physical address is required in the email footer.")
      .max(500),
    buttonText: z.string().trim().max(80).optional(),
    buttonUrl: z
      .url()
      .refine((url) => new URL(url).protocol === "https:", {
        message: "Button URL must use HTTPS.",
      })
      .optional(),
  })
  .superRefine((value, context) => {
    if (Boolean(value.buttonText) !== Boolean(value.buttonUrl)) {
      context.addIssue({
        code: "custom",
        path: [value.buttonText ? "buttonUrl" : "buttonText"],
        message: "Button text and URL must be supplied together.",
      });
    }
  });

export const saveTemplateSchema = z
  .object({
    templateId: z.uuid().optional(),
    name: z.string().trim().min(1).max(160),
    category: communicationCategorySchema,
    subject: z.string().trim().min(1).max(200),
    content: templateContentSchema,
  })
  .superRefine((value, context) => {
    if (
      value.category === "submission_confirmation" &&
      (value.content.buttonText || value.content.buttonUrl)
    ) {
      context.addIssue({
        code: "custom",
        path: ["content"],
        message:
          "Submission confirmations use the product-owned Manage application action and cannot configure a custom button.",
      });
    }
    if (
      value.category === "submission_confirmation" &&
      value.content.body.length +
        SUBMISSION_CONFIRMATION_MANAGEMENT_BODY_SUFFIX.length >
        TEMPLATE_BODY_MAX_LENGTH
    ) {
      context.addIssue({
        code: "custom",
        path: ["content", "body"],
        message:
          "Submission confirmation bodies must leave room for the required application-management link.",
      });
    }
  });

export const previewCommunicationSchema = z.object({
  templateVersionId: z.uuid(),
  audienceType: audienceTypeSchema,
  manualRecipients: z.string().max(20_000).default(""),
  kind: z.enum(["transactional", "optional"]),
});

export const confirmCommunicationSchema = previewCommunicationSchema.extend({
  idempotencyKey: z.string().trim().min(8).max(128),
  recipientFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  deliverableFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  suppressedCount: z.coerce.number().int().nonnegative(),
});

export const scheduleCommunicationSchema = confirmCommunicationSchema.extend({
  scheduledAt: z.coerce.number().int().positive(),
});

export const communicationDraftFieldsSchema = previewCommunicationSchema.extend(
  {
    scheduledAt: z.number().int().positive().nullable(),
  },
);

export const updateCommunicationDraftSchema =
  communicationDraftFieldsSchema.extend({
    draftId: z.uuid(),
    revision: z.coerce.number().int().positive(),
  });

export const confirmCommunicationDraftSchema = z.object({
  draftId: z.uuid(),
  revision: z.coerce.number().int().positive(),
  recipientFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  deliverableFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  suppressedCount: z.coerce.number().int().nonnegative(),
});

export const discardCommunicationDraftSchema = z.object({
  draftId: z.uuid(),
  revision: z.coerce.number().int().positive(),
});

export const testCommunicationSchema = z.object({
  templateVersionId: z.uuid(),
  recipient: z.email(),
  idempotencyKey: z.string().trim().min(8).max(128),
});

const reminderTriggerTypeSchema = z.enum([
  "task_due",
  "task_overdue",
  "application_draft",
  "participation_pending",
]);

const reminderAudienceTypeSchema = z.enum([
  "due_speakers",
  "overdue_speakers",
  "draft_applicants",
  "pending_participants",
  "event_administrators",
]);

export const saveCommunicationTriggerSchema = z.object({
  id: z.uuid().optional(),
  templateId: z.uuid(),
  triggerType: reminderTriggerTypeSchema,
  audienceType: reminderAudienceTypeSchema,
  kind: z.enum(["transactional", "optional"]),
  sendHourUtc: z.coerce.number().int().min(0).max(23),
  enabled: z.boolean(),
});

export const communicationTriggerConfigurationSchema = z
  .object({
    audienceType: reminderAudienceTypeSchema,
    kind: z.enum(["transactional", "optional"]),
    sendHourUtc: z.number().int().min(0).max(23),
    lastRunBucket: z.string().optional(),
  })
  .strict();

export const resendWebhookEventSchema = z
  .object({
    type: z.string().min(1),
    created_at: z.iso.datetime({ offset: true }).optional(),
    data: z
      .object({
        email_id: z.string().min(1),
        tags: z.record(z.string(), z.string()).optional(),
      })
      .passthrough(),
  })
  .passthrough();

export type CommunicationCategory = z.infer<typeof communicationCategorySchema>;
export type AudienceType = z.infer<typeof audienceTypeSchema>;
export type TemplateContent = z.infer<typeof templateContentSchema>;
export type SaveTemplateInput = z.infer<typeof saveTemplateSchema>;
export type PreviewCommunicationInput = z.infer<
  typeof previewCommunicationSchema
>;
export type ConfirmCommunicationInput = z.infer<
  typeof confirmCommunicationSchema
>;
export type ScheduleCommunicationInput = z.infer<
  typeof scheduleCommunicationSchema
>;
export type CommunicationDraftFields = z.infer<
  typeof communicationDraftFieldsSchema
>;
export type UpdateCommunicationDraftInput = z.input<
  typeof updateCommunicationDraftSchema
>;
export type ConfirmCommunicationDraftInput = z.input<
  typeof confirmCommunicationDraftSchema
>;
export type DiscardCommunicationDraftInput = z.input<
  typeof discardCommunicationDraftSchema
>;
export type TestCommunicationInput = z.infer<typeof testCommunicationSchema>;
export type SaveCommunicationTriggerInput = z.input<
  typeof saveCommunicationTriggerSchema
>;
