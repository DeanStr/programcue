import { expect, type Page, test } from "@playwright/test";

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
  // Opening the public route establishes the deterministic demo publication that
  // both admin views read; production mode never executes this seed path.
  await waitForInterface(page, "/public/programme/future-of-events-2027");
});

test("public programme filters sessions by track, format and room", async ({
  page,
}) => {
  await waitForInterface(page, "/public/programme/future-of-events-2027");
  const rows = page.locator(".programme-row");
  const total = await rows.count();
  expect(total).toBe(5);
  await expect(
    page.getByText(`Showing ${total} of ${total} published sessions.`),
  ).toBeVisible();

  await page.getByLabel("Filter by track").selectOption("AI & Innovation");
  await expect(page).toHaveURL(/track=AI(?:\+|%20)%26(?:\+|%20)Innovation/u);
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".session-detail-panel h2")).toHaveText(
    "AI in Event Operations",
  );
  await expect(
    page.getByText(
      `Showing 2 of ${total} published sessions for the current filters.`,
    ),
  ).toBeVisible();

  await page.getByLabel("Filter by format").selectOption("breakout");
  await expect(rows).toHaveCount(1);
  await expect(rows.locator("h3")).toHaveText("Building Better Event Data");
  // The speaker roster follows the active session filters.
  await expect(page.locator("#speakers > .grid article")).toHaveCount(1);

  await page.getByLabel("Filter by room").selectOption("Main Stage");
  await expect(rows).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "No matching sessions" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Clear filters" }).first().click();
  await expect(rows).toHaveCount(total);
  await expect(page.getByLabel("Filter by track")).toHaveValue("");
  await expect(
    page.getByRole("button", { name: "Clear filters" }),
  ).toBeDisabled();
  await expect(page).not.toHaveURL(/track=|format=|room=/u);

  // Facet navigation carries a just-entered search atomically instead of
  // replacing it with the URL's still-debouncing value.
  const search = page.getByLabel("Search sessions, speakers, or topics");
  await search.fill("event operations");
  await page.getByLabel("Filter by track").selectOption("AI & Innovation");
  await expect(search).toHaveValue("event operations");
  await expect(page).toHaveURL(/query=event(?:\+|%20)operations/u);
  await expect(page).toHaveURL(/track=AI(?:\+|%20)%26(?:\+|%20)Innovation/u);
  await page.getByRole("button", { name: "Clear filters" }).first().click();

  // A query that matches session content keeps that session's speaker and
  // profile route available even when the profile text does not match itself.
  await search.fill("future of attendee");
  await expect(page).toHaveURL(/query=future(?:\+|%20)of(?:\+|%20)attendee/u);
  await expect(rows).toHaveCount(1);
  await expect(page.locator("#speakers > .grid article")).toHaveCount(1);
  const detailProfileLink = page
    .locator(".session-detail-panel")
    .getByRole("link", { name: "View Priya Shah’s profile" });
  await detailProfileLink.click();
  const profile = page.locator("#programme-speaker-profile");
  await expect(profile).toBeVisible();
  await expect(profile.locator(".stack a")).toHaveCount(1);
  await profile.getByRole("button", { name: "Close profile" }).click();
  await expect(detailProfileLink).toBeFocused();
});

test("public programme clears a pinned session when session filters change", async ({
  page,
}) => {
  await waitForInterface(
    page,
    "/public/programme/future-of-events-2027/sessions?session=demo-session-1",
  );
  const detailTitle = page.locator(".session-detail-panel h2");
  await expect(detailTitle).toHaveText("The Future of Attendee Engagement");

  await page.getByLabel("Filter by track").selectOption("AI & Innovation");
  await expect(page).not.toHaveURL(/session=/u);
  await expect(detailTitle).toHaveText("AI in Event Operations");
  await expect(page.locator(".programme-row")).toHaveCount(2);

  await waitForInterface(
    page,
    "/public/programme/future-of-events-2027/sessions?session=demo-session-1",
  );
  await page
    .getByLabel("Search sessions, speakers, or topics")
    .fill("event operations");
  await expect(page).not.toHaveURL(/session=/u);
  await expect(detailTitle).toHaveText("AI in Event Operations");
});

test("migrates legacy public session hash links to canonical detail URLs", async ({
  page,
}) => {
  await page.goto(
    "/public/programme/future-of-events-2027#session-future-attendee-engagement",
  );
  await page.locator("body[data-hydrated='true']").waitFor();

  await expect(page).toHaveURL(
    "/public/programme/future-of-events-2027/sessions?session=demo-session-1",
  );
  await expect(page.locator(".session-detail-panel h2")).toHaveText(
    "The Future of Attendee Engagement",
  );
});

test("clears a pinned session excluded by filters in a loaded URL", async ({
  page,
}) => {
  await waitForInterface(
    page,
    "/public/programme/future-of-events-2027/sessions?session=demo-session-1&track=AI%20%26%20Innovation",
  );

  await expect(page).not.toHaveURL(/session=/u);
  await expect(page).toHaveURL(/track=AI(?:\+|%20)%26(?:\+|%20)Innovation/u);
  await expect(page.locator(".session-detail-panel h2")).toHaveText(
    "AI in Event Operations",
  );
  await expect(page.locator(".programme-row")).toHaveCount(2);
});

