import { expect, test } from "@playwright/test";

async function waitForInterface(
  page: import("@playwright/test").Page,
  path: string,
) {
  const response = await page.goto(path);
  expect(response?.ok()).toBeTruthy();
  await page.locator("body[data-hydrated='true']").waitFor();
}

test.beforeEach(async ({ page }) => {
  // Opening the public route establishes the deterministic demo publication that
  // both admin views read; production mode never executes this seed path.
  await waitForInterface(page, "/public/programme");
});

test("schedule and programme render the event calendar date and timezone", async ({
  page,
}) => {
  await expect(page.locator(".hero")).toContainText(
    "Tuesday, May 20–Thursday, May 22",
  );
  await expect(page.locator(".hero")).not.toContainText("Monday, May 19");
  await waitForInterface(page, "/public/programme/future-of-events-2025");
  await expect(page.locator(".public-top .brand")).toHaveAttribute(
    "href",
    "/public/programme/future-of-events-2025",
  );
  const calendar = await page.request.get(
    "/api/v1/public/events/future-of-events-2025/calendar.ics",
  );
  expect(calendar.ok()).toBeTruthy();
  const unfoldedCalendar = (await calendar.text()).replace(/\r?\n[ \t]/g, "");
  const sessionUrls = unfoldedCalendar
    .split(/\r?\n/)
    .filter((line) => /^URL(?:;[^:]*)?:/.test(line))
    .map((line) => line.slice(line.indexOf(":") + 1));
  expect(sessionUrls).toHaveLength(5);
  for (const sessionUrl of sessionUrls) {
    expect(sessionUrl).toMatch(
      /^https?:\/\/[^/]+\/public\/programme\/future-of-events-2025#session-[a-z0-9-]+$/,
    );
  }
  const linkedSession = new URL(sessionUrls.at(-1)!);
  await page.goto("/admin/event");
  await waitForInterface(
    page,
    `${linkedSession.pathname}${linkedSession.hash}`,
  );
  await expect(page.locator(linkedSession.hash)).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  const hydrationErrors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /hydration|didn't match/i.test(message.text())
    ) {
      hydrationErrors.push(message.text());
    }
  });
  await waitForInterface(page, "/admin/schedule");
  await expect(
    page.getByRole("button", { name: "Room", pressed: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Tue, May 20 · Room view" }),
  ).toBeVisible();
  await expect(
    page.getByText("9:00 AM", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: /Wed, May 21.*2 placed/ }).click();
  await expect(
    page.getByRole("heading", { name: "Wed, May 21 · Room view" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Community and Connection", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("9:30 AM", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    page.locator(".schedule-session-source").first(),
  ).toHaveAttribute("aria-describedby", "schedule-planner-dnd-instructions");
  await expect(page.locator("#schedule-planner-dnd-instructions")).toHaveCount(
    1,
  );
  expect(hydrationErrors).toEqual([]);

  await waitForInterface(page, "/admin/programme");
  await expect(
    page.getByRole("link", { name: "Public programme" }),
  ).toHaveAttribute("href", "/public/programme/future-of-events-2025");
  await expect(
    page.getByText("Event timezone · America/Toronto"),
  ).toBeVisible();
  await expect(
    page.getByText(/May 20, 2025.*9:00 AM.*(?:EDT|GMT-4)/).first(),
  ).toBeVisible();
  const publicMetric = page
    .locator(".metric")
    .filter({ hasText: "Published public" });
  await expect(publicMetric.locator(".value")).toHaveText("5");
  await expect(publicMetric).toContainText("Scheduled and public");
});

test("keeps personal itinerary state private and disables it in embeds", async ({
  page,
}) => {
  const publicResponse = await page.goto(
    "/public/programme/future-of-events-2025",
  );
  expect(publicResponse?.headers()["cache-control"]).toBe("private, no-store");
  await page.locator("body[data-hydrated='true']").waitFor();
  await expect(
    page.getByRole("heading", { name: "My itinerary" }),
  ).toBeVisible();

  const embedResponse = await page.goto("/embed/future-of-events-2025");
  expect(embedResponse?.headers()["cache-control"]).toContain("public");
  await page.locator("body[data-hydrated='true']").waitFor();
  await expect(page.getByRole("heading", { name: "My itinerary" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: /(?:add to|remove from) itinerary/i }),
  ).toHaveCount(0);

  const mutation = await page.request.post("/embed/future-of-events-2025", {
    form: { intent: "add", sessionId: "not-used" },
    headers: { origin: "http://127.0.0.1:5173" },
  });
  expect(mutation.status()).toBe(405);
  expect(mutation.headers().allow).toBe("GET");
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

test("schedule contains its room grid and explains mobile scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await waitForInterface(page, "/admin/schedule");

  await expect(
    page.getByText("Swipe horizontally to see every room"),
  ).toBeVisible();
  const roomGrid = page.getByRole("region", {
    name: /room schedule\. Scroll horizontally/i,
  });
  await expect(roomGrid).toBeVisible();
  const gridWidth = await roomGrid.evaluate((element) => ({
    client: element.clientWidth,
    scroll: element.scrollWidth,
  }));
  expect(gridWidth.scroll).toBeGreaterThan(gridWidth.client);
  const documentOverflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(documentOverflow).toBeLessThanOrEqual(1);
});
