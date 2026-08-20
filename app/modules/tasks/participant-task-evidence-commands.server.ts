import type { z } from "zod";
import { requireValue } from "~/lib/required-value";
import type { Viewer } from "~/platform/auth/authorize.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import { ParticipantTaskWorkflowFoundation } from "./participant-task-workflow-foundation.server";
import {
  type CompletedFileEvidenceAsset,
  completedFileEvidenceAttachmentSchema,
  isSharedSessionDeliverableTask,
  parseTaskEvidenceDetails,
  TaskEvidenceAttachmentConflictError,
  type TaskRow,
  TaskStateError,
} from "./task-service-foundation.server";

export class ParticipantTaskEvidenceCommands extends ParticipantTaskWorkflowFoundation {
  protected async completedFileEvidenceAsset(
    viewer: Viewer,
    input: z.infer<typeof completedFileEvidenceAttachmentSchema>,
    sharedSessionDeliverable: boolean,
  ) {
    return this.env.DB.prepare(
      `
      SELECT fa.id, fv.id AS versionId, fv.version_number AS versionNumber,
             fv.upload_status AS uploadStatus, fv.signature_status AS signatureStatus,
             fv.scan_status AS scanStatus, evidence.id AS evidenceId,
             evidence.status AS evidenceStatus,
             EXISTS (
               SELECT 1 FROM task_evidence prior
                WHERE prior.event_id = fa.event_id
                  AND prior.task_id = fa.target_id
                  AND prior.file_asset_id = fa.id
             ) AS hasPriorEvidence
        FROM file_assets fa
        JOIN file_versions fv
          ON fv.id = ? AND fv.asset_id = fa.id AND fv.event_id = fa.event_id
        LEFT JOIN task_evidence evidence
          ON evidence.event_id = fa.event_id
         AND evidence.task_id = fa.target_id
         AND evidence.file_asset_id = fa.id
         AND evidence.submitted_by_person_id = ?
         AND CASE WHEN json_valid(evidence.evidence_json)
               THEN json_extract(evidence.evidence_json, '$.fileVersionId')
             END = fv.id
       WHERE fa.id = ? AND fa.event_id = ?
         AND (? = 1 OR fa.owner_person_id = ?)
         AND fa.target_type = 'task' AND fa.target_id = ?
         AND fa.asset_kind = 'task_evidence' AND fa.status <> 'deleted'
         AND fv.created_by_person_id = ? AND fv.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM audit_events audit
            WHERE audit.id = 'file-erasure:' || fa.id
         )
       ORDER BY evidence.created_at DESC LIMIT 1
    `,
    )
      .bind(
        input.versionId,
        viewer.personId,
        input.assetId,
        viewer.eventId,
        sharedSessionDeliverable ? 1 : 0,
        viewer.personId,
        input.taskId,
        viewer.personId,
      )
      .first<CompletedFileEvidenceAsset>();
  }

  protected exactFileEvidenceAlreadyAttached(
    task: TaskRow,
    asset: CompletedFileEvidenceAsset | null,
    input: z.infer<typeof completedFileEvidenceAttachmentSchema>,
  ) {
    if (
      !asset ||
      !["submitted", "completed"].includes(task.status) ||
      !["submitted", "approved"].includes(asset.evidenceStatus ?? "") ||
      asset.uploadStatus !== "uploaded" ||
      asset.signatureStatus !== "valid" ||
      !["pending", "clean"].includes(asset.scanStatus) ||
      !task.evidenceJson
    )
      return false;
    const evidence = parseTaskEvidenceDetails(task.id, task.evidenceJson);
    return (
      evidence.fileAssetId === input.assetId &&
      evidence.fileVersionId === input.versionId
    );
  }

  async attachCompletedFileEvidence(viewer: Viewer, rawInput: unknown) {
    return this.projectCommand(viewer, "task.evidence.attach", rawInput, () =>
      this.attachCompletedFileEvidenceD1(viewer, rawInput),
    );
  }

