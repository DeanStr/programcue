import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { e2eOrigin } from "./support/e2e-origin";
import { resetDemoEvent } from "./support/reset-demo-event";

test.setTimeout(90_000);

async function identity(page: import("@playwright/test").Page, value: string) {
  await page
    .context()
    .addCookies([{ name: "program_cue_demo_identity", value, url: e2eOrigin }]);
}

test("sponsor contact submits within allowance and organiser accepts into the ordinary session workflow", async ({
  page,
  request,
}) => {
  await resetDemoEvent(request);
  await page.goto("/");
  await page.goto("/admin/sponsors");
  await page
    .getByLabel("Company name", { exact: true })
    .fill("Example sponsor");
  await page.getByLabel("Tier", { exact: true }).fill("Gold");
  await page
    .getByRole("button", { name: "Create sponsor", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Portal contacts" }),
  ).toBeVisible();
  const adminUrl = page.url();
  await page.getByLabel("Contact name", { exact: true }).fill("Priya Shah");
  await page
    .getByLabel("Contact email", { exact: true })
    .fill("priya.speaker@example.com");
  await page.getByRole("button", { name: "Add contact", exact: true }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: /Sponsor contact updated|Deadline extended/ }),
  ).toContainText("Sponsor contact updated");
  await page
    .getByRole("button", { name: "Prepare invitation", exact: true })
    .click();
  await expect(page).toHaveURL(/\/admin\/communications\/compose\//);
  await expect(
    page.getByText("priya.speaker@example.com", { exact: false }).first(),
  ).toBeVisible();
  await identity(page, "speaker");
  await page.goto("/sponsor");
  await page.getByRole("link", { name: /Example sponsor ·/ }).click();
  await expect(
    page.getByRole("heading", { name: "Accept sponsor invitation" }),
  ).toBeVisible();
  await page.getByRole("checkbox", { name: /I accept sponsor access/ }).check();
  await page
    .getByRole("button", { name: "Accept invitation", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Add sponsored session" }),
  ).toBeVisible();
  const portalUrl = page.url();
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({
    path: "/tmp/programcue-sponsor-portal-browser.png",
    fullPage: true,
  });
  await page
    .getByLabel("Session title", { exact: true })
    .fill("Industry lessons from our sponsor");
  await page
    .getByLabel("Speaker name", { exact: true })
    .fill("Invited Presenter");
  await page
    .getByLabel("Speaker email", { exact: true })
    .fill("sponsor-presenter@example.com");
  await page
    .getByRole("button", { name: "Save session draft", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Industry lessons from our sponsor" }),
  ).toBeVisible();
  await expect(
    page.getByText("Your session allowance is full.", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Save session draft" }),
  ).toHaveCount(0);
  await page
    .getByRole("checkbox", { name: /Submit “Industry lessons/ })
    .check();
  await page
    .getByRole("button", { name: "Submit for review", exact: true })
    .click();
  await expect(
    page.getByText("Status: submitted", { exact: true }),
  ).toBeVisible();
  await identity(page, "administrator");
  await page.goto(adminUrl);
  await page
    .getByRole("checkbox", { name: /Create “Industry lessons/ })
    .check();
  await page
    .getByRole("button", {
      name: "Accept session and invite speakers",
      exact: true,
    })
    .click();
  await expect(
    page.getByText("Status: accepted", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Manage accepted session" }),
  ).toBeVisible();
  await identity(page, "speaker");
  await page.goto(portalUrl);
  await expect(
    page.getByText("Accepted by the organiser.", { exact: false }),
  ).toBeVisible();
  await expect(page.getByText("Edit session", { exact: true })).toHaveCount(0);
  await identity(page, "administrator");
  await page.goto(adminUrl);
  await page.getByText("Revoke access", { exact: true }).click();
  await page.getByRole("checkbox", { name: /Confirm revoking/ }).check();
  await page
    .getByRole("button", { name: "Revoke contact", exact: true })
    .click();
  await expect(
    page.getByText("Revoked", { exact: false }).first(),
  ).toBeVisible();
  await identity(page, "speaker");
  const response = await page.goto(portalUrl);
  expect(response?.status()).toBe(404);
  await identity(page, "owner");
  await page.goto("/admin/files/retention");
  await expect(
    page.getByText(
      "This also permanently removes private sponsor profiles, contacts and proposal snapshots.",
      { exact: false },
    ),
  ).toBeVisible();
});

test("deliverables matrix supports filters, evidence navigation and event-local deadline extension", async ({
  page,
  request,
}) => {
  await resetDemoEvent(request);
  await page.goto("/");
  await page.goto("/admin/tasks");
  await page
    .getByRole("link", { name: "Deliverables matrix", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Speaker deliverables", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Speaker", { exact: true }).fill("Priya");
  await page
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  const matrix = page.getByRole("region", {
    name: "Speaker deliverables matrix",
  });
  await expect(
    matrix.getByRole("link", { name: "Priya Shah", exact: true }),
  ).toBeVisible();
  const extension = matrix.locator("details").first();
  await extension.locator("summary").click();
  await extension
    .getByLabel("New deadline", { exact: true })
    .fill("2035-10-20");
  await extension
    .getByLabel("Reason", { exact: true })
    .fill("Agreed with the speaker for the new delivery date.");
  await extension
    .getByRole("button", { name: "Save extension", exact: true })
    .click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: /Sponsor contact updated|Deadline extended/ }),
  ).toContainText("Deadline extended");
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
  await page.screenshot({
    path: "/tmp/programcue-deliverables-browser.png",
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "Prepare reminder", exact: true })
    .click();
  await expect(page).toHaveURL(/\/admin\/communications\/compose\//);
  await expect(
    page.getByText("priya.speaker@example.com", { exact: false }).first(),
  ).toBeVisible();
  await page.goto("/admin/tasks/deliverables?q=Priya");
  await page
    .getByRole("combobox", { name: "Show speakers with", exact: true })
    .selectOption("unassigned");
  await page
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await expect(page).toHaveURL(/state=unassigned/);
  await page
    .getByRole("combobox", { name: "Show speakers with", exact: true })
    .selectOption("outstanding");
  await page
    .getByRole("combobox", { name: "Requirement", exact: true })
    .selectOption("task-template-handbook");
  await page
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await expect(page).toHaveURL(/state=outstanding/);
  await page.getByRole("link", { name: "Clear", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/tasks\/deliverables$/);
  await expect(page.getByLabel("Speaker", { exact: true })).toHaveValue("");
  await expect(
    page.getByRole("combobox", { name: "Requirement", exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("combobox", { name: "Show speakers with", exact: true }),
  ).toHaveValue("all");
  await page.goBack();
  await expect(page.getByLabel("Speaker", { exact: true })).toHaveValue(
    "Priya",
  );
  await expect(
    page.getByRole("combobox", { name: "Show speakers with", exact: true }),
  ).toHaveValue("outstanding");
  await page.goForward();
  await expect(page.getByLabel("Speaker", { exact: true })).toHaveValue("");
  await page
    .getByRole("button", { name: "Apply filters", exact: true })
    .click();
  await expect(page).toHaveURL(/state=all/);
  expect(new URL(page.url()).searchParams.get("q")).toBe("");
  expect(new URL(page.url()).searchParams.get("template")).toBe("");
});
