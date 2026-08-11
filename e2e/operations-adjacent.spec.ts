import { expect, test } from "@playwright/test";

import { resetDemoEvent } from "./support/reset-demo-event";
import { resetDemoSubmissions } from "./support/reset-demo-submissions";

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

async function waitForInterface(
  page: import("@playwright/test").Page,
  path: string,
) {
  const response = await page.goto(path);
  expect(response?.ok()).toBeTruthy();
  await page.locator("body[data-hydrated='true']").waitFor();
}

test("event cloning shows its copy boundary and records a clean event", async ({
  page,
}) => {
  await page.context().addCookies([
    {
      name: "program_cue_demo_role",
      value: "owner",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await waitForInterface(page, "/admin/events/clone");
  await expect(
    page.getByRole("heading", { name: /Clone Future of Events 2025/ }),
  ).toBeVisible();
  await expect(page.getByText("Intentionally excluded")).toBeVisible();
  await page.getByLabel("Event name").fill("Browser clone event");
  await page.getByLabel("Public slug").fill("browser-clone-event");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Create clean clone" }).click();
  const cloneStatus = page
    .getByRole("main")
    .getByRole("status")
    .filter({ hasText: "Clone complete" });
  await expect(cloneStatus).toBeVisible();
  await expect(
    page.getByRole("link", { name: "view clone audit" }),
  ).toBeVisible();
});

test("CSV import exposes a durable preview before confirming", async ({
  page,
}) => {
  await page.context().addCookies([
    {
      name: "program_cue_demo_role",
      value: "owner",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const exported = await page.request.post("/admin/exports/rooms.csv", {
    headers: { origin: "http://127.0.0.1:5173" },
    form: { idempotencyKey: crypto.randomUUID() },
  });
  expect(exported.ok()).toBeTruthy();
  expect(await exported.text()).toContain("id,name,capacity,position,status");
  const csv = [
    "name,building,level,capacity,position,status",
    "Main Stage,,,1200,0,active",
  ].join("\n");

  await waitForInterface(page, "/admin/operations?panel=imports");
  await page.getByLabel("Record type").selectOption("rooms");
  await page.getByLabel("CSV file").setInputFiles({
    name: "rooms.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });
  await page.getByRole("button", { name: "Preview import" }).click();
  await expect(page).toHaveURL(/panel=imports&operation=/);
  const operationId = new URL(page.url()).searchParams.get("operation");
  expect(operationId).toBeTruthy();
  await expect(page.getByText("Preview ready to commit")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Record-level results" }),
  ).toBeVisible();

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Confirm import" }).click();
  const importStatus = page
    .getByRole("main")
    .getByRole("status")
    .filter({ hasText: /Imported \d+ rooms records/ });
  await expect(importStatus).toBeVisible();
  const operationsTable = page.getByRole("table").filter({
    has: page.getByRole("columnheader", { name: "Operation", exact: true }),
  });
  const operationRow = operationsTable
    .getByRole("row")
    .filter({ hasText: operationId! });
  await expect(
    operationRow.getByRole("link", { name: "data.import", exact: true }),
  ).toBeVisible();
});

test("task import previews disclose every lifecycle transition before confirmation", async ({
  page,
  request,
}) => {
  await resetDemoEvent(request);
  await page.context().addCookies([
    {
      name: "program_cue_demo_role",
      value: "owner",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const csv = [
    "id,title,description,targetType,targetId,ownerEmail,status,statusReason,impact,dueAt",
    "task-demo-handbook,Read the speaker handbook,Read and acknowledge the current handbook,speaker,person-demo-speaker,priya.speaker@example.com,waived,No longer required,medium,",
  ].join("\n");

  await waitForInterface(page, "/admin/operations?panel=imports");
  await page.getByLabel("Record type").selectOption("tasks");
  await page.getByLabel("CSV file").setInputFiles({
    name: "task-lifecycle.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv),
  });
  await page.getByRole("button", { name: "Preview import" }).click();
  await expect(page).toHaveURL(/panel=imports&operation=/);
  const operationId = new URL(page.url()).searchParams.get("operation");
  expect(operationId).toBeTruthy();

  await expect(page.getByText("1 task lifecycle change")).toBeVisible();
  await expect(
    page.getByText(
      "(task-demo-handbook): not started → waived (waive)",
      { exact: false },
    ),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", {
      name: "Task status: not started → waived · transition: waive",
    }),
  ).toBeVisible();

  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("1 listed task lifecycle change");
    await dialog.dismiss();
  });
  await page.getByRole("button", { name: "Confirm import" }).click();
  await expect(page.getByText("Preview ready to commit")).toBeVisible();

  const operationsTable = page.getByRole("table").filter({
    has: page.getByRole("columnheader", { name: "Operation", exact: true }),
  });
  const operationRow = operationsTable
    .getByRole("row")
    .filter({ hasText: operationId! });
  page.once("dialog", (dialog) => dialog.accept());
  await operationRow.getByRole("button", { name: "Cancel" }).click();
  await expect(
    page
      .getByRole("main")
      .getByRole("status")
      .filter({ hasText: `Operation ${operationId} was cancelled` }),
  ).toBeVisible();
});

test("session tags and archive state use preview, confirmation and real undo", async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  await resetDemoSubmissions(request);
  const unique = Date.now();
  const title = `Sponsor briefing bulk ${unique}`;
  try {
    await waitForInterface(page, "/admin/submissions");
    await page.getByText("Create a guaranteed direct session").click();
    const directSessionForm = page.locator("form").filter({
      has: page.getByRole("button", { name: "Create unscheduled session" }),
    });
    await directSessionForm.getByLabel("Session title").fill(title);
    await directSessionForm
      .getByLabel("Description")
      .fill("A disposable session used to exercise reviewed bulk changes.");
    await directSessionForm
      .getByLabel("Speaker 1 name")
      .fill("Bulk Browser Speaker");
    await directSessionForm
      .getByLabel("Email")
      .fill(`sponsor-bulk-${unique}@example.com`);
    await directSessionForm
      .getByRole("button", { name: "Create unscheduled session" })
      .click();
    const directSessionStatus = page
      .getByRole("main")
      .getByRole("status")
      .filter({ hasText: "Direct session created" });
    await expect(directSessionStatus).toBeVisible();

    await waitForInterface(page, "/admin/sessions/bulk");
    const sessionsTable = page.getByRole("table", {
      name: "Sessions available for bulk update",
    });
    await sessionsTable
      .getByRole("checkbox", { name: `Select ${title}`, exact: true })
      .check();
    await page.getByLabel("New tag name").fill(`Browser tag ${unique}`);
    await page
      .getByRole("button", { name: "Preview affected records" })
      .click();
    await expect(page).toHaveURL(/operation=/);
    await expect(
      page.getByRole("heading", { name: "2. Review and confirm" }),
    ).toBeVisible();
    await expect(page.getByText(/No tags → Browser tag/)).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Confirm exact changes" }).click();
    const main = page.getByRole("main");
    await expect(
      main
        .getByRole("status")
        .filter({ hasText: "confirmed changes were applied" }),
    ).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await page
      .getByRole("button", { name: "Prepare five-minute undo" })
      .click();
    await expect(
      main.getByRole("status").filter({ hasText: "inverse changes are ready" }),
    ).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Confirm exact changes" }).click();
    await expect(
      main
        .getByRole("status")
        .filter({ hasText: "confirmed changes were applied" }),
    ).toBeVisible();

    await waitForInterface(page, "/admin/sessions/bulk");
    await page.locator('select[name="action"]').selectOption("archive");
    await page
      .getByRole("table", { name: "Sessions available for bulk update" })
      .getByRole("checkbox", { name: `Select ${title}`, exact: true })
      .check();
    await page
      .getByRole("button", { name: "Preview affected records" })
      .click();
    await expect(page.getByText("unscheduled → archived")).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Confirm exact changes" }).click();
    await expect(
      main
        .getByRole("status")
        .filter({ hasText: "confirmed changes were applied" }),
    ).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await page
      .getByRole("button", { name: "Prepare five-minute undo" })
      .click();
    await expect(page.getByText("archived → unscheduled")).toBeVisible();
    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Confirm exact changes" }).click();
    await expect(
      main
        .getByRole("status")
        .filter({ hasText: "confirmed changes were applied" }),
    ).toBeVisible();
  } finally {
    await resetDemoSubmissions(request);
  }
});
