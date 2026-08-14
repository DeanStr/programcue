import { expect, test } from "@playwright/test";

import { e2eOrigin } from "./support/e2e-origin";
import { resetDemoEvent } from "./support/reset-demo-event";
import { resetDemoSubmissions } from "./support/reset-demo-submissions";
import {
  acceptConfirm,
  confirmDialog,
  dismissConfirm,
} from "./support/confirm-dialog";

const FIXTURE_CONFIRMATION = "seed-golden-path-browser-fixture";

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
      name: "program_cue_demo_identity",
      value: "owner",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const unique = Date.now();
  await waitForInterface(page, "/admin/events/new");
  await page.getByLabel("Event name").fill(`Browser clone source ${unique}`);
  await page.getByLabel("Public slug").fill(`browser-clone-source-${unique}`);
  await page.getByRole("button", { name: "Create blank event" }).click();
  await acceptConfirm(page);
  await expect(page.getByText("Event created", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open new event" }).click();
  await expect(page.locator(".event-switcher strong")).toHaveText(
    `Browser clone source ${unique}`,
  );

  await waitForInterface(page, "/admin/events/clone");
  await expect(
    page.getByRole("heading", { name: /Clone Browser clone source/ }),
  ).toBeVisible();
  await expect(page.getByText("Intentionally excluded")).toBeVisible();
  await page.getByLabel("Event name").fill(`Browser clone event ${unique}`);
  await page.getByLabel("Public slug").fill(`browser-clone-event-${unique}`);
  await page.getByRole("button", { name: "Create clean clone" }).click();
  await acceptConfirm(page);
  const cloneStatus = page
    .getByRole("main")
    .getByRole("status")
    .filter({ hasText: "Clone complete" });
  await expect(cloneStatus).toBeVisible();
  await expect(
    page.getByRole("link", { name: "view clone audit" }),
  ).toBeVisible();
});

