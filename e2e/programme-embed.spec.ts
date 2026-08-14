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
    /day=2027-05-21.*track=AI\+%26\+Innovation.*format=breakout.*room=Room\+303.*query=Building.*controls=search.*density=compact.*speakers=hide/,
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
    /programcue-widget\.js.*data-day="2027-05-21".*data-track="AI &amp; Innovation".*data-format="breakout".*data-room="Room 303".*data-query="Building".*data-controls="search".*data-density="compact".*data-speakers="hide"/s,
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
          data-programcue-event="future-of-events-2027"
          data-target="#programme-widget"
          data-controls=""></script>
      `,
    }),
  );
  const rejectedEmbed = page.waitForResponse(
    (response) =>
      response.url().includes("/embed/future-of-events-2027?controls=") &&
      response.status() === 400,
  );
  await page.goto(`${e2eOrigin}/__programcue-widget-empty-option`);
  await rejectedEmbed;
  await expect(page.locator("#programme-widget iframe")).toHaveAttribute(
    "src",
    /\/embed\/future-of-events-2027\?controls=$/,
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
            data-day="2027-05-21"
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
    /\/embed\/future-of-events-2027\?day=2027-05-21&accent=%230d9488&controls=search&density=compact$/,
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
