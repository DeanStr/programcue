import { expect, test } from "@playwright/test";

import { openRecordPanel } from "./support/open-record-panel";
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
  await page.route("https://branding.example.test/event.svg", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="#4f46e5"/></svg>',
    }),
  );
  await page.goto("/admin/event");
  await expect(
    page.getByRole("heading", { name: "Event Setup" }),
  ).toBeVisible();

  const venue = page.getByLabel("Venue");
  const original = await venue.inputValue();
  const logo = page.getByLabel("Participant logo URL");
  const welcome = page.getByLabel("Participant welcome message");
  const support = page.getByLabel("Participant support URL");
  const originalLogo = await logo.inputValue();
  const originalWelcome = await welcome.inputValue();
  const originalSupport = await support.inputValue();
  try {
    await venue.fill("Beanfield Centre — persistence check");
    await logo.fill("https://branding.example.test/event.svg");
    await welcome.fill(
      "Welcome to the browser-verified participant workspace.",
    );
    await support.fill("https://support.example.test/participants");
    await page.getByRole("button", { name: "Save event" }).click();
    await expect(
      page.getByText("Event settings saved to D1.", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(venue).toHaveValue("Beanfield Centre — persistence check");
    await expect(logo).toHaveValue("https://branding.example.test/event.svg");
    await expect(welcome).toHaveValue(
      "Welcome to the browser-verified participant workspace.",
    );

    await page.goto("/apply/form");
    await expect(
      page.getByText("Welcome to the browser-verified participant workspace."),
    ).toBeVisible();

    await page.context().addCookies([
      {
        name: "program_cue_demo_identity",
        value: "speaker",
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await page.goto("/participant/dashboard");
    await expect(
      page.getByText("Welcome to the browser-verified participant workspace."),
    ).toBeVisible();
    await expect(
      page.getByAltText("Future of Events 2027 logo"),
    ).toHaveAttribute("src", "https://branding.example.test/event.svg");
    await expect(
      page.getByRole("link", { name: "Participant support" }),
    ).toHaveAttribute("href", "https://support.example.test/participants");
  } finally {
    await page.context().addCookies([
      {
        name: "program_cue_demo_identity",
        value: "administrator",
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      },
    ]);
    await page.goto("/admin/event");
    await page.getByLabel("Venue").fill(original);
    await page.getByLabel("Participant logo URL").fill(originalLogo);
    await page.getByLabel("Participant welcome message").fill(originalWelcome);
    await page.getByLabel("Participant support URL").fill(originalSupport);
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

test("programme validation opens the affected disclosure and retains record context", async ({
  page,
}) => {
  await page.goto("/admin/event");
  await openRecordPanel(page, "Programme tracks");

  const trackPanel = page.locator("details.event-record-panel").filter({
    has: page.getByRole("heading", {
      name: "Programme tracks",
      exact: true,
    }),
  });
  await expect(
    page.getByRole("group", { name: "Leadership track settings" }),
  ).toBeVisible();
  await expect(page.getByLabel("Leadership colour")).toBeVisible();
  await expect(page.getByLabel("Leadership exclusive")).toBeVisible();

  await page.getByLabel("Leadership track name").fill("");
  await trackPanel.locator("summary").click();
  await expect(trackPanel).not.toHaveAttribute("open", "");
  await page.getByRole("button", { name: "Save event" }).click();

  await expect(page.getByRole("alert")).toBeVisible();
  await expect(trackPanel).toHaveAttribute("open", "");
  await expect(trackPanel.locator(".help").last()).toBeVisible();
});

test("uncommitted record drafts block save and remain protected during navigation", async ({
  page,
}) => {
  await page.goto("/admin/event");
  await openRecordPanel(page, "Programme tracks");
  const draft = page.getByLabel("New track");
  await draft.fill("Draft that still needs adding");

  const save = page.getByRole("button", { name: "Save event" });
  await expect(save).toBeDisabled();
  await expect(
    page.getByText(/Add or clear the unfinished room/),
  ).toBeVisible();

  await page.getByRole("link", { name: "Submissions", exact: true }).click();
  const warning = page.getByRole("dialog", { name: "Leave without saving?" });
  await expect(warning).toBeVisible();
  await warning.getByRole("button", { name: "Stay on this page" }).click();
  await expect(warning).toBeHidden();
  await expect(page).toHaveURL(/\/admin\/event$/);
  await expect(draft).toHaveValue("Draft that still needs adding");

  await draft.fill("");
  await expect(save).toBeEnabled();
});

test("repository workflows remain blocked until exact Event Setup edits are saved or discarded", async ({
  page,
}) => {
  await page.goto("/admin/event");
  await openRecordPanel(page, "Programme tracks");

  const venue = page.getByLabel("Venue");
  const originalVenue = await venue.inputValue();
  const trackName = page.getByLabel("Leadership track name");
  const originalTrackName = await trackName.inputValue();
  const configure = page.getByRole("button", {
    name: /Configure|Revalidate/,
  });

  await venue.fill(`${originalVenue} — unsaved`);
  await trackName.fill(`${originalTrackName} unsaved`);

  await expect(configure).toBeDisabled();
  await expect(
    page.getByText(
      "Save or discard the current Event Setup edits before changing repository authority.",
    ),
  ).toBeVisible();

  await venue.fill(originalVenue);
  await page
    .getByLabel(`${originalTrackName} unsaved track name`)
    .fill(originalTrackName);

  await expect(configure).toBeEnabled();
  await expect(
    page.getByText(
      "Save or discard the current Event Setup edits before changing repository authority.",
    ),
  ).toBeHidden();

  await page.getByRole("link", { name: "Submissions", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "Leave without saving?" }),
  ).toBeHidden();
  await expect(page).toHaveURL(/\/admin\/submissions/);
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
    await openRecordPanel(page, "Programme tracks");

    const newTrack = page.getByLabel("New track");
    await newTrack.fill(keyboardTrack);
    await newTrack.press("Enter");
    await expect(
      page.getByLabel(`${keyboardTrack} track settings`),
    ).toBeVisible();

    await newTrack.fill(buttonTrack);
    await page.getByRole("button", { name: "Add track", exact: true }).click();
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
    await openRecordPanel(page, "Programme tracks");
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
