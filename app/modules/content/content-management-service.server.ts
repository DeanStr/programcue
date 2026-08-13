import { z } from "zod";

import {
  AirtableProviderBoundary,
  airtableCommandKey,
} from "~/modules/airtable/airtable-provider-boundary.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { safeDownloadName } from "~/modules/files/file-policy";
import { ScheduleService } from "~/modules/schedule/schedule-service.server";
import {
  ScheduleConfigurationError,
  ScheduleIdempotencyConflictError,
  ScheduleRevisionConflictError,
} from "~/modules/schedule/schedule-errors";
import {
  contentRestoreSchema,
  contentStatusChangeSchema,
  contentZipConfirmSchema,
  contentZipPreviewSchema,
  type ContentStatus,
} from "./content-schema";
import {
  createStoredZipStream,
  type StoredZipEntry,
} from "./zip-stream.server";

const MAX_ZIP_BYTES = 100 * 1024 * 1024;
const CONTENT_HISTORY_PAGE_SIZE = 50;
const FILE_LIBRARY_PAGE_SIZE = 50;

const zipManifestEntrySchema = z.object({
  assetId: z.string().min(1).max(160),
  versionId: z.string().min(1).max(160),
  objectEtag: z.string().min(1).max(300),
  sizeBytes: z.number().int().nonnegative().max(MAX_ZIP_BYTES),
  filename: z.string().min(1).max(500),
  sessionName: z.string().min(1).max(300),
  speakerName: z.string().min(1).max(300),
  createdAt: z.number().int().positive(),
});

const zipManifestSchema = z.array(zipManifestEntrySchema).min(1).max(20);

type ContentRevisionRow = {
  id: string;
  scheduleVersionId: string;
  scheduleVersionNumber: number;
  scheduleVersionStatus: string;
  revisionNumber: number;
  title: string;
  slug: string;
  description: string | null;
  trackId: string | null;
  trackName: string | null;
  format: string;
  durationMinutes: number;
  requiredResourcesJson: string;
  visibility: "public" | "private" | "hidden";
  contentStatus: ContentStatus;
  changeKind: "baseline" | "edit" | "status" | "restore";
  restoredFromRevisionId: string | null;
  editorName: string | null;
  createdAt: number;
};

export class ContentManagementStateError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

function requireAdministrator(viewer: Viewer) {
  if (viewer.role !== "owner" && viewer.role !== "administrator") {
    throw new ContentManagementStateError(
      "Administrator access is required.",
      403,
    );
  }
}

function parseResources(value: string, revisionId: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(
      `Content revision ${revisionId} has invalid resource JSON.`,
    );
  }
  const result = z.array(z.string().min(1).max(120)).max(50).safeParse(parsed);
  if (!result.success || new Set(result.data).size !== result.data.length) {
    throw new Error(
      `Content revision ${revisionId} has invalid required resources.`,
    );
  }
  return result.data;
}

function safeZipSegment(value: string) {
  return (
    value
      .normalize("NFKC")
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
      .replace(/\.{2,}/g, ".")
      .trim()
      .slice(0, 100) || "Unassigned"
  );
}

function duplicateZipPath(group: string, filename: string, suffix: string) {
  const extensionIndex = filename.lastIndexOf(".");
  const suffixedFilename =
    extensionIndex > 0 && extensionIndex < filename.length - 1
      ? `${filename.slice(0, extensionIndex)}-${suffix}${filename.slice(extensionIndex)}`
      : `${filename}-${suffix}`;
  return `${group}/${suffixedFilename}`;
}

function uniqueZipPath(
  paths: ReadonlySet<string>,
  group: string,
  filename: string,
  assetSuffix: string,
) {
  const base = `${group}/${filename}`;
  if (!paths.has(base)) return base;
  let candidate = duplicateZipPath(group, filename, assetSuffix);
  let collision = 2;
  while (paths.has(candidate)) {
    candidate = duplicateZipPath(
      group,
      filename,
      `${assetSuffix}-${collision}`,
    );
    collision += 1;
  }
  return candidate;
}

function parseHistoryCursor(value: string | null) {
  if (value === null) return null;
  const match = /^(\d+):(\d+)$/.exec(value);
  const scheduleVersionNumber = Number(match?.[1]);
  const revisionNumber = Number(match?.[2]);
  if (
    !Number.isSafeInteger(scheduleVersionNumber) ||
    scheduleVersionNumber < 1 ||
    !Number.isSafeInteger(revisionNumber) ||
    revisionNumber < 1
  ) {
    throw new ContentManagementStateError(
      "The content history cursor is invalid.",
      400,
    );
  }
  return { scheduleVersionNumber, revisionNumber };
}

