import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  prepareVisualBaseline,
  seedVisualAcceleventsFailure,
  seedVisualAssistantProposal,
} from "./support/prepare-visual-baseline";
import { resetDemoEvent } from "./support/reset-demo-event";

// Every core rendered product surface is represented here. These snapshots protect the current
// product-quality baseline; they are not pixel-parity checks against the removed prototype.
// `/` and `/sign-in` redirect in the evaluator environment, resource routes are non-visual, and
// signed utility flows such as email preferences use focused browser-behavior coverage instead.
type DemoRole = "owner" | "evaluator" | "speaker";

type Surface = {
  name: string;
  path: string;
  role?: DemoRole;
};

const SURFACES: readonly Surface[] = [
  { name: "demo-guide", path: "/demo" },
  { name: "event-setup", path: "/admin/event" },
  {
    name: "file-retention",
    path: "/admin/files/retention",
    role: "owner",
  },
  { name: "event-clone", path: "/admin/events/clone", role: "owner" },
  { name: "command-centre", path: "/admin/command" },
  { name: "form-builder", path: "/admin/submissions/form" },
  { name: "evaluation-admin", path: "/admin/review" },
  {
    name: "review-workbench",
    path: "/review/workbench",
    role: "evaluator",
  },
  { name: "speakers-list", path: "/admin/speakers" },
  { name: "resources-admin", path: "/admin/resources" },
  { name: "session-bulk", path: "/admin/sessions/bulk" },
  { name: "communications", path: "/admin/communications" },
  { name: "task-bulk", path: "/admin/tasks/bulk" },
  { name: "programme-admin", path: "/admin/programme" },
  { name: "integrations", path: "/admin/integrations" },
  { name: "settings", path: "/admin/settings" },
  {
    name: "public-programme",
    path: "/public/programme/future-of-events-2025",
  },
  {
    name: "programme-embed",
    path: "/embed/future-of-events-2025",
  },
  { name: "public-application", path: "/apply/form" },
  {
    name: "speaker-dashboard",
    path: "/speaker/dashboard",
    role: "speaker",
  },
  { name: "speaker-sessions", path: "/speaker/sessions", role: "speaker" },
  { name: "speaker-tasks", path: "/speaker/tasks", role: "speaker" },
  { name: "speaker-files", path: "/speaker/files", role: "speaker" },
  { name: "speaker-profile", path: "/speaker/profile", role: "speaker" },
  {
    name: "speaker-resources",
    path: "/speaker/resources",
    role: "speaker",
  },
];

async function selectDemoRole(page: Page, role: DemoRole) {
  await page.context().addCookies([
    {
      name: "program_cue_demo_role",
      value: role,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

async function selectCurrentEvent(page: Page) {
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
}

async function openHydrated(page: Page, path: string) {
  const response = await page.goto(path);
  expect(response?.ok(), `${path} should load`).toBe(true);
  await page.locator("body[data-hydrated='true']").waitFor();
  await page.evaluate(() => document.fonts.ready);
}

async function expectDocumentContained(page: Page, context: string) {
  const containment = await page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth;
    const overflow = document.documentElement.scrollWidth - viewportWidth;
    const describe = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) return null;
      const bounds = element.getBoundingClientRect();
      const styles = getComputedStyle(element);
      return {
        selector,
        left: Math.round(bounds.left),
        right: Math.round(bounds.right),
        width: Math.round(bounds.width),
        minWidth: styles.minWidth,
        gridTemplateColumns: styles.gridTemplateColumns,
      };
    };
    const identify = (element: Element) => {
      const classes = element
        .getAttribute("class")
        ?.trim()
        .replace(/\s+/g, ".");
      return `${element.localName}${element.id ? `#${element.id}` : ""}${classes ? `.${classes}` : ""}`;
    };
    const offenders = Array.from(document.body.querySelectorAll("*"))
      .map((element) => {
        const bounds = element.getBoundingClientRect();
        return {
          element: identify(element),
          right: Math.round(bounds.right),
          width: Math.round(bounds.width),
          hasOverflowingChild: Array.from(element.children).some(
            (child) => child.getBoundingClientRect().right > viewportWidth + 1,
          ),
        };
      })
      .filter(
        ({ right, hasOverflowingChild }) =>
          right > viewportWidth + 1 && !hasOverflowingChild,
      )
      .sort((left, right) => right.right - left.right)
      .slice(0, 5);
    const scrollOffenders = Array.from(document.body.querySelectorAll("*"))
      .map((element) => ({
        element: identify(element),
        clientWidth: element.clientWidth,
        scrollWidth: element.scrollWidth,
        overflowX: getComputedStyle(element).overflowX,
      }))
      .filter(
        ({ clientWidth, scrollWidth, overflowX }) =>
          scrollWidth > clientWidth + 1 &&
          !["auto", "scroll", "hidden", "clip"].includes(overflowX),
      )
      .sort(
        (left, right) =>
          right.scrollWidth -
          right.clientWidth -
          (left.scrollWidth - left.clientWidth),
      )
      .slice(0, 8);
    return {
      overflow,
      viewportWidth,
      innerWidth: window.innerWidth,
      visualViewportWidth: Math.round(window.visualViewport?.width ?? 0),
      containers: [
        describe("body"),
        describe(".app-admin"),
        describe(".topbar"),
        describe("main#main"),
        describe(".command-mid"),
      ],
      offenders,
      scrollOffenders,
    };
  });
  expect(
    containment.overflow,
    `${context} should contain horizontal overflow inside its local work area; diagnostics: ${JSON.stringify(containment)}`,
  ).toBeLessThanOrEqual(1);
}

