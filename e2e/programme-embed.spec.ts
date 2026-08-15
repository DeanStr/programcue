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

test("configures, previews and copies a constrained programme embed", async ({
  page,
  context,
}) => {
  await waitForInterface(page, "/admin/programme");
  await expect(
    page.getByRole("heading", { name: "Configure embed" }),
  ).toBeVisible();

  await page.getByLabel("Initial day").selectOption("2027-05-21");
  await page.getByLabel("Initial track").selectOption("AI & Innovation");
  await page.getByLabel("Initial format").selectOption("breakout");
  await page.getByLabel("Initial room").selectOption("Room 303");
  await page.getByLabel("Search text").fill("Building");
  const visitorControls = page.getByRole("group", {
    name: "Visible visitor controls",
  });
  await visitorControls.getByLabel("Day", { exact: true }).uncheck();
  await visitorControls.getByLabel("Track", { exact: true }).uncheck();
  await visitorControls.getByLabel("Format", { exact: true }).uncheck();
  await visitorControls.getByLabel("Room", { exact: true }).uncheck();
  await page.getByLabel("Density").selectOption("compact");
  await page.getByLabel("Include the speaker directory").uncheck();

  const preview = page.locator(".programme-embed-preview iframe");
  await expect(preview).toHaveAttribute(
    "src",
    /\/embed\/future-of-events-2027\/sessions\?day=2027-05-21.*track=AI\+%26\+Innovation.*format=breakout.*room=Room\+303.*query=Building.*controls=search.*density=compact.*directory=hide/,
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

  await expect(
    page.getByRole("textbox", { name: "Iframe code", exact: true }),
  ).toHaveValue(/controls=search.*density=compact.*directory=hide/);
  await page.getByLabel("Installation format").selectOption("widget");
  const widgetCode = page.getByRole("textbox", {
    name: "Auto-resizing widget code",
    exact: true,
  });
  await expect(widgetCode).toHaveValue(
    /programcue-widget\.js.*data-surface="sessions".*data-day="2027-05-21".*data-track="AI &amp; Innovation".*data-format="breakout".*data-room="Room 303".*data-query="Building".*data-controls="search".*data-density="compact".*data-directory="hide"/s,
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
  await expect(widgetCode).toHaveValue("");
  await expect(page.getByRole("button", { name: "Copy code" })).toBeDisabled();

  await page.getByLabel("Initial height").fill("640");
  await expect(page.getByLabel("Initial height")).not.toHaveAttribute(
    "aria-invalid",
    "true",
  );
  await expect(widgetCode).toHaveValue(/data-height="640"/);
  await expect(page.getByRole("button", { name: "Copy code" })).toBeEnabled();
});

test("saves and controls a stable managed embed lifecycle", async ({ page }) => {
  await waitForInterface(page, "/admin/programme");
  await expect(
    page.getByRole("heading", { name: "Managed embeds" }),
  ).toBeVisible();
  await page.getByLabel("Embed name").fill("Conference homepage");
  await page.getByLabel("Stable slug").fill("e2e-homepage");
  await page
    .getByLabel("Installation note (optional)")
    .fill("Homepage below the hero");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(
    page.getByText("Managed embed saved as a draft."),
  ).toBeVisible();

  const row = page.getByRole("row").filter({ hasText: "Conference homepage" });
  await expect(row).toContainText("draft");
  await row.getByRole("button", { name: "Load and preview" }).click();
  await expect(page.getByText(/Current revision 1/)).toBeVisible();
  await row.getByLabel("I previewed this configuration.").check();
  await row.getByRole("button", { name: "Activate" }).click();
  await expect(page.getByText("Managed embed activated.")).toBeVisible();

  const active = await page.request.get(
    "/embed/future-of-events-2027/saved/e2e-homepage",
  );
  expect(active.status()).toBe(200);
  const activeRow = page.getByRole("row").filter({ hasText: "Conference homepage" });
  await activeRow
    .getByLabel("I confirm visitors will see an unavailable response.")
    .check();
  await activeRow.getByRole("button", { name: "Pause" }).click();
  await expect(
    page.getByRole("row").filter({ hasText: "Conference homepage" }),
  ).toContainText("paused");
  const paused = await page.request.get(
    "/embed/future-of-events-2027/saved/e2e-homepage",
  );
  expect(paused.status()).toBe(503);
  expect(paused.headers()["retry-after"]).toBe("300");

  const pausedRow = page.getByRole("row").filter({ hasText: "Conference homepage" });
  await pausedRow
    .getByLabel("I understand this URL will permanently return 410.")
    .check();
  await pausedRow.getByRole("button", { name: "Revoke" }).click();
  await expect(
    page.getByRole("row").filter({ hasText: "Conference homepage" }),
  ).toContainText("revoked");
  const revoked = await page.request.get(
    "/embed/future-of-events-2027/saved/e2e-homepage",
  );
  expect(revoked.status()).toBe(410);
});

test("previews every public widget type and applies granular field selection", async ({
  page,
}) => {
  await waitForInterface(page, "/admin/programme");
  const preview = page.locator(".programme-embed-preview iframe");
  const widgetTypes = [
    ["speakers", "Speakers"],
    ["agenda", "Agenda"],
    ["schedule", "Schedule Itinerary"],
    ["gallery", "Speaker Gallery"],
    ["sessions", null],
  ] as const;

  for (const [surface, heading] of widgetTypes) {
    await page.getByLabel("Public surface").selectOption(surface);
    await expect(preview).toHaveAttribute(
      "src",
      new RegExp(`/embed/future-of-events-2027/${surface}`),
    );
    const frame = preview.contentFrame();
    await frame.locator("body[data-hydrated='true']").waitFor();
    if (heading) {
      await expect(
        frame.getByRole("heading", { name: heading, exact: true }),
      ).toBeVisible();
    } else {
      await expect(frame.locator(".programme-row").first()).toBeVisible();
    }
  }

  await page.getByLabel("Public surface").selectOption("agenda");
  await page.getByLabel("Time and duration").uncheck();
  await page.getByLabel("Room and location").uncheck();
  await page.getByLabel("Descriptions").uncheck();
  await expect(preview).toHaveAttribute("src", /fields=/);
  const agendaFrame = preview.contentFrame();
  await agendaFrame.locator("body[data-hydrated='true']").waitFor();
  await expect(agendaFrame.locator(".agenda-card-title").first()).toBeVisible();
  await expect(
    agendaFrame.getByLabel("Search sessions, speakers, or topics"),
  ).toBeVisible();
  await expect(agendaFrame.getByLabel("Filter by day")).toBeVisible();
  await expect(agendaFrame.locator(".agenda-card-time")).toHaveCount(0);
  await expect(agendaFrame.locator(".session-place")).toHaveCount(0);
  await expect(agendaFrame.locator(".agenda-card-description")).toHaveCount(0);

  await page.getByLabel("Installation format").selectOption("widget");
  await expect(
    page.getByRole("textbox", {
      name: "Auto-resizing widget code",
      exact: true,
    }),
  ).toHaveValue(/data-surface="agenda".*data-fields=/s);

  await page.getByLabel("Speaker detail blocks and profile links").uncheck();

  await page.getByLabel("Public surface").selectOption("sessions");
  let fieldFrame = preview.contentFrame();
  await fieldFrame.locator("body[data-hydrated='true']").waitFor();
  await expect(
    fieldFrame.locator(".programme-row .speaker").first(),
  ).toBeVisible();
  await expect(fieldFrame.locator(".programme-row .avatar")).toHaveCount(0);
  await expect(
    fieldFrame.locator("#speakers .public-speaker-card h3").first(),
  ).toBeVisible();
  await expect(
    fieldFrame.locator("#speakers .public-speaker-card .avatar"),
  ).toHaveCount(0);
  await expect(
    fieldFrame.locator("#speakers .public-speaker-card-bio"),
  ).toHaveCount(0);
  await expect(
    fieldFrame.locator("#speakers .public-speaker-card-foot"),
  ).toHaveCount(0);
  await expect(
    fieldFrame.getByRole("link", { name: /View profile and sessions/i }),
  ).toHaveCount(0);

  for (const surface of ["agenda", "schedule"] as const) {
    await page.getByLabel("Public surface").selectOption(surface);
    fieldFrame = preview.contentFrame();
    await fieldFrame.locator("body[data-hydrated='true']").waitFor();
    await expect(
      fieldFrame.locator(".public-session-speaker-names").first(),
    ).toBeVisible();
    await expect(fieldFrame.locator(".public-session-speakers")).toHaveCount(0);
    if (surface === "agenda") {
      await expect(
        fieldFrame.locator(
          ".public-surface-detail .public-session-speaker-names",
        ),
      ).toBeVisible();
    }
  }

  await page.getByLabel("Public surface").selectOption("speakers");
  fieldFrame = preview.contentFrame();
  await fieldFrame.locator("body[data-hydrated='true']").waitFor();
  await expect(
    fieldFrame.locator("div.public-speaker-directory-trigger").first(),
  ).toBeVisible();
  await expect(
    fieldFrame.locator("button.public-speaker-directory-trigger"),
  ).toHaveCount(0);
  await expect(
    fieldFrame.locator(".public-speaker-directory-card img"),
  ).toHaveCount(0);
  await expect(
    fieldFrame.locator(".public-speaker-directory-card .help"),
  ).toHaveCount(0);
  await expect(fieldFrame.getByRole("dialog")).toHaveCount(0);

  await page.getByLabel("Public surface").selectOption("gallery");
  fieldFrame = preview.contentFrame();
  await fieldFrame.locator("body[data-hydrated='true']").waitFor();
  await expect(
    fieldFrame.locator("article.speaker-gallery-card").first(),
  ).toBeVisible();
  await expect(fieldFrame.locator("button.speaker-gallery-card")).toHaveCount(
    0,
  );
  await expect(fieldFrame.locator(".speaker-gallery-card img")).toHaveCount(0);
  await expect(
    fieldFrame.locator(".speaker-gallery-card-sessions"),
  ).toHaveCount(0);
  await expect(fieldFrame.getByRole("dialog")).toHaveCount(0);
});

test("rejects unsupported embed configuration instead of silently falling back", async ({
  page,
}) => {
  const invalidControls = await page.request.get(
    "/embed/future-of-events-2027?controls=search,unknown",
  );
  expect(invalidControls.status()).toBe(400);
  expect(await invalidControls.text()).toContain(
    "Embed controls must be a unique comma-separated selection",
  );

  const staleFormat = await page.request.get(
    "/embed/future-of-events-2027?format=not-published",
  );
  expect(staleFormat.status()).toBe(400);
  expect(await staleFormat.text()).toContain(
    "Embed format must identify a published format",
  );

  for (const name of ["day", "track", "format", "room", "accent"]) {
    const emptyValue = await page.request.get(
      `/embed/future-of-events-2027?${name}=`,
    );
    expect(emptyValue.status()).toBe(400);
    expect(await emptyValue.text()).toContain(
      `Embed ${name} must not be empty when provided`,
    );
  }

  const unknownParameter = await page.request.get(
    "/embed/future-of-events-2027?densitty=compact",
  );
  expect(unknownParameter.status()).toBe(400);
  expect(await unknownParameter.text()).toContain(
    "Embed configuration contains an unsupported parameter",
  );

  const duplicateParameter = await page.request.get(
    "/embed/future-of-events-2027?density=compact&density=comfortable",
  );
  expect(duplicateParameter.status()).toBe(400);
  expect(await duplicateParameter.text()).toContain(
    "Embed parameter density must appear at most once",
  );

  const invalidFields = await page.request.get(
    "/embed/future-of-events-2027/sessions?fields=time,sponsors",
  );
  expect(invalidFields.status()).toBe(400);
  expect(await invalidFields.text()).toContain(
    "Embed fields must be a unique comma-separated selection",
  );

  const invalidSurface = await page.request.get(
    "/embed/future-of-events-2027/timeline",
  );
  expect(invalidSurface.status()).toBe(404);
  expect(await invalidSurface.text()).toContain(
    "Embed surface must be sessions, speakers, agenda, schedule or gallery",
  );
});

test("widget preserves invalid options for rejection and fails before mounting", async ({
  page,
}) => {
  await page.route(`${e2eOrigin}/__programcue-widget-empty-option`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `
        <div id="programme-widget"></div>
        <script src="${e2eOrigin}/programcue-widget.js"
          data-programcue-event="future-of-events-2027"
          data-target="#programme-widget"
          data-controls=""></script>
      `,
    }),
  );
  const rejectedEmbed = page.waitForResponse(
    (response) =>
      response
        .url()
        .includes("/embed/future-of-events-2027/sessions?controls=") &&
      response.status() === 400,
  );
  await page.goto(`${e2eOrigin}/__programcue-widget-empty-option`);
  await rejectedEmbed;
  await expect(page.locator("#programme-widget iframe")).toHaveAttribute(
    "src",
    /\/embed\/future-of-events-2027\/sessions\?controls=$/,
  );

  await page.route(`${e2eOrigin}/__programcue-widget-empty-height`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `
        <div id="programme-widget"></div>
        <script src="${e2eOrigin}/programcue-widget.js"
          data-programcue-event="future-of-events-2027"
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

  await page.route(
    `${e2eOrigin}/__programcue-widget-invalid-surface`,
    (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `
        <div id="programme-widget"></div>
        <script src="${e2eOrigin}/programcue-widget.js"
          data-programcue-event="future-of-events-2027"
          data-target="#programme-widget"
          data-surface="timeline"></script>
      `,
      }),
  );
  const surfaceError = page.waitForEvent("pageerror");
  await page.goto(`${e2eOrigin}/__programcue-widget-invalid-surface`);
  await expect(surfaceError).resolves.toHaveProperty(
    "message",
    "Program Cue widget data-surface must be sessions, speakers, agenda, schedule or gallery.",
  );
  await expect(page.locator("#programme-widget iframe")).toHaveCount(0);

  await page.route(`${e2eOrigin}/__programcue-widget-empty-surface`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `
        <div id="programme-widget"></div>
        <script src="${e2eOrigin}/programcue-widget.js"
          data-programcue-event="future-of-events-2027"
          data-target="#programme-widget"
          data-surface=""></script>
      `,
    }),
  );
  const emptySurfaceError = page.waitForEvent("pageerror");
  await page.goto(`${e2eOrigin}/__programcue-widget-empty-surface`);
  await expect(emptySurfaceError).resolves.toHaveProperty(
    "message",
    "Program Cue widget data-surface must be sessions, speakers, agenda, schedule or gallery.",
  );
  await expect(page.locator("#programme-widget iframe")).toHaveCount(0);
});

test("exports static programme files and mounts a filtered auto-resizing widget", async ({
  page,
}) => {
  const jsonExport = await page.request.get(
    "/api/v1/public/events/future-of-events-2027/programme?format=json",
  );
  expect(jsonExport.ok()).toBeTruthy();
  expect(jsonExport.headers()["content-disposition"]).toContain(
    "future-of-events-2027-programme.json",
  );
  expect((await jsonExport.json()).speakers.length).toBeGreaterThan(0);

  const htmlExport = await page.request.get(
    "/api/v1/public/events/future-of-events-2027/programme?format=html",
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
            data-programcue-event="future-of-events-2027"
            data-target="#programme-widget"
            data-surface="agenda"
            data-day="2027-05-21"
            data-accent="#0d9488"
            data-controls="search"
            data-density="compact"
            data-fields="location,track,format,speaker-details"></script>
        `,
    }),
  );
  await page.goto(`${e2eOrigin}/__programcue-widget-host`);
  const frame = page.locator("#programme-widget iframe");
  await expect(frame).toHaveAttribute(
    "src",
    /\/embed\/future-of-events-2027\/agenda\?day=2027-05-21&accent=%230d9488&controls=search&density=compact&fields=location%2Ctrack%2Cformat%2Cspeaker-details$/,
  );
  await frame.contentFrame().locator("body[data-hydrated='true']").waitFor();
  await expect(
    frame.contentFrame().locator(".public-shell.embed-compact"),
  ).toBeVisible();
  await expect(
    frame.contentFrame().locator(".public-filters select"),
  ).toHaveCount(0);
  await expect(frame.contentFrame().locator(".agenda-card")).toHaveCount(2);
  await expect(frame.contentFrame().locator(".agenda-card-time")).toHaveCount(
    0,
  );
  await expect(
    frame.contentFrame().locator(".agenda-card-description"),
  ).toHaveCount(0);
  await expect
    .poll(async () =>
      Number.parseInt(await frame.evaluate((node) => node.style.height), 10),
    )
    .toBeGreaterThan(720);
});

