import { z } from "zod";
import type { Viewer } from "~/platform/auth/authorize.server";

export const aiFeedbackSchema = z
  .object({
    operationId: z.string().trim().min(1).max(200),
    rating: z.enum(["helpful", "not_helpful"]),
    reason: z
      .enum([
        "incorrect",
        "missing_evidence",
        "wrong_record",
        "unsafe",
        "other",
      ])
      .nullable()
      .default(null),
    detail: z.preprocess(
      (value) =>
        typeof value === "string" && value.trim() === ""
          ? null
          : typeof value === "string"
            ? value.trim()
            : value,
      z.string().min(1).max(500).nullable().default(null),
    ),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.rating === "helpful" && value.reason !== null) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Helpful feedback does not need a problem reason.",
      });
    }
    if (value.rating === "not_helpful" && value.reason === null) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Choose what was wrong with the AI result.",
      });
    }
  });

export class AiFeedbackTargetError extends Error {
  constructor(
    message = "That completed AI operation is not available for feedback.",
  ) {
    super(message);
    this.name = "AiFeedbackTargetError";
  }
}

export class AiFeedbackService {
  constructor(private readonly env: CloudflareEnvironment) {}

  async save(viewer: Viewer, input: unknown) {
    const parsed = aiFeedbackSchema.parse(input);
    const feedbackId = crypto.randomUUID();
    const feedbackOperationId = crypto.randomUUID();
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO ai_operation_feedback (
           id, organisation_id, event_id, operation_id, person_id,
           rating, reason, detail, last_operation_id, created_at, updated_at
         )
         SELECT ?, operation.organisation_id, operation.event_id,
                operation.id, operation.requested_by_person_id, ?, ?, ?, ?,
                unixepoch(), unixepoch()
           FROM operation_jobs operation
           JOIN events event
             ON event.id = operation.event_id
            AND event.organisation_id = operation.organisation_id
          WHERE operation.id = ? AND operation.event_id = ?
            AND operation.organisation_id = ?
            AND operation.requested_by_person_id = ?
            AND operation.type LIKE 'ai.%'
            AND operation.status = 'completed'
         ON CONFLICT(operation_id, person_id) DO UPDATE SET
           rating = excluded.rating,
           reason = excluded.reason,
           detail = excluded.detail,
           last_operation_id = excluded.last_operation_id,
           updated_at = unixepoch()`,
      ).bind(
        feedbackId,
        parsed.rating,
        parsed.reason,
        parsed.detail,
        feedbackOperationId,
        parsed.operationId,
        viewer.eventId,
        viewer.organisationId,
        viewer.personId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id,
           event_id, actor_person_id, action, entity_type, entity_id,
           correlation_id, metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, organisation_id, event_id, ?,
                'assistant.feedback.recorded', 'operation_job', operation_id,
                ?, json_object(
                  'rating', rating,
                  'reason', reason,
                  'hasDetail', detail IS NOT NULL
                ), unixepoch()
           FROM ai_operation_feedback
          WHERE operation_id = ? AND person_id = ?
            AND event_id = ? AND organisation_id = ?
            AND last_operation_id = ?`,
      ).bind(
        feedbackOperationId,
        viewer.personId,
        feedbackOperationId,
        parsed.operationId,
        viewer.personId,
        viewer.eventId,
        viewer.organisationId,
        feedbackOperationId,
      ),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1) {
      throw new AiFeedbackTargetError();
    }
    if ((results[1]?.meta.changes ?? 0) !== 1) {
      throw new Error("AI feedback was not recorded atomically.");
    }
    return { operationId: parsed.operationId, rating: parsed.rating };
  }
}
