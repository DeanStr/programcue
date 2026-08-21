import { expect, test } from "@playwright/test";

import { e2eOrigin } from "./support/e2e-origin";
import { openRecordPanel } from "./support/open-record-panel";

async function waitForInterface(
  page: import("@playwright/test").Page,
  path: string,
) {
  const response = await page.goto(path);
  expect(response?.ok()).toBeTruthy();
  await page.locator("body[data-hydrated='true']").waitFor();
}

async function selectDemoRole(
  page: import("@playwright/test").Page,
  role: "administrator" | "speaker",
) {
  await page.context().addCookies([
    {
      name: "program_cue_demo_identity",
      value: role,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

test("skip navigation and command palette preserve keyboard focus", async ({
  page,
}) => {
  await waitForInterface(page, "/admin/event");

  await page.keyboard.press("Tab");
  const skipLink = page.getByRole("link", { name: "Skip to main content" });
  await expect(skipLink).toBeFocused();
  await expect(skipLink).toHaveCSS("position", "fixed");
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();

  const trigger = page.getByRole("button", {
    name: /search or run a command/i,
  });
  const commandDialog = page.getByRole("dialog", {
    name: "Search or run a command",
  });
  await trigger.click();
  await expect(commandDialog).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Program Cue commands" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(commandDialog).toBeHidden();
  await expect(trigger).toBeFocused();

  await page.keyboard.press("Control+k");
  await expect(commandDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(commandDialog).toBeHidden();
  await expect(trigger).toBeFocused();

  const priorControl = page.getByRole("button", { name: "New", exact: true });
  await priorControl.focus();
  await expect(priorControl).toBeFocused();
  await page.keyboard.press("Control+k");
  await expect(commandDialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(commandDialog).toBeHidden();
  await expect(priorControl).toBeFocused();
});

test("administrator navigation groups stable workspace families without hiding programme tools", async ({
  page,
}) => {
  await waitForInterface(page, "/admin/programme");
  const navigation = page.getByRole("complementary", {
    name: "Primary navigation",
  });
  await expect(
    navigation.getByText("Event work", { exact: true }),
  ).toBeVisible();
  await expect(
    navigation.getByText("Administration", { exact: true }),
  ).toBeVisible();
  await navigation.getByRole("button", { name: "Collapse navigation" }).click();
  await expect(
    navigation.getByText("Event work", { exact: true }),
  ).toBeHidden();
  await expect(
    navigation.getByText("Administration", { exact: true }),
  ).toBeHidden();
  await navigation.getByRole("button", { name: "Expand navigation" }).click();
  await expect(
    navigation.getByRole("link", { name: "Session content & files" }),
  ).toBeVisible();
  await expect(
    navigation.getByRole("link", { name: "Speaker network" }),
  ).toHaveCount(0);
  await expect(
    navigation.getByRole("link", { name: "Speaker resources" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Content review" }),
  ).toHaveAttribute("href", "/admin/content#content-review-title");
  await expect(
    page.getByRole("link", { name: "File library" }),
  ).toHaveAttribute("href", "/admin/content#content-files-title");

  await waitForInterface(page, "/admin/content");
  await expect(
    page
      .getByRole("complementary", { name: "Primary navigation" })
      .getByRole("link", { name: "Session content & files" }),
  ).toHaveAttribute("aria-current", "page");

  await waitForInterface(page, "/admin/speakers");
  const main = page.locator("#main");
  await expect(
    main.getByRole("link", { name: "Speaker Network" }),
  ).toHaveAttribute("href", "/admin/crm");
  await expect(main.getByRole("link", { name: "Resources" })).toHaveAttribute(
    "href",
    "/admin/resources",
  );
  // Both are full workspaces, so the rail names them as the speaker family's
  // second level rather than marking Speakers current and contradicting the
  // breadcrumb below it.
  const speakerRail = page.getByRole("complementary", {
    name: "Primary navigation",
  });
  await expect(
    speakerRail.getByRole("link", { name: "Speaker network" }),
  ).toHaveAttribute("href", "/admin/crm");
  await expect(
    speakerRail.getByRole("link", { name: "Speaker resources" }),
  ).toHaveAttribute("href", "/admin/resources");

  await waitForInterface(page, "/admin/crm");
  const crmRail = page.getByRole("complementary", {
    name: "Primary navigation",
  });
  // The page is Speaker Network, so that is what claims aria-current. Speakers
  // marks the family instead of claiming to be the page and contradicting the
  // breadcrumb underneath it.
  await expect(
    crmRail.getByRole("link", { name: "Speaker network" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(crmRail.getByRole("link", { name: "Speakers" })).toHaveAttribute(
    "data-family-current",
    "",
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  const mobileNavigation = page.getByRole("dialog", { name: "Navigation" });
  const mobileCoreHeading = mobileNavigation.getByText("Event work", {
    exact: true,
  });
  await expect(mobileCoreHeading).toBeVisible();
  await expect(mobileCoreHeading).toHaveCSS("color", "rgb(72, 90, 85)");
  await expect(mobileCoreHeading).toHaveCSS("opacity", "1");
});

test("route announcements describe page changes but ignore same-page actions", async ({
  page,
}) => {
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
  await waitForInterface(page, "/admin/event");
  const announcement = page.locator("[data-pc-route-announcement]");
  await expect(announcement).toBeEmpty();

  await page.getByLabel("End date").fill("2025-05-19");
  await page.getByRole("button", { name: "Save event" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "End date cannot be before the start date",
  );
  await expect(announcement).toBeEmpty();

  await page.getByRole("link", { name: "Home", exact: true }).click();
  // The save was rejected, so the edited end date is still unsaved and Event
  // Setup asks before discarding it.
  await page.getByRole("button", { name: "Leave and discard" }).click();
  await expect(
    page.getByRole("heading", { name: "Command Centre", level: 1 }),
  ).toBeVisible();
  await expect(announcement).toHaveText(await page.title());
});

test("admin child-route errors preserve navigation and event context", async ({
  page,
}) => {
  const response = await page.goto("/admin/speakers/not-a-speaker");
  expect(response?.status()).toBe(404);
  await page.locator("body[data-hydrated='true']").waitFor();

  await expect(
    page.getByRole("heading", { name: "Page not found", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Primary navigation" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Switch event" }),
  ).toContainText("Future of Events 2027");
});

test("shared form errors connect labels, help and corrective links", async ({
  page,
}) => {
  await waitForInterface(page, "/design/system");

  const email = page.getByRole("textbox", { name: /operations email/i });
  await expect(email).toHaveAttribute("aria-invalid", "true");
  await expect(email).toHaveAttribute("aria-required", "true");
  const describedBy = await email.getAttribute("aria-describedby");
  expect(describedBy?.split(" ")).toHaveLength(2);

  const summary = page.getByRole("alert", { name: "There is a problem" });
  await expect(summary).toContainText(
    "Enter a complete operations email address.",
  );
  await summary.getByRole("link").click();
  await expect(email).toBeFocused();

  const pendingButton = page.getByRole("button", { name: "Saving" });
  await expect(pendingButton).toBeDisabled();
  await expect(pendingButton).toHaveAttribute("aria-busy", "true");
});

for (const path of ["/admin/submissions/form", "/design/system"] as const) {
  test(`${path} exposes a name for every form control`, async ({ page }) => {
    await waitForInterface(page, path);
    if (path === "/admin/submissions/form") {
      await page
        .getByRole("region", { name: "Visual call-for-speakers form editor" })
        .waitFor();
    }
    const unnamedControls = await page
      .locator("input:not([type='hidden']), select, textarea")
      .evaluateAll((controls) =>
        controls
          .filter((control) => {
            const element = control as HTMLInputElement;
            return (
              !element.labels?.length &&
              !element.getAttribute("aria-label") &&
              !element.getAttribute("aria-labelledby")
            );
          })
          .map((control) => control.outerHTML),
      );
    expect(unnamedControls).toEqual([]);
  });
}

test("review scoring exposes every criterion control at mobile width", async ({
  page,
}) => {
  await page.context().addCookies([
    {
      name: "program_cue_demo_identity",
      value: "evaluator",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.setViewportSize({ width: 412, height: 915 });
  await waitForInterface(page, "/review/workbench");

  for (const name of [
    "Audience relevance",
    "Content substance",
    "Practical value",
    "Delivery approach",
  ]) {
    // Each criterion scores through a segmented radio group rather than a
    // dropdown, so the chosen position is visible at rest.
    await expect(page.getByRole("radiogroup", { name })).toBeVisible();
  }
  await expect(
    page.getByRole("button", { name: "Return to organizer demo" }),
  ).toBeVisible();
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("representative shells remain usable at a 200 percent equivalent layout viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 500 });
  for (const path of [
    "/admin/submissions",
    "/apply/form",
    "/public/programme/future-of-events-2027",
    "/participant/dashboard",
    "/participant/tasks",
    "/admin/communications/compose",
    "/design/system",
  ] as const) {
    if (path.startsWith("/participant/")) await selectDemoRole(page, "speaker");
    if (path.startsWith("/admin/")) await selectDemoRole(page, "administrator");
    await waitForInterface(page, path);
    await expect(page.locator("#main")).toBeVisible();
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(
      overflow,
      `${path} should contain horizontal overflow inside its local work area`,
    ).toBeLessThanOrEqual(1);
  }
});

test("fixed mobile admin chrome does not cover the page title", async ({
  page,
}) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await waitForInterface(page, "/admin/submissions");
  const topbar = await page.locator(".topbar").boundingBox();
  const heading = await page
    .getByRole("heading", { name: "Applications", level: 1 })
    .boundingBox();
  expect(topbar).not.toBeNull();
  expect(heading).not.toBeNull();
  expect(heading!.y).toBeGreaterThanOrEqual(topbar!.y + topbar!.height);
});

test("representative surfaces have one primary main landmark and unique ids", async ({
  page,
}) => {
  for (const path of [
    "/admin/event",
    "/admin/review",
    "/apply/form",
    "/public/programme/future-of-events-2027",
    "/participant/resources",
    "/participant/tasks",
    "/admin/communications/compose",
    "/design/system",
  ] as const) {
    if (path.startsWith("/participant/")) await selectDemoRole(page, "speaker");
    if (path.startsWith("/admin/")) await selectDemoRole(page, "administrator");
    await waitForInterface(page, path);
    await expect(page.locator("main#main")).toHaveCount(1);
    const duplicateIds = await page.locator("[id]").evaluateAll((elements) => {
      const ids = elements.map((element) => element.id);
      return ids.filter((id, index) => ids.indexOf(id) !== index);
    });
    expect(duplicateIds).toEqual([]);
  }
});

test("resource authoring exposes typed click-to-load video and map blocks", async ({
  page,
}) => {
  await waitForInterface(page, "/admin/resources");
  await expect(
    page.getByLabel("Audience").getByRole("option", {
      name: "Speakers with confirmed sessions",
    }),
  ).toBeAttached();
  const editor = page.getByRole("textbox", { name: "Page content" });
  await expect(editor).toBeVisible();
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await expect(editor).toHaveAttribute("aria-multiline", "true");
  await expect(page.getByRole("button", { name: "Bold" })).toHaveAttribute(
    "aria-pressed",
  );

  await page
    .getByLabel("YouTube or Vimeo link")
    .fill("https://youtu.be/dQw4w9WgXcQ?t=42");
  await page.getByRole("button", { name: "Add video" }).click();
  const video = page.locator(
    ".resource-live-preview .resource-external-embed--youtube",
  );
  await expect(video).toContainText("YouTube video");
  await expect(
    video.getByRole("link", { name: /Open on YouTube/ }),
  ).toHaveAttribute("href", "https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  await video.getByRole("button", { name: "Load video from YouTube" }).click();
  await expect(video.locator("iframe")).toHaveAttribute(
    "src",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
  );
  await expect(video.locator("iframe")).toHaveAttribute(
    "sandbox",
    "allow-scripts allow-same-origin",
  );

  await page.getByRole("button", { name: "Map", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Venue or address" })
    .fill("Barbican Centre, London");
  await page.getByRole("button", { name: "Add map" }).click();
  const map = page.locator(
    ".resource-live-preview .resource-external-embed--google_maps",
  );
  await expect(map).toContainText("Map of Barbican Centre, London");
  await expect(
    map.getByRole("link", { name: /Open in Google Maps/ }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Move Google Maps block up" }).click();
  await expect(video.locator("iframe")).toHaveCount(0);
  await expect(
    video.getByRole("button", { name: "Load video from YouTube" }),
  ).toBeVisible();
  await expect(
    map.getByRole("button", { name: "Load map from Google Maps" }),
  ).toBeVisible();
  await map.getByRole("button", { name: "Load map from Google Maps" }).click();
  await expect(map.locator("iframe")).toHaveAttribute(
    "src",
    /https:\/\/www\.google\.com\/maps\/embed\/v1\/place\?.*q=Barbican\+Centre%2C\+London/,
  );
  await expect(map.locator("iframe")).toHaveAttribute(
    "sandbox",
    "allow-scripts allow-same-origin allow-popups",
  );

  await page.getByRole("button", { name: "Video", exact: true }).click();
  await page
    .getByLabel("YouTube or Vimeo link")
    .fill("https://youtu.be/aqz-KE-bpKQ");
  await expect(page.locator('input[name="externalEmbedDraft"]')).toHaveValue(
    "https://youtu.be/aqz-KE-bpKQ",
  );
  await page.getByRole("button", { name: "Map", exact: true }).click();
  await expect(page.locator('input[name="externalEmbedDraft"]')).toHaveValue(
    "",
  );
  await page
    .getByRole("textbox", { name: "Venue or address" })
    .fill("Unfinished venue");
  await page.getByRole("button", { name: "Video", exact: true }).click();
  await expect(page.locator('input[name="externalEmbedDraft"]')).toHaveValue(
    "",
  );
});

test("CRM horizontal regions expose a keyboard scrolling target", async ({
  page,
}) => {
  await waitForInterface(page, "/admin/crm");
  const directory = page.getByRole("region", {
    name: "Speaker contact directory",
  });
  await directory.focus();
  await expect(directory).toBeFocused();

  await waitForInterface(page, "/admin/crm/pipeline");
  const pipeline = page.getByRole("region", {
    name: "Speaker sourcing stages",
  });
  await pipeline.focus();
  await expect(pipeline).toBeFocused();
});

test("custom toggles retain their complete track at desktop and phone widths", async ({
  page,
}) => {
  for (const viewport of [
    { width: 1440, height: 1000 },
    { width: 375, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await waitForInterface(page, "/admin/event");
    // The first toggles on this page are a track's Exclusive/Public pair, which
    // now sit inside a collapsed record panel.
    await openRecordPanel(page, "Programme tracks");
    const toggle = page.locator('label.toggle input[type="checkbox"]').first();
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveCSS("width", "36px");
    await expect(toggle).toHaveCSS("height", "20px");
    expect(
      await toggle.evaluate((element) =>
        getComputedStyle(element, "::after").getPropertyValue("width"),
      ),
    ).toBe("16px");
  }
});

test("server-rendered timestamps hydrate in a non-UTC browser timezone", async ({
  browser,
}) => {
  const context = await browser.newContext({
    baseURL: e2eOrigin,
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
  });
  const page = await context.newPage();
  const hydrationErrors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /hydration|didn't match/i.test(message.text())
    )
      hydrationErrors.push(message.text());
  });
  for (const path of [
    "/admin/operations",
    "/admin/settings",
    "/admin/submissions/form",
    "/participant/resources",
    "/admin/communications/compose",
    "/admin/integrations",
  ] as const) {
    if (path.startsWith("/participant/")) await selectDemoRole(page, "speaker");
    if (path.startsWith("/admin/")) await selectDemoRole(page, "administrator");
    await waitForInterface(page, path);
  }
  expect(hydrationErrors).toEqual([]);
  await context.close();
});
