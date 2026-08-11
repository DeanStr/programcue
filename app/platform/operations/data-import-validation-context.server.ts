import { parseSessionFormatsConfiguration } from "~/modules/events/event-configuration";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  DataImportStateError,
  type DataImportValidationRecords,
  type EventImportResource,
} from "./data-import-validation.server";

export class DataImportValidationContext {
  constructor(private readonly env: CloudflareEnvironment) {}

  async load(
    viewer: Viewer,
    resource: EventImportResource,
    options: {
      requestedTaskIds?: readonly string[];
      requestedPersonEmails?: readonly string[];
      requestedSpeakerTargetIds?: readonly string[];
    } = {},
  ): Promise<DataImportValidationRecords> {
    const context: DataImportValidationRecords = {};
    if (
      resource === "people" ||
      resource === "submissions" ||
      resource === "tasks"
    ) {
      const emails = [...new Set(options.requestedPersonEmails ?? [])].slice(
        0,
        200,
      );
      const people = emails.length
        ? await this.env.DB.prepare(
            `SELECT p.id, lower(p.email) AS key, p.profile_revision AS revision,
                p.display_name AS name, p.organisation_name AS organisation,
                p.job_title AS jobTitle, p.profile_status AS profileStatus,
                EXISTS(
                  SELECT 1 FROM memberships m
                   WHERE m.person_id = p.id AND m.event_id = ?
                     AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL
                ) AS linked
           FROM people p
          WHERE p.email IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
          )
            .bind(viewer.eventId, JSON.stringify(emails))
            .all<{
              id: string;
              key: string;
              revision: number;
              name: string;
              organisation: string | null;
              jobTitle: string | null;
              profileStatus: string;
              linked: number;
            }>()
        : { results: [] };
      context.people = Object.fromEntries(
        people.results.map((row) => [row.key, row]),
      );
      const memberships = emails.length
        ? await this.env.DB.prepare(
            `SELECT lower(person.email) || char(0) || membership.role AS key,
                membership.id
           FROM memberships membership
           JOIN people person ON person.id = membership.person_id
          WHERE membership.event_id = ? AND membership.revoked_at IS NULL
            AND person.email IN (
              SELECT CAST(value AS TEXT) FROM json_each(?)
            )`,
          )
            .bind(viewer.eventId, JSON.stringify(emails))
            .all<{ id: string; key: string }>()
        : { results: [] };
      context.memberships = Object.fromEntries(
        memberships.results.map((row) => [row.key, row]),
      );
      if (resource === "tasks") {
        const speakerTargetIds = [
          ...new Set(options.requestedSpeakerTargetIds ?? []),
        ].slice(0, 200);
        const speakerTargets = speakerTargetIds.length
          ? await this.env.DB.prepare(
              `SELECT person.id
                 FROM people person
                WHERE person.id IN (
                  SELECT CAST(value AS TEXT) FROM json_each(?)
                )
                  AND EXISTS (
                    SELECT 1 FROM memberships membership
                     WHERE membership.event_id = ?
                       AND membership.person_id = person.id
                       AND membership.accepted_at IS NOT NULL
                       AND membership.revoked_at IS NULL
                  )`,
            )
              .bind(JSON.stringify(speakerTargetIds), viewer.eventId)
              .all<{ id: string }>()
          : { results: [] };
        context.speakerTargets = Object.fromEntries(
          speakerTargets.results.map((row) => [row.id, row]),
        );
      }
    }
    if (resource === "submissions") {
      const rows = await this.env.DB.prepare(
        `SELECT id, public_reference AS key, revision, status
           FROM submissions WHERE event_id = ?`,
      )
        .bind(viewer.eventId)
        .all<{ id: string; key: string; revision: number }>();
      context.submissions = Object.fromEntries(
        rows.results.map((row) => [row.key, row]),
      );
    }
    if (resource === "sessions" || resource === "tasks") {
      const rows = await this.env.DB.prepare(
        "SELECT id, slug AS key, status, revision FROM sessions WHERE event_id = ?",
      )
        .bind(viewer.eventId)
        .all<{ id: string; key: string; status: string; revision: number }>();
      context.sessions = Object.fromEntries(
        rows.results.map((row) => [row.key, row]),
      );
      context.sessionIds = Object.fromEntries(
        rows.results.map((row) => [row.id, row]),
      );
    }
    if (resource === "sessions") {
      const formats = await this.configuredSessionFormats(viewer);
      context.sessionFormats = Object.fromEntries(
        formats.map((format) => [format.key, { id: format.key }]),
      );
    }
    if (resource === "sessions" || resource === "tracks") {
      const rows = await this.env.DB.prepare(
        `SELECT id, slug AS key, name, colour_token AS colour, position,
                exclusive, is_public AS public
           FROM tracks WHERE event_id = ?`,
      )
        .bind(viewer.eventId)
        .all<{
          id: string;
          key: string;
          name: string;
          colour: string | null;
          position: number;
          exclusive: number;
          public: number;
        }>();
      context.tracks = Object.fromEntries(
        rows.results.map((row) => [row.key, row]),
      );
    }
    if (resource === "rooms") {
      const rows = await this.env.DB.prepare(
        `SELECT room.id, lower(room.name) AS key, room.name, room.building,
                room.level, room.capacity, room.position, room.status,
                (SELECT COUNT(*)
                   FROM schedule_entries entry
                   JOIN schedule_versions version
                     ON version.id = entry.schedule_version_id
                    AND version.event_id = entry.event_id
                  WHERE entry.event_id = room.event_id
                    AND entry.room_id = room.id
                    AND version.status IN ('draft','publishing','published')
                ) AS scheduleReferences,
                (SELECT MAX(session.expected_attendance)
                   FROM schedule_entries entry
                   JOIN schedule_versions version
                     ON version.id = entry.schedule_version_id
                    AND version.event_id = entry.event_id
                    AND version.status = 'published'
                   JOIN sessions session
                     ON session.id = entry.session_id
                    AND session.event_id = entry.event_id
                   JOIN schedule_policies policy
                     ON policy.event_id = entry.event_id
                    AND policy.capacity_action = 'block'
                  WHERE entry.event_id = room.event_id
                    AND entry.room_id = room.id
                    AND session.expected_attendance IS NOT NULL
                ) AS requiredCapacity
           FROM rooms room WHERE room.event_id = ?
           ORDER BY room.id`,
      )
        .bind(viewer.eventId)
        .all<{
          id: string;
          key: string;
          name: string;
          building: string | null;
          level: string | null;
          capacity: number;
          position: number;
          status: string;
          scheduleReferences: number;
          requiredCapacity: number | null;
        }>();
      context.rooms = {};
      for (const row of rows.results) {
        const existing = context.rooms[row.key];
        if (existing) {
          existing.ambiguous = true;
          continue;
        }
        context.rooms[row.key] = { ...row, ambiguous: false };
      }
    }
    if (resource === "tasks") {
      const taskIds = [...new Set(options.requestedTaskIds ?? [])].slice(
        0,
        200,
      );
      const rows = taskIds.length
        ? await this.env.DB.prepare(
            `SELECT task.id, task.id AS key, task.event_id AS eventId,
                    task.revision, task.status, task.task_type AS taskType,
                    EXISTS (
                      SELECT 1
                        FROM task_instance_dependencies dependency
                        JOIN task_instances prerequisite
                          ON prerequisite.id = dependency.depends_on_task_id
                       WHERE dependency.task_id = task.id
                         AND prerequisite.status NOT IN ('completed','waived')
                    ) AS dependenciesBlocked,
                    EXISTS (
                      SELECT 1
                        FROM task_instance_dependencies dependency
                        JOIN task_instances dependent
                          ON dependent.id = dependency.task_id
                       WHERE dependency.depends_on_task_id = task.id
                         AND dependent.status IN ('submitted','completed')
                    ) AS dependentAdvanced,
                    EXISTS (
                      SELECT 1
                        FROM task_evidence evidence
                        JOIN file_assets asset
                          ON asset.id = evidence.file_asset_id
                         AND asset.event_id = evidence.event_id
                        JOIN file_versions version
                          ON version.id = json_extract(evidence.evidence_json, '$.fileVersionId')
                         AND version.asset_id = asset.id
                         AND version.event_id = asset.event_id
                       WHERE evidence.task_id = task.id
                         AND evidence.status = 'submitted'
                         AND asset.status = 'active'
                         AND version.scan_status = 'clean'
                         AND version.signature_status = 'valid'
                         AND version.released_at IS NOT NULL
                    ) AS safeSubmittedEvidence
               FROM task_instances task
              WHERE task.id IN (${taskIds.map(() => "?").join(", ")})`,
          )
            .bind(...taskIds)
            .all<{
              id: string;
              key: string;
              eventId: string;
              revision: number;
              status: string;
              taskType: string;
              dependenciesBlocked: number;
              dependentAdvanced: number;
              safeSubmittedEvidence: number;
            }>()
        : { results: [] };
      context.tasks = Object.fromEntries(
        rows.results.map((row) => [row.key, row]),
      );
    }
    return context;
  }

  private async configuredSessionFormats(viewer: Viewer) {
    const event = await this.env.DB.prepare(
      `SELECT session_formats_json AS sessionFormatsJson
         FROM events
        WHERE id = ? AND organisation_id = ?`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{ sessionFormatsJson: string }>();
    if (!event) {
      throw new DataImportStateError(
        "The import event is unavailable in the authorised organisation.",
      );
    }
    return this.parseConfiguredSessionFormats(event.sessionFormatsJson);
  }

  private parseConfiguredSessionFormats(value: string) {
    try {
      return parseSessionFormatsConfiguration(value);
    } catch (error) {
      throw new DataImportStateError(
        error instanceof Error
          ? error.message
          : "The event has invalid session-format configuration.",
      );
    }
  }
}
