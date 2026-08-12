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

export class ApiAdministrationPeopleCommands extends ApiAdministrationCommandExecutor {
  async executeForms(
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

  async executePeople(
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

  async executeMemberships(
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
}
