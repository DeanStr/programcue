import type { Viewer } from "~/platform/auth/authorize.server";
import { scheduleConflictInsert } from "./schedule-conflict-statement.server";
import { ScheduleIdempotencyConflictError } from "./schedule-errors";
import {
  type ContentApprovalSource,
  parseSchedulePlacementResult,
} from "./schedule-placement-evidence";
import type { ScheduleConflict } from "./schedule-rules";
import type {
  ScheduleEventScope,
  SchedulePlacementCommand,
  SchedulePlacementResult,
  ScheduleSession,
  ScheduleWorkspace,
} from "./schedule-service.server";

export type SchedulePlacementWorkflowContext = {
  env: CloudflareEnvironment;
  getWorkspace: (viewer: ScheduleEventScope) => Promise<ScheduleWorkspace>;
};

export async function replayPlacement(
  env: CloudflareEnvironment,
  viewer: Viewer,
  command: SchedulePlacementCommand,
): Promise<SchedulePlacementResult | null> {
  const record = await env.DB.prepare(
    `SELECT request_hash AS requestHash, status, response_json AS responseJson
       FROM idempotency_records
      WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
        AND scope = 'schedule.entry.place' AND idempotency_key = ?
        AND expires_at > unixepoch()`,
  )
    .bind(
      viewer.organisationId,
      viewer.eventId,
      command.actorId,
      command.idempotencyKey,
    )
    .first<{
      requestHash: string;
      status: "processing" | "completed" | "failed";
      responseJson: string | null;
    }>();
  if (!record) return null;
  if (record.requestHash !== command.requestHash) {
    throw new ScheduleIdempotencyConflictError(
      "IDEMPOTENCY_KEY_REUSED",
      "This assistant placement identifier was already used for a different request.",
    );
  }
  if (record.status !== "completed") {
    throw new ScheduleIdempotencyConflictError(
      "IDEMPOTENCY_REQUEST_IN_PROGRESS",
      record.status === "failed"
        ? "This assistant placement did not complete. Prepare a fresh proposal before retrying."
        : "This assistant placement is still being processed. Retry the same approved proposal shortly.",
    );
  }
  if (!record.responseJson) {
    throw new Error(
      "The completed schedule placement is missing its durable response.",
    );
  }
  let response: unknown;
  try {
    response = JSON.parse(record.responseJson);
  } catch {
    throw new Error(
      "The completed schedule placement has an invalid durable response.",
    );
  }
  return parseSchedulePlacementResult(response);
}

export function sessionContentDurationStatements(
  env: CloudflareEnvironment,
  input: {
    scheduleVersionId: string;
    eventId: string;
    sessionId: string;
    durationMinutes: number;
    expectedContentRevision: number;
    contentStatus: ScheduleSession["contentStatus"];
    approvedByPersonId: string | null;
    approvedAt: number | null;
    approvalSource: ContentApprovalSource | null;
    operationId: string;
    editorPersonId: string;
    changeKind: "edit" | "restore";
    include: boolean;
  },
) {
  if (!input.include) return [];
  const historyRevisionId = crypto.randomUUID();
  const nextContentRevision = input.expectedContentRevision + 1;
  return [
    env.DB.prepare(
      `
      UPDATE schedule_session_contents
         SET duration_minutes = ?, content_status = ?,
             content_revision = content_revision + 1,
             last_edited_by_person_id = ?,
             approved_by_person_id = ?,
             approved_at = ?,
             approval_source = ?,
             last_operation_id = ?,
             updated_at = unixepoch()
       WHERE schedule_version_id = ? AND event_id = ? AND session_id = ?
         AND content_revision = ?
         AND EXISTS (
           SELECT 1 FROM schedule_versions
            WHERE id = schedule_session_contents.schedule_version_id
              AND event_id = schedule_session_contents.event_id
              AND publication_operation_id = ?
         )
    `,
    ).bind(
      input.durationMinutes,
      input.contentStatus,
      input.editorPersonId,
      input.approvedByPersonId,
      input.approvedAt,
      input.approvalSource,
      input.operationId,
      input.scheduleVersionId,
      input.eventId,
      input.sessionId,
      input.expectedContentRevision,
      input.operationId,
    ),
    env.DB.prepare(
      `
      INSERT INTO session_content_revisions (
        id, event_id, schedule_version_id, session_id, revision_number,
        title, slug, description, track_id, format, duration_minutes,
        required_resources_json, visibility, content_status, change_kind,
        restored_from_revision_id, created_by_person_id, created_at
      )
      SELECT ?, content.event_id, content.schedule_version_id,
             content.session_id, content.content_revision, content.title,
             content.slug, content.description, content.track_id,
             content.format, content.duration_minutes,
             content.required_resources_json, content.visibility,
             content.content_status, ?, NULL, ?, unixepoch()
        FROM schedule_session_contents content
       WHERE content.schedule_version_id = ? AND content.event_id = ?
         AND content.session_id = ? AND content.last_operation_id = ?
         AND content.content_revision = ?
    `,
    ).bind(
      historyRevisionId,
      input.changeKind,
      input.editorPersonId,
      input.scheduleVersionId,
      input.eventId,
      input.sessionId,
      input.operationId,
      nextContentRevision,
    ),
  ];
}

export function conflictInsert(
  env: CloudflareEnvironment,
  eventId: string,
  versionId: string,
  entryId: string,
  conflict: ScheduleConflict,
  operationId: string,
  conflictId?: string,
) {
  return scheduleConflictInsert(
    env,
    eventId,
    versionId,
    entryId,
    conflict,
    operationId,
    conflictId,
  );
}