test("blank event creation keeps templates empty and makes repository authority explicit", async ({
  page,
}) => {
  const unique = Date.now();
  await page.context().addCookies([
    {
      name: "program_cue_demo_identity",
      value: "owner",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await waitForInterface(page, "/admin/events/new");
  await expect(page.getByRole("heading", { name: "New event" })).toBeVisible();
  await expect(page.getByText("Empty by design")).toBeVisible();
  await expect(page.getByLabel("Reuse verified sender")).toHaveValue("");
  await expect(
    page.getByLabel("Reuse verified sender").getByRole("option", {
      name: "None — configure later",
    }),
  ).toHaveCount(1);
  await expect(
    page.getByRole("radio", { name: /Cloudflare D1/ }),
  ).toBeChecked();
  await page.getByRole("radio", { name: /Airtable/ }).check();
  await expect(page.getByLabel("Reuse verified sender")).toHaveCount(0);
  await expect(page.getByLabel("Personal access token")).toBeVisible();
  await expect(page.getByLabel("Base ID")).toBeVisible();
  await page.getByRole("radio", { name: /Cloudflare D1/ }).check();
  await page.getByLabel("Event name").fill(`Browser blank event ${unique}`);
  await page.getByLabel("Public slug").fill(`browser-blank-event-${unique}`);
  await page.getByRole("button", { name: "Create blank event" }).click();
  await acceptConfirm(page);
  await expect(page.getByText("Event created", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "View creation operation" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open new event" }).click();
  await expect(page.locator(".event-switcher strong")).toHaveText(
    `Browser blank event ${unique}`,
  );
  await waitForInterface(page, "/admin/command");
  await expect(
    page.getByRole("heading", { name: "Run this programme" }),
  ).toBeVisible();
  await expect(page.getByText("0 of 4 phases ready")).toBeVisible();
  for (const phase of [
    "Set up",
    "Collect and decide",
    "Prepare speakers",
    "Publish and verify",
  ]) {
    await expect(page.getByRole("heading", { name: phase })).toBeVisible();
  }
  await expect(
    page.getByRole("link", { name: /Publish an application form/ }),
  ).toHaveAttribute("href", "/admin/submissions/form");
});

test("failed Airtable creation stays inaccessible until D1 is explicitly selected", async ({
  page,
  request,
}) => {
  await page.context().addCookies([
    {
      name: "program_cue_demo_identity",
      value: "owner",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const fixture = await request.post("/demo/fixtures/golden-path", {
    form: {
      intent: "seed_event_repository_recovery",
      confirm: FIXTURE_CONFIRMATION,
    },
    headers: { origin: e2eOrigin },
  });
  const fixtureText = await fixture.text();
  expect(fixture.ok(), fixtureText).toBeTruthy();
  const seeded = JSON.parse(fixtureText) as {
    eventId: string;
    recoveryPath: string;
    providerCalled: boolean;
  };
  expect(seeded.providerCalled).toBe(false);

  await waitForInterface(page, "/events/select");
  await expect(
    page.getByText("Airtable recovery browser fixture", { exact: true }),
  ).toHaveCount(0);

  await waitForInterface(page, "/admin/event");
  await expect(
    page.getByRole("heading", { name: "Incomplete events" }),
  ).toBeVisible();
  await page
    .getByRole("link", { name: "Recover Airtable recovery browser fixture" })
    .click();
  await expect(page).toHaveURL(seeded.recoveryPath);
  await expect(
    page.getByRole("heading", { name: "Airtable recovery browser fixture" }),
  ).toBeVisible();
  await expect(
    page.getByText("provisioning failed", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText(/no provider request was made/)).toBeVisible();
  await expect(page.getByLabel("Base ID")).toHaveValue("");
  await expect(page.getByLabel("Rooms table")).toHaveValue("");

  await page.getByRole("button", { name: "Explicitly keep on D1" }).click();
  await acceptConfirm(page);
  await expect(
    page.getByText("Recovery complete", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open recovered event" }).click();
  await expect(page).toHaveURL(/\/admin\/event$/);
  await expect(
    page.getByRole("heading", { name: "Event Setup" }),
  ).toBeVisible();
});

test("CSV import exposes a durable preview before confirming", async ({
  page,
}) => {
  await page.context().addCookies([
    {
      name: "program_cue_demo_identity",
      value: "owner",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const exported = await page.request.post("/admin/exports/rooms.csv", {
    headers: { origin: e2eOrigin },
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

  await page.getByRole("button", { name: "Confirm import" }).click();
  await acceptConfirm(page);
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
      name: "program_cue_demo_identity",
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
    page.getByText("(task-demo-handbook): not started → waived (waive)", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", {
      name: "Task status: not started → waived · transition: waive",
    }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Confirm import" }).click();
  await expect(confirmDialog(page)).toContainText(
    "1 listed task lifecycle change",
  );
  await dismissConfirm(page);
  await expect(page.getByText("Preview ready to commit")).toBeVisible();

  const operationsTable = page.getByRole("table").filter({
    has: page.getByRole("columnheader", { name: "Operation", exact: true }),
  });
  const operationRow = operationsTable
    .getByRole("row")
    .filter({ hasText: operationId! });
  await operationRow.getByRole("button", { name: "Cancel" }).click();
  await expect(
    confirmDialog(page).locator("[data-pc-confirm='cancel']"),
  ).toBeFocused();
  await acceptConfirm(page);
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
    await directSessionForm.getByLabel("Track").selectOption({ index: 1 });
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
    await page.getByRole("button", { name: "Confirm exact changes" }).click();
    await acceptConfirm(page);
    const main = page.getByRole("main");
    await expect(
      main
        .getByRole("status")
        .filter({ hasText: "confirmed changes were applied" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Prepare five-minute undo" })
      .click();
    await acceptConfirm(page);
    await expect(
      main.getByRole("status").filter({ hasText: "inverse changes are ready" }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Confirm exact changes" }).click();
    await acceptConfirm(page);
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
    await page.getByRole("button", { name: "Confirm exact changes" }).click();
    await acceptConfirm(page);
    await expect(
      main
        .getByRole("status")
        .filter({ hasText: "confirmed changes were applied" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Prepare five-minute undo" })
      .click();
    await acceptConfirm(page);
    await expect(page.getByText("archived → unscheduled")).toBeVisible();
    await page.getByRole("button", { name: "Confirm exact changes" }).click();
    await acceptConfirm(page);
    await expect(
      main
        .getByRole("status")
        .filter({ hasText: "confirmed changes were applied" }),
    ).toBeVisible();
  } finally {
    await resetDemoSubmissions(request);
  }
});
