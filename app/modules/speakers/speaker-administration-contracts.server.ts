import { z } from "zod";
import type { Viewer } from "~/platform/auth/authorize.server";
import type { SpeakerWorkflowStatus } from "./speaker-roster-import.server";
import {
  speakerLinkedinUrlSchema,
  speakerTravelPreferencesSchema,
  speakerXHandleSchema,
} from "./speaker-schema";

export const adminSpeakerProfileSchema = z.object({
  revision: z.coerce.number().int().positive(),
  name: z.string().trim().min(2, "Enter the speaker's name.").max(120),
  biography: z.string().trim().max(5_000),
  pronunciation: z.string().trim().max(160),
  organisationName: z.string().trim().max(160),
  jobTitle: z.string().trim().max(160),
  linkedinUrl: speakerLinkedinUrlSchema,
  xHandle: speakerXHandleSchema,
  travelPreferences: speakerTravelPreferencesSchema,
  profileStatus: z.enum(["draft", "published", "archived"], {
    message: "Choose a valid profile status.",
  }),
});

export const adminScopedSpeakerProfileSchema = z.object({
  profileRevision: z.coerce.number().int().positive(),
  organisationProfileOperationId: z.string().trim().max(200),
  travelProfileOperationId: z.string().trim().max(200),
  name: z.string().trim().min(2, "Enter the speaker's name.").max(120),
  biography: z.string().trim().max(5_000),
  organisationName: z.string().trim().max(160),
  jobTitle: z.string().trim().max(160),
  travelPreferences: speakerTravelPreferencesSchema,
});

export const speakerCommandIdempotencyKeySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._:-]{8,128}$/, "Refresh before trying again.");

export const manualSpeakerRecordSchema = z
  .object({
    idempotencyKey: speakerCommandIdempotencyKeySchema,
    name: z.string().trim().min(2, "Enter the speaker's name.").max(120),
    email: z.string().trim().toLowerCase().email().max(254),
  })
  .extend({
    jobTitle: z.string().trim().max(160).default(""),
    organisationName: z.string().trim().max(160).default(""),
    biography: z.string().trim().max(5_000).default(""),
  });

export const existingSpeakerProspectSchema = z
  .object({
    idempotencyKey: speakerCommandIdempotencyKeySchema,
    personId: z.string().trim().min(1).max(200),
  })
  .strict();

export const speakerInvitationSchema = z
  .object({
    idempotencyKey: speakerCommandIdempotencyKeySchema,
    personId: z.string().trim().min(1).max(200),
    confirmation: z.literal("send"),
  })
  .strict();

export function organisationAdministratorViewer(viewer: Viewer) {
  if (viewer.role !== "owner" && viewer.role !== "administrator") {
    throw new Response("Event administrator access is required.", {
      status: 403,
    });
  }
  return {
    ...viewer,
    role: viewer.role,
    currentEventId: viewer.eventId,
  } as const;
}

export const speakerWorkflowSchema = z
  .object({
    idempotencyKey: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._:-]{8,128}$/u),
    status: z.enum([
      "prospect",
      "invited",
      "confirmed",
      "declined",
      "withdrawn",
    ]),
  })
  .strict();

export type AdminSpeakerFilters = {
  personId?: string;
  query?: string;
  profileStatus?: "" | "draft" | "published" | "archived";
  readiness?: "" | "ready" | "needs_attention";
  workflowStatus?: "" | SpeakerWorkflowStatus;
};

export type AdminSpeakerFileVersion = {
  id: string;
  assetId: string;
  versionNumber: number;
  filename: string;
  sizeBytes: number;
  uploadStatus: string;
  signatureStatus: string;
  scanStatus: string;
  createdAt: number;
  releasedAt: number | null;
};

export type AdminSpeakerListItem = {
  id: string;
  name: string;
  email: string;
  jobTitle: string | null;
  organisationName: string | null;
  profileStatus: string;
  workflowStatus: SpeakerWorkflowStatus;
  sessionCount: number;
  outstandingTasks: number;
  completedTasks: number;
  quarantinedFiles: number;
  pendingRoles: number;
  missingRequiredFields: number;
  portalAccessAccepted: number;
  portalInvitationPending: number;
};
