import { expect, test } from "@playwright/test";
import { e2eOrigin } from "./support/e2e-origin";
import { openEvaluationView } from "./support/evaluation-admin";
import { resetDemoEvent } from "./support/reset-demo-event";

test.beforeEach(async ({ request }) => {
  expect((await request.get("/admin/command")).ok()).toBeTruthy();
});

test("seeded evaluation submission details load with immutable form context", async ({
  page,
}) => {
  await page.context().addCookies([
    {
      name: "program_cue_event",
      value: "evt-foe-2025",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
    {
      name: "program_cue_demo_identity",
      value: "administrator",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);

  for (const submission of [
    {
      id: "demo-evaluation-submission-calm",
      title: "Operational calm under pressure",
    },
    {
      id: "demo-evaluation-submission-inclusive",
      title: "Designing inclusive attendee journeys",
    },
  ]) {
    const response = await page.goto(`/admin/submissions/${submission.id}`);
    expect(response?.ok()).toBeTruthy();
    await expect(
      page.getByRole("heading", { name: submission.title }),
    ).toBeVisible();
    await expect(
      page.getByText("Evaluation demo proposals · Form version 1"),
    ).toBeVisible();
  }
});

test("a reviewer denied an administrator page receives a usable recovery path", async ({
  page,
}) => {
  await page.context().addCookies([
    {
      name: "program_cue_event",
      value: "evt-foe-2025",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
    {
      name: "program_cue_demo_identity",
      value: "evaluator",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);

  const response = await page.goto("/admin/review");
  expect(response?.status()).toBe(403);
  const recovery = page.getByRole("link", { name: "Choose an event" });
  await expect(recovery).toHaveAttribute("href", "/events/select");
  await recovery.click();
  await expect(page).toHaveURL(/\/events\/select$/u);
  await expect(
    page.getByRole("heading", { name: "Choose an event" }),
  ).toBeVisible();
});

test("review submission confirmation preserves context", async ({ page }) => {
  test.setTimeout(60_000);
  await page.context().addCookies([
    {
      name: "program_cue_event",
      value: "evt-foe-2025",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
    {
      name: "program_cue_demo_identity",
      value: "evaluator",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const response = await page.goto("/review/workbench");
  expect(response?.ok()).toBeTruthy();
  await page.locator("body[data-hydrated='true']").waitFor();

  await expect(
    page.getByRole("heading", { name: "Review Workbench" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Committee discussion" }),
  ).toBeVisible();
  await expect(page.getByText("Independent review first")).toBeVisible();
  const queueItems = page
    .getByRole("navigation", {
      name: "Assigned review sources",
    })
    .getByRole("link");
  await expect(queueItems).toHaveCount(2);
  await expect(
    page.getByRole("button", { name: "Previous", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Next", exact: true }),
  ).toBeEnabled();

  // The conflict question gates submission before the rubric is even reached:
  // a reviewer who has not answered it cannot submit at all.
  const submitNext = page.getByRole("button", { name: "Submit and open next" });
  await expect(submitNext).toBeDisabled();
  await expect(
    page.getByText(
      "Answer the conflict of interest question before submitting",
    ),
  ).toBeVisible();
  await page.getByRole("radio", { name: /No conflict/ }).check();
  await expect(submitNext).toBeDisabled();
  await expect(
    page.getByText(
      "Complete the required criteria, recommendation and confidence before submitting",
    ),
  ).toBeVisible();

  const scoreGroups = page.locator("[data-review-scale]");
  const scoreGroupCount = await scoreGroups.count();

  const chosen = (index: number) =>
    scoreGroups.nth(index).getByRole("radio", { name: "4", exact: true });
  for (let index = 0; index < scoreGroupCount; index += 1) {
    await chosen(index).check();
    await expect(chosen(index)).toBeChecked();
  }
  await page
    .getByRole("radiogroup", { name: "Recommendation" })
    .getByRole("radio", { name: "Accept" })
    .check();
  await page
    .getByRole("radiogroup", { name: "Confidence" })
    .getByRole("radio", { name: "4", exact: true })
    .check();
  for (let index = 0; index < scoreGroupCount; index += 1) {
    await expect(chosen(index)).toBeChecked();
  }
  await expect(
    page
      .getByRole("region", { name: "Score submission" })
      .locator(".review-score-progress"),
  ).toContainText("4/4");
  await page.getByRole("button", { name: "Submit and open next" }).click();
  const confirmation = page.getByRole("dialog", {
    name: "Submit and open the next review?",
  });
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toContainText(
    "Only an authorised evaluation manager can explicitly reopen the review",
  );
  await confirmation.getByRole("button", { name: "Continue editing" }).click();
  await expect(confirmation).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Submit and open next" }),
  ).toBeFocused();

  // Declaring a conflict disables scoring and blocks submission rather than
  // sitting beside a completed rubric as an afterthought.
  await page.getByRole("radio", { name: /I have a conflict/ }).check();
  await expect(page.locator(".review-rubric")).not.toHaveAttribute("inert");
  await expect(scoreGroups.first()).toBeVisible();
  const disabledScore = scoreGroups.first().getByRole("radio").first();
  expect(
    await disabledScore.evaluate((input: HTMLInputElement) => input.disabled),
  ).toBe(true);
  await expect(disabledScore).toHaveCSS("cursor", "not-allowed");
  await expect(
    page.getByRole("button", { name: "Submit and open next" }),
  ).toBeDisabled();
  await expect(
    page.getByText("A conflicted review cannot be submitted"),
  ).toBeVisible();

  const declare = page.getByRole("button", {
    name: "Declare conflict and return",
  });
  await declare.click();
  const conflict = page.getByRole("dialog", { name: "Declare a conflict" });
  await expect(conflict).toContainText(
    "recused and returned to the committee for reassignment",
  );
  await conflict.getByRole("button", { name: "Close" }).click();
  await expect(conflict).toBeHidden();
  await expect(declare).toBeFocused();
  await expect(page.locator(".review-save-state")).toHaveText("Saved");
  await page.reload();
  await page.locator("body[data-hydrated='true']").waitFor();
  const reloadedScoreGroups = page.locator("[data-review-scale]");
  for (let index = 0; index < scoreGroupCount; index += 1) {
    await expect(
      reloadedScoreGroups
        .nth(index)
        .getByRole("radio", { name: "4", exact: true }),
    ).toBeChecked();
  }
});

test("review source remains visible at the final scoring controls", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.context().addCookies([
    {
      name: "program_cue_event",
      value: "evt-foe-2025",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
    {
      name: "program_cue_demo_identity",
      value: "evaluator",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const response = await page.goto("/review/workbench");
  expect(response?.ok()).toBeTruthy();
  await page.locator("body[data-hydrated='true']").waitFor();

  const sourceReference = page.locator("#review-submission-title");
  const scoreBody = page.locator(".review-score-body");
  const privateNotes = page.getByLabel("Private notes");
  const scoreProgress = page.locator(".review-score-progress");
  const reviewActions = page.locator("#review-actions");

  const measureWorkbench = () =>
    page.evaluate(() => {
      const workbench = document.querySelector<HTMLElement>(".review-layout");
      const source = document.querySelector<HTMLElement>(".review-detail");
      const rubric = document.querySelector<HTMLElement>(".review-score-body");
      const actions = document.querySelector<HTMLElement>("#review-actions");
      if (!workbench || !source || !rubric || !actions) return null;
      const workbenchBounds = workbench.getBoundingClientRect();
      const sourceBounds = source.getBoundingClientRect();
      const actionBounds = actions.getBoundingClientRect();
      return {
        pageScrollY: Math.round(window.scrollY),
        workbenchBottom: Math.round(workbenchBounds.bottom),
        sourceVisibleHeight: Math.round(
          Math.min(sourceBounds.bottom, window.innerHeight) -
            Math.max(sourceBounds.top, 0),
        ),
        actionsBottom: Math.round(actionBounds.bottom),
        viewportHeight: window.innerHeight,
        sourceOverflow: getComputedStyle(source).overflowY,
        rubricOverflow: getComputedStyle(rubric).overflowY,
      };
    });

  await scoreBody.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(privateNotes).toBeInViewport();
  await expect(scoreProgress).toBeInViewport();
  await expect(reviewActions).toBeInViewport();
  await expect(sourceReference).toBeInViewport();

  const layout = await measureWorkbench();
  expect(layout).not.toBeNull();
  expect(layout!.pageScrollY).toBe(0);
  expect(layout!.sourceVisibleHeight).toBeGreaterThan(200);
  expect(layout!.actionsBottom).toBeLessThanOrEqual(layout!.viewportHeight);
  expect(layout!.sourceOverflow).toBe("auto");
  expect(layout!.rubricOverflow).toBe("auto");

  await privateNotes.focus();
  await expect(privateNotes).toBeFocused();
  await expect(privateNotes).toBeInViewport();
  await expect(sourceReference).toBeInViewport();

  await page.setViewportSize({ width: 1280, height: 500 });
  await scoreBody.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(privateNotes).toBeInViewport();
  await expect(reviewActions).toBeInViewport();
  await expect(sourceReference).toBeInViewport();
  const shortLayout = await measureWorkbench();
  expect(shortLayout).not.toBeNull();
  expect(shortLayout!.pageScrollY).toBe(0);
  expect(shortLayout!.workbenchBottom).toBeLessThanOrEqual(
    shortLayout!.viewportHeight,
  );
  expect(shortLayout!.actionsBottom).toBeLessThanOrEqual(
    shortLayout!.viewportHeight,
  );

  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Review saved." }),
  ).toBeVisible();
  const noticeLayout = await measureWorkbench();
  expect(noticeLayout).not.toBeNull();
  expect(noticeLayout!.pageScrollY).toBe(0);
  expect(noticeLayout!.workbenchBottom).toBeLessThanOrEqual(
    noticeLayout!.viewportHeight,
  );
  expect(noticeLayout!.actionsBottom).toBeLessThanOrEqual(
    noticeLayout!.viewportHeight,
  );
  await expect(sourceReference).toBeInViewport();
  await expect(reviewActions).toBeInViewport();

  const discussionHeading = page.getByRole("heading", {
    name: "Committee discussion",
  });
  await discussionHeading.scrollIntoViewIfNeeded();
  await expect(discussionHeading).toBeInViewport();
});

test("evaluation administration exposes onboarding and consequential previews", async ({
  page,
}) => {
  test.setTimeout(90_000);
  await page.context().addCookies([
    {
      name: "program_cue_event",
      value: "evt-foe-2025",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
    {
      name: "program_cue_demo_identity",
      value: "administrator",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const response = await page.goto("/admin/review");
  expect(response?.ok()).toBeTruthy();
  await page.locator("body[data-hydrated='true']").waitFor();

  const reviewTargetMetric = page
    .locator(".pc-eval-metric")
    .filter({ hasText: "Review targets" });
  await expect(reviewTargetMetric.locator(".value")).toHaveText("8");
  await expect(reviewTargetMetric.locator(".detail")).toHaveText(
    "2 proposals · 6 sessions",
  );

  await openEvaluationView(page, "Setup");
  await page.getByText("Manage evaluation access", { exact: true }).click();
  const invitation = page.locator("details").filter({
    hasText: "Manage evaluation access",
  });
  await expect(invitation.getByLabel("Name")).toBeVisible();
  await expect(invitation.getByLabel("Email")).toBeVisible();
  await expect(invitation.getByLabel("Access role")).toBeVisible();
  await expect(
    invitation.getByLabel("Team after evaluator acceptance"),
  ).toBeVisible();
  await expect(invitation).toContainText("expires after seven days");
  await expect(
    invitation
      .getByRole("button", { name: /Promote to chair|Revoke chair/ })
      .first(),
  ).toBeVisible();
  await openEvaluationView(page, "Assignments");
  await expect(
    page.getByRole("heading", { name: "Session queue" }),
  ).toBeVisible();
  await openEvaluationView(page, "Results");
  const unifiedResults = page.getByRole("region", {
    name: "Unified evaluation results",
  });
  await expect(unifiedResults).toBeVisible();
  await expect(
    unifiedResults.getByRole("columnheader", { name: "Recommendations" }),
  ).toBeVisible();
  await expect(page.getByLabel("View preset")).toContainText("Decision-ready");
  await expect(page.getByLabel("Coverage filter")).toContainText(
    "Incomplete reviews",
  );
  await page.getByLabel("Coverage filter").selectOption("unassigned");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/(?:\?|&)filter=unassigned(?:&|$)/u);
  await expect(reviewTargetMetric.locator(".value")).toHaveText("6");
  await expect(reviewTargetMetric.locator(".detail")).toHaveText(
    "0 proposals · 6 sessions",
  );
  await expect(unifiedResults.locator("tbody > tr")).toHaveCount(6);

  await page.getByLabel("Coverage filter").selectOption("");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/(?:\?|&)filter=(?:&|$)/u);
  await expect(reviewTargetMetric.locator(".value")).toHaveText("8");
  await openEvaluationView(page, "Assignments");
  await page.getByRole("link", { name: "Open discussion" }).first().click();
  await expect(
    page.getByRole("heading", { name: "Committee discussion" }),
  ).toBeVisible();
  await expect(
    page.getByText(/thread is confined to the selected round/i),
  ).toBeVisible();
  await page.getByLabel("Add to discussion").fill("Browser committee note");
  await page.getByRole("button", { name: "Add message" }).click();
  await expect(page.getByText("Browser committee note")).toBeVisible();

  const discussionUrl = new URL(page.url());
  const roundId = discussionUrl.searchParams.get("resultsRound");
  const submissionId = discussionUrl.searchParams.get("submission");
  const sessionId = discussionUrl.searchParams.get("session");
  const targetType = submissionId ? "submission" : "session";
  const targetId = submissionId ?? sessionId;
  if (!roundId || !targetId) {
    throw new Error(
      "The focused discussion URL is missing its round or target.",
    );
  }
  await page.waitForTimeout(1_100);
  await page.evaluate(
    async ({ roundId, targetId, targetType }) => {
      for (let index = 0; index < 50; index += 1) {
        const response = await fetch("/admin/review", {
          method: "POST",
          body: new URLSearchParams({
            intent: "add-discussion-message",
            roundId,
            targetType,
            targetId,
            body: `Browser pagination note ${String(index).padStart(2, "0")}`,
            idempotencyKey: crypto.randomUUID(),
          }),
        });
        if (!response.ok) {
          throw new Error(`Discussion message ${index} failed to save.`);
        }
      }
    },
    { roundId, targetId, targetType },
  );
  await page.reload();
  await page.locator("body[data-hydrated='true']").waitFor();
  await expect(page.getByText("Browser committee note")).toBeHidden();
  await expect(page.getByText("50+ messages", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Load earlier messages" }).click();
  await expect(page.getByText("Browser committee note")).toBeVisible();

  await openEvaluationView(page, "Assignments");
  const bulkAssignButton = page.getByRole("button", { name: "Bulk assign" });
  await bulkAssignButton.click();
  const bulkAssignment = page.getByRole("dialog", {
    name: "Bulk assign reviewers",
  });
  const trackFilter = bulkAssignment.getByLabel("Filter submissions by track");
  await expect(trackFilter.locator("option")).not.toHaveCount(1);
  await trackFilter.selectOption({ index: 1 });
  await bulkAssignment.getByRole("button", { name: "Select visible" }).click();
  expect(await bulkAssignment.getByRole("checkbox").count()).toBeGreaterThan(0);
  await expect(bulkAssignment.getByRole("checkbox").first()).toBeChecked();
  await bulkAssignment
    .getByRole("button", { name: /Preview 1 assignment target/ })
    .click();
  const bulkPreview = page.getByRole("dialog", {
    name: "Confirm bulk assignment",
  });
  await expect(bulkPreview).toContainText(
    "New untouched assignments can be undone for five minutes",
  );
  await expect(
    bulkPreview.getByRole("button", { name: "Confirm assignments" }),
  ).toBeVisible();
  await bulkPreview.getByRole("button", { name: "Close" }).click();
  await expect(bulkPreview).toBeHidden();
  await expect(bulkAssignButton).toBeFocused();

  const undecidedProposal = page
    .getByRole("region", { name: "Evaluation proposal queue" })
    .getByRole("row", { name: /Designing inclusive attendee journeys/u });
  await undecidedProposal.getByRole("button", { name: "Decide" }).click();
  const decision = page.getByRole("dialog", { name: /Decision ·/ });
  await expect(decision).toContainText("Effect preview");
  await expect(
    decision.getByLabel("Acceptance programme track"),
  ).not.toHaveValue("");
  await expect(decision).toContainText(
    "Release updates applicant-visible state",
  );
  await expect(
    decision.getByRole("button", { name: "Release decision" }),
  ).toBeVisible();
  await decision.getByRole("button", { name: "Close" }).click();
  await expect(decision).toBeHidden();
  await expect(
    undecidedProposal.getByRole("button", { name: "Decide" }),
  ).toBeFocused();
});

test("a committee chair can save and resume an accepted decision draft", async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
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
    {
      name: "program_cue_demo_identity",
      value: "committee_chair",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const response = await page.goto("/admin/review");
  expect(response?.ok()).toBeTruthy();
  await page.locator("body[data-hydrated='true']").waitFor();

  await openEvaluationView(page, "Assignments");
  const undecidedProposal = page
    .getByRole("region", { name: "Evaluation proposal queue" })
    .getByRole("row", { name: /Designing inclusive attendee journeys/u });
  await undecidedProposal.getByRole("button", { name: "Decide" }).click();
  let decision = page.getByRole("dialog", { name: /Decision ·/ });
  await decision.locator('select[name="decision"]').selectOption("accepted");
  const format = decision.getByLabel("Acceptance session format");
  const sessionFormatKey = await format.inputValue();
  expect(sessionFormatKey).not.toBe("");
  await decision.getByLabel("Rationale").fill("Keep this chair draft intact.");
  await decision.getByLabel("Acceptance session duration (minutes)").fill("75");
  await decision.getByRole("button", { name: "Save draft" }).click();

  await expect(
    page.getByRole("heading", { name: "Review & selection", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Decision draft saved" }),
  ).toBeVisible();
  await undecidedProposal.getByRole("button", { name: "Decide" }).click();
  decision = page.getByRole("dialog", { name: /Decision ·/ });
  await expect(decision).toContainText("Resuming decision draft revision");
  await expect(decision.locator('select[name="decision"]')).toHaveValue(
    "accepted",
  );
  await expect(decision.getByLabel("Acceptance session format")).toHaveValue(
    sessionFormatKey,
  );
  await expect(decision.getByLabel("Rationale")).toHaveValue(
    "Keep this chair draft intact.",
  );
  await expect(
    decision.getByLabel("Acceptance session duration (minutes)"),
  ).toHaveValue("75");

  await resetDemoEvent(request);
});

test("a released decision keeps inspectable recipient delivery evidence after reload", async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
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
    {
      name: "program_cue_demo_identity",
      value: "administrator",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto("/admin/review");
  await page.locator("body[data-hydrated='true']").waitFor();

  await openEvaluationView(page, "Assignments");
  const proposal = page
    .getByRole("region", { name: "Evaluation proposal queue" })
    .getByRole("row", { name: /Designing inclusive attendee journeys/u });
  await proposal.getByRole("button", { name: "Decide" }).click();
  const decision = page.getByRole("dialog", { name: /Decision ·/ });
  await decision.locator('select[name="decision"]').selectOption("rejected");
  await decision
    .getByLabel("Rationale")
    .fill("The programme already covers this material in greater depth.");
  const evidenceOverride = decision.getByRole("checkbox", {
    name: /Confirm review-evidence override/u,
  });
  if (await evidenceOverride.isVisible()) await evidenceOverride.check();
  await decision.getByRole("button", { name: "Release decision" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: /notification queued/i }),
  ).toBeVisible();

  async function expectDeliveryEvidence() {
    await openEvaluationView(page, "Results");
    const result = page
      .getByRole("region", { name: "Unified evaluation results" })
      .getByRole("row", { name: /Designing inclusive attendee journeys/u });
    await result.getByText("Review and decision detail").click();
    await expect(
      result.getByText("Decision notification evidence"),
    ).toBeVisible();
    await expect(result).toContainText("Rendered subject");
    await expect(result).toContainText("Recipient delivery");
    await expect(result).toContainText("Rendered template body SHA-256");
    await expect(result).toContainText("Delivery state updated");
    await expect(result).toContainText(
      "Queue acceptance is not proof of delivery",
    );
  }

  await expectDeliveryEvidence();
  await page.reload();
  await page.locator("body[data-hydrated='true']").waitFor();
  await expectDeliveryEvidence();
  await resetDemoEvent(request);
});

test("AI advisory and human judgment remain separate after reload", async ({
  page,
  request,
}) => {
  await resetDemoEvent(request);
  const fixture = await request.post("/demo/fixtures/ai-review-evidence", {
    form: { confirm: "seed-ai-review-evidence-browser-fixture" },
    headers: { origin: e2eOrigin },
  });
  expect(fixture.ok()).toBeTruthy();
  await page.context().addCookies([
    {
      name: "program_cue_event",
      value: "evt-foe-2025",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
    {
      name: "program_cue_demo_identity",
      value: "administrator",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto("/admin/review");
  await page.locator("body[data-hydrated='true']").waitFor();

  async function openEvidence() {
    const result = page
      .getByRole("region", { name: "Unified evaluation results" })
      .getByRole("row", { name: /Designing inclusive attendee journeys/u });
    const humanAggregate = result.getByText(
      "Human review aggregate · canonical",
    );
    if (!(await humanAggregate.isVisible())) {
      await result.getByText("Review and decision detail").click();
    }
    await expect(humanAggregate).toBeVisible();
    await expect(result.getByText("AI advisory · immutable")).toBeVisible();
    await expect(
      result.getByText(/Human assessment of the AI advisory/u),
    ).toBeVisible();
    await expect(result).toContainText("2.5 / 5");
    await expect(result).toContainText("no model provider was called");
    return result;
  }

  let result = await openEvidence();
  await result.getByLabel("Human assessment score").fill("4.5");
  await result
    .getByLabel("Assessment rationale")
    .fill("The human panel weighs the demonstrated audience fit differently.");
  await result
    .getByRole("checkbox", { name: /Save this as a separate/u })
    .check();
  await result.getByRole("button", { name: "Save human assessment" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "Human assessment of the AI advisory saved" }),
  ).toContainText("4.5 / 5");

  result = await openEvidence();
  await expect(result).toContainText("4.5 / 5");
  await expect(result).toContainText(
    "Does not affect review averages, coverage, disagreement, sorting, or decision readiness",
  );
  await page.reload();
  await page.locator("body[data-hydrated='true']").waitFor();
  result = await openEvidence();
  await expect(result).toContainText("2.5 / 5");
  await expect(result).toContainText("4.5 / 5");
  await resetDemoEvent(request);
});

test("a clean reviewer sees a waiting state before receiving an invitation", async ({
  page,
  request,
}) => {
  await resetDemoEvent(request);
  await page.context().addCookies([
    {
      name: "program_cue_demo_identity",
      value: "sbek_reviewer",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);

  const response = await page.goto("/events/select");
  expect(response?.ok()).toBeTruthy();
  await page.locator("body[data-hydrated='true']").waitFor();
  await expect(
    page.getByRole("heading", { name: "No event access yet" }),
  ).toBeVisible();
  await expect(page.getByText("No event access yet")).toBeVisible();
  await expect(page.getByText("You do not have access")).toBeHidden();
});

test("the exact SBEK reviewer invitation hands off to Sam without claiming email delivery", async ({
  page,
  request,
}) => {
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
  await page.locator("body[data-hydrated='true']").waitFor();
  await openEvaluationView(page, "Setup");
  await page.getByText("Manage evaluation access", { exact: true }).click();
  const invitation = page.locator("details").filter({
    hasText: "Manage evaluation access",
  });
  await invitation.getByLabel("Name").fill("Sam Whitfield");
  await invitation.getByLabel("Email").fill("sbek-reviewer@example.com");
  await invitation.getByRole("button", { name: "Send invitation" }).click();
  await expect(
    page.getByText(/fixed demo identity was activated locally/i),
  ).toBeVisible();
  await expect(invitation.getByText("Unaccepted invitations")).toHaveCount(0);

  await page.goto("/demo");
  await page
    .getByRole("row", { name: /sbek reviewer.*Sam Whitfield/i })
    .getByRole("button", { name: "Continue as Sam Whitfield" })
    .click();
  await expect(page).toHaveURL(/\/review\/workbench/);
  await expect(
    page.getByRole("heading", { name: "Review Workbench" }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Signed in as Sam Whitfield" }),
  ).toBeVisible();

  await page.goto("/demo");
  await page.getByRole("button", { name: "Continue as Sam Whitfield" }).click();
  await expect(page).toHaveURL(/\/review\/workbench/);
});
