import { z } from "zod";

import {
  MAX_SUBMISSION_SPEAKERS,
  storedFormSchemaSchema,
} from "./submission-form-schema";

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

const participantDraftSpeakerInputSchema = speakerInputSchema.partial({
  name: true,
});

export const participantDraftPayloadSchema = draftPayloadSchema.extend({
  speakers: z
    .array(participantDraftSpeakerInputSchema)
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
});

const emptyDraftSpeakerInputSchema = z.object({
  name: z.string().trim().length(0),
  email: z.string().trim().length(0),
  biography: z.string().trim().length(0).optional(),
});

const draftSaveSpeakersSchema = z.union([
  draftPayloadSchema.shape.speakers,
  z.tuple([emptyDraftSpeakerInputSchema]).transform(() => []),
]);

/**
 * Saving a draft may omit the primary speaker while an anonymous applicant is
 * still filling in their identity. The editor renders one completely empty
 * speaker row for that state; discard only that sole empty placeholder. Mixed
 * empty and populated rows remain invalid so a co-speaker cannot be silently
 * promoted to primary. Final submission continues to use the strict
 * draftPayloadSchema above.
 */
export const draftSavePayloadSchema = draftPayloadSchema.extend({
  speakers: draftSaveSpeakersSchema,
});

export const participantDraftSavePayloadSchema =
  participantDraftPayloadSchema.extend({
    speakers: z.union([
      participantDraftPayloadSchema.shape.speakers,
      z.tuple([emptyDraftSpeakerInputSchema]).transform(() => []),
    ]),
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
