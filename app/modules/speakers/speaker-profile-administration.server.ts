import {
  AirtableProviderBoundary,
  airtableCommandKey,
} from "~/modules/airtable/airtable-provider-boundary.server";
import {
  isPublicSiteDatabaseConstraint,
  PUBLIC_SITE_SPEAKER_PROFILE_CONSTRAINT,
} from "~/modules/public-site/public-site-errors";
import { ApiError } from "~/platform/api/api.server";
import { ApiPersonIdempotencyService } from "~/platform/api/api-person-idempotency.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import { ParticipantProfileConflictError } from "./participant-profile-service.server";
import { SpeakerAdminQueryService } from "./speaker-admin-query-service.server";
import {
  adminProfileExclusiveSql,
  adminProfileIsShared,
  adminSpeakerScopeSql,
} from "./speaker-admin-scope.server";
import {
  adminScopedSpeakerProfileSchema,
  adminSpeakerProfileSchema,
  speakerWorkflowSchema,
} from "./speaker-administration-contracts.server";
import {
  canonicalProfileRevisionStatement,
  organisationProfileRevisionStatement,
} from "./speaker-profile-revision.server";
import type { SpeakerWorkflowStatus } from "./speaker-roster-import.server";
import { SpeakerAdminStateError } from "./speaker-service-errors";

export class SpeakerProfileAdministration {
  private readonly airtable: AirtableProviderBoundary;
  private readonly adminQueries: SpeakerAdminQueryService;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
    this.adminQueries = new SpeakerAdminQueryService(env, this.airtable);
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

  async updateAdminScopedSpeakerProfile(
    viewer: Viewer,
    personId: string,
    rawInput: unknown,
  ) {
    const idempotencyKey = await airtableCommandKey(
      "speaker.admin.scoped_profile.update",
      viewer,
      { personId, ...(rawInput as Record<string, unknown>) },
    );
    return this.airtable.executeIdempotent(
      viewer,
      { idempotencyKey, operation: "speaker.admin.scoped_profile.update" },
      () => this.updateAdminScopedSpeakerProfileD1(viewer, personId, rawInput),
    );
  }

