import { expect, test, type Page } from "@playwright/test";

import { e2eOrigin } from "./support/e2e-origin";
import { openRecordPanel } from "./support/open-record-panel";
import { resetDemoEvent } from "./support/reset-demo-event";

async function waitForInterface(page: Page, path: string) {
  const response = await page.goto(path);
  expect(response?.ok()).toBeTruthy();
  await page.locator("body[data-hydrated='true']").waitFor();
}

async function expectStatus(page: Page, text: string | RegExp) {
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
  await waitForInterface(page, "/public/programme/future-of-events-2025");
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
  await expect(page.getByLabel("Iframe code")).toHaveValue(
    new RegExp(`<iframe src="${e2eOrigin}/embed/future-of-events-2025`),
  );
  await expect(page.getByLabel("Iframe code")).not.toHaveValue(/accent=/);
  await expect(page.getByRole("link", { name: "Static JSON" })).toHaveAttribute(
    "href",
    /format=json$/,
  );
  await expect(page.getByRole("link", { name: "Static HTML" })).toHaveAttribute(
    "href",
    /format=html$/,
  );
  const publicMetric = page
    .locator(".metric")
    .filter({ hasText: "Published public" });
  await expect(publicMetric.locator(".value")).toHaveText("5");
  await expect(publicMetric).toContainText("Scheduled and public");
});

