import type { z } from "zod";

import {
  participantTaskAccessSql,
  taskConfiguration,
} from "~/modules/tasks/task-service-foundation.server";
import {
  parseEventFilePolicy,
  validateDirectFileDeclaration,
} from "./file-policy";
import {
  FileAccessError,
  FileService,
  type UploadTarget,
  uploadTargetSchema,
} from "./file-service.server";
import { isApplicantActor } from "./multipart-upload-access.server";
import type {
  multipartInitiateSchema,
  TaskEvidenceFilePolicy,
} from "./multipart-upload-contract";
import type {
  MultipartActor,
  MultipartRow,
} from "./multipart-upload-contracts";
import { FileMultipartConflictError } from "./multipart-upload-errors";

export class MultipartUploadAuthorizer {
  constructor(private readonly env: CloudflareEnvironment) {}

  participantTaskGuard(actor: MultipartActor) {
    if (
      isApplicantActor(actor) ||
      ["owner", "administrator"].includes(actor.role)
    ) {
      return null;
    }
    return {
      sql: participantTaskAccessSql("task"),
      bindings: [actor.personId, actor.personId, actor.personId],
    };
  }

  async assertTarget(actor: MultipartActor, target: UploadTarget) {
    if (isApplicantActor(actor)) {
      if (
        target.targetType !== "submission" ||
        target.targetId !== actor.submissionId ||
        target.assetKind !== "video"
      ) {
        throw new FileAccessError(
          "Applicant multipart uploads are limited to the authorized draft video field.",
        );
      }
      const owned = await this.env.DB.prepare(
        `SELECT 1
           FROM submissions submission
           JOIN events event
             ON event.id = submission.event_id AND event.organisation_id = ?
          WHERE submission.id = ? AND submission.event_id = ?
            AND submission.status = 'draft'
            AND (
              (? IS NOT NULL AND submission.submitter_person_id = ?)
              OR (? IS NULL AND submission.submitter_person_id IS NULL)
            )`,
      )
        .bind(
          actor.organisationId,
          actor.submissionId,
          actor.eventId,
          actor.personId,
          actor.personId,
          actor.personId,
        )
        .first();
      if (!owned) {
        throw new FileAccessError(
          "The draft submission is no longer available for this applicant.",
        );
      }
      return null;
    }
    const files = new FileService(this.env);
    if (["owner", "administrator"].includes(actor.role)) {
      await files.assertAdminTarget(actor, target);
      return null;
    }
    return files.assertParticipantTarget(actor, target);
  }

  assertSameRequest(
    row: MultipartRow,
    input: z.infer<typeof multipartInitiateSchema>,
  ) {
    if (
      row.targetType !== input.target.targetType ||
      row.targetId !== input.target.targetId ||
      row.assetKind !== input.target.assetKind ||
      row.filename !== input.filename ||
      row.contentType !== input.contentType ||
      row.sizeBytes !== input.sizeBytes
    ) {
      throw new FileMultipartConflictError(
        "This idempotency key was already used for a different multipart upload.",
      );
    }
  }

  assertAuthorisedTaskAsset(
    target: UploadTarget,
    authorisedAssetId: string | null,
    row: MultipartRow,
  ) {
    if (
      target.targetType === "task" &&
      authorisedAssetId !== null &&
      row.assetId !== authorisedAssetId
    ) {
      throw new FileAccessError(
        "This upload no longer belongs to the task's canonical evidence asset.",
      );
    }
  }

  uploadTarget(row: MultipartRow) {
    return uploadTargetSchema.parse({
      targetType: row.targetType,
      targetId: row.targetId,
      assetKind: row.assetKind,
    });
  }

  async taskEvidenceFilePolicy(
    actor: MultipartActor,
    target: UploadTarget,
  ): Promise<TaskEvidenceFilePolicy | undefined> {
    if (target.targetType !== "task" || target.assetKind !== "task_evidence") {
      return undefined;
    }
    const task = await this.env.DB.prepare(
      `SELECT task_type AS taskType, target_type AS targetType,
              configuration_json AS configurationJson
         FROM task_instances
        WHERE id = ? AND event_id = ?`,
    )
      .bind(target.targetId, actor.eventId)
      .first<{
        taskType: string;
        targetType: string;
        configurationJson: string;
      }>();
    if (task?.taskType !== "file_upload") {
      throw new FileAccessError("This task does not accept file evidence.");
    }
    let configuration: ReturnType<typeof taskConfiguration>;
    try {
      configuration = taskConfiguration(task.configurationJson);
    } catch {
      throw new FileAccessError(
        "This file task has invalid purpose or target configuration. Ask an administrator to repair it.",
      );
    }
    if (
      (configuration.fileScope === "participant_document" &&
        task.targetType === "speaker") ||
      (configuration.fileScope === "session_deliverable" &&
        task.targetType === "session")
    ) {
      return {
        fileScope: configuration.fileScope,
        ...(configuration.fileKind ? { fileKind: configuration.fileKind } : {}),
      };
    }
    throw new FileAccessError(
      "This file task has invalid purpose or target configuration. Ask an administrator to repair it.",
    );
  }

  assertCurrentDeclaration(
    row: MultipartRow,
    taskFilePolicy?: TaskEvidenceFilePolicy,
  ) {
    const target = this.uploadTarget(row);
    validateDirectFileDeclaration(
      target.assetKind,
      { name: row.filename, type: row.contentType, size: row.sizeBytes },
      parseEventFilePolicy(row.filePolicyJson),
      {
        taskFileScope: taskFilePolicy?.fileScope,
        taskFileKind: taskFilePolicy?.fileKind,
      },
    );
  }

  async assertCurrentUploadAllowed(actor: MultipartActor, row: MultipartRow) {
    const target = this.uploadTarget(row);
    const authorisedAssetId = await this.assertTarget(actor, target);
    this.assertAuthorisedTaskAsset(target, authorisedAssetId, row);
    this.assertCurrentDeclaration(
      row,
      await this.taskEvidenceFilePolicy(actor, target),
    );
  }
}
