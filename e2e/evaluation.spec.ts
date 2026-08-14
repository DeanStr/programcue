import { expect, test } from "@playwright/test";
import { resetDemoEvent } from "./support/reset-demo-event";

test.beforeEach(async ({ request }) => {
  expect((await request.get("/admin/command")).ok()).toBeTruthy();
});

test("reviewer queue navigation and submission confirmation preserve context", async ({
  page,
}) => {
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
  const queueItems = page
    .getByRole("navigation", {
      name: "Assigned review sources",
    })
    .getByRole("link");
  await expect(queueItems).toHaveCount(2);

  const firstUrl = page.url();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page).toHaveURL(/\/review\/workbench\?assignment=/);
  expect(page.url()).not.toBe(firstUrl);
  await page.getByRole("button", { name: "Previous", exact: true }).click();

  await page.getByRole("button", { name: "Submit and open next" }).click();
  await expect(
    page.getByRole("dialog", { name: "Submit and open the next review?" }),
  ).toBeHidden();
  // A blocked submit sends focus to the first unscored criterion, which is now
  // the first segment of its radio group rather than a dropdown.
  const scoreGroups = page.locator("[data-review-scale]");
  const scoreGroupCount = await scoreGroups.count();
  await expect(scoreGroups.first().getByRole("radio").first()).toBeFocused();

  const chosen = (index: number) =>
    scoreGroups.nth(index).getByRole("radio", { name: "4", exact: true });
  for (let index = 0; index < scoreGroupCount; index += 1) {
    await chosen(index).check();
    await expect(chosen(index)).toBeChecked();
  }
  await page.locator('select[name="recommendation"]').selectOption("accept");
  await page.locator('select[name="confidence"]').selectOption("4");
  for (let index = 0; index < scoreGroupCount; index += 1) {
    await expect(chosen(index)).toBeChecked();
  }
  await expect(
    page.getByRole("region", { name: "Score submission" }).locator(".status"),
  ).toContainText("4 / 4");
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

  await page.getByRole("button", { name: "Declare conflict" }).click();
  const conflict = page.getByRole("dialog", { name: "Declare a conflict" });
  await expect(conflict).toContainText(
    "recused and returned to the committee for reassignment",
  );
  await conflict.getByRole("button", { name: "Close" }).click();
  await expect(conflict).toBeHidden();
  await expect(
    page.getByRole("button", { name: "Declare conflict" }),
  ).toBeFocused();
});

test("evaluation administration exposes onboarding and consequential previews", async ({
  page,
}) => {
  const response = await page.goto("/admin/review");
  expect(response?.ok()).toBeTruthy();
  await page.locator("body[data-hydrated='true']").waitFor();

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
  await expect(
    page.getByRole("heading", { name: "Session queue" }),
  ).toBeVisible();

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

  await page.getByRole("button", { name: "Decide" }).first().click();
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
    page.getByRole("button", { name: "Decide" }).first(),
  ).toBeFocused();
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
