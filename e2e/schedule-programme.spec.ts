import { expect, test, type Page } from "@playwright/test";

import { e2eOrigin } from "./support/e2e-origin";
import { resetDemoEvent } from "./support/reset-demo-event";

async function waitForInterface(page: Page, path: string) {
  const response = await page.goto(path);
  expect(response?.ok()).toBeTruthy();
  await page.locator("body[data-hydrated='true']").waitFor();
}

async function expectStatus(page: Page, text: string) {
  await expect(
    page.getByRole("status").filter({ hasText: text }).first(),
  ).toBeVisible();
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
  await page.getByRole("button", { name: "Day", pressed: false }).click();
  await expect(page.getByRole("heading", { name: "Day view" })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "day schedule calendar" }),
  ).toBeVisible();
  await expect(
    page.getByText(/Community and Connection/).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Week", pressed: false }).click();
  await expect(page.getByRole("heading", { name: "Week view" })).toBeVisible();
  await expect(
    page.getByRole("region", { name: "week schedule calendar" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "List", pressed: false }).click();
  await expect(
    page.getByRole("region", { name: "list schedule calendar" }),
  ).toBeVisible();
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
  await expect(page.getByLabel("Embed code")).toHaveValue(
    new RegExp(`<iframe src="${e2eOrigin}/embed/future-of-events-2025"`),
  );
  await expect(page.getByLabel("Auto-resizing widget code")).toHaveValue(
    /programcue-widget\.js.*data-programcue-event="future-of-events-2025"/s,
  );
  await expect(
    page.getByRole("link", { name: "Download static JSON" }),
  ).toHaveAttribute("href", /format=json$/);
  await expect(
    page.getByRole("link", { name: "Download static HTML" }),
  ).toHaveAttribute("href", /format=html$/);
  const publicMetric = page
    .locator(".metric")
    .filter({ hasText: "Published public" });
  await expect(publicMetric.locator(".value")).toHaveText("5");
  await expect(publicMetric).toContainText("Scheduled and public");
});

test("exports static programme files and mounts a filtered auto-resizing widget", async ({
  page,
}) => {
  const jsonExport = await page.request.get(
    "/api/v1/public/events/future-of-events-2025/programme?format=json",
  );
  expect(jsonExport.ok()).toBeTruthy();
  expect(jsonExport.headers()["content-disposition"]).toContain(
    "future-of-events-2025-programme.json",
  );
  expect((await jsonExport.json()).speakers.length).toBeGreaterThan(0);

  const htmlExport = await page.request.get(
    "/api/v1/public/events/future-of-events-2025/programme?format=html",
  );
  expect(htmlExport.ok()).toBeTruthy();
  expect(htmlExport.headers()["content-type"]).toContain("text/html");
  expect(await htmlExport.text()).toContain("<!doctype html>");

  // The real application CSP intentionally permits only HTTPS frames. Fulfil
  // a CSP-neutral loopback host document so the local HTTP test can exercise
  // the widget contract without inheriting Program Cue's response headers or
  // using an opaque origin that Chromium blocks from loopback resources.
  await page.route(`${e2eOrigin}/__programcue-widget-host`, async (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `
          <main><div id="programme-widget"></div></main>
          <script src="${e2eOrigin}/programcue-widget.js"
            data-programcue-event="future-of-events-2025"
            data-target="#programme-widget"
            data-day="2025-05-21"
            data-accent="#0d9488"></script>
        `,
    }),
  );
  await page.goto(`${e2eOrigin}/__programcue-widget-host`);
  const frame = page.locator("#programme-widget iframe");
  await expect(frame).toHaveAttribute(
    "src",
    /\/embed\/future-of-events-2025\?day=2025-05-21&accent=%230d9488$/,
  );
  await frame.contentFrame().locator("body[data-hydrated='true']").waitFor();
  await expect(frame.contentFrame().locator(".programme-row")).toHaveCount(2);
  await expect
    .poll(async () =>
      Number.parseInt(await frame.evaluate((node) => node.style.height), 10),
    )
    .toBeGreaterThan(720);
});