export type ContentFileVersion = {
  id: string;
  versionNumber: number;
  filename: string;
  sizeBytes: number;
  uploadStatus: string;
  signatureStatus: string;
  scanStatus: string;
  releasedAt: number | null;
  createdAt: number;
  current: boolean;
};

export type ContentFileAsset = {
  id: string;
  targetType: string;
  targetId: string;
  assetKind: string;
  status: string;
  ownerPersonId: string | null;
  speakerName: string;
  sessionName: string;
  currentVersionId: string | null;
  versionCount: number;
  versions: ContentFileVersion[];
};

export class ContentManagementService {
  constructor(private readonly env: CloudflareEnvironment) {}

  private requireBucket() {
    if (!this.env.FILES) {
      throw new Error("Required private R2 binding FILES is unavailable.");
    }
    return this.env.FILES;
  }

  async getDashboard(viewer: Viewer, filePage = 1) {
    requireAdministrator(viewer);
    if (!Number.isSafeInteger(filePage) || filePage < 1) {
      throw new ContentManagementStateError(
        "The files page must be a positive integer.",
        400,
      );
    }
    const [version, sessions, assets, fileCount] = await Promise.all([
      this.env.DB.prepare(
        `SELECT version.id, version.version_number AS versionNumber,
                version.status, version.revision
           FROM schedule_versions version
           JOIN events event
             ON event.id = version.event_id AND event.organisation_id = ?
          WHERE version.event_id = ?
            AND version.status IN ('draft','published')
          ORDER BY CASE version.status WHEN 'draft' THEN 0 ELSE 1 END,
                   version.version_number DESC
          LIMIT 1`,
      )
        .bind(viewer.organisationId, viewer.eventId)
        .first<{
          id: string;
          versionNumber: number;
          status: string;
          revision: number;
        }>(),
      this.env.DB.prepare(
        `SELECT content.session_id AS sessionId, content.title,
                content.content_status AS contentStatus,
                content.content_revision AS contentRevision,
                content.visibility, content.updated_at AS updatedAt,
                GROUP_CONCAT(person.display_name, '||') AS speakerNames,
                EXISTS (
                  SELECT 1 FROM schedule_entries entry
                   WHERE entry.event_id = content.event_id
                     AND entry.schedule_version_id = content.schedule_version_id
                     AND entry.session_id = content.session_id
                ) AS scheduled
           FROM schedule_session_contents content
           JOIN schedule_versions version
             ON version.id = content.schedule_version_id
            AND version.event_id = content.event_id
           JOIN events event
             ON event.id = content.event_id AND event.organisation_id = ?
           LEFT JOIN session_speakers relation
             ON relation.event_id = content.event_id
            AND relation.session_id = content.session_id
           LEFT JOIN people person ON person.id = relation.person_id
          WHERE content.event_id = ?
            AND version.status IN ('draft','published')
            AND version.id = (
              SELECT active.id FROM schedule_versions active
               WHERE active.event_id = content.event_id
                 AND active.status IN ('draft','published')
               ORDER BY CASE active.status WHEN 'draft' THEN 0 ELSE 1 END,
                        active.version_number DESC LIMIT 1
            )
          GROUP BY content.schedule_version_id, content.session_id
          ORDER BY content.title COLLATE NOCASE, content.session_id`,
      )
        .bind(viewer.organisationId, viewer.eventId)
        .all<{
          sessionId: string;
          title: string;
          contentStatus: ContentStatus;
          contentRevision: number;
          visibility: string;
          updatedAt: number;
          speakerNames: string | null;
          scheduled: number;
        }>(),
      this.env.DB.prepare(
        `SELECT asset.id, asset.target_type AS targetType,
                asset.target_id AS targetId, asset.asset_kind AS assetKind,
                asset.status, asset.owner_person_id AS ownerPersonId,
                asset.current_version_id AS currentVersionId,
                current.id AS currentFileVersionId,
                current.version_number AS currentVersionNumber,
                current.original_filename AS currentFilename,
                current.size_bytes AS currentSizeBytes,
                current.upload_status AS currentUploadStatus,
                current.signature_status AS currentSignatureStatus,
                current.scan_status AS currentScanStatus,
                current.released_at AS currentReleasedAt,
                current.created_at AS currentCreatedAt,
                (SELECT COUNT(*) FROM file_versions retained
                  WHERE retained.event_id = asset.event_id
                    AND retained.asset_id = asset.id
                    AND retained.deleted_at IS NULL) AS versionCount,
                COALESCE(owner.display_name, (
                  SELECT person.display_name
                    FROM task_instances task
                    JOIN people person ON person.id = task.owner_person_id
                   WHERE asset.target_type = 'task' AND task.id = asset.target_id
                     AND task.event_id = asset.event_id
                ), 'Unknown speaker') AS speakerName,
                COALESCE(
                  (SELECT session.title FROM sessions session
                    WHERE asset.target_type = 'session'
                      AND session.id = asset.target_id
                      AND session.event_id = asset.event_id),
                  (SELECT session.title
                     FROM task_instances task
                     JOIN sessions session
                       ON task.target_type = 'session'
                      AND session.id = task.target_id
                      AND session.event_id = task.event_id
                    WHERE asset.target_type = 'task' AND task.id = asset.target_id
                      AND task.event_id = asset.event_id),
                  (SELECT session.title FROM sessions session
                    WHERE asset.target_type = 'submission'
                      AND session.source_submission_id = asset.target_id
                      AND session.event_id = asset.event_id
                    ORDER BY session.created_at LIMIT 1),
                  'Unassigned'
                ) AS sessionName
           FROM file_assets asset
           JOIN events event
             ON event.id = asset.event_id AND event.organisation_id = ?
           LEFT JOIN people owner ON owner.id = asset.owner_person_id
           LEFT JOIN file_versions current
             ON current.id = asset.current_version_id
            AND current.event_id = asset.event_id
            AND current.asset_id = asset.id
            AND current.deleted_at IS NULL
          WHERE asset.event_id = ? AND asset.status <> 'deleted'
          ORDER BY asset.updated_at DESC, asset.id
          LIMIT ? OFFSET ?`,
      )
        .bind(
          viewer.organisationId,
          viewer.eventId,
          FILE_LIBRARY_PAGE_SIZE + 1,
          (filePage - 1) * FILE_LIBRARY_PAGE_SIZE,
        )
        .all<
          Omit<ContentFileAsset, "versions" | "versionCount"> & {
            versionCount: number;
            currentFileVersionId: string | null;
            currentVersionNumber: number | null;
            currentFilename: string | null;
            currentSizeBytes: number | null;
            currentUploadStatus: string | null;
            currentSignatureStatus: string | null;
            currentScanStatus: string | null;
            currentReleasedAt: number | null;
            currentCreatedAt: number | null;
          }
        >(),
      this.env.DB.prepare(
        `SELECT COUNT(*) AS total
           FROM file_assets asset
           JOIN events event
             ON event.id = asset.event_id AND event.organisation_id = ?
          WHERE asset.event_id = ? AND asset.status <> 'deleted'`,
      )
        .bind(viewer.organisationId, viewer.eventId)
        .first<{ total: number }>(),
    ]);
    if (
      !fileCount ||
      !Number.isSafeInteger(fileCount.total) ||
      fileCount.total < 0
    ) {
      throw new Error(
        "The file library count query returned an invalid result.",
      );
    }
    const totalFiles = fileCount.total;
    if (filePage > 1 && assets.results.length === 0) {
      throw new ContentManagementStateError(
        "The requested files page does not exist.",
        404,
      );
    }
    return {
      version: version ?? null,
      sessions: sessions.results.map((session) => ({
        ...session,
        scheduled: Boolean(session.scheduled),
        speakerNames: session.speakerNames?.split("||") ?? [],
      })),
      files: assets.results
        .slice(0, FILE_LIBRARY_PAGE_SIZE)
        .map(
          ({
            currentFileVersionId,
            currentVersionNumber,
            currentFilename,
            currentSizeBytes,
            currentUploadStatus,
            currentSignatureStatus,
            currentScanStatus,
            currentReleasedAt,
            currentCreatedAt,
            ...asset
          }) => {
            if (asset.currentVersionId === null) {
              return { ...asset, versions: [] };
            }
            if (
              currentFileVersionId !== asset.currentVersionId ||
              currentVersionNumber === null ||
              currentFilename === null ||
              currentSizeBytes === null ||
              currentUploadStatus === null ||
              currentSignatureStatus === null ||
              currentScanStatus === null ||
              currentCreatedAt === null
            ) {
              throw new Error(
                `File asset ${asset.id} references unavailable current version ${asset.currentVersionId}.`,
              );
            }
            return {
              ...asset,
              versions: [
                {
                  id: currentFileVersionId,
                  versionNumber: currentVersionNumber,
                  filename: currentFilename,
                  sizeBytes: currentSizeBytes,
                  uploadStatus: currentUploadStatus,
                  signatureStatus: currentSignatureStatus,
                  scanStatus: currentScanStatus,
                  releasedAt: currentReleasedAt,
                  createdAt: currentCreatedAt,
                  current: true,
                },
              ],
            };
          },
        ),
      filesPagination: {
        page: filePage,
        pageSize: FILE_LIBRARY_PAGE_SIZE,
        total: totalFiles,
        hasPrevious: filePage > 1,
        hasNext: assets.results.length > FILE_LIBRARY_PAGE_SIZE,
      },
    };
  }

