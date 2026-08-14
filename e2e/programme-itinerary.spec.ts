import { expect, test, type Page } from "@playwright/test";

import { e2eOrigin } from "./support/e2e-origin";

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

test("keeps personal itinerary state private and disables it in embeds", async ({
  page,
}) => {
  const publicResponse = await page.goto(
    "/public/programme/future-of-events-2027",
  );
  expect(publicResponse?.headers()["cache-control"]).toBe("private, no-store");
  await page.locator("body[data-hydrated='true']").waitFor();
  await expect(
    page.getByRole("heading", { name: "My itinerary" }),
  ).toBeVisible();

  const embedResponse = await page.goto("/embed/future-of-events-2027");
  expect(embedResponse?.headers()["cache-control"]).toContain("public");
  await page.locator("body[data-hydrated='true']").waitFor();
  await expect(page.getByRole("heading", { name: "My itinerary" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: /(?:add to|remove from) itinerary/i }),
  ).toHaveCount(0);

  const mutation = await page.request.post("/embed/future-of-events-2027", {
    form: { intent: "add", sessionId: "not-used" },
    headers: { origin: e2eOrigin },
  });
  expect(mutation.status()).toBe(405);
  expect(mutation.headers().allow).toBe("GET");
});

test("publishes speaker profiles and a read-only itinerary share link", async ({
  page,
}) => {
  await waitForInterface(page, "/public/programme/future-of-events-2027");
  await page.getByRole("link", { name: "Speakers" }).click();
  await expect(
    page.getByRole("heading", { name: "Speakers", exact: true }),
  ).toBeVisible();
  const profileLink = page
    .getByRole("link", { name: "View profile and sessions" })
    .first();
  await profileLink.click();
  await expect(
    page.getByText("Speaker profile", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Share profile link" }),
  ).toHaveAttribute("href", /^#speaker-/);

  await page.locator(".programme-row").first().click();
  await page.getByRole("button", { name: "Add to itinerary" }).click();
  await expect(page.getByText("Saved ✓").first()).toBeVisible();
  const itineraryItem = page.locator(".itinerary-item").first();
  await expect(itineraryItem).toContainText(
    "Main Stage · keynote · Leadership",
  );
  await expect(itineraryItem).toContainText("Priya Shah");
  const calendarExport = page.getByRole("link", { name: "Export itinerary" });
  await expect(calendarExport).toBeVisible();
  const calendarHref = await calendarExport.getAttribute("href");
  expect(calendarHref).toContain("calendar.ics?itinerary=mine");
  const calendarResponse = await page.request.get(calendarHref!);
  expect(calendarResponse.ok()).toBeTruthy();
  expect(calendarResponse.headers()["content-disposition"]).toContain(
    "future-of-events-2027-itinerary.ics",
  );
  expect((await calendarResponse.text()).match(/^UID:/gmu)).toHaveLength(1);
  const download = page.waitForEvent("download");
  await calendarExport.click();
  await download;
  await expect(
    page.getByRole("status").filter({
      hasText: "Calendar download requested. Check your browser downloads.",
    }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Create read-only share link" })
    .click();
  const shareLink = page
    .getByRole("status")
    .getByRole("link")
    .filter({ hasText: /share=/ });
  await expect(shareLink).toBeVisible();
  const shareHref = await shareLink.getAttribute("href");
  expect(shareHref).toContain("?share=");

  await waitForInterface(page, shareHref!);
  await expect(
    page.getByRole("heading", { name: "Shared itinerary" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Export itinerary" }),
  ).toBeVisible();
  const sharedCalendarHref = await page
    .getByRole("link", { name: "Export itinerary" })
    .getAttribute("href");
  expect(sharedCalendarHref).toContain("calendar.ics?share=");
  const sharedCalendarResponse = await page.request.get(sharedCalendarHref!);
  expect(sharedCalendarResponse.ok()).toBeTruthy();
  expect((await sharedCalendarResponse.text()).match(/^UID:/gmu)).toHaveLength(
    1,
  );
  await expect(
    page.getByRole("button", { name: /add to|remove from itinerary/i }),
  ).toHaveCount(0);
});
