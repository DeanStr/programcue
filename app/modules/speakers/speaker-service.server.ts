import { z } from "zod";
import { SpeakerAdminQueryService } from "./speaker-admin-query-service.server";
import {
  adminProfileExclusiveSql,
  adminProfileIsShared,
  adminSpeakerScopeSql,
} from "./speaker-admin-scope.server";

import {
  airtableCommandKey,
  airtableIntentCommand,
  AirtableProviderBoundary,
} from "~/modules/airtable/airtable-provider-boundary.server";
import { emailDeliveryIssue } from "~/modules/communications/email-deliverability";
import {
  existingPersonOrganisationRelationshipSql,
  organisationRelationshipBindings,
  unavailableExistingEmails,
} from "~/modules/crm/crm-contact-scope.server";
import { ApiPersonIdempotencyService } from "~/platform/api/api-person-idempotency.server";
import { ApiError } from "~/platform/api/api.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  EvaluatorEmailAliasContextError,
  resolveEvaluatorEmailAlias,
  type EvaluatorEmailRouting,
} from "~/platform/evaluation/evaluator-email-alias.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import {
  dispatchSpeakerInvitationsForCommand,
  prepareSpeakerInvitations,
  SpeakerInvitationDeliveryError,
  type SpeakerInvitationDelivery,
} from "./speaker-invitation.server";
import type { SpeakerWorkflowStatus } from "./speaker-roster-import.server";
import {
  speakerLinkedinUrlSchema,
  speakerTravelPreferencesSchema,
  speakerXHandleSchema,
} from "./speaker-schema";

import { ParticipantProfileConflictError } from "./participant-profile-service.server";
import { SpeakerParticipationService } from "./speaker-participation-service.server";
import {
  SpeakerAdminIntegrityError,
  SpeakerAdminStateError,
} from "./speaker-service-errors";
export { ParticipantProfileConflictError as SpeakerProfileConflictError } from "./participant-profile-service.server";
export {
  SpeakerAdminIntegrityError,
  SpeakerAdminStateError,
} from "./speaker-service-errors";

const adminSpeakerProfileSchema = z.object({
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

const speakerCommandIdempotencyKeySchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9._:-]{8,128}$/, "Refresh before trying again.");

const manualSpeakerRecordSchema = z
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

const existingSpeakerProspectSchema = z
  .object({
    idempotencyKey: speakerCommandIdempotencyKeySchema,
    personId: z.string().trim().min(1).max(200),
  })
  .strict();

const speakerInvitationSchema = z
  .object({
    idempotencyKey: speakerCommandIdempotencyKeySchema,
    personId: z.string().trim().min(1).max(200),
    confirmation: z.literal("send"),
  })
  .strict();

function organisationAdministratorViewer(viewer: Viewer) {
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

const speakerWorkflowSchema = z
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
  portalAccessAccepted: number;
  portalInvitationPending: number;
};

