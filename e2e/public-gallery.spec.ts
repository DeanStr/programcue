import { expect, type Page, test } from "@playwright/test";

import { e2eOrigin } from "./support/e2e-origin";
import { resetDemoEvent } from "./support/reset-demo-event";

test.use({ storageState: { cookies: [], origins: [] } });

async function openAnonymous(page: Page, path: string) {
  const response = await page.goto(path);
  expect(response?.ok(), `${path} should be public`).toBe(true);
  await page.locator("body[data-hydrated='true']").waitFor();
  expect(page.url()).not.toContain("/sign-in");
}

test.beforeEach(async ({ playwright }) => {
  const request = await playwright.request.newContext({
    baseURL: e2eOrigin,
    extraHTTPHeaders: { origin: e2eOrigin },
    storageState: {
      cookies: [
        {
          name: "program_cue_demo_identity",
          value: "administrator",
          domain: "127.0.0.1",
          path: "/",
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: "Lax",
        },
      ],
      origins: [],
    },
  });
  try {
    await resetDemoEvent(request);
  } finally {
    await request.dispose();
  }
});

test("anonymous visitors can use all programme surfaces and the gallery detail", async ({
  page,
}) => {
  await page.context().clearCookies();

  await openAnonymous(page, "/public/programme/future-of-events-2027");
  await expect(page.locator(".public-nav a")).toHaveText([
    "Event home",
    "Programme",
    "Speakers",
    "Schedule",
    "Speaker Gallery",
    "About",
    "FAQ",
    "Venue",
    "Code of conduct",
    "Sponsors",
  ]);
  const eventNavigation = page
    .getByRole("navigation", { name: "Event navigation" })
    .first();
  await expect(
    eventNavigation.getByRole("link", { name: "Event home" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    eventNavigation.getByRole("link", { name: "Programme" }),
  ).not.toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("navigation", { name: "Programme views" }),
  ).toHaveCount(0);
  await expect(page.locator(".programme-row")).toHaveCount(5);

  await eventNavigation.getByRole("link", { name: "Programme" }).click();
  await expect(page).toHaveURL(
    /\/public\/programme\/future-of-events-2027\/sessions$/u,
  );
  await expect(
    eventNavigation.getByRole("link", { name: "Event home" }),
  ).not.toHaveAttribute("aria-current", "page");
  await expect(
    eventNavigation.getByRole("link", { name: "Programme" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    page.getByRole("navigation", { name: "Schedule views" }),
  ).toHaveCount(0);
  await eventNavigation.getByLabel("Browse programme and event pages").click();
  await eventNavigation.getByRole("link", { name: "Schedule" }).click();
  await expect(page).toHaveURL(
    /\/public\/programme\/future-of-events-2027\/schedule$/u,
  );
  const scheduleViews = page.getByRole("navigation", {
    name: "Schedule views",
  });
  await expect(scheduleViews.locator(".public-view-full")).toHaveText([
    "Timetable",
    "Day-by-day",
  ]);
  await expect(
    scheduleViews.getByRole("link", { name: "Day-by-day" }),
  ).toHaveAttribute("aria-current", "page");
  await scheduleViews.getByRole("link", { name: "Timetable" }).click();
  await expect(page).toHaveURL(
    /\/public\/programme\/future-of-events-2027\/timetable$/u,
  );
  await expect(
    scheduleViews.getByRole("link", { name: "Timetable" }),
  ).toHaveAttribute("aria-current", "page");
  await eventNavigation.getByLabel("Browse, current page Schedule").click();
  const currentScheduleLink = eventNavigation.getByRole("link", {
    name: "Schedule",
  });
  await expect(currentScheduleLink).toHaveAttribute("aria-current", "page");
  await expect(currentScheduleLink).toHaveAttribute(
    "href",
    "/public/programme/future-of-events-2027/timetable",
  );
  await eventNavigation.getByRole("link", { name: "Programme" }).click();
  await expect(page).toHaveURL(
    /\/public\/programme\/future-of-events-2027\/sessions$/u,
  );
  await expect(
    eventNavigation.getByRole("link", { name: "Programme" }),
  ).toHaveAttribute("aria-current", "page");
  await page
    .locator(".programme-entry")
    .filter({ hasText: "AI in Event Operations" })
    .locator(".programme-row")
    .click();
  await expect(page).toHaveURL(
    /\/public\/programme\/future-of-events-2027\/sessions\?session=demo-session-2$/u,
  );
  await expect(
    page.locator(".session-detail-panel h2", {
      hasText: "AI in Event Operations",
    }),
  ).toBeVisible();
  const showMore = page
    .getByRole("button", {
      name: /Show more of the The Future of Attendee Engagement description/,
    })
    .first();
  await showMore.click();
  await expect(
    page.getByRole("button", {
      name: /Show less of the The Future of Attendee Engagement description/,
    }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: /Show less of the The Future of Attendee Engagement description/,
    })
    .click();
  await expect(showMore).toBeVisible();

  await openAnonymous(page, "/public/programme/future-of-events-2027/speakers");
  await expect(
    page
      .getByRole("navigation", { name: "Speaker views" })
      .locator(".public-view-full"),
  ).toHaveText(["Directory", "Gallery"]);
  await expect(
    page.getByRole("heading", { name: "Speakers", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Alex Morgan", { exact: true })).toBeVisible();
  await expect(page.getByText("Priya Shah", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Search speakers by name")).toHaveCount(0);

  const retiredAgenda = await page.request.get(
    "/public/programme/future-of-events-2027/agenda?query=AI+operations",
    { maxRedirects: 0 },
  );
  expect(retiredAgenda.status()).toBe(308);
  expect(retiredAgenda.headers().location).toBe(
    "/public/programme/future-of-events-2027/schedule?query=AI+operations",
  );
  await openAnonymous(page, "/public/programme/future-of-events-2027/agenda");
  await expect(page).toHaveURL(
    /\/public\/programme\/future-of-events-2027\/schedule$/u,
  );

  await openAnonymous(page, "/public/programme/future-of-events-2027/schedule");
  await expect(
    page.getByRole("heading", { name: "Day-by-day schedule", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".public-itinerary-card")).toHaveCount(3);
  await expect(page.locator(".public-itinerary-card").first()).toContainText(
    "Director of Experience Design",
  );
  await expect(
    page.getByRole("button", {
      name: "Save The Future of Attendee Engagement to my itinerary",
    }),
  ).toBeVisible();

  await openAnonymous(
    page,
    "/public/programme/future-of-events-2027/timetable",
  );
  await expect(
    page.getByRole("heading", { name: "Timetable", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".public-timetable-session")).toHaveCount(3);
  await expect(page.locator(".public-timetable-room")).toHaveCount(3);
  const dayButtons = page
    .getByRole("group", { name: "Timetable days" })
    .getByRole("button");
  await expect(dayButtons).toHaveCount(2);
  await dayButtons.first().focus();
  await dayButtons.first().press("ArrowRight");
  await expect(dayButtons.nth(1)).toBeFocused();
  await expect(dayButtons.nth(1)).toHaveAttribute("aria-pressed", "true");
  await dayButtons.nth(1).press("Home");
  await expect(dayButtons.first()).toBeFocused();
  await expect(dayButtons.first()).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/day=Thursday%2C\+May\+20/u);
  await scheduleViews.getByRole("link", { name: "Day-by-day" }).click();
  await expect(page).toHaveURL(
    /\/public\/programme\/future-of-events-2027\/schedule\?day=Thursday%2C\+May\+20$/u,
  );
  await expect(page.locator(".public-itinerary-card")).toHaveCount(3);
  await scheduleViews.getByRole("link", { name: "Timetable" }).click();
  await expect(page).toHaveURL(
    /\/public\/programme\/future-of-events-2027\/timetable\?day=Thursday%2C\+May\+20$/u,
  );
  const timetableSession = page.getByRole("button", {
    name: "Open details for AI in Event Operations",
  });
  const timetableUrl = page.url();
  await timetableSession.click();
  await expect(page).toHaveURL(timetableUrl);
  const timetableDetail = page.getByRole("dialog");
  await expect(timetableDetail).toBeVisible();
  await expect(timetableDetail).toContainText("AI in Event Operations");
  await expect(timetableDetail).toContainText("About this session");
  await expect(timetableDetail).toContainText("Alex Morgan");
  await expect(
    timetableDetail.getByRole("link", { name: "Open session page" }),
  ).toHaveAttribute(
    "href",
    "/public/programme/future-of-events-2027/sessions?session=demo-session-2",
  );
  await page.keyboard.press("Escape");
  await expect(timetableDetail).toHaveCount(0);
  await expect(timetableSession).toBeFocused();

  await openAnonymous(page, "/public/programme/future-of-events-2027/gallery");
  await expect(
    page.getByRole("heading", { name: "Speaker Gallery", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Search speaker gallery by name")).toHaveCount(
    0,
  );
  await expect(page.getByRole("link", { name: /My itinerary/ })).toHaveCount(0);
  await openAnonymous(
    page,
    "/public/programme/future-of-events-2027/gallery?galleryQuery=Priya+Shah",
  );
  const search = page.getByRole("searchbox", {
    name: "Search speaker gallery by name",
  });
  await expect(search).toBeVisible();
  await expect(search).toHaveValue("Priya Shah");
  const priyaCard = page.getByRole("button", {
    name: "Open speaker details for Priya Shah",
  });
  await expect(priyaCard).toHaveCount(1);
  await priyaCard.press("Enter");

  const detail = page.getByRole("dialog");
  await expect(detail).toBeVisible();
  await expect(detail).toContainText("Priya Shah");
  await expect(detail).toContainText("EventLab");
  await expect(detail).toContainText("Director of Experience Design");
  await detail.getByRole("button", { name: "Show more" }).click();
  await expect(detail).toContainText("calm, welcoming and easy to navigate");
  await expect(detail).toContainText("The Future of Attendee Engagement");
  await expect(detail).toContainText("Main Stage");
  await expect(
    detail.getByRole("link", { name: "The Future of Attendee Engagement" }),
  ).toHaveAttribute(
    "href",
    "/public/programme/future-of-events-2027/sessions?session=demo-session-1",
  );
  await detail.getByRole("button", { name: "Close speaker details" }).click();
  await expect(detail).toHaveCount(0);
  await expect(search).toHaveValue("Priya Shah");
  await expect(priyaCard).toBeFocused();

  await search.fill("Alex Morgan");
  const alexCard = page.getByRole("button", {
    name: "Open speaker details for Alex Morgan",
  });
  await alexCard.press("Enter");
  await search.fill("Priya Shah");
  await page.getByRole("button", { name: "Close speaker details" }).click();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue("Priya Shah");
  await expect(page.locator("a[href*='/sign-in']")).toHaveCount(0);
});

test("mobile programme navigation closes after activation and reflows at 320px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openAnonymous(page, "/public/programme/future-of-events-2027");

  const mobileNavigation = page.locator(".public-mobile-nav");
  await mobileNavigation.getByText("Browse", { exact: true }).click();
  await expect(mobileNavigation).toHaveAttribute("open", "");
  await mobileNavigation
    .getByRole("link", { name: "Speakers", exact: true })
    .click();
  await expect(mobileNavigation).not.toHaveAttribute("open", "");
  await expect(
    page.getByRole("heading", { name: "Speakers", exact: true }),
  ).toBeInViewport();

  await page.setViewportSize({ width: 320, height: 700 });
  await openAnonymous(page, "/public/programme/future-of-events-2027");
  const brandName = page.locator(".public-brand-name");
  await expect(brandName).toHaveText("Future of Events 2027");
  await brandName.evaluate((element) => {
    element.textContent =
      "International Symposium for Responsible and Accessible Event Technology";
  });
  const containment = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
    panelRights: [...document.querySelectorAll("#itinerary > .card")].map(
      (element) => Math.round(element.getBoundingClientRect().right),
    ),
  }));
  expect(containment.documentWidth).toBeLessThanOrEqual(
    containment.viewportWidth,
  );
  expect(
    containment.panelRights.every(
      (right) => right <= containment.viewportWidth + 1,
    ),
  ).toBe(true);
  expect(
    await brandName.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  await expect(page.locator(".public-top")).toHaveCSS("position", "static");
  await expect(brandName).toHaveCSS("white-space", "normal");
  const compactPublicTargets = page.locator(
    ".session-disclosure, .public-venue-map, .session-detail-profile-link",
  );
  const compactPublicTargetSizes = await compactPublicTargets.evaluateAll(
    (targets) =>
      targets
        .filter((target) => target.getClientRects().length > 0)
        .map((target) => {
          const box = target.getBoundingClientRect();
          return { width: box.width, height: box.height };
        }),
  );
  expect(compactPublicTargetSizes.length).toBeGreaterThan(0);
  expect(
    compactPublicTargetSizes.every(
      ({ width, height }) => width >= 24 && height >= 24,
    ),
  ).toBe(true);

  await openAnonymous(
    page,
    "/public/programme/future-of-events-2027/timetable",
  );
  await expect(page.locator(".public-timetable-room").first()).toBeHidden();
  await expect(page.locator(".public-timetable-session")).toHaveCount(3);
  const timetableContainment = await page.evaluate(() => ({
    viewportWidth: document.documentElement.clientWidth,
    documentWidth: document.documentElement.scrollWidth,
    cards: [...document.querySelectorAll(".public-timetable-session")].map(
      (element) => ({
        left: Math.round(element.getBoundingClientRect().left),
        right: Math.round(element.getBoundingClientRect().right),
      }),
    ),
  }));
  expect(timetableContainment.documentWidth).toBeLessThanOrEqual(
    timetableContainment.viewportWidth,
  );
  expect(
    timetableContainment.cards.every(
      ({ left, right }) =>
        left >= 0 && right <= timetableContainment.viewportWidth + 1,
    ),
  ).toBe(true);
});
