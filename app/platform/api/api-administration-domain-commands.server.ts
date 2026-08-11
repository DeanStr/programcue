import { z } from "zod";

import { EvaluationService } from "~/modules/evaluations/evaluation-service.server";
import { EventService } from "~/modules/events/event-service.server";
import { IntegrationService } from "~/modules/integrations/integration-service.server";
import { ResourceAuthoringService } from "~/modules/resources/resource-authoring-service.server";
import { ScheduleService } from "~/modules/schedule/schedule-service.server";
import { SubmissionService } from "~/modules/submissions/submission-service.server";
import {
  TaskService,
  taskTemplateIdForIntent,
} from "~/modules/tasks/task-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { SessionBulkService } from "~/platform/operations/session-bulk-service.server";
import { decryptWebhookSecret } from "~/platform/operations/webhook-crypto.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import {
  apiAdministrationCommandSchema,
  apiAdministrationFamilySchema,
  apiDecisionSchema,
  apiFormPublishSchema,
  apiFormSaveSchema,
  apiIntegrationConnectionSchema,
  apiIntegrationDisconnectSchema,
  apiIntegrationMappingDeleteSchema,
  apiIntegrationMappingSchema,
  apiMembershipRevocationSchema,
  apiPersonInvitationSchema,
  apiResourcePublishSchema,
  apiResourceSaveSchema,
  apiSessionEditSchema,
  apiSessionLifecycleSchema,
  apiTaskAssignmentSchema,
  apiTaskTemplateSchema,
  apiWebhookEndpointSchema,
  apiWebhookRotateSecretSchema,
  apiWebhookStatusSchema,
  apiWebhookTestSchema,
} from "./api-command-contract";
import { ApiPersonIdempotencyService } from "./api-person-idempotency.server";
import { ApiError, apiRequestHash } from "./api.server";
import {
  ApiAdministrationCommandExecutor,
  assertMatch,
  assertNew,
  type Command,
  type Family,
} from "./api-administration-command-foundation.server";

export class ApiAdministrationDomainCommands extends ApiAdministrationCommandExecutor {
  async executeSessions(
    viewer: Viewer,
    family: Family,
    itemId: string,
    command: Command,
    rawInput: unknown,
    idempotencyKey: string,
  ): Promise<unknown> {
    if (family === "sessions" && command === "edit") {
      const input = apiSessionEditSchema.parse(rawInput);
      assertMatch(input.sessionId, itemId, "Session identifier");
      if (input.idempotencyKey !== idempotencyKey) {
        throw new ApiError(
          422,
          "IDEMPOTENCY_KEY_MISMATCH",
          "The Idempotency-Key header must match body.idempotencyKey",
        );
      }
      return new ScheduleService(this.env).updateSessionContent(viewer, input);
    }

    if (
      family === "sessions" &&
      (command === "archive" || command === "restore")
    ) {
      apiSessionLifecycleSchema.parse(rawInput);
      const response = await this.idempotency.run({
        viewer,
        scope: `api.session.${command}`,
        idempotencyKey,
        input: { itemId, command },
        execute: (commandId) =>
          new SessionBulkService(this.env).applyLifecycleCommand(
            viewer,
            { action: command, sessionId: itemId },
            commandId,
          ),
        recover: async (commandId) => {
          const row = await this.env.DB.prepare(
            `SELECT result_json AS resultJson
               FROM operation_jobs
              WHERE id = ? AND event_id = ? AND organisation_id = ?
                AND requested_by_person_id = ? AND type = 'session.bulk'
                AND status = 'completed'`,
          )
            .bind(
              commandId,
              viewer.eventId,
              viewer.organisationId,
              viewer.personId,
            )
            .first<{ resultJson: string }>();
          if (!row) return null;
          const result = z
            .object({
              action: z.enum(["archive", "restore"]),
              changeCount: z.number().int().positive(),
              undoExpiresAt: z.number().int().nullable().optional(),
            })
            .passthrough()
            .parse(JSON.parse(row.resultJson));
          return {
            operationId: commandId,
            action: result.action,
            changedCount: result.changeCount,
            undoExpiresAt: result.undoExpiresAt ?? null,
          };
        },
      });
      return { ...response.result, replayed: response.replayed };
    }

    throw new ApiError(
      404,
      "ADMINISTRATION_COMMAND_NOT_FOUND",
      `The ${family}/${command} administration command is not supported`,
    );
  }

  async executeDecisions(
    viewer: Viewer,
    family: Family,
    itemId: string,
    command: Command,
    rawInput: unknown,
    idempotencyKey: string,
  ): Promise<unknown> {
    if (
      family === "decisions" &&
      (command === "draft" || command === "release")
    ) {
      const input = apiDecisionSchema.parse(rawInput);
      assertMatch(input.submissionId, itemId, "Submission identifier");
      const decisionInput = {
        ...input,
        confirmed: undefined,
        release: command === "release",
      };
      const requestHash = await apiRequestHash(decisionInput);
      const response = await this.idempotency.run({
        viewer,
        scope: `api.decision.${command}`,
        idempotencyKey,
        input: decisionInput,
        execute: async (commandId) => {
          await new EvaluationService(this.env).decide(viewer, decisionInput, {
            commandId,
            idempotencyKey,
            requestHash,
            actorId: viewer.personId,
          });
          const result = await this.decisionResult(viewer, commandId);
          if (!result)
            throw new Error("The saved decision result is unavailable.");
          return result;
        },
        recover: (commandId) => this.decisionResult(viewer, commandId),
      });
      return { ...response.result, replayed: response.replayed };
    }

    throw new ApiError(
      404,
      "ADMINISTRATION_COMMAND_NOT_FOUND",
      `The ${family}/${command} administration command is not supported`,
    );
  }