  async getFileVersions(viewer: Viewer, assetId: string, page = 1) {
    requireAdministrator(viewer);
    if (!Number.isSafeInteger(page) || page < 1) {
      throw new ContentManagementStateError(
        "The file-version page must be a positive integer.",
        400,
      );
    }
    const [asset, versions] = await Promise.all([
      this.env.DB.prepare(
        `SELECT COUNT(version.id) AS total
           FROM file_assets asset
           JOIN events event
             ON event.id = asset.event_id AND event.organisation_id = ?
           LEFT JOIN file_versions version
             ON version.asset_id = asset.id
            AND version.event_id = asset.event_id
            AND version.deleted_at IS NULL
          WHERE asset.id = ? AND asset.event_id = ?
            AND asset.status <> 'deleted'
          GROUP BY asset.id`,
      )
        .bind(viewer.organisationId, assetId, viewer.eventId)
        .first<{ total: number }>(),
      this.env.DB.prepare(
        `SELECT version.id, version.version_number AS versionNumber,
                version.original_filename AS filename,
                version.size_bytes AS sizeBytes,
                version.upload_status AS uploadStatus,
                version.signature_status AS signatureStatus,
                version.scan_status AS scanStatus,
                version.released_at AS releasedAt,
                version.created_at AS createdAt,
                version.id = asset.current_version_id AS current
           FROM file_versions version
           JOIN file_assets asset
             ON asset.id = version.asset_id AND asset.event_id = version.event_id
           JOIN events event
             ON event.id = version.event_id AND event.organisation_id = ?
          WHERE version.event_id = ? AND version.asset_id = ?
            AND version.deleted_at IS NULL AND asset.status <> 'deleted'
          ORDER BY version.version_number DESC, version.id
          LIMIT ? OFFSET ?`,
      )
        .bind(
          viewer.organisationId,
          viewer.eventId,
          assetId,
          FILE_LIBRARY_PAGE_SIZE + 1,
          (page - 1) * FILE_LIBRARY_PAGE_SIZE,
        )
        .all<Omit<ContentFileVersion, "current"> & { current: number }>(),
    ]);
    if (!asset) {
      throw new ContentManagementStateError(
        "The file asset is unavailable or outside this event.",
        404,
      );
    }
    if (page > 1 && versions.results.length === 0) {
      throw new ContentManagementStateError(
        "The requested file-version page does not exist.",
        404,
      );
    }
    return {
      versions: versions.results
        .slice(0, FILE_LIBRARY_PAGE_SIZE)
        .map(({ current, ...version }) => ({
          ...version,
          current: Boolean(current),
        })),
      page,
      total: asset.total,
      hasPrevious: page > 1,
      hasNext: versions.results.length > FILE_LIBRARY_PAGE_SIZE,
    };
  }

