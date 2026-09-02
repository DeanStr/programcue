import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

import { resetDemoSubmissions } from "./support/reset-demo-submissions";

async function waitForInterface(
  page: import("@playwright/test").Page,
  path: string,
) {
  const response = await page.goto(path);
  expect(response).not.toBeNull();
  expect(response!.ok()).toBeTruthy();
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
  await expect(
    page.getByRole("heading", { name: "Resume an application" }),
  ).toBeVisible();
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Send verification code" }).click();
  await page.getByLabel("Six-digit code").fill("424242");
  await page
    .getByRole("button", { name: "Verify and open applications" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Call for Speakers" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Start application" }).click();

  await expect(page.getByLabel("Session title")).toBeVisible();
  await expectNoHorizontalPageOverflow(page);
});

test("mobile administration sections reveal linked content without overflow", async ({
  context,
  page,
}) => {
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
  await waitForInterface(page, "/admin/command");
  await expect(
    page.getByRole("heading", { name: "Command Centre" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Overall readiness" }),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Workflows" })).toBeVisible();
  await expect(page.getByLabel("Operational focus")).toBeVisible();
  // The reminder foundation and purpose are required inputs that shape the
  // draft, so they are shown outright rather than behind a disclosure.
  const reminderSelector = page.getByLabel("Approved reminder foundation");
  await expect(reminderSelector).toBeVisible();
  await expect(page.getByLabel("Message purpose")).toBeVisible();
  const selectorBox = await reminderSelector.boundingBox();
  expect(selectorBox).not.toBeNull();
  expect(selectorBox!.x + selectorBox!.width).toBeLessThanOrEqual(390);
  await expectNoHorizontalPageOverflow(page);

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
    .getByRole("link", { name: "Automation" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Schedule-change email" }),
  ).toBeVisible();
  const templateName = `Schedule change browser test ${Date.now()}`;
  const savedTemplate = await page.evaluate(async (name) => {
    const form = new FormData();
    form.set("intent", "save-template");
    form.set("name", name);
    form.set("category", "schedule");
    form.set("subject", "Your {{event.name}} schedule changed");
    form.set(
      "body",
      "Hi {{recipient.firstName}}\n\n{{schedule.changes}}\n\n{{schedule.url}}",
    );
    form.set("physicalAddress", "255 Front Street West, Toronto, ON");
    const response = await fetch("/admin/communications", {
      method: "POST",
      body: form,
    });
    return {
      ok: response.ok,
      status: response.status,
      url: response.url,
      text: await response.text(),
    };
  }, templateName);
  expect(
    savedTemplate.ok,
    `${savedTemplate.status} ${savedTemplate.text}`,
  ).toBeTruthy();
  const templateVersionId = new URL(savedTemplate.url).searchParams.get(
    "template",
  );
  expect(templateVersionId).not.toBeNull();
  const publishedTemplate = await page.evaluate(async (versionId) => {
    const form = new FormData();
    form.set("intent", "publish-template");
    form.set("templateVersionId", versionId);
    const response = await fetch("/admin/communications", {
      method: "POST",
      body: form,
    });
    return {
      ok: response.ok,
      status: response.status,
      text: await response.text(),
    };
  }, templateVersionId!);
  expect(
    publishedTemplate.ok,
    `${publishedTemplate.status} ${publishedTemplate.text}`,
  ).toBeTruthy();
  await page.reload();
  await page.locator("body[data-hydrated='true']").waitFor();

  const scheduleEmail = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Schedule-change email" }),
  });
  const notificationCheckbox = scheduleEmail.getByLabel(
    "Notify pending and confirmed participants on publication",
  );
  await expect(notificationCheckbox).not.toBeChecked();
  await scheduleEmail
    .getByLabel("Published schedule template")
    .selectOption(templateVersionId!);
  await notificationCheckbox.check();
  await scheduleEmail
    .getByRole("button", { name: "Save schedule email setting" })
    .click();
  await expect(
    scheduleEmail.getByText("Enabled", { exact: true }),
  ).toBeVisible();
  await expect(notificationCheckbox).toBeChecked();
  await scheduleEmail
    .getByRole("button", { name: "Disable", exact: true })
    .click();
  await expect(scheduleEmail.getByText("Off", { exact: true })).toBeVisible();
  await expect(notificationCheckbox).not.toBeChecked();
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
  const assignments = page
    .getByRole("navigation", { name: "Evaluation views" })
    .getByRole("link", { name: "Assignments" });
  await expect(assignments).toHaveAttribute(
    "href",
    /[?&]view=assignments(?:&|$)/,
  );
  await expect(assignments).not.toHaveAttribute("href", /#/);
  await assignments.click();
  await expect(
    page.getByRole("heading", { name: "Proposal assignments and decisions" }),
  ).toBeInViewport();
  await expect(
    page.getByRole("button", { name: "Assign" }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Decide" }).first(),
  ).toBeVisible();
  const evaluator = page
    .getByRole("combobox", { name: /Evaluator or team for / })
    .first();
  await expect(evaluator).toBeVisible();
  const evaluatorBox = await evaluator.boundingBox();
  expect(evaluatorBox).not.toBeNull();
  expect(evaluatorBox!.height).toBeLessThan(48);
  await waitForInterface(page, "/admin/review");
  await expect(
    page
      .getByRole("navigation", { name: "Evaluation views" })
      .getByRole("link", { name: "Results" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("heading", { name: "Proposal assignments and decisions" }),
  ).toHaveCount(0);
  await waitForInterface(page, "/admin/event");
  await waitForInterface(page, "/admin/review#evaluation-setup");
  await expect(page).toHaveURL(/[?&]view=setup(?:&|#|$)/);
  await expect(
    page.getByText("Manage evaluation access", { exact: true }),
  ).toBeVisible();
  await expectNoHorizontalPageOverflow(page);
});

test("scrollable table regions accept keyboard focus", async ({ page }) => {
  await waitForInterface(page, "/admin/submissions/form");
  const history = page.getByRole("region", { name: "Form version history" });
  await history.focus();
  await expect(history).toBeFocused();
});
