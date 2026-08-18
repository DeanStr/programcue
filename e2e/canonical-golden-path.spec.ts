import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";

import { e2eOrigin } from "./support/e2e-origin";
import { openEvaluationView } from "./support/evaluation-admin";
import { resetDemoEvent } from "./support/reset-demo-event";

const TEAM_NAME = "Golden path review team";
const SUBMISSION_TITLE = "Operational handoffs without guesswork";
const APPLICANT_EMAIL = "sbek-speaker@example.com";
const SPEAKER_NAME = "Riley Golden";
const REVIEW_TARGETS = [
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

async function createNextScheduleDraft(page: Page) {
  await page.getByRole("button", { name: "Create next draft" }).click();
  const confirmation = page.getByRole("dialog", {
    name: "Create the next schedule draft?",
  });
  await expect(confirmation).toContainText(
    "The published programme will not change",
  );
  await confirmation.getByRole("button", { name: "Confirm new draft" }).click();
}

async function selectScheduleSessionByTitle(placement: Locator, title: string) {
  const sessionSelect = placement.getByLabel("Session");
  const matchingOption = sessionSelect
    .locator("option")
    .filter({ hasText: title });
  await expect(matchingOption).toHaveCount(1);
  const sessionId = await matchingOption.getAttribute("value");
  expect(sessionId).toBeTruthy();
  await sessionSelect.selectOption(sessionId!);
}

function waitForScheduleMutation(page: Page) {
  return page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/admin/schedule.data",
  );
}

async function switchDemoRole(
  page: Page,
  role: "administrator" | "evaluator" | "speaker",
) {
  const response = await page.request.post("/demo/role", {
    form: { identity: role },
    headers: { origin: e2eOrigin },
  });
  expect(response.ok()).toBeTruthy();
}

async function completeSelectedReview(page: Page) {
  const form = page.locator("#review-score-form");
  const submit = form.getByRole("button", {
    name: "Submit review",
    exact: true,
  });
  // The conflict question gates scoring and submission, so it is answered
  // before anything else — the same order a reviewer meets it in.
  await expect(submit).toBeDisabled();
  await form.getByRole("radio", { name: /No conflict/ }).check();
  const scoreGroups = form.locator("[data-review-scale]");
  const scoreGroupCount = await scoreGroups.count();
  expect(scoreGroupCount).toBeGreaterThan(0);
  for (let index = 0; index < scoreGroupCount; index += 1) {
    await scoreGroups
      .nth(index)
      .getByRole("radio", { name: "5", exact: true })
      .check();
  }
  await form
    .getByRole("radiogroup", { name: "Recommendation" })
    .getByRole("radio", { name: "Accept" })
    .check();
  await form
    .getByRole("radiogroup", { name: "Confidence" })
    .getByRole("radio", { name: "5", exact: true })
    .check();
  await form
    .getByLabel("Applicant feedback")
    .fill("Clear, practical and ready for the programme.");
  await form
    .getByLabel("Private notes")
    .fill("Verified through the deterministic judged workflow.");
  await form.getByRole("button", { name: "Save draft" }).click();
  await expectStatus(page, "Review saved");
  await submit.click();
  const confirmation = page.getByRole("dialog", {
    name: "Submit this review?",
  });
  await confirmation.getByRole("button", { name: "Submit review" }).click();
  await expect(
    form.getByText("This review is submitted and locked."),
  ).toBeVisible();
  const contrast = await new AxeBuilder({ page })
    .withRules(["color-contrast"])
    .analyze();
  expect(
    contrast.violations,
    `submitted review contrast violations: ${contrast.violations
      .flatMap((violation) => violation.nodes.map((node) => node.target))
      .join(", ")}`,
  ).toEqual([]);
}