  private async updateAdminScopedSpeakerProfileD1(
    viewer: Viewer,
    rawPersonId: string,
    rawInput: unknown,
  ) {
    const personId = rawPersonId.trim();
    const input = adminScopedSpeakerProfileSchema.parse(rawInput);
    if (!personId || personId.length > 200) {
      throw new Response("Speaker not found in this event.", { status: 404 });
    }
    const inScope = await this.env.DB.prepare(
      `SELECT 1 AS allowed FROM people person
        WHERE person.id = ? AND ${adminSpeakerScopeSql()}`,
    )
      .bind(personId, viewer.eventId, viewer.organisationId)
      .first();
    if (!inScope) {
      throw new Response("Speaker not found in this event.", { status: 404 });
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
        data: { profileScope: "organisation_event" },
      },
      auditEventId,
    );
    try {
      await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT INTO organisation_contacts (
           organisation_id, person_id, source, status, created_by_person_id,
           created_at, updated_at
         )
         SELECT event.organisation_id, person.id, 'manual', 'active', ?,
                unixepoch(), unixepoch()
           FROM events event
           JOIN people person ON person.id = ?
          WHERE event.id = ? AND event.organisation_id = ?
            AND person.profile_revision = ?
            AND ${adminSpeakerScopeSql("person.id")}
         ON CONFLICT(organisation_id, person_id) DO NOTHING`,
        ).bind(
          viewer.personId,
          personId,
          viewer.eventId,
          viewer.organisationId,
          input.profileRevision,
          viewer.eventId,
          viewer.organisationId,
        ),
        this.env.DB.prepare(
          `INSERT INTO organisation_contact_profiles (
           organisation_id, person_id, display_name, biography,
           organisation_name, job_title, source, created_by_person_id,
           updated_by_person_id, last_operation_id, created_at, updated_at
         )
         SELECT ?, person.id, ?, ?, ?, ?, 'manual', ?, ?, ?,
                unixepoch(), unixepoch()
           FROM people person
           JOIN organisation_contacts contact
             ON contact.organisation_id = ? AND contact.person_id = person.id
           LEFT JOIN organisation_contact_profiles current
             ON current.organisation_id = contact.organisation_id
            AND current.person_id = contact.person_id
          WHERE person.id = ? AND person.profile_revision = ?
            AND ${adminSpeakerScopeSql("person.id")}
            AND COALESCE(current.last_operation_id, '') = ?
         ON CONFLICT(organisation_id, person_id) DO UPDATE SET
           display_name = excluded.display_name,
           biography = excluded.biography,
           organisation_name = excluded.organisation_name,
           job_title = excluded.job_title,
           updated_by_person_id = excluded.updated_by_person_id,
           last_operation_id = excluded.last_operation_id,
           updated_at = unixepoch()
         WHERE COALESCE(organisation_contact_profiles.last_operation_id, '') = ?`,
        ).bind(
          viewer.organisationId,
          input.name,
          input.biography || null,
          input.organisationName || null,
          input.jobTitle || null,
          viewer.personId,
          viewer.personId,
          operationId,
          viewer.organisationId,
          personId,
          input.profileRevision,
          viewer.eventId,
          viewer.organisationId,
          input.organisationProfileOperationId,
          input.organisationProfileOperationId,
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
           JOIN organisation_contact_profiles profile
             ON profile.organisation_id = event.organisation_id
            AND profile.person_id = person.id
            AND profile.last_operation_id = ?
           LEFT JOIN event_participant_profiles current
             ON current.event_id = event.id AND current.person_id = person.id
          WHERE event.id = ? AND event.organisation_id = ?
            AND person.profile_revision = ?
            AND COALESCE(current.last_operation_id, '') = ?
         ON CONFLICT(event_id, person_id) DO UPDATE SET
           travel_preferences = excluded.travel_preferences,
           last_operation_id = excluded.last_operation_id,
           updated_at = unixepoch()
         WHERE event_participant_profiles.organisation_id = excluded.organisation_id
           AND COALESCE(event_participant_profiles.last_operation_id, '') = ?`,
        ).bind(
          input.travelPreferences || null,
          operationId,
          personId,
          operationId,
          viewer.eventId,
          viewer.organisationId,
          input.profileRevision,
          input.travelProfileOperationId,
          input.travelProfileOperationId,
        ),
        this.env.DB.prepare(
          `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'speaker.admin.scoped_profile.updated',
                'person', person.id, ?, ?, unixepoch()
           FROM people person
           JOIN organisation_contact_profiles profile
             ON profile.organisation_id = ? AND profile.person_id = person.id
            AND profile.last_operation_id = ?
           JOIN event_participant_profiles event_profile
             ON event_profile.event_id = ?
            AND event_profile.organisation_id = profile.organisation_id
            AND event_profile.person_id = person.id
            AND event_profile.last_operation_id = ?
          WHERE person.id = ? AND person.profile_revision = ?`,
        ).bind(
          auditEventId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          operationId,
          JSON.stringify({ profileScope: "organisation_event" }),
          viewer.organisationId,
          operationId,
          viewer.eventId,
          operationId,
          personId,
          input.profileRevision,
        ),
        organisationProfileRevisionStatement(this.env, {
          organisationId: viewer.organisationId,
          eventId: viewer.eventId,
          personId,
          recordedByPersonId: viewer.personId,
          correlationId: operationId,
        }),
        ...webhook.statements,
        this.env.DB.prepare(
          `INSERT INTO people (id, email, display_name)
         SELECT ?, NULL, 'Scoped speaker profile completion guard'
          WHERE NOT EXISTS (
            SELECT 1 FROM audit_events audit
             WHERE audit.id = ? AND audit.organisation_id = ?
               AND audit.event_id = ? AND audit.actor_person_id = ?
               AND audit.action = 'speaker.admin.scoped_profile.updated'
               AND audit.entity_id = ? AND audit.correlation_id = ?
          )
             OR NOT EXISTS (
               SELECT 1 FROM speaker_profile_revisions revision
                WHERE revision.organisation_id = ? AND revision.event_id = ?
                  AND revision.person_id = ?
                  AND revision.source = 'organisation_profile'
                  AND revision.correlation_id = ?
             )`,
        ).bind(
          `scoped-profile-guard-${operationId}`,
          auditEventId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          personId,
          operationId,
          viewer.organisationId,
          viewer.eventId,
          personId,
          operationId,
        ),
      ]);
    } catch (error) {
      if (
        error instanceof Error &&
        /NOT NULL constraint failed: people\.email/u.test(error.message)
      ) {
        throw new ParticipantProfileConflictError(
          "These organisation or event speaker details changed after the page loaded. Refresh before saving again.",
        );
      }
      throw error;
    }
    const deliveries = await webhookService.dispatchPreparedEvent(webhook);
    return {
      webhookWarning: deliveries.some(
        (delivery) => delivery.status === "queue_failed",
      )
        ? "The profile was saved, but one or more outbound webhooks need a queue retry."
        : null,
    };
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
    const statements = [
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
      canonicalProfileRevisionStatement(this.env, {
        organisationId: viewer.organisationId,
        eventId: viewer.eventId,
        personId,
        recordedByPersonId: viewer.personId,
        correlationId: operationId,
      }),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, correlation_id, metadata_json, created_at
        ) SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'speaker.admin.profile.updated', 'person', ?, ?, ?, unixepoch()
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
      this.env.DB.prepare(
        `INSERT INTO event_changes (
           event_id, entity_type, entity_id, change_type,
           correlation_id, created_at
         )
         SELECT ?, 'person', ?, 'updated', ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM people
             WHERE id = ? AND profile_revision = ? AND last_operation_id = ?
          )
         RETURNING sequence`,
      ).bind(
        viewer.eventId,
        personId,
        operationId,
        personId,
        input.revision + 1,
        operationId,
      ),
      ...webhook.statements,
    ];
    let results: D1Result<unknown>[];
    try {
      results = await this.env.DB.batch(statements);
    } catch (error) {
      if (
        isPublicSiteDatabaseConstraint(
          error,
          PUBLIC_SITE_SPEAKER_PROFILE_CONSTRAINT,
        )
      ) {
        throw new SpeakerAdminStateError(
          "Remove this featured speaker from the published event site before unpublishing their profile.",
        );
      }
      throw error;
    }
    const [updated, eventProfile] = results;
    if ((updated.meta.changes ?? 0) !== 1)
      throw new ParticipantProfileConflictError(
        "This speaker profile changed after the page loaded. Refresh before saving again.",
      );
    if ((eventProfile.meta.changes ?? 0) !== 1) {
      throw new Error(
        "The event-scoped travel preferences were not committed with the speaker profile.",
      );
    }
    if ((results[2]?.meta.changes ?? 0) !== 1) {
      throw new Error("The public profile revision was not recorded.");
    }
    const change = results[4]?.results[0] as { sequence: number } | undefined;
    if (!change) {
      throw new Error(
        "The committed speaker profile change cursor was not recorded.",
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
      changeCursor: Number(change.sequence),
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
                 id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
                 entity_type, entity_id, correlation_id, metadata_json, created_at
               )
               SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'speaker.workflow.updated', 'person', ?, ?,
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
