import { describe, expect, it } from "vitest";
import { aiAssistantResultSchema } from "./ai-types";

const result = {
  runId: "run-1",
  operationId: "operation-1",
  answer: "Review the proposed task.",
  attribution: {
    provider: "Workers AI",
    model: "configured-model",
    responseId: "response-1",
    generatedAt: "2026-09-06T00:00:00Z",
    advisory: true,
  },
  evidence: [
    {
      id: "task-1",
      label: "Task",
      detail: "Overdue",
      href: "/admin/tasks",
      source: "Program Cue D1",
    },
  ],
  proposals: [
    {
      id: "proposal-1",
      title: "Follow up",
      summary: "A task",
      consequence: "Creates one task",
      changes: [{ field: "title", before: null, after: "Follow up" }],
      toolName: "propose_task",
      approvalRequired: true,
    },
  ],
};

describe("assistant result contract", () => {
  it("retains the evidence and explicit approval requirement of a valid result", () => {
    expect(aiAssistantResultSchema.parse(result)).toEqual(result);
  });
  it.each([
    null,
    {},
    { ...result, attribution: {} },
    { ...result, evidence: [{}] },
    {
      ...result,
      proposals: [{ ...result.proposals[0], approvalRequired: false }],
    },
    {
      ...result,
      proposals: [
        { ...result.proposals[0], toolName: "propose_reminder_send" },
      ],
    },
  ])("rejects incomplete or inconsistent results %#", (payload) => {
    expect(aiAssistantResultSchema.safeParse(payload).success).toBe(false);
  });
});
