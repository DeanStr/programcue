import type { Viewer } from "~/platform/auth/authorize.server";
import {
  ScheduleConfigurationError,
  ScheduleNotFoundError,
  ScheduleReviewLinkExpiredError,
  ScheduleReviewLinkIntentReusedError,
  ScheduleReviewLinkLimitError,
  ScheduleReviewLinkNotFoundError,
  ScheduleRevisionConflictError,
} from "./schedule-errors";
import {
  buildScheduleReviewProjection,
  hashScheduleReviewProjection,
  parseScheduleReviewProjection,
  type ScheduleReviewProjection,
  type ScheduleReviewProjectionEntryInput,
  ScheduleReviewProjectionError,
  serializeScheduleReviewProjection,
} from "./schedule-review-projection";
import {
  createScheduleReviewToken,
  hashScheduleReviewToken,
  isScheduleReviewToken,
} from "./schedule-review-token.server";
import {
  SCHEDULE_REVIEW_LINK_ACKNOWLEDGEMENT,
  scheduleReviewLinkCreateSchema,
  scheduleReviewLinkRevokeSchema,
} from "./schedule-schema";
import type {
  ScheduleEventScope,
  ScheduleWorkspace,
} from "./schedule-service.server";

export const SCHEDULE_REVIEW_LINK_ACTIVE_LIMIT = 10;
export const SCHEDULE_REVIEW_LINK_MAX_TTL_SECONDS = 2_592_000;
export const SCHEDULE_REVIEW_LINK_DAY_SECONDS = 86_400;
export const SCHEDULE_REVIEW_LINK_INACTIVE_LIST_LIMIT = 20;

const LIST_COLUMNS = `link.id,
       link.schedule_version_id AS scheduleVersionId,
       link.schedule_revision AS scheduleRevision,
       version.version_number AS versionNumber,
       link.purpose AS purpose,
       link.expires_at AS expiresAt,
       link.created_at AS createdAt,
       creator.display_name AS createdByName,
       link.revoked_at AS revokedAt,
       link.revocation_reason AS revocationReason`;

type SpeakerRow = {
  sessionId: string;
  personId: string;
  position: number;
  participationStatus: "pending" | "confirmed" | "declined";
  displayName: string | null;
};

export type ScheduleReviewLinkStatus = "active" | "expired" | "revoked";

export type ScheduleReviewLinkListItem = {
  id: string;
  scheduleVersionId: string;
  scheduleRevision: number;
  versionNumber: number | null;
  purpose: string;
  expiresAt: number;
  createdAt: number;
  createdByName: string | null;
  revokedAt: number | null;
  revocationReason: "manual" | "published" | null;
  status: ScheduleReviewLinkStatus;
};

export type ScheduleReviewLinkListResult = {
  items: ScheduleReviewLinkListItem[];
  omittedInactiveCount: number;
};

export type ScheduleReviewLinkDisclosure = {
  title: string;
  room: string;
  startsAt: number;
  speakers: string[];
};

export type ScheduleReviewLinkSummary = {
  canCreate: boolean;
  entryCount: number;
  speakerNameCount: number;
  projectionHash: string | null;
  blockedReason: string | null;
  disclosures: ScheduleReviewLinkDisclosure[];
};

export type ScheduleReviewLinkCreateResult = {
  id: string;
  token: string;
  path: string;
  expiresAt: number;
  entryCount: number;
  speakerNameCount: number;
};

function requireAdministrator(viewer: Viewer) {
  if (viewer.role !== "owner" && viewer.role !== "administrator") {
    throw new Response(
      "This page is for event administrators. Your current role cannot open it.",
      { status: 403 },
    );
  }
}

function reviewLinkStatus(input: {
  revokedAt: number | null;
  expiresAt: number;
  now: number;
}): ScheduleReviewLinkStatus {
  if (input.revokedAt !== null) return "revoked";
  if (input.expiresAt <= input.now) return "expired";
  return "active";
}