  async getSession(
    viewer: Viewer,
    sessionId: string,
    historyCursor: string | null = null,
  ) {
    requireAdministrator(viewer);
    const cursor = parseHistoryCursor(historyCursor);
    const current = await this.env.DB.prepare(
      `SELECT content.schedule_version_id AS scheduleVersionId,
              version.version_number AS scheduleVersionNumber,
              version.status AS scheduleVersionStatus,
              version.revision AS scheduleRevision,
              event.timezone,
              content.session_id AS sessionId, content.title,
              content.description, content.content_status AS contentStatus,
              content.content_revision AS contentRevision,
              content.visibility, content.approved_at AS approvedAt,
              approver.display_name AS approvedByName
         FROM schedule_session_contents content
         JOIN schedule_versions version
           ON version.id = content.schedule_version_id
          AND version.event_id = content.event_id
         JOIN events event
           ON event.id = content.event_id AND event.organisation_id = ?
         LEFT JOIN people approver ON approver.id = content.approved_by_person_id
        WHERE content.event_id = ? AND content.session_id = ?
          AND version.status IN ('draft','published')
        ORDER BY CASE version.status WHEN 'draft' THEN 0 ELSE 1 END,
                 version.version_number DESC LIMIT 1`,
    )
      .bind(viewer.organisationId, viewer.eventId, sessionId)
      .first<{
        scheduleVersionId: string;
        scheduleVersionNumber: number;
        scheduleVersionStatus: string;
        scheduleRevision: number;
        timezone: string;
        sessionId: string;
        title: string;
        description: string | null;
        contentStatus: ContentStatus;
        contentRevision: number;
        visibility: string;
        approvedAt: number | null;
        approvedByName: string | null;
      }>();
    if (!current) {
      throw new ContentManagementStateError(
        "Session content was not found.",
        404,
      );
    }
    const revisions = await this.env.DB.prepare(
      `SELECT revision.id, revision.schedule_version_id AS scheduleVersionId,
              version.version_number AS scheduleVersionNumber,
              version.status AS scheduleVersionStatus,
              revision.revision_number AS revisionNumber,
              revision.title, revision.slug, revision.description,
              revision.track_id AS trackId, track.name AS trackName,
              revision.format, revision.duration_minutes AS durationMinutes,
              revision.required_resources_json AS requiredResourcesJson,
              revision.visibility, revision.content_status AS contentStatus,
              revision.change_kind AS changeKind,
              revision.restored_from_revision_id AS restoredFromRevisionId,
              editor.display_name AS editorName,
              revision.created_at AS createdAt
         FROM session_content_revisions revision
         JOIN schedule_versions version
           ON version.id = revision.schedule_version_id
          AND version.event_id = revision.event_id
         JOIN events event
           ON event.id = revision.event_id AND event.organisation_id = ?
         LEFT JOIN people editor ON editor.id = revision.created_by_person_id
         LEFT JOIN tracks track
           ON track.id = revision.track_id AND track.event_id = revision.event_id
        WHERE revision.event_id = ? AND revision.session_id = ?
          ${
            cursor
              ? `AND (
                   version.version_number < ?
                   OR (
                     version.version_number = ?
                     AND revision.revision_number < ?
                   )
                 )`
              : ""
          }
        ORDER BY version.version_number DESC, revision.revision_number DESC
        LIMIT ?`,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        sessionId,
        ...(cursor
          ? [
              cursor.scheduleVersionNumber,
              cursor.scheduleVersionNumber,
              cursor.revisionNumber,
            ]
          : []),
        CONTENT_HISTORY_PAGE_SIZE + 1,
      )
      .all<ContentRevisionRow>();
    const page = revisions.results.slice(0, CONTENT_HISTORY_PAGE_SIZE);
    const last = page.at(-1);
    return {
      current,
      revisions: page,
      nextHistoryCursor:
        revisions.results.length > CONTENT_HISTORY_PAGE_SIZE && last
          ? `${last.scheduleVersionNumber}:${last.revisionNumber}`
          : null,
    };
  }

