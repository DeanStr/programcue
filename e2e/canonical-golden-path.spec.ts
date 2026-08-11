import { expect, test, type Page } from "@playwright/test";

import { e2eOrigin } from "./support/e2e-origin";
import { resetDemoEvent } from "./support/reset-demo-event";

const TEAM_NAME = "Golden path review team";
const SUBMISSION_TITLE = "Operational handoffs without guesswork";
const APPLICANT_EMAIL = "golden-path-applicant@example.com";
const SPEAKER_NAME = "Riley Golden";
const REVIEW_TARGETS = [
  {
    queueText: "DEMO-EVAL-001",
    title: "Operational calm under pressure",
  },
  {
    queueText: "DEMO-EVAL-002",
    title: "Designing inclusive attendee journeys",
  },
  { queueText: SUBMISSION_TITLE, title: SUBMISSION_TITLE },
] as const;

async function waitForInterface(page: Page, path: string) {
  const response = await page.goto(path);
  expect(response?.ok(), `${path} should load`).toBeTruthy();
  await page.locator("body[data-hydrated='true']").waitFor();
}

async function expectStatus(page: Page, text: string) {
  await expect(
    page.getByRole("status").filter({ hasText: text }).first(),
  ).toBeVisible();
}

async function switchDemoRole(
  page: Page,
  role: "administrator" | "evaluator" | "speaker",
) {
  const response = await page.request.post("/demo/role", {
    form: { role },
    headers: { origin: e2eOrigin },
  });
  expect(response.ok()).toBeTruthy();
}

async function completeSelectedReview(page: Page) {
  const form = page.locator("#review-score-form");
  const scoreInputs = form.locator('select[name^="score:"]');
  expect(await scoreInputs.count()).toBeGreaterThan(0);
  for (let index = 0; index < (await scoreInputs.count()); index += 1) {
    await scoreInputs.nth(index).selectOption("5");
  }
  await form.getByLabel("Recommendation").selectOption("accept");
  await form.getByLabel("Confidence").selectOption("5");
  await form
    .getByLabel("Applicant feedback")
    .fill("Clear, practical and ready for the programme.");
  await form
    .getByLabel("Private notes")
    .fill("Verified through the deterministic judged workflow.");
  await form.getByRole("button", { name: "Save draft" }).click();
  await expectStatus(page, "Review saved");
  await form
    .getByRole("button", { name: "Submit review", exact: true })
    .click();
  const confirmation = page.getByRole("dialog", {
    name: "Submit this review?",
  });
  await confirmation.getByRole("button", { name: "Submit review" }).click();
  await expect(
    form.getByText("This review is submitted and locked."),
  ).toBeVisible();
}

