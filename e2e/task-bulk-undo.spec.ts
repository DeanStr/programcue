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
      name: "program_cue_demo_identity",
      value: "speaker",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

async function selectAdministrator(page: import("@playwright/test").Page) {
  await page.context().addCookies([
    {
      name: "program_cue_demo_identity",
      value: "administrator",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

test("task dashboard filters visible work and keeps template creation open", async ({
  page,
}) => {
  await selectAdministrator(page);
  await waitForInterface(page, "/admin/tasks");
  const filters = page.getByRole("region", { name: "Filter assigned work" });
  const assignedWork = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Assigned work" }),
  });
  await page.getByText("Create a template", { exact: true }).click();
  const templateCreation = page.getByRole("region", {
    name: "Create task template",
  });

  await expect(filters.getByLabel("Status")).toBeVisible();
  await expect(templateCreation.getByLabel("Due date anchor")).toBeVisible();
  await expect(
    templateCreation.getByRole("button", { name: "Create template" }),
  ).toBeVisible();

  const handbookTask = assignedWork.getByRole("row").filter({
    has: page.getByText("Read the speaker handbook", { exact: true }),
  });
  await handbookTask.getByText("Extend deadline", { exact: true }).click();
  await handbookTask.getByLabel(/New deadline/).fill("2035-05-20");
  await handbookTask
    .getByLabel("Reason for deadline extension")
    .fill("Speaker requested an individual extension.");
  await handbookTask.getByRole("button", { name: "Confirm extension" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Speaker deadline extended" }),
  ).toBeVisible();

  await filters.getByLabel("Status").selectOption("completed");
  await filters.getByRole("button", { name: "Apply filters" }).click();
  await expect(page).toHaveURL(/state=completed/u);
  await expect(page.getByText("Showing 1 of 3 tasks")).toBeVisible();
  await expect(
    assignedWork.getByText("Complete your speaker profile", { exact: true }),
  ).toBeVisible();
  await expect(
    assignedWork.getByText("Upload presentation slides", { exact: true }),
  ).toHaveCount(0);

  await filters.getByLabel("Status").selectOption("not_started");
  await filters.getByLabel("Task type").selectOption("file_upload");
  await filters.getByRole("button", { name: "Apply filters" }).click();
  await expect(page).toHaveURL(/state=not_started/u);
  await expect(page).toHaveURL(/type=file_upload/u);
  await expect(
    assignedWork.getByText("Upload presentation slides", { exact: true }),
  ).toBeVisible();
  await expect(
    assignedWork.getByText("Complete your speaker profile", { exact: true }),
  ).toHaveCount(0);
});

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

test("an unavailable task preview returns to the bulk workspace", async ({
  page,
}) => {
  await waitForInterface(
    page,
    "/admin/tasks/bulk?operation=00000000-0000-4000-8000-000000000000",
  );
  const unavailable = page.getByRole("alert");
  await expect(unavailable).toContainText(
    "This preview is no longer available",
  );
  await expect(unavailable).toContainText(
    "Create a new preview before confirming any changes.",
  );
  await expect(
    page.getByRole("heading", { name: "1. Configure a task action" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "This page could not load" }),
  ).toHaveCount(0);
});

test("a speaker can undo a reversible task completion from its status notice", async ({
  page,
}) => {
  await selectAdministrator(page);
  await waitForInterface(page, "/admin/tasks");
  await page.getByText("Create a template", { exact: true }).click();
  const creation = page.getByRole("region", {
    name: "Create task template",
  });
  await creation.getByLabel("Name").fill("Confirm arrival details");
  await creation
    .getByLabel("Description")
    .fill("Confirm the final arrival arrangements.");
  await creation.locator('select[name="taskType"]').selectOption("checklist");
  await creation.getByRole("button", { name: "Create template" }).click();
  await expect(page.locator(".pc-status-notice[role='status']")).toContainText(
    "Task template created",
  );

  await page.getByText("Plan and onboarding", { exact: true }).click();
  const assignment = page.locator("section.tasks-plan-block").filter({
    has: page.getByRole("heading", { name: "Assign a plan" }),
  });
  await assignment.locator('select[name="templateId"]').selectOption({
    label: "Confirm arrival details",
  });
  await assignment.locator('select[name="targetId"]').selectOption({
    label: "Priya Shah · priya.speaker@example.com",
  });
  await assignment
    .getByRole("button", { name: "Assign with prerequisites" })
    .click();
  await expect(page.locator(".pc-status-notice[role='status']")).toContainText(
    "Task plan assigned",
  );

  await selectSpeaker(page);
  await waitForInterface(page, "/participant/tasks");
  const task = page.locator("article.speaker-task").filter({
    hasText: "Confirm arrival details",
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
  await expect(
    actionNotice.getByText("Task completion undone.", { exact: true }),
  ).toBeVisible();
  await expect(task.getByRole("checkbox")).not.toBeChecked();
  await expect(
    task.getByRole("button", { name: "Complete task" }),
  ).toBeVisible();
  await expect(task.getByText("Completed", { exact: true })).toHaveCount(0);
});

test("a link task opens the organiser destination and requires acknowledgement", async ({
  page,
}) => {
  await selectAdministrator(page);
  await waitForInterface(page, "/admin/tasks");
  await page.getByText("Create a template", { exact: true }).click();
  const creation = page.getByRole("region", {
    name: "Create task template",
  });
  await creation.getByLabel("Name").fill("Review the arrival guide");
  await creation.getByLabel("Description").fill("Read the arrival details.");
  await creation.locator('select[name="taskType"]').selectOption("link_visit");
  await creation
    .getByLabel("Destination URL")
    .fill("https://example.test/arrival-guide");
  await creation.getByRole("button", { name: "Create template" }).click();
  await expect(page.locator(".pc-status-notice[role='status']")).toContainText(
    "Task template created",
  );

  await page.getByText("Plan and onboarding", { exact: true }).click();
  const assignment = page.locator("section.tasks-plan-block").filter({
    has: page.getByRole("heading", { name: "Assign a plan" }),
  });
  await assignment.locator('select[name="templateId"]').selectOption({
    label: "Review the arrival guide",
  });
  await assignment.locator('select[name="targetId"]').selectOption({
    label: "Priya Shah · priya.speaker@example.com",
  });
  await assignment
    .getByRole("button", { name: "Assign with prerequisites" })
    .click();
  await expect(page.locator(".pc-status-notice[role='status']")).toContainText(
    "Task plan assigned",
  );

  await selectSpeaker(page);
  await waitForInterface(page, "/participant/tasks");
  const task = page.locator("article.speaker-task").filter({
    hasText: "Review the arrival guide",
  });
  const link = task.getByRole("link", { name: "Open link" });
  await expect(link).toHaveAttribute(
    "href",
    "https://example.test/arrival-guide",
  );
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  await expect(
    task.getByRole("button", { name: "Complete task" }),
  ).toBeDisabled();
  await task.getByRole("checkbox", { name: "I’ve visited this link" }).check();
  await task.getByRole("button", { name: "Complete task" }).click();
  await expect(page.locator(".pc-status-notice[role='status']")).toContainText(
    "Task completed",
  );
  await expect(task.getByText("Completed", { exact: true })).toBeVisible();
});

test("speaker task evidence uses the signed direct uploader", async ({
  page,
}) => {
  await selectSpeaker(page);
  await waitForInterface(page, "/participant/tasks");
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

test("deliverable comments preserve author and event-local timestamps across roles", async ({
  page,
}) => {
  const speakerMessage = "Draft deck - final version coming Friday.";
  const administratorReply = "Thanks — the programme team will review it.";
  await selectSpeaker(page);
  await waitForInterface(page, "/participant/tasks");
  let task = page.locator("article.speaker-task").filter({
    hasText: "Upload presentation slides",
  });
  const speakerComposer = task.locator("details.speaker-task-comment");
  await speakerComposer.locator("summary").click();
  await speakerComposer
    .getByRole("textbox", { name: "Message" })
    .fill(speakerMessage);
  await speakerComposer.getByRole("button", { name: "Send" }).click();
  let comment = task.locator("blockquote.task-comment").filter({
    hasText: speakerMessage,
  });
  await expect(comment).toContainText("Priya Shah");
  await expect(comment.locator("time")).toHaveAttribute(
    "data-exact-time",
    /America\/Toronto/,
  );

  await selectAdministrator(page);
  await waitForInterface(page, "/admin/tasks");
  const row = page.getByRole("row").filter({
    has: page.getByText("Upload presentation slides", { exact: true }),
  });
  await row
    .locator("details")
    .filter({ hasText: "1 message" })
    .locator("summary")
    .click();
  comment = row.locator("blockquote.task-comment").filter({
    hasText: speakerMessage,
  });
  await expect(comment).toContainText("Priya Shah");
  await expect(comment.locator("time")).toHaveAttribute(
    "data-exact-time",
    /America\/Toronto/,
  );

  const administratorComposer = row.locator("details").filter({
    hasText: "Add comment",
  });
  await administratorComposer.locator("summary").click();
  await administratorComposer
    .getByRole("textbox", { name: "Message" })
    .fill(administratorReply);
  await administratorComposer
    .getByRole("button", { name: "Send comment" })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Comment added." }),
  ).toBeVisible();
  comment = row.locator("blockquote.task-comment").filter({
    hasText: administratorReply,
  });
  await expect(comment).toContainText("Jordan Alvarez");
  await expect(comment.locator("time")).toHaveAttribute(
    "data-exact-time",
    /America\/Toronto/,
  );

  await selectSpeaker(page);
  await waitForInterface(page, "/participant/tasks");
  task = page.locator("article.speaker-task").filter({
    hasText: "Upload presentation slides",
  });
  comment = task.locator("blockquote.task-comment").filter({
    hasText: administratorReply,
  });
  await expect(comment).toContainText("Jordan Alvarez");
  await expect(comment.locator("time")).toHaveAttribute(
    "data-exact-time",
    /America\/Toronto/,
  );
});