  async changeStatus(viewer: Viewer, rawInput: unknown) {
    requireAdministrator(viewer);
    const input = contentStatusChangeSchema.parse(rawInput);
    const operation = "content.session_status.change";
    const idempotencyKey = await airtableCommandKey(operation, viewer, input);
    return new AirtableProviderBoundary(this.env).executeIdempotent(
      {
        organisationId: viewer.organisationId,
        eventId: viewer.eventId,
        personId: viewer.personId,
      },
      { idempotencyKey, operation },
      () => this.changeStatusD1(viewer, input),
    );
  }

  private async changeStatusD1(
    viewer: Viewer,
    input: ReturnType<typeof contentStatusChangeSchema.parse>,
  ) {
    const current = await this.env.DB.prepare(
      `SELECT event.revision AS eventRevision, content.title,
              content.description, content.visibility,
              content.content_status AS contentStatus
         FROM schedule_session_contents content
         JOIN schedule_versions version
           ON version.id = content.schedule_version_id
          AND version.event_id = content.event_id AND version.status = 'draft'
         JOIN events event
           ON event.id = content.event_id AND event.organisation_id = ?
        WHERE content.event_id = ? AND content.schedule_version_id = ?
          AND content.session_id = ? AND version.revision = ?
          AND content.content_revision = ?`,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        input.scheduleVersionId,
        input.sessionId,
        input.scheduleRevision,
        input.contentRevision,
      )
      .first<{
        eventRevision: number;
        title: string;
        description: string | null;
        visibility: "public" | "private" | "hidden";
        contentStatus: ContentStatus;
      }>();
    if (!current) {
      throw new ContentManagementStateError(
        "The draft content changed after this review loaded. Refresh before changing its status.",
      );
    }
    if (input.status === current.contentStatus) {
      throw new ContentManagementStateError(
        `This content is already ${input.status.replaceAll("_", " ")}.`,
      );
    }
    if (input.status === "approved" && !current.title.trim()) {
      throw new ContentManagementStateError(
        "Approved content requires a title.",
        422,
      );
    }
    if (
      input.status === "approved" &&
      current.visibility === "public" &&
      !current.description?.trim()
    ) {
      throw new ContentManagementStateError(
        "Approved public content requires both a title and description.",
        422,
      );
    }
    const operationId = crypto.randomUUID();
    const historyId = crypto.randomUUID();
    const auditId = crypto.randomUUID();
    const nextContentRevision = input.contentRevision + 1;
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE events SET revision = revision + 1,
                last_operation_id = ?, last_updated_by_person_id = ?,
                updated_at = unixepoch()
          WHERE id = ? AND organisation_id = ? AND revision = ?`,
      ).bind(
        operationId,
        viewer.personId,
        viewer.eventId,
        viewer.organisationId,
        current.eventRevision,
      ),
      this.env.DB.prepare(
        `UPDATE schedule_versions SET revision = revision + 1,
                publication_operation_id = ?
          WHERE id = ? AND event_id = ? AND status = 'draft' AND revision = ?
            AND EXISTS (SELECT 1 FROM events WHERE id = ?
              AND organisation_id = ? AND last_operation_id = ?)`,
      ).bind(
        operationId,
        input.scheduleVersionId,
        viewer.eventId,
        input.scheduleRevision,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `UPDATE schedule_session_contents
            SET content_status = ?, content_revision = content_revision + 1,
                last_edited_by_person_id = ?,
                approved_by_person_id = CASE WHEN ? = 'approved' THEN ? ELSE NULL END,
                approved_at = CASE WHEN ? = 'approved' THEN unixepoch() ELSE NULL END,
                last_operation_id = ?, updated_at = unixepoch()
          WHERE schedule_version_id = ? AND event_id = ? AND session_id = ?
            AND content_revision = ?
            AND EXISTS (SELECT 1 FROM schedule_versions
              WHERE id = schedule_session_contents.schedule_version_id
                AND event_id = schedule_session_contents.event_id
                AND status = 'draft' AND publication_operation_id = ?)`,
      ).bind(
        input.status,
        viewer.personId,
        input.status,
        viewer.personId,
        input.status,
        operationId,
        input.scheduleVersionId,
        viewer.eventId,
        input.sessionId,
        input.contentRevision,
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO session_content_revisions (
           id, event_id, schedule_version_id, session_id, revision_number,
           title, slug, description, track_id, format, duration_minutes,
           required_resources_json, visibility, content_status, change_kind,
           created_by_person_id, created_at
         )
         SELECT ?, event_id, schedule_version_id, session_id, content_revision,
                title, slug, description, track_id, format, duration_minutes,
                required_resources_json, visibility, content_status, 'status',
                ?, unixepoch()
           FROM schedule_session_contents
          WHERE schedule_version_id = ? AND event_id = ? AND session_id = ?
            AND last_operation_id = ? AND content_revision = ?`,
      ).bind(
        historyId,
        viewer.personId,
        input.scheduleVersionId,
        viewer.eventId,
        input.sessionId,
        operationId,
        nextContentRevision,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, ?, 'session.content.status_changed', 'session', ?, ?,
                unixepoch()
          WHERE EXISTS (SELECT 1 FROM session_content_revisions WHERE id = ?)`,
      ).bind(
        auditId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        input.sessionId,
        JSON.stringify({
          from: current.contentStatus,
          to: input.status,
          contentRevision: nextContentRevision,
        }),
        historyId,
      ),
    ]);
    if (results.some((result) => (result.meta.changes ?? 0) !== 1)) {
      throw new ContentManagementStateError(
        "The draft content changed while its status was being updated. Refresh before trying again.",
      );
    }
    return {
      sessionId: input.sessionId,
      status: input.status,
      contentRevision: nextContentRevision,
      scheduleRevision: input.scheduleRevision + 1,
    };
  }

  async restoreRevision(viewer: Viewer, rawInput: unknown) {
    requireAdministrator(viewer);
    const input = contentRestoreSchema.parse(rawInput);
    const [workspace, revision] = await Promise.all([
      new ScheduleService(this.env).getWorkspace(viewer),
      this.env.DB.prepare(
        `SELECT revision.id, revision.title, revision.description,
                revision.track_id AS trackId, revision.format,
                revision.duration_minutes AS durationMinutes,
                revision.required_resources_json AS requiredResourcesJson,
                revision.visibility
           FROM session_content_revisions revision
           JOIN events event
             ON event.id = revision.event_id AND event.organisation_id = ?
          WHERE revision.id = ? AND revision.event_id = ?
            AND revision.session_id = ?`,
      )
        .bind(
          viewer.organisationId,
          input.revisionId,
          viewer.eventId,
          input.sessionId,
        )
        .first<{
          id: string;
          title: string;
          description: string | null;
          trackId: string | null;
          format: string;
          durationMinutes: number;
          requiredResourcesJson: string;
          visibility: "public" | "private" | "hidden";
        }>(),
    ]);
    if (!revision) {
      throw new ContentManagementStateError(
        "Content revision was not found.",
        404,
      );
    }
    if (!workspace.version || workspace.version.status !== "draft") {
      throw new ContentManagementStateError(
        "Create a draft schedule before restoring content.",
      );
    }
    const session = workspace.sessions.find(
      (candidate) => candidate.id === input.sessionId,
    );
    if (!session) {
      throw new ContentManagementStateError("Session was not found.", 404);
    }
    if (
      workspace.version.id !== input.scheduleVersionId ||
      workspace.version.revision !== input.scheduleRevision ||
      session.contentRevision !== input.contentRevision
    ) {
      throw new ContentManagementStateError(
        "The draft content changed after this history page loaded. Refresh before restoring a revision.",
      );
    }
    try {
      return await new ScheduleService(this.env).restoreSessionContent(
        viewer,
        {
          scheduleVersionId: input.scheduleVersionId,
          scheduleRevision: input.scheduleRevision,
          sessionId: session.id,
          sessionRevision: session.revision,
          idempotencyKey: crypto.randomUUID(),
          title: revision.title,
          description: revision.description ?? "",
          format: revision.format,
          durationMinutes: revision.durationMinutes,
          trackId: revision.trackId,
          visibility: revision.visibility,
          requiredResources: parseResources(
            revision.requiredResourcesJson,
            revision.id,
          ),
        },
        revision.id,
      );
    } catch (error) {
      if (
        error instanceof ScheduleRevisionConflictError ||
        error instanceof ScheduleIdempotencyConflictError
      ) {
        throw new ContentManagementStateError(error.message);
      }
      if (error instanceof ScheduleConfigurationError) {
        throw new ContentManagementStateError(error.message, 422);
      }
      throw error;
    }
  }

  private async zipRows(viewer: Viewer, assetIds: string[]) {
    const placeholders = assetIds.map(() => "?").join(", ");
    return this.env.DB.prepare(
      `SELECT asset.id AS assetId, version.id AS versionId,
              version.object_key AS objectKey,
              version.object_etag AS objectEtag,
              version.size_bytes AS sizeBytes,
              version.original_filename AS filename,
              version.created_at AS createdAt,
              COALESCE(owner.display_name, 'Unknown speaker') AS speakerName,
              COALESCE(
                (SELECT session.title FROM sessions session
                  WHERE asset.target_type = 'session'
                    AND session.id = asset.target_id
                    AND session.event_id = asset.event_id),
                (SELECT session.title
                   FROM task_instances task
                   JOIN sessions session
                     ON task.target_type = 'session'
                    AND session.id = task.target_id
                    AND session.event_id = task.event_id
                  WHERE asset.target_type = 'task' AND task.id = asset.target_id
                    AND task.event_id = asset.event_id),
                (SELECT session.title FROM sessions session
                  WHERE asset.target_type = 'submission'
                    AND session.source_submission_id = asset.target_id
                    AND session.event_id = asset.event_id
                  ORDER BY session.created_at LIMIT 1),
                'Unassigned'
              ) AS sessionName
         FROM file_assets asset
         JOIN events event
           ON event.id = asset.event_id AND event.organisation_id = ?
         JOIN file_versions version
           ON version.id = asset.current_version_id
          AND version.event_id = asset.event_id AND version.asset_id = asset.id
         LEFT JOIN people owner ON owner.id = asset.owner_person_id
        WHERE asset.event_id = ? AND asset.id IN (${placeholders})
          AND asset.status = 'active'
          AND version.upload_status = 'uploaded'
          AND version.signature_status = 'valid'
          AND version.scan_status = 'clean'
          AND version.released_at IS NOT NULL
          AND version.deleted_at IS NULL AND version.object_etag IS NOT NULL
        ORDER BY asset.id`,
    )
      .bind(viewer.organisationId, viewer.eventId, ...assetIds)
      .all<z.infer<typeof zipManifestEntrySchema> & { objectKey: string }>();
  }

  async previewZip(viewer: Viewer, rawInput: unknown) {
    requireAdministrator(viewer);
    const input = contentZipPreviewSchema.parse(rawInput);
    if (new Set(input.assetIds).size !== input.assetIds.length) {
      throw new ContentManagementStateError(
        "Choose each file only once before preparing an export.",
        422,
      );
    }
    const rows = await this.zipRows(viewer, input.assetIds);
    if (rows.results.length !== input.assetIds.length) {
      throw new ContentManagementStateError(
        "Every selected file must have a current released, clean version before export.",
        422,
      );
    }
    const totalBytes = rows.results.reduce(
      (sum, row) => sum + row.sizeBytes,
      0,
    );
    if (totalBytes > MAX_ZIP_BYTES) {
      throw new ContentManagementStateError(
        "The selected current versions exceed the 100 MB ZIP export limit.",
        422,
      );
    }
    const manifest = rows.results.map(
      ({ objectKey: _objectKey, ...row }) => row,
    );
    return {
      groupBy: input.groupBy,
      entries: manifest,
      totalBytes,
      manifest: JSON.stringify(manifest),
    };
  }

  async downloadZip(viewer: Viewer, rawInput: unknown) {
    requireAdministrator(viewer);
    const input = contentZipConfirmSchema.parse(rawInput);
    let decoded: unknown;
    try {
      decoded = JSON.parse(input.manifest);
    } catch {
      throw new ContentManagementStateError("The ZIP preview is invalid.", 422);
    }
    const expected = zipManifestSchema.parse(decoded);
    const rows = await this.zipRows(
      viewer,
      expected.map((entry) => entry.assetId),
    );
    const current = rows.results.map(
      ({ objectKey: _objectKey, ...row }) => row,
    );
    const unchanged =
      current.length === expected.length &&
      current.every((row, index) => {
        const prior = expected[index];
        return (
          prior !== undefined &&
          row.assetId === prior.assetId &&
          row.versionId === prior.versionId &&
          row.objectEtag === prior.objectEtag &&
          row.sizeBytes === prior.sizeBytes &&
          row.filename === prior.filename &&
          row.sessionName === prior.sessionName &&
          row.speakerName === prior.speakerName &&
          row.createdAt === prior.createdAt
        );
      });
    if (!unchanged) {
      throw new ContentManagementStateError(
        "One or more selected files changed after preview. Prepare a fresh ZIP preview.",
      );
    }
    const totalBytes = expected.reduce((sum, row) => sum + row.sizeBytes, 0);
    if (totalBytes > MAX_ZIP_BYTES) {
      throw new ContentManagementStateError(
        "The selected current versions exceed the 100 MB ZIP export limit.",
        422,
      );
    }
    const bucket = this.requireBucket();
    const paths = new Set<string>();
    const entries: StoredZipEntry[] = [];
    for (const row of rows.results) {
      const object = await bucket.get(row.objectKey);
      if (
        !object ||
        object.httpEtag !== row.objectEtag ||
        object.size !== row.sizeBytes
      ) {
        throw new ContentManagementStateError(
          `Private file ${row.filename} is missing or no longer matches its released version.`,
        );
      }
      const group = safeZipSegment(
        input.groupBy === "session" ? row.sessionName : row.speakerName,
      );
      const filename = safeZipSegment(row.filename);
      const path = uniqueZipPath(
        paths,
        group,
        filename,
        row.assetId.slice(-8),
      );
      paths.add(path);
      entries.push({ path, object, modifiedAt: row.createdAt });
    }
    return new Response(createStoredZipStream(entries), {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${safeDownloadName(`programme-files-by-${input.groupBy}.zip`)}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }

  async downloadCurrentFile(viewer: Viewer, assetId: string) {
    requireAdministrator(viewer);
    const rows = await this.zipRows(viewer, [assetId]);
    const row = rows.results[0];
    if (!row) {
      throw new ContentManagementStateError(
        "The current file is unavailable, quarantined or outside this event.",
        404,
      );
    }
    const object = await this.requireBucket().get(row.objectKey);
    if (
      !object ||
      object.httpEtag !== row.objectEtag ||
      object.size !== row.sizeBytes
    ) {
      throw new Error(
        "The released private R2 object is missing or no longer matches its scanned version.",
      );
    }
    return new Response(object.body, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${safeDownloadName(row.filename)}"`,
        "content-length": String(object.size),
        etag: row.objectEtag,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
}