async function waitForSurfaceReady(page: Page, name: string) {
  if (name === "demo-guide") {
    await expect(
      page.getByRole("heading", { name: "Provider truth" }),
    ).toBeVisible();
  } else if (name === "file-retention") {
    await expect(
      page.getByRole("heading", {
        name: "Anonymise expired participant data",
      }),
    ).toBeVisible();
  } else if (name === "form-builder") {
    const editor = page.getByRole("region", {
      name: "Visual call-for-speakers form editor",
    });
    await expect(editor.locator(".fjs-editor-container")).toBeVisible();
    await expect(
      page.getByText(
        /Visual editor ready|Visual form and Program Cue draft are synchronized/,
      ),
    ).toBeVisible();
  } else if (name === "communications") {
    await expect(
      page.getByText("Operations Queue bound", { exact: true }),
    ).toBeVisible();
  } else if (name === "settings") {
    await expect(
      page.getByRole("heading", { name: "Create an outbound webhook" }),
    ).toBeVisible();
  }
}

async function captureState(page: Page, target: Locator, name: string) {
  await expect(target).toBeVisible();
  const unrelatedFixedChrome = await page.addStyleTag({
    content: ".topbar, .skip-link { visibility: hidden !important; }",
  });
  try {
    await expect(target).toHaveScreenshot(`${name}.png`);
  } finally {
    await unrelatedFixedChrome.evaluate((style) =>
      style.parentNode?.removeChild(style),
    );
  }
  await expectDocumentContained(page, name);
}

