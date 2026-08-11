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

type Family = z.infer<typeof apiAdministrationFamilySchema>;
type Command = z.infer<typeof apiAdministrationCommandSchema>;

type FormResult = {
  formId: string;
  revision: number;
  draftVersionId: string;
  draftRevision: number;
  publishedVersionId: string | null;
  status: string;
};

type ResourceResult = {
  pageId: string;
  revision: number;
  status: string;
  versionId: string;
  versionNumber: number;
};

type StoredWebhookSecret = {
  endpointId: string;
  secretFingerprint: string;
};

const identifierSchema = z.string().trim().min(1).max(300);

function assertNew(itemId: string) {
  if (itemId !== "new") {
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "This create command requires the literal item identifier 'new'",
    );
  }
}

function assertMatch(actual: string, expected: string, label: string) {
  if (actual !== expected) {
    throw new ApiError(
      422,
      "PATH_BODY_MISMATCH",
      `${label} in the request body must match the URL identifier`,
    );
  }
}

export class ApiAdministrationCommandService {
  private readonly idempotency: ApiPersonIdempotencyService;

  constructor(private readonly env: CloudflareEnvironment) {
    this.idempotency = new ApiPersonIdempotencyService(env);
  }

  private async restoreCurrentWebhookSecret(
    viewer: Viewer,
    stored: StoredWebhookSecret,
  ) {
    const row = await this.env.DB.prepare(
      `SELECT secret_ciphertext AS secretCiphertext
         FROM webhook_endpoints
        WHERE id = ? AND event_id = ? AND organisation_id = ?`,
    )
      .bind(stored.endpointId, viewer.eventId, viewer.organisationId)
      .first<{ secretCiphertext: string }>();
    if (
      !row ||
      (await apiRequestHash(row.secretCiphertext)) !== stored.secretFingerprint
    ) {
      throw new ApiError(
        409,
        "WEBHOOK_SECRET_SUPERSEDED",
        "This command's webhook secret has since been rotated and can no longer be replayed",
      );
    }
    return {
      endpointId: stored.endpointId,
      secret: await decryptWebhookSecret(
        row.secretCiphertext,
        stored.endpointId,
        this.env.WEBHOOK_CREDENTIALS_KEY,
      ),
      secretCiphertext: row.secretCiphertext,
    };
  }

  private async formResult(
    viewer: Viewer,
    formId: string,
    operationId?: string,
  ): Promise<FormResult | null> {
    return this.env.DB.prepare(
      `SELECT form.id AS formId, form.revision, form.status,
              draft.id AS draftVersionId, draft.revision AS draftRevision,
              published.id AS publishedVersionId
         FROM form_definitions form
         JOIN events event
           ON event.id = form.event_id AND event.organisation_id = ?
         JOIN form_versions draft
           ON draft.form_id = form.id AND draft.event_id = form.event_id
          AND draft.status = 'draft'
         LEFT JOIN form_versions published
           ON published.form_id = form.id
          AND published.event_id = form.event_id
          AND published.status = 'published'
        WHERE form.id = ? AND form.event_id = ?
          ${operationId ? "AND form.last_operation_id = ?" : ""}
        ORDER BY draft.version_number DESC LIMIT 1`,
    )
      .bind(
        viewer.organisationId,
        formId,
        viewer.eventId,
        ...(operationId ? [operationId] : []),
      )
      .first<FormResult>();
  }

  private async resourceResult(
    viewer: Viewer,
    pageId: string,
    operationId?: string,
  ): Promise<ResourceResult | null> {
    return this.env.DB.prepare(
      `SELECT page.id AS pageId, page.revision, page.status,
              version.id AS versionId, version.version_number AS versionNumber
         FROM resource_pages page
         JOIN events event
           ON event.id = page.event_id AND event.organisation_id = ?
         JOIN resource_page_versions version
           ON version.resource_page_id = page.id
          AND version.event_id = page.event_id
          AND version.status = CASE
                WHEN page.status = 'published' THEN 'published' ELSE 'draft' END
        WHERE page.id = ? AND page.event_id = ?
          ${operationId ? "AND page.last_operation_id = ?" : ""}
        ORDER BY version.version_number DESC LIMIT 1`,
    )
      .bind(
        viewer.organisationId,
        pageId,
        viewer.eventId,
        ...(operationId ? [operationId] : []),
      )
      .first<ResourceResult>();
  }

