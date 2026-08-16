import { z } from "zod";

import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import type { Viewer } from "~/platform/auth/authorize.server";

export const eventExportResources = [
  "people",
  "submissions",
  "sessions",
  "rooms",
  "tracks",
  "tasks",
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
      ? Object.keys(rows[0]!)
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