test.describe.serial("canonical D1-backed judged workflow", () => {
  test.beforeAll(async ({ request }) => {
    await resetDemoEvent(request);
  });

  test.afterAll(async ({ request }) => {
    await resetDemoEvent(request);
  });

  test("publishes category routing and submits into the active review round", async ({
    page,
  }) => {
    await switchDemoRole(page, "administrator");
    await waitForInterface(page, "/admin/review");
    await page.getByText("Create evaluation team", { exact: true }).click();
    const teamForm = page.locator("details").filter({
      has: page.getByText("Create evaluation team", { exact: true }),
    });
    await teamForm.getByLabel("Team name").fill(TEAM_NAME);
    await teamForm
      .getByLabel("Description")
      .fill("The deterministic review-routing acceptance team.");
    await teamForm.getByRole("button", { name: "Create team" }).click();
    await expectStatus(page, "Evaluation team saved");

    const team = page.locator("article").filter({
      has: page.getByRole("heading", { name: TEAM_NAME }),
    });
    await team.getByLabel(`Member for ${TEAM_NAME}`).selectOption({
      label: "Jordan Lee",
    });
    await team.getByRole("button", { name: "Add or update member" }).click();
    await expectStatus(page, "Team member saved");

    await waitForInterface(page, "/admin/submissions/form");
    const routing = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Field settings" }),
    });
    await routing.getByLabel("Event Operations").selectOption({
      label: TEAM_NAME,
    });
    await page.getByRole("button", { name: "Save draft" }).click();
    await expectStatus(page, "Draft form saved to D1");
    await page.getByRole("button", { name: "Publish version" }).click();
    await page
      .getByRole("dialog", { name: "Publish this application form version?" })
      .getByRole("button", { name: "Confirm publication" })
      .click();
    await expectStatus(page, "Published a new immutable form version");

    await waitForInterface(page, "/apply/form");
    await page.getByLabel("Email address").fill(APPLICANT_EMAIL);
    await page.getByRole("button", { name: "Send verification code" }).click();
    await page.getByLabel("Six-digit code").fill("424242");
    await page.getByRole("button", { name: "Verify and open drafts" }).click();
    await page.getByRole("button", { name: "Start application" }).click();
    await page
      .getByText("Your claimed speaker profile", { exact: true })
      .click();
    const profile = page.locator("details").filter({
      has: page.getByText("Your claimed speaker profile", { exact: true }),
    });
    await profile.getByLabel("Display name").fill(SPEAKER_NAME);
    await profile
      .getByLabel("Biography")
      .fill("Riley builds accountable programme operations and handoffs.");
    await profile.getByRole("button", { name: "Save my profile" }).click();
    await expectStatus(page, "Your speaker profile was updated");
    await page.getByLabel("Session title *").fill(SUBMISSION_TITLE);
    await page
      .getByLabel("Session description *")
      .fill(
        "A practical operating model for accountable handoffs across programme, speaker and venue teams.",
      );
    await page
      .getByLabel("Session category *")
      .selectOption("Event Operations");
    await page.getByLabel("Format *").selectOption("Presentation");
    await page.getByLabel("Speaker 1 name").fill(SPEAKER_NAME);
    await page.getByRole("button", { name: "Save draft" }).click();
    await expectStatus(page, "This draft is stored in D1");
    await page.getByText("I have reviewed this application").click();
    await page.getByRole("button", { name: "Submit application" }).click();
    await expectStatus(page, "This application is submitted and stored in D1");

    await switchDemoRole(page, "administrator");
    await waitForInterface(page, "/admin/review");
    const row = page.getByRole("row", { name: new RegExp(SUBMISSION_TITLE) });
    await expect(row).toContainText(`Routed to ${TEAM_NAME}`);
    await expect(row).toContainText("assigned");
    await expect(row).toContainText("0 / 1");
  });

  test("completes two immutable rounds and releases acceptance into onboarding", async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await switchDemoRole(page, "evaluator");
    await waitForInterface(page, "/review/workbench");
    const queue = page.getByRole("navigation", {
      name: "Assigned review sources",
    });
    for (const target of REVIEW_TARGETS) {
      const assignment = queue
        .getByRole("link")
        .filter({ hasText: target.queueText });
      await assignment.click();
      await expect(assignment).toHaveAttribute("aria-current", "page");
      await expect(
        page.locator("#review-submission-title", { hasText: target.title }),
      ).toBeVisible();
      await completeSelectedReview(page);
    }

    await switchDemoRole(page, "administrator");
    await waitForInterface(page, "/admin/review");
    await page.getByLabel("Next round name").fill("Final programme review");
    await page.getByRole("button", { name: "Add next round" }).click();
    await expectStatus(page, "Next round created from the rubric");
    await page.getByRole("button", { name: "Review advancement" }).click();
    const advancement = page.getByRole("dialog", {
      name: "Advance to Final programme review",
    });
    await advancement.getByLabel(new RegExp(SUBMISSION_TITLE)).check();
    await advancement
      .getByLabel("Next-round reviewers")
      .selectOption({ label: `${TEAM_NAME} (1)` });
    await advancement
      .getByRole("button", { name: "Close round and advance shortlist" })
      .click();
    await expectStatus(page, "1 submission advanced with 1 new assignment");

    await switchDemoRole(page, "evaluator");
    await waitForInterface(page, "/review/workbench");
    const nextRoundAssignment = page
      .getByRole("navigation", { name: "Assigned review sources" })
      .getByRole("link")
      .filter({ hasText: SUBMISSION_TITLE })
      .filter({ hasText: /assigned\s*$/ });
    await expect(nextRoundAssignment).toHaveCount(1);
    await nextRoundAssignment.click();
    await expect(
      page.locator("#review-submission-title", { hasText: SUBMISSION_TITLE }),
    ).toBeVisible();
    await completeSelectedReview(page);

    await switchDemoRole(page, "administrator");
    await waitForInterface(page, "/admin/review");
    const decisionRow = page.getByRole("row", {
      name: new RegExp(SUBMISSION_TITLE),
    });
    await decisionRow.getByRole("button", { name: "Decide" }).click();
    const decision = page.getByRole("dialog", {
      name: `Decision · ${SUBMISSION_TITLE}`,
    });
    await decision.locator('select[name="decision"]').selectOption("accepted");
    await decision
      .getByLabel("Rationale")
      .fill("Two completed rounds support programme acceptance.");
    await decision
      .getByLabel("Acceptance session duration (minutes)")
      .fill("60");
    await decision.getByRole("button", { name: "Release decision" }).click();
    await expectStatus(
      page,
      "Decision released and notification queued. 1 demo speaker invitation was saved; explicit demo mode sent no email.",
    );

    await waitForInterface(page, "/admin/speakers?query=Riley%20Golden");
    const speakerRow = page.getByRole("row", {
      name: new RegExp(`${SPEAKER_NAME}.*${APPLICANT_EMAIL}`, "i"),
    });
    await expect(speakerRow.locator('td[data-label="Sessions"]')).toHaveText(
      "1",
    );
    await expect(speakerRow.locator('td[data-label="Tasks"]')).toContainText(
      "3 outstanding",
    );

    await waitForInterface(page, "/admin/tasks");
    for (const taskTitle of [
      "Complete your speaker profile",
      "Upload presentation slides",
      "Read the speaker handbook",
    ]) {
      const taskRow = page.getByRole("row", {
        name: new RegExp(`${taskTitle}.*${SPEAKER_NAME}`, "i"),
      });
      await expect(taskRow).toBeVisible();
    }
  });

  test("places, resizes, undoes and publishes the accepted session", async ({
    page,
  }) => {
    await switchDemoRole(page, "administrator");
    await waitForInterface(page, "/admin/schedule");
    await page.getByRole("button", { name: "Create next draft" }).click();
    await expect(page.getByText(/Version 2 · draft/)).toBeVisible();
    await page.getByText("Place or move with form", { exact: true }).click();
    const placement = page.locator("details").filter({
      has: page.getByText("Place or move with form", { exact: true }),
    });
    await placement.getByLabel("Session").selectOption({
      label: SUBMISSION_TITLE,
    });
    await placement.getByLabel("Room").selectOption({ label: "Room 303" });
    const start = placement.getByLabel(/Start · America\/Toronto/);
    const freeSlot = (await start.locator("option").allTextContents()).find(
      (label) => /Tue, May 20.*8:00 AM/.test(label),
    );
    expect(freeSlot).toBeTruthy();
    await start.selectOption({ label: freeSlot! });
    await placement.getByLabel("Duration (minutes)").fill("60");
    await placement.getByRole("button", { name: "Place session" }).click();
    await expectStatus(page, "Session placed");

    await placement.getByLabel("Duration (minutes)").fill("45");
    await placement
      .getByRole("button", { name: "Move or resize session" })
      .click();
    await expectStatus(page, "Session placed");
    await page.getByRole("button", { name: "Undo" }).click();
    await expectStatus(page, "Schedule change undone");
    await expect(placement.getByLabel("Duration (minutes)")).toHaveValue("60");

    await placement.getByLabel("Duration (minutes)").fill("45");
    await placement
      .getByRole("button", { name: "Move or resize session" })
      .click();
    await expectStatus(page, "Session placed");
    await page.getByRole("button", { name: "Publish schedule" }).click();
    const publication = page.getByRole("dialog", { name: "Publish schedule" });
    await expect(publication).toContainText("revalidated before publication");
    await publication
      .getByRole("button", { name: "Confirm publication" })
      .click();
    await expectStatus(page, "Schedule published");

    await waitForInterface(page, "/public/programme/future-of-events-2025");
    await expect(
      page.locator(".programme-row").filter({ hasText: SUBMISSION_TITLE }),
    ).toBeVisible();
    const programme = await page.request.get(
      "/api/v1/public/events/future-of-events-2025/programme",
    );
    expect(programme.ok()).toBeTruthy();
    const body = (await programme.json()) as {
      sessions: Array<{
        title: string;
        room: string;
        startsAt: string;
        endsAt: string;
      }>;
    };
    const publishedSession = body.sessions.find(
      (session) => session.title === SUBMISSION_TITLE,
    );
    expect(publishedSession).toMatchObject({
      room: "Room 303",
      startsAt: "2025-05-20T12:00:00.000Z",
    });
    expect(
      Date.parse(publishedSession!.endsAt) -
        Date.parse(publishedSession!.startsAt),
    ).toBe(45 * 60 * 1_000);
  });
});
