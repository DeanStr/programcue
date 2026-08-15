import { z } from "zod";
import { ContentArchiveService } from "./content-archive-service.server";
import { ContentManagementStateError } from "./content-management-errors";
export { ContentManagementStateError } from "./content-management-errors";

import {
  AirtableProviderBoundary,
  airtableCommandKey,
} from "~/modules/airtable/airtable-provider-boundary.server";
import {
  ScheduleConfigurationError,
  ScheduleIdempotencyConflictError,
  ScheduleRevisionConflictError,
} from "~/modules/schedule/schedule-errors";
import { ScheduleService } from "~/modules/schedule/schedule-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  contentRestoreSchema,
  contentStatusChangeSchema,
  type ContentStatus,
} from "./content-schema";

const CONTENT_HISTORY_PAGE_SIZE = 50;
const FILE_LIBRARY_PAGE_SIZE = 50;

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

function contentRevisionChanges(
  revision: ContentRevisionRow,
  previous: ContentRevisionRow | undefined,
) {
  if (!previous) return [];
  const fields: Array<{
    label: string;
    before: string;
    after: string;
  }> = [
    { label: "Title", before: previous.title, after: revision.title },
    {
      label: "Description",
      before: previous.description ?? "No description",
      after: revision.description ?? "No description",
    },
    {
      label: "Track",
      before: previous.trackName ?? "No track",
      after: revision.trackName ?? "No track",
    },
    { label: "Format", before: previous.format, after: revision.format },
    {
      label: "Duration",
      before: `${previous.durationMinutes} minutes`,
      after: `${revision.durationMinutes} minutes`,
    },
    {
      label: "Visibility",
      before: previous.visibility,
      after: revision.visibility,
    },
    {
      label: "Content status",
      before: previous.contentStatus.replaceAll("_", " "),
      after: revision.contentStatus.replaceAll("_", " "),
    },
    {
      label: "Required resources",
      before: previous.requiredResourcesJson,
      after: revision.requiredResourcesJson,
    },
  ];
  return fields.filter((field) => field.before !== field.after);
}

type ContentApprovalProvenance = {
  sessionId: string;
  contentStatus: ContentStatus;
  approvedByPersonId: string | null;
  approvedByName: string | null;
  approvedAt: number | null;
  approvalSource: "editorial" | "legacy_publication" | null;
};

type ValidContentApprovalProvenance =
  | {
      contentStatus: "approved";
      approvedByPersonId: string;
      approvedByName: string;
      approvedAt: number;
      approvalSource: "editorial";
    }
  | {
      contentStatus: "approved";
      approvedByPersonId: null;
      approvedByName: null;
      approvedAt: number;
      approvalSource: "legacy_publication";
    }
  | {
      contentStatus: Exclude<ContentStatus, "approved">;
      approvedByPersonId: null;
      approvedByName: null;
      approvedAt: null;
      approvalSource: null;
    };