function formatLabels(workspace: ScheduleWorkspace) {
  return new Map(
    workspace.sessionFormats.map((format) => [format.key, format.label]),
  );
}

function roomNames(workspace: ScheduleWorkspace) {
  return new Map(workspace.rooms.map((room) => [room.id, room.name]));
}

function sessionById(workspace: ScheduleWorkspace) {
  return new Map(workspace.sessions.map((session) => [session.id, session]));
}

function speakerNamesBySession(
  sessionIds: ReadonlyArray<string>,
  rows: ReadonlyArray<SpeakerRow>,
) {
  const names = new Map<string, string[]>(
    sessionIds.map((sessionId) => [sessionId, []]),
  );
  for (const row of rows) {
    if (row.participationStatus === "declined") continue;
    const list = names.get(row.sessionId);
    if (!list) continue;
    const displayName = row.displayName?.trim() ?? "";
    if (!displayName) {
      throw new ScheduleReviewProjectionError(
        "An assigned speaker is missing a display name, so the review snapshot cannot be created.",
      );
    }
    list.push(displayName);
  }
  return names;
}

function draftEntries(
  workspace: ScheduleWorkspace,
  speakers: Map<string, string[]>,
): ScheduleReviewProjectionEntryInput[] {
  if (workspace.version?.status !== "draft") {
    throw new ScheduleNotFoundError(
      "A draft schedule is required before creating a review snapshot.",
    );
  }
  const sessions = sessionById(workspace);
  const rooms = roomNames(workspace);
  const formats = formatLabels(workspace);
  const entries: ScheduleReviewProjectionEntryInput[] = [];
  for (const entry of workspace.entries) {
    const session = sessions.get(entry.sessionId);
    if (!session) {
      throw new ScheduleConfigurationError(
        `Schedule entry ${entry.id} references an unavailable session.`,
      );
    }
    if (session.visibility !== "public") continue;
    const roomName = rooms.get(entry.roomId)?.trim() ?? "";
    if (!roomName) {
      throw new ScheduleConfigurationError(
        "A scheduled session is missing a room name, so the review snapshot cannot be created.",
      );
    }
    const formatLabel = formats.get(session.format)?.trim() ?? "";
    if (!formatLabel) {
      throw new ScheduleReviewProjectionError(
        "A scheduled session uses a format that is not configured for this event.",
      );
    }
    entries.push({
      id: entry.id,
      startsAt: entry.startsAt,
      endsAt: entry.endsAt,
      title: session.title,
      formatLabel,
      roomName,
      trackName: session.trackName?.trim() ? session.trackName.trim() : null,
      speakers: speakers.get(session.id) ?? [],
    });
  }
  return entries;
}

export function scheduleReviewPreviewPath(token: string) {
  return `/programme-preview/${token}`;
}

export {
  isScheduleReviewPreviewPath,
  SCHEDULE_REVIEW_PREVIEW_NOT_FOUND_MESSAGE,
  scheduleReviewPreviewHeaders,
  scheduleReviewPreviewNotFound,
} from "./schedule-review-preview-http";

function disclosedRecords(
  projection: ScheduleReviewProjection,
): ScheduleReviewLinkDisclosure[] {
  return projection.entries.map((entry) => ({
    title: entry.title,
    room: entry.room,
    startsAt: entry.startsAt,
    speakers: [...entry.speakers],
  }));
}

