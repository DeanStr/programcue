import { expect, test } from "@playwright/test";
import { acceptConfirm, confirmDialog } from "./support/confirm-dialog";
import { e2eOrigin } from "./support/e2e-origin";
import { openEvaluationView } from "./support/evaluation-admin";
import { resetDemoEvent } from "./support/reset-demo-event";

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
  const providerStatus = page.getByRole("status").filter({
    hasText: /not configured/i,
  });
  await expect(providerStatus).toBeVisible();
  await expect(providerStatus).toContainText(/will not simulate a response/i);
  await expect(
    page.getByRole("button", { name: "Ask assistant" }),
  ).toBeDisabled();
  await expect(page.locator("form#assistant-stream-form")).toHaveAttribute(
    "action",
    "/admin/assistant/stream",
  );
  const suggestedRequest = page.getByRole("button", {
    name: "What is blocking event readiness? Cite the exact records and rank the next three actions.",
  });
  await expect(suggestedRequest).toHaveAttribute(
    "form",
    "assistant-stream-form",
  );
  await expect(suggestedRequest).toHaveAttribute("name", "suggestedPrompt");
});

test("assistant streaming endpoint returns an event stream instead of the page document", async ({
  page,
}) => {
  await page.goto("/admin/assistant");
  const response = await page.evaluate(async () => {
    const form = new FormData();
    form.set("intent", "ask");
    form.set("prompt", "What is blocking readiness?");
    const result = await fetch("/admin/assistant/stream", {
      method: "POST",
      headers: { accept: "text/event-stream" },
      body: form,
    });
    return {
      status: result.status,
      contentType: result.headers.get("content-type"),
      body: await result.text(),
    };
  });

  expect(response.status).toBe(200);
  expect(response.contentType).toContain("text/event-stream");
  expect(response.body).toContain("event: status");
  expect(response.body).toContain("event: error");
  expect(response.body).not.toContain("<!DOCTYPE html>");
});