test("configures, previews and copies a constrained programme embed", async ({
  page,
  context,
}) => {
  await waitForInterface(page, "/admin/programme");
  await expect(
    page.getByRole("heading", { name: "Configure embed" }),
  ).toBeVisible();

  await page.getByLabel("Initial day").selectOption("2025-05-21");
  await page.getByLabel("Initial track").selectOption("AI & Innovation");
  await page.getByLabel("Initial format").selectOption("breakout");
  await page.getByLabel("Initial room").selectOption("Room 303");
  await page.getByLabel("Search text").fill("Building");
  await page.getByLabel("Day", { exact: true }).uncheck();
  await page.getByLabel("Track", { exact: true }).uncheck();
  await page.getByLabel("Format", { exact: true }).uncheck();
  await page.getByLabel("Room", { exact: true }).uncheck();
  await page.getByLabel("Density").selectOption("compact");
  await page
    .getByLabel("Include the speaker directory and profile links")
    .uncheck();

  const preview = page.locator(".programme-embed-preview iframe");
  await expect(preview).toHaveAttribute(
    "src",
    /day=2025-05-21.*track=AI\+%26\+Innovation.*format=breakout.*room=Room\+303.*query=Building.*controls=search.*density=compact.*speakers=hide/,
  );
  const previewFrame = preview.contentFrame();
  await previewFrame.locator("body[data-hydrated='true']").waitFor();
  await expect(
    previewFrame.locator(".public-shell.embed-compact"),
  ).toBeVisible();
  await expect(previewFrame.locator(".programme-row")).toHaveCount(1);
  await expect(
    previewFrame.getByLabel("Search sessions, speakers, or topics"),
  ).toHaveValue("Building");
  await expect(previewFrame.locator(".public-filters select")).toHaveCount(0);
  await expect(previewFrame.locator("#speakers")).toBeHidden();

  await expect(page.getByLabel("Iframe code")).toHaveValue(
    /controls=search.*density=compact.*speakers=hide/,
  );
  await page.getByRole("button", { name: "Widget", exact: true }).click();
  await expect(page.getByLabel("Auto-resizing widget code")).toHaveValue(
    /programcue-widget\.js.*data-day="2025-05-21".*data-track="AI &amp; Innovation".*data-format="breakout".*data-room="Room 303".*data-query="Building".*data-controls="search".*data-density="compact".*data-speakers="hide"/s,
  );

  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.getByRole("button", { name: "Copy code" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Installation code copied." }),
  ).toBeVisible();

  await page.getByLabel("Initial height").fill("100");
  await expect(page.getByLabel("Initial height")).toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(
    page
      .getByRole("alert")
      .filter({ hasText: "Embed height must be an integer from 160 to 20000" }),
  ).toBeVisible();
  await expect(page.getByLabel("Auto-resizing widget code")).toHaveValue("");
  await expect(page.getByRole("button", { name: "Copy code" })).toBeDisabled();

  await page.getByLabel("Initial height").fill("640");
  await expect(page.getByLabel("Initial height")).not.toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(page.getByLabel("Auto-resizing widget code")).toHaveValue(
    /data-height="640"/,
  );
  await expect(page.getByRole("button", { name: "Copy code" })).toBeEnabled();
});

test("rejects unsupported embed configuration instead of silently falling back", async ({
  page,
}) => {
  const invalidControls = await page.request.get(
    "/embed/future-of-events-2025?controls=search,unknown",
  );
  expect(invalidControls.status()).toBe(400);
  expect(await invalidControls.text()).toContain(
    "Embed controls must be a unique comma-separated selection",
  );

  const staleFormat = await page.request.get(
    "/embed/future-of-events-2025?format=not-published",
  );
  expect(staleFormat.status()).toBe(400);
  expect(await staleFormat.text()).toContain(
    "Embed format must identify a published format",
  );

  for (const name of ["day", "track", "format", "room", "accent"]) {
    const emptyValue = await page.request.get(
      `/embed/future-of-events-2025?${name}=`,
    );
    expect(emptyValue.status()).toBe(400);
    expect(await emptyValue.text()).toContain(
      `Embed ${name} must not be empty when provided`,
    );
  }

  const unknownParameter = await page.request.get(
    "/embed/future-of-events-2025?densitty=compact",
  );
  expect(unknownParameter.status()).toBe(400);
  expect(await unknownParameter.text()).toContain(
    "Embed configuration contains an unsupported parameter",
  );

  const duplicateParameter = await page.request.get(
    "/embed/future-of-events-2025?density=compact&density=comfortable",
  );
  expect(duplicateParameter.status()).toBe(400);
  expect(await duplicateParameter.text()).toContain(
    "Embed parameter density must appear at most once",
  );
});

test("widget preserves empty options for rejection and fails on an empty height", async ({
  page,
}) => {
  await page.route(`${e2eOrigin}/__programcue-widget-empty-option`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `
        <div id="programme-widget"></div>
        <script src="${e2eOrigin}/programcue-widget.js"
          data-programcue-event="future-of-events-2025"
          data-target="#programme-widget"
          data-controls=""></script>
      `,
    }),
  );
  const rejectedEmbed = page.waitForResponse(
    (response) =>
      response.url().includes("/embed/future-of-events-2025?controls=") &&
      response.status() === 400,
  );
  await page.goto(`${e2eOrigin}/__programcue-widget-empty-option`);
  await rejectedEmbed;
  await expect(page.locator("#programme-widget iframe")).toHaveAttribute(
    "src",
    /\/embed\/future-of-events-2025\?controls=$/,
  );

  await page.route(`${e2eOrigin}/__programcue-widget-empty-height`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `
        <div id="programme-widget"></div>
        <script src="${e2eOrigin}/programcue-widget.js"
          data-programcue-event="future-of-events-2025"
          data-target="#programme-widget"
          data-height=""></script>
      `,
    }),
  );
  const widgetError = page.waitForEvent("pageerror");
  await page.goto(`${e2eOrigin}/__programcue-widget-empty-height`);
  await expect(widgetError).resolves.toHaveProperty(
    "message",
    "Program Cue widget data-height must be an integer from 160 to 20000.",
  );
  await expect(page.locator("#programme-widget iframe")).toHaveCount(0);
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
            data-accent="#0d9488"
            data-controls="search"
            data-density="compact"></script>
        `,
    }),
  );
  await page.goto(`${e2eOrigin}/__programcue-widget-host`);
  const frame = page.locator("#programme-widget iframe");
  await expect(frame).toHaveAttribute(
    "src",
    /\/embed\/future-of-events-2025\?day=2025-05-21&accent=%230d9488&controls=search&density=compact$/,
  );
  await frame.contentFrame().locator("body[data-hydrated='true']").waitFor();
  await expect(
    frame.contentFrame().locator(".public-shell.embed-compact"),
  ).toBeVisible();
  await expect(
    frame.contentFrame().locator(".public-filters select"),
  ).toHaveCount(0);
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

  test("reviews, approves and restores attributed session content", async ({
    page,
  }) => {
    test.slow();
    const approvedTitle = `Approved content ${crypto.randomUUID().slice(0, 8)}`;
    await waitForInterface(page, "/admin/schedule?session=demo-session-1");
    await page.getByRole("button", { name: "Create next draft" }).click();
    const editor = page.getByTestId("session-content-editor");
    await editor.getByLabel("Title").fill(approvedTitle);
    await editor
      .getByLabel("Public description")
      .fill("An exact description that is ready for programme approval.");
    await expect(editor.getByText("Saved", { exact: true })).toBeVisible({
      timeout: 10_000,
    });

    await editor.getByRole("link", { name: "Review history" }).click();
    await expect(
      page.getByRole("heading", { name: approvedTitle }),
    ).toBeVisible();
    await page.getByLabel("Next status").selectOption("approved");
    await page
      .getByRole("checkbox", { name: /apply this exact status/i })
      .check();
    await page.getByRole("button", { name: "Change status" }).click();
    await expect(
      page.getByText("Content updated", { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("Approved status").first()).toBeVisible();

    await page.getByRole("link", { name: "Edit current content" }).click();
    await editor.getByLabel("Title").fill("Edited content requires approval");
    await expect(editor.getByText("Saved", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await editor.getByRole("link", { name: "Review history" }).click();
    await expect(page.getByLabel("Draft status").first()).toBeVisible();

    const approvedRevision = page
      .locator("li.card", { hasText: approvedTitle })
      .filter({ has: page.getByLabel("Approved status") });
    await approvedRevision.getByText("Restore this revision").click();
    await approvedRevision
      .getByRole("checkbox", { name: /restore exactly this title/i })
      .check();
    await approvedRevision
      .getByRole("button", { name: "Restore as new draft" })
      .click();
    await expect(
      page.getByText(
        "The selected revision was restored as a new draft revision.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: approvedTitle }),
    ).toBeVisible();
  });

  test("loads retained file versions only when their disclosure opens", async ({
    page,
    request,
  }) => {
    const fixture = await request.post("/demo/fixtures/golden-path", {
      form: {
        intent: "seed_task_evidence",
        confirm: "seed-golden-path-browser-fixture",
      },
      headers: { origin: e2eOrigin },
    });
    expect(fixture.ok(), await fixture.text()).toBeTruthy();

    await waitForInterface(page, "/admin/content");
    const library = page.getByRole("region", { name: "Central files library" });
    const disclosure = library.locator("details").first();
    await expect(disclosure).not.toHaveAttribute("open", "");
    await expect(disclosure.locator("li")).toHaveCount(0);

    const historyResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname.includes("/versions"),
    );
    await disclosure.locator("summary").click();
    expect((await historyResponse).ok()).toBeTruthy();
    await expect(disclosure.locator("li").first()).toContainText(/v\d+/);
  });

  test("configures resources and commits a pointer resize through the authoritative schedule", async ({
    page,
  }) => {
    test.slow();
    await waitForInterface(page, "/admin/event");
    await openRecordPanel(page, "Rooms and capacities");
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

  test("previews and confirms deterministic auto-placement without publishing", async ({
    page,
  }) => {
    test.slow();
    const unique = Date.now();
    const titles = [
      `Auto-place first ${unique}`,
      `Auto-place second ${unique}`,
    ];

    await waitForInterface(page, "/admin/submissions");
    for (const [index, title] of titles.entries()) {
      const directSession = page.locator("details").filter({
        has: page.getByText("Create a guaranteed direct session", {
          exact: true,
        }),
      });
      if ((await directSession.getAttribute("open")) === null) {
        await directSession
          .getByText("Create a guaranteed direct session", { exact: true })
          .click();
      }
      await directSession.getByLabel("Session title").fill(title);
      await directSession.getByLabel("Track").selectOption({ index: 1 });
      await directSession
        .getByLabel("Description")
        .fill("A deterministic auto-placement test session.");
      await directSession
        .getByLabel("Speaker 1 name")
        .fill(`Auto Speaker ${index + 1}`);
      await directSession
        .getByLabel("Email", { exact: true })
        .fill(`auto-place-${unique}-${index}@example.com`);
      await directSession
        .getByRole("button", { name: "Create unscheduled session" })
        .click();
      await expect(
        page.locator(".validation-item.ok[role='status']").filter({
          hasText: "Direct session created in the unscheduled programme.",
        }),
      ).toBeVisible();
    }

    await waitForInterface(page, "/admin/schedule");
    await page.getByRole("button", { name: "Create next draft" }).click();
    await expect(page.getByText(/Version \d+ · draft/)).toBeVisible();

    const autoPlace = page.getByRole("button", {
      name: "Auto-place unscheduled sessions",
    });
    await expect(autoPlace).toBeEnabled();
    await autoPlace.click();
    const preview = page.getByRole("dialog", {
      name: "Preview auto-placement",
    });
    await expect(preview).toBeVisible();
    await expect(
      preview.getByRole("heading", { name: "Proposed placements" }),
    ).toBeVisible();
    await expect(preview.getByTestId("auto-placement-proposal")).toHaveCount(2);
    for (const title of titles) {
      await expect(preview.getByText(title, { exact: true })).toBeVisible();
    }
    await expect(
      preview.getByRole("button", { name: "Confirm placements" }),
    ).toBeEnabled();
    await preview.getByRole("button", { name: "Confirm placements" }).click();

    await expectStatus(page, /Auto-place applied 2 placements/);
    for (const title of titles) {
      await expect(
        page.locator(".schedule-entry-draggable").filter({ hasText: title }),
      ).toBeVisible();
    }
    await expect(page.getByText(/draft.*not published/i)).toBeVisible();
    for (const title of titles) {
      await expect(
        page.locator(".schedule-entry-draggable").filter({
          hasText: title,
        }),
      ).toHaveCount(1);
    }

    const publicProgramme = await page.request.get(
      "/api/v1/public/events/future-of-events-2025/programme",
    );
    expect(publicProgramme.ok()).toBeTruthy();
    const publicProgrammeBody = JSON.stringify(await publicProgramme.json());
    expect(publicProgrammeBody).not.toContain(titles[0]);
    expect(publicProgrammeBody).not.toContain(titles[1]);

    await waitForInterface(page, "/admin/schedule");
    await expect(page.getByText(/Version \d+ · draft/)).toBeVisible();
    for (const title of titles) {
      await expect(
        page.locator(".schedule-entry-draggable").filter({
          hasText: title,
        }),
      ).toHaveCount(1);
    }
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
  const itineraryItem = page.locator(".itinerary-item").first();
  await expect(itineraryItem).toContainText(
    "Main Stage · keynote · Leadership",
  );
  await expect(itineraryItem).toContainText("Priya Shah");
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

test("public programme filters sessions by track, format and room", async ({
  page,
}) => {
  await waitForInterface(page, "/public/programme/future-of-events-2025");
  const rows = page.locator(".programme-row");
  const total = await rows.count();
  expect(total).toBe(5);
  await expect(
    page.getByText(`Showing ${total} of ${total} published sessions.`),
  ).toBeVisible();

  await page.getByLabel("Filter by track").selectOption("AI & Innovation");
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

  // A query that matches session content keeps that session's speaker and
  // profile route available even when the profile text does not match itself.
  await page
    .getByLabel("Search sessions, speakers, or topics")
    .fill("future of attendee");
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

test("public programme exposes speaker affiliations and a closable profile panel", async ({
  page,
}) => {
  // Opening the organiser roster materialises the demo speaker's title and
  // organisation; the public surface only renders what D1 already holds.
  await waitForInterface(page, "/admin/speakers");
  await waitForInterface(page, "/public/programme/future-of-events-2025");

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

  // A shared profile URL has no opener recorded in component state, so close
  // falls back to its visible speaker-card link instead of dropping focus.
  await page.goto(
    "/public/programme/future-of-events-2025#speaker-person-demo-speaker",
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
