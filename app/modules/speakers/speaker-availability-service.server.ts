import { requireValue } from "~/lib/required-value";
import {
  AirtableProviderBoundary,
  airtableCommandKey,
} from "~/modules/airtable/airtable-provider-boundary.server";
import { scheduleDraftConflictRebuildStatements } from "~/modules/schedule/schedule-conflict-statement.server";
import {
  ScheduleConfigurationError,
  ScheduleRevisionConflictError,
} from "~/modules/schedule/schedule-errors";
import type { SpeakerBlackoutWindow } from "~/modules/schedule/schedule-rules";
import type { ScheduleWorkspace } from "~/modules/schedule/schedule-service.server";
import {
  eventCalendarDateEpoch,
  eventLocalRange,
  formatEventLocalInterval,
  participantAllDayRange,
  participantEventLocalTimeEpoch,
} from "~/modules/schedule/schedule-time";
import {
  detectWorkspaceConflicts,
  loadScheduleWorkspaceD1,
} from "~/modules/schedule/schedule-workspace.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { adminSpeakerScopeSql } from "./speaker-admin-scope.server";
import {
  MAX_SPEAKER_BLACKOUT_WINDOWS,
  speakerBlackoutCreateSchema,
  speakerBlackoutDeleteSchema,
} from "./speaker-availability-schema";
import { SpeakerAdminStateError } from "./speaker-service-errors";

export type SpeakerAvailabilityWindow = SpeakerBlackoutWindow & {
  note: string | null;
  overlappingSessions: Array<{
    id: string;
    title: string;
    startsAt: number;
    endsAt: number;
  }>;
};

const writeAuthSql = `(
  EXISTS (
    SELECT 1 FROM memberships membership
     WHERE membership.event_id = events.id
       AND membership.organisation_id = events.organisation_id
       AND membership.person_id = ?
       AND membership.role = 'speaker'
       AND membership.accepted_at IS NOT NULL
       AND membership.revoked_at IS NULL
  )
  OR EXISTS (
    SELECT 1 FROM session_speakers relationship
    JOIN sessions session
      ON session.id = relationship.session_id
     AND session.event_id = relationship.event_id
     WHERE relationship.event_id = events.id
       AND relationship.person_id = ?
       AND session.status <> 'archived'
       AND relationship.participation_status IN ('pending','confirmed')
  )
)`;

function clockParts(value: string) {
  const [hourText, minuteText] = value.split(":");
  return { hour: Number(hourText), minute: Number(minuteText) };
}

function invalidAvailability(error: unknown): never {
  if (error instanceof SpeakerAdminStateError) throw error;
  throw new SpeakerAdminStateError(
    error instanceof Error
      ? error.message
      : "The unavailable period is invalid.",
    422,
  );
}

function trimNote(value: string) {
  const note = value.trim();
  return note.length === 0 ? null : note;
}

