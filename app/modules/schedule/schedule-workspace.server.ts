import { z } from "zod";

import { parseSessionFormatsConfiguration } from "~/modules/events/event-configuration";
import { eventResourceSchema } from "~/modules/events/event-schema";
import { ScheduleConfigurationError } from "./schedule-errors";
import {
  detectScheduleConflicts,
  type ScheduleConflict,
  type ScheduledItem,
} from "./schedule-rules";
import type {
  ScheduleEntry,
  ScheduleEventScope,
  ScheduleSession,
  ScheduleWorkspace,
  WorkspaceEvent,
} from "./schedule-service.server";

const scheduleSpeakerProjectionSchema = z
  .array(
    z
      .object({
        id: z.string().trim().min(1),
        name: z.string().trim().min(1),
      })
      .strict(),
  )
  .max(50);

export function detectWorkspaceConflicts(workspace: ScheduleWorkspace) {
  const sessionById = new Map(
    workspace.sessions.map((session) => [session.id, session]),
  );
  const scheduled: ScheduledItem[] = workspace.entries.map((entry) => {
    const session = sessionById.get(entry.sessionId);
    if (!session) {
      throw new Error(
        `Schedule entry ${entry.id} references an unavailable session.`,
      );
    }
    return {
      ...entry,
      entryId: entry.id,
      trackId: session.trackId,
      trackExclusive: session.trackExclusive,
      speakerIds: session.speakerIds,
      speakerNames: session.speakerNames,
      expectedAttendance: session.expectedAttendance,
      requiredResources: session.requiredResources,
      title: session.title,
    };
  });
  const conflicts: Array<{ entryId: string; conflict: ScheduleConflict }> = [];
  const overlapPairs = new Set<string>();
  for (const entry of scheduled) {
    const detected = detectScheduleConflicts({
      candidate: entry,
      existing: scheduled,
      rooms: workspace.rooms,
      eventStartsAt: workspace.event.startsAt,
      eventEndsAt: workspace.event.endsAt,
      eventTimezone: workspace.event.timezone,
      policies: workspace.policies,
      excludeEntryId: entry.entryId,
    });
    for (const conflict of detected) {
      if (conflict.conflictingEntryId) {
        const pair = [entry.entryId, conflict.conflictingEntryId].sort();
        const fingerprint = `${conflict.type}:${pair[0]}:${pair[1]}`;
        if (overlapPairs.has(fingerprint)) continue;
        overlapPairs.add(fingerprint);
      }
      conflicts.push({ entryId: entry.entryId, conflict });
    }
  }
  return conflicts;
}

export function schedulePolicyAction(
  value: string,
): "ignore" | "warn" | "block" {
  if (value === "allow") return "ignore";
  if (value === "warn" || value === "block") return value;
  throw new ScheduleConfigurationError(
    `Unsupported schedule policy action: ${value}.`,
  );
}

