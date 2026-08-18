import { listPublishedSiteReferenceProblemsForSchedule } from "~/modules/public-site/public-site-publication-validation.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import type {
  ScheduleEntry,
  ScheduleWorkspace,
} from "./schedule-service.server";

export type SchedulePublicationChange = {
  sessionId: string;
  title: string;
};

export type SchedulePublicationMove = SchedulePublicationChange & {
  from: { room: string; startsAt: number; endsAt: number };
  to: { room: string; startsAt: number; endsAt: number };
};

export type SchedulePublicationVisibilityChange = SchedulePublicationChange & {
  from: string;
  to: string;
};

export const SCHEDULE_PUBLICATION_CONTENT_FIELDS = [
  "title",
  "description",
  "track",
  "format",
  "duration",
] as const;

export type SchedulePublicationContentField =
  (typeof SCHEDULE_PUBLICATION_CONTENT_FIELDS)[number];

export type SchedulePublicationContentChange = SchedulePublicationChange & {
  fields: Array<{
    field: SchedulePublicationContentField;
    before: string;
    after: string;
    excerpted?: boolean;
  }>;
};

export const SCHEDULE_PUBLICATION_DESCRIPTION_EXCERPT_LENGTH = 280;

export type SchedulePublicationPreview = {
  publishedVersionNumber: number | null;
  changes: {
    added: SchedulePublicationChange[];
    removed: SchedulePublicationChange[];
    moved: SchedulePublicationMove[];
    visibility: SchedulePublicationVisibilityChange[];
    content: SchedulePublicationContentChange[];
  };
  blockers: {
    emptySchedule: boolean;
    conflicts: ScheduleWorkspace["publicationConflicts"];
    contentVisibility: SchedulePublicationChange[];
    contentApproval: SchedulePublicationChange[];
    unconfirmedSpeakers: Array<
      SchedulePublicationChange & { speakerId: string; speakerName: string }
    >;
    publicDependencies: string[];
  };
  warnings: ScheduleWorkspace["publicationConflicts"];
};

type PublishedEntry = Pick<
  ScheduleEntry,
  "sessionId" | "roomId" | "startsAt" | "endsAt"
> & {
  title: string;
  description: string | null;
  format: string;
  trackId: string | null;
  trackName: string | null;
  durationMinutes: number;
  visibility: string;
  room: string;
};

function compareLabels(
  left: SchedulePublicationChange,
  right: SchedulePublicationChange,
) {
  return (
    left.title.localeCompare(right.title, "en", { sensitivity: "base" }) ||
    left.sessionId.localeCompare(right.sessionId)
  );
}

function displayText(value: string | null | undefined) {
  const trimmed = value?.trim() ?? "";
  return trimmed || "None";
}

function durationLabel(minutes: number) {
  return `${minutes} min`;
}

function excerptDescription(value: string) {
  if (value.length <= SCHEDULE_PUBLICATION_DESCRIPTION_EXCERPT_LENGTH) {
    return { text: value, excerpted: false };
  }
  return {
    text: `${value
      .slice(0, SCHEDULE_PUBLICATION_DESCRIPTION_EXCERPT_LENGTH)
      .trimEnd()}…`,
    excerpted: true,
  };
}

