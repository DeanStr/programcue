import { z } from "zod";

export const channelSchema = z.enum(["email", "sms", "push", "calendar"]);

export const communicationDraftSchema = z
  .object({
    name: z.string().trim().min(1).max(160),
    channels: z
      .array(channelSchema)
      .min(1, "Select at least one delivery channel.")
      .refine(
        (channels) => new Set(channels).size === channels.length,
        "Delivery channels must not contain duplicates.",
      ),
    subject: z.string().trim().max(200).default(""),
    emailBody: z.string().trim().max(100_000).default(""),
    physicalAddress: z.string().trim().max(500).default(""),
    smsBody: z
      .string()
      .trim()
      .max(160, "SMS exceeds 160 characters.")
      .default(""),
    pushTitle: z.string().trim().max(60).default(""),
    pushBody: z.string().trim().max(180).default(""),
    calendarTitle: z.string().trim().max(200).default(""),
    calendarLocation: z.string().trim().max(500).default(""),
    calendarStartsAt: z.iso.datetime({ offset: true }).nullable().default(null),
    calendarEndsAt: z.iso.datetime({ offset: true }).nullable().default(null),
  })
  .superRefine((draft, context) => {
    if (draft.channels.includes("email")) {
      if (!draft.subject)
        context.addIssue({
          code: "custom",
          path: ["subject"],
          message: "Email subject is required.",
        });
      if (!draft.emailBody)
        context.addIssue({
          code: "custom",
          path: ["emailBody"],
          message: "Email body is required.",
        });
      if (!draft.physicalAddress)
        context.addIssue({
          code: "custom",
          path: ["physicalAddress"],
          message: "A physical address is required in the email footer.",
        });
    }
    if (draft.channels.includes("sms") && !draft.smsBody) {
      context.addIssue({
        code: "custom",
        path: ["smsBody"],
        message: "SMS body is required.",
      });
    }
    if (draft.channels.includes("push")) {
      if (!draft.pushTitle)
        context.addIssue({
          code: "custom",
          path: ["pushTitle"],
          message: "Push title is required.",
        });
      if (!draft.pushBody)
        context.addIssue({
          code: "custom",
          path: ["pushBody"],
          message: "Push body is required.",
        });
    }
    if (draft.channels.includes("calendar")) {
      if (!draft.calendarTitle)
        context.addIssue({
          code: "custom",
          path: ["calendarTitle"],
          message: "Calendar title is required.",
        });
      if (!draft.calendarLocation)
        context.addIssue({
          code: "custom",
          path: ["calendarLocation"],
          message: "Calendar location is required.",
        });
      if (!draft.calendarStartsAt || !draft.calendarEndsAt) {
        context.addIssue({
          code: "custom",
          path: ["calendarStartsAt"],
          message: "Calendar start and end are required.",
        });
      } else if (
        Date.parse(draft.calendarStartsAt) >= Date.parse(draft.calendarEndsAt)
      ) {
        context.addIssue({
          code: "custom",
          path: ["calendarEndsAt"],
          message: "Calendar end must be after its start.",
        });
      }
    }
  });

export function calculateRecipientCount({
  selected,
  suppressed,
  invalid,
}: {
  selected: number;
  suppressed: number;
  invalid: number;
}) {
  for (const [name, value] of Object.entries({
    selected,
    suppressed,
    invalid,
  })) {
    if (!Number.isInteger(value) || value < 0)
      throw new Error(`${name} must be a non-negative integer.`);
  }
  if (suppressed + invalid > selected)
    throw new Error(
      "Recipient exclusions cannot exceed the selected audience.",
    );
  return selected - suppressed - invalid;
}

export type CommunicationDraftInput = z.infer<typeof communicationDraftSchema>;
