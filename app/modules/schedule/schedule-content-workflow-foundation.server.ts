import type { Viewer } from "~/platform/auth/authorize.server";
import { scheduleConflictInsert } from "./schedule-conflict-statement.server";
import { ScheduleIdempotencyConflictError } from "./schedule-errors";
import type { ScheduleConflict } from "./schedule-rules";
import type {
  ScheduleEventScope,
  ScheduleWorkspace,
} from "./schedule-service.server";

export abstract class ScheduleContentWorkflowFoundation {
  constructor(
    protected readonly env: CloudflareEnvironment,
    protected readonly dependencies: {
      getWorkspace: (viewer: ScheduleEventScope) => Promise<ScheduleWorkspace>;
    },
  ) {}

  protected getWorkspace(viewer: ScheduleEventScope) {
    return this.dependencies.getWorkspace(viewer);
  }

  protected async replayEditorCommand<T>(
    viewer: Viewer,
    scope: "schedule.session_content.save" | "schedule.notes.save",
    idempotencyKey: string,
    requestHash: string,
    parse: (value: unknown) => T,
  ): Promise<T | null> {
    const record = await this.env.DB.prepare(
      `SELECT request_hash AS requestHash, status, response_json AS responseJson
         FROM idempotency_records
        WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
          AND scope = ? AND idempotency_key = ? AND expires_at > unixepoch()`,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        scope,
        idempotencyKey,
      )
      .first<{
        requestHash: string;
        status: "processing" | "completed" | "failed";
        responseJson: string | null;
      }>();
    if (!record) return null;
    if (record.requestHash !== requestHash) {
      throw new ScheduleIdempotencyConflictError(
        "IDEMPOTENCY_KEY_REUSED",
        "This editor save identifier was already used for different content.",
      );
    }
    if (record.status !== "completed") {
      throw new ScheduleIdempotencyConflictError(
        "IDEMPOTENCY_REQUEST_IN_PROGRESS",
        record.status === "failed"
          ? "This editor save did not complete. Make another edit or explicitly retry with a new save identifier."
          : "This editor save is still being processed. Retry the same save shortly.",
      );
    }
    if (!record.responseJson) {
      throw new Error(
        "The completed editor save is missing its durable response.",
      );
    }
    let response: unknown;
    try {
      response = JSON.parse(record.responseJson);
    } catch {
      throw new Error(
        "The completed editor save has an invalid durable response.",
      );
    }
    return parse(response);
  }

  protected conflictInsert(
    eventId: string,
    versionId: string,
    entryId: string,
    conflict: ScheduleConflict,
    operationId: string,
  ) {
    return scheduleConflictInsert(
      this.env,
      eventId,
      versionId,
      entryId,
      conflict,
      operationId,
    );
  }
}