export async function loadScheduleWorkspaceD1(
  env: CloudflareEnvironment,
  viewer: ScheduleEventScope,
): Promise<ScheduleWorkspace> {
  const event = await env.DB.prepare(
    `
      SELECT e.id, e.name, e.starts_at AS startsAt, e.ends_at AS endsAt,
             e.timezone, e.brand_accent AS brandAccent, e.revision,
             e.repository_provider AS repositoryProvider,
             e.session_formats_json AS sessionFormatsJson
        FROM events e
       WHERE e.id = ? AND e.organisation_id = ?
    `,
  )
    .bind(viewer.eventId, viewer.organisationId)
    .first<WorkspaceEvent>();
  if (!event) throw new Error("Event not found.");

  const [version, rooms, tracks, sessions, policyRow] = await Promise.all([
    env.DB.prepare(
      `
        SELECT id, version_number AS versionNumber, status, revision, notes
          FROM schedule_versions
         WHERE event_id = ? AND status IN ('draft','published')
         ORDER BY CASE status WHEN 'draft' THEN 0 ELSE 1 END, version_number DESC
         LIMIT 1
      `,
    )
      .bind(viewer.eventId)
      .first<{
        id: string;
        versionNumber: number;
        status: string;
        revision: number;
        notes: string;
      }>(),
    env.DB.prepare(
      "SELECT id, name, position, capacity, resources_json AS resourcesJson FROM rooms WHERE event_id = ? AND status = 'active' ORDER BY position, name",
    )
      .bind(viewer.eventId)
      .all<{
        id: string;
        name: string;
        position: number;
        capacity: number;
        resourcesJson: string;
      }>(),
    env.DB.prepare(
      "SELECT id, name, exclusive FROM tracks WHERE event_id = ? ORDER BY position, name",
    )
      .bind(viewer.eventId)
      .all<{ id: string; name: string; exclusive: number }>(),
    env.DB.prepare(
      `
        SELECT s.id,
               COALESCE(content.title, s.title) AS title,
               COALESCE(content.slug, s.slug) AS slug,
               COALESCE(content.description, s.description, '') AS description,
               COALESCE(content.track_id, s.track_id) AS trackId,
               t.name AS trackName,
               COALESCE(t.exclusive, 0) AS trackExclusive,
               COALESCE(content.format, s.format) AS format,
               COALESCE(content.duration_minutes, s.duration_minutes) AS durationMinutes,
               s.expected_attendance AS expectedAttendance,
               COALESCE(content.required_resources_json, s.required_resources_json) AS requiredResourcesJson,
               s.visibility AS sourceVisibility,
               COALESCE(content.visibility, s.visibility) AS visibility,
               COALESCE(content.content_status, 'draft') AS contentStatus,
               COALESCE(content.content_revision, 1) AS contentRevision,
               content.session_id AS snapshotSessionId, s.status,
               s.revision,
               COALESCE((
                 SELECT json_group_array(json(ordered.speaker))
                   FROM (
                     SELECT json_object(
                              'id', session_speaker.person_id,
                              'name', person.display_name
                            ) AS speaker
                       FROM session_speakers session_speaker
                       LEFT JOIN people person ON person.id = session_speaker.person_id
                      WHERE session_speaker.session_id = s.id
                        AND session_speaker.event_id = s.event_id
                      ORDER BY session_speaker.position, session_speaker.person_id
                   ) ordered
               ), '[]') AS speakersJson
          FROM sessions s
          LEFT JOIN schedule_session_contents content
            ON content.event_id = s.event_id AND content.session_id = s.id
           AND content.schedule_version_id = (
             SELECT active.id
               FROM schedule_versions active
              WHERE active.event_id = s.event_id
                AND active.status IN ('draft','published')
              ORDER BY CASE active.status WHEN 'draft' THEN 0 ELSE 1 END,
                       active.version_number DESC
              LIMIT 1
           )
          LEFT JOIN tracks t
            ON t.id = COALESCE(content.track_id, s.track_id)
           AND t.event_id = s.event_id
         WHERE s.event_id = ? AND s.status IN ('unscheduled','scheduled','published')
         ORDER BY s.title
      `,
    )
      .bind(viewer.eventId)
      .all<
        Omit<
          ScheduleSession,
          "speakerIds" | "speakerNames" | "trackExclusive" | "requiredResources"
        > & {
          trackExclusive: number;
          requiredResourcesJson: string;
          snapshotSessionId: string | null;
          speakersJson: string;
        }
      >(),
    env.DB.prepare(
      `
        SELECT room_overlap_action AS roomAction, speaker_overlap_action AS speakerAction,
               required_resource_overlap_action AS resourceAction,
               exclusive_track_overlap_action AS trackAction,
               event_boundary_action AS boundaryAction,
               capacity_action AS capacityAction,
               minimum_turnaround_minutes AS minimumTurnaroundMinutes,
               revision
          FROM schedule_policies WHERE event_id = ?
      `,
    )
      .bind(viewer.eventId)
      .first<{
        roomAction: string;
        speakerAction: string;
        resourceAction: string;
        trackAction: string;
        boundaryAction: string;
        capacityAction: string;
        minimumTurnaroundMinutes: number;
        revision: number;
      }>(),
  ]);

  if (!policyRow) throw new ScheduleConfigurationError();
  const currentVersion = version ?? null;
  const [entries, conflicts] = currentVersion
    ? await Promise.all([
        env.DB.prepare(
          `
        SELECT id, session_id AS sessionId, room_id AS roomId, starts_at AS startsAt,
               ends_at AS endsAt, revision
          FROM schedule_entries
         WHERE event_id = ? AND schedule_version_id = ?
         ORDER BY starts_at, room_id
      `,
        )
          .bind(viewer.eventId, currentVersion.id)
          .all<ScheduleEntry>(),
        env.DB.prepare(
          `
        SELECT id, conflict_type AS type, severity,
               primary_entry_id AS primaryEntryId,
               conflicting_entry_id AS conflictingEntryId,
               COALESCE(json_extract(details_json, '$.message'), conflict_type) AS message
          FROM schedule_conflicts
         WHERE event_id = ? AND schedule_version_id = ? AND resolved_at IS NULL
         ORDER BY severity, created_at
      `,
        )
          .bind(viewer.eventId, currentVersion.id)
          .all<{
            id: string;
            type: string;
            severity: string;
            message: string;
            primaryEntryId: string | null;
            conflictingEntryId: string | null;
          }>(),
      ])
    : [{ results: [] }, { results: [] }];
  const scheduledSessionIds = new Set(
    entries.results.map((entry) => entry.sessionId),
  );
  if (
    currentVersion &&
    sessions.results.some(
      (session) =>
        !session.snapshotSessionId &&
        (currentVersion.status === "draft" ||
          scheduledSessionIds.has(session.id)),
    )
  ) {
    throw new ScheduleConfigurationError(
      "The active schedule version is missing one or more required frozen session-content snapshots.",
    );
  }

  let parsedFormats: ScheduleWorkspace["sessionFormats"];
  try {
    parsedFormats = parseSessionFormatsConfiguration(event.sessionFormatsJson);
  } catch (error) {
    throw new ScheduleConfigurationError(
      error instanceof Error
        ? error.message
        : "The event has invalid session-format configuration.",
    );
  }
  const formatKeys = new Set(parsedFormats.map((format) => format.key));
  if (sessions.results.some((session) => !formatKeys.has(session.format))) {
    throw new ScheduleConfigurationError(
      "A session uses a format that is not configured for this event.",
    );
  }
  const configuredRooms = rooms.results.map(({ resourcesJson, ...room }) => {
    let resources: unknown;
    try {
      resources = JSON.parse(resourcesJson);
    } catch {
      throw new ScheduleConfigurationError(
        `Room ${room.id} has invalid resource inventory JSON.`,
      );
    }
    const parsed = eventResourceSchema.array().max(50).safeParse(resources);
    if (!parsed.success || new Set(parsed.data).size !== parsed.data.length) {
      throw new ScheduleConfigurationError(
        `Room ${room.id} has invalid or duplicate resource inventory entries.`,
      );
    }
    return { ...room, resources: parsed.data };
  });
  const configuredSessions = sessions.results.map(
    ({ snapshotSessionId: _snapshotSessionId, speakersJson, ...session }) => {
      let resources: unknown;
      try {
        resources = JSON.parse(session.requiredResourcesJson);
      } catch {
        throw new ScheduleConfigurationError(
          `Session ${session.id} has invalid required resource JSON.`,
        );
      }
      const parsed = eventResourceSchema.array().max(50).safeParse(resources);
      if (!parsed.success || new Set(parsed.data).size !== parsed.data.length) {
        throw new ScheduleConfigurationError(
          `Session ${session.id} has invalid or duplicate required resources.`,
        );
      }
      let rawSpeakers: unknown;
      try {
        rawSpeakers = JSON.parse(speakersJson);
      } catch {
        throw new ScheduleConfigurationError(
          `Session ${session.id} has invalid speaker projection JSON.`,
        );
      }
      const speakers = scheduleSpeakerProjectionSchema.safeParse(rawSpeakers);
      if (
        !speakers.success ||
        new Set(speakers.data.map((speaker) => speaker.id)).size !==
          speakers.data.length
      ) {
        throw new ScheduleConfigurationError(
          `Session ${session.id} has invalid or duplicate speaker projections.`,
        );
      }
      return {
        ...session,
        requiredResources: parsed.data,
        trackExclusive: Boolean(session.trackExclusive),
        speakerIds: speakers.data.map((speaker) => speaker.id),
        speakerNames: speakers.data.map((speaker) => speaker.name),
      };
    },
  );

  const workspace: ScheduleWorkspace = {
    event,
    version: currentVersion,
    rooms: configuredRooms,
    tracks: tracks.results.map((track) => ({
      ...track,
      exclusive: Boolean(track.exclusive),
    })),
    sessionFormats: parsedFormats,
    sessions: configuredSessions,
    entries: entries.results,
    /* A conflict that cannot point at the cards it is about is only a
       sentence. Both ends of an overlap are implicated; a single-entry
       breach such as an event boundary has a primary and nothing else. */
    conflicts: conflicts.results.map(
      ({ primaryEntryId, conflictingEntryId, ...conflict }) => ({
        ...conflict,
        entryIds: [primaryEntryId, conflictingEntryId].filter(
          (entryId): entryId is string => Boolean(entryId),
        ),
      }),
    ),
    publicationConflicts: [],
    policies: {
      room: schedulePolicyAction(policyRow.roomAction),
      speaker: schedulePolicyAction(policyRow.speakerAction),
      resource: schedulePolicyAction(policyRow.resourceAction),
      track: schedulePolicyAction(policyRow.trackAction),
      boundary: schedulePolicyAction(policyRow.boundaryAction),
      capacity: schedulePolicyAction(policyRow.capacityAction),
      minimumTurnaroundMinutes: policyRow.minimumTurnaroundMinutes,
    },
    policyRevision: policyRow.revision,
  };
  return {
    ...workspace,
    publicationConflicts: detectWorkspaceConflicts(workspace).map(
      ({ conflict }) => conflict,
    ),
  };
}