test.describe.serial("responsive visual inventory", () => {
  test.beforeAll(async ({ request }) => {
    await prepareVisualBaseline(request);
  });

  test.afterAll(async ({ request }) => {
    await resetDemoEvent(request);
  });

  for (const surface of SURFACES) {
    test(`${surface.name} uses the Program Cue visual system`, async ({
      page,
    }, testInfo) => {
      if (surface.role) await selectDemoRole(page, surface.role);
      await openHydrated(page, surface.path);
      await expect(
        page.getByRole("heading", { level: 1 }).first(),
      ).toBeVisible();
      await waitForSurfaceReady(page, surface.name);
      const isolateFixedSpeakerNavigation =
        testInfo.project.name === "mobile-chromium" &&
        surface.name.startsWith("speaker-");
      let fixedNavigationStyle: Awaited<
        ReturnType<Page["addStyleTag"]>
      > | null = null;
      if (isolateFixedSpeakerNavigation) {
        const navigation = page.locator(".speaker-nav");
        await captureState(page, navigation, `${surface.name}-navigation`);
        fixedNavigationStyle = await page.addStyleTag({
          content: ".speaker-nav { visibility: hidden !important; }",
        });
      }
      try {
        await expect(page.locator("body")).toHaveScreenshot(
          `${surface.name}.png`,
        );
      } finally {
        await fixedNavigationStyle?.evaluate((style) =>
          style.parentNode?.removeChild(style),
        );
      }
      await expectDocumentContained(page, surface.name);
    });
  }

  test("command palette has a contained searched state", async ({ page }) => {
    await openHydrated(page, "/admin/command");
    await page
      .getByRole("button", { name: /Search or run a command/i })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Search or run a command",
    });
    await dialog
      .getByRole("combobox", { name: "Program Cue commands" })
      .fill("settings");
    await expect(
      dialog.getByText("Settings", { exact: true }).first(),
    ).toBeVisible();
    await captureState(page, dialog, "command-palette-settings");
  });

  test("exact event time disclosure remains visible at the viewport edge", async ({
    page,
  }) => {
    await openHydrated(page, "/admin/tasks");
    const eventTime = page.locator(".pc-event-time").first();
    await eventTime.focus();
    await expect(eventTime).toBeFocused();
    await expect(eventTime).toHaveAttribute(
      "data-exact-time",
      /America\/Toronto/,
    );
    await expect(page).toHaveScreenshot("event-time-focus-disclosure.png");
    await expectDocumentContained(page, "event-time-focus-disclosure");
  });

  test("event switcher contains the current event at every visual width", async ({
    page,
  }) => {
    await openHydrated(page, "/admin/command");
    await page.getByRole("button", { name: "Switch event" }).click();
    const dialog = page.getByRole("dialog", { name: "Current event" });
    const currentEvent = dialog.locator("form").filter({ hasText: "Current" });
    await expect(currentEvent).toHaveCount(1);
    const currentStatus = currentEvent.getByText("Current", { exact: true });
    await expect(currentStatus).toBeVisible();
    const [eventBox, statusBox] = await Promise.all([
      currentEvent.boundingBox(),
      currentStatus.boundingBox(),
    ]);
    expect(eventBox).not.toBeNull();
    expect(statusBox).not.toBeNull();
    expect(statusBox!.x).toBeGreaterThanOrEqual(eventBox!.x);
    expect(statusBox!.x + statusBox!.width).toBeLessThanOrEqual(
      eventBox!.x + eventBox!.width,
    );
    await captureState(page, currentEvent, "event-switcher-current-event");

    const box = await dialog.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height);

    await openHydrated(page, "/events/select");
    const defaultEvent = page.locator("main form").filter({
      hasText: "Future of Events 2025",
    });
    await defaultEvent.getByRole("button", { name: "Use this event" }).click();
    await expect(page).toHaveURL(/\/admin\/event$/);
    await openHydrated(page, "/events/select");
    const selectorCurrentEvent = page.locator("main form").filter({
      has: page.getByRole("button", { name: "Continue with current event" }),
    });
    await expect(selectorCurrentEvent).toHaveCount(1);
    await captureState(
      page,
      selectorCurrentEvent,
      "event-selector-current-event",
    );
  });

  test("assistant write preview shows the exact approval boundary", async ({
    page,
    request,
  }) => {
    const fixture = await seedVisualAssistantProposal(request);
    await openHydrated(page, "/admin/assistant");
    const proposal = page.locator("section.card").filter({
      has: page.getByText(fixture.taskTitle, { exact: true }),
    });
    await expect(
      proposal.getByText("Approval required", { exact: true }),
    ).toBeVisible();
    await captureState(page, proposal, "assistant-write-preview");
  });

  test("submission grid exposes selection, density and column controls", async ({
    page,
  }) => {
    await openHydrated(page, "/admin/submissions");
    const queue = page.locator("section.card").filter({
      has: page.getByRole("heading", { name: "Application queue" }),
    });
    await queue
      .getByRole("checkbox", { name: /^Select (?!every application)/ })
      .first()
      .check();
    await queue.getByLabel("Density").selectOption("compact");
    await queue.locator("summary").filter({ hasText: "Columns" }).click();
    await expect(
      queue.getByRole("group", { name: "Visible columns" }),
    ).toBeVisible();
    await captureState(page, queue, "submission-grid-controls");
  });

  test("likely duplicate speaker warning keeps confirmation consequential", async ({
    page,
  }) => {
    await selectCurrentEvent(page);
    await openHydrated(page, "/admin/submissions");
    await page
      .getByText("Create a guaranteed direct session", { exact: true })
      .click();
    const directSession = page.locator("details").filter({
      has: page.getByText("Create a guaranteed direct session", {
        exact: true,
      }),
    });
    await directSession
      .getByLabel("Session title")
      .fill("Visual duplicate identity guard");
    await directSession.getByLabel("Track").selectOption({ index: 1 });
    await directSession.getByLabel("Speaker 1 name").fill("Priya Shah");
    await directSession.getByLabel("Email").fill("priya.speaker@example.com");
    await directSession
      .getByRole("button", { name: "Create unscheduled session" })
      .click();
    await expect(
      directSession.getByRole("heading", { name: "Likely existing person" }),
    ).toBeVisible();
    await expect(
      directSession.getByLabel(/I reviewed these identities/),
    ).not.toBeChecked();
    await captureState(page, directSession, "duplicate-person-confirmation");
  });

  test("automatic task-plan settings remain legible when expanded", async ({
    page,
  }) => {
    await openHydrated(page, "/admin/tasks");
    const taskPlan = page.locator("aside").filter({
      has: page.getByRole("heading", { name: "Assign a plan" }),
    });
    const template = taskPlan.locator("details").filter({
      has: page.getByText("Create task template", { exact: true }),
    });
    await template.getByText("Create task template", { exact: true }).click();
    await template.getByLabel("Due date anchor").selectOption("acceptance");
    await template
      .getByLabel("Add this task automatically when a submission is accepted")
      .check();
    await captureState(page, taskPlan, "automatic-task-plan");
  });

  test("scheduled communication preview shows timing and mobile content before confirmation", async ({
    page,
  }) => {
    await selectCurrentEvent(page);
    await openHydrated(page, "/admin/communications/compose");
    const composer = page.locator("section").filter({
      has: page.getByRole("heading", { name: "1. Create the durable draft" }),
    });
    await composer
      .getByLabel("Schedule for later (optional, America/Toronto)")
      .fill("2027-07-10T09:30");
    await composer
      .getByRole("button", { name: "Create durable draft" })
      .click();
    await page
      .getByRole("button", { name: "Generate current preview" })
      .click();

    const preview = page.locator("section").filter({
      has: page.getByRole("heading", {
        name: "2. Verify the authoritative preview",
      }),
    });
    await expect(
      preview.getByRole("heading", {
        name: "2. Verify the authoritative preview",
      }),
    ).toBeVisible();
    await expect(
      preview.locator(".validation-item.info").filter({
        hasText: "Scheduled for",
      }),
    ).toBeVisible();
    await preview
      .getByRole("group", { name: "Email preview size" })
      .getByRole("button", { name: "Mobile" })
      .click();
    const frame = preview.getByTitle(
      "Representative merged email · mobile preview",
    );
    await expect(frame).toBeVisible();
    await frame.contentFrame().locator("body").waitFor();
    await captureState(page, preview, "scheduled-communication-preview");
  });

  test("standard schedule views and content previews have explicit visual states", async ({
    page,
  }) => {
    await openHydrated(page, "/admin/schedule?session=demo-session-1");

    const canvas = page.locator(".schedule-canvas");
    await page.getByRole("button", { name: "Day", pressed: false }).click();
    await expect(page.getByRole("heading", { name: "Day view" })).toBeVisible();
    await expect(
      page.getByRole("region", { name: "day schedule calendar" }),
    ).toBeVisible();
    await captureState(page, canvas, "schedule-standard-day");

    await page.getByRole("button", { name: "Week", pressed: false }).click();
    const weekCalendar = page.getByRole("region", {
      name: "week schedule calendar",
    });
    await expect(weekCalendar).toBeVisible();
    const firstWeekEvent = weekCalendar
      .locator(".schedule-standard-event-content")
      .first();
    await firstWeekEvent.evaluate((event) => {
      const frame = event.closest<HTMLElement>(
        ".schedule-standard-scroll-frame",
      );
      if (!frame) throw new Error("Week calendar scroll frame is missing.");
      frame.scrollLeft +=
        event.getBoundingClientRect().left -
        frame.getBoundingClientRect().left -
        110;
    });
    await expect(firstWeekEvent).toContainText(
      "The Future of Attendee Engagement",
    );
    await captureState(page, canvas, "schedule-standard-week");

    await captureState(
      page,
      page.getByTestId("schedule-notes-editor"),
      "schedule-notes-editor",
    );
    await captureState(
      page,
      page.getByTestId("session-content-editor"),
      "session-content-editor",
    );

    const preview = page.getByTestId("session-content-preview");
    await preview.getByRole("button", { name: "Mobile" }).click();
    await preview.getByRole("button", { name: "Session detail" }).click();
    await expect(
      preview.locator("[data-preview-viewport='mobile']"),
    ).toBeVisible();
    await captureState(page, preview, "session-content-mobile-preview");
  });

  test("import and export controls keep their consequence boundary visible", async ({
    page,
  }) => {
    await openHydrated(page, "/admin/operations?panel=imports");
    await captureState(
      page,
      page.locator("section").filter({
        has: page.getByRole("heading", { name: "CSV import" }),
      }),
      "operation-import-controls",
    );

    await selectDemoRole(page, "owner");
    await openHydrated(page, "/admin/operations?panel=exports");
    await captureState(
      page,
      page.locator("section").filter({
        has: page.getByRole("heading", { name: "Event data exports" }),
      }),
      "operation-export-controls",
    );
  });

  test("failed provider item exposes honest record-level recovery controls", async ({
    page,
    request,
  }) => {
    const fixture = await seedVisualAcceleventsFailure(request);
    await openHydrated(
      page,
      `/admin/operations?operation=${encodeURIComponent(fixture.operationId)}`,
    );
    const results = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Record-level results" }),
    });
    const table = results.locator(".table-wrap");
    await expect(table).toBeVisible();
    expect(
      await table.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      ),
      "record-level results should present the complete row without horizontal scrolling",
    ).toBeLessThanOrEqual(1);

    const recoveryControls = [
      results.getByRole("button", { name: /^Retry / }),
      results.getByRole("button", { name: /^Skip / }),
    ];
    const tableBounds = await table.boundingBox();
    expect(tableBounds).not.toBeNull();
    for (const control of recoveryControls) {
      await expect(control).toBeVisible();
      const controlBounds = await control.boundingBox();
      expect(controlBounds).not.toBeNull();
      expect(controlBounds!.x).toBeGreaterThanOrEqual(tableBounds!.x - 1);
      expect(controlBounds!.x + controlBounds!.width).toBeLessThanOrEqual(
        tableBounds!.x + tableBounds!.width + 1,
      );
    }
    await captureState(page, results, "operation-record-recovery");
  });

  test("interactive API reference has a responsive application viewport", async ({
    page,
  }) => {
    await openHydrated(page, "/api/docs");
    await expect(page.locator(".scalar-api-reference")).toBeVisible();
    await expect(
      page.getByText("Program Cue API", { exact: true }).first(),
    ).toBeVisible();
    await expect(page).toHaveScreenshot("api-reference.png");
    await expectDocumentContained(page, "api-reference");
  });

  test("new operational surfaces remain contained at a 200 percent equivalent width", async ({
    page,
  }, testInfo) => {
    test.skip(
      testInfo.project.name !== "desktop-chromium",
      "The desktop project owns the explicit 200% equivalent pass.",
    );
    await selectDemoRole(page, "owner");
    await page.setViewportSize({ width: 720, height: 900 });
    for (const [name, path] of [
      ["assistant", "/admin/assistant"],
      ["form builder", "/admin/submissions/form"],
      ["submission grid", "/admin/submissions?status=submitted"],
      ["schedule", "/admin/schedule?session=demo-session-1"],
      ["task plan", "/admin/tasks"],
      ["operation import", "/admin/operations?panel=imports"],
      ["API settings", "/admin/settings"],
      ["retention", "/admin/files/retention"],
      ["demo guide", "/demo"],
      ["API reference", "/api/docs"],
    ] as const) {
      await openHydrated(page, path);
      if (name === "form builder")
        await waitForSurfaceReady(page, "form-builder");
      if (name === "API reference") {
        await expect(page.locator(".scalar-api-reference")).toBeVisible();
      }
      await expect(page.locator("main#main")).toBeVisible();
      await expectDocumentContained(page, `${name} at 200% equivalent`);
    }
  });
});
