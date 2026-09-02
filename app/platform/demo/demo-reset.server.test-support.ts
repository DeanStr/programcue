import { env } from "cloudflare:test";

import { assistantProposalMetadataSchema } from "~/modules/ai/ai-tools.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { DEMO_EVENT_ID, DEMO_ORGANISATION_ID } from "./demo-reset.server";

export function demoEnvironment(
  overrides: Partial<CloudflareEnvironment> = {},
) {
  return {
    ...(env as unknown as CloudflareEnvironment),
    APP_ENV: "demo",
    DEMO_MODE: "true",
    DEFAULT_EVENT_ID: DEMO_EVENT_ID,
    ...overrides,
  } as CloudflareEnvironment;
}

export const demoAdministrator: Viewer = {
  personId: "person-demo-admin",
  name: "Jordan Alvarez",
  email: "sbek-organizer@example.com",
  role: "administrator",
  organisationId: DEMO_ORGANISATION_ID,
  eventId: DEMO_EVENT_ID,
  demo: true,
};

export function taskProposalMetadata(proposalId: string, model: string) {
  return assistantProposalMetadataSchema.parse({
    version: 1,
    toolName: "propose_task",
    runId: crypto.randomUUID(),
    model,
    arguments: {
      title: "Confirm venue accessibility handoff",
      description: "Confirm the documented handoff with the venue team.",
      targetType: "event",
      targetId: DEMO_EVENT_ID,
      ownerPersonId: null,
      taskType: "administrator_only",
      impact: "high",
      dueAt: null,
      dependencyIds: [],
    },
    preview: {
      id: proposalId,
      toolName: "propose_task",
      title: "Confirm venue accessibility handoff",
      summary: "Create one administrator task for the demo event.",
      consequence: "Approval creates one durable event task.",
      changes: [
        {
          field: "Task",
          before: null,
          after: "Confirm venue accessibility handoff",
        },
      ],
      approvalRequired: true,
    },
  });
}
