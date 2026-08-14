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
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Send verification code" }).click();
  await page.getByLabel("Six-digit code").fill("424242");
  await page.getByRole("button", { name: "Verify and open drafts" }).click();
  await expect(
    page.getByRole("heading", { name: "Call for Speakers" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Start application" }).click();

  await expect(page.getByLabel("Session title *")).toBeVisible();
  await expectNoHorizontalPageOverflow(page);
});

test("mobile administration sections reveal linked content without overflow", async ({
  page,
}) => {
  await waitForInterface(page, "/admin/command");
  const navigation = page.getByRole("navigation", {
    name: "Command Centre sections",
  });
  const workflows = page.getByRole("button", { name: /^Workflow actions/ });
  await expect(workflows).toHaveAttribute("aria-expanded", "false");
  await navigation.getByRole("link", { name: "Workflow actions" }).click();
  await expect(workflows).toHaveAttribute("aria-expanded", "true");
  await expect(
    page.getByRole("heading", { name: "Readiness by workflow" }),
  ).toBeVisible();
  await workflows.click();
  await expect(workflows).toHaveAttribute("aria-expanded", "false");
  await navigation.getByRole("link", { name: "Workflow actions" }).click();
  await expect(workflows).toHaveAttribute("aria-expanded", "true");

  const assistants = page.getByRole("button", {
    name: /^Assistants and delivery/,
  });
  await navigation.getByRole("link", { name: "Assistants" }).click();
  await expect(assistants).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByLabel("Operational focus")).toHaveClass(/field/);

  const reminderSelector = page.getByLabel("Approved reminder foundation");
  await expect(reminderSelector).toBeVisible();
  const selectorBox = await reminderSelector.boundingBox();
  expect(selectorBox).not.toBeNull();
  expect(selectorBox!.x + selectorBox!.width).toBeLessThanOrEqual(390);
  await expectNoHorizontalPageOverflow(page);
  await expectNoContrastViolations(page, "Command Centre");

  await waitForInterface(page, "/admin/communications");
  const delivery = page.getByRole("button", {
    name: /^Delivery configuration/,
  });
  await expect(delivery).toHaveAttribute("aria-expanded", "false");
  await page
    .getByRole("navigation", { name: "Communications Centre sections" })
    .getByRole("link", { name: "Delivery" })
    .click();
  await expect(delivery).toHaveAttribute("aria-expanded", "true");
  await expectNoHorizontalPageOverflow(page);
  await expectNoContrastViolations(page, "Communications Centre");

  await waitForInterface(page, "/admin/review");
  const evaluationAccess = page.getByRole("button", {
    name: /^Evaluation access/,
  });
  await expect(evaluationAccess).toHaveAttribute("aria-expanded", "false");
  await page
    .getByRole("navigation", { name: "Evaluation administration sections" })
    .getByRole("link", { name: "Access" })
    .click();
  await expect(evaluationAccess).toHaveAttribute("aria-expanded", "true");
  await expectNoHorizontalPageOverflow(page);
});

test("scrollable table regions accept keyboard focus", async ({ page }) => {
  await waitForInterface(page, "/admin/submissions/form");
  const history = page.getByRole("region", { name: "Form version history" });
  await history.focus();
  await expect(history).toBeFocused();
});