test("focuses the exact named schedule record", async ({ page }) => {
  const response = await page.request.get(
    "/api/v1/public/events/future-of-events-2025/programme",
  );
  expect(response.ok()).toBeTruthy();
  const programme = (await response.json()) as {
    sessions: Array<{ id: string }>;
  };
  const sessionId = programme.sessions[0]!.id;
  await waitForInterface(
    page,
    `/admin/schedule?session=${encodeURIComponent(sessionId)}`,
  );

  await expect(page).toHaveURL(new RegExp(`session=${sessionId}`));
  await expect(
    page.getByText("Focused session", { exact: true }),
  ).toBeVisible();
  await expect(page.locator(`#schedule-session-${sessionId}`)).toBeFocused();
});

test.describe("mutable schedule authoring", () => {
  test.afterEach(async ({ context, request }) => {
    await context.setOffline(false);
    await resetDemoEvent(request);
  });

  test("autosaves revisioned session content and explicitly restores offline schedule notes", async ({
    page,
    context,
  }) => {
    test.slow();
    const title = `Recovery-safe session ${crypto.randomUUID().slice(0, 8)}`;
    const description = "A saved description rendered by the isolated preview.";
    const notes =
      "Restore these draft-only production notes after reconnecting.";
    await waitForInterface(page, "/admin/schedule?session=demo-session-1");
    await page.getByRole("button", { name: "Create next draft" }).click();
    await expect(page.getByText(/Version \d+ · draft/)).toBeVisible();

    const editor = page.getByTestId("session-content-editor");
    await expect(editor.getByLabel("Title")).toHaveValue(
      "The Future of Attendee Engagement",
    );
    await editor.getByLabel("Title").fill(title);
    await editor.getByLabel("Public description").fill(description);
    await expect(editor.getByText("Saved", { exact: true })).toBeVisible({
      timeout: 10_000,
    });

    const preview = page.getByTestId("session-content-preview");
    await expect(preview.getByRole("heading", { name: title })).toBeVisible();
    await preview.getByRole("button", { name: "Mobile" }).click();
    await expect(
      preview.locator("[data-preview-viewport='mobile']"),
    ).toBeVisible();
    await preview.getByRole("button", { name: "Session detail" }).click();
    await expect(preview.getByText(description, { exact: true })).toBeVisible();
    await preview.getByRole("button", { name: "Calendar" }).click();
    await preview
      .getByText("Exact ICS generated from the last saved server revision")
      .click();
    await expect(preview.locator("pre")).toContainText(`SUMMARY:${title}`);

    const publicProgramme = await page.request.get(
      "/api/v1/public/events/future-of-events-2025/programme",
    );
    expect(publicProgramme.ok()).toBeTruthy();
    expect(JSON.stringify(await publicProgramme.json())).not.toContain(title);

    const notesEditor = page.getByTestId("schedule-notes-editor");
    await context.setOffline(true);
    await notesEditor.getByLabel("Schedule notes").fill(notes);
    await expect(
      notesEditor.getByText("Offline", { exact: true }).first(),
    ).toBeVisible();
    await page.waitForTimeout(750);

    await context.setOffline(false);
    await waitForInterface(page, "/admin/schedule?session=demo-session-1");
    const restoredNotesEditor = page.getByTestId("schedule-notes-editor");
    await restoredNotesEditor
      .getByRole("button", { name: "Restore local edits" })
      .click();
    await expect(restoredNotesEditor.getByLabel("Schedule notes")).toHaveValue(
      notes,
    );
    await expect(
      restoredNotesEditor.getByText("Saved", { exact: true }),
    ).toBeVisible({ timeout: 10_000 });

    await waitForInterface(page, "/admin/schedule?session=demo-session-1");
    await expect(
      page.getByTestId("schedule-notes-editor").getByLabel("Schedule notes"),
    ).toHaveValue(notes);
    await expect(
      page.getByTestId("session-content-editor").getByLabel("Title"),
    ).toHaveValue(title);
  });

  test("configures resources and commits a pointer resize through the authoritative schedule", async ({
    page,
  }) => {
    test.slow();
    await waitForInterface(page, "/admin/event");
    const resourceInputs = page.getByLabel(/^New resource for /);
    const resourceCount = await resourceInputs.count();
    expect(resourceCount).toBeGreaterThan(0);
    for (let index = 0; index < resourceCount; index += 1) {
      await resourceInputs.nth(index).fill("livestream crew");
      await page
        .getByRole("button", { name: "Add resource" })
        .nth(index)
        .click();
    }
    await page.getByRole("button", { name: "Save event" }).click();
    await expectStatus(page, "Event settings saved");

    await waitForInterface(page, "/admin/schedule");
    await page.getByRole("button", { name: "Create next draft" }).click();
    await expect(page.getByText(/Version \d+ · draft/)).toBeVisible();
    await page.getByText("Session required resources", { exact: true }).click();
    await page
      .getByRole("checkbox", { name: /livestream crew/i })
      .first()
      .check();
    await page.getByRole("button", { name: "Save required resources" }).click();
    await expectStatus(page, "Session requirements updated");

    await page.getByRole("button", { name: "Day", pressed: false }).click();
    const calendar = page.getByRole("region", {
      name: "day schedule calendar",
    });
    const event = calendar.getByRole("button", {
      name: /The Future of Attendee Engagement · Main Stage/,
    });
    await event.hover();
    const eventBox = await event.locator("..").boundingBox();
    expect(eventBox).not.toBeNull();
    const resizeRequest = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === "/admin/schedule.data",
    );
    await page.mouse.move(
      eventBox!.x + eventBox!.width / 2,
      eventBox!.y + eventBox!.height - 5,
    );
    await page.mouse.down();
    await page.mouse.move(
      eventBox!.x + eventBox!.width / 2,
      eventBox!.y + eventBox!.height - 30,
      { steps: 5 },
    );
    await page.mouse.up();
    expect((await resizeRequest).ok()).toBeTruthy();
    await expectStatus(page, "Session placed");
    const undo = page.getByRole("button", { name: "Undo" });
    await expect(undo).toBeVisible();
    await undo.click();
    await expectStatus(page, "Schedule change undone");
  });
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
    headers: { origin: e2eOrigin },
  });
  expect(mutation.status()).toBe(405);
  expect(mutation.headers().allow).toBe("GET");
});

