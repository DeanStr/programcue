import { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";
import {
  apiAdministrationCommandSchema,
  apiAdministrationFamilySchema,
} from "./api-command-contract";
import type { Family } from "./api-administration-command-foundation.server";
import { ApiAdministrationPeopleCommands } from "./api-administration-people-commands.server";
import { ApiAdministrationDomainCommands } from "./api-administration-domain-commands.server";
import { ApiAdministrationIntegrationCommands } from "./api-administration-integration-commands.server";

const identifierSchema = z.string().trim().min(1).max(300);

export class ApiAdministrationCommandService {
  constructor(private readonly env: CloudflareEnvironment) {}

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
    const people = new ApiAdministrationPeopleCommands(this.env);
    const domain = new ApiAdministrationDomainCommands(this.env);
    const integrations = new ApiAdministrationIntegrationCommands(this.env);
    const handlers = {
      forms: people.executeForms.bind(people),
      people: people.executePeople.bind(people),
      memberships: people.executeMemberships.bind(people),
      sessions: domain.executeSessions.bind(domain),
      decisions: domain.executeDecisions.bind(domain),
      "task-templates": domain.executeTaskTemplates.bind(domain),
      "task-assignments": domain.executeTaskAssignments.bind(domain),
      resources: domain.executeResources.bind(domain),
      "integration-connections":
        integrations.executeIntegrationConnections.bind(integrations),
      "integration-mappings":
        integrations.executeIntegrationMappings.bind(integrations),
      "webhook-endpoints":
        integrations.executeWebhookEndpoints.bind(integrations),
    } satisfies Record<Family, typeof people.executeForms>;
    return handlers[family](
      viewer,
      family,
      itemId,
      command,
      rawInput,
      idempotencyKey,
    );
  }
}