export class SpeakerService {
  private readonly airtable;
  private readonly participation: SpeakerParticipationService;
  private readonly adminQueries: SpeakerAdminQueryService;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
    this.participation = new SpeakerParticipationService(env, this.airtable);
    this.adminQueries = new SpeakerAdminQueryService(env, this.airtable);
  }

  getPortal(viewer: Viewer) {
    return this.participation.getPortal(viewer);
  }

  updateProfile(viewer: Viewer, rawInput: unknown) {
    return this.participation.updateProfile(viewer, rawInput);
  }

  confirmOwnParticipation(viewer: Viewer, rawInput: unknown) {
    return this.participation.confirmOwnParticipation(viewer, rawInput);
  }

  confirmExternalParticipation(
    viewer: Viewer,
    rawPersonId: string,
    rawInput: unknown,
  ) {
    return this.participation.confirmExternalParticipation(
      viewer,
      rawPersonId,
      rawInput,
    );
  }

  async addManualSpeakerRecord(viewer: Viewer, rawInput: unknown) {
    const parsed = manualSpeakerRecordSchema.parse(rawInput);
    let resolution: Awaited<ReturnType<typeof resolveEvaluatorEmailAlias>>;
    try {
      resolution = await resolveEvaluatorEmailAlias(
        this.env,
        viewer,
        parsed.email,
      );
    } catch (error) {
      if (error instanceof EvaluatorEmailAliasContextError) {
        throw new SpeakerAdminStateError(error.message, 422);
      }
      throw error;
    }
    const organisationViewer = organisationAdministratorViewer(viewer);
    if (
      !resolution.routing &&
      (
        await unavailableExistingEmails(this.env, organisationViewer, [
          resolution.email,
        ])
      ).has(resolution.email)
    ) {
      throw new SpeakerAdminStateError(
        "This email belongs to a person outside the current organisation and cannot be linked directly.",
        409,
      );
    }
    const { idempotencyKey, ...profile } = parsed;
    const input = { ...profile, email: resolution.email };
    const command = await airtableIntentCommand(
      "speaker.admin.add",
      viewer,
      idempotencyKey,
      { ...input, evaluatorEmailRouting: resolution.routing },
    );
    return this.airtable.executeIdempotent(viewer, command, async () => {
      try {
        const { result } = await new ApiPersonIdempotencyService(this.env).run({
          viewer,
          scope: "speaker.admin.add",
          idempotencyKey,
          input: { ...input, evaluatorEmailRouting: resolution.routing },
          execute: (commandId) =>
            this.addManualSpeakerRecordD1(
              viewer,
              input,
              resolution.routing,
              commandId,
            ),
          recover: (commandId) =>
            this.recoverManualSpeakerRecord(
              viewer,
              input.email,
              resolution.routing,
              commandId,
            ),
        });
        return result;
      } catch (error) {
        if (error instanceof ApiError) {
          throw new SpeakerAdminStateError(error.message, error.status);
        }
        throw error;
      }
    });
  }

  private async addManualSpeakerRecordD1(
    viewer: Viewer,
    input: Omit<z.infer<typeof manualSpeakerRecordSchema>, "idempotencyKey">,
    routing: EvaluatorEmailRouting | null,
    commandId: string,
  ) {
    const event = await this.env.DB.prepare(
      "SELECT 1 FROM events WHERE id = ? AND organisation_id = ?",
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first();
    if (!event) throw new Response("Event not found.", { status: 404 });

    const mergedContact = await this.env.DB.prepare(
      `SELECT 1
         FROM people person
         JOIN organisation_contacts contact ON contact.person_id = person.id
        WHERE person.email = ? COLLATE NOCASE
          AND contact.organisation_id = ? AND contact.status = 'merged'`,
    )
      .bind(input.email, viewer.organisationId)
      .first();
    if (mergedContact) {
      throw new SpeakerAdminStateError(
        "This email belongs to a merged Speaker Network contact. Use the primary contact instead.",
        409,
      );
    }

    const proposedPersonId = routing?.personId ?? crypto.randomUUID();
    const evaluatorIdentityRequired = routing ? 1 : 0;
    const organisationViewer = organisationAdministratorViewer(viewer);
    const membershipId = crypto.randomUUID();
    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, email_verified, profile_status,
           last_operation_id, created_at, updated_at
         ) VALUES (?, ?, ?, 0, 'draft', ?, unixepoch(), unixepoch())
         ON CONFLICT(email) DO NOTHING`,
      ).bind(proposedPersonId, input.email, input.email, commandId),
      this.env.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role, invited_at,
           invitation_expires_at, accepted_at, revoked_at, last_operation_id,
           created_at
         )
         SELECT ?, ?, ?, person.id, 'speaker', NULL, NULL, NULL, NULL, ?,
                unixepoch()
           FROM people person
          WHERE person.email = ? COLLATE NOCASE
            AND NOT EXISTS (
              SELECT 1 FROM event_speaker_workflows active_workflow
               WHERE active_workflow.event_id = ?
                 AND active_workflow.person_id = person.id
                 AND active_workflow.status IN ('prospect','invited','confirmed')
            )
            AND (
              (? = 1 AND person.id = ?)
              OR
              (? = 0 AND (
                person.id = ? OR ${existingPersonOrganisationRelationshipSql}
              ))
            )
         ON CONFLICT(event_id, person_id, role) WHERE event_id IS NOT NULL
         DO UPDATE SET invited_at = CASE
                         WHEN memberships.revoked_at IS NULL
                         THEN memberships.invited_at ELSE NULL END,
                       invitation_expires_at = CASE
                         WHEN memberships.revoked_at IS NULL
                         THEN memberships.invitation_expires_at ELSE NULL END,
                       accepted_at = CASE
                         WHEN memberships.revoked_at IS NULL
                         THEN memberships.accepted_at ELSE NULL END,
                       revoked_at = NULL,
                       last_operation_id = excluded.last_operation_id
          WHERE memberships.organisation_id = excluded.organisation_id`,
      ).bind(
        membershipId,
        viewer.organisationId,
        viewer.eventId,
        commandId,
        input.email,
        viewer.eventId,
        evaluatorIdentityRequired,
        routing?.personId ?? "",
        evaluatorIdentityRequired,
        proposedPersonId,
        ...organisationRelationshipBindings(organisationViewer),
      ),
      this.env.DB.prepare(
        `INSERT INTO organisation_contacts (
           organisation_id, person_id, source, status, created_by_person_id,
           created_at, updated_at
         )
         SELECT membership.organisation_id, membership.person_id, 'manual',
                'active', ?, unixepoch(), unixepoch()
           FROM memberships membership
           JOIN people person ON person.id = membership.person_id
          WHERE membership.organisation_id = ? AND membership.event_id = ?
            AND membership.role = 'speaker'
            AND membership.revoked_at IS NULL
            AND membership.last_operation_id = ?
            AND person.email = ? COLLATE NOCASE
         ON CONFLICT(organisation_id, person_id) DO UPDATE SET
           updated_at = unixepoch()
         WHERE organisation_contacts.status = 'active'`,
      ).bind(
        viewer.personId,
        viewer.organisationId,
        viewer.eventId,
        commandId,
        input.email,
      ),
      this.env.DB.prepare(
        `INSERT INTO organisation_contact_profiles (
           organisation_id, person_id, display_name, biography,
           organisation_name, job_title, source, created_by_person_id,
           updated_by_person_id, last_operation_id, created_at, updated_at
         )
         SELECT membership.organisation_id, membership.person_id, ?, ?, ?, ?,
                'manual', ?, ?, ?, unixepoch(), unixepoch()
           FROM memberships membership
           JOIN people person ON person.id = membership.person_id
           JOIN organisation_contacts contact
             ON contact.organisation_id = membership.organisation_id
            AND contact.person_id = membership.person_id
            AND contact.status = 'active'
          WHERE membership.organisation_id = ? AND membership.event_id = ?
            AND membership.role = 'speaker'
            AND membership.revoked_at IS NULL
            AND membership.last_operation_id = ?
            AND person.email = ? COLLATE NOCASE
         ON CONFLICT(organisation_id, person_id) DO UPDATE SET
           display_name = excluded.display_name,
           biography = CASE WHEN ? = 1 THEN excluded.biography
                            ELSE organisation_contact_profiles.biography END,
           organisation_name = CASE WHEN ? = 1 THEN excluded.organisation_name
                                    ELSE organisation_contact_profiles.organisation_name END,
           job_title = CASE WHEN ? = 1 THEN excluded.job_title
                            ELSE organisation_contact_profiles.job_title END,
           source = 'manual',
           updated_by_person_id = excluded.updated_by_person_id,
           last_operation_id = excluded.last_operation_id,
           updated_at = unixepoch()`,
      ).bind(
        input.name,
        input.biography || null,
        input.organisationName || null,
        input.jobTitle || null,
        viewer.personId,
        viewer.personId,
        commandId,
        viewer.organisationId,
        viewer.eventId,
        commandId,
        input.email,
        input.biography ? 1 : 0,
        input.organisationName ? 1 : 0,
        input.jobTitle ? 1 : 0,
      ),
      this.env.DB.prepare(
        `INSERT INTO event_speaker_workflows (
           event_id, person_id, status, source, last_operation_id,
           updated_by_person_id, created_at, updated_at
         )
         SELECT membership.event_id, membership.person_id,
                CASE WHEN membership.accepted_at IS NOT NULL
                     THEN 'confirmed' ELSE 'prospect' END,
                'manual', ?, ?, unixepoch(), unixepoch()
           FROM memberships membership
           JOIN people person ON person.id = membership.person_id
          WHERE membership.organisation_id = ? AND membership.event_id = ?
            AND membership.role = 'speaker'
            AND membership.revoked_at IS NULL
            AND membership.last_operation_id = ?
            AND person.email = ? COLLATE NOCASE
         ON CONFLICT(event_id, person_id) DO UPDATE SET
           status = CASE
             WHEN event_speaker_workflows.status IN ('declined','withdrawn')
             THEN excluded.status ELSE event_speaker_workflows.status END,
           source = CASE
             WHEN event_speaker_workflows.status IN ('declined','withdrawn')
             THEN excluded.source ELSE event_speaker_workflows.source END,
           revision = event_speaker_workflows.revision + 1,
           last_operation_id = excluded.last_operation_id,
           updated_by_person_id = excluded.updated_by_person_id,
           updated_at = unixepoch()`,
      ).bind(
        `${commandId}:workflow`,
        viewer.personId,
        viewer.organisationId,
        viewer.eventId,
        commandId,
        input.email,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, ?, 'speaker.admin.added', 'person', person.id, ?,
                json_object(
                  'enteredEmail', ?,
                  'routedEmail', ?,
                  'evaluatorAliasPersonId', ?,
                  'createdIdentity', person.last_operation_id = ?,
                  'createdRosterAssociation', 1
                ), unixepoch()
           FROM people person
           JOIN memberships membership
             ON membership.organisation_id = ?
            AND membership.event_id = ?
            AND membership.person_id = person.id
            AND membership.role = 'speaker'
            AND membership.last_operation_id = ?
          WHERE person.email = ? COLLATE NOCASE
            AND membership.revoked_at IS NULL`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        commandId,
        routing?.enteredEmail ?? input.email,
        routing?.routedEmail ?? null,
        routing?.personId ?? null,
        commandId,
        viewer.organisationId,
        viewer.eventId,
        commandId,
        input.email,
      ),
      // D1 rolls a batch back only when one of its statements fails. Every
      // conditional write above may legally affect zero rows, so finish with
      // a no-write-on-success sentinel that violates people.email NOT NULL
      // unless exactly one coherent command result exists inside this batch.
      this.env.DB.prepare(
        `INSERT INTO people (id, email, display_name)
         SELECT ?, NULL, 'Manual speaker completion guard'
          WHERE (
            SELECT COUNT(*)
              FROM people person
              JOIN memberships membership
                ON membership.organisation_id = ?
               AND membership.event_id = ?
               AND membership.person_id = person.id
               AND membership.role = 'speaker'
               AND membership.revoked_at IS NULL
               AND membership.last_operation_id = ?
              JOIN event_speaker_workflows workflow
                ON workflow.event_id = membership.event_id
               AND workflow.person_id = membership.person_id
               AND workflow.last_operation_id = ?
               AND workflow.updated_by_person_id = ?
              JOIN organisation_contacts contact
                ON contact.organisation_id = membership.organisation_id
               AND contact.person_id = membership.person_id
               AND contact.status = 'active'
              JOIN organisation_contact_profiles contact_profile
                ON contact_profile.organisation_id = membership.organisation_id
               AND contact_profile.person_id = membership.person_id
               AND contact_profile.last_operation_id = ?
              JOIN audit_events audit
                ON audit.organisation_id = membership.organisation_id
               AND audit.event_id = membership.event_id
               AND audit.actor_person_id = ?
               AND audit.action = 'speaker.admin.added'
               AND audit.entity_type = 'person'
               AND audit.entity_id = person.id
               AND audit.correlation_id = ?
             WHERE person.email = ? COLLATE NOCASE
               AND (
                 (? = 1 AND person.id = ?)
                 OR
                 (? = 0 AND (
                   person.id = ? OR ${existingPersonOrganisationRelationshipSql}
                 ))
               )
               AND json_extract(audit.metadata_json, '$.enteredEmail') = ?
               AND json_extract(audit.metadata_json, '$.routedEmail') IS ?
               AND json_extract(audit.metadata_json, '$.evaluatorAliasPersonId') IS ?
               AND json_extract(audit.metadata_json, '$.createdIdentity')
                   IS (person.last_operation_id = ?)
               AND json_extract(audit.metadata_json, '$.createdRosterAssociation') = 1
          ) <> 1
          AND (
            SELECT COUNT(*)
              FROM people person
              JOIN events event
                ON event.id = ? AND event.organisation_id = ?
               AND event.activation_status = 'active'
              JOIN event_speaker_workflows workflow
                ON workflow.event_id = event.id
               AND workflow.person_id = person.id
               AND workflow.status IN ('prospect','invited','confirmed')
             WHERE person.email = ? COLLATE NOCASE
               AND (? = 0 OR person.id = ?)
               AND workflow.last_operation_id <> ?
               AND NOT EXISTS (
                 SELECT 1 FROM memberships command_membership
                  WHERE command_membership.organisation_id = event.organisation_id
                    AND command_membership.event_id = event.id
                    AND command_membership.person_id = person.id
                    AND command_membership.role = 'speaker'
                    AND command_membership.last_operation_id = ?
               )
               AND NOT EXISTS (
                 SELECT 1 FROM audit_events command_audit
                  WHERE command_audit.organisation_id = event.organisation_id
                    AND command_audit.event_id = event.id
                    AND command_audit.actor_person_id = ?
                    AND command_audit.action = 'speaker.admin.added'
                    AND command_audit.entity_type = 'person'
                    AND command_audit.entity_id = person.id
                    AND command_audit.correlation_id = ?
               )
          ) <> 1`,
      ).bind(
        `${commandId}:incomplete`,
        viewer.organisationId,
        viewer.eventId,
        commandId,
        `${commandId}:workflow`,
        viewer.personId,
        commandId,
        viewer.personId,
        commandId,
        input.email,
        evaluatorIdentityRequired,
        routing?.personId ?? "",
        evaluatorIdentityRequired,
        proposedPersonId,
        ...organisationRelationshipBindings(organisationViewer),
        routing?.enteredEmail ?? input.email,
        routing?.routedEmail ?? null,
        routing?.personId ?? null,
        commandId,
        viewer.eventId,
        viewer.organisationId,
        input.email,
        evaluatorIdentityRequired,
        routing?.personId ?? "",
        `${commandId}:workflow`,
        commandId,
        viewer.personId,
        commandId,
      ),
    ]);
    const created = await this.recoverManualSpeakerRecord(
      viewer,
      input.email,
      routing,
      commandId,
    );
    if (!created) {
      throw new Error(
        "The speaker record was not linked to the authorised event.",
      );
    }
    return created;
  }

  private async recoverManualSpeakerRecord(
    viewer: Viewer,
    email: string,
    requestedRouting: EvaluatorEmailRouting | null,
    commandId: string,
  ) {
    const row = await this.env.DB.prepare(
      `SELECT audit.entity_id AS personId, person.email,
              json_extract(audit.metadata_json, '$.createdIdentity') AS createdIdentity,
              json_extract(audit.metadata_json, '$.enteredEmail') AS enteredEmail,
              json_extract(audit.metadata_json, '$.routedEmail') AS routedEmail,
              json_extract(audit.metadata_json, '$.evaluatorAliasPersonId') AS evaluatorAliasPersonId,
              json_extract(audit.metadata_json, '$.createdRosterAssociation') AS createdRosterAssociation
         FROM audit_events audit
         JOIN people person ON person.id = audit.entity_id
        WHERE audit.organisation_id = ? AND audit.event_id = ?
          AND audit.actor_person_id = ?
          AND audit.action = 'speaker.admin.added'
          AND audit.entity_type = 'person'
          AND audit.correlation_id = ?
        LIMIT 1`,
    )
      .bind(viewer.organisationId, viewer.eventId, viewer.personId, commandId)
      .first<{
        personId: string;
        email: string;
        createdIdentity: number;
        enteredEmail: EvaluatorEmailRouting["enteredEmail"];
        routedEmail: string | null;
        evaluatorAliasPersonId: string | null;
        createdRosterAssociation: number;
      }>();
    if (!row) {
      const existing = await this.env.DB.prepare(
        `SELECT person.id AS personId, person.email
           FROM people person
           JOIN event_speaker_workflows workflow
             ON workflow.event_id = ? AND workflow.person_id = person.id
           JOIN events event ON event.id = workflow.event_id
          WHERE event.organisation_id = ?
            AND event.activation_status = 'active'
            AND workflow.status IN ('prospect','invited','confirmed')
            AND person.email = ? COLLATE NOCASE
            AND (? = 0 OR person.id = ?)`,
      )
        .bind(
          viewer.eventId,
          viewer.organisationId,
          email,
          requestedRouting ? 1 : 0,
          requestedRouting?.personId ?? "",
        )
        .first<{ personId: string; email: string }>();
      return existing
        ? {
            ...existing,
            createdIdentity: false,
            createdRosterAssociation: false,
            routing: requestedRouting,
          }
        : null;
    }
    const routing = row.routedEmail
      ? {
          enteredEmail: row.enteredEmail,
          routedEmail: row.routedEmail,
          personId: row.evaluatorAliasPersonId!,
        }
      : null;
    if (routing && !routing.personId) {
      throw new SpeakerAdminIntegrityError(
        "The evaluator email routing audit is incomplete.",
      );
    }
    return {
      personId: row.personId,
      email: row.email,
      createdIdentity: Boolean(row.createdIdentity),
      createdRosterAssociation: Boolean(row.createdRosterAssociation),
      routing,
    };
  }

  /**
   * Adds an existing organisation contact to the event roster without
   * creating portal access or preparing any communication. The Speaker
   * Network uses this same provider-aware command instead of maintaining a
   * second roster mutation path.
   */
  async addExistingSpeakerProspect(viewer: Viewer, rawInput: unknown) {
    organisationAdministratorViewer(viewer);
    const input = existingSpeakerProspectSchema.parse(rawInput);
    const command = await airtableIntentCommand(
      "speaker.admin.prospect.add_existing",
      viewer,
      input.idempotencyKey,
      { personId: input.personId },
    );
    return this.airtable.executeIdempotent(viewer, command, async () => {
      try {
        const { result } = await new ApiPersonIdempotencyService(this.env).run({
          viewer,
          scope: "speaker.admin.prospect.add_existing",
          idempotencyKey: input.idempotencyKey,
          input: { personId: input.personId },
          execute: (commandId) =>
            this.addExistingSpeakerProspectD1(
              viewer,
              input.personId,
              commandId,
            ),
          recover: (commandId) =>
            this.recoverExistingSpeakerProspect(
              viewer,
              input.personId,
              commandId,
            ),
        });
        return result;
      } catch (error) {
        if (error instanceof ApiError) {
          throw new SpeakerAdminStateError(error.message, error.status);
        }
        throw error;
      }
    });
  }

  private async addExistingSpeakerProspectD1(
    viewer: Viewer,
    personId: string,
    commandId: string,
  ) {
    const organisationViewer = organisationAdministratorViewer(viewer);
    const [, audit] = await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO event_speaker_workflows (
           event_id, person_id, status, source, last_operation_id,
           updated_by_person_id, created_at, updated_at
         )
         SELECT event.id, person.id, 'prospect', 'manual', ?, ?,
                unixepoch(), unixepoch()
           FROM people person
           JOIN events event ON event.id = ?
         WHERE person.id = ? AND event.organisation_id = ?
            AND event.activation_status = 'active'
            AND ${existingPersonOrganisationRelationshipSql}
         ON CONFLICT(event_id, person_id) DO NOTHING`,
      ).bind(
        commandId,
        viewer.personId,
        viewer.eventId,
        personId,
        viewer.organisationId,
        ...organisationRelationshipBindings(organisationViewer),
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, event.organisation_id, event.id, ?,
                'speaker.admin.prospect_added', 'person', person.id, ?,
                json_object(
                  'source', 'speaker_network',
                  'workflowStatus', workflow.status,
                  'created', workflow.last_operation_id = ?
                ), unixepoch()
           FROM people person
           JOIN event_speaker_workflows workflow
             ON workflow.event_id = ? AND workflow.person_id = person.id
           JOIN events event
             ON event.id = workflow.event_id AND event.organisation_id = ?
          WHERE person.id = ? AND event.activation_status = 'active'
            AND workflow.status IN ('prospect','invited','confirmed')
            AND ${existingPersonOrganisationRelationshipSql}`,
      ).bind(
        crypto.randomUUID(),
        viewer.personId,
        commandId,
        commandId,
        viewer.eventId,
        viewer.organisationId,
        personId,
        ...organisationRelationshipBindings(organisationViewer),
      ),
    ]);
    if ((audit.meta.changes ?? 0) !== 1) {
      const current = await this.env.DB.prepare(
        `SELECT workflow.status
           FROM event_speaker_workflows workflow
           JOIN events event ON event.id = workflow.event_id
          WHERE workflow.event_id = ? AND workflow.person_id = ?
            AND event.organisation_id = ?
            AND event.activation_status = 'active'`,
      )
        .bind(viewer.eventId, personId, viewer.organisationId)
        .first<{ status: SpeakerWorkflowStatus }>();
      if (current?.status === "declined" || current?.status === "withdrawn") {
        throw new SpeakerAdminStateError(
          `This contact already has a ${current.status} speaker workflow. Change that status explicitly before adding them as a prospect.`,
          409,
        );
      }
      throw new SpeakerAdminStateError(
        "The contact is not available to this organisation or the target event is no longer active.",
        404,
      );
    }
    const result = await this.recoverExistingSpeakerProspect(
      viewer,
      personId,
      commandId,
    );
    if (result) return result;

    throw new SpeakerAdminIntegrityError(
      "The existing speaker prospect was not accompanied by its audit record.",
    );
  }

  private async recoverExistingSpeakerProspect(
    viewer: Viewer,
    personId: string,
    commandId: string,
  ) {
    const row = await this.env.DB.prepare(
      `SELECT audit.event_id AS eventId, audit.entity_id AS personId,
              json_extract(audit.metadata_json, '$.workflowStatus') AS workflowStatus,
              json_extract(audit.metadata_json, '$.created') AS created
         FROM audit_events audit
         JOIN event_speaker_workflows workflow
           ON workflow.event_id = audit.event_id
          AND workflow.person_id = audit.entity_id
        WHERE audit.organisation_id = ? AND audit.event_id = ?
          AND audit.actor_person_id = ?
          AND audit.action = 'speaker.admin.prospect_added'
          AND audit.entity_type = 'person' AND audit.entity_id = ?
          AND audit.correlation_id = ?
          AND workflow.status IN ('prospect','invited','confirmed')
        LIMIT 1`,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        personId,
        commandId,
      )
      .first<{
        eventId: string;
        personId: string;
        workflowStatus: SpeakerWorkflowStatus;
        created: number;
      }>();
    return row ? { ...row, created: Boolean(row.created) } : null;
  }

  async inviteSpeakerRecord(viewer: Viewer, rawInput: unknown) {
    organisationAdministratorViewer(viewer);
    const input = speakerInvitationSchema.parse(rawInput);
    const speaker = await this.env.DB.prepare(
      `SELECT person.email,
              EXISTS (
                SELECT 1 FROM memberships membership
                 WHERE membership.organisation_id = event.organisation_id
                   AND membership.event_id = event.id
                   AND membership.person_id = person.id
                   AND membership.role = 'speaker'
                   AND membership.accepted_at IS NOT NULL
                   AND membership.revoked_at IS NULL
              ) AS portalAccessAccepted
         FROM people person
         JOIN event_speaker_workflows workflow
           ON workflow.person_id = person.id AND workflow.event_id = ?
         JOIN events event ON event.id = workflow.event_id
        WHERE person.id = ? AND event.organisation_id = ?
          AND event.activation_status = 'active'
          AND workflow.status IN ('prospect','invited','confirmed')`,
    )
      .bind(viewer.eventId, input.personId, viewer.organisationId)
      .first<{ email: string; portalAccessAccepted: number }>();
    if (!speaker) {
      throw new SpeakerAdminStateError(
        "Only an active speaker record in this event can be invited.",
        404,
      );
    }
    const deliveryIssue = emailDeliveryIssue(speaker.email, this.env.APP_ENV);
    if (!speaker.portalAccessAccepted && deliveryIssue) {
      throw new SpeakerAdminStateError(
        `The speaker invitation email address is not deliverable: ${deliveryIssue.toLowerCase()}.`,
        422,
      );
    }
    const command = await airtableIntentCommand(
      "speaker.admin.invite",
      viewer,
      input.idempotencyKey,
      { personId: input.personId },
    );
    const result = await this.airtable.executeIdempotent(
      viewer,
      command,
      async () => {
        try {
          const { result } = await new ApiPersonIdempotencyService(
            this.env,
          ).run({
            viewer,
            scope: "speaker.admin.invite",
            idempotencyKey: input.idempotencyKey,
            input: { personId: input.personId },
            execute: (commandId) =>
              this.inviteSpeakerRecordD1(viewer, input.personId, commandId),
            recover: (commandId) =>
              this.recoverSpeakerInvitation(viewer, input.personId, commandId),
          });
          return result;
        } catch (error) {
          if (error instanceof ApiError) {
            throw new SpeakerAdminStateError(error.message, error.status);
          }
          throw error;
        }
      },
    );
    const invitationOutcomes = await dispatchSpeakerInvitationsForCommand({
      env: this.env,
      organisationId: viewer.organisationId,
      eventId: viewer.eventId,
      commandId: result.commandId,
    });
    const invitationOutcome = invitationOutcomes[0];
    const accepted =
      result.accepted || invitationOutcome?.status === "not_required";
    const delivery: SpeakerInvitationDelivery = accepted
      ? "not_required"
      : (invitationOutcome?.status ?? "not_required");
    if (!accepted && delivery === "not_required") {
      throw new Error(
        "The pending speaker invitation is missing its delivery outcome.",
      );
    }
    if (["queue_failed", "failed", "cancelled"].includes(delivery)) {
      throw new SpeakerInvitationDeliveryError(result.membershipId);
    }
    const { commandId: _commandId, ...publicResult } = result;
    return { ...publicResult, accepted, delivery };
  }

  private async inviteSpeakerRecordD1(
    viewer: Viewer,
    personId: string,
    commandId: string,
  ) {
    const speaker = await this.env.DB.prepare(
      `SELECT person.email
         FROM people person
         JOIN event_speaker_workflows workflow
           ON workflow.person_id = person.id AND workflow.event_id = ?
         JOIN events event ON event.id = workflow.event_id
        WHERE person.id = ? AND event.organisation_id = ?
          AND event.activation_status = 'active'
          AND workflow.status IN ('prospect','invited','confirmed')`,
    )
      .bind(viewer.eventId, personId, viewer.organisationId)
      .first<{ email: string }>();
    if (!speaker) {
      throw new SpeakerAdminStateError(
        "Only an active speaker record in this event can be invited.",
        404,
      );
    }

    const membershipId = crypto.randomUUID();
    const invitationPlans = await prepareSpeakerInvitations({
      env: this.env,
      actor: {
        organisationId: viewer.organisationId,
        eventId: viewer.eventId,
        personId: viewer.personId,
      },
      commandId,
      source: "speaker_network",
      emails: [speaker.email],
    });
    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role,
           invited_at, invitation_expires_at, accepted_at, revoked_at,
           last_operation_id, created_at
         )
         SELECT ?, event.organisation_id, event.id, person.id, 'speaker',
                unixepoch(), unixepoch() + 604800, NULL, NULL, ?, unixepoch()
           FROM people person
           JOIN event_speaker_workflows workflow
             ON workflow.event_id = ? AND workflow.person_id = person.id
           JOIN events event ON event.id = workflow.event_id
          WHERE person.id = ? AND event.organisation_id = ?
            AND event.activation_status = 'active'
            AND workflow.status IN ('prospect','invited','confirmed')
         ON CONFLICT(event_id, person_id, role) WHERE event_id IS NOT NULL
         DO UPDATE SET
           invited_at = CASE
             WHEN memberships.accepted_at IS NOT NULL
              AND memberships.revoked_at IS NULL
             THEN memberships.invited_at ELSE unixepoch() END,
           invitation_expires_at = CASE
             WHEN memberships.accepted_at IS NOT NULL
              AND memberships.revoked_at IS NULL
             THEN memberships.invitation_expires_at
             ELSE unixepoch() + 604800 END,
           accepted_at = CASE
             WHEN memberships.accepted_at IS NOT NULL
              AND memberships.revoked_at IS NULL
             THEN memberships.accepted_at ELSE NULL END,
           revoked_at = NULL,
           last_operation_id = excluded.last_operation_id
         WHERE memberships.organisation_id = excluded.organisation_id`,
      ).bind(
        membershipId,
        commandId,
        viewer.eventId,
        personId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `UPDATE event_speaker_workflows
            SET status = CASE WHEN status = 'confirmed'
                              THEN status ELSE 'invited' END,
                source = CASE WHEN status = 'confirmed'
                              THEN source ELSE 'manual' END,
                revision = revision + 1,
                last_operation_id = ?,
                updated_by_person_id = ?,
                updated_at = unixepoch()
          WHERE event_id = ? AND person_id = ?
            AND status IN ('prospect','invited','confirmed')
            AND EXISTS (
              SELECT 1 FROM memberships membership
               WHERE membership.organisation_id = ?
                 AND membership.event_id = event_speaker_workflows.event_id
                 AND membership.person_id = event_speaker_workflows.person_id
                 AND membership.role = 'speaker'
                 AND membership.accepted_at IS NULL
                 AND membership.revoked_at IS NULL
                 AND membership.last_operation_id = ?
            )`,
      ).bind(
        `${commandId}:workflow`,
        viewer.personId,
        viewer.eventId,
        personId,
        viewer.organisationId,
        commandId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, event.organisation_id, event.id, ?,
                CASE WHEN membership.accepted_at IS NULL
                     THEN 'speaker.admin.invited'
                     ELSE 'speaker.admin.reused' END,
                'person', person.id, ?,
                json_object('source', 'speaker_roster'), unixepoch()
           FROM people person
           JOIN event_speaker_workflows workflow
             ON workflow.event_id = ? AND workflow.person_id = person.id
           JOIN events event ON event.id = workflow.event_id
           JOIN memberships membership
             ON membership.organisation_id = event.organisation_id
            AND membership.event_id = event.id
            AND membership.person_id = person.id
            AND membership.role = 'speaker'
            AND membership.last_operation_id = ?
          WHERE person.id = ? AND event.organisation_id = ?
            AND event.activation_status = 'active'
            AND membership.revoked_at IS NULL
            AND workflow.status IN ('prospect','invited','confirmed')
            AND (
              membership.accepted_at IS NOT NULL
              OR (
                workflow.last_operation_id = ?
                AND workflow.updated_by_person_id = ?
              )
            )`,
      ).bind(
        crypto.randomUUID(),
        viewer.personId,
        commandId,
        viewer.eventId,
        commandId,
        personId,
        viewer.organisationId,
        `${commandId}:workflow`,
        viewer.personId,
      ),
      ...invitationPlans.flatMap((plan) => plan.statements),
    ]);
    const invitation = await this.recoverSpeakerInvitation(
      viewer,
      personId,
      commandId,
    );
    if (!invitation) {
      throw new SpeakerAdminStateError(
        "The speaker record changed before its invitation could be saved. Refresh before trying again.",
        409,
      );
    }
    return invitation;
  }

  private async recoverSpeakerInvitation(
    viewer: Viewer,
    personId: string,
    commandId: string,
  ) {
    const row = await this.env.DB.prepare(
      `SELECT audit.entity_id AS personId, person.email,
              membership.id AS membershipId,
              membership.accepted_at IS NOT NULL AS accepted,
              membership.invitation_expires_at AS invitationExpiresAt
         FROM audit_events audit
         JOIN people person ON person.id = audit.entity_id
         JOIN memberships membership
           ON membership.person_id = audit.entity_id
          AND membership.organisation_id = audit.organisation_id
          AND membership.event_id = audit.event_id
          AND membership.role = 'speaker'
          AND membership.revoked_at IS NULL
         JOIN event_speaker_workflows workflow
           ON workflow.event_id = audit.event_id
          AND workflow.person_id = audit.entity_id
        WHERE audit.organisation_id = ? AND audit.event_id = ?
          AND audit.actor_person_id = ?
          AND audit.action IN ('speaker.admin.invited','speaker.admin.reused')
          AND audit.entity_type = 'person' AND audit.entity_id = ?
          AND audit.correlation_id = ?
          AND workflow.status IN ('prospect','invited','confirmed')
        LIMIT 1`,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        personId,
        commandId,
      )
      .first<{
        personId: string;
        email: string;
        membershipId: string;
        accepted: number;
        invitationExpiresAt: number | null;
      }>();
    return row
      ? {
          ...row,
          commandId,
          accepted: Boolean(row.accepted),
        }
      : null;
  }

  async updateAdminSpeakerProfile(
    viewer: Viewer,
    personId: string,
    rawInput: unknown,
  ) {
    const idempotencyKey = await airtableCommandKey(
      "speaker.admin.profile.update",
      viewer,
      { personId, ...(rawInput as Record<string, unknown>) },
    );
    return this.airtable.executeIdempotent(
      viewer,
      { idempotencyKey, operation: "speaker.admin.profile.update" },
      () => this.updateAdminSpeakerProfileD1(viewer, personId, rawInput),
    );
  }

  private async updateAdminSpeakerProfileD1(
    viewer: Viewer,
    rawPersonId: string,
    rawInput: unknown,
  ) {
    const personId = rawPersonId.trim();
    const input = adminSpeakerProfileSchema.parse(rawInput);
    const inScope = personId
      ? await this.env.DB.prepare(
          `SELECT 1 AS allowed FROM people person
            WHERE person.id = ? AND ${adminSpeakerScopeSql()}`,
        )
          .bind(personId, viewer.eventId, viewer.organisationId)
          .first()
      : null;
    if (!inScope)
      throw new Response("Speaker not found in this event.", { status: 404 });
    if (await adminProfileIsShared(this.env, viewer, personId)) {
      throw new SpeakerAdminStateError(
        "This person is linked to another event or an organisation-wide role. Ask them to update their shared profile from their own speaker workspace.",
      );
    }
    const operationId = crypto.randomUUID();
    const auditEventId = crypto.randomUUID();
    const webhookService = new WebhookService(this.env);
    const webhook = await webhookService.prepareEventForAudit(
      viewer,
      {
        eventType: "speaker.updated",
        entityType: "speaker",
        entityId: personId,
        idempotencyKey: `speaker.updated:${personId}:${operationId}`,
        correlationId: operationId,
        data: {
          revision: input.revision + 1,
          status: input.profileStatus,
        },
      },
      auditEventId,
    );
    const [updated, eventProfile] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE people
           SET display_name = ?, biography = ?, pronunciation = ?,
               organisation_name = ?, job_title = ?, linkedin_url = ?,
               x_handle = ?, profile_status = ?,
               profile_revision = profile_revision + 1,
               last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND profile_revision = ?
           AND ${adminSpeakerScopeSql("people.id")}
           AND ${adminProfileExclusiveSql("people.id")}
      `,
      ).bind(
        input.name,
        input.biography || null,
        input.pronunciation || null,
        input.organisationName || null,
        input.jobTitle || null,
        input.linkedinUrl || null,
        input.xHandle || null,
        input.profileStatus,
        operationId,
        personId,
        input.revision,
        viewer.eventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO event_participant_profiles (
           event_id, organisation_id, person_id, travel_preferences,
           last_operation_id, created_at, updated_at
         )
         SELECT event.id, event.organisation_id, person.id, ?, ?,
                unixepoch(), unixepoch()
           FROM events event
           JOIN people person ON person.id = ?
          WHERE event.id = ? AND event.organisation_id = ?
            AND person.profile_revision = ? AND person.last_operation_id = ?
         ON CONFLICT(event_id, person_id) DO UPDATE SET
           travel_preferences = excluded.travel_preferences,
           last_operation_id = excluded.last_operation_id,
           updated_at = unixepoch()
         WHERE event_participant_profiles.organisation_id = excluded.organisation_id`,
      ).bind(
        input.travelPreferences || null,
        operationId,
        personId,
        viewer.eventId,
        viewer.organisationId,
        input.revision + 1,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, correlation_id, metadata_json, created_at
        ) SELECT ?, ?, ?, ?, 'speaker.admin.profile.updated', 'person', ?, ?, ?, unixepoch()
           WHERE EXISTS (
             SELECT 1 FROM people
              WHERE id = ? AND profile_revision = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        auditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        personId,
        operationId,
        JSON.stringify({
          profileStatus: input.profileStatus,
          revision: input.revision + 1,
        }),
        personId,
        input.revision + 1,
        operationId,
      ),
      ...webhook.statements,
    ]);
    if ((updated.meta.changes ?? 0) !== 1)
      throw new ParticipantProfileConflictError(
        "This speaker profile changed after the page loaded. Refresh before saving again.",
      );
    if ((eventProfile.meta.changes ?? 0) !== 1) {
      throw new Error(
        "The event-scoped travel preferences were not committed with the speaker profile.",
      );
    }
    const deliveries = await webhookService.dispatchPreparedEvent(webhook);
    return {
      revision: input.revision + 1,
      profileStatus: input.profileStatus,
      webhookWarning: deliveries.some(
        (delivery) => delivery.status === "queue_failed",
      )
        ? "The profile was saved, but one or more outbound webhooks need a queue retry."
        : null,
    };
  }

  async updateSpeakerWorkflowStatus(
    viewer: Viewer,
    rawPersonId: string,
    rawInput: unknown,
  ) {
    if (viewer.role !== "owner" && viewer.role !== "administrator") {
      throw new Response("Event administrator access is required.", {
        status: 403,
      });
    }
    const personId = rawPersonId.trim();
    if (!personId || personId.length > 200) {
      throw new Response("Speaker not found in this event.", { status: 404 });
    }
    const input = speakerWorkflowSchema.parse(rawInput);
    try {
      const { result } = await new ApiPersonIdempotencyService(this.env).run({
        viewer,
        scope: "speaker.workflow.update",
        idempotencyKey: input.idempotencyKey,
        input: { personId, status: input.status },
        execute: async (commandId) => {
          await this.env.DB.batch([
            this.env.DB.prepare(
              `INSERT INTO event_speaker_workflows (
                 event_id, person_id, status, source, last_operation_id,
                 updated_by_person_id, created_at, updated_at
               )
               SELECT ?, person.id, ?, 'manual', ?, ?, unixepoch(), unixepoch()
                 FROM people person
                WHERE person.id = ? AND ${adminSpeakerScopeSql()}
               ON CONFLICT(event_id, person_id) DO UPDATE SET
                 status = excluded.status,
                 source = excluded.source,
                 revision = event_speaker_workflows.revision + 1,
                 last_operation_id = excluded.last_operation_id,
                 updated_by_person_id = excluded.updated_by_person_id,
                 updated_at = unixepoch()`,
            ).bind(
              viewer.eventId,
              input.status,
              commandId,
              viewer.personId,
              personId,
              viewer.eventId,
              viewer.organisationId,
            ),
            this.env.DB.prepare(
              `INSERT INTO audit_events (
                 id, organisation_id, event_id, actor_person_id, action,
                 entity_type, entity_id, correlation_id, metadata_json, created_at
               )
               SELECT ?, ?, ?, ?, 'speaker.workflow.updated', 'person', ?, ?,
                      json_object('status', ?), unixepoch()
                 FROM event_speaker_workflows workflow
                WHERE workflow.event_id = ? AND workflow.person_id = ?
                  AND workflow.last_operation_id = ?`,
            ).bind(
              crypto.randomUUID(),
              viewer.organisationId,
              viewer.eventId,
              viewer.personId,
              personId,
              commandId,
              input.status,
              viewer.eventId,
              personId,
              commandId,
            ),
          ]);
          const recovered = await this.recoverSpeakerWorkflow(
            viewer,
            commandId,
          );
          if (!recovered) {
            throw new Response("Speaker not found in this event.", {
              status: 404,
            });
          }
          return recovered;
        },
        recover: (commandId) => this.recoverSpeakerWorkflow(viewer, commandId),
      });
      return result;
    } catch (error) {
      if (error instanceof ApiError) {
        throw new SpeakerAdminStateError(error.message, error.status);
      }
      throw error;
    }
  }

  private async recoverSpeakerWorkflow(viewer: Viewer, commandId: string) {
    return this.env.DB.prepare(
      `SELECT audit.entity_id AS personId,
              json_extract(audit.metadata_json, '$.status') AS status
         FROM audit_events audit
        WHERE audit.organisation_id = ? AND audit.event_id = ?
          AND audit.actor_person_id = ?
          AND audit.action = 'speaker.workflow.updated'
          AND audit.correlation_id = ?
        LIMIT 1`,
    )
      .bind(viewer.organisationId, viewer.eventId, viewer.personId, commandId)
      .first<{ personId: string; status: SpeakerWorkflowStatus }>();
  }

  getAdminSpeakerDetail(
    ...args: Parameters<SpeakerAdminQueryService["getAdminSpeakerDetail"]>
  ) {
    return this.adminQueries.getAdminSpeakerDetail(...args);
  }

  listAdminSpeakerPage(
    ...args: Parameters<SpeakerAdminQueryService["listAdminSpeakerPage"]>
  ) {
    return this.adminQueries.listAdminSpeakerPage(...args);
  }
}