test("assistant reconciles a streamed proposal after approval", async ({
  page,
  request,
}) => {
  await resetDemoEvent(request);
  const configure = async (enabled: boolean) => {
    const response = await request.post("/demo/fixtures/assistant-proposal", {
      form: {
        intent: "configure_stream_test",
        confirm: FIXTURE_CONFIRMATION,
        enabled: enabled ? "yes" : "no",
      },
      headers: { origin: e2eOrigin },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  };

  await configure(true);
  try {
    await page.goto("/admin/assistant");
    await page.locator("body[data-hydrated='true']").waitFor();
    await expect(
      page.getByRole("button", { name: "Ask assistant" }),
    ).toBeEnabled();

    const fixture = await request.post("/demo/fixtures/assistant-proposal", {
      form: { intent: "seed", confirm: FIXTURE_CONFIRMATION },
      headers: { origin: e2eOrigin },
    });
    const fixtureBody = await fixture.text();
    expect(fixture.ok(), fixtureBody).toBeTruthy();
    const fixtureData = JSON.parse(fixtureBody) as {
      preview: {
        id: string;
        toolName: "propose_task";
        title: string;
        summary: string;
        consequence: string;
        changes: Array<{
          field: string;
          before: string | null;
          after: string;
        }>;
        approvalRequired: true;
      };
      runId: string;
      taskTitle: string;
    };
    const suggestedPrompt =
      "What is blocking event readiness? Cite the exact records and rank the next three actions.";
    let postedBody = "";
    await page.route("**/admin/assistant/stream", async (route) => {
      postedBody = route.request().postData() ?? "";
      const result = {
        runId: fixtureData.runId,
        operationId: fixtureData.runId,
        answer: "I prepared one exact task preview for approval.",
        attribution: {
          provider: "Anthropic",
          model: "claude-sonnet-4-6",
          responseId: "e2e-streamed-proposal",
          generatedAt: "2026-08-21T00:00:00.000Z",
          advisory: true,
        },
        evidence: [],
        proposals: [fixtureData.preview],
      };
      await route.fulfill({
        status: 200,
        contentType: "text/event-stream; charset=utf-8",
        headers: { "cache-control": "private, no-store" },
        body: [
          "event: status",
          'data: {"phase":"started"}',
          "",
          "event: delta",
          'data: {"delta":"I prepared one exact task preview for approval."}',
          "",
          "event: result",
          `data: ${JSON.stringify(result)}`,
          "",
          "",
        ].join("\n"),
      });
    });

    await page.getByRole("button", { name: suggestedPrompt }).click();
    await expect(
      page.getByRole("heading", { name: "Assistant answer" }),
    ).toBeVisible();
    expect(postedBody).toContain(suggestedPrompt);
    await expect(
      page.getByText("1 awaiting approval", { exact: true }),
    ).toBeVisible();

    let proposal = page
      .locator("section.card")
      .filter({ hasText: fixtureData.taskTitle });
    await expect(proposal).toHaveCount(1);
    await proposal.getByRole("checkbox").check();
    await proposal
      .getByRole("button", { name: "Approve and create task" })
      .click();

    await expect(
      page.getByText("The approved task was created and audited.", {
        exact: true,
      }),
    ).toBeVisible();
    proposal = page
      .locator("section.card")
      .filter({ hasText: fixtureData.taskTitle });
    await expect(proposal).toHaveCount(1);
    await expect(proposal.getByText("Executed", { exact: true })).toBeVisible();
    await expect(
      page.getByText("0 awaiting approval", { exact: true }),
    ).toBeVisible();
    await expect(
      proposal.getByRole("button", { name: "Approve and create task" }),
    ).toHaveCount(0);
  } finally {
    await configure(false);
    await resetDemoEvent(request);
  }
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
    page.getByRole("link", { name: "Communication send" }),
  ).toBeVisible();
});

test("contextual AI actions stay inside the readiness and review workflows", async ({
  page,
}) => {
  const commandResponse = await page.goto("/admin/command");
  expect(commandResponse?.headers()["cache-control"]).toBe("private, no-store");
  await page.locator("body[data-hydrated='true']").waitFor();
  const reloadResponse = await page.reload();
  expect(reloadResponse?.headers()["cache-control"]).toBe("private, no-store");
  await page.locator("body[data-hydrated='true']").waitFor();
  const readinessAction = page.getByRole("button", {
    name: "Summarise readiness blockers",
  });
  await expect(readinessAction).toBeVisible();
  const actionRequest = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/ai/context.data",
  );
  const actionResponse = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/ai/context.data",
  );
  await readinessAction.click();
  expect((await actionRequest).method()).toBe("POST");
  expect((await actionResponse).headers()["cache-control"]).toBe(
    "private, no-store",
  );
  await expect(
    page.locator(".command-advisor").getByRole("alert"),
  ).toContainText(/not configured/i);

  await page.context().addCookies([
    {
      name: "program_cue_demo_identity",
      value: "evaluator",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const reviewResponse = await page.goto("/review/workbench");
  expect(reviewResponse?.headers()["cache-control"]).toBe("private, no-store");
  await page.locator("body[data-hydrated='true']").waitFor();
  await expect(
    page.getByRole("heading", { name: "AI reviewer suggestions" }),
  ).toBeVisible();
  await expect(
    page.getByText(/event administrator must explicitly opt in/i),
  ).toBeVisible();
});

test("reviewer AI is event-opt-in, follows an initial draft, and fails fast without provider credentials", async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  await resetDemoEvent(request);
  try {
    await page.goto("/admin/review");
    await page.locator("body[data-hydrated='true']").waitFor();
    await openEvaluationView(page, "Setup");
    const setting = page.locator("section.card").filter({
      has: page.getByRole("heading", { name: "Reviewer AI suggestions" }),
    });
    await setting.getByLabel("Allow reviewer-requested AI suggestions").check();
    await setting
      .getByRole("button", { name: "Save reviewer AI setting" })
      .click();
    await expect(
      page.getByRole("status").filter({
        hasText: "Reviewer AI suggestions enabled for this event.",
      }),
    ).toBeVisible();

    await page.context().addCookies([
      {
        name: "program_cue_demo_identity",
        value: "evaluator",
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await page.goto("/review/workbench");
    await page.locator("body[data-hydrated='true']").waitFor();
    const generate = page.getByRole("button", {
      name: "Generate criterion suggestions",
    });
    if (!(await generate.isVisible())) {
      await expect(
        page.getByText("Start with your own assessment"),
      ).toBeVisible();
      await page
        .locator("[data-review-scale]")
        .first()
        .getByRole("radio", { name: "3", exact: true })
        .check();
      await expect(page.locator(".review-save-state")).toHaveText("Saved", {
        timeout: 10_000,
      });
    }
    await expect(generate).toBeEnabled();
    await generate.click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: /credentials are not configured/i }),
    ).toBeVisible();
  } finally {
    await resetDemoEvent(request);
  }
});

test("a non-actionable failed operation can be archived without erasing its history", async ({
  page,
  request,
}) => {
  const fixture = await request.post("/demo/fixtures/golden-path", {
    form: {
      intent: "seed_non_actionable_failure_alert",
      confirm: "seed-golden-path-browser-fixture",
    },
    headers: { origin: e2eOrigin },
  });
  const fixtureBody = await fixture.text();
  expect(fixture.ok(), fixtureBody).toBeTruthy();
  const fixtureData = JSON.parse(fixtureBody) as {
    operationId: string;
    providerCalled: boolean;
  };
  expect(fixtureData.providerCalled).toBe(false);

  await page.goto(
    `/admin/operations?operation=${encodeURIComponent(fixtureData.operationId)}`,
  );
  await page.locator("body[data-hydrated='true']").waitFor();
  const notificationsButton = page.getByRole("button", {
    name: /operational notifications?$/,
  });
  const notificationLabel =
    await notificationsButton.getAttribute("aria-label");
  const notificationCount = Number.parseInt(notificationLabel ?? "", 10);
  expect(notificationCount).toBeGreaterThan(0);

  const failedOperation = page
    .getByRole("list", { name: "Background operations" })
    .getByRole("listitem")
    .filter({ hasText: fixtureData.operationId });
  await expect(failedOperation).toContainText("Ai context run");
  await expect(failedOperation).toContainText(
    "a historical AI context run failed before the bug was corrected",
  );
  await failedOperation.getByRole("button", { name: "Archive alert" }).click();
  await expect(confirmDialog(page)).toContainText(
    "The failed operation, recorded error and audit history remain available.",
  );
  await acceptConfirm(page);
  await expect(
    page.getByRole("status").filter({
      hasText:
        "The failure was acknowledged and removed from active operational alerts.",
    }),
  ).toBeVisible();
  await expect(
    failedOperation.getByRole("button", { name: "Archive alert" }),
  ).toHaveCount(0);
  await expect(failedOperation).toContainText(
    "failed before the bug was corrected",
  );
  await expect(page.getByRole("region", { name: "Audit trail" })).toContainText(
    "operation · failure_acknowledged",
  );
});

test("failed operation history exposes every bounded page", async ({
  page,
  request,
}) => {
  const fixture = await request.post("/demo/fixtures/golden-path", {
    form: {
      intent: "seed_failure_alert_pagination",
      confirm: "seed-golden-path-browser-fixture",
    },
    headers: { origin: e2eOrigin },
  });
  const fixtureBody = await fixture.text();
  expect(fixture.ok(), fixtureBody).toBeTruthy();
  const fixtureData = JSON.parse(fixtureBody) as {
    operationType: string;
    operationCount: number;
    providerCalled: boolean;
  };
  expect(fixtureData).toMatchObject({
    operationCount: 51,
    providerCalled: false,
  });

  await page.goto(
    `/admin/operations?status=failed&type=${encodeURIComponent(fixtureData.operationType)}`,
  );
  await page.locator("body[data-hydrated='true']").waitFor();
  const firstPageNavigation = page.getByRole("navigation", {
    name: "Failed operation pages",
  });
  await expect(firstPageNavigation).toContainText(
    "Showing 1–50 of 51 failed operations",
  );
  await expect(
    page
      .getByRole("list", { name: "Background operations" })
      .locator(":scope > li"),
  ).toHaveCount(50);

  await firstPageNavigation.getByRole("link", { name: "Next page" }).click();
  await expect(page).toHaveURL(/(?:\?|&)page=2(?:&|$)/);
  const secondPageNavigation = page.getByRole("navigation", {
    name: "Failed operation pages",
  });
  await expect(secondPageNavigation).toContainText(
    "Showing 51–51 of 51 failed operations",
  );
  await expect(
    page
      .getByRole("list", { name: "Background operations" })
      .locator(":scope > li"),
  ).toHaveCount(1);
  await expect(
    secondPageNavigation.getByRole("link", { name: "Previous page" }),
  ).toBeVisible();
  await expect(
    secondPageNavigation.getByRole("link", { name: "Next page" }),
  ).toHaveCount(0);
});

test("an accidental contextual AI document GET renders the application error page", async ({
  page,
}) => {
  const response = await page.goto("/ai/context");
  expect(response?.status()).toBe(405);
  expect(response?.headers()["content-type"]).toContain("text/html");
  expect(response?.headers()["cache-control"]).toBe("private, no-store");
  await expect(
    page.getByRole("heading", { name: "That request could not be completed" }),
  ).toBeVisible();
  await expect(
    page.getByText("Contextual AI actions require POST.", { exact: true }),
  ).toBeVisible();
});