  protected async attachCompletedFileEvidenceD1(
    viewer: Viewer,
    rawInput: unknown,
  ) {
    const input = completedFileEvidenceAttachmentSchema.parse(rawInput);
    const ownedTask = await this.participantTask(viewer, input.taskId);
    if (ownedTask?.taskType !== "file_upload")
      throw new TaskStateError(
        "File task not found or not owned by this speaker.",
      );
    const sharedSessionDeliverable = isSharedSessionDeliverableTask(ownedTask);
    let asset = await this.completedFileEvidenceAsset(
      viewer,
      input,
      sharedSessionDeliverable,
    );
    let submittedEvidence: {
      assetId: string;
      versionId: string;
      versionNumber: number;
    } | null;
    try {
      submittedEvidence = await this.submittedFileEvidence(viewer, ownedTask);
    } catch (error) {
      if (
        error instanceof TaskStateError &&
        asset?.evidenceId === null &&
        asset?.uploadStatus === "uploaded" &&
        asset.signatureStatus === "valid" &&
        ["pending", "clean"].includes(asset.scanStatus)
      ) {
        throw new TaskEvidenceAttachmentConflictError(error.message);
      }
      throw error;
    }
    await this.requireTaskWebhookReadiness(viewer, "task.updated");
    if (this.exactFileEvidenceAlreadyAttached(ownedTask, asset, input)) {
      const webhookWarning = await this.queueTaskWebhook(
        viewer,
        "participant_ui",
        {
          eventType: "task.updated",
          taskId: input.taskId,
          operationId:
            ownedTask.lastOperationId ??
            `evidence:${requireValue(asset, "Required asset is unavailable.").evidenceId}`,
          data: { action: "file_evidence_attached", status: ownedTask.status },
        },
      );
      return { ...input, duplicate: true, webhookWarning };
    }
    if (
      asset?.uploadStatus !== "uploaded" ||
      asset.signatureStatus !== "valid" ||
      !["pending", "clean"].includes(asset.scanStatus)
    )
      throw new TaskStateError(
        "The exact file version did not complete safely or is no longer attachable.",
      );
    if (
      submittedEvidence &&
      (input.assetId !== submittedEvidence.assetId ||
        input.versionId === submittedEvidence.versionId ||
        asset.versionNumber <= submittedEvidence.versionNumber)
    ) {
      const message =
        "A replacement must be a newer version of this task's canonical evidence asset.";
      if (asset.evidenceId) throw new TaskStateError(message);
      throw new TaskEvidenceAttachmentConflictError(message);
    }
    if (!submittedEvidence && asset.hasPriorEvidence) {
      const message =
        "Evidence from an earlier submission cannot be attached as a new task upload.";
      if (asset.evidenceId) throw new TaskStateError(message);
      throw new TaskEvidenceAttachmentConflictError(message);
    }
    let task: TaskRow;
    try {
      task = await this.assertFileEvidenceUploadAllowed(viewer, input.taskId);
    } catch (error) {
      if (error instanceof TaskStateError) {
        throw new TaskEvidenceAttachmentConflictError(error.message);
      }
      throw error;
    }
    const evidenceId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const auditEventId = crypto.randomUUID();
    const preparedWebhook = await new WebhookService(
      this.env,
    ).prepareEventForAudit(
      viewer,
      {
        eventType: "task.updated",
        entityType: "task",
        entityId: input.taskId,
        idempotencyKey: `task.updated:${input.taskId}:${operationId}`,
        correlationId: operationId,
        data: { action: "file_evidence_attached", status: "submitted" },
      },
      auditEventId,
    );
    const taskEvidenceJson = JSON.stringify({
      fileAssetId: asset.id,
      fileVersionId: asset.versionId,
      scanStatus: asset.scanStatus,
    });
    const evidenceJson = JSON.stringify({
      fileVersionId: asset.versionId,
      scanStatus: asset.scanStatus,
    });
    const [updated] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE task_instances SET status = 'submitted', readiness_state = 'on_track', readiness_percent = 80,
          evidence_json = ?, submitted_at = unixepoch(), revision = revision + 1,
          last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND revision = ? AND status NOT IN ('completed','waived')
           AND (
             ? = 0
             OR (
               task_instances.task_type = 'file_upload'
               AND task_instances.target_type = 'session'
               AND json_valid(task_instances.configuration_json)
               AND json_extract(task_instances.configuration_json, '$.fileScope') = 'session_deliverable'
               AND EXISTS (
                 SELECT 1 FROM session_speakers relation
                 WHERE relation.event_id = task_instances.event_id
                    AND relation.session_id = task_instances.target_id
                    AND relation.person_id = ?
                    AND relation.participation_status IN ('pending','confirmed')
               )
             )
           )
           AND (
             ? IS NULL
             OR (
               status = 'submitted'
               AND json_valid(evidence_json)
               AND json_extract(evidence_json, '$.fileAssetId') = ?
               AND json_extract(evidence_json, '$.fileVersionId') = ?
             )
           )
           AND NOT EXISTS (
             SELECT 1 FROM task_instance_dependencies dep
             JOIN task_instances prerequisite ON prerequisite.id = dep.depends_on_task_id
              WHERE dep.task_id = task_instances.id
                AND prerequisite.status NOT IN ('completed','waived')
           )
           AND EXISTS (
             SELECT 1
               FROM file_assets fa
               JOIN file_versions fv
                 ON fv.id = ? AND fv.asset_id = fa.id AND fv.event_id = fa.event_id
              WHERE fa.id = ? AND fa.event_id = task_instances.event_id
                AND (? = 1 OR fa.owner_person_id = ?)
                AND fa.target_type = 'task'
                AND fa.target_id = task_instances.id
                AND fa.asset_kind = 'task_evidence' AND fa.status <> 'deleted'
                AND fv.created_by_person_id = ? AND fv.upload_status = 'uploaded'
                AND fv.signature_status = 'valid' AND fv.scan_status IN ('pending','clean')
                AND fv.deleted_at IS NULL
                AND NOT EXISTS (
                  SELECT 1 FROM audit_events audit
                   WHERE audit.id = 'file-erasure:' || fa.id
                )
           )
      `,
      ).bind(
        taskEvidenceJson,
        operationId,
        task.id,
        viewer.eventId,
        task.revision,
        sharedSessionDeliverable ? 1 : 0,
        viewer.personId,
        submittedEvidence?.versionId ?? null,
        submittedEvidence?.assetId ?? null,
        submittedEvidence?.versionId ?? null,
        input.versionId,
        input.assetId,
        sharedSessionDeliverable ? 1 : 0,
        viewer.personId,
        viewer.personId,
      ),
      this.env.DB.prepare(
        `
        UPDATE task_evidence SET status = 'superseded'
         WHERE task_id = ? AND event_id = ? AND status = 'submitted'
           AND ? IS NOT NULL AND file_asset_id = ?
           AND CASE WHEN json_valid(evidence_json)
                 THEN json_extract(evidence_json, '$.fileVersionId')
               END = ?
           AND EXISTS (
             SELECT 1 FROM task_instances
              WHERE id = ? AND event_id = ? AND revision = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        task.id,
        viewer.eventId,
        submittedEvidence?.versionId ?? null,
        submittedEvidence?.assetId ?? null,
        submittedEvidence?.versionId ?? null,
        task.id,
        viewer.eventId,
        task.revision + 1,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO task_evidence (id, event_id, task_id, submitted_by_person_id, file_asset_id, evidence_json, status, created_at)
        SELECT ?, ?, ?, ?, ?, ?, 'submitted', unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM task_instances
            WHERE id = ? AND event_id = ? AND revision = ? AND last_operation_id = ?
         )
      `,
      ).bind(
        evidenceId,
        viewer.eventId,
        task.id,
        viewer.personId,
        asset.id,
        evidenceJson,
        task.id,
        viewer.eventId,
        task.revision + 1,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
        ) SELECT ?, 'person', 'participant_ui', 1, ?, ?, ?, 'task.file.submitted', 'task_instance', ?, ?, unixepoch()
           WHERE EXISTS (
             SELECT 1 FROM task_evidence WHERE id = ? AND event_id = ? AND task_id = ?
           )
      `,
      ).bind(
        auditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        task.id,
        JSON.stringify({
          evidenceId,
          assetId: input.assetId,
          versionId: input.versionId,
          scanStatus: asset.scanStatus,
        }),
        evidenceId,
        viewer.eventId,
        task.id,
      ),
      ...preparedWebhook.statements,
    ]);
    if ((updated.meta.changes ?? 0) !== 1) {
      const currentTask = await this.participantTask(viewer, input.taskId);
      asset = await this.completedFileEvidenceAsset(
        viewer,
        input,
        sharedSessionDeliverable,
      );
      if (
        currentTask &&
        this.exactFileEvidenceAlreadyAttached(currentTask, asset, input)
      ) {
        const webhookWarning = await this.queueTaskWebhook(
          viewer,
          "participant_ui",
          {
            eventType: "task.updated",
            taskId: input.taskId,
            operationId:
              currentTask.lastOperationId ??
              `evidence:${requireValue(asset, "Required asset is unavailable.").evidenceId}`,
            data: {
              action: "file_evidence_attached",
              status: currentTask.status,
            },
          },
        );
        return { ...input, duplicate: true, webhookWarning };
      }
      throw new TaskEvidenceAttachmentConflictError(
        "This task changed. Refresh before submitting file evidence.",
      );
    }
    const webhookWarning = await this.queueTaskWebhook(
      viewer,
      "participant_ui",
      {
        eventType: "task.updated",
        taskId: input.taskId,
        operationId,
        data: { action: "file_evidence_attached", status: "submitted" },
      },
    );
    return { ...input, duplicate: false, webhookWarning };
  }
}
