import { expect, test } from "@playwright/test";

import { resetDemoEvent } from "./support/reset-demo-event";

test.beforeEach(async ({ context, request }) => {
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
  await resetDemoEvent(request);
});

async function waitForInterface(
  page: import("@playwright/test").Page,
  path: string,
) {
  const response = await page.goto(path);
  expect(response?.ok()).toBeTruthy();
  await page.locator("body[data-hydrated='true']").waitFor();
}

async function selectSpeaker(page: import("@playwright/test").Page) {
  await page.context().addCookies([
    {
      name: "program_cue_demo_role",
      value: "speaker",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

test("task status bulk actions require an exact preview and can be cancelled", async ({
  page,
}) => {
  await waitForInterface(page, "/admin/tasks");
  await waitForInterface(page, "/admin/tasks/bulk");
  await page.locator('select[name="action"]').selectOption("reopen");
  const candidate = page.locator(".bulk-record-picker label").filter({
    hasText: "Complete your speaker profile",
  });
  await expect(candidate).toContainText("Priya Shah · completed · revision 1");
  await candidate.getByRole("checkbox").check();
  await page.getByRole("button", { name: "Preview exact changes" }).click();
  await expect(page).toHaveURL(/operation=/);
  await expect(
    page.getByRole("heading", { name: "2. Review and confirm" }),
  ).toBeVisible();
  const previewRow = page.getByRole("row").filter({
    has: page.getByText("Complete your speaker profile · Priya Shah", {
      exact: true,
    }),
  });
  await expect(
    previewRow.getByRole("cell", {
      name: "completed → not started",
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel preview" }).click();
  const cancellationNotice = page
    .locator(".validation-item.ok[role='status']")
    .filter({
      has: page.getByText("Bulk workflow updated", { exact: true }),
    });
  await expect(cancellationNotice).toContainText(
    "The preview was cancelled without changing task records.",
  );
  await expect(
    page.getByRole("link", { name: "Prepare overdue reminders" }),
  ).toHaveAttribute(
    "href",
    "/admin/communications?audience=overdue_speakers&category=task_reminder",
  );
  await waitForInterface(page, "/admin/tasks");
  const unchangedTask = page.getByRole("row").filter({
    has: page.getByText("Complete your speaker profile", { exact: true }),
  });
  await expect(unchangedTask.getByLabel("Complete status")).toBeVisible();
  await expect(unchangedTask).toContainText("Revision 1");
});

test("a speaker can undo a reversible task completion from its status notice", async ({
  page,
}) => {
  await selectSpeaker(page);
  await waitForInterface(page, "/speaker/tasks");
  const task = page.locator("article.speaker-task").filter({
    hasText: "Read the speaker handbook",
  });
  await task.getByRole("checkbox").check();
  await task.getByRole("button", { name: "Complete task" }).click();
  const actionNotice = page.locator(".pc-status-notice[role='status']");
  await expect(
    actionNotice.getByText(
      "Task completed. You can undo this for five minutes.",
      { exact: true },
    ),
  ).toBeVisible();
  const completionToast = page.locator("[data-sonner-toast]").filter({
    has: page.getByText("Task completed", { exact: true }),
  });
  await expect(
    completionToast.getByText(
      "This shortcut remains available until the server-issued window expires unless later work makes undo unsafe.",
      { exact: true },
    ),
  ).toBeVisible();
  await completionToast.getByRole("button", { name: "Undo" }).click();
  const undoToast = page.locator("[data-sonner-toast]").filter({
    has: page.getByText("Task completion undone", { exact: true }),
  });
  await expect(undoToast).toBeVisible();
  await expect(
    actionNotice.getByText("Task completion undone.", { exact: true }),
  ).toBeVisible();
  await expect(
    task.getByLabel("Not started status", { exact: true }),
  ).toBeVisible();
});

test("speaker task evidence uses the signed direct uploader", async ({
  page,
}) => {
  await selectSpeaker(page);
  await waitForInterface(page, "/speaker/tasks");
  const task = page.locator("article.speaker-task").filter({
    hasText: "Upload presentation slides",
  });
  await expect(
    task.getByText("Upload evidence", { exact: true }),
  ).toBeVisible();
  await expect(task.locator('input[name="directFile"]')).toHaveAttribute(
    "type",
    "file",
  );
  await expect(
    task.locator('input[name="intent"][value="upload-task"]'),
  ).toHaveCount(0);
});