export async function buildSchedulePublicationPreview(
  env: CloudflareEnvironment,
  viewer: Pick<Viewer, "organisationId" | "eventId">,
  workspace: ScheduleWorkspace,
): Promise<SchedulePublicationPreview | null> {
  if (workspace.version?.status !== "draft") return null;

  const [publishedVersion, unconfirmed, publicDependencies] = await Promise.all(
    [
      env.DB.prepare(
        `SELECT id, version_number AS versionNumber
           FROM schedule_versions
          WHERE event_id = ? AND status = 'published'
          LIMIT 1`,
      )
        .bind(viewer.eventId)
        .first<{ id: string; versionNumber: number }>(),
      env.DB.prepare(
        `SELECT session.id AS sessionId, content.title,
                relationship.person_id AS speakerId,
                COALESCE(person.display_name, relationship.person_id) AS speakerName
           FROM schedule_entries entry
           JOIN sessions session
             ON session.id = entry.session_id AND session.event_id = entry.event_id
           JOIN schedule_session_contents content
             ON content.schedule_version_id = entry.schedule_version_id
            AND content.event_id = entry.event_id
            AND content.session_id = entry.session_id
           JOIN session_speakers relationship
             ON relationship.session_id = session.id
            AND relationship.event_id = session.event_id
           LEFT JOIN people person ON person.id = relationship.person_id
          WHERE entry.schedule_version_id = ? AND entry.event_id = ?
            AND relationship.participation_status IS NOT 'confirmed'
          ORDER BY content.title COLLATE NOCASE, session.id,
                   speakerName COLLATE NOCASE, relationship.person_id`,
      )
        .bind(workspace.version.id, viewer.eventId)
        .all<{
          sessionId: string;
          title: string;
          speakerId: string;
          speakerName: string;
        }>(),
      listPublishedSiteReferenceProblemsForSchedule(env, {
        eventId: viewer.eventId,
        organisationId: viewer.organisationId,
        scheduleVersionId: workspace.version.id,
      }),
    ],
  );

  const publishedEntries = publishedVersion
    ? await env.DB.prepare(
        `SELECT entry.session_id AS sessionId, entry.room_id AS roomId,
                entry.starts_at AS startsAt, entry.ends_at AS endsAt,
                content.title, content.description, content.format,
                content.track_id AS trackId, track.name AS trackName,
                content.duration_minutes AS durationMinutes,
                content.visibility, room.name AS room
           FROM schedule_entries entry
           JOIN schedule_session_contents content
             ON content.schedule_version_id = entry.schedule_version_id
            AND content.event_id = entry.event_id
            AND content.session_id = entry.session_id
           JOIN rooms room
             ON room.id = entry.room_id AND room.event_id = entry.event_id
           LEFT JOIN tracks track
             ON track.id = content.track_id AND track.event_id = content.event_id
          WHERE entry.event_id = ? AND entry.schedule_version_id = ?
          ORDER BY content.title COLLATE NOCASE, entry.session_id`,
      )
        .bind(viewer.eventId, publishedVersion.id)
        .all<PublishedEntry>()
    : { results: [] };

  const sessions = new Map(
    workspace.sessions.map((session) => [session.id, session] as const),
  );
  const rooms = new Map(workspace.rooms.map((room) => [room.id, room.name]));
  const draftEntries = new Map(
    workspace.entries.map((entry) => [entry.sessionId, entry] as const),
  );
  const previousEntries = new Map(
    publishedEntries.results.map((entry) => [entry.sessionId, entry] as const),
  );
  const added: SchedulePublicationChange[] = [];
  const removed: SchedulePublicationChange[] = [];
  const moved: SchedulePublicationMove[] = [];
  const visibility: SchedulePublicationVisibilityChange[] = [];
  const content: SchedulePublicationContentChange[] = [];
  const formatLabel = (key: string) =>
    workspace.sessionFormats.find((format) => format.key === key)?.label ?? key;

  for (const [sessionId, entry] of draftEntries) {
    const session = sessions.get(sessionId);
    if (!session) {
      throw new Error(
        `Schedule publication preview cannot resolve session ${sessionId}.`,
      );
    }
    const previous = previousEntries.get(sessionId);
    if (!previous) {
      added.push({ sessionId, title: session.title });
      continue;
    }
    if (
      previous.roomId !== entry.roomId ||
      previous.startsAt !== entry.startsAt ||
      previous.endsAt !== entry.endsAt
    ) {
      const room = rooms.get(entry.roomId);
      if (!room) {
        throw new Error(
          `Schedule publication preview cannot resolve room ${entry.roomId}.`,
        );
      }
      moved.push({
        sessionId,
        title: session.title,
        from: {
          room: previous.room,
          startsAt: previous.startsAt,
          endsAt: previous.endsAt,
        },
        to: { room, startsAt: entry.startsAt, endsAt: entry.endsAt },
      });
    }
    if (previous.visibility !== session.visibility) {
      visibility.push({
        sessionId,
        title: session.title,
        from: previous.visibility,
        to: session.visibility,
      });
    }
    const fields: SchedulePublicationContentChange["fields"] = [];
    if (previous.title !== session.title) {
      fields.push({
        field: "title",
        before: previous.title,
        after: session.title,
      });
    }
    if (
      displayText(previous.description) !== displayText(session.description)
    ) {
      const before = excerptDescription(displayText(previous.description));
      const after = excerptDescription(displayText(session.description));
      fields.push({
        field: "description",
        before: before.text,
        after: after.text,
        ...(before.excerpted || after.excerpted ? { excerpted: true } : {}),
      });
    }
    if ((previous.trackId ?? null) !== session.trackId) {
      fields.push({
        field: "track",
        before: previous.trackName ?? "No track",
        after: session.trackName ?? "No track",
      });
    }
    if (previous.format !== session.format) {
      fields.push({
        field: "format",
        before: formatLabel(previous.format),
        after: formatLabel(session.format),
      });
    }
    if (previous.durationMinutes !== session.durationMinutes) {
      fields.push({
        field: "duration",
        before: durationLabel(previous.durationMinutes),
        after: durationLabel(session.durationMinutes),
      });
    }
    if (fields.length) {
      content.push({ sessionId, title: session.title, fields });
    }
  }

  for (const previous of publishedEntries.results) {
    if (!draftEntries.has(previous.sessionId)) {
      removed.push({ sessionId: previous.sessionId, title: previous.title });
    }
  }

  const scheduledSessions = workspace.entries.map((entry) => {
    const session = sessions.get(entry.sessionId);
    if (!session) {
      throw new Error(
        `Schedule publication preview cannot resolve session ${entry.sessionId}.`,
      );
    }
    return session;
  });
  const contentVisibility = scheduledSessions
    .filter(
      (session) =>
        session.sourceVisibility === "public" &&
        session.visibility !== "public",
    )
    .map((session) => ({ sessionId: session.id, title: session.title }))
    .sort(compareLabels);
  const contentApproval = scheduledSessions
    .filter(
      (session) =>
        session.sourceVisibility === "public" &&
        session.contentStatus !== "approved",
    )
    .map((session) => ({ sessionId: session.id, title: session.title }))
    .sort(compareLabels);
  const blockingConflicts = workspace.publicationConflicts.filter(
    (conflict) => conflict.severity === "blocking",
  );

  return {
    publishedVersionNumber: publishedVersion?.versionNumber ?? null,
    changes: {
      added: added.sort(compareLabels),
      removed: removed.sort(compareLabels),
      moved: moved.sort(compareLabels),
      visibility: visibility.sort(compareLabels),
      content: content.sort(compareLabels),
    },
    blockers: {
      emptySchedule: workspace.entries.length === 0,
      conflicts: blockingConflicts,
      contentVisibility,
      contentApproval,
      unconfirmedSpeakers: unconfirmed.results,
      publicDependencies,
    },
    warnings: workspace.publicationConflicts.filter(
      (conflict) => conflict.severity !== "blocking",
    ),
  };
}
