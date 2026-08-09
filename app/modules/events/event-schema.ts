import { z } from "zod";

export function isSupportedIanaTimezone(value: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: value }).format(0);
    return true;
  } catch {
    return false;
  }
}

export const timezoneSchema = z
  .string()
  .trim()
  .min(1, "Event timezone is required.")
  .max(100)
  .refine(
    isSupportedIanaTimezone,
    "Choose a valid IANA timezone such as America/Toronto or UTC.",
  );

export const roomInputSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  name: z.string().trim().min(1, "Every room needs a name.").max(120),
  capacity: z.coerce
    .number()
    .int()
    .min(1, "Every room needs a positive capacity.")
    .max(100_000),
  position: z.coerce.number().int().min(0),
});

export const eventSetupInputSchema = z
  .object({
    revision: z.coerce.number().int().positive(),
    name: z.string().trim().min(1, "Event name is required.").max(160),
    timezone: timezoneSchema,
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    venue: z.string().trim().max(200),
    city: z.string().trim().max(120),
    publicSlug: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        "Use lowercase letters, numbers and hyphens.",
      ),
    brandAccent: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "Choose a valid brand colour."),
    description: z.string().trim().max(2_000),
    repositoryProvider: z.literal(
      "d1",
      "Airtable cannot be selected until its repository adapter is implemented.",
    ),
    retentionMonths: z.coerce
      .number()
      .pipe(z.union([z.literal(12), z.literal(24), z.literal(36)])),
    submissionAccessMode: z.enum([
      "email_verified",
      "account_required",
      "password_protected",
    ]),
    allowAnonymousDrafts: z.boolean(),
    duplicatePersonWarnings: z.boolean(),
    rooms: z.array(roomInputSchema).max(100),
  })
  .superRefine((value, context) => {
    if (value.endDate < value.startDate) {
      context.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "End date cannot be before the start date.",
      });
    }
    const uniqueIds = new Set(value.rooms.map((room) => room.id));
    if (uniqueIds.size !== value.rooms.length) {
      context.addIssue({
        code: "custom",
        path: ["rooms"],
        message: "Room identifiers must be unique.",
      });
    }
  });

export const administratorInvitationSchema = z.object({
  name: z.string().trim().min(1, "Administrator name is required.").max(120),
  email: z
    .email("Enter a valid administrator email address.")
    .transform((value) => value.toLowerCase()),
});

export type EventSetupInput = z.infer<typeof eventSetupInputSchema>;
export type AdministratorInvitationInput = z.infer<
  typeof administratorInvitationSchema
>;