export class SpeakerAvailabilityService {
  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly airtable: AirtableProviderBoundary = new AirtableProviderBoundary(
      env,
    ),
  ) {}

  async canManage(viewer: Viewer) {
    await this.airtable.assertReadable(viewer);
    const allowed = await this.env.DB.prepare(
      `SELECT 1 AS allowed FROM events WHERE id = ? AND organisation_id = ? AND ${writeAuthSql}`,
    )
      .bind(
        viewer.eventId,
        viewer.organisationId,
        viewer.personId,
        viewer.personId,
      )
      .first();
    return Boolean(allowed);
  }

  async requireManage(viewer: Viewer) {
    if (!(await this.canManage(viewer))) {
      throw new SpeakerAdminStateError(
        "Only speakers can manage availability for this event.",
        403,
      );
    }
  }

  async listOwnWindows(viewer: Viewer) {
    await this.airtable.assertReadable(viewer);
    await this.requireManage(viewer);
    const [event, windows] = await Promise.all([
      this.loadEvent(viewer),
      this.env.DB.prepare(
        `
        SELECT id, person_id AS personId, starts_at AS startsAt, ends_at AS endsAt,
               note
          FROM speaker_blackout_windows
         WHERE event_id = ? AND person_id = ?
         ORDER BY starts_at, id
      `,
      )
        .bind(viewer.eventId, viewer.personId)
        .all<SpeakerBlackoutWindow & { note: string | null }>(),
    ]);
    return {
      event,
      windows: windows.results.map((window) => ({
        ...window,
        overlappingSessions:
          [] as SpeakerAvailabilityWindow["overlappingSessions"],
      })),
    };
  }

  async listAdminWindows(viewer: Viewer, personId: string) {
    await this.airtable.assertReadable(viewer);
    const [event, windows, overlaps] = await Promise.all([
      this.loadEvent(viewer),
      this.env.DB.prepare(
        `
        SELECT window.id, window.person_id AS personId,
               window.starts_at AS startsAt, window.ends_at AS endsAt
          FROM speaker_blackout_windows window
         WHERE window.event_id = ? AND window.person_id = ?
           AND ${adminSpeakerScopeSql("window.person_id")}
         ORDER BY window.starts_at, window.id
      `,
      )
        .bind(viewer.eventId, personId, viewer.eventId, viewer.organisationId)
        .all<SpeakerBlackoutWindow>(),
      this.env.DB.prepare(
        `
        SELECT window.id AS windowId, session.id AS sessionId,
               COALESCE(content.title, session.title) AS title,
               entry.starts_at AS startsAt, entry.ends_at AS endsAt
          FROM speaker_blackout_windows window
          JOIN schedule_versions version
            ON version.event_id = window.event_id
           AND version.status = 'draft'
          JOIN schedule_entries entry
            ON entry.schedule_version_id = version.id
           AND entry.event_id = window.event_id
          JOIN sessions session
            ON session.id = entry.session_id AND session.event_id = window.event_id
          LEFT JOIN schedule_session_contents content
            ON content.schedule_version_id = version.id
           AND content.event_id = window.event_id
           AND content.session_id = session.id
          JOIN session_speakers relationship
            ON relationship.session_id = session.id
           AND relationship.event_id = window.event_id
           AND relationship.person_id = window.person_id
         WHERE window.event_id = ? AND window.person_id = ?
           AND entry.starts_at < window.ends_at
           AND window.starts_at < entry.ends_at
         ORDER BY window.id, entry.starts_at, session.id
      `,
      )
        .bind(viewer.eventId, personId)
        .all<{
          windowId: string;
          sessionId: string;
          title: string;
          startsAt: number;
          endsAt: number;
        }>(),
    ]);
    const overlappingByWindow = new Map<
      string,
      SpeakerAvailabilityWindow["overlappingSessions"]
    >();
    for (const overlap of overlaps.results) {
      const records = overlappingByWindow.get(overlap.windowId) ?? [];
      records.push({
        id: overlap.sessionId,
        title: overlap.title,
        startsAt: overlap.startsAt,
        endsAt: overlap.endsAt,
      });
      overlappingByWindow.set(overlap.windowId, records);
    }
    return {
      event,
      windows: windows.results.map((window) => ({
        ...window,
        note: null,
        overlappingSessions: overlappingByWindow.get(window.id) ?? [],
      })),
    };
  }

  async createOwnWindow(viewer: Viewer, rawInput: unknown) {
    await this.airtable.assertReadable(viewer);
    await this.requireManage(viewer);
    const parsed = speakerBlackoutCreateSchema.parse(rawInput);
    const idempotencyKey = await airtableCommandKey(
      "speaker.availability.create",
      viewer,
      parsed,
    );
    return this.airtable.executeIdempotent(
      viewer,
      { idempotencyKey, operation: "speaker.availability.create" },
      () => this.createOwnWindowD1(viewer, parsed),
    );
  }

  async deleteOwnWindow(viewer: Viewer, rawInput: unknown) {
    await this.airtable.assertReadable(viewer);
    await this.requireManage(viewer);
    const parsed = speakerBlackoutDeleteSchema.parse(rawInput);
    const idempotencyKey = await airtableCommandKey(
      "speaker.availability.delete",
      viewer,
      parsed,
    );
    return this.airtable.executeIdempotent(
      viewer,
      { idempotencyKey, operation: "speaker.availability.delete" },
      () => this.deleteOwnWindowD1(viewer, parsed),
    );
  }

  async deleteAdminWindow(
    viewer: Viewer,
    rawPersonId: string,
    rawInput: unknown,
  ) {
    await this.airtable.assertReadable(viewer);
    const personId = rawPersonId.trim();
    if (!personId || personId.length > 200) {
      throw new SpeakerAdminStateError("Speaker not found in this event.", 404);
    }
    const parsed = speakerBlackoutDeleteSchema.parse(rawInput);
    const idempotencyKey = await airtableCommandKey(
      "speaker.availability.admin_delete",
      viewer,
      { personId, ...parsed },
    );
    return this.airtable.executeIdempotent(
      viewer,
      { idempotencyKey, operation: "speaker.availability.admin_delete" },
      () => this.deleteAdminWindowD1(viewer, personId, parsed),
    );
  }

  private async createOwnWindowD1(
    viewer: Viewer,
    parsed: ReturnType<typeof speakerBlackoutCreateSchema.parse>,
  ) {
    const event = await this.loadEvent(viewer);
    if (event.revision !== parsed.eventRevision) {
      throw new ScheduleRevisionConflictError(
        "The event changed after this page loaded. Refresh before adding another unavailable period.",
      );
    }
    const range = this.convertInput(parsed, event);
    this.assertWithinEvent(range, event);
    return this.mutateWindow(viewer, {
      origin: "participant_ui",
      action: "speaker.blackout.created",
      personId: viewer.personId,
      eventRevision: parsed.eventRevision,
      writeAuthPersonId: viewer.personId,
      insert: {
        id: crypto.randomUUID(),
        startsAt: range.startsAt,
        endsAt: range.endsAt,
        note: trimNote(parsed.note),
      },
    });
  }

  private async deleteOwnWindowD1(
    viewer: Viewer,
    parsed: ReturnType<typeof speakerBlackoutDeleteSchema.parse>,
  ) {
    return this.mutateWindow(viewer, {
      origin: "participant_ui",
      action: "speaker.blackout.deleted",
      personId: viewer.personId,
      eventRevision: parsed.eventRevision,
      writeAuthPersonId: viewer.personId,
      deleteId: parsed.windowId,
    });
  }

  private async deleteAdminWindowD1(
    viewer: Viewer,
    personId: string,
    parsed: ReturnType<typeof speakerBlackoutDeleteSchema.parse>,
  ) {
    const scoped = await this.env.DB.prepare(
      `SELECT 1 AS allowed FROM people person
        WHERE person.id = ? AND ${adminSpeakerScopeSql()}`,
    )
      .bind(personId, viewer.eventId, viewer.organisationId)
      .first();
    if (!scoped) {
      throw new SpeakerAdminStateError("Speaker not found in this event.", 404);
    }
    return this.mutateWindow(viewer, {
      origin: "admin_ui",
      action: "speaker.blackout.deleted_by_organiser",
      personId,
      eventRevision: parsed.eventRevision,
      deleteId: parsed.windowId,
    });
  }

  private async loadEvent(viewer: Viewer) {
    const event = await this.env.DB.prepare(
      `
      SELECT id, timezone, starts_at AS startsAt, ends_at AS endsAt, revision
        FROM events
       WHERE id = ? AND organisation_id = ?
    `,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{
        id: string;
        timezone: string;
        startsAt: number;
        endsAt: number;
        revision: number;
      }>();
    if (!event) throw new SpeakerAdminStateError("Event not found.", 404);
    return event;
  }

  private convertInput(
    parsed: {
      startDate: string;
      endDate: string;
      startTime?: string;
      endTime?: string;
      allDay: boolean;
    },
    event: { timezone: string },
  ) {
    try {
      if (parsed.allDay) {
        return participantAllDayRange(
          parsed.startDate,
          parsed.endDate,
          event.timezone,
        );
      }
      const startTime = requireValue(
        parsed.startTime,
        "Choose a start time, or mark the period as all day.",
      );
      const endTime = requireValue(
        parsed.endTime,
        "Choose an end time, or mark the period as all day.",
      );
      const startClock = clockParts(startTime);
      const endClock = clockParts(endTime);
      const startsAt = participantEventLocalTimeEpoch(
        eventCalendarDateEpoch(parsed.startDate),
        event.timezone,
        startClock.hour,
        startClock.minute,
      );
      const endsAt = participantEventLocalTimeEpoch(
        eventCalendarDateEpoch(parsed.endDate),
        event.timezone,
        endClock.hour,
        endClock.minute,
      );
      if (endsAt <= startsAt) {
        throw new SpeakerAdminStateError(
          "The unavailable period must end after it starts.",
          422,
        );
      }
      return { startsAt, endsAt };
    } catch (error) {
      invalidAvailability(error);
    }
  }

  private assertWithinEvent(
    range: { startsAt: number; endsAt: number },
    event: { startsAt: number; endsAt: number; timezone: string },
  ) {
    const bounds = eventLocalRange(
      event.startsAt,
      event.endsAt,
      event.timezone,
    );
    if (
      range.startsAt < bounds.startsAt ||
      range.endsAt > bounds.endsAtExclusive
    ) {
      throw new SpeakerAdminStateError(
        "Unavailable periods must stay within the event dates.",
        422,
      );
    }
  }

  private async mutateWindow(
    viewer: Viewer,
    input: {
      origin: "participant_ui" | "admin_ui";
      action:
        | "speaker.blackout.created"
        | "speaker.blackout.deleted"
        | "speaker.blackout.deleted_by_organiser";
      personId: string;
      eventRevision: number;
      writeAuthPersonId?: string;
      insert?: {
        id: string;
        startsAt: number;
        endsAt: number;
        note: string | null;
      };
      deleteId?: string;
    },
  ) {
    let workspace: ScheduleWorkspace;
    try {
      workspace = await loadScheduleWorkspaceD1(this.env, viewer, {
        includePublicationConflicts: false,
      });
    } catch (error) {
      if (error instanceof ScheduleConfigurationError) {
        throw new SpeakerAdminStateError(error.message, 422);
      }
      throw error;
    }
    if (workspace.event.revision !== input.eventRevision) {
      throw new ScheduleRevisionConflictError(
        "The event changed after this page loaded. Refresh before continuing.",
      );
    }
    const currentWindows = workspace.speakerBlackouts.filter(
      (window) => window.personId === input.personId,
    );
    let nextWindow: SpeakerBlackoutWindow | undefined;
    const createdWindow = input.insert;
    if (createdWindow) {
      if (currentWindows.length >= MAX_SPEAKER_BLACKOUT_WINDOWS) {
        throw new SpeakerAdminStateError(
          `A speaker can record at most ${MAX_SPEAKER_BLACKOUT_WINDOWS} unavailable periods for this event.`,
          422,
        );
      }
      if (
        currentWindows.some(
          (window) =>
            window.startsAt < createdWindow.endsAt &&
            createdWindow.startsAt < window.endsAt,
        )
      ) {
        throw new SpeakerAdminStateError(
          "Unavailable periods for the same speaker cannot overlap.",
          422,
        );
      }
      nextWindow = {
        id: createdWindow.id,
        personId: input.personId,
        startsAt: createdWindow.startsAt,
        endsAt: createdWindow.endsAt,
      };
    }
    const remainingWindows = input.deleteId
      ? workspace.speakerBlackouts.filter(
          (window) => window.id !== input.deleteId,
        )
      : workspace.speakerBlackouts;
    const prospectiveWindows = nextWindow
      ? [...remainingWindows, nextWindow]
      : remainingWindows;
    const deletedWindow = input.deleteId
      ? workspace.speakerBlackouts.find(
          (window) => window.id === input.deleteId,
        )
      : undefined;
    if (input.deleteId && !deletedWindow) {
      throw new SpeakerAdminStateError(
        "That unavailable period is no longer on this speaker.",
        409,
      );
    }
    if (input.deleteId && deletedWindow?.personId !== input.personId) {
      throw new SpeakerAdminStateError(
        "That unavailable period is no longer on this speaker.",
        409,
      );
    }

    const operationId = crypto.randomUUID();
    const auditEventId = crypto.randomUUID();
    const draft =
      workspace.version?.status === "draft" ? workspace.version : null;
    const conflicts = draft
      ? detectWorkspaceConflicts({
          ...workspace,
          speakerBlackouts: prospectiveWindows,
        })
      : [];
    const versionGuard = draft
      ? `EXISTS (
           SELECT 1 FROM schedule_versions current_version
            WHERE current_version.id = ? AND current_version.event_id = events.id
              AND current_version.status = 'draft' AND current_version.revision = ?
         )`
      : `NOT EXISTS (
           SELECT 1 FROM schedule_versions current_version
            WHERE current_version.event_id = events.id
              AND current_version.status = 'draft'
         )`;
    const versionBindings = draft ? [draft.id, draft.revision] : [];
    const writeAuthBindings = input.writeAuthPersonId
      ? [input.writeAuthPersonId, input.writeAuthPersonId]
      : [];
    const eventUpdate = this.env.DB.prepare(
      `
      UPDATE events
         SET revision = revision + 1, last_operation_id = ?,
             last_updated_by_person_id = ?, updated_at = unixepoch()
       WHERE id = ? AND organisation_id = ? AND revision = ?
         ${input.writeAuthPersonId ? `AND ${writeAuthSql}` : ""}
         AND ${versionGuard}
    `,
    ).bind(
      operationId,
      viewer.personId,
      viewer.eventId,
      viewer.organisationId,
      input.eventRevision,
      ...writeAuthBindings,
      ...versionBindings,
    );

    const windowMutation = input.insert
      ? this.env.DB.prepare(
          `
        INSERT INTO speaker_blackout_windows (
          id, event_id, person_id, starts_at, ends_at, note, revision,
          created_at, updated_at
        )
        SELECT ?, events.id, ?, ?, ?, ?, 1, unixepoch(), unixepoch()
          FROM events
         WHERE events.id = ? AND events.organisation_id = ?
           AND events.last_operation_id = ?
           AND (
             SELECT COUNT(*) FROM speaker_blackout_windows current_window
              WHERE current_window.event_id = events.id
                AND current_window.person_id = ?
           ) < ?
           AND NOT EXISTS (
             SELECT 1 FROM speaker_blackout_windows current_window
              WHERE current_window.event_id = events.id
                AND current_window.person_id = ?
                AND current_window.starts_at < ?
                AND ? < current_window.ends_at
           )
      `,
        ).bind(
          input.insert.id,
          input.personId,
          input.insert.startsAt,
          input.insert.endsAt,
          input.insert.note,
          viewer.eventId,
          viewer.organisationId,
          operationId,
          input.personId,
          MAX_SPEAKER_BLACKOUT_WINDOWS,
          input.personId,
          input.insert.endsAt,
          input.insert.startsAt,
        )
      : this.env.DB.prepare(
          `
        DELETE FROM speaker_blackout_windows
         WHERE id = ? AND event_id = ? AND person_id = ?
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = speaker_blackout_windows.event_id
                AND organisation_id = ?
                AND last_operation_id = ?
           )
      `,
        ).bind(
          requireValue(input.deleteId, "Required window id is unavailable."),
          viewer.eventId,
          input.personId,
          viewer.organisationId,
          operationId,
        );

    const auditWindow =
      input.insert ??
      requireValue(deletedWindow, "Required deleted window is unavailable.");
    const statements: D1PreparedStatement[] = [eventUpdate, windowMutation];
    if (draft) {
      statements.push(
        ...scheduleDraftConflictRebuildStatements(this.env, {
          organisationId: viewer.organisationId,
          eventId: viewer.eventId,
          operationId,
          draft,
          conflicts,
        }),
      );
    }
    statements.push(
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, actor_kind, origin, metadata_version, organisation_id, event_id,
          actor_person_id, action, entity_type, entity_id, correlation_id,
          metadata_json, created_at
        )
        SELECT ?, 'person', ?, 1, ?, ?, ?, ?, 'speaker_blackout_window', ?, ?, ?,
               unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM events
            WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
         )
      `,
      ).bind(
        auditEventId,
        input.origin,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        input.action,
        auditWindow.id,
        operationId,
        JSON.stringify({
          windowId: auditWindow.id,
          personId: input.personId,
          startsAt: auditWindow.startsAt,
          endsAt: auditWindow.endsAt,
        }),
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO event_changes (
          event_id, entity_type, entity_id, change_type, correlation_id, created_at
        )
        SELECT ?, 'person', ?, 'updated', ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM events
            WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
         )
        RETURNING sequence
      `,
      ).bind(
        viewer.eventId,
        input.personId,
        operationId,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
    );

    const results = await this.env.DB.batch(statements);
    const eventUpdated = results[0];
    const windowUpdated = results[1];
    const draftUpdated = draft ? results[2] : null;
    const auditIndex = draft ? 4 + conflicts.length : 2;
    const audit = results[auditIndex];
    const change = results[auditIndex + 1] as D1Result<{ sequence: number }>;
    if (
      (eventUpdated?.meta.changes ?? 0) !== 1 ||
      (windowUpdated?.meta.changes ?? 0) !== 1 ||
      (draftUpdated && (draftUpdated.meta.changes ?? 0) !== 1) ||
      (audit?.meta.changes ?? 0) !== 1
    ) {
      throw new ScheduleRevisionConflictError(
        "The event changed after this page loaded. Refresh before continuing.",
      );
    }
    const changeSequence = change?.results[0]?.sequence ?? null;
    const interval = formatEventLocalInterval(
      auditWindow.startsAt,
      auditWindow.endsAt,
      workspace.event.timezone,
    );
    return {
      windowId: auditWindow.id,
      personId: input.personId,
      startsAt: auditWindow.startsAt,
      endsAt: auditWindow.endsAt,
      interval,
      changeSequence,
    };
  }
}
