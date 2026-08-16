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

async function createNextScheduleDraft(page: Page) {
  await page.getByRole("button", { name: "Create next draft" }).click();
  const confirmation = page.getByRole("dialog", {
    name: "Create the next schedule draft?",
  });
  await expect(confirmation).toContainText(
    "The published programme will not change",
  );
  await confirmation.getByRole("button", { name: "Confirm new draft" }).click();
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

test("schedule source search updates its URL without reloading the workspace", async ({
  page,
}) => {
  await waitForInterface(page, "/admin/schedule?sourceQuery=AI");
  await createNextScheduleDraft(page);
  await expect(page.getByLabel("Find session")).toBeVisible();
  const routeReads: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/admin/schedule") {
      routeReads.push(url.href);
    }
  });

  await page.getByLabel("Find session").fill("panel");
  await expect(page).toHaveURL(/sourceQuery=panel/u);
  await expect(page.getByText(/of \d+ sessions match/u)).toBeVisible();
  expect(routeReads).toEqual([]);
});

test("schedule and programme render the event calendar date and timezone", async ({
  page,
}) => {
  await expect(page.locator(".hero")).toContainText(
    "Thursday, May 20–Saturday, May 22",
  );
  await expect(page.locator(".hero")).not.toContainText("Wednesday, May 19");
  await waitForInterface(page, "/public/programme/future-of-events-2027");
  await expect(page.locator(".public-top .brand")).toHaveAttribute(
    "href",
    "/public/programme/future-of-events-2027",
  );
  const calendar = await page.request.get(
    "/api/v1/public/events/future-of-events-2027/calendar.ics",
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
      /^https?:\/\/[^/]+\/public\/programme\/future-of-events-2027#session-[a-z0-9-]+$/,
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
    page.getByRole("heading", { name: "Thu, May 20 · Room view" }),
  ).toBeVisible();
  await expect(
    page.getByText("9:00 AM", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: /Fri, May 21.*2 placed/ }).click();
  await expect(
    page.getByRole("heading", { name: "Fri, May 21 · Room view" }),
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
  ).toHaveAttribute("href", "/public/programme/future-of-events-2027");
  await expect(
    page.getByText("Event timezone · America/Toronto"),
  ).toBeVisible();
  await expect(
    page.getByText(/May 20, 2027.*9:00 AM.*(?:EDT|GMT-4)/).first(),
  ).toBeVisible();
  const iframeCode = page.getByRole("textbox", { name: "Iframe code" });
  await expect(iframeCode).toHaveValue(
    new RegExp(`<iframe src="${e2eOrigin}/embed/future-of-events-2027`),
  );
  await expect(iframeCode).not.toHaveValue(/accent=/);
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

test("focuses the exact named schedule record", async ({ page }) => {
  const response = await page.request.get(
    "/api/v1/public/events/future-of-events-2027/programme",
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
    await createNextScheduleDraft(page);
    await expect(page.getByText(/Version \d+ · Draft/)).toBeVisible();

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
      .getByText("View the exact calendar file speakers will receive", {
        exact: true,
      })
      .click();
    await expect(preview.locator("pre")).toContainText(`SUMMARY:${title}`);

    const publicProgramme = await page.request.get(
      "/api/v1/public/events/future-of-events-2027/programme",
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
    await createNextScheduleDraft(page);
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
    await editor.getByLabel("Title").fill("Edited content returns to draft");
    await expect(editor.getByText("Saved", { exact: true })).toBeVisible({
      timeout: 10_000,
    });
    await editor.getByRole("link", { name: "Review history" }).click();
    await expect(page.getByLabel("Draft status").first()).toBeVisible();
    await expect(
      page.getByText("Title:", { exact: true }).first(),
    ).toBeVisible();

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
    await expect(
      library.getByRole("link", { name: "Open task thread" }).first(),
    ).toHaveAttribute("href", /\/admin\/tasks\?task=/);
    const disclosure = library.locator("details").first();
    await expect(disclosure).not.toHaveAttribute("open", "");
    await expect(disclosure.locator("li")).toHaveCount(0);

    const historyResponse = page.waitForResponse((response) =>
      new URL(response.url()).pathname.includes("/versions"),
    );
    await disclosure.locator("summary").click();
    expect((await historyResponse).ok()).toBeTruthy();
    await expect(disclosure.locator("li").first()).toContainText(
      /v\d+ · .*latest/,
    );
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
    await createNextScheduleDraft(page);
    await expect(page.getByText(/Version \d+ · Draft/)).toBeVisible();
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
    await createNextScheduleDraft(page);
    await expect(page.getByText(/Version \d+ · Draft/)).toBeVisible();

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
    await preview.getByLabel(titles[1]).uncheck();
    await preview.getByLabel(titles[0]).uncheck();
    await expect(
      preview.getByRole("button", { name: "Apply 0 selected placements" }),
    ).toBeDisabled();
    await preview.getByLabel(titles[0]).check();
    await expect(
      preview.getByRole("button", { name: "Apply 1 selected placement" }),
    ).toBeEnabled();
    await preview
      .getByRole("button", { name: "Apply 1 selected placement" })
      .click();

    await expectStatus(page, /Auto-place applied 1 placement/);
    await expect(
      page.getByText(/1 deselected proposal remains unscheduled/),
    ).toBeVisible();
    await expect(
      page.locator(".schedule-entry-draggable").filter({ hasText: titles[0] }),
    ).toBeVisible();
    await expect(
      page.locator(".schedule-entry-draggable").filter({ hasText: titles[1] }),
    ).toHaveCount(0);
    await expect(page.getByText(/draft.*not published/i)).toBeVisible();
    await expect(
      page.locator(".schedule-entry-draggable").filter({ hasText: titles[0] }),
    ).toHaveCount(1);
    await expect(
      page.locator(".schedule-entry-draggable").filter({ hasText: titles[1] }),
    ).toHaveCount(0);

    const publicProgramme = await page.request.get(
      "/api/v1/public/events/future-of-events-2027/programme",
    );
    expect(publicProgramme.ok()).toBeTruthy();
    const publicProgrammeBody = JSON.stringify(await publicProgramme.json());
    expect(publicProgrammeBody).not.toContain(titles[0]);
    expect(publicProgrammeBody).not.toContain(titles[1]);

    await waitForInterface(page, "/admin/schedule");
    await expect(page.getByText(/Version \d+ · Draft/)).toBeVisible();
    await expect(
      page.locator(".schedule-entry-draggable").filter({ hasText: titles[0] }),
    ).toHaveCount(1);
    await expect(
      page.locator(".schedule-entry-draggable").filter({ hasText: titles[1] }),
    ).toHaveCount(0);
  });
});

test("schedule contains its room grid and explains mobile scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await waitForInterface(page, "/admin/schedule");

  await expect(
    page.getByText("Scroll sideways to see every room"),
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