test.describe
  .serial("canonical D1-backed judged workflow", () => {
    test.beforeAll(async ({ request }) => {
      await resetDemoEvent(request);
    });

    test.afterAll(async ({ request }) => {
      await resetDemoEvent(request);
    });

    test("publishes category routing and submits into the active review round", async ({
      page,
    }) => {
      test.setTimeout(45_000);
      await switchDemoRole(page, "administrator");
      await waitForInterface(page, "/admin/review");
      await openEvaluationView(page, "Setup");
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
      const formStructure = page.locator("section").filter({
        has: page.getByRole("heading", { name: "Form structure" }),
      });
      await formStructure
        .getByRole("button", { name: /^\d+\s+Tracks/ })
        .click();
      const currentTracks = routing.getByRole("group", {
        name: "Current Event settings tracks",
      });
      await expect(
        currentTracks.getByRole("listitem").filter({
          hasText: "Event Operations",
        }),
      ).toBeVisible();
      await expect(
        currentTracks.getByRole("listitem").filter({ hasText: "Leadership" }),
      ).toBeVisible();
      await expect(
        currentTracks.getByRole("link", { name: "Event settings" }),
      ).toHaveAttribute("href", "/admin/event");
      await routing
        .getByRole("combobox", { name: "Event Operations" })
        .selectOption({
          label: TEAM_NAME,
        });
      await page.getByRole("button", { name: "Save draft" }).click();
      await expectStatus(page, "Draft form saved.");
      await page.getByRole("button", { name: "Publish version" }).click();
      await page
        .getByRole("dialog", { name: "Publish this application form version?" })
        .getByRole("button", { name: "Confirm publication" })
        .click();
      await expectStatus(page, "Published a new immutable form version");

      await waitForInterface(page, "/admin/tasks");
      await page.getByLabel(/I confirm these forms should be created/i).check();
      await page.getByRole("button", { name: "Create travel forms" }).click();
      await expectStatus(
        page,
        "Hotel stay and flight reimbursement forms are ready",
      );
      await page.getByLabel(/I confirm these forms should be created/i).check();
      await page.getByRole("button", { name: "Create travel forms" }).click();
      await expectStatus(
        page,
        "were already ready. No duplicates were created",
      );

      await waitForInterface(page, "/apply/form");
      await page.getByLabel("Email address").fill(APPLICANT_EMAIL);
      await page
        .getByRole("button", { name: "Send verification code" })
        .click();
      await page.getByLabel("Six-digit code").fill("424242");
      await page
        .getByRole("button", { name: "Verify and open drafts" })
        .click();
      await page.getByRole("button", { name: "Start application" }).click();
      await page.getByText("I have reviewed this application").click();
      await page.getByRole("button", { name: "Submit application" }).click();
      await expect(
        page.getByRole("alert").filter({
          hasText: "Complete the highlighted required field before submitting.",
        }),
      ).toBeVisible();
      await expect(page.getByLabel("Session title")).toBeFocused();
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
      await page.getByLabel("Session title").fill(SUBMISSION_TITLE);
      await page
        .getByLabel("Session description")
        .fill(
          "A practical operating model for accountable handoffs across programme, speaker and venue teams.",
        );
      await page.getByLabel("Event Operations").check();
      await page.getByLabel("Leadership").check();
      await page.getByLabel("Format").selectOption("Presentation");
      await page.getByLabel("Speaker 1 name").fill(SPEAKER_NAME);
      await page.getByRole("button", { name: "Save draft" }).click();
      await expectStatus(page, "Your draft has been saved");
      await page.getByText("I have reviewed this application").click();
      await page.getByRole("button", { name: "Submit application" }).click();
      await expectStatus(page, "Your application has been submitted");

      await switchDemoRole(page, "administrator");
      await waitForInterface(page, "/admin/review");
      await openEvaluationView(page, "Assignments");
      const row = page
        .getByRole("region", { name: "Evaluation proposal queue" })
        .getByRole("row", { name: new RegExp(SUBMISSION_TITLE) });
      await expect(row).toContainText(`Routed to ${TEAM_NAME}`);
      await expect(row).toContainText("submitted");
      await expect(row).toContainText("0 / 0");
      await row
        .getByLabel(`Evaluator or team for ${SUBMISSION_TITLE}`)
        .selectOption({ label: `${TEAM_NAME} (1)` });
      await row.getByRole("button", { name: "Assign" }).click();
      await expectStatus(page, "1 evaluator assignment created.");
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
      await openEvaluationView(page, "Setup");
      await page.getByLabel("Next round name").fill("Final programme review");
      await page.getByRole("button", { name: "Add next round" }).click();
      await expectStatus(page, "Next round created from the rubric");
      const finalRound = page.locator("section.card").filter({
        has: page.getByRole("heading", {
          name: "Final programme review",
          exact: true,
        }),
      });
      await finalRound
        .getByLabel("Reviewer for Final programme review")
        .selectOption("person-demo-evaluator");
      await finalRound.getByRole("button", { name: "Add reviewer" }).click();
      await expectStatus(page, "Reviewer added to this round pool");
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
        // The queue card ends with its reference rather than its state now. A
        // leading \b cannot be used: textContent runs the track chip straight
        // into the state ("...Leadershipassigned"), so there is no word boundary
        // to anchor to. The round-1 card reads "submitted", so this stays exact
        // enough to pick the new assignment.
        .filter({ hasText: /assigned/i });
      await expect(nextRoundAssignment).toHaveCount(1);
      await nextRoundAssignment.click();
      await expect(
        page.locator("#review-submission-title", { hasText: SUBMISSION_TITLE }),
      ).toBeVisible();
      await completeSelectedReview(page);

      await switchDemoRole(page, "administrator");
      await waitForInterface(page, "/admin/review");
      await openEvaluationView(page, "Assignments");
      const decisionRow = page
        .getByRole("region", { name: "Evaluation proposal queue" })
        .getByRole("row", { name: new RegExp(SUBMISSION_TITLE) });
      await decisionRow.getByRole("button", { name: "Decide" }).click();
      const decision = page.getByRole("dialog", {
        name: `Decision · ${SUBMISSION_TITLE}`,
      });
      await decision
        .locator('select[name="decision"]')
        .selectOption("accepted");
      await expect(
        decision.getByLabel("Acceptance programme track"),
      ).toHaveValue("");
      await decision
        .getByLabel("Acceptance programme track")
        .selectOption({ label: "Event Operations" });
      await decision
        .getByLabel("Rationale")
        .fill("Two completed rounds support programme acceptance.");
      await decision
        .getByLabel("Include submitted reviewer feedback in the decision email")
        .check();
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
        "5 outstanding",
      );

      await waitForInterface(page, "/admin/tasks");
      for (const taskTitle of [
        "Complete your speaker profile",
        "Upload presentation slides",
        "Read the speaker handbook",
        "Hotel stay requirements",
        "Flight reimbursement",
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
      await createNextScheduleDraft(page);
      await expect(page.getByText(/Version 2 · Draft/)).toBeVisible();
      const placement = page.locator("details").filter({
        has: page.getByText("Place or move with form", { exact: true }),
      });
      await expect(placement).toHaveAttribute("open", "");
      await selectScheduleSessionByTitle(placement, "AI in Event Operations");
      await placement.getByLabel("Room").selectOption({ label: "Room 301A" });
      const start = placement.getByLabel(/Start · America\/Toronto/);
      const speakerConflictSlot = (
        await start.locator("option").allTextContents()
      ).find((label) => /Fri, May 21.*9:30 AM/.test(label));
      expect(speakerConflictSlot).toBeTruthy();
      await start.selectOption({ label: speakerConflictSlot! });
      await placement.getByLabel("Duration (minutes)").fill("60");
      await placement
        .getByRole("button", { name: "Move or resize session" })
        .click();
      await expectStatus(page, "Session placed with 1 warning");
      const warningNotice = page
        .locator('.validation-item.warn[role="status"]')
        .filter({ hasText: "Session placed with 1 warning" });
      await expect(warningNotice).toContainText(
        "speaker: Alex Morgan appears in both “AI in Event Operations” and “Community and Connection”",
      );
      await page.getByRole("button", { name: "List", pressed: false }).click();
      await expect(
        page.getByRole("region", { name: "list schedule calendar" }),
      ).toBeVisible();
      const recordedConflict = page
        .locator(".schedule-conflict-item")
        .filter({ hasText: "Community and Connection" });
      await recordedConflict
        .getByRole("button", { name: "Show on board" })
        .click();
      await expect(
        page.getByRole("button", { name: "Room", pressed: true }),
      ).toBeVisible();
      const revealedConflictEntry = page
        .locator(".schedule-room-board [data-entry-id].revealed")
        .first();
      await expect(revealedConflictEntry).toBeVisible();
      await expect(revealedConflictEntry).toBeFocused();
      await page.getByRole("button", { name: "Undo" }).click();
      await expectStatus(page, "Schedule change undone");

      await selectScheduleSessionByTitle(placement, SUBMISSION_TITLE);
      await placement.getByLabel("Room").selectOption({ label: "Main Stage" });
      const occupiedSlot = (
        await start.locator("option").allTextContents()
      ).find((label) => /Thu, May 20.*9:00 AM/.test(label));
      expect(occupiedSlot).toBeTruthy();
      await start.selectOption({ label: occupiedSlot! });
      await placement.getByLabel("Duration (minutes)").fill("60");
      await placement.getByRole("button", { name: "Place session" }).click();
      const blockedNotice = page
        .getByRole("alert")
        .filter({ hasText: "blocking schedule conflict" });
      await expect(blockedNotice).toContainText(
        "room: Room overlaps “The Future of Attendee Engagement”",
      );

      await placement.getByLabel("Room").selectOption({ label: "Room 303" });
      const freeSlot = (await start.locator("option").allTextContents()).find(
        (label) => /Thu, May 20.*8:00 AM/.test(label),
      );
      expect(freeSlot).toBeTruthy();
      await start.selectOption({ label: freeSlot! });
      await placement.getByLabel("Duration (minutes)").fill("60");
      await placement.getByRole("button", { name: "Place session" }).click();
      await expectStatus(page, "Session placed");

      await placement.getByLabel("Duration (minutes)").fill("45");
      const resizeRequest = waitForScheduleMutation(page);
      await placement
        .getByRole("button", { name: "Move or resize session" })
        .click();
      expect((await resizeRequest).ok()).toBeTruthy();
      await expectStatus(page, "Session placed");
      const undoRequest = waitForScheduleMutation(page);
      await page.getByRole("button", { name: "Undo" }).click();
      expect((await undoRequest).ok()).toBeTruthy();
      await expectStatus(page, "Schedule change undone");
      await expect(placement.getByLabel("Duration (minutes)")).toHaveValue(
        "60",
      );
      await expect(
        placement.getByRole("button", { name: "Move or resize session" }),
      ).toBeEnabled();

      await placement.getByLabel("Duration (minutes)").fill("45");
      await expect(placement.locator('input[name="endsAt"]')).toHaveValue(
        String(Number(await start.inputValue()) + 45 * 60),
      );
      const finalResizeRequest = waitForScheduleMutation(page);
      await placement
        .getByRole("button", { name: "Move or resize session" })
        .click();
      expect((await finalResizeRequest).ok()).toBeTruthy();
      await expectStatus(page, "Session placed");

      await waitForInterface(page, "/admin/content");
      const contentRow = page.locator("article.list-row", {
        hasText: SUBMISSION_TITLE,
      });
      await expect(contentRow.getByLabel("Draft status")).toBeVisible();

      await waitForInterface(page, "/admin/schedule");
      await page.getByRole("button", { name: "Publish schedule" }).click();
      let publication = page.getByRole("dialog", { name: "Publish schedule" });
      await expect(publication).toContainText("not marked Approved");
      await expect(publication).toContainText("Publication is blocked");
      await expect(
        publication.getByRole("button", { name: "Confirm publication" }),
      ).toBeDisabled();
      await publication.getByRole("link", { name: SUBMISSION_TITLE }).click();
      await page.getByLabel("Next status").selectOption("approved");
      await page
        .getByLabel("Apply this exact status to the current content revision")
        .check();
      await page.getByRole("button", { name: "Change status" }).click();
      await expectStatus(page, "Content status changed to approved");

      await waitForInterface(page, "/admin/schedule");
      await page.getByRole("button", { name: "Publish schedule" }).click();
      publication = page.getByRole("dialog", { name: "Publish schedule" });
      await expect(publication).toContainText(
        "Every scheduled public session has a public content snapshot",
      );
      await expect(publication).not.toContainText("not marked Approved");
      await expect(
        publication.getByRole("button", { name: "Confirm publication" }),
      ).toBeEnabled();
      await expect(publication).toContainText(
        "currently published programme remains unchanged",
      );
      await expect(publication).toContainText(
        "/public/programme/future-of-events-2027",
      );
      await expect(publication).toContainText("revalidated before publication");
      await publication
        .getByRole("button", { name: "Confirm publication" })
        .click();
      await expectStatus(page, "Schedule published");
      await expect(
        page.getByRole("link", { name: "Open public programme" }),
      ).toHaveAttribute("href", "/public/programme/future-of-events-2027");

      await waitForInterface(page, "/public/programme/future-of-events-2027");
      await expect(
        page.locator(".programme-row").filter({ hasText: SUBMISSION_TITLE }),
      ).toBeVisible();
      const programme = await page.request.get(
        "/api/v1/public/events/future-of-events-2027/programme",
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
        startsAt: "2027-05-20T12:00:00.000Z",
      });
      expect(
        Date.parse(publishedSession!.endsAt) -
          Date.parse(publishedSession!.startsAt),
      ).toBe(45 * 60 * 1_000);
    });
  });
