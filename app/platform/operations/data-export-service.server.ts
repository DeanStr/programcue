import { z } from "zod";

import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { participantTaskAccessForPersonRowSql } from "~/modules/tasks/task-service-foundation.server";
import type { Viewer } from "~/platform/auth/authorize.server";

export const eventExportResources = [
  "people",
  "submissions",
  "sessions",
  "rooms",
  "tracks",
  "tasks",
  "participant-readiness",
  "session-staffing",
  "audit",
] as const;

const eventExportResourceSchema = z.enum(eventExportResources);
export type EventExportResource = z.infer<typeof eventExportResourceSchema>;
const exportIntentSchema = z.uuid();

type ExportValue = string | number | null;

const EXPORT_LIMIT = 10_000;

const submissionTracksSchema = z.array(
  z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    position: z.number().int().nonnegative(),
  }),
);

function iso(epoch: number | null) {
  return epoch === null ? null : new Date(epoch * 1_000).toISOString();
}

function safeSpreadsheetValue(value: ExportValue) {
  const text = value === null ? "" : String(value);
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Leading ASCII controls must not bypass spreadsheet-formula neutralization.
  return /^[\u0000-\u0020]*[=+\-@]/u.test(text) ? `'${text}` : text;
}

function csvCell(value: ExportValue) {
  const text = safeSpreadsheetValue(value);
  return /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function renderCsv(
  columns: string[],
  rows: Array<Record<string, ExportValue>>,
) {
  return `${[
    columns.map(csvCell).join(","),
    ...rows.map((row) =>
      columns.map((column) => csvCell(row[column] ?? null)).join(","),
    ),
  ].join("\r\n")}\r\n`;
}

export class EventExportTooLargeError extends Error {
  constructor(resource: string) {
    super(
      `The ${resource} export exceeds ${EXPORT_LIMIT.toLocaleString()} records. Narrow the event data before exporting.`,
    );
    this.name = "EventExportTooLargeError";
  }
}

export class DataExportIdempotencyConflictError extends Error {
  constructor() {
    super(
      "That export intent already captured a different resource or data snapshot. Start a new export.",
    );
    this.name = "DataExportIdempotencyConflictError";
  }
}

async function exportSnapshotHash(csv: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(csv),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export class DataExportService {
  private readonly airtable: AirtableProviderBoundary;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
  }

  private async assertOrganisationOwner(viewer: Viewer) {
    const owner = await this.env.DB.prepare(
      `SELECT 1
         FROM memberships membership
         JOIN events event
           ON event.id = ? AND event.organisation_id = membership.organisation_id
        WHERE membership.organisation_id = ?
          AND membership.person_id = ? AND membership.event_id IS NULL
          AND membership.role = 'owner'
          AND membership.accepted_at IS NOT NULL
          AND membership.revoked_at IS NULL
        LIMIT 1`,
    )
      .bind(viewer.eventId, viewer.organisationId, viewer.personId)
      .first();
    if (!owner) {
      throw new Response(
        "Organisation owner access is required to export event data.",
        { status: 403 },
      );
    }
  }

  private async existingExport(
    viewer: Viewer,
    idempotencyKey: string,
    resource: EventExportResource,
  ) {
    const existing = await this.env.DB.prepare(
      `SELECT id, payload_json AS payloadJson, result_json AS resultJson
         FROM operation_jobs
        WHERE event_id = ? AND organisation_id = ?
          AND requested_by_person_id = ? AND type = 'data.export'
          AND idempotency_key = ?
        LIMIT 1`,
    )
      .bind(
        viewer.eventId,
        viewer.organisationId,
        viewer.personId,
        idempotencyKey,
      )
      .first<{ id: string; payloadJson: string; resultJson: string }>();
    if (!existing) return null;
    const payload = z
      .object({
        type: z.literal("data.export"),
        operationId: z.string().min(1),
        resource: eventExportResourceSchema,
      })
      .strict()
      .parse(JSON.parse(existing.payloadJson));
    if (payload.operationId !== existing.id) {
      throw new Error("The durable export operation identity is invalid.");
    }
    if (payload.resource !== resource) {
      throw new DataExportIdempotencyConflictError();
    }
    const result = z
      .object({
        resource: eventExportResourceSchema,
        rowCount: z.number().int().nonnegative(),
        contentType: z.literal("text/csv"),
        csvSha256: z.string().regex(/^[a-f0-9]{64}$/u),
      })
      .strict()
      .parse(JSON.parse(existing.resultJson));
    if (result.resource !== payload.resource) {
      throw new Error("The durable export result resource is invalid.");
    }
    return {
      operationId: existing.id,
      rowCount: result.rowCount,
      csvSha256: result.csvSha256,
    };
  }

  async export(viewer: Viewer, rawResource: unknown, rawIntentKey: unknown) {
    await this.assertOrganisationOwner(viewer);
    await this.airtable.assertReadable(viewer);
    const resource = eventExportResourceSchema.parse(rawResource);
    const intentKey = exportIntentSchema.parse(rawIntentKey);
    const idempotencyKey = `data-export:${viewer.personId}:${intentKey}`;
    const existingOperationId = await this.existingExport(
      viewer,
      idempotencyKey,
      resource,
    );
    const rows = await this.rows(viewer, resource);
    if (rows.length > EXPORT_LIMIT)
      throw new EventExportTooLargeError(resource);
    const columns = rows.length
      ? Object.keys(rows[0])
      : this.emptyColumns(resource);
    const csv = renderCsv(columns, rows);
    const csvSha256 = await exportSnapshotHash(csv);
    if (existingOperationId) {
      if (
        existingOperationId.rowCount !== rows.length ||
        existingOperationId.csvSha256 !== csvSha256
      ) {
        throw new DataExportIdempotencyConflictError();
      }
      return {
        csv,
        resource,
        rowCount: rows.length,
        operationId: existingOperationId.operationId,
      };
    }
    const operationId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const result = JSON.stringify({
      resource,
      rowCount: rows.length,
      contentType: "text/csv",
      csvSha256,
    });
    const [created] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        INSERT OR IGNORE INTO operation_jobs (
          id, organisation_id, event_id, requested_by_person_id, type,
          idempotency_key, correlation_id, status, payload_json, result_json,
          progress_total, progress_completed, progress_failed, cancellable,
          started_at, completed_at, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, 'data.export', ?, ?, 'completed', ?, ?, ?, ?, 0,
               0, unixepoch(), unixepoch(), unixepoch(), unixepoch()
          FROM events e WHERE e.id = ? AND e.organisation_id = ?
      `,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        idempotencyKey,
        correlationId,
        JSON.stringify({ type: "data.export", operationId, resource }),
        result,
        rows.length,
        rows.length,
        viewer.eventId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, correlation_id, metadata_json, created_at
        ) SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'data.exported', 'operation', ?, ?, ?, unixepoch()
           WHERE EXISTS (SELECT 1 FROM operation_jobs WHERE id = ?)
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        operationId,
        correlationId,
        result,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO event_changes (
          event_id, entity_type, entity_id, change_type, correlation_id, created_at
        ) SELECT ?, 'operation', ?, 'created', ?, unixepoch()
           WHERE EXISTS (SELECT 1 FROM operation_jobs WHERE id = ?)
      `,
      ).bind(viewer.eventId, operationId, correlationId, operationId),
    ]);
    if ((created.meta.changes ?? 0) === 1) {
      return { csv, resource, rowCount: rows.length, operationId };
    }
    const concurrentOperation = await this.existingExport(
      viewer,
      idempotencyKey,
      resource,
    );
    if (!concurrentOperation) {
      throw new Error("The export could not be recorded in this event.");
    }
    if (
      concurrentOperation.rowCount !== rows.length ||
      concurrentOperation.csvSha256 !== csvSha256
    ) {
      throw new DataExportIdempotencyConflictError();
    }
    return {
      csv,
      resource,
      rowCount: rows.length,
      operationId: concurrentOperation.operationId,
    };
  }

  private emptyColumns(resource: EventExportResource) {
    const columns: Record<EventExportResource, string[]> = {
      people: [
        "id",
        "email",
        "name",
        "organisation",
        "jobTitle",
        "profileStatus",
        "createdAt",
        "updatedAt",
      ],
      submissions: [
        "id",
        "publicReference",
        "title",
        "tracks",
        "format",
        "status",
        "submitterEmail",
        "submittedAt",
        "createdAt",
        "updatedAt",
      ],
      sessions: [
        "id",
        "title",
        "slug",
        "track",
        "format",
        "durationMinutes",
        "status",
        "visibility",
        "createdAt",
        "updatedAt",
      ],
      rooms: ["id", "name", "capacity", "position", "status"],
      tracks: [
        "id",
        "name",
        "slug",
        "colour",
        "position",
        "exclusive",
        "public",
      ],
      tasks: [
        "id",
        "title",
        "targetType",
        "targetId",
        "ownerEmail",
        "status",
        "readinessState",
        "readinessPercent",
        "impact",
        "dueAt",
        "completedAt",
        "updatedAt",
      ],
      "participant-readiness": [
        "personId",
        "email",
        "name",
        "organisation",
        "jobTitle",
        "profileStatus",
        "applicationCount",
        "draftApplications",
        "submittedApplications",
        "sessionCount",
        "pendingRoles",
        "confirmedRoles",
        "declinedRoles",
        "outstandingTasks",
        "completedTasks",
        "missingRequiredFields",
        "quarantinedFiles",
        "readinessStatus",
      ],
      "session-staffing": [
        "sessionId",
        "sessionTitle",
        "sessionStatus",
        "personId",
        "personName",
        "email",
        "role",
        "roleLabel",
        "response",
        "scheduleStatus",
        "scheduleVersion",
        "room",
        "startsAt",
        "endsAt",
        "outstandingRequirements",
      ],
      audit: [
        "id",
        "action",
        "entityType",
        "entityId",
        "actorEmail",
        "correlationId",
        "metadataJson",
        "createdAt",
      ],
    };
    return columns[resource];
  }

  private async rows(viewer: Viewer, resource: EventExportResource) {
    const limit = EXPORT_LIMIT + 1;
    if (resource === "people") {
      const result = await this.env.DB.prepare(
        `
        SELECT DISTINCT p.id, p.email, p.display_name AS name,
               p.organisation_name AS organisation, p.job_title AS jobTitle,
               p.profile_status AS profileStatus, p.created_at AS createdAt,
               p.updated_at AS updatedAt
          FROM people p
          JOIN events e ON e.id = ? AND e.organisation_id = ?
         WHERE EXISTS (
           SELECT 1 FROM memberships m
            WHERE m.person_id = p.id
              AND m.organisation_id = e.organisation_id
              AND (
                m.event_id = e.id
                OR (
                  m.event_id IS NULL
                  AND m.role IN ('owner', 'administrator')
                  AND m.accepted_at IS NOT NULL
                  AND m.revoked_at IS NULL
                )
              )
         ) OR EXISTS (
           SELECT 1 FROM submission_speakers ss
            WHERE ss.person_id = p.id AND ss.event_id = e.id
         ) OR EXISTS (
           SELECT 1 FROM session_speakers ss
            WHERE ss.person_id = p.id AND ss.event_id = e.id
         ) OR EXISTS (
           SELECT 1 FROM submissions s
            WHERE s.submitter_person_id = p.id AND s.event_id = e.id
         )
         ORDER BY p.display_name, p.id LIMIT ?
      `,
      )
        .bind(viewer.eventId, viewer.organisationId, limit)
        .all<{
          id: string;
          email: string;
          name: string;
          organisation: string | null;
          jobTitle: string | null;
          profileStatus: string;
          createdAt: number;
          updatedAt: number;
        }>();
      return result.results.map((row) => ({
        ...row,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      }));
    }
    if (resource === "submissions") {
      const result = await this.env.DB.prepare(
        `
        SELECT s.id, s.public_reference AS publicReference, s.title,
               COALESCE((
                 SELECT json_group_array(json(selected.track))
                   FROM (
                     SELECT json_object(
                              'id', selection.track_id,
                              'name', selection.track_name_snapshot,
                              'position', selection.position
                            ) AS track
                       FROM submission_track_selections selection
                      WHERE selection.submission_id = s.id
                        AND selection.event_id = s.event_id
                      ORDER BY selection.position
                   ) selected
               ), '[]') AS tracksJson,
               s.format, s.status, s.submitter_email AS submitterEmail,
               s.submitted_at AS submittedAt, s.created_at AS createdAt,
               s.updated_at AS updatedAt
          FROM submissions s JOIN events e ON e.id = s.event_id AND e.organisation_id = ?
         WHERE s.event_id = ? ORDER BY s.created_at, s.id LIMIT ?
      `,
      )
        .bind(viewer.organisationId, viewer.eventId, limit)
        .all<{
          id: string;
          publicReference: string;
          title: string;
          tracksJson: string;
          format: string | null;
          status: string;
          submitterEmail: string | null;
          submittedAt: number | null;
          createdAt: number;
          updatedAt: number;
        }>();
      return result.results.map(({ tracksJson, ...row }) => {
        const tracks = submissionTracksSchema.parse(JSON.parse(tracksJson));
        if (row.status !== "draft" && tracks.length === 0) {
          throw new Error(
            `Submission ${row.id} is missing persisted track selections.`,
          );
        }
        return {
          id: row.id,
          publicReference: row.publicReference,
          title: row.title,
          tracks: JSON.stringify(tracks),
          format: row.format,
          status: row.status,
          submitterEmail: row.submitterEmail,
          submittedAt: iso(row.submittedAt),
          createdAt: iso(row.createdAt),
          updatedAt: iso(row.updatedAt),
        };
      }) as Array<Record<string, ExportValue>>;
    }
    if (resource === "sessions") {
      const result = await this.env.DB.prepare(
        `
        SELECT s.id, s.title, s.slug, t.name AS track, s.format,
               s.duration_minutes AS durationMinutes, s.status, s.visibility,
               s.created_at AS createdAt, s.updated_at AS updatedAt
          FROM sessions s JOIN events e ON e.id = s.event_id AND e.organisation_id = ?
          LEFT JOIN tracks t ON t.id = s.track_id AND t.event_id = s.event_id
         WHERE s.event_id = ? ORDER BY s.title, s.id LIMIT ?
      `,
      )
        .bind(viewer.organisationId, viewer.eventId, limit)
        .all<{
          id: string;
          title: string;
          slug: string;
          track: string | null;
          format: string;
          durationMinutes: number;
          status: string;
          visibility: string;
          createdAt: number;
          updatedAt: number;
        }>();
      return result.results.map((row) => ({
        ...row,
        createdAt: iso(row.createdAt),
        updatedAt: iso(row.updatedAt),
      })) as Array<Record<string, ExportValue>>;
    }
    if (resource === "rooms") {
      const result = await this.env.DB.prepare(
        `SELECT r.id, r.name, r.capacity, r.position, r.status
           FROM rooms r JOIN events e ON e.id = r.event_id AND e.organisation_id = ?
          WHERE r.event_id = ? ORDER BY r.position, r.name LIMIT ?`,
      )
        .bind(viewer.organisationId, viewer.eventId, limit)
        .all<Record<string, ExportValue>>();
      return result.results;
    }
    if (resource === "tracks") {
      const result = await this.env.DB.prepare(
        `SELECT t.id, t.name, t.slug, t.colour_token AS colour, t.position,
                t.exclusive, t.is_public AS public
           FROM tracks t JOIN events e ON e.id = t.event_id AND e.organisation_id = ?
          WHERE t.event_id = ? ORDER BY t.position, t.name LIMIT ?`,
      )
        .bind(viewer.organisationId, viewer.eventId, limit)
        .all<Record<string, ExportValue>>();
      return result.results;
    }
    if (resource === "tasks") {
      const result = await this.env.DB.prepare(
        `
        SELECT ti.id, ti.title, ti.target_type AS targetType,
               ti.target_id AS targetId, p.email AS ownerEmail, ti.status,
               ti.readiness_state AS readinessState,
               ti.readiness_percent AS readinessPercent, ti.impact,
               ti.due_at AS dueAt, ti.completed_at AS completedAt,
               ti.updated_at AS updatedAt
          FROM task_instances ti
          JOIN events e ON e.id = ti.event_id AND e.organisation_id = ?
          LEFT JOIN people p ON p.id = ti.owner_person_id
         WHERE ti.event_id = ? ORDER BY ti.due_at IS NULL, ti.due_at, ti.id LIMIT ?
      `,
      )
        .bind(viewer.organisationId, viewer.eventId, limit)
        .all<{
          id: string;
          title: string;
          targetType: string;
          targetId: string;
          ownerEmail: string | null;
          status: string;
          readinessState: string;
          readinessPercent: number;
          impact: string;
          dueAt: number | null;
          completedAt: number | null;
          updatedAt: number;
        }>();
      return result.results.map((row) => ({
        ...row,
        dueAt: iso(row.dueAt),
        completedAt: iso(row.completedAt),
        updatedAt: iso(row.updatedAt),
      })) as Array<Record<string, ExportValue>>;
    }
    if (resource === "participant-readiness") {
      const result = await this.env.DB.prepare(
        `
        WITH participant_ids(person_id) AS (
          SELECT role.person_id
            FROM session_participant_roles role
           WHERE role.event_id = ?
          UNION
          SELECT submission.submitter_person_id
            FROM submissions submission
           WHERE submission.event_id = ?
             AND submission.submitter_person_id IS NOT NULL
          UNION
          SELECT speaker.person_id
            FROM submission_speakers speaker
           WHERE speaker.event_id = ? AND speaker.person_id IS NOT NULL
             AND speaker.invitation_status = 'claimed'
          UNION
          SELECT task.owner_person_id
            FROM task_instances task
           WHERE task.event_id = ? AND task.owner_person_id IS NOT NULL
          UNION
          SELECT task.target_id
            FROM task_instances task
           WHERE task.event_id = ? AND task.target_type = 'speaker'
        ), participant_rows AS (
          SELECT person.id AS personId, person.email,
                 COALESCE(contact_profile.display_name, person.display_name) AS name,
                 COALESCE(contact_profile.organisation_name, person.organisation_name) AS organisation,
                 COALESCE(contact_profile.job_title, person.job_title) AS jobTitle,
                 person.profile_status AS profileStatus,
                 (SELECT COUNT(*) FROM submissions application
                   WHERE application.event_id = ?
                     AND (
                       application.submitter_person_id = person.id
                       OR EXISTS (
                         SELECT 1 FROM submission_speakers application_speaker
                          WHERE application_speaker.event_id = application.event_id
                            AND application_speaker.submission_id = application.id
                            AND application_speaker.person_id = person.id
                            AND application_speaker.invitation_status = 'claimed'
                       )
                     )) AS applicationCount,
                 (SELECT COUNT(*) FROM submissions application
                   WHERE application.event_id = ?
                     AND application.status = 'draft'
                     AND (
                       application.submitter_person_id = person.id
                       OR EXISTS (
                         SELECT 1 FROM submission_speakers application_speaker
                          WHERE application_speaker.event_id = application.event_id
                            AND application_speaker.submission_id = application.id
                            AND application_speaker.person_id = person.id
                            AND application_speaker.invitation_status = 'claimed'
                       )
                     )) AS draftApplications,
                 (SELECT COUNT(*) FROM submissions application
                   WHERE application.event_id = ?
                     AND application.status <> 'draft'
                     AND (
                       application.submitter_person_id = person.id
                       OR EXISTS (
                         SELECT 1 FROM submission_speakers application_speaker
                          WHERE application_speaker.event_id = application.event_id
                            AND application_speaker.submission_id = application.id
                            AND application_speaker.person_id = person.id
                            AND application_speaker.invitation_status = 'claimed'
                       )
                     )) AS submittedApplications,
                 (SELECT COUNT(DISTINCT role.session_id)
                    FROM session_participant_roles role
                   WHERE role.event_id = ? AND role.person_id = person.id) AS sessionCount,
                 (SELECT COUNT(*) FROM session_participant_roles role
                    JOIN sessions role_session
                      ON role_session.id = role.session_id
                     AND role_session.event_id = role.event_id
                   WHERE role.event_id = ? AND role.person_id = person.id
                     AND role.participation_status = 'pending'
                     AND role_session.status NOT IN ('cancelled','archived')) AS pendingRoles,
                 (SELECT COUNT(*) FROM session_participant_roles role
                   WHERE role.event_id = ? AND role.person_id = person.id
                     AND role.participation_status = 'confirmed') AS confirmedRoles,
                 (SELECT COUNT(*) FROM session_participant_roles role
                   WHERE role.event_id = ? AND role.person_id = person.id
                     AND role.participation_status = 'declined') AS declinedRoles,
                 (SELECT COUNT(*) FROM task_instances task
                   WHERE task.event_id = ?
                     AND ${participantTaskAccessForPersonRowSql("task", true)}
                     AND task.status NOT IN ('completed','waived')
                     ) AS outstandingTasks,
                 (SELECT COUNT(*) FROM task_instances task
                   WHERE task.event_id = ?
                     AND ${participantTaskAccessForPersonRowSql("task", true)}
                     AND task.status IN ('completed','waived')
                     ) AS completedTasks,
                 (SELECT COUNT(*) FROM event_field_definitions definition
                   WHERE definition.event_id = ?
                     AND definition.owner_type = 'person'
                     AND definition.status = 'active' AND definition.required = 1
                     AND NOT EXISTS (
                       SELECT 1 FROM event_field_values value
                        WHERE value.definition_id = definition.id
                          AND value.event_id = definition.event_id
                          AND value.person_id = person.id
                          AND (
                            (definition.field_type IN ('short_text','long_text','date','single_choice')
                              AND json_type(value.value_json) = 'text'
                              AND trim(CAST(json_extract(value.value_json, '$') AS TEXT)) <> '')
                            OR (definition.field_type = 'number'
                              AND json_type(value.value_json) IN ('integer','real'))
                            OR (definition.field_type = 'boolean'
                              AND json_type(value.value_json) IN ('true','false'))
                            OR (definition.field_type = 'multiple_choice'
                              AND json_type(value.value_json) = 'array'
                              AND json_array_length(value.value_json) > 0)
                          )
                     )) AS missingRequiredFields,
                 (SELECT COUNT(*)
                    FROM file_assets asset
                    JOIN file_versions version ON version.id = (
                      SELECT latest.id FROM file_versions latest
                       WHERE latest.asset_id = asset.id
                         AND latest.deleted_at IS NULL
                       ORDER BY latest.version_number DESC
                       LIMIT 1
                    )
                   WHERE asset.event_id = ?
                     AND asset.owner_person_id = person.id
                     AND asset.status <> 'deleted'
                     AND version.upload_status = 'uploaded'
                     AND version.signature_status = 'valid'
                     AND version.scan_status = 'pending') AS quarantinedFiles
            FROM participant_ids participant
            JOIN people person ON person.id = participant.person_id
            JOIN events event ON event.id = ? AND event.organisation_id = ?
            LEFT JOIN organisation_contact_profiles contact_profile
              ON contact_profile.organisation_id = event.organisation_id
             AND contact_profile.person_id = person.id
        )
        SELECT participant.*,
               CASE WHEN participant.profileStatus = 'published'
                          AND participant.pendingRoles = 0
                          AND participant.outstandingTasks = 0
                          AND participant.missingRequiredFields = 0
                          AND participant.quarantinedFiles = 0
                    THEN 'ready' ELSE 'needs_attention' END AS readinessStatus
          FROM participant_rows participant
         ORDER BY participant.name COLLATE NOCASE, participant.personId
         LIMIT ?
      `,
      )
        .bind(
          viewer.eventId,
          viewer.eventId,
          viewer.eventId,
          viewer.eventId,
          viewer.eventId,
          viewer.eventId,
          viewer.eventId,
          viewer.eventId,
          viewer.eventId,
          viewer.eventId,
          viewer.eventId,
          viewer.eventId,
          viewer.eventId,
          viewer.eventId,
          viewer.eventId,
          viewer.eventId,
          viewer.eventId,
          viewer.organisationId,
          limit,
        )
        .all<Record<string, ExportValue>>();
      return result.results;
    }
    if (resource === "session-staffing") {
      const result = await this.env.DB.prepare(
        `
        WITH active_schedule AS (
          SELECT version.id, version.status, version.version_number
            FROM schedule_versions version
           WHERE version.event_id = ? AND version.status IN ('draft','published')
           ORDER BY CASE version.status WHEN 'draft' THEN 0 ELSE 1 END,
                    version.version_number DESC
           LIMIT 1
        )
        SELECT session.id AS sessionId, session.title AS sessionTitle,
               session.status AS sessionStatus, person.id AS personId,
               COALESCE(contact_profile.display_name, person.display_name) AS personName,
               person.email, role.role, role.label AS roleLabel,
               role.participation_status AS response,
               active_schedule.status AS scheduleStatus,
               active_schedule.version_number AS scheduleVersion,
               room.name AS room, entry.starts_at AS startsAt,
               entry.ends_at AS endsAt,
               (SELECT COUNT(*) FROM task_instances task
                 WHERE task.event_id = session.event_id
                   AND ${participantTaskAccessForPersonRowSql("task", true)}
                   AND task.status NOT IN ('completed','waived')
                   AND (
                     (task.target_type = 'session' AND task.target_id = session.id)
                     OR (task.target_type = 'speaker' AND task.target_id = person.id)
                   )
               ) AS outstandingRequirements
          FROM session_participant_roles role
          JOIN sessions session
            ON session.id = role.session_id AND session.event_id = role.event_id
          JOIN events event
            ON event.id = session.event_id AND event.organisation_id = ?
          JOIN people person ON person.id = role.person_id
          LEFT JOIN organisation_contact_profiles contact_profile
            ON contact_profile.organisation_id = event.organisation_id
           AND contact_profile.person_id = person.id
          LEFT JOIN active_schedule ON 1 = 1
          LEFT JOIN schedule_entries entry
            ON entry.schedule_version_id = active_schedule.id
           AND entry.event_id = session.event_id
           AND entry.session_id = session.id
          LEFT JOIN rooms room
            ON room.id = entry.room_id AND room.event_id = entry.event_id
         WHERE role.event_id = ?
         ORDER BY session.title COLLATE NOCASE, session.id,
                  role.position, role.role, personName COLLATE NOCASE, person.id
         LIMIT ?
      `,
      )
        .bind(viewer.eventId, viewer.organisationId, viewer.eventId, limit)
        .all<{
          sessionId: string;
          sessionTitle: string;
          sessionStatus: string;
          personId: string;
          personName: string;
          email: string;
          role: string;
          roleLabel: string;
          response: string;
          scheduleStatus: string | null;
          scheduleVersion: number | null;
          room: string | null;
          startsAt: number | null;
          endsAt: number | null;
          outstandingRequirements: number;
        }>();
      return result.results.map((row) => ({
        ...row,
        startsAt: iso(row.startsAt),
        endsAt: iso(row.endsAt),
      }));
    }
    const result = await this.env.DB.prepare(
      `
      SELECT a.id, a.action, a.entity_type AS entityType,
             a.entity_id AS entityId, p.email AS actorEmail,
             a.correlation_id AS correlationId, a.metadata_json AS metadataJson,
             a.created_at AS createdAt
        FROM audit_events a
        JOIN events e ON e.id = a.event_id AND e.organisation_id = ?
        LEFT JOIN people p ON p.id = a.actor_person_id
       WHERE a.event_id = ? ORDER BY a.created_at, a.id LIMIT ?
    `,
    )
      .bind(viewer.organisationId, viewer.eventId, limit)
      .all<{
        id: string;
        action: string;
        entityType: string;
        entityId: string | null;
        actorEmail: string | null;
        correlationId: string | null;
        metadataJson: string;
        createdAt: number;
      }>();
    return result.results.map((row) => ({
      ...row,
      createdAt: iso(row.createdAt),
    })) as Array<Record<string, ExportValue>>;
  }
}