  async executeTaskTemplates(
    viewer: Viewer,
    family: Family,
    itemId: string,
    command: Command,
    rawInput: unknown,
    idempotencyKey: string,
  ): Promise<unknown> {
    if (family === "task-templates" && command === "save") {
      assertNew(itemId);
      const input = apiTaskTemplateSchema.parse(rawInput);
      const response = await this.idempotency.run({
        viewer,
        scope: "api.task-template.save",
        idempotencyKey,
        input,
        execute: async (commandId) => ({
          templateId: await new TaskService(this.env).createTemplate(
            viewer,
            input,
            commandId,
          ),
        }),
        recover: async (commandId) => {
          const templateId = taskTemplateIdForIntent(viewer.eventId, commandId);
          const row = await this.env.DB.prepare(
            `SELECT id AS templateId FROM task_templates
              WHERE id = ? AND event_id = ?`,
          )
            .bind(templateId, viewer.eventId)
            .first<{ templateId: string }>();
          return row;
        },
      });
      return { ...response.result, replayed: response.replayed };
    }

    throw new ApiError(
      404,
      "ADMINISTRATION_COMMAND_NOT_FOUND",
      `The ${family}/${command} administration command is not supported`,
    );
  }

  async executeTaskAssignments(
    viewer: Viewer,
    family: Family,
    itemId: string,
    command: Command,
    rawInput: unknown,
    idempotencyKey: string,
  ): Promise<unknown> {
    if (family === "task-assignments" && command === "assign") {
      assertNew(itemId);
      const input = apiTaskAssignmentSchema.parse(rawInput);
      const response = await this.idempotency.run({
        viewer,
        scope: "api.task-template.assign",
        idempotencyKey,
        input,
        execute: async (commandId) => {
          const result = await new TaskService(this.env).assignTemplate(
            viewer,
            input.templateId,
            input.targetId,
            commandId,
          );
          return { taskId: result.taskId };
        },
        recover: async (commandId) => {
          const row = await this.env.DB.prepare(
            `SELECT task.id AS taskId
               FROM audit_events audit
               JOIN task_instances task
                 ON task.id = audit.entity_id AND task.event_id = audit.event_id
              WHERE audit.organisation_id = ? AND audit.event_id = ?
                AND audit.action = 'task.assigned'
                AND audit.correlation_id = ?
                AND task.template_id = ? AND task.target_id = ?
              LIMIT 1`,
          )
            .bind(
              viewer.organisationId,
              viewer.eventId,
              commandId,
              input.templateId,
              input.targetId,
            )
            .first<{ taskId: string }>();
          return row;
        },
      });
      return { ...response.result, replayed: response.replayed };
    }

    throw new ApiError(
      404,
      "ADMINISTRATION_COMMAND_NOT_FOUND",
      `The ${family}/${command} administration command is not supported`,
    );
  }

  async executeResources(
    viewer: Viewer,
    family: Family,
    itemId: string,
    command: Command,
    rawInput: unknown,
    idempotencyKey: string,
  ): Promise<unknown> {
    if (family === "resources" && command === "save") {
      const input = apiResourceSaveSchema.parse(rawInput);
      if (itemId === "new") {
        if (input.id) {
          throw new ApiError(
            422,
            "PATH_BODY_MISMATCH",
            "A new resource request must not include body.id",
          );
        }
      } else {
        if (!input.id) {
          throw new ApiError(
            422,
            "PATH_BODY_MISMATCH",
            "An existing resource save requires body.id",
          );
        }
        assertMatch(input.id, itemId, "Resource identifier");
      }
      const response = await this.idempotency.run({
        viewer,
        scope: "api.resource.save",
        idempotencyKey,
        input,
        execute: async (commandId) => {
          const pageId = input.id ?? `resource:${commandId}`;
          await new ResourceAuthoringService(this.env).save(viewer, input, {
            operationId: commandId,
            pageId,
            versionId: `resource-version:${commandId}`,
            auditId: `audit:resource:${commandId}`,
          });
          const result = await this.resourceResult(viewer, pageId, commandId);
          if (!result)
            throw new Error("The saved resource result is unavailable.");
          return result;
        },
        recover: (commandId) =>
          this.resourceResult(
            viewer,
            input.id ?? `resource:${commandId}`,
            commandId,
          ),
      });
      return { ...response.result, replayed: response.replayed };
    }

    if (family === "resources" && command === "publish") {
      const input = apiResourcePublishSchema.parse(rawInput);
      const response = await this.idempotency.run({
        viewer,
        scope: "api.resource.publish",
        idempotencyKey,
        input: { itemId, ...input },
        execute: async (commandId) => {
          await new ResourceAuthoringService(this.env).publish(
            viewer,
            itemId,
            input.revision,
            {
              operationId: commandId,
              auditId: `audit:resource-publish:${commandId}`,
            },
          );
          const result = await this.resourceResult(viewer, itemId, commandId);
          if (!result)
            throw new Error("The published resource result is unavailable.");
          return result;
        },
        recover: (commandId) => this.resourceResult(viewer, itemId, commandId),
      });
      return { ...response.result, replayed: response.replayed };
    }

    throw new ApiError(
      404,
      "ADMINISTRATION_COMMAND_NOT_FOUND",
      `The ${family}/${command} administration command is not supported`,
    );
  }
}
