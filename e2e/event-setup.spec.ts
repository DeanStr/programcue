import { expect, type Page, test } from "@playwright/test";

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

test.afterAll(async ({ request }) => {
  await resetDemoEvent(request);
});

async function showEventSettingsPanel(
  page: Page,
  name: "Identity" | "Structure" | "Access" | "Data",
) {
  const button = page.getByRole("button", { name, exact: true });
  if ((await button.getAttribute("aria-pressed")) !== "true")
    await button.click();
  await expect(button).toHaveAttribute("aria-pressed", "true");
}

test("Event Setup saves through D1 and survives a reload", async ({ page }) => {
  await page.goto("/admin/event");
  await expect(
    page.getByRole("heading", { name: "Event settings" }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => getComputedStyle(document.documentElement).scrollBehavior,
    ),
  ).toBe("auto");

  const venue = page.getByLabel("Venue", { exact: true });
  const original = await venue.inputValue();
  const venueAddress = page.getByLabel("Venue address");
  const venueMapUrl = page.getByLabel("Venue map URL");
  const originalVenueAddress = await venueAddress.inputValue();
  const originalVenueMapUrl = await venueMapUrl.inputValue();
  try {
    await venue.fill("Beanfield Centre — persistence check");
    await venueAddress.fill("105 Princes' Boulevard, Toronto, ON");
    await venueMapUrl.fill("https://maps.example.test/beanfield-centre");
    await showEventSettingsPanel(page, "Structure");
    const save = page.getByRole("button", { name: "Save event" });
    await save.scrollIntoViewIfNeeded();
    const scrollBeforeSave = await page.evaluate(() => window.scrollY);
    await save.click();
    await expect(
      page.getByText("Event settings saved.", { exact: true }),
    ).toBeVisible();
    await expect
      .poll(async () =>
        page.evaluate(
          (before) => Math.abs(window.scrollY - before) <= 1,
          scrollBeforeSave,
        ),
      )
      .toBe(true);
    await expect(
      page.getByRole("button", { name: "Structure", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await expect
      .poll(() => new URL(page.url()).hash)
      .toBe("#event-setup-structure");
    await page.reload();
    await expect(venue).toHaveValue("Beanfield Centre — persistence check");
    await expect(venueAddress).toHaveValue(
      "105 Princes' Boulevard, Toronto, ON",
    );
    await expect(venueMapUrl).toHaveValue(
      "https://maps.example.test/beanfield-centre",
    );
    await page.goto("/public/programme/future-of-events-2027");
    await expect(
      page.getByText("105 Princes' Boulevard, Toronto, ON"),
    ).toBeVisible();
    await expect(page.getByRole("link", { name: /Open map/ })).toHaveAttribute(
      "href",
      "https://maps.example.test/beanfield-centre",
    );
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
    await page.getByLabel("Venue", { exact: true }).fill(original);
    await page.getByLabel("Venue address").fill(originalVenueAddress);
    await page.getByLabel("Venue map URL").fill(originalVenueMapUrl);
    await page.getByRole("button", { name: "Save event" }).click();
    await expect(
      page.getByText("Event settings saved.", { exact: true }),
    ).toBeVisible();
  }
});

test("Event Setup rejects an invalid date range before persistence", async ({
  page,
}) => {
  await page.goto("/admin/event");
  await page.locator("body[data-hydrated='true']").waitFor();
  await page.getByLabel("End date").fill("2025-05-19");
  await showEventSettingsPanel(page, "Structure");
  await page.getByRole("button", { name: "Save event" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "End date cannot be before the start date",
  );
  await expect
    .poll(() => new URL(page.url()).hash)
    .toBe("#event-setup-identity");
});

test("Event Setup error-summary links reveal their hidden panel", async ({
  page,
}) => {
  await page.goto("/admin/event");
  await page.locator("body[data-hydrated='true']").waitFor();
  const eventName = page.getByLabel("Event name");
  await eventName.fill("   ");
  await showEventSettingsPanel(page, "Structure");
  await page.getByRole("button", { name: "Save event" }).click();

  const nameError = page.getByRole("link", {
    name: "Event name is required.",
  });
  await expect(nameError).toBeVisible();
  await expect
    .poll(() => new URL(page.url()).hash)
    .toBe("#event-setup-identity");

  await showEventSettingsPanel(page, "Structure");
  await nameError.click();
  await expect(
    page.getByRole("button", { name: "Identity", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(eventName).toBeFocused();
  await expect
    .poll(() => new URL(page.url()).hash)
    .toBe("#event-setup-identity");
});

test("Event Setup shows only the latest response across panel changes", async ({
  page,
}) => {
  await page.goto("/admin/event");
  await page.locator("body[data-hydrated='true']").waitFor();
  const eventName = page.getByLabel("Event name");
  const originalName = await eventName.inputValue();
  await eventName.fill("   ");
  await showEventSettingsPanel(page, "Structure");
  await page.getByRole("button", { name: "Save event" }).click();

  const retainedError = page.getByRole("link", {
    name: "Event name is required.",
  });
  await expect(retainedError).toBeVisible();

  await page.reload();
  await page.locator("body[data-hydrated='true']").waitFor();
  await expect(eventName).toHaveValue(originalName);
  await expect(retainedError).toHaveCount(0);

  await eventName.fill("   ");
  await showEventSettingsPanel(page, "Structure");
  await page.getByRole("button", { name: "Save event" }).click();
  await expect(retainedError).toBeVisible();

  await eventName.fill(originalName);
  await page.getByRole("button", { name: "Save event" }).click();
  const savedMessage = page.getByText("Event settings saved.", { exact: true });
  await expect(savedMessage).toBeVisible();
  await expect(retainedError).toHaveCount(0);

  await showEventSettingsPanel(page, "Data");
  await expect(savedMessage).toBeVisible();
  await expect(retainedError).toHaveCount(0);
  await page.reload();
  await page.locator("body[data-hydrated='true']").waitFor();
  await expect(savedMessage).toHaveCount(0);
  await expect(retainedError).toHaveCount(0);
});

test("Event Setup clears validation after leaving the route", async ({
  page,
}) => {
  await page.goto("/admin/event");
  await page.locator("body[data-hydrated='true']").waitFor();
  const eventName = page.getByLabel("Event name");
  const originalName = await eventName.inputValue();
  await eventName.fill("   ");
  await page.getByRole("button", { name: "Save event" }).click();

  const retainedError = page.getByRole("link", {
    name: "Event name is required.",
  });
  await expect(retainedError).toBeVisible();
  await page.getByRole("link", { name: "Applications", exact: true }).click();
  const warning = page.getByRole("dialog", { name: "Leave without saving?" });
  await warning.getByRole("button", { name: "Leave and discard" }).click();
  await expect(page).toHaveURL(/\/admin\/submissions/);

  await page
    .getByRole("link", { name: "Event settings", exact: true })
    .click();
  await expect(page).toHaveURL(/\/admin\/event/);
  await page.locator("body[data-hydrated='true']").waitFor();
  await expect(eventName).toHaveValue(originalName);
  await expect(retainedError).toHaveCount(0);
});

test("a non-validation save failure replaces earlier validation errors", async ({
  context,
  page,
}) => {
  await page.goto("/admin/event");
  await page.locator("body[data-hydrated='true']").waitFor();
  const eventName = page.getByLabel("Event name");
  const originalName = await eventName.inputValue();
  await eventName.fill("   ");
  await showEventSettingsPanel(page, "Structure");
  await page.getByRole("button", { name: "Save event" }).click();

  const retainedError = page.getByRole("link", {
    name: "Event name is required.",
  });
  await expect(retainedError).toBeVisible();

  const concurrentPage = await context.newPage();
  await concurrentPage.goto("/admin/event");
  await concurrentPage.locator("body[data-hydrated='true']").waitFor();
  const venue = concurrentPage.getByLabel("Venue", { exact: true });
  await venue.fill(`${await venue.inputValue()} conflict check`);
  await concurrentPage.getByRole("button", { name: "Save event" }).click();
  await expect(
    concurrentPage.getByText("Event settings saved.", { exact: true }),
  ).toBeVisible();
  await concurrentPage.close();

  await eventName.fill(originalName);
  await page.getByRole("button", { name: "Save event" }).click();
  const conflict = page.getByText(
    "This event changed after the page loaded. Refresh and review the latest values before saving.",
    { exact: true },
  );
  await expect(conflict).toBeVisible();
  await expect(retainedError).toHaveCount(0);

  await showEventSettingsPanel(page, "Data");
  await expect(conflict).toBeVisible();
  await expect(retainedError).toHaveCount(0);
});

test("Event Setup reveals a hidden panel before focusing an invalid field", async ({
  page,
}) => {
  await page.goto("/admin/event");
  await page.locator("body[data-hydrated='true']").waitFor();
  const eventName = page.getByLabel("Event name");
  await eventName.fill("");
  await showEventSettingsPanel(page, "Structure");

  await page.getByRole("button", { name: "Save event" }).click();

  await expect(
    page.getByRole("button", { name: "Identity", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect
    .poll(() => new URL(page.url()).hash)
    .toBe("#event-setup-identity");
  await expect(eventName).toBeFocused();
  expect(
    await eventName.evaluate(
      (input) => (input as HTMLInputElement).validity.valid,
    ),
  ).toBe(false);
});

test("Event Setup sticky controls account for the evaluation banner", async ({
  page,
}) => {
  await page.goto("/admin/event");
  await page.locator("body[data-hydrated='true']").waitFor();
  const toolbar = page.locator(".event-setup-workspace-toolbar");
  const baselineTop = await toolbar.evaluate((element) =>
    Number.parseFloat(getComputedStyle(element).top),
  );

  await page.evaluate(() =>
    document.documentElement.style.setProperty("--eval-banner-offset", "37px"),
  );

  await expect
    .poll(() =>
      toolbar.evaluate((element) =>
        Number.parseFloat(getComputedStyle(element).top),
      ),
    )
    .toBe(baselineTop + 37);
});

test("Event Setup keeps save controls in reach on narrow screens", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto("/admin/event#event-setup-identity");
  await page.locator("body[data-hydrated='true']").waitFor();

  const desktopActions = page
    .locator(".event-setup-workspace-toolbar")
    .locator(".event-setup-actions");
  const mobileActions = page.locator(".event-setup-mobile-actions");
  await expect(desktopActions).toBeHidden();
  await expect(mobileActions).toBeVisible();
  await expect
    .poll(() =>
      mobileActions.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          position: getComputedStyle(element).position,
          bottomGap: Math.round(window.innerHeight - bounds.bottom),
        };
      }),
    )
    .toEqual({ position: "fixed", bottomGap: 0 });

  const description = page.getByLabel("Programme description");
  const original = await description.inputValue();
  const changed = `${original}\nMobile commit bar check`;
  try {
    await description.fill(changed);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
    await expect(
      mobileActions.getByText("1 unsaved", { exact: true }),
    ).toBeVisible();
    await mobileActions
      .getByRole("button", { name: "Save", exact: true })
      .click();
    await expect(
      page.getByText("Event settings saved.", { exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(description).toHaveValue(changed);
  } finally {
    await description.fill(original);
    await mobileActions
      .getByRole("button", { name: "Save", exact: true })
      .click();
    await expect(
      page.getByText("Event settings saved.", { exact: true }),
    ).toBeVisible();
  }
});

test("Event Setup panel links clear the sticky toolbar", async ({ page }) => {
  for (const width of [1280, 780]) {
    await page.setViewportSize({ width, height: 720 });
    for (const panel of ["identity", "access"] as const) {
      await page.goto(`/admin/event#event-setup-${panel}`);
      await page.locator("body[data-hydrated='true']").waitFor();
      const heading = page.locator(`#event-setup-${panel}-title`);
      const toolbar = page.locator(".event-setup-workspace-toolbar");

      await expect(heading).toBeVisible();
      await expect
        .poll(async () => {
          const headingBox = await heading.boundingBox();
          const toolbarBox = await toolbar.boundingBox();
          return Boolean(
            headingBox &&
              toolbarBox &&
              headingBox.y >= toolbarBox.y + toolbarBox.height,
          );
        })
        .toBe(true);
    }
  }

  await page.setViewportSize({ width: 861, height: 720 });
  await page.goto("/admin/event#event-setup-identity");
  await page.locator("body[data-hydrated='true']").waitFor();
  const venue = page.getByLabel("Venue", { exact: true });
  await venue.fill(`${await venue.inputValue()} unsaved`);
  await showEventSettingsPanel(page, "Access");
  const heading = page.locator("#event-setup-access-title");
  const toolbar = page.locator(".event-setup-workspace-toolbar");
  await expect
    .poll(async () => {
      const headingBox = await heading.boundingBox();
      const toolbarBox = await toolbar.boundingBox();
      return Boolean(
        headingBox &&
          toolbarBox &&
          headingBox.y >= toolbarBox.y + toolbarBox.height,
      );
    })
    .toBe(true);
});

test("Event Setup panel navigation stays synchronized with the admin shell", async ({
  page,
}) => {
  await page.goto("/admin/event");
  await page.locator("body[data-hydrated='true']").waitFor();
  await showEventSettingsPanel(page, "Data");

  await page.getByRole("button", { name: "Switch event" }).click();
  const dialog = page.getByRole("dialog", { name: "Current event" });
  await expect(dialog.locator('input[name="returnTo"]').first()).toHaveValue(
    "/admin/event#event-setup-data",
  );
  await dialog.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: /Search or run a command/ }).click();
  await page
    .getByRole("combobox", { name: "Program Cue commands" })
    .fill("Event settings");
  await page.getByRole("option", { name: /^Event settings\b/ }).click();
  await expect(page).toHaveURL(/\/admin\/event$/);
  await expect(
    page.getByRole("button", { name: "Identity", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("Event Setup opens Rooms by default without expanding every Structure editor", async ({
  page,
}) => {
  await page.goto("/admin/event#event-setup-structure");
  await page.locator("body[data-hydrated='true']").waitFor();

  const recordPanel = (heading: string) =>
    page.locator("details.event-record-panel").filter({
      has: page.getByRole("heading", { name: heading, exact: true }),
    });

  await expect(recordPanel("Rooms and capacities")).toHaveAttribute("open", "");
  await expect(recordPanel("Programme tracks")).not.toHaveAttribute("open", "");
  await expect(
    recordPanel("Session formats and durations"),
  ).not.toHaveAttribute("open", "");

  await recordPanel("Rooms and capacities").locator("summary").click();
  await expect(recordPanel("Rooms and capacities")).not.toHaveAttribute(
    "open",
    "",
  );
  await showEventSettingsPanel(page, "Identity");
  await showEventSettingsPanel(page, "Structure");
  await expect(recordPanel("Rooms and capacities")).not.toHaveAttribute(
    "open",
    "",
  );
});

test("Event Setup opens a collapsed record before focusing an invalid field", async ({
  page,
}) => {
  await page.goto("/admin/event");
  await page.locator("body[data-hydrated='true']").waitFor();
  await showEventSettingsPanel(page, "Structure");
  await openRecordPanel(page, "Rooms and capacities");

  const roomPanel = page.locator("details.event-record-panel").filter({
    has: page.getByRole("heading", {
      name: "Rooms and capacities",
      exact: true,
    }),
  });
  const capacity = roomPanel.locator('input[type="number"]').first();
  await capacity.fill("0");
  await roomPanel.locator("summary").click();
  await showEventSettingsPanel(page, "Identity");

  await page.getByRole("button", { name: "Save event" }).click();

  await expect(
    page.getByRole("button", { name: "Structure", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(roomPanel).toHaveAttribute("open", "");
  await expect(capacity).toBeFocused();
  expect(
    await capacity.evaluate(
      (input) => (input as HTMLInputElement).validity.valid,
    ),
  ).toBe(false);

  await capacity.fill("1");
  await roomPanel.locator("summary").click();
  await expect(roomPanel).not.toHaveAttribute("open", "");
  await showEventSettingsPanel(page, "Identity");
  const venue = page.getByLabel("Venue", { exact: true });
  const originalVenue = await venue.inputValue();
  await venue.fill(`${originalVenue} corrected`);
  await venue.fill(originalVenue);
  await showEventSettingsPanel(page, "Structure");
  await expect(roomPanel).not.toHaveAttribute("open", "");
});

test("Event Setup rejects attempts to change Branding-owned fields", async ({
  page,
}) => {
  await page.goto("/admin/event");
  await page.locator("body[data-hydrated='true']").waitFor();
  const venue = page.getByLabel("Venue", { exact: true });
  const originalVenue = await venue.inputValue();
  await venue.fill("This venue must not persist");
  // Dirty-state tracking re-renders the form after the venue input. Tamper
  // and submit in one turn so React cannot restore the published accent first.
  await page
    .locator("form")
    .filter({ has: page.locator('input[name="brandAccent"]') })
    .evaluate((form) => {
      if (!(form instanceof HTMLFormElement)) {
        throw new Error("Event Setup did not render a form.");
      }
      const input = form.querySelector('input[name="brandAccent"]');
      if (!(input instanceof HTMLInputElement)) {
        throw new Error("Event Setup is missing the published accent field.");
      }
      input.value = "#000000";
      form.requestSubmit();
    });
  await expect(page.getByRole("alert")).toContainText(
    "use the Branding workspace",
  );
  await page.reload();
  await expect(venue).toHaveValue(originalVenue);
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

  await expect(
    page.getByRole("alert", { name: "There is a problem" }),
  ).toBeVisible();
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

  await page.getByRole("link", { name: "Applications", exact: true }).click();
  const warning = page.getByRole("dialog", { name: "Leave without saving?" });
  await expect(warning).toBeVisible();
  await warning.getByRole("button", { name: "Stay on this page" }).click();
  await expect(warning).toBeHidden();
  await expect(page).toHaveURL(/\/admin\/event(?:#event-setup-structure)?$/);
  await expect(draft).toHaveValue("Draft that still needs adding");

  await draft.fill("");
  await expect(save).toBeEnabled();
});

test("repository workflows remain blocked until exact Event Setup edits are saved or discarded", async ({
  page,
}) => {
  await page.goto("/admin/event");
  await openRecordPanel(page, "Programme tracks");

  await showEventSettingsPanel(page, "Identity");
  const venue = page.getByLabel("Venue", { exact: true });
  const originalVenue = await venue.inputValue();
  await showEventSettingsPanel(page, "Structure");
  const trackName = page.getByLabel("Leadership track name");
  const originalTrackName = await trackName.inputValue();
  await showEventSettingsPanel(page, "Data");
  const configure = page.getByRole("button", {
    name: /Configure|Revalidate/,
  });

  await showEventSettingsPanel(page, "Identity");
  await venue.fill(`${originalVenue} — unsaved`);
  await showEventSettingsPanel(page, "Structure");
  await trackName.fill(`${originalTrackName} unsaved`);

  await showEventSettingsPanel(page, "Data");
  await expect(configure).toBeDisabled();
  await expect(
    page.getByText(
      "Save or discard your Event settings edits before changing where event data is held.",
    ),
  ).toBeVisible();

  await showEventSettingsPanel(page, "Identity");
  await venue.fill(originalVenue);
  await showEventSettingsPanel(page, "Structure");
  await page
    .getByLabel(`${originalTrackName} unsaved track name`)
    .fill(originalTrackName);

  await showEventSettingsPanel(page, "Data");
  await expect(configure).toBeEnabled();
  await expect(
    page.getByText(
      "Save or discard your Event settings edits before changing where event data is held.",
    ),
  ).toBeHidden();

  await showEventSettingsPanel(page, "Identity");
  const city = page.getByLabel("City", { exact: true });
  const originalCity = await city.inputValue();
  await city.fill("Unsaved city");
  await showEventSettingsPanel(page, "Data");
  await expect(configure).toBeDisabled();
  await page.getByRole("button", { name: "Discard changes" }).click();
  await showEventSettingsPanel(page, "Identity");
  await expect(city).toHaveValue(originalCity);
  await showEventSettingsPanel(page, "Data");
  await expect(configure).toBeEnabled();

  await page.getByRole("link", { name: "Applications", exact: true }).click();
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
  await expect(page.getByLabel(`${buttonTrack} track settings`)).toBeVisible();

  await page.getByRole("button", { name: "Save event" }).click();
  await expect(
    page.getByText("Event settings saved.", { exact: true }),
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
  await expect(page.getByLabel(`${buttonTrack} track settings`)).toBeVisible();

  const keyboardTrackPanel = page.getByLabel(`${keyboardTrack} track settings`);
  const panelId = await keyboardTrackPanel.getAttribute("id");
  if (!panelId?.startsWith("event-track-"))
    throw new Error("The created track is missing its stable focus target.");
  const trackId = panelId.slice("event-track-".length);
  await page.goto(`/admin/event?track=${encodeURIComponent(trackId)}`);
  await expect(page.locator(`#${panelId}`)).toBeFocused();
  await page.getByRole("button", { name: `Remove ${keyboardTrack}` }).click();
  await expect(page).toHaveURL(/\/admin\/event#event-setup-structure$/);
  await expect(
    page.getByRole("button", { name: "Structure", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(`#${panelId}`)).toHaveCount(0);
  await page.getByRole("button", { name: "Save event" }).click();
  await expect(
    page.getByText("Event settings saved.", { exact: true }),
  ).toBeVisible();
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
    .fill("Home");
  await page.getByRole("option", { name: /^Home\b/ }).click();
  await expect(page).toHaveURL(/\/admin\/command$/);
  await expect(
    page.getByRole("heading", { name: "Command Centre" }),
  ).toBeVisible();
});

test("the command palette offers the public product guide without leaving the workspace", async ({
  page,
}) => {
  await page.goto("/admin/event");
  await page.locator("body[data-hydrated='true']").waitFor();
  await page.getByRole("button", { name: /Search or run a command/ }).click();
  await page
    .getByRole("combobox", { name: "Program Cue commands" })
    .fill("product guide");
  await expect(
    page.getByRole("option", { name: /Product guide/ }),
  ).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/event$/);
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

  await page.getByRole("button", { name: "Save event" }).click();
  await expect(
    page.getByText("Event settings saved.", { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(
    /\/admin\/event\?room=main#event-setup-structure$/,
  );
  await expect(page.locator("#event-room-main")).toBeVisible();
});
