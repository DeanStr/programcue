import { expect, test } from "@playwright/test";

test.beforeEach(async ({ context }) => {
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
});

test("Event Setup saves through D1 and survives a reload", async ({ page }) => {
  await page.goto("/admin/event");
  await expect(
    page.getByRole("heading", { name: "Event Setup" }),
  ).toBeVisible();

  const venue = page.getByLabel("Venue");
  const original = await venue.inputValue();
  try {
    await venue.fill("Beanfield Centre — persistence check");
    await page.getByRole("button", { name: "Save event" }).click();
    await expect(
      page.getByText("Event settings saved to D1.", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(venue).toHaveValue("Beanfield Centre — persistence check");
  } finally {
    await page.getByLabel("Venue").fill(original);
    await page.getByRole("button", { name: "Save event" }).click();
    await expect(
      page.getByText("Event settings saved to D1.", { exact: true }),
    ).toBeVisible();
  }
});

test("Event Setup rejects an invalid date range before persistence", async ({
  page,
}) => {
  await page.goto("/admin/event");
  await page.getByLabel("End date").fill("2025-05-19");
  await page.getByRole("button", { name: "Save event" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "End date cannot be before the start date",
  );
});

test("the command palette uses path-based React Router navigation", async ({
  page,
}) => {
  await page.goto("/admin/event");
  await page.locator("body[data-hydrated='true']").waitFor();
  await page.getByRole("button", { name: /Search or run a command/ }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page
    .getByRole("combobox", { name: "Program Cue commands" })
    .fill("Command Centre");
  await page.getByRole("option", { name: /Command Centre/ }).click();
  await expect(page).toHaveURL(/\/admin\/command$/);
  await expect(
    page.getByRole("heading", { name: "Command Centre" }),
  ).toBeVisible();
});