test("public session detail exposes its canonical share link", async ({
  page,
}) => {
  await waitForInterface(page, "/public/programme/future-of-events-2027");
  await page
    .locator(".programme-entry")
    .filter({ hasText: "The Future of Attendee Engagement" })
    .locator(".programme-row")
    .click();

  const shareLink = page.getByRole("link", {
    name: "Shareable session link",
  });
  await expect(shareLink).toHaveAttribute(
    "href",
    "/public/programme/future-of-events-2027/sessions?session=demo-session-1",
  );
  await shareLink.click();
  await expect(page).toHaveURL(
    "/public/programme/future-of-events-2027/sessions?session=demo-session-1",
  );
  await expect(page).toHaveTitle(
    "The Future of Attendee Engagement · Future of Events 2027",
  );
});

test("public programme clears unavailable saved facets honestly", async ({
  page,
}) => {
  await waitForInterface(
    page,
    "/public/programme/future-of-events-2027?track=Retired&format=Missing&query=operations",
  );

  await expect(page).not.toHaveURL(/track=|format=/u);
  await expect(page).toHaveURL(/query=operations/u);
  await expect(
    page.getByText(
      "Saved track, format filters are no longer available and were cleared.",
    ),
  ).toBeVisible();
  await expect(page.getByLabel("Filter by track")).toHaveValue("");
  await expect(page.getByLabel("Filter by format")).toHaveValue("");
});

test("public programme exposes speaker affiliations and a closable profile panel", async ({
  page,
}) => {
  // Opening the organiser roster materialises the demo speaker's title and
  // organisation; the public surface only renders what D1 already holds.
  await waitForInterface(page, "/admin/speakers");
  await waitForInterface(page, "/public/programme/future-of-events-2027");

  // Each session-row affiliation remains attached to the matching speaker and
  // includes both title and organisation.
  await expect(page.locator(".programme-row-speaker").first()).toContainText(
    "Priya Shah — Director of Experience Design · EventLab",
  );
  await page.locator(".programme-row").first().click();
  const detail = page.locator(".session-detail-panel");
  await expect(detail).toContainText(
    "Director of Experience Design · EventLab",
  );
  await expect(detail).toContainText("Leadership");

  // The profile panel is opt-in, names the speaker's role and rooms, and
  // returns focus to the control that opened it.
  await expect(page.locator("#programme-speaker-profile")).toHaveCount(0);
  const profileLink = page.locator("#speaker-profile-link-person-demo-speaker");
  await profileLink.click();
  const profile = page.locator("#programme-speaker-profile");
  await expect(profile).toBeVisible();
  await expect(profile).toContainText("Director of Experience Design");
  await expect(profile).toBeFocused();
  await expect(profile.locator(".stack a")).toHaveCount(3);
  await expect(profile.locator(".stack a").first()).toContainText("Main Stage");

  await profile.getByRole("button", { name: "Close profile" }).click();
  await expect(page.locator("#programme-speaker-profile")).toHaveCount(0);
  await expect(profileLink).toBeFocused();

  // A direct session URL is temporarily replaced by the speaker profile URL;
  // closing the profile must restore the session that the visitor opened.
  await waitForInterface(
    page,
    "/public/programme/future-of-events-2027/sessions?session=demo-session-1",
  );
  const directSessionProfileLink = page.getByRole("link", {
    name: "View Priya Shah’s profile",
  });
  await directSessionProfileLink.click();
  await expect(page).toHaveURL(
    /\/public\/programme\/future-of-events-2027\/sessions\?speaker=person-demo-speaker(?:#.*)?$/u,
  );
  await page.getByRole("button", { name: "Close profile" }).click();
  await expect(page).toHaveURL(
    /\/public\/programme\/future-of-events-2027\/sessions\?session=demo-session-1$/u,
  );
  await expect(
    page.getByRole("heading", {
      name: "The Future of Attendee Engagement",
      exact: true,
      level: 2,
    }),
  ).toBeVisible();

  // A shared profile URL has no opener recorded in component state, so close
  // falls back to its visible speaker-card link instead of dropping focus.
  await page.goto(
    "/public/programme/future-of-events-2027?speaker=person-demo-speaker",
  );
  await page.locator("body[data-hydrated='true']").waitFor();
  await expect(profile).toBeVisible();
  await profile.getByRole("button", { name: "Close profile" }).click();
  await expect(profileLink).toBeFocused();
});

test("programme contains its wide table and explains mobile scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await waitForInterface(page, "/admin/programme");

  await expect(
    page.getByText("Swipe horizontally to see all columns"),
  ).toBeVisible();
  const tableWidth = await page
    .locator(".programme-table-wrap")
    .evaluate((element) => ({
      client: element.clientWidth,
      scroll: element.scrollWidth,
    }));
  expect(tableWidth.scroll).toBeGreaterThan(tableWidth.client);
  const documentOverflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(documentOverflow).toBeLessThanOrEqual(1);
});
