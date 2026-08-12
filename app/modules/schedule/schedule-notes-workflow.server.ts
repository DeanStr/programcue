import type { Viewer } from "~/platform/auth/authorize.server";
import {
  ScheduleNotFoundError,
  ScheduleRevisionConflictError,
} from "./schedule-errors";
import { scheduleNotesSchema } from "./schedule-schema";
import { ScheduleSessionEditorWorkflow } from "./schedule-session-editor-workflow.server";

export abstract class ScheduleNotesWorkflow extends ScheduleSessionEditorWorkflow {
  async updateScheduleNotesD1(
    viewer: Viewer,
    parsed: ReturnType<typeof scheduleNotesSchema.parse>,
    requestHash: string,
  ) {
    type Result = { scheduleVersionId: string; scheduleRevision: number };
    const parseResult = (value: unknown): Result => {
      if (!value || typeof value !== "object")
        throw new Error("The saved schedule-notes response is invalid.");
      const result = value as Partial<Result>;
      if (
        typeof result.scheduleVersionId !== "string" ||
        !Number.isSafeInteger(result.scheduleRevision)
      ) {
        throw new Error("The saved schedule-notes response is invalid.");
      }
      return result as Result;
    };
    const replay = await this.replayEditorCommand(
      viewer,
      "schedule.notes.save",
      parsed.idempotencyKey,
      requestHash,
      parseResult,
    );
    if (replay) return replay;
    const workspace = await this.getWorkspace(viewer);
    if (
      !workspace.version ||
      workspace.version.id !== parsed.scheduleVersionId ||
      workspace.version.status !== "draft"
    ) {
      throw new ScheduleNotFoundError(
        "Schedule notes can only be edited on an active draft.",
      );
    }
    if (workspace.version.revision !== parsed.scheduleRevision)
      throw new ScheduleRevisionConflictError();

    const commandId = crypto.randomUUID();
    const result: Result = {
      scheduleVersionId: parsed.scheduleVersionId,
      scheduleRevision: parsed.scheduleRevision + 1,
    };
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `DELETE FROM idempotency_records
          WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
            AND scope = 'schedule.notes.save' AND idempotency_key = ?
            AND expires_at <= unixepoch()`,
      ).bind(
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.idempotencyKey,
      ),
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO idempotency_records (
           id, organisation_id, event_id, actor_id, scope, idempotency_key,
           request_hash, status, expires_at, created_at
         ) VALUES (?, ?, ?, ?, 'schedule.notes.save', ?, ?, 'processing',
                   unixepoch() + 604800, unixepoch())`,
      ).bind(
        commandId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.idempotencyKey,
        requestHash,
      ),
      this.env.DB.prepare(
        `UPDATE events
            SET revision = revision + 1, last_operation_id = ?,
                last_updated_by_person_id = ?, updated_at = unixepoch()
          WHERE id = ? AND organisation_id = ? AND revision = ?
            AND EXISTS (
              SELECT 1 FROM idempotency_records command
               WHERE command.id = ? AND command.organisation_id = ?
                 AND command.event_id = ? AND command.actor_id = ?
                 AND command.scope = 'schedule.notes.save'
                 AND command.idempotency_key = ?
                 AND command.request_hash = ? AND command.status = 'processing'
            )`,
      ).bind(
        commandId,
        viewer.personId,
        viewer.eventId,
        viewer.organisationId,
        workspace.event.revision,
        commandId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.idempotencyKey,
        requestHash,
      ),
      this.env.DB.prepare(
        `UPDATE schedule_versions
            SET notes = ?, revision = revision + 1,
                publication_operation_id = ?
          WHERE id = ? AND event_id = ? AND status = 'draft' AND revision = ?
            AND EXISTS (
              SELECT 1 FROM events
               WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
            )`,
      ).bind(
        parsed.notes,
        commandId,
        parsed.scheduleVersionId,
        viewer.eventId,
        parsed.scheduleRevision,
        viewer.eventId,
        viewer.organisationId,
        commandId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, ?, 'schedule.notes.updated', 'schedule_version', ?, ?,
                unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM schedule_versions
             WHERE id = ? AND event_id = ? AND status = 'draft'
               AND publication_operation_id = ?
          )`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.scheduleVersionId,
        JSON.stringify({ scheduleRevision: result.scheduleRevision }),
        parsed.scheduleVersionId,
        viewer.eventId,
        commandId,
      ),
      this.env.DB.prepare(
        `UPDATE idempotency_records
            SET status = 'completed', response_status = 200,
                response_json = ?, entity_type = 'schedule_version',
                entity_id = ?, completed_at = unixepoch()
          WHERE id = ? AND organisation_id = ? AND event_id = ?
            AND actor_id = ? AND scope = 'schedule.notes.save'
            AND idempotency_key = ? AND request_hash = ?
            AND status = 'processing'
            AND EXISTS (
              SELECT 1 FROM schedule_versions
               WHERE id = ? AND event_id = ? AND status = 'draft'
                 AND publication_operation_id = ?
            )`,
      ).bind(
        JSON.stringify(result),
        parsed.scheduleVersionId,
        commandId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.idempotencyKey,
        requestHash,
        parsed.scheduleVersionId,
        viewer.eventId,
        commandId,
      ),
      this.env.DB.prepare(
        `DELETE FROM idempotency_records
          WHERE id = ? AND organisation_id = ? AND event_id = ?
            AND actor_id = ? AND scope = 'schedule.notes.save'
            AND idempotency_key = ? AND request_hash = ?
            AND status = 'processing'
            AND NOT EXISTS (
              SELECT 1 FROM schedule_versions
               WHERE id = ? AND event_id = ? AND status = 'draft'
                 AND publication_operation_id = ?
            )`,
      ).bind(
        commandId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.idempotencyKey,
        requestHash,
        parsed.scheduleVersionId,
        viewer.eventId,
        commandId,
      ),
    ]);
    if (
      (results[2]!.meta.changes ?? 0) !== 1 ||
      (results[3]!.meta.changes ?? 0) !== 1
    ) {
      const racedReplay = await this.replayEditorCommand(
        viewer,
        "schedule.notes.save",
        parsed.idempotencyKey,
        requestHash,
        parseResult,
      );
      if (racedReplay) return racedReplay;
      throw new ScheduleRevisionConflictError();
    }
    const completed = await this.replayEditorCommand(
      viewer,
      "schedule.notes.save",
      parsed.idempotencyKey,
      requestHash,
      parseResult,
    );
    if (!completed)
      throw new Error("The schedule-notes save did not record its result.");
    return completed;
  }
}
