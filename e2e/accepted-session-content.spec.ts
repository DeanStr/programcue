import { expect, test } from "@playwright/test";
import { acceptConfirm } from "./support/confirm-dialog";
import { openEvaluationView } from "./support/evaluation-admin";
import { openRecordPanel } from "./support/open-record-panel";
import { resetDemoEvent } from "./support/reset-demo-event";

test.afterEach(async ({ request }) => {
  await resetDemoEvent(request);
});

// Acceptance after publication must not require a prior visit to the planner.
test("an accepted session opens before its first draft and enters content review after explicit draft creation", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  await resetDemoEvent(request);
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
  await page.goto("/admin/review");
  await openEvaluationView(page, "Assignments");
  const title = "Designing inclusive attendee journeys";
  const proposal = page
    .getByRole("region", { name: "Evaluation proposal queue" })
    .getByRole("row", { name: new RegExp(title) });
  await proposal.getByRole("button", { name: "Decide" }).click();
  const decision = page.getByRole("dialog", { name: `Decision · ${title}` });
  await decision.locator('select[name="decision"]').selectOption("accepted");
  await decision
    .getByLabel("Acceptance programme track")
    .selectOption({ label: "Experience Design" });
  await decision
    .getByLabel("Rationale")
    .fill("Accept this proposal for the event programme.");
  await decision.getByLabel("Acceptance session duration (minutes)").fill("45");
  await decision
    .getByRole("checkbox", { name: /Release without a completed review/ })
    .check();
  await decision.getByRole("button", { name: "Release decision" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: /notification queued/i }),
  ).toBeVisible();

  const index = await page.goto("/admin/content");
  expect(index?.status()).toBe(200);
  const session = page
    .getByRole("listitem")
    .filter({ has: page.getByRole("link", { name: title, exact: true }) });
  await expect(session).toContainText("Not in a draft");
  await session.getByRole("link", { name: title, exact: true }).click();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Start a content draft" }),
  ).toBeVisible();
  const detailUrl = page.url();
  await expect(
    page.getByText(/Experience Design · Presentation · 45 minutes/),
  ).toBeVisible();

  // The accepted session's speakers can change before publication: add an
  // existing person found by lookup, then remove them again.
  const speakersPanel = page.getByRole("region", { name: "Speakers" });
  const speakerRows = speakersPanel.getByRole("listitem");
  await expect(speakerRows).toHaveCount(1);
  await expect(speakerRows.first()).toContainText("Priya Shah");
  await expect(speakerRows.first()).toContainText("Confirmed");
  await expect(
    speakersPanel.getByRole("button", { name: "Remove" }),
  ).toHaveCount(0);
  await speakersPanel.getByLabel(/Find an existing speaker/).fill("Alex");
  await speakersPanel.getByRole("button", { name: /Alex Morgan/ }).click();
  await expect(speakersPanel.getByLabel("Speaker email")).toHaveValue(
    "alex.submitter@example.com",
  );
  await speakersPanel.getByRole("button", { name: "Add speaker" }).click();
  await expect(speakersPanel.getByRole("status")).toContainText(
    "Alex Morgan was added as a speaker.",
  );
  await expect(speakerRows).toHaveCount(2);
  await expect(speakerRows.nth(1)).toContainText("Awaiting confirmation");
  await expect(speakersPanel.getByLabel("Speaker email")).toHaveValue("");
  expect((await page.reload())?.status()).toBe(200);
  await expect(speakerRows).toHaveCount(2);
  await speakerRows
    .filter({ hasText: "Alex Morgan" })
    .getByRole("button", { name: "Remove" })
    .click();
  await acceptConfirm(page);
  await expect(speakersPanel.getByRole("status")).toContainText(
    "Alex Morgan was removed from this session.",
  );
  await expect(speakerRows).toHaveCount(1);
  expect((await page.reload())?.status()).toBe(200);
  await page.getByRole("link", { name: "Open schedule", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/schedule\?session=/);
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "Edit next version", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Edit next version?" })
    .getByRole("button", { name: "Confirm new draft" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Edit next version?" }),
  ).not.toBeVisible();
  expect((await page.goto(detailUrl))?.status()).toBe(200);
  await expect(
    page.getByRole("heading", { name: "Content approval" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Change status" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Start a content draft" }),
  ).toHaveCount(0);
  await page.goto("/admin/content");
  await expect(
    page.getByRole("link", { name: title, exact: true }),
  ).toHaveCount(1);
  expect(
    (await page.goto("/admin/content/sessions/missing-session"))?.status(),
  ).toBe(404);
});

test("a fresh evaluation event starts without showcase review assignments", async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(60_000);
  await resetDemoEvent(request);
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
  await context.addCookies([
    {
      name: "program_cue_demo_identity",
      value: "owner",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const suffix = Date.now();
  const name = `DevFlow review setup ${suffix}`;
  expect((await page.goto("/admin/events/new"))?.status()).toBe(200);
  await page.getByLabel("Event name").fill(name);
  await page.locator("#event-new-timezone").fill("Asia/Kathmandu");
  await page.getByLabel("Public slug").fill(`devflow-review-setup-${suffix}`);
  await page.getByRole("button", { name: "Create blank event" }).click();
  await acceptConfirm(page);
  await page.getByRole("button", { name: "Open new event" }).click();
  await expect(page.locator(".event-switcher strong")).toHaveText(name);
  expect((await page.goto("/admin/review"))?.status()).toBe(200);
  await expect(
    page.getByRole("region", {
      name: "Create the evaluation plan",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "Programme committee review",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.getByLabel("First round name").fill("CFP Review");
  await page.getByRole("button", { name: "Create review plan" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Evaluation plan created." }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "No matching review targets",
      exact: true,
    }),
  ).toBeVisible();
  await page.goto("/admin/event");
  await openRecordPanel(page, "Programme tracks");
  await page.getByLabel("New track").fill("Developer experience");
  await page.getByRole("button", { name: "Add track", exact: true }).click();
  await page.getByRole("button", { name: "Save event", exact: true }).click();
  await expect(
    page.getByText("Event settings saved.", { exact: true }),
  ).toBeVisible();
  expect((await page.goto("/admin/submissions/form"))?.status()).toBe(200);
  await expect(
    page.getByRole("button", { name: "Save draft", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByText("Form properties", { exact: true }).click();
  await expect(
    page.getByText("Applications close at 11:59 PM in Asia/Kathmandu.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(page).toHaveURL(/form=/);
  await page.reload();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByText("Form properties", { exact: true }).click();
  await expect(
    page.getByText("Applications close at 11:59 PM in Asia/Kathmandu.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.goto("/admin/submissions/form?new=1");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByText("Form properties", { exact: true }).click();
  await expect(
    page.getByText("Applications close at 11:59 PM in Asia/Kathmandu.", {
      exact: true,
    }),
  ).toBeVisible();
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
  await page.goto("/admin/review");
  await expect(
    page.getByText("Programme committee review", { exact: true }).first(),
  ).toBeVisible();
});
