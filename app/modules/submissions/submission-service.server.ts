import { z } from "zod";
import {
  AirtableProviderBoundary,
  airtableCommandKey,
  airtableIntentCommand,
} from "~/modules/airtable/airtable-provider-boundary.server";

import {
  findSessionFormatConfiguration,
  parseSessionFormatsConfiguration,
} from "~/modules/events/event-configuration";
import { sessionFormatInputSchema } from "~/modules/events/event-schema";
import { materializePublishedResourceAcknowledgementsForSession } from "~/modules/resources/resource-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import {
  ApplicantSessionService,
  hashApplicantToken,
  requireApplicantPepper,
  type PublicForm,
} from "./applicant-session.server";
import {
  buildCoSpeakerInvitationPlan,
  persistQueueFailure,
} from "./co-speaker-invitation.server";
import {
  D1SubmissionRepository,
  SubmissionStateError,
  SubmissionRevisionConflictError,
  type Applicant,
  type FormWorkspace,
} from "./submission-repository.server";
import {
  DEFAULT_FORM_SCHEMA,
  draftPayloadSchema,
  routingSchema,
  saveFormSchema,
  validateAnswerShapes,
  validateFinalAnswers,
  visibleAnswers,
  visibleFields,
  type SaveFormInput,
  type SubmissionFormSchema,
} from "./submission-schema";

export class PublicFormUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PublicFormUnavailableError";
  }
}

class SubmissionCommittedStateError extends SubmissionStateError {
  readonly committed = true;
}

export type SubmissionApiActor = {
  kind: "api_key";
  organisationId: string;
  eventId: string;
  personId: null;
  actorId: string;
};

type SubmissionAdminActor = Viewer | SubmissionApiActor;

function isSubmissionApiActor(
  actor: SubmissionAdminActor,
): actor is SubmissionApiActor {
  return "kind" in actor && actor.kind === "api_key";
}

const adminIdempotencyKeySchema = z.string().trim().min(8).max(128);

