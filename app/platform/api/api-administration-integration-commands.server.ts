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
  type StoredWebhookSecret,
} from "./api-administration-command-foundation.server";

export class ApiAdministrationIntegrationCommands extends ApiAdministrationCommandExecutor {
  async executeIntegrationConnections(
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

  async executeIntegrationMappings(
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

  async executeWebhookEndpoints(
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
}
