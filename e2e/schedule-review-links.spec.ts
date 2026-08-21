import { expect, type Page, test } from "@playwright/test";

import { e2eOrigin } from "./support/e2e-origin";
import { resetDemoEvent } from "./support/reset-demo-event";

async function waitForInterface(page: Page, path: string) {
  const response = await page.goto(path);
  expect(response?.ok()).toBeTruthy();
  await page.locator("body[data-hydrated='true']").waitFor();
}

test.beforeEach(async ({ page }) => {
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
  await waitForInterface(page, "/public/programme/future-of-events-2027");
});

test.afterEach(async ({ request }) => {
  await resetDemoEvent(request);
});

test("creates a one-time confidential review URL and invalidates it on revoke and publication", async ({
  page,
}) => {
  await waitForInterface(page, "/admin/schedule");
  await page.getByRole("button", { name: "Create next draft" }).click();
  const nextDraft = page.getByRole("dialog", {
    name: "Create the next schedule draft?",
  });
  await nextDraft.getByRole("button", { name: "Confirm new draft" }).click();
  await expect(
    page.getByRole("heading", { name: "Draft review links" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Create review link" }).click();
  const createDialog = page.getByRole("dialog", {
    name: "Create a confidential draft review link?",
  });
  await expect(createDialog).toContainText("unpublished profiles");
  await createDialog
    .getByRole("button", { name: "Create confidential link" })
    .click();
  const urlField = createDialog.getByLabel("Confidential preview URL");
  await expect(urlField).toBeVisible();
  const reviewUrl = await urlField.inputValue();
  expect(reviewUrl).toMatch(
    new RegExp(
      `^${e2eOrigin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/programme-preview/[A-Za-z0-9_-]{43}$`,
    ),
  );
  const previewPath = new URL(reviewUrl).pathname;
  await createDialog.getByText("Close", { exact: true }).click();
  await expect(page.getByText("Confidential preview URL")).toHaveCount(0);
  await expect(page.locator("text=/programme-preview/")).toHaveCount(0);
  const reviewList = page.locator(".schedule-review-link-list");
  await expect(reviewList).toContainText("Created");
  await expect(reviewList).toContainText("Jordan Alvarez");

  const preview = await page.goto(previewPath);
  expect(preview?.ok()).toBeTruthy();
  expect(preview?.headers()["cache-control"]).toBe("private, no-store");
  expect(preview?.headers()["x-robots-tag"]).toBe("noindex, nofollow");
  await expect(
    page.getByRole("heading", { name: "Confidential programme preview" }),
  ).toBeVisible();
  await expect(page.getByText("Future of Events 2027")).toHaveCount(0);
  const html = await page.content();
  expect(html).not.toContain("Community and Connection");

  await page.getByRole("button", { name: "View programme" }).click();
  await expect(
    page.getByRole("heading", { name: "Future of Events 2027" }),
  ).toBeVisible();
  await expect(
    page.getByText("Community and Connection").first(),
  ).toBeVisible();

  await waitForInterface(page, "/admin/schedule");
  await page.getByRole("button", { name: "Revoke" }).first().click();
  await page
    .getByRole("dialog", { name: "Revoke this confidential review link?" })
    .getByRole("button", { name: "Revoke link" })
    .click();
  await expect(page.getByText("Manually revoked")).toBeVisible();
  const revoked = await page.goto(previewPath);
  expect(revoked?.status()).toBe(404);
  await expect(
    page.getByRole("heading", { name: "Page not found" }),
  ).toBeVisible();

  await waitForInterface(page, "/admin/schedule");
  await page.getByRole("button", { name: "Create review link" }).click();
  await page
    .getByRole("dialog", { name: "Create a confidential draft review link?" })
    .getByRole("button", { name: "Create confidential link" })
    .click();
  const secondUrl = await page
    .getByLabel("Confidential preview URL")
    .inputValue();
  const secondPath = new URL(secondUrl).pathname;
  await page.getByRole("dialog").getByText("Close", { exact: true }).click();

  await page.getByRole("button", { name: "Publish schedule" }).click();
  await page
    .getByRole("dialog", { name: "Publish schedule" })
    .getByRole("button", { name: "Confirm publication" })
    .click();
  await expect(page.getByText(/Schedule published/i).first()).toBeVisible();
  const published = await page.goto(secondPath);
  expect(published?.status()).toBe(404);
});