const directSessionSchema = z.object({
  idempotencyKey: adminIdempotencyKeySchema,
  title: z.string().trim().min(3).max(180),
  description: z.string().trim().max(3_000).default(""),
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

const manualApplicationSchema = z.object({
  idempotencyKey: adminIdempotencyKeySchema,
  title: z.string().trim().min(3).max(180),
  description: z.string().trim().min(1).max(5_000),
  category: z.string().trim().min(1).max(80),
  format: z.string().trim().min(1).max(80),
  submitterName: z.string().trim().min(1).max(120),
  submitterEmail: z.string().trim().toLowerCase().email().max(254),
  speakers: directSessionSchema.shape.speakers,
  routedTeamId: z.string().trim().min(1).max(100).nullable().default(null),
});

const withdrawSubmissionSchema = z.object({
  submissionId: z.string().min(1).max(100),
  revision: z.coerce.number().int().positive(),
});

function slugify(value: string) {
  return (
    value
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "session"
  );
}

async function intentBoundDraftId(
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

function applicantFormView(form: PublicForm) {
  const { accessPasswordHash: _accessPasswordHash, version, ...summary } = form;
  const { routing: _routing, ...publicVersion } = version;
  return { ...summary, version: publicVersion };
}

function answerValidationError(errors: Record<string, string[]>) {
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

type ApplicantVideoUploadRow = {
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

type PreparedAdminMutation = {
  recordId: string;
  scope:
    "submission.admin.direct_session.create" | "submission.admin.manual.create";
  idempotencyKey: string;
  requestHash: string;
  organisationId: string;
  eventId: string;
  actorId: string;
};

type AdminMutationRecord = {
  id: string;
  requestHash: string;
  status: "processing" | "completed" | "failed";
  entityId: string | null;
};

export class SubmissionService {
  readonly repository: D1SubmissionRepository;
  readonly applicants: ApplicantSessionService;
  private readonly airtable: AirtableProviderBoundary;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    this.repository = new D1SubmissionRepository(env);
    this.applicants = new ApplicantSessionService(env);
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
  }

  private async publicScope(eventId: string) {
    const event = await this.env.DB.prepare(
      `SELECT organisation_id AS organisationId
         FROM events WHERE id = ?`,
    )
      .bind(eventId)
      .first<{ organisationId: string }>();
    if (!event) throw new Response("Event not found", { status: 404 });
    return { organisationId: event.organisationId, eventId };
  }

  getApplicationEventScope(eventId: string) {
    return this.publicScope(eventId);
  }

  private async projectCommand<T>(
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

  private async projectIntentCommand<T>(
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

  private async getConfiguredSessionFormatSnapshotD1(
    viewer: Pick<Viewer, "organisationId" | "eventId">,
  ) {
    const event = await this.env.DB.prepare(
      `SELECT session_formats_json AS sessionFormatsJson
         FROM events WHERE id = ? AND organisation_id = ?`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{ sessionFormatsJson: string }>();
    if (!event) throw new SubmissionStateError("Event not found.");
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

  private assertApplicationManagementAccess(applicant: Applicant) {
    if (applicant.claimOnly) {
      throw new SubmissionStateError(
        "Sign in with a verified Program Cue account to create or manage applications.",
      );
    }
  }

  async getAdminWorkspace(viewer: Viewer, formId?: string) {
    await this.airtable.assertReadable(viewer);
    return this.repository.getAdminWorkspace(
      viewer.organisationId,
      viewer.eventId,
      formId,
    );
  }

  async listAdminForms(viewer: Viewer) {
    await this.airtable.assertReadable(viewer);
    const forms = await this.env.DB.prepare(
      `SELECT form.id, form.name, form.kind, form.status,
              form.public_slug AS publicSlug,
              MAX(CASE WHEN version.status = 'published' THEN version.version_number END) AS publishedVersion
         FROM form_definitions form
         JOIN events event ON event.id = form.event_id AND event.organisation_id = ?
         LEFT JOIN form_versions version
           ON version.form_id = form.id AND version.event_id = form.event_id
        WHERE form.event_id = ? AND form.status <> 'archived'
        GROUP BY form.id
        ORDER BY form.updated_at DESC, form.name`,
    )
      .bind(viewer.organisationId, viewer.eventId)
      .all<{
        id: string;
        name: string;
        kind: "submission" | "direct_session";
        status: string;
        publicSlug: string;
        publishedVersion: number | null;
      }>();
    return forms.results;
  }

  async getLatestPublishedFormSlug(
    viewer: Pick<Viewer, "organisationId" | "eventId">,
  ) {
    await this.airtable.assertReadable(viewer);
    const form = await this.env.DB.prepare(
      `SELECT form.public_slug AS publicSlug
         FROM form_definitions form
         JOIN events event
           ON event.id = form.event_id AND event.organisation_id = ?
        WHERE form.event_id = ? AND form.status = 'published'
        ORDER BY form.updated_at DESC, form.id
        LIMIT 1`,
    )
      .bind(viewer.organisationId, viewer.eventId)
      .first<{ publicSlug: string }>();
    return form?.publicSlug ?? null;
  }

  defaultFormInput(accessMode: SaveFormInput["accessMode"]): SaveFormInput {
    return {
      name: "Call for Speakers",
      kind: "submission",
      publicSlug: "call-for-speakers",
      closeDate: null,
      submissionLimit: null,
      minSpeakers: 1,
      maxSpeakers: 4,
      accessMode,
      accessPassword: "",
      schema: DEFAULT_FORM_SCHEMA,
      routing: {
        categories: {},
        teamNames: {},
        directSessionDurationMinutes: null,
        passwordHash: null,
      },
    };
  }

  async getDefaultFormInput(viewer: Viewer) {
    await this.airtable.assertReadable(viewer);
    const event = await this.env.DB.prepare(
      `SELECT submission_access_mode AS accessMode
         FROM events
        WHERE id = ? AND organisation_id = ?`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{ accessMode: SaveFormInput["accessMode"] }>();
    if (!event) throw new Response("Event not found", { status: 404 });
    return this.defaultFormInput(event.accessMode);
  }

  async saveForm(
    viewer: Viewer,
    rawInput: unknown,
    operation?: {
      operationId: string;
      formId: string;
      versionId: string;
      auditId: string;
    },
  ) {
    if (operation) {
      const recovered = await this.env.DB.prepare(
        `SELECT form.id
           FROM form_definitions form
           JOIN events event
             ON event.id = form.event_id AND event.organisation_id = ?
          WHERE form.id = ? AND form.event_id = ?
            AND form.last_operation_id = ?
            AND EXISTS (
              SELECT 1 FROM form_versions version
               WHERE version.id = ? AND version.form_id = form.id
                 AND version.event_id = form.event_id
            )`,
      )
        .bind(
          viewer.organisationId,
          operation.formId,
          viewer.eventId,
          operation.operationId,
          operation.versionId,
        )
        .first<{ id: string }>();
      if (recovered) return recovered.id;
      return this.projectIntentCommand(
        viewer,
        "submission.form.save",
        operation.operationId,
        rawInput,
        () => this.saveFormD1(viewer, rawInput, operation),
      );
    }
    return this.projectCommand(viewer, "submission.form.save", rawInput, () =>
      this.saveFormD1(viewer, rawInput),
    );
  }

  private async saveFormD1(
    viewer: Viewer,
    rawInput: unknown,
    operation?: {
      operationId: string;
      formId: string;
      versionId: string;
      auditId: string;
    },
  ) {
    const input = saveFormSchema.parse(rawInput);
    if (input.kind === "direct_session") {
      const { formats: configuredFormats } =
        await this.getConfiguredSessionFormatSnapshotD1(viewer);
      const formatField = input.schema.fields.find(
        (field) => field.id === "format",
      )!;
      let resolvedKeys: string[];
      try {
        resolvedKeys = formatField.options.map((option) => {
          const configured = findSessionFormatConfiguration(
            configuredFormats,
            option,
          );
          if (!configured) {
            throw new SubmissionStateError(
              `Direct-session format “${option}” is not configured for this event.`,
            );
          }
          return configured.key;
        });
      } catch (error) {
        if (error instanceof SubmissionStateError) throw error;
        throw new SubmissionStateError(
          error instanceof Error
            ? error.message
            : "The direct-session form has invalid format configuration.",
        );
      }
      if (new Set(resolvedKeys).size !== resolvedKeys.length) {
        throw new SubmissionStateError(
          "Direct-session format options must map to distinct event formats.",
        );
      }
    }
    let passwordHash: string | null = null;
    if (input.accessMode === "password_protected") {
      if (input.accessPassword) {
        passwordHash = await ApplicantSessionService.hashPassword(
          input.accessPassword,
          requireApplicantPepper(this.env),
        );
      } else if (input.id) {
        const existing = await this.repository.getAdminWorkspace(
          viewer.organisationId,
          viewer.eventId,
          input.id,
        );
        if (!existing) throw new Response("Form not found", { status: 404 });
        passwordHash = existing.draftVersion.routing.passwordHash;
        if (!passwordHash) {
          throw new SubmissionStateError(
            "Set an access password before saving this password-protected form.",
          );
        }
      }
    }
    const configuredTeamIds = [
      ...new Set(Object.values(input.routing.categories)),
    ];
    let teamNames: Record<string, string> = {};
    if (configuredTeamIds.length) {
      const placeholders = configuredTeamIds.map(() => "?").join(",");
      const teams = await this.env.DB.prepare(
        `SELECT team.id, team.name
           FROM evaluation_teams team
           JOIN events event
             ON event.id = team.event_id AND event.organisation_id = ?
          WHERE team.event_id = ? AND team.status = 'active'
            AND team.id IN (${placeholders})`,
      )
        .bind(viewer.organisationId, viewer.eventId, ...configuredTeamIds)
        .all<{ id: string; name: string }>();
      if (teams.results.length !== configuredTeamIds.length) {
        throw new SubmissionStateError(
          "Every category route must reference an active evaluation team in this event.",
        );
      }
      teamNames = Object.fromEntries(
        teams.results.map((team) => [team.id, team.name]),
      );
    }
    const routing = routingSchema.parse({
      ...input.routing,
      teamNames,
      passwordHash,
    });
    const saved = { ...input, routing };
    if (!input.id)
      return this.repository.createForm(
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        saved,
        operation,
      );
    await this.repository.saveForm(
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      input.id,
      saved,
      operation
        ? {
            operationId: operation.operationId,
            auditId: operation.auditId,
          }
        : undefined,
    );
    return input.id;
  }

  async publishForm(
    viewer: Viewer,
    formId: string,
    formRevision: unknown,
    draftRevision: unknown,
    operation?: {
      operationId: string;
      nextVersionId: string;
      auditId: string;
    },
  ) {
    if (operation) {
      const recovered = await this.env.DB.prepare(
        `SELECT form.id
           FROM form_definitions form
           JOIN events event
             ON event.id = form.event_id AND event.organisation_id = ?
          WHERE form.id = ? AND form.event_id = ?
            AND form.status = 'published' AND form.last_operation_id = ?
            AND EXISTS (
              SELECT 1 FROM form_versions next_draft
               WHERE next_draft.id = ? AND next_draft.form_id = form.id
                 AND next_draft.event_id = form.event_id
                 AND next_draft.status = 'draft'
            )`,
      )
        .bind(
          viewer.organisationId,
          formId,
          viewer.eventId,
          operation.operationId,
          operation.nextVersionId,
        )
        .first();
      if (recovered) return;
      return this.projectIntentCommand(
        viewer,
        "submission.form.publish",
        operation.operationId,
        { formId, formRevision, draftRevision },
        () =>
          this.publishFormD1(
            viewer,
            formId,
            formRevision,
            draftRevision,
            operation,
          ),
      );
    }
    return this.projectCommand(
      viewer,
      "submission.form.publish",
      { formId, formRevision, draftRevision },
      () => this.publishFormD1(viewer, formId, formRevision, draftRevision),
    );
  }

  private async publishFormD1(
    viewer: Viewer,
    formId: string,
    formRevision: unknown,
    draftRevision: unknown,
    operation?: {
      operationId: string;
      nextVersionId: string;
      auditId: string;
    },
  ) {
    const parsedFormRevision = z.coerce
      .number()
      .int()
      .positive()
      .parse(formRevision);
    const parsedDraftRevision = z.coerce
      .number()
      .int()
      .positive()
      .parse(draftRevision);
    const workspace = await this.repository.getAdminWorkspace(
      viewer.organisationId,
      viewer.eventId,
      formId,
    );
    if (!workspace) throw new Response("Form not found", { status: 404 });
    if (
      workspace.accessMode === "password_protected" &&
      !workspace.draftVersion.routing.passwordHash
    ) {
      throw new SubmissionStateError(
        "Set and save an access password before publishing this form.",
      );
    }
    let expectedSessionFormatsJson: string | null = null;
    if (workspace.kind === "direct_session") {
      const formatSnapshot =
        await this.getConfiguredSessionFormatSnapshotD1(viewer);
      const formatField = workspace.draftVersion.schema.fields.find(
        (field) => field.id === "format",
      )!;
      const resolvedKeys = formatField.options.map((option) => {
        const configured = findSessionFormatConfiguration(
          formatSnapshot.formats,
          option,
        );
        if (!configured) {
          throw new SubmissionStateError(
            `Direct-session format “${option}” is not configured for this event.`,
          );
        }
        return configured.key;
      });
      if (new Set(resolvedKeys).size !== resolvedKeys.length) {
        throw new SubmissionStateError(
          "Direct-session format options must map to distinct event formats.",
        );
      }
      expectedSessionFormatsJson = formatSnapshot.serialized;
    }
    const configuredTeamIds = [
      ...new Set(Object.values(workspace.draftVersion.routing.categories)),
    ];
    if (configuredTeamIds.length) {
      const placeholders = configuredTeamIds.map(() => "?").join(",");
      const teams = await this.env.DB.prepare(
        `SELECT id, name FROM evaluation_teams
          WHERE event_id = ? AND status = 'active' AND id IN (${placeholders})`,
      )
        .bind(viewer.eventId, ...configuredTeamIds)
        .all<{ id: string; name: string }>();
      if (teams.results.length !== configuredTeamIds.length) {
        throw new SubmissionStateError(
          "Every category route must reference an active evaluation team in this event.",
        );
      }
      const names = new Map(teams.results.map((team) => [team.id, team.name]));
      for (const teamId of configuredTeamIds) {
        if (
          workspace.draftVersion.routing.teamNames[teamId] !== names.get(teamId)
        ) {
          throw new SubmissionStateError(
            "A routed evaluation team changed after this form draft was saved. Save the form again before publishing.",
          );
        }
      }
    }
    await this.repository.publishForm(
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      formId,
      parsedFormRevision,
      parsedDraftRevision,
      operation,
      expectedSessionFormatsJson,
    );
  }

  async listRoutingTeams(viewer: Viewer) {
    await this.airtable.assertReadable(viewer);
    const teams = await this.env.DB.prepare(
      `SELECT team.id, team.name
         FROM evaluation_teams team
         JOIN events event ON event.id = team.event_id AND event.organisation_id = ?
        WHERE team.event_id = ? AND team.status = 'active'
        ORDER BY team.name, team.id`,
    )
      .bind(viewer.organisationId, viewer.eventId)
      .all<{ id: string; name: string }>();
    return teams.results;
  }

  async getPublicForm(publicSlug: string) {
    const form = await this.getPublicFormD1(publicSlug);
    const freshness = await this.airtable.assertReadable(
      await this.publicScope(form.eventId),
    );
    // Airtable-backed reads refresh the D1 projection. Read the form again so
    // this request cannot return the pre-refresh version that was used only to
    // discover the public form's event scope.
    return freshness === null ? form : this.getPublicFormD1(publicSlug);
  }

  private async getPublicFormD1(publicSlug: string) {
    const form = await this.repository.getPublicForm(publicSlug);
    if (!form)
      throw new Response("Application form not found", { status: 404 });
    return form;
  }

  async authorizeApplicantMultipartUpload(
    request: Request,
    publicSlug: string,
    submissionIdInput: string,
    fieldIdInput: string,
  ) {
    const submissionId = z.string().min(1).max(100).parse(submissionIdInput);
    const fieldId = z
      .string()
      .regex(/^[a-z][a-z0-9_]{1,39}$/)
      .parse(fieldIdInput);
    const form = await this.getPublicForm(publicSlug);
    const applicant = await this.applicants.get(request, form);
    if (!applicant) {
      throw new Response(
        "Open the application draft before uploading a video.",
        {
          status: 401,
        },
      );
    }
    this.assertApplicationManagementAccess(applicant);
    const draftForm = await this.repository.getApplicantDraftForm(
      form,
      applicant,
      submissionId,
    );
    const field = draftForm.version.schema.fields.find(
      (candidate) => candidate.id === fieldId,
    );
    if (field?.type !== "video") {
      throw new Response(
        "This application field does not accept video uploads.",
        {
          status: 422,
        },
      );
    }
    const draft = await this.env.DB.prepare(
      `SELECT event.organisation_id AS organisationId
         FROM submissions submission
         JOIN events event ON event.id = submission.event_id
         JOIN form_versions version
           ON version.id = submission.form_version_id
          AND version.event_id = submission.event_id
        WHERE submission.id = ? AND submission.event_id = ?
          AND version.form_id = ? AND version.id = ?
          AND submission.status = 'draft'
          AND (
            (? IS NOT NULL AND submission.submitter_person_id = ?)
            OR
            (? IS NOT NULL AND submission.id = ?
              AND submission.submitter_person_id IS NULL
              AND submission.submitter_email IS NULL)
          )`,
    )
      .bind(
        submissionId,
        form.eventId,
        form.id,
        draftForm.version.id,
        applicant.personId,
        applicant.personId,
        applicant.anonymousDraftId,
        applicant.anonymousDraftId,
      )
      .first<{ organisationId: string }>();
    if (!draft) {
      throw new Response("Application draft not found.", { status: 404 });
    }
    return {
      organisationId: draft.organisationId,
      eventId: form.eventId,
      personId: applicant.personId,
      submissionId,
      fieldId,
    };
  }

  private applicationAvailability(
    form: Awaited<ReturnType<SubmissionService["getPublicForm"]>>,
  ) {
    if (
      form.closesAt !== null &&
      form.closesAt < Math.floor(Date.now() / 1_000)
    ) {
      return {
        accepting: false as const,
        reason: "Applications for this event are closed.",
      };
    }
    if (
      form.submissionLimit !== null &&
      form.submittedCount >= form.submissionLimit
    ) {
      return {
        accepting: false as const,
        reason: "This call for speakers has reached its submission limit.",
      };
    }
    return { accepting: true as const, reason: null };
  }

  private async getApplicantVideoUpload(
    form: PublicForm,
    applicant: Applicant,
    submissionId: string,
  ) {
    const field = form.version.schema.fields.find(
      (candidate) => candidate.type === "video",
    );
    if (!field) return null;
    const row = await this.env.DB.prepare(
      `SELECT asset.id AS assetId, asset.status AS assetStatus,
              asset.current_version_id AS currentVersionId,
              version.id AS versionId, version.original_filename AS filename,
              version.size_bytes AS sizeBytes,
              version.upload_status AS uploadStatus,
              version.signature_status AS signatureStatus,
              version.scan_status AS scanStatus,
              version.released_at AS releasedAt
         FROM file_assets asset
         JOIN file_versions version
           ON version.asset_id = asset.id AND version.event_id = asset.event_id
        WHERE asset.event_id = ? AND asset.target_type = 'submission'
          AND asset.target_id = ? AND asset.asset_kind = 'video'
          AND asset.owner_person_id IS ? AND asset.status <> 'deleted'
        ORDER BY version.version_number DESC
        LIMIT 1`,
    )
      .bind(form.eventId, submissionId, applicant.personId)
      .first<ApplicantVideoUploadRow>();
    if (!row) return null;
    const status =
      row.assetStatus === "active" &&
      row.currentVersionId === row.versionId &&
      row.uploadStatus === "uploaded" &&
      row.signatureStatus === "valid" &&
      row.scanStatus === "clean" &&
      row.releasedAt !== null
        ? ("ready" as const)
        : row.uploadStatus === "uploaded" &&
            row.signatureStatus === "valid" &&
            row.scanStatus === "pending"
          ? ("scanning" as const)
          : ["failed", "aborted"].includes(row.uploadStatus) ||
              ["invalid", "failed"].includes(row.signatureStatus) ||
              ["infected", "failed"].includes(row.scanStatus) ||
              row.assetStatus === "rejected"
            ? ("rejected" as const)
            : ("uploading" as const);
    return {
      fieldId: field.id,
      assetId: row.assetId,
      versionId: row.versionId,
      filename: row.filename,
      sizeBytes: row.sizeBytes,
      status,
    };
  }

  async getApplicantPortal(
    publicSlug: string,
    request: Request,
    selectedId?: string | null,
  ) {
    const form = await this.getPublicForm(publicSlug);
    const applicant = await this.applicants.get(request, form);
    const availability = this.applicationAvailability(form);
    if (!applicant) {
      const browserForm = applicantFormView(form);
      return {
        form: browserForm,
        applicant: null,
        drafts: [],
        invitations: [],
        speakerProfile: null,
        selected: null,
        selectedForm: browserForm,
        selectedUpload: null,
        availability,
      };
    }
    const [drafts, invitations, claimedProfile] = await Promise.all([
      applicant.claimOnly
        ? Promise.resolve([])
        : this.repository.getApplicantDrafts(form.id, applicant),
      this.repository.getCoSpeakerInvitations(form.id, applicant),
      applicant.verified
        ? this.env.DB.prepare(
            `SELECT 1 AS available
               FROM submission_speakers speaker
               JOIN submissions submission
                 ON submission.id = speaker.submission_id
                AND submission.event_id = speaker.event_id
               JOIN form_versions version
                 ON version.id = submission.form_version_id
                AND version.event_id = submission.event_id
              WHERE speaker.person_id = ? AND speaker.invitation_status = 'claimed'
                AND version.form_id = ? AND speaker.event_id = ?
              LIMIT 1`,
          )
            .bind(applicant.personId, form.id, form.eventId)
            .first<{ available: number }>()
        : Promise.resolve(null),
    ]);
    const requestedDraft = selectedId !== null && selectedId !== undefined;
    const selected = requestedDraft
      ? (drafts.find((draft) => draft.id === selectedId) ?? null)
      : (drafts.find((draft) => draft.status === "draft") ??
        drafts.at(0) ??
        null);
    if (requestedDraft && !selected) {
      throw new Response("Application draft not found", { status: 404 });
    }
    const selectedForm = selected
      ? await this.repository.getApplicantDraftForm(
          form,
          applicant,
          selected.id,
        )
      : form;
    const selectedUpload =
      selected?.status === "draft" && selectedForm
        ? await this.getApplicantVideoUpload(
            selectedForm,
            applicant,
            selected.id,
          )
        : null;
    return {
      form: applicantFormView(form),
      applicant,
      drafts,
      invitations,
      speakerProfile:
        applicant.verified && claimedProfile
          ? {
              name: applicant.name,
              biography: applicant.biography,
              revision: applicant.profileRevision,
            }
          : null,
      selected,
      selectedForm: applicantFormView(selectedForm),
      selectedUpload,
      availability,
    };
  }

  async createDraft(
    publicSlug: string,
    applicant: Applicant,
    intentId: string = crypto.randomUUID(),
  ) {
    this.assertApplicationManagementAccess(applicant);
    const form = await this.getPublicForm(publicSlug);
    const scope = await this.publicScope(form.eventId);
    return this.projectIntentCommand(
      { ...scope, personId: applicant.personId },
      "submission.draft.create",
      intentId,
      { publicSlug, applicant },
      async () => {
        const draftId = await intentBoundDraftId(
          form.id,
          "authenticated",
          applicant.personId,
          intentId,
        );
        const replay = await this.repository.findDraftCreationReplay(
          form,
          applicant,
          draftId,
        );
        if (replay) return replay.id;
        const availability = this.applicationAvailability(form);
        if (!availability.accepting) {
          throw new PublicFormUnavailableError(availability.reason);
        }
        return this.repository.createDraft(form, applicant, draftId);
      },
    );
  }

  async startAnonymousDraft(
    publicSlug: string,
    password: string,
    intentId: string = crypto.randomUUID(),
  ) {
    const form = await this.getPublicForm(publicSlug);
    const scope = await this.publicScope(form.eventId);
    return this.projectIntentCommand(
      { ...scope, personId: null },
      "submission.anonymous_draft.start",
      intentId,
      { publicSlug, password },
      async () =>
        this.startAnonymousDraftD1(
          form,
          password,
          await intentBoundDraftId(form.id, "anonymous", null, intentId),
        ),
      { replay: "reject" },
    );
  }

  private async startAnonymousDraftD1(
    form: PublicForm,
    password: string,
    draftId: string,
  ) {
    const applicant: Applicant = {
      personId: null,
      email: "",
      name: "",
      verified: false,
      anonymousDraftId: draftId,
      biography: "",
      profileRevision: 0,
    };
    const replay = await this.repository.findDraftCreationReplay(
      form,
      applicant,
      draftId,
    );
    if (!replay) {
      const availability = this.applicationAvailability(form);
      if (!availability.accepting) {
        throw new PublicFormUnavailableError(availability.reason);
      }
    }
    const session = await this.applicants.startAnonymous(
      form,
      draftId,
      password,
      { requireExistingDraft: Boolean(replay) },
    );
    if (replay) return { draftId, cookie: session.cookie };
    try {
      await this.repository.createDraft(form, session.applicant, draftId);
    } catch (error) {
      await this.env.DB.prepare("DELETE FROM verification_tokens WHERE id = ?")
        .bind(session.tokenId)
        .run();
      throw error;
    }
    return { draftId, cookie: session.cookie };
  }

  async saveDraft(
    publicSlug: string,
    applicant: Applicant,
    rawPayload: unknown,
  ) {
    this.assertApplicationManagementAccess(applicant);
    const currentForm = await this.getPublicForm(publicSlug);
    const scope = await this.publicScope(currentForm.eventId);
    return this.projectCommand(
      { ...scope, personId: applicant.personId },
      "submission.draft.save",
      { publicSlug, applicant, rawPayload },
      () => this.saveDraftD1(currentForm, applicant, rawPayload),
    );
  }

  private async saveDraftD1(
    currentForm: PublicForm,
    applicant: Applicant,
    rawPayload: unknown,
  ) {
    const payload = draftPayloadSchema.parse(rawPayload);
    if (
      applicant.verified &&
      payload.speakers[0]?.email.toLowerCase() !== applicant.email.toLowerCase()
    ) {
      throw answerValidationError({
        speakers: [
          "The primary speaker email must match the verified applicant email.",
        ],
      });
    }
    const form = await this.repository.getApplicantDraftForm(
      currentForm,
      applicant,
      payload.submissionId,
    );
    const errors = validateAnswerShapes(
      form.version.schema,
      payload.answers,
      payload.uploads,
    );
    if (Object.keys(errors).length) throw answerValidationError(errors);
    return this.repository.saveDraft(form, applicant, payload);
  }

  private async resolveAutomaticRouting(
    form: Pick<PublicForm, "eventId">,
    teamId: string,
  ) {
    const team = await this.env.DB.prepare(
      `SELECT id FROM evaluation_teams
        WHERE id = ? AND event_id = ? AND status = 'active'`,
    )
      .bind(teamId, form.eventId)
      .first<{ id: string }>();
    if (!team) {
      throw new SubmissionStateError(
        "The evaluation team configured for this category is no longer active. Your draft was not submitted.",
      );
    }
    const rounds = await this.env.DB.prepare(
      `SELECT round.id
         FROM evaluation_rounds round
         JOIN evaluation_plans plan
           ON plan.id = round.plan_id AND plan.event_id = round.event_id
        WHERE round.event_id = ? AND round.status = 'active'
          AND plan.status = 'active'
        ORDER BY round.id`,
    )
      .bind(form.eventId)
      .all<{ id: string }>();
    if (rounds.results.length !== 1) {
      throw new SubmissionStateError(
        rounds.results.length === 0
          ? "Automatic category routing requires one active evaluation round. Activate a round before applications are submitted."
          : "Automatic category routing is ambiguous because this event has more than one active evaluation round.",
      );
    }
    const members = await this.env.DB.prepare(
      `SELECT member.person_id AS personId,
              EXISTS (
                SELECT 1 FROM memberships membership
                 WHERE membership.event_id = member.event_id
                   AND membership.person_id = member.person_id
                   AND membership.role IN ('evaluator','committee_chair')
                   AND membership.accepted_at IS NOT NULL
                   AND membership.revoked_at IS NULL
              ) AS eligible
         FROM evaluation_team_members member
        WHERE member.team_id = ? AND member.event_id = ?
          AND member.removed_at IS NULL
        ORDER BY member.person_id`,
    )
      .bind(teamId, form.eventId)
      .all<{ personId: string; eligible: number }>();
    if (!members.results.length) {
      throw new SubmissionStateError(
        "The evaluation team configured for this category has no active members. Your draft was not submitted.",
      );
    }
    if (members.results.some((member) => !member.eligible)) {
      throw new SubmissionStateError(
        "Every active member of the routed team must have an accepted evaluator or committee-chair membership before applications can be submitted.",
      );
    }
    return {
      teamId,
      roundId: rounds.results[0]!.id,
      evaluatorPersonIds: members.results.map((member) => member.personId),
    };
  }

  async submitDraft(
    publicSlug: string,
    applicant: Applicant,
    rawPayload: unknown,
  ) {
    this.assertApplicationManagementAccess(applicant);
    if (!applicant.verified) {
      throw new SubmissionStateError(
        "Verify your email before submitting this application.",
      );
    }
    const currentForm = await this.getPublicForm(publicSlug);
    const scope = await this.publicScope(currentForm.eventId);
    return this.projectCommand(
      { ...scope, personId: applicant.personId },
      "submission.draft.submit",
      { publicSlug, applicant, rawPayload },
      () => this.submitDraftD1(currentForm, applicant, rawPayload),
    );
  }

  async submitDraftForParticipantApi(
    publicSlug: string,
    applicant: Extract<Applicant, { verified: true }>,
    rawPayload: unknown,
    operationId: string,
  ) {
    this.assertApplicationManagementAccess(applicant);
    const currentForm = await this.getPublicForm(publicSlug);
    const scope = await this.publicScope(currentForm.eventId);
    return this.projectCommand(
      { ...scope, personId: applicant.personId },
      "submission.participant_api.submit",
      { publicSlug, applicant, rawPayload, operationId },
      () => this.submitDraftD1(currentForm, applicant, rawPayload, operationId),
    );
  }

  private async submitDraftD1(
    currentForm: PublicForm,
    applicant: Extract<Applicant, { verified: true }>,
    rawPayload: unknown,
    operationId?: string,
  ) {
    const availability = this.applicationAvailability(currentForm);
    if (!availability.accepting)
      throw new PublicFormUnavailableError(availability.reason);
    const payload = draftPayloadSchema.parse(rawPayload);
    if (
      payload.speakers[0]?.email.toLowerCase() !== applicant.email.toLowerCase()
    ) {
      throw answerValidationError({
        speakers: [
          "The primary speaker email must match the verified applicant email.",
        ],
      });
    }
    const form = await this.repository.getApplicantDraftForm(
      currentForm,
      applicant,
      payload.submissionId,
    );
    const shapeErrors = validateAnswerShapes(
      form.version.schema,
      payload.answers,
      payload.uploads,
    );
    if (Object.keys(shapeErrors).length)
      throw answerValidationError(shapeErrors);
    const answers = visibleAnswers(form.version.schema, payload.answers);
    const visibleVideoFields = new Set(
      visibleFields(form.version.schema, answers)
        .filter((field) => field.type === "video")
        .map((field) => field.id),
    );
    const uploads = Object.fromEntries(
      Object.entries(payload.uploads).filter(
        ([fieldId]) =>
          visibleVideoFields.has(fieldId) &&
          !String(answers[fieldId] ?? "").trim(),
      ),
    );
    const submittedPayload = {
      ...payload,
      answers,
      uploads,
    };
    const errors = validateFinalAnswers(
      form.version.schema,
      submittedPayload.answers,
      submittedPayload.speakers,
      form.minSpeakers,
      form.maxSpeakers,
      submittedPayload.uploads,
    );
    if (Object.keys(errors).length) {
      throw answerValidationError(errors);
    }
    const category = String(submittedPayload.answers.category ?? "");
    const routedTeamId =
      form.kind === "submission"
        ? (form.version.routing.categories[category] ?? null)
        : null;
    const routingAssignment = routedTeamId
      ? await this.resolveAutomaticRouting(form, routedTeamId)
      : null;
    for (const [fieldId, reference] of Object.entries(
      submittedPayload.uploads,
    )) {
      const upload = await this.env.DB.prepare(
        `SELECT asset.status AS assetStatus,
                asset.current_version_id AS currentVersionId,
                version.upload_status AS uploadStatus,
                version.signature_status AS signatureStatus,
                version.scan_status AS scanStatus,
                version.released_at AS releasedAt
           FROM file_assets asset
           JOIN file_versions version
             ON version.id = ? AND version.asset_id = asset.id
            AND version.event_id = asset.event_id
          WHERE asset.id = ? AND asset.event_id = ?
            AND asset.target_type = 'submission' AND asset.target_id = ?
            AND asset.asset_kind = 'video' AND asset.owner_person_id = ?
            AND asset.status <> 'deleted'`,
      )
        .bind(
          reference.versionId,
          reference.assetId,
          form.eventId,
          submittedPayload.submissionId,
          applicant.personId,
        )
        .first<{
          assetStatus: string;
          currentVersionId: string | null;
          uploadStatus: string;
          signatureStatus: string;
          scanStatus: string;
          releasedAt: number | null;
        }>();
      if (!upload) {
        throw new SubmissionStateError(
          `The native video selected for ${fieldId} no longer belongs to this draft. Upload it again or use an HTTPS link.`,
        );
      }
      if (
        upload.assetStatus !== "active" ||
        upload.currentVersionId !== reference.versionId ||
        upload.uploadStatus !== "uploaded" ||
        upload.signatureStatus !== "valid" ||
        upload.scanStatus !== "clean" ||
        upload.releasedAt === null
      ) {
        const message =
          upload.uploadStatus === "uploaded" &&
          upload.signatureStatus === "valid" &&
          upload.scanStatus === "pending"
            ? "The uploaded video is still being scanned. Refresh after the scan finishes before submitting."
            : "The uploaded video did not pass upload and security validation. Upload a replacement or use an HTTPS link.";
        throw new SubmissionStateError(message);
      }
    }
    return this.repository.submitDraft(form, applicant, submittedPayload, {
      routedTeamId,
      routingAssignment,
      upload:
        Object.entries(submittedPayload.uploads).map(
          ([fieldId, reference]) => ({ fieldId, ...reference }),
        )[0] ?? null,
      operationId,
    });
  }

  async withdrawSubmission(
    publicSlug: string,
    applicant: Applicant,
    rawInput: unknown,
  ) {
    this.assertApplicationManagementAccess(applicant);
    if (!applicant.verified) {
      throw new SubmissionStateError(
        "Verify your email before withdrawing this application.",
      );
    }
    const input = withdrawSubmissionSchema.parse(rawInput);
    const currentForm = await this.getPublicForm(publicSlug);
    const form = await this.repository.getApplicantDraftForm(
      currentForm,
      applicant,
      input.submissionId,
    );
    const scope = await this.publicScope(form.eventId);
    return this.projectCommand(
      { ...scope, personId: applicant.personId },
      "submission.withdraw",
      { publicSlug, input },
      () =>
        this.repository.withdrawSubmission(
          form,
          applicant,
          input.submissionId,
          input.revision,
        ),
    );
  }

  async withdrawSubmissionForParticipantApi(
    publicSlug: string,
    applicant: Extract<Applicant, { verified: true }>,
    rawInput: unknown,
    operationId: string,
  ) {
    this.assertApplicationManagementAccess(applicant);
    const input = withdrawSubmissionSchema.parse(rawInput);
    const currentForm = await this.getPublicForm(publicSlug);
    const form = await this.repository.getApplicantDraftForm(
      currentForm,
      applicant,
      input.submissionId,
    );
    const scope = await this.publicScope(form.eventId);
    return this.projectCommand(
      { ...scope, personId: applicant.personId },
      "submission.participant_api.withdraw",
      { publicSlug, input, operationId },
      () =>
        this.repository.withdrawSubmission(
          form,
          applicant,
          input.submissionId,
          input.revision,
          { operationId },
        ),
    );
  }

  async updateClaimedSpeakerProfile(
    publicSlug: string,
    applicant: Applicant,
    rawInput: unknown,
  ) {
    if (!applicant.verified) {
      throw new SubmissionStateError(
        "Verify your email before updating a speaker profile.",
      );
    }
    const form = await this.getPublicForm(publicSlug);
    const scope = await this.publicScope(form.eventId);
    return this.projectCommand(
      { ...scope, personId: applicant.personId },
      "submission.speaker_profile.update",
      { publicSlug, rawInput },
      () => this.updateClaimedSpeakerProfileD1(form, applicant, rawInput),
    );
  }

  private async updateClaimedSpeakerProfileD1(
    form: PublicForm,
    applicant: Extract<Applicant, { verified: true }>,
    rawInput: unknown,
  ) {
    const input = z
      .object({
        revision: z.coerce.number().int().positive(),
        name: z.string().trim().min(1).max(120),
        biography: z.string().trim().max(5_000),
      })
      .parse(rawInput);
    const operationId = crypto.randomUUID();
    const [updated] = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE people
            SET display_name = ?, biography = ?, profile_revision = profile_revision + 1,
                last_operation_id = ?, updated_at = unixepoch()
          WHERE id = ? AND profile_revision = ? AND email_verified = 1
            AND EXISTS (
              SELECT 1 FROM submission_speakers speaker
              JOIN submissions submission
                ON submission.id = speaker.submission_id
               AND submission.event_id = speaker.event_id
              JOIN form_versions version
                ON version.id = submission.form_version_id
               AND version.event_id = submission.event_id
             WHERE speaker.person_id = people.id
               AND speaker.invitation_status = 'claimed'
               AND version.form_id = ? AND speaker.event_id = ?
            )`,
      ).bind(
        input.name,
        input.biography || null,
        operationId,
        applicant.personId,
        input.revision,
        form.id,
        form.eventId,
      ),
      this.env.DB.prepare(
        `UPDATE submission_speakers
            SET display_name = ?, updated_at = unixepoch()
          WHERE person_id = ? AND event_id = ? AND invitation_status = 'claimed'
            AND EXISTS (SELECT 1 FROM people WHERE id = ? AND last_operation_id = ?)`,
      ).bind(
        input.name,
        applicant.personId,
        form.eventId,
        applicant.personId,
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action, entity_type,
           entity_id, metadata_json, created_at
         ) SELECT ?, event.organisation_id, ?, ?, 'speaker.profile.updated',
                  'person', ?, ?, unixepoch()
             FROM events event
            WHERE event.id = ?
              AND EXISTS (SELECT 1 FROM people WHERE id = ? AND last_operation_id = ?)`,
      ).bind(
        crypto.randomUUID(),
        form.eventId,
        applicant.personId,
        applicant.personId,
        JSON.stringify({ source: "application_claim" }),
        form.eventId,
        applicant.personId,
        operationId,
      ),
    ]);
    if ((updated.meta.changes ?? 0) !== 1) {
      throw new SubmissionRevisionConflictError();
    }
  }

  async claimCoSpeaker(
    publicSlug: string,
    applicant: Applicant,
    invitationId: string,
  ) {
    const form = await this.getPublicForm(publicSlug);
    const scope = await this.publicScope(form.eventId);
    await this.projectCommand(
      { ...scope, personId: applicant.personId },
      "submission.co_speaker.claim",
      { publicSlug, invitationId, applicant },
      () => this.repository.claimCoSpeaker(form.id, applicant, invitationId),
    );
  }

  async getCoSpeakerClaim(
    publicSlug: string,
    speakerId: string,
    rawToken: string,
  ) {
    const form = await this.getPublicForm(publicSlug);
    return this.getCoSpeakerClaimD1(form, speakerId, rawToken);
  }

  private async getCoSpeakerClaimD1(
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
              submission.id AS submissionId, submission.title AS submissionTitle
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

  async claimCoSpeakerToken(
    publicSlug: string,
    speakerId: string,
    rawToken: string,
  ) {
    const form = await this.getPublicForm(publicSlug);
    const scope = await this.publicScope(form.eventId);
    return this.projectCommand(
      { ...scope, personId: null },
      "submission.co_speaker_token.claim",
      { publicSlug, speakerId, rawToken },
      () => this.claimCoSpeakerTokenD1(form, speakerId, rawToken),
      { replay: "reject" },
    );
  }

  private async claimCoSpeakerTokenD1(
    form: PublicForm,
    speakerId: string,
    rawToken: string,
  ) {
    const expectedClaimTokenHash = await hashApplicantToken(
      `co-speaker-claim:${form.id}:${speakerId}:${rawToken}`,
    );
    const claim = await this.getCoSpeakerClaimD1(form, speakerId, rawToken);
    if (!claim) {
      throw new SubmissionStateError(
        "This co-speaker claim link is invalid or has been replaced.",
      );
    }
    if (claim.expired) {
      await this.env.DB.prepare(
        `UPDATE submission_speakers
            SET invitation_status = 'expired', updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND invitation_status IN ('pending','sent')
            AND invitation_expires_at <= unixepoch()`,
      )
        .bind(speakerId, form.eventId)
        .run();
      throw new SubmissionCommittedStateError(
        "This co-speaker claim link has expired. Ask an administrator to resend it.",
      );
    }
    const proposedBiography = await this.env.DB.prepare(
      `SELECT revision.speaker_snapshot_json AS speakerSnapshotJson
         FROM submission_revisions revision
        WHERE revision.submission_id = ? AND revision.event_id = ?
        ORDER BY revision.revision_number DESC LIMIT 1`,
    )
      .bind(claim.submissionId, form.eventId)
      .first<{ speakerSnapshotJson: string }>();
    if (!proposedBiography) {
      throw new SubmissionStateError(
        "The latest submission speaker revision is unavailable for this co-speaker claim.",
      );
    }
    const speakers = draftPayloadSchema.shape.speakers.parse(
      JSON.parse(proposedBiography.speakerSnapshotJson),
    );
    const matchingSpeaker = speakers.find(
      (speaker) => speaker.email.toLowerCase() === claim.email.toLowerCase(),
    );
    if (!matchingSpeaker) {
      throw new SubmissionStateError(
        "The latest submission speaker revision does not contain this co-speaker claim.",
      );
    }
    const biography = matchingSpeaker.biography;
    const personId = crypto.randomUUID();
    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, email_verified, biography, profile_status,
           created_at, updated_at
         ) VALUES (?, ?, ?, 0, ?, 'draft', unixepoch(), unixepoch())
         ON CONFLICT(email) DO NOTHING`,
      ).bind(personId, claim.email, claim.displayName, biography ?? null),
    ]);
    const person = await this.env.DB.prepare(
      `SELECT id AS personId, email, display_name AS name,
              COALESCE(biography, '') AS biography,
              profile_revision AS profileRevision
         FROM people WHERE email = ? COLLATE NOCASE`,
    )
      .bind(claim.email)
      .first<{
        personId: string;
        email: string;
        name: string;
        biography: string;
        profileRevision: number;
      }>();
    if (!person) {
      throw new SubmissionStateError(
        "The co-speaker identity could not be established.",
      );
    }
    const preparedSession = await this.applicants.prepareVerifiedSession(
      form,
      person.personId,
    );
    if (!preparedSession.applicant.verified) {
      throw new Error("A prepared co-speaker claim session must be verified.");
    }
    await this.repository.claimCoSpeaker(
      form.id,
      preparedSession.applicant,
      speakerId,
      expectedClaimTokenHash,
      preparedSession.persistence,
      biography ?? null,
    );
    const claimedApplicant = {
      ...preparedSession.applicant,
      biography:
        preparedSession.applicant.biography.trim() || biography?.trim() || "",
    };
    return {
      applicant:
        form.accessMode === "account_required"
          ? { ...claimedApplicant, claimOnly: true }
          : claimedApplicant,
      cookie: preparedSession.cookie,
    };
  }

  async resendCoSpeakerInvitation(viewer: Viewer, invitationId: string) {
    return this.projectCommand(
      viewer,
      "submission.co_speaker.resend",
      { invitationId },
      () => this.resendCoSpeakerInvitationD1(viewer, invitationId),
    );
  }

  private async resendCoSpeakerInvitationD1(
    viewer: Viewer,
    invitationId: string,
  ) {
    const operationsQueue = this.env.OPERATIONS_QUEUE;
    if (!operationsQueue) {
      throw new Error("Required OPERATIONS_QUEUE binding is unavailable.");
    }
    const row = await this.env.DB.prepare(
      `SELECT speaker.id, speaker.email, speaker.display_name AS displayName,
              speaker.claim_token_hash AS claimTokenHash,
              submission.id AS submissionId, submission.title AS submissionTitle,
              form.id AS formId, form.public_slug AS publicSlug,
              event.name AS eventName, event.starts_at AS startsAt,
              event.ends_at AS endsAt, event.brand_accent AS brandAccent,
              event.venue_name AS venueName,
              event.city
         FROM submission_speakers speaker
         JOIN submissions submission
           ON submission.id = speaker.submission_id
          AND submission.event_id = speaker.event_id
         JOIN form_versions version
           ON version.id = submission.form_version_id
          AND version.event_id = submission.event_id
         JOIN form_definitions form
           ON form.id = version.form_id AND form.event_id = version.event_id
         JOIN events event
           ON event.id = speaker.event_id AND event.organisation_id = ?
        WHERE speaker.id = ? AND speaker.event_id = ? AND speaker.is_primary = 0
          AND speaker.invitation_status IN ('pending','sent','expired')`,
    )
      .bind(viewer.organisationId, invitationId, viewer.eventId)
      .first<{
        id: string;
        email: string;
        displayName: string;
        claimTokenHash: string | null;
        submissionId: string;
        submissionTitle: string;
        formId: string;
        publicSlug: string;
        eventName: string;
        brandAccent: string;
        startsAt: number;
        endsAt: number;
        venueName: string | null;
        city: string | null;
      }>();
    if (!row) {
      throw new SubmissionStateError(
        "This co-speaker invitation is unavailable in the current event.",
      );
    }
    const plan = await buildCoSpeakerInvitationPlan(
      this.env,
      {
        organisationId: viewer.organisationId,
        eventId: viewer.eventId,
        eventName: row.eventName,
        brandAccent: row.brandAccent,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        physicalAddress: [row.venueName, row.city]
          .filter((value): value is string => Boolean(value?.trim()))
          .join(", "),
        formId: row.formId,
        publicSlug: row.publicSlug,
        submissionId: row.submissionId,
        submissionTitle: row.submissionTitle,
        requestedByPersonId: viewer.personId,
      },
      row,
    );
    const [updated] = await this.env.DB.batch(plan.statements);
    if ((updated.meta.changes ?? 0) !== 1) {
      throw new SubmissionStateError(
        "This invitation changed before it could be resent. Refresh and try again.",
      );
    }
    try {
      await operationsQueue.send(plan.message);
      return { status: "queued" as const, operationId: plan.operationId };
    } catch (error) {
      await persistQueueFailure(this.env, plan, error);
      return { status: "queue_failed" as const, operationId: plan.operationId };
    }
  }

  async listAdminSubmissions(
    viewer: Viewer,
    filters: { status?: string; category?: string; query?: string },
  ) {
    await this.airtable.assertReadable(viewer);
    return this.repository.listAdminSubmissions(
      viewer.organisationId,
      viewer.eventId,
      filters,
    );
  }

  async listAdminSubmissionPage(
    viewer: Viewer,
    filters: { status?: string; category?: string; query?: string },
    page: number,
  ) {
    await this.airtable.assertReadable(viewer);
    if (!Number.isInteger(page) || page < 1) {
      throw new Response("Invalid submissions page", { status: 400 });
    }
    const pageSize = 50;
    const [rows, categories] = await Promise.all([
      this.repository.listAdminSubmissions(
        viewer.organisationId,
        viewer.eventId,
        filters,
        { limit: pageSize + 1, offset: (page - 1) * pageSize },
      ),
      this.repository.listAdminSubmissionCategories(
        viewer.organisationId,
        viewer.eventId,
      ),
    ]);
    return {
      submissions: rows.slice(0, pageSize),
      categories,
      page,
      hasNext: rows.length > pageSize,
    };
  }

  async getAdminSubmission(viewer: Viewer, submissionId: string) {
    await this.airtable.assertReadable(viewer);
    return this.repository.getAdminSubmission(
      viewer.organisationId,
      viewer.eventId,
      submissionId,
    );
  }

  private async readAdminMutation(
    command: Omit<PreparedAdminMutation, "recordId">,
  ) {
    const row = await this.env.DB.prepare(
      `SELECT id, request_hash AS requestHash, status, entity_id AS entityId
         FROM idempotency_records
        WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
          AND scope = ? AND idempotency_key = ?
          AND expires_at > unixepoch()`,
    )
      .bind(
        command.organisationId,
        command.eventId,
        command.actorId,
        command.scope,
        command.idempotencyKey,
      )
      .first<AdminMutationRecord>();
    if (!row) return null;
    if (row.requestHash !== command.requestHash) {
      throw new SubmissionStateError(
        "This idempotency key was already used with different record details. Refresh before trying again.",
      );
    }
    if (row.status !== "completed") {
      throw new SubmissionStateError(
        "This record creation request is already being processed. Wait for it to finish before retrying.",
      );
    }
    if (!row.entityId) {
      throw new Error(
        "A completed submission administration idempotency record is missing its entity ID.",
      );
    }
    return row.entityId;
  }

  private async prepareAdminMutation(
    actor: SubmissionAdminActor,
    scope: PreparedAdminMutation["scope"],
    idempotencyKey: string,
    requestPayload: unknown,
  ) {
    if (isSubmissionApiActor(actor) && !actor.actorId.startsWith("api_key:")) {
      throw new Error("Submission API actor IDs must identify an API key.");
    }
    const requestHash = await hashApplicantToken(
      JSON.stringify(requestPayload),
    );
    const identity = {
      scope,
      idempotencyKey,
      requestHash,
      organisationId: actor.organisationId,
      eventId: actor.eventId,
      actorId: isSubmissionApiActor(actor) ? actor.actorId : actor.personId,
    };
    const replay = await this.readAdminMutation(identity);
    return replay
      ? { replay, command: null }
      : {
          replay: null,
          command: { ...identity, recordId: crypto.randomUUID() },
        };
  }

  private adminMutationClaimStatements(command: PreparedAdminMutation) {
    return [
      this.env.DB.prepare(
        `DELETE FROM idempotency_records
          WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
            AND scope = ? AND idempotency_key = ?
            AND expires_at <= unixepoch()`,
      ).bind(
        command.organisationId,
        command.eventId,
        command.actorId,
        command.scope,
        command.idempotencyKey,
      ),
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO idempotency_records (
           id, organisation_id, event_id, actor_id, scope, idempotency_key,
           request_hash, status, expires_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'processing',
                   unixepoch() + 2592000, unixepoch())`,
      ).bind(
        command.recordId,
        command.organisationId,
        command.eventId,
        command.actorId,
        command.scope,
        command.idempotencyKey,
        command.requestHash,
      ),
    ];
  }

  private async resolveAdminMutationRace(command: PreparedAdminMutation) {
    const row = await this.env.DB.prepare(
      `SELECT id, request_hash AS requestHash, status, entity_id AS entityId
         FROM idempotency_records
        WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
          AND scope = ? AND idempotency_key = ?
          AND expires_at > unixepoch()`,
    )
      .bind(
        command.organisationId,
        command.eventId,
        command.actorId,
        command.scope,
        command.idempotencyKey,
      )
      .first<AdminMutationRecord>();
    if (!row) return null;
    if (row.requestHash !== command.requestHash) {
      throw new SubmissionStateError(
        "This idempotency key was already used with different record details. Refresh before trying again.",
      );
    }
    if (row.status === "completed") {
      if (!row.entityId) {
        throw new Error(
          "A completed submission administration idempotency record is missing its entity ID.",
        );
      }
      return row.entityId;
    }
    if (row.id !== command.recordId) {
      throw new SubmissionStateError(
        "This record creation request is already being processed. Wait for it to finish before retrying.",
      );
    }
    await this.env.DB.prepare(
      `DELETE FROM idempotency_records
        WHERE id = ? AND organisation_id = ? AND event_id = ?
          AND actor_id = ? AND status = 'processing'`,
    )
      .bind(
        command.recordId,
        command.organisationId,
        command.eventId,
        command.actorId,
      )
      .run();
    return null;
  }

  async createDirectSession(viewer: Viewer, rawInput: unknown) {
    const result = await this.executeDirectSession(viewer, rawInput);
    return result.sessionId;
  }

  createDirectSessionForApi(actor: SubmissionApiActor, rawInput: unknown) {
    return this.executeDirectSession(actor, rawInput);
  }

  private executeDirectSession(actor: SubmissionAdminActor, rawInput: unknown) {
    return this.projectCommand(
      actor,
      "submission.direct_session.create",
      rawInput,
      () => this.createDirectSessionD1(actor, rawInput),
    );
  }

  private async createDirectSessionD1(
    actor: SubmissionAdminActor,
    rawInput: unknown,
  ) {
    const parsed = directSessionSchema.parse(rawInput);
    const { idempotencyKey, ...inputWithoutDuration } = parsed;
    const prepared = await this.prepareAdminMutation(
      actor,
      "submission.admin.direct_session.create",
      idempotencyKey,
      inputWithoutDuration,
    );
    if (prepared.replay) {
      return { sessionId: prepared.replay, replayed: true };
    }
    const formatSnapshot =
      await this.getConfiguredSessionFormatSnapshotD1(actor);
    const configuredFormat = formatSnapshot.formats.find(
      (format) => format.key === parsed.format,
    );
    if (!configuredFormat) {
      throw new SubmissionStateError(
        `Session format “${parsed.format}” is not configured for this event.`,
      );
    }
    const input = {
      ...inputWithoutDuration,
      durationMinutes:
        parsed.durationMinutes ?? configuredFormat.defaultDurationMinutes,
    };
    const command = prepared.command!;
    const sessionId = crypto.randomUUID();
    const slug = `${slugify(input.title)}-${sessionId.slice(0, 6)}`;
    const auditEventId = crypto.randomUUID();
    const webhookService = new WebhookService(this.env);
    const preparedWebhook = await webhookService.prepareEventForAudit(
      {
        organisationId: actor.organisationId,
        eventId: actor.eventId,
        personId: isSubmissionApiActor(actor) ? null : actor.personId,
        actorId: isSubmissionApiActor(actor) ? actor.actorId : undefined,
      },
      {
        eventType: "session.created",
        entityType: "session",
        entityId: sessionId,
        idempotencyKey: `session.created:${sessionId}`,
        correlationId: command.recordId,
        data: {
          source: isSubmissionApiActor(actor)
            ? "api_direct_entry"
            : "administrator_direct_entry",
        },
      },
      auditEventId,
    );
    const statements: D1PreparedStatement[] = [
      ...this.adminMutationClaimStatements(command),
    ];
    const sessionInsertIndex = statements.length;
    statements.push(
      this.env.DB.prepare(
        `INSERT INTO sessions (
           id, event_id, title, slug, description, format, duration_minutes,
           status, created_at, updated_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, 'unscheduled', unixepoch(), unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM events
             WHERE id = ? AND organisation_id = ?
               AND session_formats_json = ?
          )
            AND EXISTS (
              SELECT 1 FROM idempotency_records command
               WHERE command.id = ? AND command.organisation_id = ?
                 AND command.event_id = ? AND command.actor_id = ?
                 AND command.scope = ? AND command.idempotency_key = ?
                 AND command.request_hash = ? AND command.status = 'processing'
            )`,
      ).bind(
        sessionId,
        actor.eventId,
        input.title,
        slug,
        input.description || null,
        input.format,
        input.durationMinutes,
        actor.eventId,
        actor.organisationId,
        formatSnapshot.serialized,
        command.recordId,
        command.organisationId,
        command.eventId,
        command.actorId,
        command.scope,
        command.idempotencyKey,
        command.requestHash,
      ),
    );
    for (const speaker of input.speakers) {
      statements.push(
        this.env.DB.prepare(
          `
          INSERT INTO people (
            id, email, display_name, email_verified, biography, profile_status,
            created_at, updated_at
          ) SELECT ?, ?, ?, 0, ?, 'draft', unixepoch(), unixepoch()
              WHERE EXISTS (
                SELECT 1 FROM sessions WHERE id = ? AND event_id = ?
              )
          ON CONFLICT(email) DO NOTHING
        `,
        ).bind(
          crypto.randomUUID(),
          speaker.email,
          speaker.name,
          speaker.biography || null,
          sessionId,
          actor.eventId,
        ),
      );
    }
    input.speakers.forEach((speaker, position) => {
      statements.push(
        this.env.DB.prepare(
          `
          INSERT INTO session_speakers (
            session_id, event_id, person_id, position, role_label
          ) SELECT ?, ?, id, ?, ? FROM people
             WHERE email = ? COLLATE NOCASE
               AND EXISTS (
                 SELECT 1 FROM sessions WHERE id = ? AND event_id = ?
               )
        `,
        ).bind(
          sessionId,
          actor.eventId,
          position,
          position === 0 ? "Primary speaker" : "Co-speaker",
          speaker.email,
          sessionId,
          actor.eventId,
        ),
      );
    });
    statements.push(
      ...materializePublishedResourceAcknowledgementsForSession(
        this.env,
        actor.eventId,
        sessionId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, actor_id, action,
          entity_type, entity_id, metadata_json, created_at
        ) SELECT ?, ?, ?, ?, ?, 'session.direct.created', 'session', ?, ?, unixepoch()
            WHERE EXISTS (
              SELECT 1 FROM sessions WHERE id = ? AND event_id = ?
            )
      `,
      ).bind(
        auditEventId,
        actor.organisationId,
        actor.eventId,
        isSubmissionApiActor(actor) ? null : actor.personId,
        isSubmissionApiActor(actor) ? actor.actorId : null,
        sessionId,
        JSON.stringify({
          title: input.title,
          speakerEmails: input.speakers.map((speaker) => speaker.email),
        }),
        sessionId,
        actor.eventId,
      ),
      this.env.DB.prepare(
        `UPDATE idempotency_records
            SET status = 'completed', response_status = 200,
                response_json = ?, entity_type = 'session', entity_id = ?,
                completed_at = unixepoch()
          WHERE id = ? AND organisation_id = ? AND event_id = ?
            AND actor_id = ? AND scope = ? AND idempotency_key = ?
            AND request_hash = ? AND status = 'processing'
            AND EXISTS (
              SELECT 1 FROM sessions WHERE id = ? AND event_id = ?
            )`,
      ).bind(
        JSON.stringify({ entityId: sessionId }),
        sessionId,
        command.recordId,
        command.organisationId,
        command.eventId,
        command.actorId,
        command.scope,
        command.idempotencyKey,
        command.requestHash,
        sessionId,
        actor.eventId,
      ),
    );
    statements.push(...preparedWebhook.statements);
    const results = await this.env.DB.batch(statements);
    if ((results[sessionInsertIndex]?.meta.changes ?? 0) !== 1) {
      const replay = await this.resolveAdminMutationRace(command);
      if (replay) return { sessionId: replay, replayed: true };
      throw new SubmissionStateError(
        "The event changed before the direct session was created. Refresh and try again.",
      );
    }
    await webhookService.dispatchPreparedEvent(preparedWebhook);
    return { sessionId, replayed: false };
  }

  async createManualApplication(viewer: Viewer, rawInput: unknown) {
    return this.projectCommand(
      viewer,
      "submission.manual_application.create",
      rawInput,
      () => this.createManualApplicationD1(viewer, rawInput),
    );
  }

  private async createManualApplicationD1(viewer: Viewer, rawInput: unknown) {
    const parsed = manualApplicationSchema.parse(rawInput);
    const { idempotencyKey, ...input } = parsed;
    const prepared = await this.prepareAdminMutation(
      viewer,
      "submission.admin.manual.create",
      idempotencyKey,
      input,
    );
    if (prepared.replay) return prepared.replay;
    const command = prepared.command!;
    const event = await this.env.DB.prepare(
      `SELECT id FROM events WHERE id = ? AND organisation_id = ?`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{ id: string }>();
    if (!event) throw new Response("Event not found", { status: 404 });
    const routedTeam = input.routedTeamId
      ? await this.env.DB.prepare(
          `SELECT id, name FROM evaluation_teams
          WHERE id = ? AND event_id = ? AND status = 'active'`,
        )
          .bind(input.routedTeamId, viewer.eventId)
          .first<{ id: string; name: string }>()
      : null;
    if (input.routedTeamId && !routedTeam) {
      throw new SubmissionStateError(
        "The selected evaluation team is unavailable in this event.",
      );
    }
    const routingAssignment = input.routedTeamId
      ? await this.resolveAutomaticRouting(
          { eventId: viewer.eventId },
          input.routedTeamId,
        )
      : null;
    const submissionId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const auditEventId = crypto.randomUUID();
    const webhookService = new WebhookService(this.env);
    const webhookInput = {
      source: "administrator_manual_entry",
      status: input.routedTeamId ? "assigned" : "submitted",
    };
    const preparedWebhooks = await Promise.all([
      webhookService.prepareEventForAudit(
        viewer,
        {
          eventType: "submission.created",
          entityType: "submission",
          entityId: submissionId,
          idempotencyKey: `submission.created:${submissionId}`,
          correlationId: operationId,
          data: webhookInput,
        },
        auditEventId,
      ),
      webhookService.prepareEventForAudit(
        viewer,
        {
          eventType: "submission.submitted",
          entityType: "submission",
          entityId: submissionId,
          idempotencyKey: `submission.submitted:${submissionId}`,
          correlationId: operationId,
          data: webhookInput,
        },
        auditEventId,
      ),
    ]);
    const answers = {
      title: input.title,
      description: input.description,
      category: input.category,
      format: input.format,
    };
    const manualSchema = {
      introduction: "Entered manually by an administrator.",
      fields: DEFAULT_FORM_SCHEMA.fields
        .filter((field) =>
          ["title", "description", "category", "format"].includes(field.id),
        )
        .map((field) => ({
          ...field,
          required: true,
          condition: null,
          ...(field.id === "category"
            ? { options: [input.category] }
            : field.id === "format"
              ? { options: [input.format] }
              : {}),
        })),
    } satisfies SubmissionFormSchema;
    const snapshot = {
      formVersionId: "manual-administrator-entry",
      versionNumber: 1,
      schema: manualSchema,
      routing: {
        categories: input.routedTeamId
          ? { [input.category]: input.routedTeamId }
          : {},
        teamNames:
          input.routedTeamId && routedTeam
            ? { [input.routedTeamId]: routedTeam.name }
            : {},
        directSessionDurationMinutes: null,
        passwordHash: null,
      },
      answers,
      speakers: input.speakers,
      uploads: {},
    };
    const statements: D1PreparedStatement[] = [
      ...this.adminMutationClaimStatements(command),
    ];
    const submissionInsertIndex = statements.length;
    statements.push(
      this.env.DB.prepare(
        `INSERT INTO submissions (
           id, event_id, form_version_id, submitter_person_id, submitter_email,
           routed_team_id, public_reference, title, category, format, status,
           answers_json, submitted_snapshot_json, revision, last_operation_id,
           submitted_at, created_at, updated_at
         ) SELECT ?, ?, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?,
                  unixepoch(), unixepoch(), unixepoch()
            WHERE EXISTS (
                SELECT 1 FROM events WHERE id = ? AND organisation_id = ?
              )
              AND (
                ? IS NULL OR EXISTS (
                  SELECT 1 FROM evaluation_teams team
                   WHERE team.id = ? AND team.event_id = ? AND team.status = 'active'
                )
              )
              AND (
                ? IS NULL OR (
                  EXISTS (
                    SELECT 1 FROM evaluation_rounds round
                    JOIN evaluation_plans plan
                      ON plan.id = round.plan_id AND plan.event_id = round.event_id
                     WHERE round.id = ? AND round.event_id = ?
                       AND round.status = 'active' AND plan.status = 'active'
                  )
                  AND (
                    SELECT COUNT(*) FROM evaluation_rounds active_round
                    JOIN evaluation_plans active_plan
                      ON active_plan.id = active_round.plan_id
                     AND active_plan.event_id = active_round.event_id
                   WHERE active_round.event_id = ?
                     AND active_round.status = 'active'
                     AND active_plan.status = 'active'
                  ) = 1
                  AND (
                    SELECT COUNT(*) FROM evaluation_team_members member
                     WHERE member.team_id = ? AND member.event_id = ?
                       AND member.removed_at IS NULL
                  ) = ?
                  AND (
                    SELECT COUNT(DISTINCT member.person_id)
                      FROM evaluation_team_members member
                     WHERE member.team_id = ? AND member.event_id = ?
                       AND member.removed_at IS NULL
                       AND EXISTS (
                         SELECT 1 FROM memberships membership
                          WHERE membership.event_id = member.event_id
                            AND membership.person_id = member.person_id
                            AND membership.role IN ('evaluator','committee_chair')
                            AND membership.accepted_at IS NOT NULL
                            AND membership.revoked_at IS NULL
                       )
                  ) = ?
                )
              )
              AND EXISTS (
                SELECT 1 FROM idempotency_records command
                 WHERE command.id = ? AND command.organisation_id = ?
                   AND command.event_id = ? AND command.actor_id = ?
                   AND command.scope = ? AND command.idempotency_key = ?
                   AND command.request_hash = ? AND command.status = 'processing'
              )`,
      ).bind(
        submissionId,
        viewer.eventId,
        input.submitterEmail,
        input.routedTeamId,
        `PC-MANUAL-${submissionId.slice(0, 8).toUpperCase()}`,
        input.title,
        input.category,
        input.format,
        routingAssignment ? "assigned" : "submitted",
        JSON.stringify(answers),
        JSON.stringify(snapshot),
        operationId,
        viewer.eventId,
        viewer.organisationId,
        input.routedTeamId,
        input.routedTeamId,
        viewer.eventId,
        routingAssignment?.roundId ?? null,
        routingAssignment?.roundId ?? null,
        viewer.eventId,
        viewer.eventId,
        routingAssignment?.teamId ?? null,
        viewer.eventId,
        routingAssignment?.evaluatorPersonIds.length ?? 0,
        routingAssignment?.teamId ?? null,
        viewer.eventId,
        routingAssignment?.evaluatorPersonIds.length ?? 0,
        command.recordId,
        command.organisationId,
        command.eventId,
        command.actorId,
        command.scope,
        command.idempotencyKey,
        command.requestHash,
      ),
    );
    statements.push(
      this.env.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, email_verified, profile_status, created_at, updated_at
         ) SELECT ?, ?, ?, 0, 'draft', unixepoch(), unixepoch()
            WHERE EXISTS (
              SELECT 1 FROM submissions
               WHERE id = ? AND event_id = ? AND last_operation_id = ?
            )
         ON CONFLICT(email) DO NOTHING`,
      ).bind(
        crypto.randomUUID(),
        input.submitterEmail,
        input.submitterName,
        submissionId,
        viewer.eventId,
        operationId,
      ),
    );
    for (const speaker of input.speakers) {
      statements.push(
        this.env.DB.prepare(
          `INSERT INTO people (
             id, email, display_name, email_verified, biography, profile_status,
             created_at, updated_at
           ) SELECT ?, ?, ?, 0, ?, 'draft', unixepoch(), unixepoch()
              WHERE EXISTS (
                SELECT 1 FROM submissions
                 WHERE id = ? AND event_id = ? AND last_operation_id = ?
              )
           ON CONFLICT(email) DO NOTHING`,
        ).bind(
          crypto.randomUUID(),
          speaker.email,
          speaker.name,
          speaker.biography || null,
          submissionId,
          viewer.eventId,
          operationId,
        ),
      );
    }
    const submitterLinkedIndex = statements.length;
    statements.push(
      this.env.DB.prepare(
        `UPDATE submissions
            SET submitter_person_id = (
              SELECT person.id FROM people person
               WHERE person.email = ? COLLATE NOCASE
            ), updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND last_operation_id = ?
            AND EXISTS (
              SELECT 1 FROM people person
               WHERE person.email = ? COLLATE NOCASE
            )`,
      ).bind(
        input.submitterEmail,
        submissionId,
        viewer.eventId,
        operationId,
        input.submitterEmail,
      ),
    );
    input.speakers.forEach((speaker, position) => {
      statements.push(
        this.env.DB.prepare(
          `INSERT INTO submission_speakers (
             id, event_id, submission_id, person_id, email, display_name,
             position, invitation_status, is_primary, claimed_at, created_at, updated_at
           ) SELECT ?, ?, ?, person.id, ?, ?, ?, 'claimed', ?, unixepoch(), unixepoch(), unixepoch()
               FROM people person
              WHERE person.email = ? COLLATE NOCASE
                AND EXISTS (
                  SELECT 1 FROM submissions
                   WHERE id = ? AND event_id = ? AND last_operation_id = ?
                )`,
        ).bind(
          crypto.randomUUID(),
          viewer.eventId,
          submissionId,
          speaker.email,
          speaker.name,
          position,
          position === 0 ? 1 : 0,
          speaker.email,
          submissionId,
          viewer.eventId,
          operationId,
        ),
      );
    });
    if (routingAssignment) {
      for (const evaluatorPersonId of routingAssignment.evaluatorPersonIds) {
        statements.push(
          this.env.DB.prepare(
            `INSERT INTO evaluator_assignments (
               id, event_id, round_id, submission_id, evaluator_person_id,
               team_id, status, revision, last_operation_id, assigned_at
             )
             SELECT ?, ?, ?, ?, ?, ?, 'assigned', 1, ?, unixepoch()
              WHERE EXISTS (
                SELECT 1 FROM submissions submission
                 WHERE submission.id = ? AND submission.event_id = ?
                   AND submission.status = 'assigned'
                   AND submission.routed_team_id = ?
                   AND submission.last_operation_id = ?
              )
                AND EXISTS (
                  SELECT 1 FROM evaluation_rounds round
                  JOIN evaluation_plans plan
                    ON plan.id = round.plan_id AND plan.event_id = round.event_id
                 WHERE round.id = ? AND round.event_id = ?
                   AND round.status = 'active' AND plan.status = 'active'
                )
                AND EXISTS (
                  SELECT 1 FROM evaluation_team_members member
                  JOIN evaluation_teams team
                    ON team.id = member.team_id AND team.event_id = member.event_id
                 WHERE member.team_id = ? AND member.event_id = ?
                   AND member.person_id = ? AND member.removed_at IS NULL
                   AND team.status = 'active'
                   AND EXISTS (
                     SELECT 1 FROM memberships membership
                      WHERE membership.event_id = member.event_id
                        AND membership.person_id = member.person_id
                        AND membership.role IN ('evaluator','committee_chair')
                        AND membership.accepted_at IS NOT NULL
                        AND membership.revoked_at IS NULL
                   )
                )
             ON CONFLICT(round_id, submission_id, evaluator_person_id)
               WHERE submission_id IS NOT NULL DO NOTHING`,
          ).bind(
            crypto.randomUUID(),
            viewer.eventId,
            routingAssignment.roundId,
            submissionId,
            evaluatorPersonId,
            routingAssignment.teamId,
            operationId,
            submissionId,
            viewer.eventId,
            routingAssignment.teamId,
            operationId,
            routingAssignment.roundId,
            viewer.eventId,
            routingAssignment.teamId,
            viewer.eventId,
            evaluatorPersonId,
          ),
        );
      }
      statements.push(
        this.env.DB.prepare(
          `INSERT INTO audit_events (
             id, organisation_id, event_id, actor_person_id, action,
             entity_type, entity_id, metadata_json, created_at
           )
           SELECT ?, ?, ?, ?, 'evaluation.assignments.auto_created',
                  'submission', ?, ?, unixepoch()
            WHERE (
              SELECT COUNT(*) FROM evaluator_assignments assignment
               WHERE assignment.event_id = ? AND assignment.round_id = ?
                 AND assignment.submission_id = ? AND assignment.team_id = ?
                 AND assignment.last_operation_id = ?
            ) = ?`,
        ).bind(
          crypto.randomUUID(),
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          submissionId,
          JSON.stringify({
            roundId: routingAssignment.roundId,
            teamId: routingAssignment.teamId,
            evaluatorCount: routingAssignment.evaluatorPersonIds.length,
          }),
          viewer.eventId,
          routingAssignment.roundId,
          submissionId,
          routingAssignment.teamId,
          operationId,
          routingAssignment.evaluatorPersonIds.length,
        ),
      );
    }
    statements.push(
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action, entity_type,
           entity_id, correlation_id, metadata_json, created_at
         ) SELECT ?, ?, ?, ?, 'submission.manual.created', 'submission', ?, ?, ?, unixepoch()
            WHERE EXISTS (
              SELECT 1 FROM submissions
               WHERE id = ? AND event_id = ? AND last_operation_id = ?
            )`,
      ).bind(
        auditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        submissionId,
        operationId,
        JSON.stringify({ routedTeamId: input.routedTeamId }),
        submissionId,
        viewer.eventId,
        operationId,
      ),
      this.env.DB.prepare(
        `UPDATE idempotency_records
            SET status = 'completed', response_status = 200,
                response_json = ?, entity_type = 'submission', entity_id = ?,
                completed_at = unixepoch()
          WHERE id = ? AND organisation_id = ? AND event_id = ?
            AND actor_id = ? AND scope = ? AND idempotency_key = ?
            AND request_hash = ? AND status = 'processing'
            AND EXISTS (
              SELECT 1 FROM submissions
               WHERE id = ? AND event_id = ? AND last_operation_id = ?
            )`,
      ).bind(
        JSON.stringify({ entityId: submissionId }),
        submissionId,
        command.recordId,
        command.organisationId,
        command.eventId,
        command.actorId,
        command.scope,
        command.idempotencyKey,
        command.requestHash,
        submissionId,
        viewer.eventId,
        operationId,
      ),
    );
    statements.push(
      ...preparedWebhooks.flatMap((webhook) => webhook.statements),
    );
    const results = await this.env.DB.batch(statements);
    if (
      (results[submissionInsertIndex]?.meta.changes ?? 0) !== 1 ||
      (results[submitterLinkedIndex]?.meta.changes ?? 0) !== 1
    ) {
      const replay = await this.resolveAdminMutationRace(command);
      if (replay) return replay;
      throw new SubmissionStateError(
        input.routedTeamId
          ? "The evaluation routing configuration changed before the manual application was created. Refresh and try again."
          : "The manual application could not be created in this event.",
      );
    }
    await Promise.all(
      preparedWebhooks.map((webhook) =>
        webhookService.dispatchPreparedEvent(webhook),
      ),
    );
    return submissionId;
  }

  static workspaceToInput(workspace: FormWorkspace): SaveFormInput {
    return {
      id: workspace.id,
      revision: workspace.revision,
      draftRevision: workspace.draftVersion.revision,
      name: workspace.name,
      kind: workspace.kind,
      publicSlug: workspace.publicSlug,
      closeDate: D1SubmissionRepository.closeDateFromEpoch(
        workspace.closesAt,
        workspace.eventTimezone,
      ),
      submissionLimit: workspace.submissionLimit,
      minSpeakers: workspace.minSpeakers,
      maxSpeakers: workspace.maxSpeakers,
      accessMode: workspace.accessMode,
      accessPassword: "",
      schema: workspace.draftVersion.schema,
      routing: { ...workspace.draftVersion.routing, passwordHash: null },
    };
  }
}
