import { expect, test } from "@playwright/test";
import {
  completeApplicationTurnstile,
  installApplicationTurnstileMock,
  waitForApplicationTurnstileActions,
} from "./support/mock-turnstile";

const accessCode =
  process.env.PROGRAM_CUE_EVALUATION_E2E_ACCESS_CODE ??
  "program-cue-evaluation-e2e-access";

test("gate-only evaluation access reopens an anonymous application after redirect", async ({
  page,
}) => {
  await installApplicationTurnstileMock(page);
  await page.goto("/evaluate");
  await page.getByRole("textbox", { name: "Access code" }).fill(accessCode);
  await page.getByRole("button", { name: "Unlock evaluation" }).click();

  await expect(
    page.getByRole("heading", { name: "Choose an evaluation persona" }),
  ).toBeVisible();
  await expect(
    page.getByText("No persona selected", { exact: true }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Application form" }).click();
  await expect(
    page.getByText("Evaluation access is active without a selected persona."),
  ).toBeVisible();

  await waitForApplicationTurnstileActions(page, [
    "application_start_anonymous",
  ]);
  await completeApplicationTurnstile(
    page,
    "application_start_anonymous",
    "XXXX.DUMMY.TOKEN.XXXX",
  );
  const start = page.getByRole("button", { name: "Start application" });
  await expect(start).toBeEnabled({ timeout: 20_000 });
  await start.click();

  await expect(page).toHaveURL(/\/apply\/form\?draft=[^&]+&notice=/u);
  await expect(
    page.getByRole("heading", { name: "Protect and submit this draft" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Your applications" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Discard anonymous session" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(
    page.locator(".validation-item.ok[role='status']").filter({
      hasText: "Your draft has been saved.",
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Untitled application", level: 1 }),
  ).toBeVisible();
});

test("accepted speaker saves a new anonymous application from the participant workspace", async ({
  page,
}) => {
  await installApplicationTurnstileMock(page);
  await page.goto("/evaluate");
  await page.getByRole("textbox", { name: "Access code" }).fill(accessCode);
  await page.getByRole("button", { name: "Unlock evaluation" }).click();

  const acceptedSpeaker = page.locator("article").filter({
    has: page.getByRole("heading", { name: "Accepted speaker", exact: true }),
  });
  await acceptedSpeaker
    .getByRole("button", { name: "Open as Accepted speaker" })
    .click();
  await expect(page).toHaveURL(/\/participant\/dashboard$/u);

  await page.getByRole("link", { name: "Applications", exact: true }).click();
  await page
    .getByRole("link", {
      name: /Call for Speakers.*Start a new application/u,
    })
    .click();
  await expect(
    page.getByText("Accepted speaker is selected for private workspaces."),
  ).toBeVisible();
  await page.getByRole("link", { name: "Continue to application" }).click();

  await waitForApplicationTurnstileActions(page, [
    "application_start_anonymous",
  ]);
  await completeApplicationTurnstile(
    page,
    "application_start_anonymous",
    "XXXX.DUMMY.TOKEN.XXXX",
  );
  const start = page.getByRole("button", { name: "Start application" });
  await expect(start).toBeEnabled({ timeout: 20_000 });
  await start.click();

  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(
    page.locator(".validation-item.ok[role='status']").filter({
      hasText: "Your draft has been saved.",
    }),
  ).toBeVisible();
});
