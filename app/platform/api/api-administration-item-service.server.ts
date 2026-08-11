import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { z } from "zod";
import {
  isAirtableManagedAdminResource,
  type AdminApiResource,
} from "./api-administration-service.server";
import { isoTimestamp } from "./api-pagination.server";
import { ApiError, type ApiPrincipal } from "./api.server";

type EventPrincipal = ApiPrincipal & { eventId: string };
type ApiRecord = Record<string, unknown> & { id: string };

const submissionTracksSchema = z.array(
  z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    position: z.number().int().nonnegative(),
  }),
);

function parseJson(value: unknown, label: string) {
  if (value === null) return null;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} contains invalid persisted JSON.`);
  }
}

function serialise(row: ApiRecord) {
  const result: Record<string, unknown> = { ...row };
  for (const field of [
    "startsAt",
    "endsAt",
    "closesAt",
    "acceptedAt",
    "invitedAt",
    "submittedAt",
    "withdrawnAt",
    "publishedAt",
    "decidedAt",
    "scheduledAt",
    "queuedAt",
    "sentAt",
    "cancelledAt",
    "archivedAt",
    "completedAt",
    "releasedAt",
    "createdAt",
    "updatedAt",
  ]) {
    if (field in result) {
      result[field] = isoTimestamp(result[field] as number | null);
    }
  }
  for (const field of [
    "answersJson",
    "submittedSnapshotJson",
    "schemaJson",
    "routingJson",
    "settingsSnapshotJson",
    "requiredResourcesJson",
    "effectPreviewJson",
    "audienceJson",
    "contentSnapshotJson",
    "documentJson",
  ]) {
    if (field in result) {
      const key = field.slice(0, -4);
      result[key] = parseJson(result[field], `${String(result.id)} ${key}`);
      delete result[field];
    }
  }
  for (const field of [
    "emailVerified",
    "acknowledgementRequired",
    "isPrimary",
  ]) {
    if (field in result) result[field] = Boolean(result[field]);
  }
  if ("tracksJson" in result) {
    const tracks = submissionTracksSchema.parse(
      parseJson(result.tracksJson, `${String(result.id)} tracks`),
    );
    if (result.status !== "draft" && tracks.length === 0) {
      throw new Error(
        `Submission ${String(result.id)} is missing persisted track selections.`,
      );
    }
    result.tracks = tracks;
    delete result.tracksJson;
  }
  return result;
}

export class ApiAdministrationItemService {
  private readonly airtable: AirtableProviderBoundary;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
  }

  async get(
    principal: EventPrincipal,
    resource: AdminApiResource,
    itemId: string,
  ) {
    if (isAirtableManagedAdminResource(resource)) {
      await this.airtable.assertReadable(principal);
    }
    const item = await this.getItem(principal, resource, itemId);
    if (!item) {
      throw new ApiError(404, "ADMIN_ITEM_NOT_FOUND", "Record not found");
    }
    const related = await this.getRelated(principal, resource, itemId);
    return {
      item: serialise(item),
      related: related.records,
      relatedHasMore: related.hasMore,
    };
  }

  private getItem(
    principal: EventPrincipal,
    resource: AdminApiResource,
    itemId: string,
  ): Promise<ApiRecord | null> {
    if (resource === "submissions") {
      return this.env.DB.prepare(
        `SELECT submission.id, submission.public_reference AS publicReference,
                submission.form_version_id AS formVersionId,
                version.form_id AS formId,
                submission.submitter_person_id AS submitterPersonId,
                submission.submitter_email AS submitterEmail,
                submission.title, submission.category, submission.format,
                submission.routed_team_id AS routedTeamId, submission.status,
                COALESCE((
                  SELECT json_group_array(json(selected.track))
                    FROM (
                      SELECT json_object(
                               'id', selection.track_id,
                               'name', selection.track_name_snapshot,
                               'position', selection.position
                             ) AS track
                        FROM submission_track_selections selection
                       WHERE selection.submission_id = submission.id
                         AND selection.event_id = submission.event_id
                       ORDER BY selection.position
                    ) selected
                ), '[]') AS tracksJson,
                submission.answers_json AS answersJson,
                submission.submitted_snapshot_json AS submittedSnapshotJson,
                submission.revision, submission.submitted_at AS submittedAt,
                submission.withdrawn_at AS withdrawnAt,
                submission.created_at AS createdAt,
                submission.updated_at AS updatedAt
           FROM submissions submission
           JOIN events event ON event.id = submission.event_id
             AND event.organisation_id = ?
           LEFT JOIN form_versions version
             ON version.id = submission.form_version_id
            AND version.event_id = submission.event_id
          WHERE submission.id = ? AND submission.event_id = ?`,
      )
        .bind(principal.organisationId, itemId, principal.eventId)
        .first<ApiRecord>();
    }
    if (resource === "forms") {
      return this.env.DB.prepare(
        `SELECT form.id, form.name, form.description, form.kind, form.status,
                form.public_slug AS publicSlug, form.closes_at AS closesAt,
                form.submission_limit AS submissionLimit,
                form.min_speakers AS minSpeakers,
                form.max_speakers AS maxSpeakers,
                form.access_mode AS accessMode, form.revision,
                form.created_at AS createdAt, form.updated_at AS updatedAt
           FROM form_definitions form
           JOIN events event ON event.id = form.event_id
             AND event.organisation_id = ?
          WHERE form.id = ? AND form.event_id = ?`,
      )
        .bind(principal.organisationId, itemId, principal.eventId)
        .first<ApiRecord>();
    }
    if (resource === "people" || resource === "speakers") {
      const relationship =
        resource === "speakers"
          ? `AND (
               EXISTS (SELECT 1 FROM memberships membership
                         WHERE membership.person_id = person.id
                           AND membership.event_id = event.id
                           AND membership.role = 'speaker'
                           AND membership.accepted_at IS NOT NULL
                           AND membership.revoked_at IS NULL)
               OR EXISTS (SELECT 1 FROM session_speakers speaker
                            WHERE speaker.person_id = person.id
                              AND speaker.event_id = event.id)
               OR EXISTS (SELECT 1 FROM submission_speakers speaker
                            WHERE speaker.person_id = person.id
                              AND speaker.event_id = event.id)
             )`
          : `AND EXISTS (
               SELECT 1 FROM memberships membership
                WHERE membership.person_id = person.id
                  AND membership.organisation_id = event.organisation_id
                  AND (membership.event_id = event.id OR (
                    membership.event_id IS NULL
                    AND membership.role IN ('owner','administrator')
                  ))
                  AND membership.revoked_at IS NULL
             )`;
      return this.env.DB.prepare(
        `SELECT person.id, person.display_name AS displayName, person.email,
                person.email_verified AS emailVerified,
                person.image_url AS imageUrl, person.biography,
                person.pronunciation,
                person.organisation_name AS organisationName,
                person.job_title AS jobTitle,
                person.profile_status AS profileStatus,
                person.profile_revision AS profileRevision,
                person.created_at AS createdAt,
                person.updated_at AS updatedAt
           FROM people person
           JOIN events event ON event.id = ? AND event.organisation_id = ?
          WHERE person.id = ? ${relationship}`,
      )
        .bind(principal.eventId, principal.organisationId, itemId)
        .first<ApiRecord>();
    }
    if (resource === "sessions") {
      return this.env.DB.prepare(
        `SELECT session.id, session.source_submission_id AS sourceSubmissionId,
                session.track_id AS trackId, track.name AS trackName,
                session.title, session.slug, session.description,
                session.format, session.duration_minutes AS durationMinutes,
                session.expected_attendance AS expectedAttendance,
                session.required_resources_json AS requiredResourcesJson,
                session.status, session.visibility, session.revision,
                session.created_at AS createdAt,
                session.updated_at AS updatedAt
           FROM sessions session
           JOIN events event ON event.id = session.event_id
             AND event.organisation_id = ?
           LEFT JOIN tracks track ON track.id = session.track_id
             AND track.event_id = session.event_id
          WHERE session.id = ? AND session.event_id = ?`,
      )
        .bind(principal.organisationId, itemId, principal.eventId)
        .first<ApiRecord>();
    }
    if (resource === "schedule-versions") {
      return this.env.DB.prepare(
        `SELECT version.id, version.name,
                version.version_number AS versionNumber,
                version.status, version.revision,
                version.publication_operation_id AS publicationOperationId,
                version.created_by_person_id AS createdByPersonId,
                version.created_at AS createdAt,
                version.published_at AS publishedAt
           FROM schedule_versions version
           JOIN events event ON event.id = version.event_id
             AND event.organisation_id = ?
          WHERE version.id = ? AND version.event_id = ?`,
      )
        .bind(principal.organisationId, itemId, principal.eventId)
        .first<ApiRecord>();
    }
    if (resource === "decisions") {
      return this.env.DB.prepare(
        `SELECT decision.id, decision.submission_id AS submissionId,
                submission.title AS submissionTitle,
                decision.round_id AS roundId, decision.decision,
                decision.rationale, decision.status,
                decision.revision_number AS revisionNumber,
                decision.effect_preview_json AS effectPreviewJson,
                decision.decided_by_person_id AS decidedByPersonId,
                decision.decided_at AS decidedAt,
                decision.published_at AS publishedAt
           FROM submission_decisions decision
           JOIN submissions submission
             ON submission.id = decision.submission_id
            AND submission.event_id = decision.event_id
           JOIN events event ON event.id = decision.event_id
             AND event.organisation_id = ?
          WHERE decision.id = ? AND decision.event_id = ?`,
      )
        .bind(principal.organisationId, itemId, principal.eventId)
        .first<ApiRecord>();
    }
    if (resource === "communications") {
      return this.env.DB.prepare(
        `SELECT communication.id,
                communication.template_version_id AS templateVersionId,
                communication.sender_profile_id AS senderProfileId,
                communication.operation_id AS operationId,
                communication.idempotency_key AS idempotencyKey,
                communication.kind, communication.channel,
                communication.status,
                communication.audience_json AS audienceJson,
                communication.content_snapshot_json AS contentSnapshotJson,
                communication.recipient_count AS recipientCount,
                communication.scheduled_at AS scheduledAt,
                communication.queued_at AS queuedAt,
                communication.sent_at AS sentAt,
                communication.cancelled_at AS cancelledAt,
                communication.created_at AS createdAt,
                communication.updated_at AS updatedAt
           FROM communications communication
           JOIN events event ON event.id = communication.event_id
             AND event.organisation_id = ?
          WHERE communication.id = ? AND communication.event_id = ?`,
      )
        .bind(principal.organisationId, itemId, principal.eventId)
        .first<ApiRecord>();
    }
    return this.env.DB.prepare(
      `SELECT page.id, page.title, page.slug, page.category,
              page.status, page.audience_scope AS audienceScope,
              page.acknowledgement_required AS acknowledgementRequired,
              page.revision, page.archived_at AS archivedAt,
              page.created_at AS createdAt, page.updated_at AS updatedAt
         FROM resource_pages page
         JOIN events event ON event.id = page.event_id
           AND event.organisation_id = ?
        WHERE page.id = ? AND page.event_id = ?`,
    )
      .bind(principal.organisationId, itemId, principal.eventId)
      .first<ApiRecord>();
  }

  private async getRelated(
    principal: EventPrincipal,
    resource: AdminApiResource,
    itemId: string,
  ) {
    let rows: ApiRecord[] = [];
    if (resource === "submissions") {
      rows = (
        await this.env.DB.prepare(
          `SELECT speaker.id, speaker.person_id AS personId, speaker.email,
                  speaker.display_name AS displayName,
                  speaker.position, speaker.invitation_status AS invitationStatus,
                  speaker.is_primary AS isPrimary,
                  speaker.created_at AS createdAt,
                  speaker.updated_at AS updatedAt
             FROM submission_speakers speaker
             JOIN submissions submission
               ON submission.id = speaker.submission_id
              AND submission.event_id = speaker.event_id
             JOIN events event ON event.id = submission.event_id
               AND event.organisation_id = ?
            WHERE speaker.submission_id = ? AND speaker.event_id = ?
            ORDER BY speaker.position, speaker.id
            LIMIT 201`,
        )
          .bind(principal.organisationId, itemId, principal.eventId)
          .all<ApiRecord>()
      ).results;
    } else if (resource === "forms") {
      rows = (
        await this.env.DB.prepare(
          `SELECT version.id, version.version_number AS versionNumber,
                  version.revision, version.schema_json AS schemaJson,
                  version.routing_json AS routingJson,
                  version.settings_snapshot_json AS settingsSnapshotJson,
                  version.status, version.published_at AS publishedAt,
                  version.created_at AS createdAt
             FROM form_versions version
             JOIN form_definitions form
               ON form.id = version.form_id AND form.event_id = version.event_id
             JOIN events event ON event.id = form.event_id
               AND event.organisation_id = ?
            WHERE version.form_id = ? AND version.event_id = ?
            ORDER BY version.version_number DESC
            LIMIT 201`,
        )
          .bind(principal.organisationId, itemId, principal.eventId)
          .all<ApiRecord>()
      ).results;
    } else if (resource === "people" || resource === "speakers") {
      rows = (
        await this.env.DB.prepare(
          `SELECT membership.id, membership.role,
                  membership.accepted_at AS acceptedAt,
                  membership.invited_at AS invitedAt,
                  membership.created_at AS createdAt
             FROM memberships membership
             JOIN events event ON event.organisation_id = membership.organisation_id
            WHERE event.id = ? AND event.organisation_id = ?
              AND membership.person_id = ?
              AND (membership.event_id = event.id OR (
                membership.event_id IS NULL
                AND membership.role IN ('owner','administrator')
              ))
              AND membership.revoked_at IS NULL
            ORDER BY membership.event_id IS NULL, membership.role
            LIMIT 201`,
        )
          .bind(principal.eventId, principal.organisationId, itemId)
          .all<ApiRecord>()
      ).results;
    } else if (resource === "sessions") {
      rows = (
        await this.env.DB.prepare(
          `SELECT person.id, person.display_name AS displayName, person.email,
                  relationship.position, relationship.role_label AS roleLabel,
                  relationship.visibility
             FROM session_speakers relationship
             JOIN sessions session ON session.id = relationship.session_id
               AND session.event_id = relationship.event_id
             JOIN events event ON event.id = session.event_id
               AND event.organisation_id = ?
             JOIN people person ON person.id = relationship.person_id
            WHERE relationship.session_id = ? AND relationship.event_id = ?
            ORDER BY relationship.position
            LIMIT 201`,
        )
          .bind(principal.organisationId, itemId, principal.eventId)
          .all<ApiRecord>()
      ).results;
    } else if (resource === "schedule-versions") {
      rows = (
        await this.env.DB.prepare(
          `SELECT entry.id, entry.session_id AS sessionId,
                  entry.room_id AS roomId, entry.starts_at AS startsAt,
                  entry.ends_at AS endsAt, entry.revision,
                  entry.created_at AS createdAt,
                  entry.updated_at AS updatedAt
             FROM schedule_entries entry
             JOIN schedule_versions version
               ON version.id = entry.schedule_version_id
              AND version.event_id = entry.event_id
             JOIN events event ON event.id = version.event_id
               AND event.organisation_id = ?
            WHERE entry.schedule_version_id = ? AND entry.event_id = ?
            ORDER BY entry.starts_at, entry.id
            LIMIT 201`,
        )
          .bind(principal.organisationId, itemId, principal.eventId)
          .all<ApiRecord>()
      ).results;
    } else if (resource === "communications") {
      rows = (
        await this.env.DB.prepare(
          `SELECT delivery.id, delivery.recipient_address AS recipientAddress,
                  delivery.recipient_name AS recipientName,
                  delivery.provider, delivery.provider_message_id AS providerMessageId,
                  delivery.status, delivery.attempt_count AS attemptCount,
                  delivery.failure_code AS failureCode,
                  delivery.failure_message AS failureMessage,
                  delivery.created_at AS createdAt,
                  delivery.updated_at AS updatedAt
             FROM communication_deliveries delivery
             JOIN communications communication
               ON communication.id = delivery.communication_id
              AND communication.event_id = delivery.event_id
             JOIN events event ON event.id = communication.event_id
               AND event.organisation_id = ?
            WHERE delivery.communication_id = ? AND delivery.event_id = ?
            ORDER BY delivery.created_at, delivery.id
            LIMIT 201`,
        )
          .bind(principal.organisationId, itemId, principal.eventId)
          .all<ApiRecord>()
      ).results;
    } else if (resource === "resources") {
      rows = (
        await this.env.DB.prepare(
          `SELECT version.id, version.version_number AS versionNumber,
                  version.title, version.slug, version.category,
                  version.audience_scope AS audienceScope,
                  version.acknowledgement_required AS acknowledgementRequired,
                  version.document_json AS documentJson, version.status,
                  version.published_at AS publishedAt,
                  version.created_at AS createdAt
             FROM resource_page_versions version
             JOIN resource_pages page
               ON page.id = version.resource_page_id
              AND page.event_id = version.event_id
             JOIN events event ON event.id = page.event_id
               AND event.organisation_id = ?
            WHERE version.resource_page_id = ? AND version.event_id = ?
            ORDER BY version.version_number DESC
            LIMIT 201`,
        )
          .bind(principal.organisationId, itemId, principal.eventId)
          .all<ApiRecord>()
      ).results;
    }
    return {
      records: rows.slice(0, 200).map(serialise),
      hasMore: rows.length > 200,
    };
  }
}
