import { expect, test } from "@playwright/test";

test.beforeEach(async ({ request }) => {
  expect((await request.get("/admin/command")).ok()).toBeTruthy();
});

test("reviewer queue navigation and submission confirmation preserve context", async ({
  page,
}) => {
  await page.context().addCookies([
    {
      name: "program_cue_demo_role",
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
  await expect(invitation).toContainText("expire after seven days");
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
  await bulkAssignment.getByRole("checkbox").first().check();
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