export function assertContentApprovalProvenance(
  content: ContentApprovalProvenance,
): asserts content is ContentApprovalProvenance &
  ValidContentApprovalProvenance {
  const editorialApprovalIsComplete =
    content.contentStatus === "approved" &&
    content.approvalSource === "editorial" &&
    content.approvedByPersonId !== null &&
    content.approvedByName !== null &&
    content.approvedAt !== null;
  const legacyApprovalIsComplete =
    content.contentStatus === "approved" &&
    content.approvalSource === "legacy_publication" &&
    content.approvedByPersonId === null &&
    content.approvedByName === null &&
    content.approvedAt !== null;
  const unapprovedStateIsComplete =
    content.contentStatus !== "approved" &&
    content.approvalSource === null &&
    content.approvedByPersonId === null &&
    content.approvedByName === null &&
    content.approvedAt === null;

  if (
    !editorialApprovalIsComplete &&
    !legacyApprovalIsComplete &&
    !unapprovedStateIsComplete
  ) {
    throw new ContentManagementStateError(
      `Session ${content.sessionId} has inconsistent approval provenance.`,
      500,
    );
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
  uploadedAt: number | null;
  current: boolean;
  latest: boolean;
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
  private readonly archive: ContentArchiveService;

  constructor(private readonly env: CloudflareEnvironment) {
    this.archive = new ContentArchiveService(env);
  }

  async getDashboard(viewer: Viewer, filePage = 1) {
    requireAdministrator(viewer);
    if (!Number.isSafeInteger(filePage) || filePage < 1) {
      throw new ContentManagementStateError(
        "The files page must be a positive integer.",
        400,
      );
    }
    const [event, version, sessions, assets, fileCount] = await Promise.all([
      this.env.DB.prepare(
        `SELECT timezone FROM events
          WHERE id = ? AND organisation_id = ?`,
      )
        .bind(viewer.eventId, viewer.organisationId)
        .first<{ timezone: string }>(),
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
                current.uploaded_at AS currentUploadedAt,
                (SELECT COUNT(*) FROM file_versions retained
                  WHERE retained.event_id = asset.event_id
                    AND retained.asset_id = asset.id
                    AND retained.deleted_at IS NULL) AS versionCount,
                (SELECT MAX(retained.version_number) FROM file_versions retained
                  WHERE retained.event_id = asset.event_id
                    AND retained.asset_id = asset.id
                    AND retained.deleted_at IS NULL) AS latestVersionNumber,
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
                  (SELECT MIN(session.title)
                     FROM task_instances task
                     JOIN session_speakers speaker
                       ON task.target_type = 'speaker'
                      AND speaker.person_id = task.target_id
                      AND speaker.event_id = task.event_id
                     JOIN sessions session
                       ON session.id = speaker.session_id
                      AND session.event_id = speaker.event_id
                    WHERE asset.target_type = 'task' AND task.id = asset.target_id
                      AND task.event_id = asset.event_id
                   HAVING COUNT(DISTINCT session.id) = 1),
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
            latestVersionNumber: number | null;
            currentFileVersionId: string | null;
            currentVersionNumber: number | null;
            currentFilename: string | null;
            currentSizeBytes: number | null;
            currentUploadStatus: string | null;
            currentSignatureStatus: string | null;
            currentScanStatus: string | null;
            currentReleasedAt: number | null;
            currentUploadedAt: number | null;
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
    if (!event) {
      throw new ContentManagementStateError(
        "The selected event is unavailable.",
        404,
      );
    }
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
      eventTimezone: event.timezone,
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
            currentUploadedAt,
            latestVersionNumber,
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
              latestVersionNumber === null
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
                  uploadedAt: currentUploadedAt,
                  current: true,
                  latest: currentVersionNumber === latestVersionNumber,
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
                version.uploaded_at AS uploadedAt,
                version.id = asset.current_version_id AS current,
                version.version_number = (
                  SELECT MAX(latest.version_number)
                    FROM file_versions latest
                   WHERE latest.event_id = version.event_id
                     AND latest.asset_id = version.asset_id
                     AND latest.deleted_at IS NULL
                ) AS latest
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
        .all<
          Omit<ContentFileVersion, "current" | "latest"> & {
            current: number;
            latest: number;
          }
        >(),
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
        .map(({ current, latest, ...version }) => ({
          ...version,
          current: Boolean(current),
          latest: Boolean(latest),
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
              content.approval_source AS approvalSource,
              content.approved_by_person_id AS approvedByPersonId,
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
        approvalSource: "editorial" | "legacy_publication" | null;
        approvedByPersonId: string | null;
        approvedByName: string | null;
      }>();
    if (!current) {
      throw new ContentManagementStateError(
        "Session content was not found.",
        404,
      );
    }
    assertContentApprovalProvenance(current);
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
      revisions: page.map((revision, index) => ({
        ...revision,
        changes: contentRevisionChanges(
          revision,
          revisions.results[index + 1],
        ),
      })),
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
                approval_source = CASE WHEN ? = 'approved' THEN 'editorial' ELSE NULL END,
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
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'session.content.status_changed', 'session', ?, ?,
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

  previewZip(viewer: Viewer, rawInput: unknown) {
    return this.archive.previewZip(viewer, rawInput);
  }

  downloadZip(viewer: Viewer, rawInput: unknown) {
    return this.archive.downloadZip(viewer, rawInput);
  }

  downloadCurrentFile(viewer: Viewer, assetId: string) {
    return this.archive.downloadCurrentFile(viewer, assetId);
  }

  downloadFileVersion(viewer: Viewer, assetId: string, versionId: string) {
    return this.archive.downloadFileVersion(viewer, assetId, versionId);
  }
}
