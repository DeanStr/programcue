import { expect, type Page, test } from "@playwright/test";

import { acceptConfirm, dismissConfirm } from "./support/confirm-dialog";
import { resetDemoEvent } from "./support/reset-demo-event";

test("speaker profile, sessions and D1 task state render through the production portal", async ({
  page,
}) => {
  await page.context().addCookies([
    {
      name: "program_cue_demo_identity",
      value: "speaker",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
    {
      name: "program_cue_event",
      value: "evt-foe-2025",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto("/participant/dashboard");
  await expect(
    page.getByRole("heading", { name: /Welcome back, Priya/ }),
  ).toBeVisible();
  // The task progress bar was replaced by a preparation stepper covering
  // profile, sessions, tasks and required resource acknowledgements.
  const stepper = page.locator(".speaker-stepper");
  await expect(
    page.getByRole("heading", { name: "Your preparation" }),
  ).toBeVisible();
  await expect(stepper.locator(".speaker-stage")).toHaveCount(4);
  await expect(stepper).toContainText("Profile marked published");
  for (const stage of ["Profile", "Sessions", "Requirements", "Resources"]) {
    await expect(
      stepper.getByRole("link", { name: new RegExp(stage) }),
    ).toBeVisible();
  }
  await expect(page.getByRole("heading", { name: "My tasks" })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Recent updates" }),
  ).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Overview" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.getByRole("link", { name: "My sessions", exact: true }).click();
  await expect(page).toHaveURL(/\/participant\/sessions$/u);
  await expect(
    page.getByRole("heading", { name: "Designing inclusive event technology" }),
  ).toBeVisible();
  const sessionCard = page
    .locator(".speaker-session-card")
    .filter({ hasText: "Designing inclusive event technology" });
  await expect(sessionCard).toContainText(
    "Practical patterns for accessible, calm and effective attendee experiences.",
  );
  await expect(sessionCard).toContainText("1 role need a response");
  const speakerRole = sessionCard
    .locator(".speaker-role-response")
    .filter({ hasText: "Speaker" });
  await expect(speakerRole).toBeVisible();
  await speakerRole.getByText("Decline this role", { exact: true }).click();
  await speakerRole
    .getByLabel("Reason (optional)")
    .fill("A private scheduling concern");
  await speakerRole.getByRole("button", { name: "Decline role" }).click();
  await acceptConfirm(page);
  await expect(page.getByRole("status")).toContainText("You declined");
  await expect(sessionCard).toContainText("Declined by you");

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
  await page.goto("/admin/speakers/person-demo-speaker#sessions");
  const adminSessionRow = page
    .getByRole("row")
    .filter({ hasText: "Designing inclusive event technology" });
  await expect(adminSessionRow).toContainText("Speaker: Declined");
  await expect(adminSessionRow).toContainText(
    "Private reason: A private scheduling concern",
  );
  await adminSessionRow.getByRole("button", { name: "Reset speaker" }).click();
  await acceptConfirm(page);
  await expect(page.locator(".pc-status-notice")).toContainText(
    "Reset the speaker role for “Designing inclusive event technology” to awaiting confirmation. No message was sent.",
  );
  await expect(adminSessionRow).toContainText("Speaker: Awaiting response");
  await expect(adminSessionRow).not.toContainText("Private reason:");
  await adminSessionRow.getByRole("button", { name: "Add moderator" }).click();
  const assignmentDialog = page.getByRole("dialog");
  await expect(assignmentDialog).toContainText("Assign the moderator role?");
  await expect(assignmentDialog).toContainText(
    "Designing inclusive event technology",
  );
  await expect(assignmentDialog).toContainText("Priya Shah");
  await dismissConfirm(page);
  await expect(adminSessionRow).not.toContainText(
    "Moderator: Awaiting response",
  );

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
  await page.goto("/participant/sessions");
  await sessionCard
    .getByRole("button", {
      name: "Accept Speaker role in Designing inclusive event technology",
    })
    .click();
  await acceptConfirm(page);
  await expect(page.getByRole("status")).toContainText("Speaker role accepted");
  await expect(speakerRole).toContainText("Accepted");
  await expect(
    sessionCard.getByRole("button", {
      name: "Accept Speaker role in Designing inclusive event technology",
    }),
  ).toHaveCount(0);
  await page.reload();
  await expect(speakerRole).toContainText("Accepted");
  await page.getByRole("link", { name: "Tasks" }).click();
  await expect(page).toHaveURL(/\/participant\/tasks$/u);
  await expect(
    page.getByRole("heading", { name: "Upload presentation slides" }).first(),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Tasks" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(
    page.getByRole("link", { name: "Overview" }),
  ).not.toHaveAttribute("aria-current");
  const slidesTask = page.locator('article[id^="task-"]').filter({
    has: page.getByRole("heading", { name: "Upload presentation slides" }),
  });
  await expect(slidesTask.getByLabel("File purpose")).toContainText(
    "Presentation slides",
  );
  await expect(slidesTask.getByLabel("Choose file")).toHaveAttribute(
    "accept",
    /\.pdf,.ppt,.pptx/u,
  );
  const commentTask = page.locator('article[id^="task-"]').first();
  const commentTaskElementId = await commentTask.getAttribute("id");
  if (!commentTaskElementId)
    throw new Error("Participant task anchor is missing.");
  const commentTaskId = commentTaskElementId.slice("task-".length);
  await page.goto(
    `/participant/tasks?task=${encodeURIComponent(commentTaskId)}&compose=comment#${encodeURIComponent(commentTaskElementId)}`,
  );
  await page.locator("body[data-hydrated='true']").waitFor();
  const correctionTask = page.locator(`article[id="${commentTaskElementId}"]`);
  const correctionField = correctionTask.getByLabel("Message");
  await expect(correctionTask.locator("details")).toHaveAttribute("open", "");
  await expect(correctionField).toBeFocused();
  await page.getByRole("link", { name: "Files" }).click();
  await expect(page.getByRole("link", { name: /^Download / })).toHaveCount(0);
  await expect(
    page.getByText("Upload a headshot", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("File purpose").locator("option")).toHaveCount(
    1,
  );
  await expect(page.getByLabel("File purpose")).toContainText("Headshot");
  await expect(
    page.getByText(/Upload slides, handouts, posters/),
  ).toBeVisible();
  await page.getByRole("link", { name: "Profile" }).click();
  await expect(
    page.getByRole("link", { name: "Upload headshot" }),
  ).toHaveAttribute("href", "/participant/files#headshot-upload");
  await page
    .getByLabel("LinkedIn profile URL")
    .fill("http://www.linkedin.com/in/priya-shah");
  await page.getByLabel("LinkedIn profile URL").press("Tab");
  await expect(page.getByLabel("LinkedIn profile URL")).toHaveValue(
    "https://www.linkedin.com/in/priya-shah",
  );
  await page.getByLabel("X handle").fill("https://x.com/priya_shah");
  await page.getByLabel("X handle").press("Tab");
  await expect(page.getByLabel("X handle")).toHaveValue("@priya_shah");
  await page
    .getByLabel("Travel and logistics preferences")
    .fill("Arrival May 11, aisle seat; dietary: Vegetarian");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Your profile was saved",
  );
  await page.reload();
  await expect(page.getByLabel("Job title")).toHaveValue(/Director/);
  await expect(page.getByLabel("LinkedIn profile URL")).toHaveValue(
    "https://www.linkedin.com/in/priya-shah",
  );
  await expect(page.getByLabel("X handle")).toHaveValue("@priya_shah");
  await expect(page.getByLabel("Travel and logistics preferences")).toHaveValue(
    "Arrival May 11, aisle seat; dietary: Vegetarian",
  );

  await page.getByLabel("LinkedIn profile URL").fill("");
  await page.getByLabel("X handle").fill("");
  await page.getByLabel("Travel and logistics preferences").fill("");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Your profile was saved",
  );
});

test.describe("optional session-details review", () => {
  test.beforeEach(async ({ page, request }) => {
    await page.context().addCookies([
      {
        name: "program_cue_demo_identity",
        value: "administrator",
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
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

  test.afterEach(async ({ request }) => {
    await resetDemoEvent(request);
  });

  test("renders, corrects and revision-binds the shared session acknowledgement", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/admin/tasks");
    await page.locator("body[data-hydrated='true']").waitFor();
    await page.getByRole("button", { name: "Plans & onboarding" }).click();
    const preset = page.locator("section.tasks-plan-block").filter({
      has: page.getByRole("heading", { name: "Session-detail review" }),
    });
    await preset.getByRole("checkbox").check();
    await preset
      .getByRole("button", { name: "Create session review task" })
      .click();
    const actionNotice = page.locator(".pc-status-notice[role='status']");
    await expect(actionNotice).toContainText(
      "The optional session-details review task is ready",
    );

    const assignment = page.locator("section.tasks-plan-block").filter({
      has: page.getByRole("heading", { name: "Assign a plan" }),
    });
    await expect(assignment).toBeVisible();
    await assignment.locator('select[name="templateId"]').selectOption({
      label: "Review session details",
    });
    await assignment.locator('select[name="targetId"]').selectOption({
      label: "Designing inclusive event technology",
    });
    await assignment
      .getByRole("button", { name: "Assign with prerequisites" })
      .click();
    await expect(actionNotice).toContainText("Task plan assigned");

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
    await page.goto("/participant/sessions");
    await page.locator("body[data-hydrated='true']").waitFor();
    const session = page.locator(".speaker-session-card").filter({
      hasText: "Designing inclusive event technology",
    });
    await session.getByRole("link", { name: "Request a correction" }).click();
    await expect(page).toHaveURL(
      /\/participant\/tasks\?task=[^&]+&compose=comment#task-/u,
    );
    await page.locator("body[data-hydrated='true']").waitFor();

    const taskId = new URL(page.url()).searchParams.get("task");
    if (!taskId) throw new Error("Session correction link omitted its task.");
    const task = page.locator(`article[id="task-${taskId}"]`);
    await expect(
      task.getByRole("heading", { name: "Review session details" }),
    ).toBeVisible();
    await expect(task).toContainText("Designing inclusive event technology");
    await expect(task).toContainText(
      "Practical patterns for accessible, calm and effective attendee experiences.",
    );
    await expect(task).toContainText("presentation · 45 minutes");
    await expect(task).toContainText("No track assigned");
    await expect(task.locator("details")).toHaveAttribute("open", "");
    await expect(task.getByLabel("Message")).toBeFocused();

    const revisionInput = task.locator('input[name="sessionDetailsRevision"]');
    const reviewedRevision = await revisionInput.getAttribute("value");
    if (!reviewedRevision) {
      throw new Error("Session review omitted its displayed revision.");
    }
    await task
      .getByLabel(
        "I have reviewed these shared session details and they are correct",
      )
      .check();
    await task.getByRole("button", { name: "Complete task" }).click();
    await expect(actionNotice).toContainText("Task completed");
    await expect(task.getByText("Completed", { exact: true })).toBeVisible();

    await page.reload();
    await expect(task.getByText("Completed", { exact: true })).toBeVisible();
    await expect(task).toContainText("Designing inclusive event technology");

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
    await page.goto("/admin/schedule?session=session-demo-speaker");
    await page.locator("body[data-hydrated='true']").waitFor();
    await page.getByRole("button", { name: "Create next draft" }).click();
    const confirmation = page.getByRole("dialog", {
      name: "Create the next schedule draft?",
    });
    await confirmation
      .getByRole("button", { name: "Confirm new draft" })
      .click();
    const editor = page.getByTestId("session-content-editor");
    await expect(editor.getByLabel("Title")).toHaveValue(
      "Designing inclusive event technology",
    );
    await editor
      .getByLabel("Public description")
      .fill("Updated session details after participant acknowledgement.");
    await expect(editor.getByText("Saved", { exact: true })).toBeVisible({
      timeout: 10_000,
    });

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
    await page.goto(`/participant/tasks?task=${taskId}#task-${taskId}`);
    await page.locator("body[data-hydrated='true']").waitFor();
    await expect(task.getByText("Completed", { exact: true })).toBeVisible();
    await expect(task.getByRole("status")).toContainText(
      `This task was completed for session revision ${reviewedRevision}; current revision`,
    );
    await expect(task.getByRole("status")).toContainText(
      "Ask the event team to reopen this task",
    );

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
    await page.goto(`/admin/tasks?task=${encodeURIComponent(taskId)}`);
    await page.locator("body[data-hydrated='true']").waitFor();
    const assignedTask = page.getByRole("row").filter({
      has: page.getByText("Review session details", { exact: true }),
    });
    await assignedTask.getByRole("button", { name: "Reopen" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Task reopened." }),
    ).toBeVisible();
    await expect(assignedTask).toContainText("Not started");
  });
});

test("a submitter enters the same participant workspace and can open applications", async ({
  page,
}) => {
  await page.context().addCookies([
    {
      name: "program_cue_demo_identity",
      value: "submitter",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
    {
      name: "program_cue_event",
      value: "evt-foe-2025",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto("/participant/dashboard");
  await expect(
    page.getByRole("navigation", { name: "Participant workspace" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Applications" }).first().click();
  await expect(page).toHaveURL(/\/participant\/applications$/u);
  await expect(
    page.getByRole("heading", { name: "Applications", level: 1 }),
  ).toBeVisible();
});

test("an administrator demo identity cannot use a speaker-owned portal", async ({
  page,
}) => {
  await page.goto("/admin/event");
  await page.context().addCookies([
    {
      name: "program_cue_demo_identity",
      value: "administrator",
      domain: "127.0.0.1",
      path: "/",
    },
  ]);
  const response = await page.goto("/participant/dashboard");
  expect(response?.status()).toBe(403);
  await expect(
    page.getByRole("heading", { name: "You do not have access" }),
  ).toBeVisible();
});

async function useDemoEvent(page: Page) {
  await page.context().addCookies([
    {
      name: "program_cue_event",
      value: "evt-foe-2025",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

/** Adds an organisation-owned speaker record and opens its event detail. */
async function addEventOwnedSpeaker(page: Page, name: string, email: string) {
  await page.goto("/admin/speakers");
  await page.locator("body[data-hydrated='true']").waitFor();
  const addSpeaker = page.locator("details").filter({
    has: page.getByText("Add speaker record", { exact: true }),
  });
  await addSpeaker.locator("summary").click();
  await page.getByRole("textbox", { name: "Name", exact: true }).fill(name);
  await page.getByRole("textbox", { name: "Email", exact: true }).fill(email);
  await addSpeaker.getByRole("button", { name: "Add speaker record" }).click();
  // A new address matches no existing identity, so the duplicate confirmation
  // usually does not appear; accept it when it does rather than assume.
  const duplicateConfirmation = addSpeaker.getByLabel(
    /I reviewed these identities/,
  );
  if (await duplicateConfirmation.isVisible().catch(() => false)) {
    await duplicateConfirmation.check();
    await addSpeaker
      .getByRole("button", { name: "Add speaker record" })
      .click();
  }
  const row = page.getByRole("row").filter({
    has: page.getByRole("link", { name, exact: true }),
  });
  await expect(row).toBeVisible();
  await row.getByRole("link", { name, exact: true }).click();
  await expect(
    page.getByRole("heading", { name, level: 1, exact: true }),
  ).toBeVisible();
}

test("organiser speaker detail shows the event-scoped record for a seeded speaker", async ({
  page,
}) => {
  await useDemoEvent(page);
  await page.goto("/admin/speakers");
  await page.getByRole("link", { name: "Priya Shah" }).click();
  await expect(page).toHaveURL(/\/admin\/speakers\/person-demo-speaker$/u);
  await expect(
    page.getByRole("heading", { name: "Priya Shah", level: 1 }),
  ).toBeVisible();

  await expect(
    page.getByRole("heading", { name: "Linked sessions" }),
  ).toBeVisible();
  await expect(
    page
      .locator('td[data-label="Session"]')
      .filter({ hasText: "Designing inclusive event technology" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Uploaded files and versions" }),
  ).toBeVisible();
  await expect(
    page.getByText("Upload speaker headshot", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Choose file")).toHaveAttribute(
    "accept",
    "image/jpeg,image/png,image/webp",
  );

  await page.getByRole("link", { name: "Preview participant view" }).click();
  await expect(page).toHaveURL(
    /\/admin\/speakers\/person-demo-speaker\/preview$/u,
  );
  await expect(
    page.getByRole("heading", { name: "Priya Shah", level: 1 }),
  ).toBeVisible();
  const preview = page.getByRole("region", {
    name: "Participant workspace preview",
  });
  await expect(preview).toContainText("My sessions");
  await expect(preview).toContainText("Designing inclusive event technology");
  await expect(preview.locator("form")).toHaveCount(0);
  await expect(preview.getByRole("button")).toHaveCount(0);
});

test("organiser speaker detail edits organisation and event fields without rewriting the canonical identity", async ({
  page,
}) => {
  await useDemoEvent(page);
  const suffix = Date.now();
  const name = `Rowan Ellis ${suffix}`;
  await addEventOwnedSpeaker(page, name, `rowan.ellis.${suffix}@example.com`);
  const detailPath = new URL(page.url()).pathname;

  const notice = page.locator(".pc-status-notice");
  await page
    .getByLabel("Organisation display name")
    .fill(`${name} · Program team`);
  await page.getByLabel("Job title").fill("Head of Experience Design");
  await page
    .getByLabel("Organisation", { exact: true })
    .fill("Program Cue Events");
  await page
    .getByLabel("Organisation biography")
    .fill("Organisation-owned speaker notes for this event.");
  await page
    .getByLabel("Travel and logistics preferences")
    .fill("Arrival May 11, aisle seat; dietary: Vegetarian");
  await page
    .getByRole("button", { name: "Save organisation and event details" })
    .click();
  await expect(notice).toContainText(
    "Organisation and event speaker details saved",
  );

  // The durable confirmation is server state, so it survives a reload while the
  // transient action notice does not.
  await page.reload();
  await expect(page.getByLabel("Organisation display name")).toHaveValue(
    `${name} · Program team`,
  );
  await expect(page.getByLabel("Job title")).toHaveValue(
    "Head of Experience Design",
  );
  await expect(page.getByLabel("Organisation", { exact: true })).toHaveValue(
    "Program Cue Events",
  );
  await expect(page.getByLabel("Organisation biography")).toHaveValue(
    "Organisation-owned speaker notes for this event.",
  );
  await expect(page.getByLabel("Travel and logistics preferences")).toHaveValue(
    "Arrival May 11, aisle seat; dietary: Vegetarian",
  );
  const profileHistory = page.getByRole("region", {
    name: "Public profile history",
  });
  await expect(profileHistory).toContainText(`${name} · Program team`);
  await expect(profileHistory).toContainText("Head of Experience Design");
  await expect(profileHistory).not.toContainText("Arrival May 11");
  await expect(notice).toHaveCount(0);

  // A second organiser holding the previous revision is refused rather than
  // silently overwriting the saved profile.
  const stalePage = await page.context().newPage();
  await stalePage.goto(detailPath);
  await page.getByLabel("Job title").fill("Experience Director");
  await page
    .getByRole("button", { name: "Save organisation and event details" })
    .click();
  await expect(notice).toContainText(
    "Organisation and event speaker details saved",
  );
  await stalePage.getByLabel("Job title").fill("Stale Organiser Title");
  await stalePage
    .getByRole("button", { name: "Save organisation and event details" })
    .click();
  await expect(stalePage.getByRole("alert")).toContainText(
    "changed after the page loaded",
  );
  await stalePage.close();
  await page.reload();
  await expect(page.getByLabel("Job title")).toHaveValue("Experience Director");
});

test("administrator speaker filters use the event-scoped server list", async ({
  page,
}) => {
  await page.goto("/admin/speakers");
  await expect(
    page.getByRole("heading", { name: "Speaker readiness" }),
  ).toBeVisible();
  await expect(page.getByText("Priya Shah", { exact: true })).toBeVisible();

  const readinessFilter = page.locator('select[name="readiness"]');
  await readinessFilter.selectOption("needs_attention");
  await page.getByRole("button", { name: "Apply filters" }).click();

  await expect(page).toHaveURL(/readiness=needs_attention/u);
  await expect(readinessFilter).toHaveValue("needs_attention");
  const priyaRow = page.getByRole("row").filter({ hasText: "Priya Shah" });
  await expect(priyaRow).toBeVisible();
  await expect(
    priyaRow.getByRole("cell", { name: "Needs attention", exact: true }),
  ).toBeVisible();
});