export class ScheduleReviewLinkService {
  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly dependencies: {
      getWorkspace: (
        viewer: ScheduleEventScope,
        options?: { bypassCache?: boolean },
      ) => Promise<ScheduleWorkspace>;
    },
  ) {}

  private getWorkspace(
    viewer: ScheduleEventScope,
    options?: { bypassCache?: boolean },
  ) {
    return this.dependencies.getWorkspace(viewer, options);
  }

  private async loadAssignedSpeakers(
    viewer: ScheduleEventScope,
    scheduleVersionId: string,
  ) {
    const result = await this.env.DB.prepare(
      `
        SELECT session_speaker.session_id AS sessionId,
               session_speaker.person_id AS personId,
               session_speaker.position AS position,
               session_speaker.participation_status AS participationStatus,
               person.display_name AS displayName
          FROM session_speakers session_speaker
          JOIN events event
            ON event.id = session_speaker.event_id
           AND event.organisation_id = ?
          LEFT JOIN people person ON person.id = session_speaker.person_id
         WHERE session_speaker.event_id = ?
           AND session_speaker.session_id IN (
             SELECT entry.session_id
               FROM schedule_entries entry
              WHERE entry.event_id = ?
                AND entry.schedule_version_id = ?
           )
         ORDER BY session_speaker.session_id, session_speaker.position,
                  session_speaker.person_id
      `,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        viewer.eventId,
        scheduleVersionId,
      )
      .all<SpeakerRow>();
    return result.results;
  }

  private async buildDraftProjection(
    viewer: ScheduleEventScope,
    workspace: ScheduleWorkspace,
  ) {
    if (workspace.version?.status !== "draft") {
      throw new ScheduleNotFoundError(
        "A draft schedule is required before creating a review snapshot.",
      );
    }
    const speakerRows = await this.loadAssignedSpeakers(
      viewer,
      workspace.version.id,
    );
    const sessions = sessionById(workspace);
    const speakers = speakerNamesBySession(
      workspace.entries
        .filter(
          (entry) => sessions.get(entry.sessionId)?.visibility === "public",
        )
        .map((entry) => entry.sessionId),
      speakerRows,
    );
    return buildScheduleReviewProjection({
      eventName: workspace.event.name,
      timezone: workspace.event.timezone,
      entries: draftEntries(workspace, speakers),
    });
  }

  private async countActiveLinks(viewer: ScheduleEventScope) {
    const active = await this.env.DB.prepare(
      `
        SELECT COUNT(*) AS total
          FROM schedule_review_links
         WHERE organisation_id = ? AND event_id = ?
           AND revoked_at IS NULL AND expires_at > unixepoch()
      `,
    )
      .bind(viewer.organisationId, viewer.eventId)
      .first<{ total: number }>();
    if (
      typeof active?.total !== "number" ||
      !Number.isFinite(active.total) ||
      active.total < 0
    ) {
      throw new Error("The active draft review link count could not be read.");
    }
    return active.total;
  }

  async summarize(
    viewer: Viewer,
    workspace?: ScheduleWorkspace,
  ): Promise<ScheduleReviewLinkSummary> {
    requireAdministrator(viewer);
    const loaded = workspace ?? (await this.getWorkspace(viewer));
    if (loaded.version?.status !== "draft") {
      return {
        canCreate: false,
        entryCount: 0,
        speakerNameCount: 0,
        projectionHash: null,
        blockedReason:
          "Create a draft schedule before sharing a confidential review snapshot.",
        disclosures: [],
      };
    }
    try {
      const projection = await this.buildDraftProjection(viewer, loaded);
      const projectionHash = await hashScheduleReviewProjection(
        serializeScheduleReviewProjection(projection),
      );
      const entryCount = projection.entries.length;
      const speakerNameCount = projection.entries.reduce(
        (total, entry) => total + entry.speakers.length,
        0,
      );
      const disclosures = disclosedRecords(projection);
      if (
        (await this.countActiveLinks(viewer)) >=
        SCHEDULE_REVIEW_LINK_ACTIVE_LIMIT
      ) {
        return {
          canCreate: false,
          entryCount,
          speakerNameCount,
          projectionHash,
          blockedReason: new ScheduleReviewLinkLimitError().message,
          disclosures,
        };
      }
      return {
        canCreate: true,
        entryCount,
        speakerNameCount,
        projectionHash,
        blockedReason: null,
        disclosures,
      };
    } catch (error) {
      if (
        error instanceof ScheduleReviewProjectionError ||
        error instanceof ScheduleConfigurationError ||
        error instanceof ScheduleNotFoundError
      ) {
        return {
          canCreate: false,
          entryCount: 0,
          speakerNameCount: 0,
          projectionHash: null,
          blockedReason: error.message,
          disclosures: [],
        };
      }
      throw error;
    }
  }

  async list(viewer: Viewer): Promise<ScheduleReviewLinkListResult> {
    requireAdministrator(viewer);
    const listJoins = `
          FROM schedule_review_links link
          LEFT JOIN schedule_versions version
            ON version.id = link.schedule_version_id
           AND version.event_id = link.event_id
          LEFT JOIN people creator
            ON creator.id = link.created_by_person_id
         WHERE link.organisation_id = ? AND link.event_id = ?`;
    const [result, inactiveCount] = await Promise.all([
      this.env.DB.prepare(
        `
          SELECT ${LIST_COLUMNS},
                 unixepoch() AS now
            ${listJoins}
             AND (
               (link.revoked_at IS NULL AND link.expires_at > unixepoch())
               OR link.id IN (
                 SELECT inner_link.id
                   FROM schedule_review_links inner_link
                  WHERE inner_link.organisation_id = ?
                    AND inner_link.event_id = ?
                    AND (
                      inner_link.revoked_at IS NOT NULL
                      OR inner_link.expires_at <= unixepoch()
                    )
                  ORDER BY inner_link.created_at DESC, inner_link.id DESC
                  LIMIT ?
               )
             )
           ORDER BY link.created_at DESC, link.id DESC
        `,
      )
        .bind(
          viewer.organisationId,
          viewer.eventId,
          viewer.organisationId,
          viewer.eventId,
          SCHEDULE_REVIEW_LINK_INACTIVE_LIST_LIMIT,
        )
        .all<{
          id: string;
          scheduleVersionId: string;
          scheduleRevision: number;
          versionNumber: number | null;
          purpose: string;
          expiresAt: number;
          createdAt: number;
          createdByName: string | null;
          revokedAt: number | null;
          revocationReason: "manual" | "published" | null;
          now: number;
        }>(),
      this.env.DB.prepare(
        `
          SELECT COUNT(*) AS total
            FROM schedule_review_links
           WHERE organisation_id = ? AND event_id = ?
             AND (revoked_at IS NOT NULL OR expires_at <= unixepoch())
        `,
      )
        .bind(viewer.organisationId, viewer.eventId)
        .first<{ total: number }>(),
    ]);
    if (
      typeof inactiveCount?.total !== "number" ||
      !Number.isFinite(inactiveCount.total) ||
      inactiveCount.total < 0
    ) {
      throw new Error("The draft review link history count could not be read.");
    }
    return {
      items: result.results.map(({ now: rowNow, ...row }) => {
        if (typeof rowNow !== "number" || !Number.isFinite(rowNow)) {
          throw new Error(
            "The draft review link list clock could not be read.",
          );
        }
        return {
          ...row,
          status: reviewLinkStatus({
            revokedAt: row.revokedAt,
            expiresAt: row.expiresAt,
            now: rowNow,
          }),
        };
      }),
      omittedInactiveCount: Math.max(
        0,
        inactiveCount.total - SCHEDULE_REVIEW_LINK_INACTIVE_LIST_LIMIT,
      ),
    };
  }

  async create(
    viewer: Viewer,
    input: unknown,
  ): Promise<ScheduleReviewLinkCreateResult> {
    requireAdministrator(viewer);
    const parsed = scheduleReviewLinkCreateSchema.parse(input);
    const workspace = await this.getWorkspace(viewer, { bypassCache: true });
    if (workspace.version?.status !== "draft") {
      throw new ScheduleNotFoundError(
        "A draft schedule is required before creating a review snapshot.",
      );
    }
    if (
      workspace.version.id !== parsed.scheduleVersionId ||
      workspace.version.revision !== parsed.scheduleRevision
    ) {
      throw new ScheduleRevisionConflictError(
        "The schedule changed after this page loaded. Refresh before creating a review snapshot.",
      );
    }
    const projection = await this.buildDraftProjection(viewer, workspace);
    const serialized = serializeScheduleReviewProjection(projection);
    const projectionHash = await hashScheduleReviewProjection(serialized);
    if (projectionHash !== parsed.projectionHash) {
      throw new ScheduleRevisionConflictError(
        "The unpublished snapshot changed after this page loaded. Refresh before creating a review snapshot.",
      );
    }
    const token = createScheduleReviewToken();
    const tokenHash = await hashScheduleReviewToken(token);
    const id = crypto.randomUUID();
    const createdAt = Math.floor(Date.now() / 1_000);
    const ttlSeconds = parsed.ttlDays * SCHEDULE_REVIEW_LINK_DAY_SECONDS;
    if (ttlSeconds > SCHEDULE_REVIEW_LINK_MAX_TTL_SECONDS) {
      throw new Error(
        "The draft review link expiry exceeds the 30-day ceiling.",
      );
    }
    const expiresAt = createdAt + ttlSeconds;
    const auditEventId = crypto.randomUUID();
    let inserted: D1Result;
    let audit: D1Result;
    try {
      [inserted, audit] = await this.env.DB.batch([
        this.env.DB.prepare(
          `
          INSERT INTO schedule_review_links (
            id, organisation_id, event_id, schedule_version_id, schedule_revision,
            projection_json, token_hash, expires_at, created_by_person_id, created_at,
            purpose, create_intent_id
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ?
           )
             AND EXISTS (
               SELECT 1 FROM schedule_versions
                WHERE id = ? AND event_id = ? AND status = 'draft' AND revision = ?
             )
             AND NOT EXISTS (
               SELECT 1 FROM schedule_review_links intent_link
                WHERE intent_link.organisation_id = ?
                  AND intent_link.event_id = ?
                  AND intent_link.create_intent_id = ?
             )
             AND (
               SELECT COUNT(*)
                 FROM schedule_review_links active_link
                WHERE active_link.organisation_id = ?
                  AND active_link.event_id = ?
                  AND active_link.revoked_at IS NULL
                  AND active_link.expires_at > unixepoch()
             ) < ?
        `,
        ).bind(
          id,
          viewer.organisationId,
          viewer.eventId,
          parsed.scheduleVersionId,
          parsed.scheduleRevision,
          serialized,
          tokenHash,
          expiresAt,
          viewer.personId,
          createdAt,
          parsed.purpose,
          parsed.createIntentId,
          viewer.eventId,
          viewer.organisationId,
          parsed.scheduleVersionId,
          viewer.eventId,
          parsed.scheduleRevision,
          viewer.organisationId,
          viewer.eventId,
          parsed.createIntentId,
          viewer.organisationId,
          viewer.eventId,
          SCHEDULE_REVIEW_LINK_ACTIVE_LIMIT,
        ),
        this.env.DB.prepare(
          `
          INSERT INTO audit_events (
            id, actor_kind, origin, metadata_version, organisation_id, event_id,
            actor_person_id, action, entity_type, entity_id, metadata_json, created_at
          )
          SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?,
                 'schedule.review_link.created', 'schedule_review_link', ?, ?, unixepoch()
           WHERE EXISTS (
             SELECT 1 FROM schedule_review_links
              WHERE id = ? AND organisation_id = ? AND event_id = ?
           )
        `,
        ).bind(
          auditEventId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          id,
          JSON.stringify({
            versionNumber: workspace.version.versionNumber,
            revision: parsed.scheduleRevision,
            expiresAt,
            entryCount: projection.entries.length,
          }),
          id,
          viewer.organisationId,
          viewer.eventId,
        ),
      ]);
    } catch (error) {
      const reused = await this.env.DB.prepare(
        `
          SELECT 1 AS present
            FROM schedule_review_links
           WHERE organisation_id = ? AND event_id = ? AND create_intent_id = ?
        `,
      )
        .bind(viewer.organisationId, viewer.eventId, parsed.createIntentId)
        .first();
      if (reused) throw new ScheduleReviewLinkIntentReusedError();
      throw error;
    }
    if ((inserted.meta.changes ?? 0) === 1) {
      if ((audit.meta.changes ?? 0) !== 1) {
        throw new Error("The draft review snapshot was not recorded in audit.");
      }
      return {
        id,
        token,
        path: scheduleReviewPreviewPath(token),
        expiresAt,
        entryCount: projection.entries.length,
        speakerNameCount: projection.entries.reduce(
          (total, entry) => total + entry.speakers.length,
          0,
        ),
      };
    }
    const reused = await this.env.DB.prepare(
      `
        SELECT 1 AS present
          FROM schedule_review_links
         WHERE organisation_id = ? AND event_id = ? AND create_intent_id = ?
      `,
    )
      .bind(viewer.organisationId, viewer.eventId, parsed.createIntentId)
      .first();
    if (reused) throw new ScheduleReviewLinkIntentReusedError();
    const current = await this.env.DB.prepare(
      `
        SELECT status, revision
          FROM schedule_versions
         WHERE id = ? AND event_id = ?
      `,
    )
      .bind(parsed.scheduleVersionId, viewer.eventId)
      .first<{ status: string; revision: number }>();
    if (current?.status !== "draft") {
      throw new ScheduleNotFoundError(
        "A draft schedule is required before creating a review snapshot.",
      );
    }
    if (current.revision !== parsed.scheduleRevision) {
      throw new ScheduleRevisionConflictError(
        "The schedule changed after this page loaded. Refresh before creating a review snapshot.",
      );
    }
    if (
      (await this.countActiveLinks(viewer)) >= SCHEDULE_REVIEW_LINK_ACTIVE_LIMIT
    ) {
      throw new ScheduleReviewLinkLimitError();
    }
    throw new ScheduleRevisionConflictError(
      "The schedule changed after this page loaded. Refresh before creating a review snapshot.",
    );
  }

  async revoke(viewer: Viewer, input: unknown) {
    requireAdministrator(viewer);
    const parsed = scheduleReviewLinkRevokeSchema.parse(input);
    const current = await this.env.DB.prepare(
      `
        SELECT schedule_version_id AS scheduleVersionId,
               schedule_revision AS scheduleRevision,
               version.version_number AS versionNumber,
               CASE
                 WHEN link.revoked_at IS NOT NULL THEN 'revoked'
                 WHEN link.expires_at <= unixepoch() THEN 'expired'
                 ELSE 'active'
               END AS status
          FROM schedule_review_links link
          LEFT JOIN schedule_versions version
            ON version.id = link.schedule_version_id
           AND version.event_id = link.event_id
         WHERE link.id = ? AND link.organisation_id = ? AND link.event_id = ?
      `,
    )
      .bind(parsed.linkId, viewer.organisationId, viewer.eventId)
      .first<{
        scheduleVersionId: string;
        scheduleRevision: number;
        versionNumber: number | null;
        status: "active" | "expired" | "revoked";
      }>();
    if (!current) throw new ScheduleReviewLinkNotFoundError();
    if (current.status === "revoked") {
      throw new ScheduleReviewLinkNotFoundError(
        "That draft review link has already been revoked.",
      );
    }
    if (current.status === "expired") {
      throw new ScheduleReviewLinkExpiredError();
    }
    const auditEventId = crypto.randomUUID();
    const [updated, audit] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
          UPDATE schedule_review_links
             SET revoked_at = unixepoch(),
                 revoked_by_person_id = ?,
                 revocation_reason = 'manual'
           WHERE id = ? AND organisation_id = ? AND event_id = ?
             AND revoked_at IS NULL
             AND expires_at > unixepoch()
        `,
      ).bind(
        viewer.personId,
        parsed.linkId,
        viewer.organisationId,
        viewer.eventId,
      ),
      this.env.DB.prepare(
        `
          INSERT INTO audit_events (
            id, actor_kind, origin, metadata_version, organisation_id, event_id,
            actor_person_id, action, entity_type, entity_id, metadata_json, created_at
          )
          SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?,
                 'schedule.review_link.revoked', 'schedule_review_link', ?, ?, unixepoch()
           WHERE EXISTS (
             SELECT 1 FROM schedule_review_links
              WHERE id = ? AND organisation_id = ? AND event_id = ?
                AND revocation_reason = 'manual'
                AND revoked_by_person_id = ?
           )
             AND NOT EXISTS (
               SELECT 1 FROM audit_events existing
                WHERE existing.organisation_id = ?
                  AND existing.event_id = ?
                  AND existing.action = 'schedule.review_link.revoked'
                  AND existing.entity_type = 'schedule_review_link'
                  AND existing.entity_id = ?
             )
        `,
      ).bind(
        auditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.linkId,
        JSON.stringify({
          reason: "manual",
          versionNumber: current.versionNumber ?? current.scheduleRevision,
          revision: current.scheduleRevision,
        }),
        parsed.linkId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        viewer.organisationId,
        viewer.eventId,
        parsed.linkId,
      ),
    ]);
    if ((updated.meta.changes ?? 0) !== 1) {
      const latest = await this.env.DB.prepare(
        `
          SELECT revoked_at AS revokedAt,
                 CASE WHEN expires_at <= unixepoch() THEN 1 ELSE 0 END AS expired
            FROM schedule_review_links
           WHERE id = ? AND organisation_id = ? AND event_id = ?
        `,
      )
        .bind(parsed.linkId, viewer.organisationId, viewer.eventId)
        .first<{ revokedAt: number | null; expired: number }>();
      if (latest?.revokedAt != null) {
        throw new ScheduleReviewLinkNotFoundError(
          "That draft review link has already been revoked.",
        );
      }
      if (latest?.expired === 1) {
        throw new ScheduleReviewLinkExpiredError();
      }
      throw new ScheduleReviewLinkNotFoundError();
    }
    if ((audit.meta.changes ?? 0) !== 1) {
      throw new Error("The draft review snapshot revocation was not recorded.");
    }
    return { id: parsed.linkId, revoked: true as const };
  }

  private async loadLivePreviewRow(token: string) {
    if (!isScheduleReviewToken(token)) return null;
    const tokenHash = await hashScheduleReviewToken(token);
    const row = await this.env.DB.prepare(
      `
        SELECT link.id, link.projection_json AS projectionJson
          FROM schedule_review_links link
          JOIN events event
            ON event.id = link.event_id
           AND event.organisation_id = link.organisation_id
         WHERE link.token_hash = ?
           AND link.revoked_at IS NULL
           AND link.expires_at > unixepoch()
           AND event.activation_status = 'active'
           AND event.participant_retention_completed_at IS NULL
      `,
    )
      .bind(tokenHash)
      .first<{ id: string; projectionJson: string }>();
    return row ?? null;
  }

  private parsedLiveProjection(row: { id: string; projectionJson: string }) {
    try {
      return parseScheduleReviewProjection(row.projectionJson);
    } catch {
      console.error(
        JSON.stringify({
          level: "error",
          subsystem: "schedule-review-preview",
          event: "projection-invalid",
          reviewLinkId: row.id,
        }),
      );
      return null;
    }
  }

  async readLivePreview(token: string): Promise<boolean> {
    const row = await this.loadLivePreviewRow(token);
    if (!row) return false;
    return this.parsedLiveProjection(row) !== null;
  }

  async loadPreviewProjection(
    token: string,
  ): Promise<ScheduleReviewProjection | null> {
    const row = await this.loadLivePreviewRow(token);
    if (!row) return null;
    return this.parsedLiveProjection(row);
  }
}

export { SCHEDULE_REVIEW_LINK_ACKNOWLEDGEMENT };
