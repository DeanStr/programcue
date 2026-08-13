import { z } from "zod";

import { ApiParticipantService } from "~/platform/api/api-participant-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  draftPayloadSchema,
  formSchemaSchema,
  submittedSnapshotSchema,
} from "./submission-schema";

const participantApplicationSummarySchema = z
  .object({
    id: z.string().min(1),
    publicReference: z.string().min(1),
    formName: z.string().min(1),
    formSlug: z.string().min(1),
    formKind: z.enum(["submission", "direct_session"]),
    formStatus: z.enum(["draft", "published", "closed", "archived"]),
    title: z.string().min(1),
    status: z.enum([
      "draft",
      "submitted",
      "assigned",
      "in_review",
      "decision_ready",
      "accepted",
      "waitlisted",
      "rejected",
      "withdrawn",
    ]),
    revision: z.number().int().positive(),
    primarySubmitter: z.boolean(),
    maxSpeakers: z.number().int().positive().nullable(),
    speakerListPublished: z.boolean(),
    speakerListEditable: z.boolean(),
    speakers: z.array(
      z.object({
        id: z.string().min(1),
        name: z.string().min(1),
        email: z.email(),
        roleLabel: z.string().min(1).max(80).nullable(),
        invitationStatus: z.enum([
          "pending",
          "sent",
          "claimed",
          "declined",
          "expired",
          "revoked",
        ]),
        isPrimary: z.boolean(),
      }),
    ),
    schema: formSchemaSchema,
    answers: draftPayloadSchema.shape.answers,
    submittedSnapshot: submittedSnapshotSchema.nullable(),
    submittedAt: z.iso.datetime({ offset: true }).nullable(),
    updatedAt: z.iso.datetime({ offset: true }),
  })
  .passthrough();

export type ParticipantApplicationSummary = z.infer<
  typeof participantApplicationSummarySchema
>;

export type ParticipantAvailableForm = {
  id: string;
  name: string;
  publicSlug: string;
  kind: "submission" | "direct_session";
  closesAt: number | null;
};

export class ParticipantApplicationSummaryService {
  constructor(private readonly env: CloudflareEnvironment) {}

  async list(viewer: Viewer) {
    const service = new ApiParticipantService(this.env);
    const applications: ParticipantApplicationSummary[] = [];
    let cursor: string | undefined;
    do {
      const page = await service.list(viewer, "submissions", {
        limit: 100,
        ...(cursor ? { cursor } : {}),
      });
      applications.push(
        ...z.array(participantApplicationSummarySchema).parse(page.submissions),
      );
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    return applications;
  }

  async getWorkspace(viewer: Viewer, selectedApplicationId?: string | null) {
    const applications = await this.list(viewer);
    let selectedApplication: ParticipantApplicationSummary | null = null;
    if (selectedApplicationId !== null && selectedApplicationId !== undefined) {
      const parsedId = z
        .string()
        .min(1)
        .max(160)
        .safeParse(selectedApplicationId);
      if (!parsedId.success) {
        throw new Response("The requested application identifier is invalid.", {
          status: 400,
        });
      }
      selectedApplication =
        applications.find((application) => application.id === parsedId.data) ??
        null;
      if (!selectedApplication) {
        throw new Response("Application not found.", { status: 404 });
      }
    }
    const availableForms = await this.env.DB.prepare(
      `SELECT form.id, form.name, form.public_slug AS publicSlug,
                form.kind, form.closes_at AS closesAt
           FROM form_definitions form
           JOIN events event
             ON event.id = form.event_id AND event.organisation_id = ?
          WHERE form.event_id = ? AND form.status = 'published'
            AND EXISTS (
              SELECT 1 FROM form_versions version
               WHERE version.form_id = form.id
                 AND version.event_id = form.event_id
                 AND version.status = 'published'
            )
            AND (form.closes_at IS NULL OR form.closes_at >= unixepoch())
            AND (
              form.submission_limit IS NULL
              OR (
                SELECT COUNT(*)
                  FROM submissions submission
                  JOIN form_versions submitted_version
                    ON submitted_version.id = submission.form_version_id
                   AND submitted_version.event_id = submission.event_id
                 WHERE submitted_version.form_id = form.id
                   AND submission.event_id = form.event_id
                   AND submission.status <> 'draft'
              ) < form.submission_limit
            )
          ORDER BY form.name, form.id`,
    )
      .bind(viewer.organisationId, viewer.eventId)
      .all<ParticipantAvailableForm>();
    return {
      applications,
      availableForms: availableForms.results,
      selectedApplication,
    };
  }
}