test("keeps programme detail panels inside the active embed filters", async ({
  page,
}) => {
  await waitForInterface(page, "/embed/future-of-events-2025?day=2025-05-21");
  const firstVisibleTitle = await page
    .locator(".programme-row h3")
    .first()
    .innerText();
  const visibleSpeakerText = (
    await page.locator(".programme-row .speaker").allInnerTexts()
  ).join(", ");
  for (const speakerName of await page
    .locator("#speakers > .grid article h3")
    .allInnerTexts()) {
    expect(visibleSpeakerText).toContain(speakerName);
  }
  await expect(page.locator(".session-detail-panel h2")).toHaveText(
    firstVisibleTitle,
  );
  const profileLink = page
    .locator("#speakers > .grid")
    .getByRole("link", { name: "View profile and sessions" })
    .first();
  if ((await profileLink.count()) > 0) {
    await profileLink.click();
    const visibleTitles = await page
      .locator(".programme-row h3")
      .allInnerTexts();
    for (const profileSession of await page
      .locator("#speakers article[aria-live='polite'] .stack a")
      .allInnerTexts()) {
      expect(
        visibleTitles.some((title) => profileSession.includes(title)),
      ).toBe(true);
    }
  }

  await waitForInterface(
    page,
    "/embed/future-of-events-2025?query=no-published-record-matches-this",
  );
  await expect(
    page.getByRole("heading", { name: "No matching sessions" }),
  ).toBeVisible();
  await expect(page.locator(".session-detail-panel")).toHaveCount(0);
  await expect(
    page.getByText("No speakers match this search.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Speaker profile", { exact: true })).toHaveCount(
    0,
  );
});

test("publishes speaker profiles and a read-only itinerary share link", async ({
  page,
}) => {
  await waitForInterface(page, "/public/programme/future-of-events-2025");
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
    page.getByRole("button", { name: /add to|remove from itinerary/i }),
  ).toHaveCount(0);
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
