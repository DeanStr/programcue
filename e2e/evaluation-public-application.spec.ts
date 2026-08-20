import { expect, test } from "@playwright/test";
import {
  completeApplicationTurnstile,
  installApplicationTurnstileMock,
  waitForApplicationTurnstileActions,
} from "./support/mock-turnstile";

const accessCode =
  process.env.PROGRAM_CUE_EVALUATION_E2E_ACCESS_CODE ??
  "program-cue-evaluation-e2e-access";

test("evaluation banner stays compact and usable on a narrow screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto("/evaluate");
  await page.getByRole("textbox", { name: "Access code" }).fill(accessCode);
  await page.getByRole("button", { name: "Unlock evaluation" }).click();
  await page
    .getByRole("button", { name: "Open as Organisation owner" })
    .click();

  const banner = page.getByRole("complementary", {
    name: "Evaluation session",
  });
  const actions = banner.locator(".pc-eval-banner-actions");
  await expect(banner).toBeVisible();
  await expect
    .poll(() =>
      banner.evaluate((element) =>
        Math.round(element.getBoundingClientRect().height),
      ),
    )
    .toBeLessThanOrEqual(100);
  await expect
    .poll(() =>
      banner.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          left: Math.round(bounds.left),
          rightGap: Math.round(
            document.documentElement.clientWidth - bounds.right,
          ),
          overflow: element.scrollWidth - element.clientWidth,
        };
      }),
    )
    .toEqual({ left: 0, rightGap: 0, overflow: 0 });
  await expect(
    banner.getByRole("link", { name: "Evaluation guide" }),
  ).toBeVisible();
  await expect(
    banner.getByRole("button", { name: "Change persona" }),
  ).toBeVisible();
  await expect(
    banner.getByRole("button", { name: "Hide evaluation bar" }),
  ).toBeVisible();
  await expect
    .poll(() =>
      actions
        .locator(".btn")
        .evaluateAll(
          (buttons) =>
            new Set(
              buttons.map((button) =>
                Math.round(button.getBoundingClientRect().top),
              ),
            ).size,
        ),
    )
    .toBe(1);
  await expect(banner).toHaveScreenshot("evaluation-banner-mobile.png");

  await page.setViewportSize({ width: 320, height: 700 });
  await expect
    .poll(() =>
      banner.evaluate((element) => {
        const identity = element.querySelector<HTMLElement>(
          ".pc-eval-banner-identity",
        );
        const buttons = [...element.querySelectorAll<HTMLElement>(".btn")];
        if (!identity || buttons.length !== 3) return null;
        return {
          bannerOverflow: Math.max(
            0,
            element.scrollWidth - element.clientWidth,
          ),
          identityOverflow: Math.max(
            0,
            identity.scrollWidth - identity.clientWidth,
          ),
          buttonOverflows: buttons.map((button) =>
            Math.max(0, button.scrollWidth - button.clientWidth),
          ),
        };
      }),
    )
    .toEqual({
      bannerOverflow: 0,
      identityOverflow: 0,
      buttonOverflows: [0, 0, 0],
    });
  await expect
    .poll(() =>
      banner.evaluate((element) =>
        Math.round(element.getBoundingClientRect().height),
      ),
    )
    .toBeLessThanOrEqual(100);

  await banner.getByRole("button", { name: "Hide evaluation bar" }).click();
  const restore = page.getByRole("button", {
    name: /Show evaluation bar: Evaluation/,
  });
  await expect(restore).toBeFocused();
  await restore.click();
  await expect(
    page.getByRole("button", { name: "Hide evaluation bar" }),
  ).toBeFocused();
});

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
