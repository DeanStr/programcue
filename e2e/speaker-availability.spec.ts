import { expect, type Page, test } from "@playwright/test";

import {
  acceptConfirm,
  confirmDialog,
  dismissConfirm,
} from "./support/confirm-dialog";
import { resetDemoEvent } from "./support/reset-demo-event";

test.beforeEach(async ({ request }) => {
  await resetDemoEvent(request);
});

test.setTimeout(180_000);

async function waitForHydrated(page: Page) {
  await page.locator("body[data-hydrated='true']").waitFor();
}

async function useDemoIdentity(
  page: Page,
  identity: "speaker" | "administrator",
) {
  await page.context().addCookies([
    {
      name: "program_cue_demo_identity",
      value: identity,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
    {
      name: "program_cue_event",
      value: "evt-foe-2025",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

test("speakers can save an all-day unavailable period without time fields", async ({
  page,
}) => {
  await useDemoIdentity(page, "speaker");
  await page.goto("/participant/availability");
  await waitForHydrated(page);
  await page.getByLabel("All day").check();
  await expect(page.getByLabel(/Start time/)).toHaveCount(0);
  await page.getByLabel("Start date").fill("2027-05-21");
  await page.getByLabel("End date").fill("2027-05-21");
  await page.getByLabel("Private note").fill("All-day travel");
  await page.getByRole("button", { name: "Add unavailable period" }).click();
  await expect(page.getByRole("status")).toContainText("All day ·");
  await expect(page.getByText("All-day travel")).toBeVisible();
  await expect(
    page.locator("li").filter({ hasText: "All-day travel" }).locator("strong"),
  ).toContainText("All day ·");
});

test("speakers can record availability that organisers can see and delete", async ({
  page,
}) => {
  await useDemoIdentity(page, "speaker");
  await page.goto("/participant/availability");
  await waitForHydrated(page);
  await expect(
    page.getByRole("heading", { name: "Availability", level: 1 }),
  ).toBeVisible();
  await page.getByLabel("Start date").fill("2027-05-21");
  await page.getByLabel("End date").fill("2027-05-21");
  await page.getByLabel(/Start time/).fill("09:00");
  await page.getByLabel(/End time/).fill("10:00");
  await page.getByLabel("Private note").fill("Travel buffer");
  await page.getByRole("button", { name: "Add unavailable period" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Saved unavailable period",
  );
  await expect(page.getByText("Travel buffer")).toBeVisible();
  await waitForHydrated(page);

  const remove = page.getByRole("button", { name: "Remove", exact: true });
  await remove.click();
  await expect(confirmDialog(page)).toBeVisible();
  await dismissConfirm(page);
  await expect(remove).toBeFocused();

  await remove.click();
  await acceptConfirm(page);
  await expect(page.getByRole("status")).toContainText(
    "Removed unavailable period",
  );

  await page.getByLabel("Start date").fill("2027-05-21");
  await page.getByLabel("End date").fill("2027-05-21");
  await page.getByLabel(/Start time/).fill("13:00");
  await page.getByLabel(/End time/).fill("14:00");
  await page.getByLabel("Private note").fill("Keep this note private");
  await page.getByRole("button", { name: "Add unavailable period" }).click();
  await expect(page.getByRole("status")).toContainText(
    "Saved unavailable period",
  );

  await useDemoIdentity(page, "administrator");
  await page.goto("/admin/speakers/person-demo-speaker");
  await waitForHydrated(page);
  await expect(
    page.getByRole("heading", { name: "Speaker availability" }),
  ).toBeVisible();
  await expect(page.getByText("Keep this note private")).toHaveCount(0);
  await page.getByRole("button", { name: "Remove unavailable period" }).click();
  await acceptConfirm(page);
  await expect(page.locator(".pc-status-notice")).toContainText(
    "Removed unavailable period",
  );
});
