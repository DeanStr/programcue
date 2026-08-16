import { z } from "zod";
import {
  AirtableProviderBoundary,
  airtableCommandKey,
  airtableIntentCommand,
} from "~/modules/airtable/airtable-provider-boundary.server";
import { parseSessionFormatsConfiguration } from "~/modules/events/event-configuration";
import { sessionFormatInputSchema } from "~/modules/events/event-schema";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  ApplicantSessionService,
  hashApplicantToken,
  type PublicForm,
} from "./applicant-session.server";
import {
  D1SubmissionRepository,
  SubmissionStateError,
  type Applicant,
} from "./submission-repository.server";

export class PublicFormUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicFormUnavailableError";
  }
}

export class SubmissionCommittedStateError extends SubmissionStateError {
  readonly committed = true;
}

export type SubmissionApiActor = {
  kind: "api_key";
  organisationId: string;
  eventId: string;
  personId: null;
  actorId: string;
};

export type SubmissionAdminActor = Viewer | SubmissionApiActor;

export function isSubmissionApiActor(
  actor: SubmissionAdminActor,
): actor is SubmissionApiActor {
  return "kind" in actor && actor.kind === "api_key";
}

export const adminIdempotencyKeySchema = z.string().trim().min(8).max(128);

export const directSessionSchema = z.object({
  idempotencyKey: adminIdempotencyKeySchema,
  title: z.string().trim().min(3).max(180),
  description: z.string().trim().max(3_000).default(""),
  trackId: z.string().trim().min(1).max(100),
  format: sessionFormatInputSchema.shape.key,
  durationMinutes: z.preprocess(
    (value) =>
      value === "" || value === null || value === undefined ? undefined : value,
    z.coerce.number().int().min(5).max(480).optional(),
  ),
  speakers: z
    .array(
      z.object({
        name: z.string().trim().min(1).max(120),
        email: z.string().trim().toLowerCase().email().max(254),
        biography: z.string().trim().max(5_000).default(""),
      }),
    )
    .min(1)
    .max(20)
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

export const manualApplicationSchema = z.object({
  idempotencyKey: adminIdempotencyKeySchema,
  title: z.string().trim().min(3).max(180),
  description: z.string().trim().min(1).max(5_000),
  trackIds: z.array(z.string().trim().min(1).max(100)).min(1).max(30),
  format: sessionFormatInputSchema.shape.key,
  submitterName: z.string().trim().min(1).max(120),
  submitterEmail: z.string().trim().toLowerCase().email().max(254),
  speakers: directSessionSchema.shape.speakers,
  routedTeamIds: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
});

export const withdrawSubmissionSchema = z.object({
  submissionId: z.string().min(1).max(100),
  revision: z.coerce.number().int().positive(),
});

export function slugify(value: string) {
  return (
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "session"
  );
}

export async function intentBoundDraftId(
  formId: string,
  operation: "authenticated" | "anonymous",
  personId: string | null,
  intentId: string,
) {
  const digest = await hashApplicantToken(
    JSON.stringify([
      "program-cue-draft-intent-v1",
      formId,
      operation,
      personId,
      intentId,
    ]),
  );
  return `draft-${digest}`;
}

export function applicantFormView(form: PublicForm) {
  const { accessPasswordHash: _accessPasswordHash, version, ...summary } = form;
  const { routing: _routing, ...publicVersion } = version;
  return { ...summary, version: publicVersion };
}

export function answerValidationError(errors: Record<string, string[]>) {
  return new z.ZodError(
    Object.entries(errors).flatMap(([path, messages]) =>
      messages.map((message) => ({
        code: "custom" as const,
        path: [path],
        message,
        input: undefined,
      })),
    ),
  );
}

export type ApplicantVideoUploadRow = {
  assetId: string;
  assetStatus: string;
  currentVersionId: string | null;
  versionId: string;
  filename: string;
  sizeBytes: number;
  uploadStatus: string;
  signatureStatus: string;
  scanStatus: string;
  releasedAt: number | null;
};

export type PreparedAdminMutation = {
  recordId: string;
  scope:
    | "submission.admin.direct_session.create"
    | "submission.admin.manual.create";
  idempotencyKey: string;
  requestHash: string;
  organisationId: string;
  eventId: string;
  actorId: string;
};

export type AdminMutationRecord = {
  id: string;
  requestHash: string;
  status: "processing" | "completed" | "failed";
  entityId: string | null;
};

export class SubmissionServiceFoundation {
  readonly repository: D1SubmissionRepository;
  readonly applicants: ApplicantSessionService;
  protected readonly airtable: AirtableProviderBoundary;
  constructor(
    protected readonly env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    this.repository = new D1SubmissionRepository(env);
    this.applicants = new ApplicantSessionService(env);
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
  }

  protected async publicScope(eventId: string) {
    const event = await this.env.DB.prepare(
      `SELECT organisation_id AS organisationId
         FROM events WHERE id = ?`,
    )
      .bind(eventId)
      .first<{ organisationId: string }>();
    if (!event)
      throw new Response("This event could not be found.", { status: 404 });
    return { organisationId: event.organisationId, eventId };
  }

  getApplicationEventScope(eventId: string) {
    return this.publicScope(eventId);
  }

  async getPublicForm(publicSlug: string) {
    const form = await this.getPublicFormD1(publicSlug);
    const freshness = await this.airtable.assertReadable(
      await this.publicScope(form.eventId),
    );
    return freshness === null ? form : this.getPublicFormD1(publicSlug);
  }

  protected async getPublicFormD1(publicSlug: string) {
    const form = await this.repository.getPublicForm(publicSlug);
    if (!form)
      throw new Response("Application form not found", { status: 404 });
    return form;
  }

  protected async requireCoSpeakerClaimForm(
    publicSlug: string,
    speakerId: string,
    rawToken: string,
  ) {
    const form = await this.repository.getCoSpeakerClaimForm(
      publicSlug,
      speakerId,
    );
    if (!form || !(await this.getCoSpeakerClaimD1(form, speakerId, rawToken))) {
      throw new SubmissionStateError(
        "This co-speaker claim link is invalid or has been replaced.",
      );
    }
    return form;
  }

  async requireClaimedCoSpeakerContext(
    publicSlug: string,
    speakerIdInput: string,
    request: Request,
  ) {
    const speakerId = z.string().min(1).max(100).parse(speakerIdInput);
    const form = await this.repository.getCoSpeakerClaimForm(
      publicSlug,
      speakerId,
    );
    if (!form) {
      throw new Response("Application form not found", { status: 404 });
    }
    const applicant = await this.applicants.get(request, form);
    const claimedRelationship = applicant?.verified
      ? await this.env.DB.prepare(
          `SELECT 1 AS available
             FROM submission_speakers speaker
             JOIN submissions submission
               ON submission.id = speaker.submission_id
              AND submission.event_id = speaker.event_id
             JOIN form_versions version
               ON version.id = submission.form_version_id
              AND version.event_id = submission.event_id
            WHERE speaker.id = ? AND speaker.person_id = ?
              AND speaker.invitation_status = 'claimed'
              AND version.form_id = ? AND speaker.event_id = ?
            LIMIT 1`,
        )
          .bind(speakerId, applicant.personId, form.id, form.eventId)
          .first<{ available: number }>()
      : null;
    if (!applicant?.verified || !claimedRelationship) {
      throw new Response("Application form not found", { status: 404 });
    }
    return { form, applicant };
  }

  protected async getCoSpeakerClaimD1(
    form: PublicForm,
    speakerId: string,
    rawToken: string,
  ) {
    if (!speakerId || !rawToken) return null;
    const tokenHash = await hashApplicantToken(
      `co-speaker-claim:${form.id}:${speakerId}:${rawToken}`,
    );
    const claim = await this.env.DB.prepare(
      `SELECT speaker.id, speaker.email, speaker.display_name AS displayName,
              speaker.invitation_expires_at AS expiresAt,
              submission.id AS submissionId,
              submission.title AS submissionTitle
         FROM submission_speakers speaker
         JOIN submissions submission
           ON submission.id = speaker.submission_id
          AND submission.event_id = speaker.event_id
         JOIN form_versions version
           ON version.id = submission.form_version_id
          AND version.event_id = submission.event_id
        WHERE speaker.id = ? AND speaker.event_id = ?
          AND speaker.claim_token_hash = ?
          AND speaker.invitation_status IN ('pending','sent','expired')
          AND version.form_id = ?`,
    )
      .bind(speakerId, form.eventId, tokenHash, form.id)
      .first<{
        id: string;
        email: string;
        displayName: string;
        expiresAt: number | null;
        submissionId: string;
        submissionTitle: string;
      }>();
    if (!claim) return null;
    return {
      ...claim,
      expired:
        claim.expiresAt === null ||
        claim.expiresAt <= Math.floor(Date.now() / 1_000),
    };
  }

  protected async projectCommand<T>(
    scope: { organisationId: string; eventId: string; personId: string | null },
    operation: string,
    input: unknown,
    execute: () => Promise<T>,
    options: { replay?: "store" | "reject" } = {},
  ) {
    const idempotencyKey = await airtableCommandKey(operation, scope, input);
    return this.airtable.executeIdempotent(
      scope,
      { idempotencyKey, operation },
      execute,
      options,
    );
  }

  protected async projectIntentCommand<T>(
    scope: { organisationId: string; eventId: string; personId: string | null },
    operation: string,
    intentId: string,
    input: unknown,
    execute: () => Promise<T>,
    options: { replay?: "store" | "reject" } = {},
  ) {
    return this.airtable.executeIdempotent(
      scope,
      await airtableIntentCommand(operation, scope, intentId, input),
      execute,
      options,
    );
  }

  async getConfiguredSessionFormats(
    viewer: Pick<Viewer, "organisationId" | "eventId">,
  ) {
    await this.airtable.assertReadable(viewer);
    return (await this.getConfiguredSessionFormatSnapshotD1(viewer)).formats;
  }

  protected async getConfiguredSessionFormatSnapshotD1(
    viewer: Pick<Viewer, "organisationId" | "eventId">,
  ) {
    const event = await this.env.DB.prepare(
      `SELECT session_formats_json AS sessionFormatsJson
         FROM events WHERE id = ? AND organisation_id = ?`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{ sessionFormatsJson: string }>();
    if (!event)
      throw new SubmissionStateError("This event could not be found.");
    try {
      return {
        serialized: event.sessionFormatsJson,
        formats: parseSessionFormatsConfiguration(event.sessionFormatsJson),
      };
    } catch (error) {
      throw new SubmissionStateError(
        error instanceof Error
          ? error.message
          : "The event has invalid session-format configuration.",
      );
    }
  }

  protected assertApplicationManagementAccess(applicant: Applicant) {
    if (applicant.claimOnly) {
      throw new SubmissionStateError(
        "Sign in with a verified Program Cue account to create or manage applications.",
      );
    }
  }
}
