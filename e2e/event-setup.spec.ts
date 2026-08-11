import { expect, test } from "@playwright/test";

import { resetDemoEvent } from "./support/reset-demo-event";

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

test("tracks added by keyboard and button survive reload and reach the schedule builder", async ({
  page,
  request,
}) => {
  const keyboardTrack = "Keyboard-created track";
  const buttonTrack = "Button-created track";
  await resetDemoEvent(request);

  try {
    await page.goto("/admin/event");
    await page.locator("body[data-hydrated='true']").waitFor();

    const newTrack = page.getByLabel("New track");
    await newTrack.fill(keyboardTrack);
    await newTrack.press("Enter");
    await expect(
      page.getByLabel(`${keyboardTrack} track settings`),
    ).toBeVisible();

    await newTrack.fill(buttonTrack);
    await page
      .getByRole("button", { name: "Add track", exact: true })
      .click();
    await expect(
      page.getByLabel(`${buttonTrack} track settings`),
    ).toBeVisible();

    await page.getByRole("button", { name: "Save event" }).click();
    await expect(
      page.getByText("Event settings saved to D1.", { exact: true }),
    ).toBeVisible();

    await page.goto("/admin/schedule?session=demo-session-1");
    await page.locator("body[data-hydrated='true']").waitFor();
    const trackSelect = page
      .getByTestId("session-content-editor")
      .getByLabel("Track");
    await expect(
      trackSelect.getByRole("option", { name: keyboardTrack, exact: true }),
    ).toHaveCount(1);
    await expect(
      trackSelect.getByRole("option", { name: buttonTrack, exact: true }),
    ).toHaveCount(1);

    await page.goto("/admin/event");
    await page.reload();
    await expect(
      page.getByLabel(`${keyboardTrack} track settings`),
    ).toBeVisible();
    await expect(
      page.getByLabel(`${buttonTrack} track settings`),
    ).toBeVisible();

    const keyboardTrackPanel = page.getByLabel(
      `${keyboardTrack} track settings`,
    );
    const panelId = await keyboardTrackPanel.getAttribute("id");
    if (!panelId?.startsWith("event-track-"))
      throw new Error("The created track is missing its stable focus target.");
    const trackId = panelId.slice("event-track-".length);
    await page.goto(`/admin/event?track=${encodeURIComponent(trackId)}`);
    await expect(page.locator(`#${panelId}`)).toBeFocused();
    await page.getByRole("button", { name: `Remove ${keyboardTrack}` }).click();
    await expect(page).toHaveURL(/\/admin\/event$/);
    await page.getByRole("button", { name: "Save event" }).click();
    await expect(
      page.getByText("Event settings saved to D1.", { exact: true }),
    ).toBeVisible();
  } finally {
    await resetDemoEvent(request);
  }
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

test("the command palette resolves a room alias to the exact Event Setup record", async ({
  page,
}) => {
  await page.goto("/admin/command");
  await page.locator("body[data-hydrated='true']").waitFor();
  await page.getByRole("button", { name: /Search or run a command/ }).click();
  await page
    .getByRole("combobox", { name: "Program Cue commands" })
    .fill("venue main stage");
  const room = page.getByRole("option", { name: /Main Stage.*room/i });
  await expect(room).toBeVisible();
  await room.click();

  await expect(page).toHaveURL(/\/admin\/event\?room=main$/);
  await expect(page.locator("#event-room-main")).toBeFocused();
});
