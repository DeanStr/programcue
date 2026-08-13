import { expect, test, type Page } from "@playwright/test";

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

  await openAnonymous(page, "/public/programme/future-of-events-2025");
  await expect(page.locator(".programme-row")).toHaveCount(5);
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

  await openAnonymous(page, "/public/programme/future-of-events-2025/speakers");
  await expect(
    page.getByRole("heading", { name: "Speakers", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Alex Morgan", { exact: true })).toBeVisible();
  await expect(page.getByText("Priya Shah", { exact: true })).toBeVisible();

  await openAnonymous(page, "/public/programme/future-of-events-2025/agenda");
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
  await page
    .getByRole("button", { name: "View details for AI in Event Operations" })
    .click();
  const agendaDetail = page.locator(".public-surface-detail");
  await expect(agendaDetail).toBeFocused();
  await expect(agendaDetail).toContainText("AI in Event Operations");

  await openAnonymous(page, "/public/programme/future-of-events-2025/schedule");
  await expect(
    page.getByRole("heading", { name: "Schedule Itinerary", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".public-itinerary-card")).toHaveCount(3);

  await openAnonymous(page, "/public/programme/future-of-events-2025/gallery");
  await expect(
    page.getByRole("heading", { name: "Speaker Gallery", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: /My itinerary/ }),
  ).toHaveAttribute(
    "href",
    "/public/programme/future-of-events-2025#itinerary",
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
    "/public/programme/future-of-events-2025#session-future-attendee-engagement",
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
  await openAnonymous(page, "/public/programme/future-of-events-2025");

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
  await openAnonymous(page, "/public/programme/future-of-events-2025");
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
});
