import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { resetDemoSubmissions } from "./support/reset-demo-submissions";

async function waitForInterface(
  page: import("@playwright/test").Page,
  path: string,
) {
  const response = await page.goto(path);
  expect(response?.ok()).toBeTruthy();
  await page.locator("body[data-hydrated='true']").waitFor();
}

async function expectNoHorizontalPageOverflow(
  page: import("@playwright/test").Page,
) {
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          document.documentElement.scrollWidth <=
          document.documentElement.clientWidth,
      ),
    )
    .toBe(true);
}

async function expectNoContrastViolations(
  page: import("@playwright/test").Page,
  label: string,
) {
  const result = await new AxeBuilder({ page })
    .withRules(["color-contrast"])
    .analyze();
  expect(
    result.violations,
    `${label} contrast violations: ${result.violations
      .flatMap((violation) => violation.nodes.map((node) => node.target))
      .join(", ")}`,
  ).toEqual([]);
}

test.use({ viewport: { width: 390, height: 844 } });

test.beforeAll(async ({ request }) => {
  await resetDemoSubmissions(request);
});

test.afterAll(async ({ request }) => {
  await resetDemoSubmissions(request);
});

test("authenticated application stays within the mobile viewport", async ({
  page,
}) => {
  const email = `mobile-applicant-${Date.now()}@example.com`;

  await waitForInterface(page, "/apply/form");
  await expect(page.getByText(/April 30, 2027/).first()).toBeVisible();
  await page.getByText("Already started?", { exact: true }).click();
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Send verification code" }).click();
  await page.getByLabel("Six-digit code").fill("424242");
  await page.getByRole("button", { name: "Verify and open drafts" }).click();
  await expect(
    page.getByRole("heading", { name: "Call for Speakers" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Start application" }).click();

  await expect(page.getByLabel("Session title")).toBeVisible();
  await expectNoHorizontalPageOverflow(page);
});

test("mobile administration sections reveal linked content without overflow", async ({
  page,
}) => {
  await waitForInterface(page, "/admin/command");
  await expect(
    page.getByRole("heading", { name: "Command Centre" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Overall readiness" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible();
  await page.getByText("Foundation and purpose", { exact: true }).click();
  const reminderSelector = page.getByLabel("Approved reminder foundation");
  await expect(reminderSelector).toBeVisible();
  const selectorBox = await reminderSelector.boundingBox();
  expect(selectorBox).not.toBeNull();
  expect(selectorBox!.x + selectorBox!.width).toBeLessThanOrEqual(390);
  await expectNoHorizontalPageOverflow(page);
  await expectNoContrastViolations(page, "Command Centre");

  await waitForInterface(page, "/admin/operations?panel=activity");
  await expect(
    page.getByRole("heading", { name: "Event activity timeline" }),
  ).toBeVisible();
  await expect(page.getByLabel("Scope")).toHaveCount(0);
  await expect(page.getByLabel("Find actors")).toBeVisible();
  await expectNoHorizontalPageOverflow(page);

  // Sender profiles, automation and calendar accounts are configured once and
  // then left alone, so they sit behind Delivery settings rather than on the
  // page an operator opens to send something today.
  await waitForInterface(page, "/admin/communications?view=setup");
  // Delivery configuration is the reason this view exists, so it opens with
  // the page. Calendar administration is the one that starts closed.
  const calendars = page.getByRole("button", {
    name: /Calendar administration/,
  });
  await expect(calendars).toHaveAttribute("aria-expanded", "false");
  await page
    .getByRole("navigation", { name: "Delivery settings sections" })
    .getByRole("link", { name: "Calendars" })
    .click();
  await expect(calendars).toHaveAttribute("aria-expanded", "true");
  await expectNoHorizontalPageOverflow(page);
  await expectNoContrastViolations(page, "Delivery settings");

  await waitForInterface(page, "/admin/communications");
  // Templates is the centre's primary work and opens with the page; History
  // is the one that starts closed.
  const history = page.getByRole("button", { name: /History/ });
  await expect(history).toHaveAttribute("aria-expanded", "false");
  await page
    .getByRole("navigation", { name: "Communications Centre sections" })
    .getByRole("link", { name: "History" })
    .click();
  await expect(history).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("heading", { name: "Delivery health" }),
  ).toBeVisible();
  await expect(page.getByText("Current event · last 90 days")).toBeVisible();
  await page.getByRole("link", { name: "Event lifetime" }).click();
  await expect(page.getByText("Current event · event lifetime")).toBeVisible();
  await expect(page.getByRole("link", { name: "Last 90 days" })).toBeVisible();
  await expectNoHorizontalPageOverflow(page);
  await expectNoContrastViolations(page, "Communications Centre");

  await waitForInterface(page, "/admin/review");
  await page
    .getByRole("navigation", { name: "Evaluation views" })
    .getByRole("link", { name: "Setup" })
    .click();
  const evaluationAccess = page.locator("details").filter({
    hasText: "Manage evaluation access",
  });
  await expect(
    page.getByText("Manage evaluation access", { exact: true }),
  ).toBeVisible();
  await expect(evaluationAccess.getByLabel("Name")).toBeHidden();
  await page.getByText("Manage evaluation access", { exact: true }).click();
  await expect(evaluationAccess.getByLabel("Name")).toBeVisible();
  await expectNoHorizontalPageOverflow(page);
});

test("scrollable table regions accept keyboard focus", async ({ page }) => {
  await waitForInterface(page, "/admin/submissions/form");
  const history = page.getByRole("region", { name: "Form version history" });
  await history.focus();
  await expect(history).toBeFocused();
});