  private async decisionResult(viewer: Viewer, commandId: string) {
    return this.env.DB.prepare(
      `SELECT decision.id AS decisionId, decision.status,
              decision.decision, decision.submission_id AS submissionId,
              session.id AS sessionId,
              operation.id AS notificationOperationId,
              operation.status AS notificationStatus
         FROM submission_decisions decision
         JOIN submissions submission
           ON submission.id = decision.submission_id
          AND submission.event_id = decision.event_id
         JOIN events event
           ON event.id = decision.event_id AND event.organisation_id = ?
         LEFT JOIN sessions session
           ON session.source_submission_id = decision.submission_id
          AND session.event_id = decision.event_id
         LEFT JOIN operation_jobs operation
           ON operation.event_id = decision.event_id
          AND operation.idempotency_key = 'decision-notification:' || decision.id
        WHERE decision.id = ? AND decision.event_id = ?`,
    )
      .bind(viewer.organisationId, commandId, viewer.eventId)
      .first<{
        decisionId: string;
        status: string;
        decision: string;
        submissionId: string;
        sessionId: string | null;
        notificationOperationId: string | null;
        notificationStatus: string | null;
      }>();
  }

  private async executeForms(
    viewer: Viewer,
    family: Family,
    itemId: string,
    command: Command,
    rawInput: unknown,
    idempotencyKey: string,
  ): Promise<unknown> {
    if (family === "forms" && command === "save") {
      const input = apiFormSaveSchema.parse(rawInput);
      if (itemId === "new") {
        if (input.id) {
          throw new ApiError(
            422,
            "PATH_BODY_MISMATCH",
            "A new form request must not include body.id",
          );
        }
      } else {
        if (!input.id) {
          throw new ApiError(
            422,
            "PATH_BODY_MISMATCH",
            "An existing form save requires body.id",
          );
        }
        assertMatch(input.id, itemId, "Form identifier");
      }
      const response = await this.idempotency.run({
        viewer,
        scope: "api.form.save",
        idempotencyKey,
        input,
        execute: async (commandId) => {
          const formId = input.id ?? `form:${commandId}`;
          await new SubmissionService(this.env).saveForm(viewer, input, {
            operationId: commandId,
            formId,
            versionId: `form-version:${commandId}`,
            auditId: `audit:form:${commandId}`,
          });
          const result = await this.formResult(viewer, formId, commandId);
          if (!result) throw new Error("The saved form result is unavailable.");
          return result;
        },
        recover: async (commandId) =>
          this.formResult(viewer, input.id ?? `form:${commandId}`, commandId),
      });
      return { ...response.result, replayed: response.replayed };
    }

    if (family === "forms" && command === "publish") {
      const input = apiFormPublishSchema.parse(rawInput);
      if (itemId === "new") {
        throw new ApiError(
          422,
          "VALIDATION_ERROR",
          "A form must be saved before it can be published",
        );
      }
      const response = await this.idempotency.run({
        viewer,
        scope: "api.form.publish",
        idempotencyKey,
        input: { itemId, ...input },
        execute: async (commandId) => {
          await new SubmissionService(this.env).publishForm(
            viewer,
            itemId,
            input.formRevision,
            input.draftRevision,
            {
              operationId: commandId,
              nextVersionId: `form-version-next:${commandId}`,
              auditId: `audit:form-publish:${commandId}`,
            },
          );
          const result = await this.formResult(viewer, itemId, commandId);
          if (!result)
            throw new Error("The published form result is unavailable.");
          return result;
        },
        recover: (commandId) => this.formResult(viewer, itemId, commandId),
      });
      return { ...response.result, replayed: response.replayed };
    }

    throw new ApiError(
      404,
      "ADMINISTRATION_COMMAND_NOT_FOUND",
      `The ${family}/${command} administration command is not supported`,
    );
  }

