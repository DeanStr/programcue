import { z } from "zod";
import type { Viewer } from "~/platform/auth/authorize.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import { ParticipantTaskWorkflowFoundation } from "./participant-task-workflow-foundation.server";
import {
  hashUndoSecret,
  participantTaskAccessSql,
  TaskStateError,
} from "./task-service-foundation.server";

export class ParticipantTaskCommentCommands extends ParticipantTaskWorkflowFoundation {
  async addComment(
    viewer: Viewer,
    taskId: string,
    body: string,
    visibility: "participant" | "administrator",
    intentId: string,
  ) {
    const parsedIntentId = z.string().trim().min(1).max(200).parse(intentId);
    return this.projectIntentCommand(
      viewer,
      "task.comment.add",
      parsedIntentId,
      { taskId, body, visibility },
      () => this.addCommentD1(viewer, taskId, body, visibility, parsedIntentId),
    );
  }

  protected async addCommentD1(
    viewer: Viewer,
    taskId: string,
    body: string,
    visibility: "participant" | "administrator",
    intentId: string,
  ) {
    const clean = z.string().trim().min(1).max(2_000).parse(body);
    const participant =
      viewer.role === "speaker" || viewer.role === "submitter";
    if (participant) {
      const task = await this.participantTask(viewer, taskId);
      if (!task)
        throw new TaskStateError(
          "Task not found or not accessible to this participant.",
        );
      visibility = "participant";
    } else {
      await this.assertEvent(viewer);
      const task = await this.env.DB.prepare(
        "SELECT 1 FROM task_instances WHERE id = ? AND event_id = ?",
      )
        .bind(taskId, viewer.eventId)
        .first();
      if (!task) throw new TaskStateError("Task not found.");
    }
    await this.requireTaskWebhookReadiness(viewer, "task.updated");
    const intentDigest = await hashUndoSecret(
      `${viewer.organisationId.length}:${viewer.organisationId}:${viewer.eventId.length}:${viewer.eventId}:${viewer.personId.length}:${viewer.personId}:${taskId.length}:${taskId}:${intentId}`,
    );
    const boundedDigest = intentDigest.slice(0, 40);
    const commentId = `task-comment:${boundedDigest}`;
    const operationId = `comment:${boundedDigest}`;
    const auditEventId = `audit:task-comment:${boundedDigest}`;
    const webhookInput = {
      eventType: "task.updated" as const,
      entityType: "task" as const,
      entityId: taskId,
      idempotencyKey: `task.updated:${taskId}:${operationId}`,
      correlationId: operationId,
      data: { action: "comment_added", visibility },
    };
    const existing = await this.env.DB.prepare(
      `SELECT id, event_id AS eventId, task_id AS taskId,
              author_person_id AS authorPersonId, body, visibility,
              EXISTS (
                SELECT 1 FROM audit_events audit
                 WHERE audit.id = ? AND audit.organisation_id = ?
                   AND audit.event_id = task_comments.event_id
                   AND audit.actor_person_id = task_comments.author_person_id
                   AND audit.action = 'task.comment.added'
                   AND audit.entity_type = 'task_instance'
                   AND audit.entity_id = task_comments.task_id
                   AND audit.correlation_id = ?
              ) AS auditExists
         FROM task_comments WHERE id = ?`,
    )
      .bind(auditEventId, viewer.organisationId, operationId, commentId)
      .first<{
        id: string;
        eventId: string;
        taskId: string;
        authorPersonId: string;
        body: string;
        visibility: string;
        auditExists: number;
      }>();
    const exactExisting =
      existing?.eventId === viewer.eventId &&
      existing.taskId === taskId &&
      existing.authorPersonId === viewer.personId &&
      existing.body === clean &&
      existing.visibility === visibility;
    if (exactExisting && !existing.auditExists) {
      throw new TaskStateError(
        "This comment action has incomplete audit history. Ask an administrator to investigate before retrying.",
      );
    }
    if (existing && !exactExisting) {
      throw new TaskStateError(
        "This comment action was already used with different content. Refresh and try again.",
      );
    }
    if (exactExisting) {
      const deliveries = await new WebhookService(
        this.env,
      ).resumePreparedEventForAudit(viewer, webhookInput, auditEventId);
      return {
        taskId,
        webhookWarning: deliveries.some(
          (delivery) => delivery.status === "queue_failed",
        )
          ? "The comment was saved, but one or more outbound webhooks need a queue retry."
          : null,
      };
    }
    const preparedWebhook = await new WebhookService(
      this.env,
    ).prepareEventForAudit(viewer, webhookInput, auditEventId);
    let created: D1Result | null = null;
    try {
      [created] = await this.env.DB.batch([
        this.env.DB.prepare(
          `
        INSERT INTO task_comments (id, event_id, task_id, author_person_id, body, visibility, created_at)
        SELECT ?, ?, ?, ?, ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM task_instances task
            WHERE task.id = ? AND task.event_id = ?
              AND ${participant ? participantTaskAccessSql("task") : "1 = 1"}
         )
      `,
        ).bind(
          commentId,
          viewer.eventId,
          taskId,
          viewer.personId,
          clean,
          visibility,
          taskId,
          viewer.eventId,
          ...(participant
            ? [viewer.personId, viewer.personId, viewer.personId]
            : []),
        ),
        this.env.DB.prepare(
          `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         ) SELECT ?, 'person', 'participant_ui', 1, ?, ?, ?, 'task.comment.added', 'task_instance', ?, ?, ?, unixepoch()
            WHERE EXISTS (
              SELECT 1 FROM task_comments
               WHERE id = ? AND event_id = ? AND task_id = ?
            )`,
        ).bind(
          auditEventId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          taskId,
          operationId,
          JSON.stringify({ commentId, visibility }),
          commentId,
          viewer.eventId,
          taskId,
        ),
        ...preparedWebhook.statements,
      ]);
    } catch (error) {
      const concurrent = await this.env.DB.prepare(
        `SELECT body, visibility, author_person_id AS authorPersonId,
                EXISTS (
                  SELECT 1 FROM audit_events audit
                   WHERE audit.id = ? AND audit.organisation_id = ?
                     AND audit.event_id = task_comments.event_id
                     AND audit.actor_person_id = task_comments.author_person_id
                     AND audit.action = 'task.comment.added'
                     AND audit.entity_type = 'task_instance'
                     AND audit.entity_id = task_comments.task_id
                     AND audit.correlation_id = ?
                ) AS auditExists
           FROM task_comments
          WHERE id = ? AND event_id = ? AND task_id = ?`,
      )
        .bind(
          auditEventId,
          viewer.organisationId,
          operationId,
          commentId,
          viewer.eventId,
          taskId,
        )
        .first<{
          body: string;
          visibility: string;
          authorPersonId: string;
          auditExists: number;
        }>();
      if (
        concurrent?.body !== clean ||
        concurrent.visibility !== visibility ||
        concurrent.authorPersonId !== viewer.personId ||
        concurrent.auditExists !== 1
      ) {
        throw error;
      }
    }
    if (created && (created.meta.changes ?? 0) !== 1) {
      throw new TaskStateError(
        "Task access changed before the comment could be saved. Refresh and try again.",
      );
    }
    const deliveries = await new WebhookService(
      this.env,
    ).resumePreparedEventForAudit(viewer, webhookInput, auditEventId);
    const webhookWarning = deliveries.some(
      (delivery) => delivery.status === "queue_failed",
    )
      ? "The comment was saved, but one or more outbound webhooks need a queue retry."
      : null;
    return { taskId, webhookWarning };
  }
}
