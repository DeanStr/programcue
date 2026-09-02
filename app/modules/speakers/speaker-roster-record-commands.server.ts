import type { z } from "zod";
import {
  AirtableProviderBoundary,
  airtableIntentCommand,
} from "~/modules/airtable/airtable-provider-boundary.server";
import {
  existingPersonOrganisationRelationshipSql,
  organisationRelationshipBindings,
  unavailableExistingEmails,
} from "~/modules/crm/crm-contact-scope.server";
import { ApiError } from "~/platform/api/api.server";
import { ApiPersonIdempotencyService } from "~/platform/api/api-person-idempotency.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  EvaluatorEmailAliasContextError,
  type EvaluatorEmailRouting,
  resolveEvaluatorEmailAlias,
} from "~/platform/evaluation/evaluator-email-alias.server";
import {
  existingSpeakerProspectSchema,
  manualSpeakerRecordSchema,
  organisationAdministratorViewer,
} from "./speaker-administration-contracts.server";
import type { SpeakerWorkflowStatus } from "./speaker-roster-import.server";
import {
  SpeakerAdminIntegrityError,
  SpeakerAdminStateError,
} from "./speaker-service-errors";

export class SpeakerRosterRecordCommands {
  private readonly airtable: AirtableProviderBoundary;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
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
    if (!event)
      throw new Response("This event could not be found.", { status: 404 });

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
        "This email belongs to a merged speaker directory contact. Use the primary contact instead.",
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
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'speaker.admin.added', 'person', person.id, ?,
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
    let routing: EvaluatorEmailRouting | null = null;
    if (row.routedEmail) {
      if (!row.evaluatorAliasPersonId) {
        throw new SpeakerAdminIntegrityError(
          "The evaluator email routing audit is incomplete.",
        );
      }
      routing = {
        enteredEmail: row.enteredEmail,
        routedEmail: row.routedEmail,
        personId: row.evaluatorAliasPersonId,
      };
    }
    return {
      personId: row.personId,
      email: row.email,
      createdIdentity: Boolean(row.createdIdentity),
      createdRosterAssociation: Boolean(row.createdRosterAssociation),
      routing,
    };
  }

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
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, event.organisation_id, event.id, ?,
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
}