  private async executePeople(
    viewer: Viewer,
    family: Family,
    itemId: string,
    command: Command,
    rawInput: unknown,
    idempotencyKey: string,
  ): Promise<unknown> {
    if (family === "people" && command === "invite") {
      assertNew(itemId);
      const input = apiPersonInvitationSchema.parse(rawInput);
      const response = await this.idempotency.run({
        viewer,
        scope: "api.person.invite",
        idempotencyKey,
        input,
        execute: async (commandId) => {
          const result = await new EventService(this.env).inviteAdministrator(
            viewer,
            input,
            {
              operationId: commandId,
              personId: `person:${commandId}`,
              membershipId: `membership:${commandId}`,
              auditId: `audit:membership-invite:${commandId}`,
            },
          );
          return {
            membershipId: result.membershipId,
            scope: input.scope,
            status: "invited" as const,
          };
        },
        recover: async (commandId) => {
          const row = await this.env.DB.prepare(
            `SELECT membership.id AS membershipId
               FROM memberships membership
               JOIN people person ON person.id = membership.person_id
              WHERE membership.organisation_id = ?
                AND membership.last_operation_id = ?
                AND membership.role = 'administrator'
                AND membership.revoked_at IS NULL
                AND person.email = ? COLLATE NOCASE
                AND ((? = 'event' AND membership.event_id = ?)
                  OR (? = 'organisation' AND membership.event_id IS NULL))`,
          )
            .bind(
              viewer.organisationId,
              commandId,
              input.email,
              input.scope,
              viewer.eventId,
              input.scope,
            )
            .first<{ membershipId: string }>();
          return row
            ? {
                membershipId: row.membershipId,
                scope: input.scope,
                status: "invited" as const,
              }
            : null;
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

  private async executeMemberships(
    viewer: Viewer,
    family: Family,
    itemId: string,
    command: Command,
    rawInput: unknown,
    idempotencyKey: string,
  ): Promise<unknown> {
    if (family === "memberships" && command === "revoke") {
      const input = apiMembershipRevocationSchema.parse(rawInput);
      assertMatch(input.membershipId, itemId, "Membership identifier");
      const response = await this.idempotency.run({
        viewer,
        scope: "api.membership.revoke",
        idempotencyKey,
        input,
        execute: (commandId) =>
          new EventService(this.env).revokeAdministrator(viewer, input, {
            operationId: commandId,
            auditId: `audit:membership-revoke:${commandId}`,
          }),
        recover: async (commandId) => {
          const row = await this.env.DB.prepare(
            `SELECT id AS membershipId,
                    CASE WHEN event_id IS NULL THEN 'organisation' ELSE 'event' END AS scope
               FROM memberships
              WHERE id = ? AND organisation_id = ?
                AND (event_id = ? OR event_id IS NULL)
                AND role = 'administrator' AND revoked_at IS NOT NULL
                AND last_operation_id = ?`,
          )
            .bind(itemId, viewer.organisationId, viewer.eventId, commandId)
            .first<{
              membershipId: string;
              scope: "event" | "organisation";
            }>();
          return row;
        },
      });
      return {
        ...response.result,
        status: "revoked",
        replayed: response.replayed,
      };
    }

    throw new ApiError(
      404,
      "ADMINISTRATION_COMMAND_NOT_FOUND",
      `The ${family}/${command} administration command is not supported`,
    );
  }

  private async executeSessions(
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

  private async executeDecisions(
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

  private async executeTaskTemplates(
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

  private async executeTaskAssignments(
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

  private async executeResources(
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

  private async executeIntegrationConnections(
    viewer: Viewer,
    family: Family,
    itemId: string,
    command: Command,
    rawInput: unknown,
    idempotencyKey: string,
  ): Promise<unknown> {
    if (family === "integration-connections" && command === "connect") {
      assertNew(itemId);
      const input = apiIntegrationConnectionSchema.parse(rawInput);
      const response = await this.idempotency.run({
        viewer,
        scope: "api.integration.connect",
        idempotencyKey,
        input,
        execute: (commandId) =>
          new IntegrationService(this.env).configureAccelevents(viewer, input, {
            operationId: commandId,
            connectionId: `integration:${commandId}`,
          }),
        recover: async (commandId) => {
          const row = await this.env.DB.prepare(
            `SELECT id AS connectionId FROM integration_connections
              WHERE event_id = ? AND organisation_id = ?
                AND provider = 'accelevents' AND status = 'connected'
                AND last_operation_id = ?`,
          )
            .bind(viewer.eventId, viewer.organisationId, commandId)
            .first<{ connectionId: string }>();
          return row;
        },
      });
      return {
        ...response.result,
        status: "connected",
        replayed: response.replayed,
      };
    }

    if (family === "integration-connections" && command === "disconnect") {
      apiIntegrationDisconnectSchema.parse(rawInput);
      const response = await this.idempotency.run({
        viewer,
        scope: "api.integration.disconnect",
        idempotencyKey,
        input: { itemId },
        execute: (commandId) =>
          new IntegrationService(this.env).disconnect(
            viewer,
            itemId,
            commandId,
          ),
        recover: async (commandId) => {
          const row = await this.env.DB.prepare(
            `SELECT id AS connectionId FROM integration_connections
              WHERE id = ? AND event_id = ? AND organisation_id = ?
                AND status = 'disconnected' AND last_operation_id = ?`,
          )
            .bind(itemId, viewer.eventId, viewer.organisationId, commandId)
            .first<{ connectionId: string }>();
          return row;
        },
      });
      return {
        ...response.result,
        status: "disconnected",
        replayed: response.replayed,
      };
    }

    throw new ApiError(
      404,
      "ADMINISTRATION_COMMAND_NOT_FOUND",
      `The ${family}/${command} administration command is not supported`,
    );
  }

  private async executeIntegrationMappings(
    viewer: Viewer,
    family: Family,
    itemId: string,
    command: Command,
    rawInput: unknown,
    idempotencyKey: string,
  ): Promise<unknown> {
    if (family === "integration-mappings" && command === "save") {
      const input = apiIntegrationMappingSchema.parse(rawInput);
      const response = await this.idempotency.run({
        viewer,
        scope: "api.integration-mapping.save",
        idempotencyKey,
        input: { connectionId: itemId, ...input },
        execute: (commandId) =>
          new IntegrationService(this.env).saveMapping(
            viewer,
            itemId,
            input,
            commandId,
          ),
        recover: async (commandId) => {
          const row = await this.env.DB.prepare(
            `SELECT mapping.id AS mappingId
               FROM integration_entity_mappings mapping
               JOIN integration_connections connection
                 ON connection.id = mapping.connection_id
              WHERE mapping.connection_id = ? AND mapping.entity_type = ?
                AND mapping.entity_id = ? AND mapping.last_operation_id = ?
                AND connection.event_id = ? AND connection.organisation_id = ?`,
          )
            .bind(
              itemId,
              input.entityType,
              input.entityId,
              commandId,
              viewer.eventId,
              viewer.organisationId,
            )
            .first<{ mappingId: string }>();
          return row;
        },
      });
      return { ...response.result, replayed: response.replayed };
    }

    if (family === "integration-mappings" && command === "delete") {
      const input = apiIntegrationMappingDeleteSchema.parse(rawInput);
      const response = await this.idempotency.run({
        viewer,
        scope: "api.integration-mapping.delete",
        idempotencyKey,
        input: { connectionId: itemId, ...input },
        execute: (commandId) =>
          new IntegrationService(this.env).deleteMapping(
            viewer,
            itemId,
            input.entityType,
            input.entityId,
            commandId,
          ),
        recover: async (commandId) => {
          const row = await this.env.DB.prepare(
            `SELECT entity_id AS mappingId FROM audit_events
              WHERE organisation_id = ? AND event_id = ?
                AND action = 'integration.mapping.deleted'
                AND correlation_id = ? LIMIT 1`,
          )
            .bind(viewer.organisationId, viewer.eventId, commandId)
            .first<{ mappingId: string }>();
          return row;
        },
      });
      return {
        ...response.result,
        status: "deleted",
        replayed: response.replayed,
      };
    }

    throw new ApiError(
      404,
      "ADMINISTRATION_COMMAND_NOT_FOUND",
      `The ${family}/${command} administration command is not supported`,
    );
  }

  private async executeWebhookEndpoints(
    viewer: Viewer,
    family: Family,
    itemId: string,
    command: Command,
    rawInput: unknown,
    idempotencyKey: string,
  ): Promise<unknown> {
    if (family === "webhook-endpoints" && command === "save") {
      assertNew(itemId);
      const input = apiWebhookEndpointSchema.parse(rawInput);
      const service = new WebhookService(this.env);
      const response = await this.idempotency.run<
        { endpointId: string; secret: string; secretCiphertext: string },
        StoredWebhookSecret
      >({
        viewer,
        scope: "api.webhook-endpoint.save",
        idempotencyKey,
        input,
        execute: async (commandId) => {
          const endpointId = `webhook:${commandId}`;
          const created = await service.create(viewer, input, {
            operationId: commandId,
            endpointId,
          });
          return {
            endpointId: created.id,
            secret: created.secret,
            secretCiphertext: created.secretCiphertext,
          };
        },
        recover: async (commandId) => {
          const endpointId = `webhook:${commandId}`;
          const row = await this.env.DB.prepare(
            `SELECT secret_ciphertext AS secretCiphertext
               FROM webhook_endpoints
              WHERE id = ? AND event_id = ? AND organisation_id = ?
                AND last_operation_id = ?`,
          )
            .bind(endpointId, viewer.eventId, viewer.organisationId, commandId)
            .first<{ secretCiphertext: string }>();
          return row
            ? {
                endpointId,
                secret: await decryptWebhookSecret(
                  row.secretCiphertext,
                  endpointId,
                  this.env.WEBHOOK_CREDENTIALS_KEY,
                ),
                secretCiphertext: row.secretCiphertext,
              }
            : null;
        },
        store: async ({ endpointId, secretCiphertext }) => ({
          endpointId,
          secretFingerprint: await apiRequestHash(secretCiphertext),
        }),
        restore: (stored) => this.restoreCurrentWebhookSecret(viewer, stored),
      });
      const current = await this.restoreCurrentWebhookSecret(viewer, {
        endpointId: response.result.endpointId,
        secretFingerprint: await apiRequestHash(
          response.result.secretCiphertext,
        ),
      });
      return {
        endpointId: current.endpointId,
        secret: current.secret,
        replayed: response.replayed,
      };
    }

    if (family === "webhook-endpoints" && command === "status") {
      const input = apiWebhookStatusSchema.parse(rawInput);
      const response = await this.idempotency.run({
        viewer,
        scope: "api.webhook-endpoint.status",
        idempotencyKey,
        input: { endpointId: itemId, ...input },
        execute: (commandId) =>
          new WebhookService(this.env).setStatus(
            viewer,
            itemId,
            input.status,
            commandId,
          ),
        recover: async (commandId) => {
          const row = await this.env.DB.prepare(
            `SELECT id AS endpointId, status FROM webhook_endpoints
              WHERE id = ? AND event_id = ? AND organisation_id = ?
                AND status = ? AND last_operation_id = ?`,
          )
            .bind(
              itemId,
              viewer.eventId,
              viewer.organisationId,
              input.status,
              commandId,
            )
            .first<{ endpointId: string; status: "active" | "disabled" }>();
          return row;
        },
      });
      return { ...response.result, replayed: response.replayed };
    }

    if (family === "webhook-endpoints" && command === "test") {
      apiWebhookTestSchema.parse(rawInput);
      const response = await this.idempotency.run({
        viewer,
        scope: "api.webhook-endpoint.test",
        idempotencyKey,
        input: { endpointId: itemId },
        execute: (commandId) =>
          new WebhookService(this.env).queueTest(viewer, itemId, commandId),
        recover: async (commandId) => {
          const key = `webhook-test:${itemId}:${commandId}`;
          const row = await this.env.DB.prepare(
            `SELECT delivery.id AS deliveryId,
                    operation.id AS operationId, operation.status
               FROM webhook_deliveries delivery
               JOIN operation_items item
                 ON item.entity_type = 'webhook_delivery'
                AND item.entity_id = delivery.id
               JOIN operation_jobs operation ON operation.id = item.operation_id
              WHERE delivery.endpoint_id = ? AND delivery.idempotency_key = ?
                AND operation.event_id = ? AND operation.organisation_id = ?`,
          )
            .bind(itemId, key, viewer.eventId, viewer.organisationId)
            .first<{
              deliveryId: string;
              operationId: string;
              status: string;
            }>();
          return row ? { ...row, replayed: true } : null;
        },
      });
      return { ...response.result, replayed: response.replayed };
    }

    if (family === "webhook-endpoints" && command === "rotate-secret") {
      apiWebhookRotateSecretSchema.parse(rawInput);
      const service = new WebhookService(this.env);
      const response = await this.idempotency.run<
        { endpointId: string; secret: string; secretCiphertext: string },
        StoredWebhookSecret
      >({
        viewer,
        scope: "api.webhook-endpoint.rotate-secret",
        idempotencyKey,
        input: { endpointId: itemId },
        execute: (commandId) => service.rotateSecret(viewer, itemId, commandId),
        recover: async (commandId) => {
          const row = await this.env.DB.prepare(
            `SELECT secret_ciphertext AS secretCiphertext
               FROM webhook_endpoints
              WHERE id = ? AND event_id = ? AND organisation_id = ?
                AND last_operation_id = ?`,
          )
            .bind(itemId, viewer.eventId, viewer.organisationId, commandId)
            .first<{ secretCiphertext: string }>();
          return row
            ? {
                endpointId: itemId,
                secret: await decryptWebhookSecret(
                  row.secretCiphertext,
                  itemId,
                  this.env.WEBHOOK_CREDENTIALS_KEY,
                ),
                secretCiphertext: row.secretCiphertext,
              }
            : null;
        },
        store: async ({ endpointId, secretCiphertext }) => ({
          endpointId,
          secretFingerprint: await apiRequestHash(secretCiphertext),
        }),
        restore: (stored) => this.restoreCurrentWebhookSecret(viewer, stored),
      });
      const current = await this.restoreCurrentWebhookSecret(viewer, {
        endpointId: response.result.endpointId,
        secretFingerprint: await apiRequestHash(
          response.result.secretCiphertext,
        ),
      });
      return {
        endpointId: current.endpointId,
        secret: current.secret,
        replayed: response.replayed,
      };
    }

    throw new ApiError(
      404,
      "ADMINISTRATION_COMMAND_NOT_FOUND",
      `The ${family}/${command} administration command is not supported`,
    );
  }

  async execute(
    viewer: Viewer,
    rawFamily: string | undefined,
    rawItemId: string | undefined,
    rawCommand: string | undefined,
    rawInput: unknown,
    idempotencyKey: string,
  ) {
    const family = apiAdministrationFamilySchema.parse(rawFamily);
    const command = apiAdministrationCommandSchema.parse(rawCommand);
    const itemId = identifierSchema.parse(rawItemId);
    const handlers = {
      forms: this.executeForms,
      people: this.executePeople,
      memberships: this.executeMemberships,
      sessions: this.executeSessions,
      decisions: this.executeDecisions,
      "task-templates": this.executeTaskTemplates,
      "task-assignments": this.executeTaskAssignments,
      resources: this.executeResources,
      "integration-connections": this.executeIntegrationConnections,
      "integration-mappings": this.executeIntegrationMappings,
      "webhook-endpoints": this.executeWebhookEndpoints,
    } satisfies Record<Family, typeof this.executeForms>;
    return handlers[family].call(
      this,
      viewer,
      family,
      itemId,
      command,
      rawInput,
      idempotencyKey,
    );
  }
}
