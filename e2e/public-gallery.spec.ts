import { expect, type Page, test } from "@playwright/test";

test.use({ storageState: { cookies: [], origins: [] } });

async function openAnonymous(page: Page, path: string) {
  const response = await page.goto(path);
  expect(response?.ok(), `${path} should be public`).toBe(true);
  await page.locator("body[data-hydrated='true']").waitFor();
  expect(page.url()).not.toContain("/sign-in");
}

test("anonymous visitors can use all programme surfaces and the gallery detail", async ({
  page,
}) => {
  await page.context().clearCookies();

  await openAnonymous(page, "/public/programme/future-of-events-2027");
  await expect(page.locator(".public-nav a")).toHaveText([
    "All sessions",
    "Speakers",
    "Day agenda",
    "Full schedule",
    "Speaker Gallery",
  ]);
  await expect(
    page.getByRole("navigation", { name: "Programme views" }).getByRole("link"),
  ).toHaveText(["List", "Agenda", "Schedule"]);
  await expect(page.locator(".programme-row")).toHaveCount(5);
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
    page.getByRole("navigation", { name: "Speaker views" }).getByRole("link"),
  ).toHaveText(["Directory", "Gallery"]);
  await expect(
    page.getByRole("heading", { name: "Speakers", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Alex Morgan", { exact: true })).toBeVisible();
  await expect(page.getByText("Priya Shah", { exact: true })).toBeVisible();

  await openAnonymous(page, "/public/programme/future-of-events-2027/agenda");
  await expect(
    page.getByRole("heading", { name: "Agenda", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Main Stage", { exact: true }).first(),
  ).toBeVisible();
  const dayButtons = page
    .getByRole("group", { name: "Agenda days" })
    .getByRole("button");
  await expect(dayButtons).toHaveCount(2);
  await dayButtons.first().focus();
  await dayButtons.first().press("ArrowRight");
  await expect(dayButtons.nth(1)).toBeFocused();
  await expect(dayButtons.nth(1)).toHaveAttribute("aria-pressed", "true");
  await dayButtons.nth(1).press("Home");
  await expect(dayButtons.first()).toBeFocused();
  await expect(dayButtons.first()).toHaveAttribute("aria-pressed", "true");
  const expandedAgendaTrigger = page.locator(
    ".agenda-card-trigger[aria-expanded='true']",
  );
  const expandedAgendaTriggerId =
    await expandedAgendaTrigger.getAttribute("id");
  expect(expandedAgendaTriggerId).toBeTruthy();
  const initiallyExpandedAgendaTrigger = page.locator(
    `#${expandedAgendaTriggerId}`,
  );
  await page.getByRole("button", { name: "Close session details" }).click();
  await expect(initiallyExpandedAgendaTrigger).toBeFocused();
  const agendaDetailTrigger = page.getByRole("button", {
    name: "View details for AI in Event Operations",
  });
  await agendaDetailTrigger.click();
  const agendaDetail = page.locator(".public-surface-detail");
  await expect(agendaDetail).toBeFocused();
  await expect(agendaDetail).toContainText("AI in Event Operations");
  await agendaDetail
    .getByRole("button", { name: "Close session details" })
    .click();
  await expect(agendaDetail).toHaveCount(0);
  await expect(agendaDetailTrigger).toBeFocused();

  await openAnonymous(page, "/public/programme/future-of-events-2027/schedule");
  await expect(
    page.getByRole("heading", { name: "Schedule Itinerary", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".public-itinerary-card")).toHaveCount(3);

  await openAnonymous(page, "/public/programme/future-of-events-2027/gallery");
  await expect(
    page.getByRole("heading", { name: "Speaker Gallery", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /My itinerary/ }),
  ).toHaveAttribute(
    "href",
    "/public/programme/future-of-events-2027#itinerary",
  );
  const search = page.getByRole("searchbox", {
    name: "Search speaker gallery by name",
  });
  await search.fill("Priya Shah");
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
});