test("keeps programme detail panels inside the active embed filters", async ({
  page,
}) => {
  await waitForInterface(page, "/embed/future-of-events-2027?day=2027-05-21");
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
    "/embed/future-of-events-2027?query=no-published-record-matches-this",
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

test("keeps omitted fields out of session and speaker detail views", async ({
  page,
}) => {
  await waitForInterface(
    page,
    "/embed/future-of-events-2027/sessions?fields=sessions,speaker-details",
  );

  const sessionDetail = page.locator(".session-detail-panel");
  await expect(sessionDetail.locator(".session-detail-when")).toHaveCount(0);
  await expect(sessionDetail.locator(".session-place")).toHaveCount(0);
  await expect(
    sessionDetail.locator(".session-detail-classification"),
  ).toHaveCount(0);

  await page
    .locator("#speakers > .grid article")
    .filter({ hasText: "Priya Shah" })
    .getByRole("link", { name: "View profile and sessions" })
    .click();
  const speakerProfile = page.locator("#speakers article[aria-live='polite']");
  await expect(speakerProfile).not.toContainText("Pronunciation");
  const linkedSession = speakerProfile.locator(".stack a").first();
  await expect(linkedSession).toBeVisible();
  await expect(linkedSession).not.toContainText(/\b(?:AM|PM|Room)\b/);

  await waitForInterface(
    page,
    "/embed/future-of-events-2027/sessions?fields=sessions",
  );
  await expect(
    page.locator(".session-detail-panel").getByRole("link", {
      name: /View .+ profile/,
    }),
  ).toHaveCount(0);

  await waitForInterface(
    page,
    "/embed/future-of-events-2027/sessions?fields=none",
  );
  await expect(page.locator(".programme-row h3").first()).toBeVisible();
  await expect(page.locator(".programme-row .speaker").first()).toBeVisible();
  await expect(page.locator(".programme-row .avatar")).toHaveCount(0);
  await expect
    .poll(() =>
      page
        .locator(".programme-row")
        .first()
        .evaluate(
          (element) =>
            getComputedStyle(element).gridTemplateColumns.split(" ").length,
        ),
    )
    .toBe(1);

  await waitForInterface(
    page,
    "/embed/future-of-events-2027/schedule?fields=none",
  );
  await expect
    .poll(() =>
      page
        .locator(".public-itinerary-card")
        .first()
        .evaluate(
          (element) =>
            getComputedStyle(element).gridTemplateColumns.split(" ").length,
        ),
    )
    .toBe(1);

  await waitForInterface(
    page,
    "/embed/future-of-events-2027/agenda?fields=none",
  );
  await expect(page.locator(".programme-day-divider")).toHaveCount(2);
  await expect(page.locator(".agenda-board")).toHaveCount(2);
});
