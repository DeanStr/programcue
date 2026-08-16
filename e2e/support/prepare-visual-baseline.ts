import { type APIRequestContext, expect } from "@playwright/test";

import { e2eOrigin } from "./e2e-origin";
import { resetDemoEvent } from "./reset-demo-event";

const sameOriginHeaders = { origin: e2eOrigin };

export async function prepareVisualBaseline(request: APIRequestContext) {
  await resetDemoEvent(request);

  // Initialise every lazy demo-owned domain that contributes records to a
  // visual surface. Keeping this list here makes a focused visual run produce
  // the same state as the complete Playwright suite.
  for (const path of [
    "/admin/command",
    "/admin/review",
    "/admin/resources",
    "/admin/tasks",
    "/admin/schedule",
    "/admin/submissions/form",
    "/embed/future-of-events-2027",
  ] as const) {
    const response = await request.get(path);
    expect(response.ok(), `${path} should initialise its visual fixture`).toBe(
      true,
    );
  }
}

export async function seedVisualAssistantProposal(request: APIRequestContext) {
  const response = await request.post("/demo/fixtures/assistant-proposal", {
    form: {
      intent: "seed",
      confirm: "seed-assistant-approval-browser-fixture",
    },
    headers: sameOriginHeaders,
  });
  const body = (await response.json()) as {
    demonstrationOnly?: boolean;
    providerCalled?: boolean;
    taskTitle?: string;
  };
  expect(response.ok(), JSON.stringify(body)).toBe(true);
  expect(body).toMatchObject({
    demonstrationOnly: true,
    providerCalled: false,
    taskTitle: "Confirm venue accessibility handoff",
  });
  return body as Required<typeof body>;
}

export async function seedVisualAcceleventsFailure(request: APIRequestContext) {
  const response = await request.post("/demo/fixtures/golden-path", {
    form: {
      intent: "seed_accelevents_no_write",
      confirm: "seed-golden-path-browser-fixture",
    },
    headers: sameOriginHeaders,
  });
  const body = (await response.json()) as {
    demonstrationOnly?: boolean;
    providerCalled?: boolean;
    operationId?: string;
  };
  expect(response.ok(), JSON.stringify(body)).toBe(true);
  expect(body).toMatchObject({
    demonstrationOnly: true,
    providerCalled: false,
    operationId: "demo-accelevents-failed-operation",
  });
  return body as Required<typeof body>;
}
