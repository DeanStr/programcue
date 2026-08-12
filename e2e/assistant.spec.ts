import { expect, test } from "@playwright/test";

import { e2eOrigin } from "./support/e2e-origin";

const FIXTURE_CONFIRMATION = "seed-assistant-approval-browser-fixture";

test.beforeEach(async ({ context }) => {
  await context.addCookies([
    {
      name: "program_cue_event",
      value: "evt-foe-2025",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
});

test("assistant fails explicitly when the OpenAI credential is unavailable", async ({
  page,
}) => {
  const response = await page.goto("/admin/assistant");
  expect(response?.ok()).toBeTruthy();
  await page.locator("body[data-hydrated='true']").waitFor();
  await expect(
    page.getByRole("heading", { name: "Event Assistant" }),
  ).toBeVisible();
  await expect(
    page.getByText("AI provider is not configured", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Ask assistant" }),
  ).toBeDisabled();
  await expect(page.getByText(/simulate a response/i)).toBeVisible();
});

test("assistant task preview requires confirmation and executes through the real task command", async ({
  page,
  request,
}) => {
  const fixture = await request.post("/demo/fixtures/assistant-proposal", {
    form: { intent: "seed", confirm: FIXTURE_CONFIRMATION },
    headers: { origin: e2eOrigin },
  });
  const fixtureBody = await fixture.text();
  expect(fixture.ok(), fixtureBody).toBeTruthy();
  const fixtureData = JSON.parse(fixtureBody) as {
    demonstrationOnly: boolean;
    providerCalled: boolean;
    taskTitle: string;
  };
  expect(fixtureData).toMatchObject({
    demonstrationOnly: true,
    providerCalled: false,
  });

  await page.goto("/admin/assistant");
  await page.locator("body[data-hydrated='true']").waitFor();
  const proposal = page
    .locator("section.card")
    .filter({ hasText: fixtureData.taskTitle });
  await expect(
    proposal.getByText("Approval required", { exact: true }),
  ).toBeVisible();
  const approve = proposal.getByRole("button", {
    name: "Approve and create task",
  });
  await approve.click();
  await expect(
    page.getByText("The approved task was created and audited.", {
      exact: true,
    }),
  ).not.toBeVisible();

  await proposal.getByRole("checkbox").check();
  await approve.click();
  await expect(
    page.getByText("The approved task was created and audited.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open created task" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Open created task" }).click();
  await expect(page).toHaveURL(/\/admin\/tasks\?task=/);
  await expect(
    page
      .getByRole("table")
      .getByRole("row")
      .filter({ hasText: fixtureData.taskTitle }),
  ).toBeVisible();
});

test("assistant reminder preview can be edited and queues exactly once only after approval", async ({
  page,
  request,
}) => {
  const fixture = await request.post("/demo/fixtures/assistant-proposal", {
    form: { intent: "seed_reminder", confirm: FIXTURE_CONFIRMATION },
    headers: { origin: e2eOrigin },
  });
  const fixtureBody = await fixture.text();
  expect(fixture.ok(), fixtureBody).toBeTruthy();
  const fixtureData = JSON.parse(fixtureBody) as {
    demonstrationOnly: boolean;
    providerCalled: boolean;
    subject: string;
    deliverableAddress: string;
    suppressedAddress: string;
  };
  expect(fixtureData).toMatchObject({
    demonstrationOnly: true,
    providerCalled: false,
  });

  await page.goto("/admin/assistant");
  await page.locator("body[data-hydrated='true']").waitFor();
  let proposal = page
    .locator("section.card")
    .filter({ hasText: fixtureData.subject })
    .first();
  await expect(
    proposal.getByText("Approval required", { exact: true }),
  ).toBeVisible();
  await proposal.getByText(/Review all \d+ selected recipients/).click();
  await expect(
    proposal.getByText(fixtureData.deliverableAddress),
  ).toBeVisible();
  await expect(proposal.getByText(fixtureData.suppressedAddress)).toBeVisible();
  await expect(
    proposal.getByText("Suppressed", { exact: true }).first(),
  ).toBeVisible();

  const revisedSubject = "Final action: {{task.title}}";
  await proposal.getByLabel("Subject").fill(revisedSubject);
  await proposal
    .getByLabel("Message template")
    .fill(
      "Hello {{recipient.firstName}}, please complete {{task.title}} in your speaker workspace today.",
    );
  await proposal.getByRole("button", { name: "Update exact preview" }).click();
  await expect(
    page.getByText(/saved as a new immutable template version/i),
  ).toBeVisible();
  proposal = page
    .locator("section.card")
    .filter({ hasText: revisedSubject })
    .first();
  await expect(proposal.getByLabel("Subject")).toHaveValue(revisedSubject);

  const approve = proposal.getByRole("button", {
    name: "Approve and queue reminder",
  });
  await approve.click();
  await expect(
    page.getByText("The approved reminder was recorded, queued and audited.", {
      exact: true,
    }),
  ).not.toBeVisible();
  await proposal.getByRole("checkbox").check();
  await approve.click();
  await expect(
    page.getByText("The approved reminder was recorded, queued and audited.", {
      exact: true,
    }),
  ).toBeVisible();
  const operationLink = page.getByRole("link", { name: "Open operation" });
  await expect(operationLink).toBeVisible();
  await operationLink.click();
  await expect(page).toHaveURL(/\/admin\/operations\?operation=/);
  await expect(
    page.getByRole("heading", { name: "Operation Centre" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "communication.send" }),
  ).toBeVisible();
});

test("contextual AI actions stay inside the readiness and review workflows", async ({
  page,
}) => {
  await page.goto("/admin/command");
  await page.locator("body[data-hydrated='true']").waitFor();
  const readinessAction = page.getByRole("button", {
    name: "Summarise readiness blockers",
  });
  await expect(readinessAction).toBeVisible();
  await readinessAction.click();
  await expect(page.getByRole("alert")).toContainText("OPENAI_API_KEY");

  await page.context().addCookies([
    {
      name: "program_cue_demo_role",
      value: "evaluator",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto("/review/workbench");
  await page.locator("body[data-hydrated='true']").waitFor();
  await expect(
    page.getByRole("button", { name: "Generate advisory review aid" }),
  ).toBeVisible();
  await expect(
    page.getByText(/cannot score, submit or change your review/i),
  ).toBeVisible();
});
