import { expect, type Locator, type Page, test } from "@playwright/test";

import { prepareVisualBaseline } from "./support/prepare-visual-baseline";
import { resetDemoEvent } from "./support/reset-demo-event";

// Representative snapshots protect each major application shell and complex
// layout family. Focused browser suites and retained responsive checks own
// interaction states and detailed containment behavior, so this inventory
// does not repeat those states as additional screenshots.
type DemoRole = "evaluator" | "speaker";

type Surface = {
  name: string;
  path: string;
  role?: DemoRole;
};

const SURFACES: readonly Surface[] = [
  { name: "event-setup", path: "/admin/event" },
  { name: "branding", path: "/admin/branding" },
  { name: "command-centre", path: "/admin/command" },
  { name: "form-builder", path: "/admin/submissions/form" },
  {
    name: "review-workbench",
    path: "/review/workbench",
    role: "evaluator",
  },
  { name: "communications", path: "/admin/communications" },
  {
    name: "public-programme",
    path: "/public/programme/future-of-events-2027",
  },
  { name: "public-application", path: "/apply/form" },
  {
    name: "speaker-dashboard",
    path: "/participant/dashboard",
    role: "speaker",
  },
];

async function selectDemoRole(page: Page, role: DemoRole) {
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
  if (name === "form-builder") {
    const editor = page.getByRole("region", {
      name: "Visual call-for-speakers form editor",
    });
    await expect(editor.locator(".fb-canvas-page")).toBeVisible();
    await expect(
      page.getByText("Changes update the draft immediately."),
    ).toBeVisible();
  } else if (name === "communications") {
    await expect(
      page.getByRole("heading", { name: "Template versions" }),
    ).toBeVisible();
  } else if (name === "evaluation-admin") {
    await expect(
      page.getByRole("navigation", { name: "Evaluation views" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Proposal assignments and decisions",
      }),
    ).toBeVisible();
  } else if (name === "tasks-readiness") {
    await expect(
      page.getByRole("heading", { name: "Filter assigned work" }),
    ).toBeVisible();
    await expect(page.locator(".tasks-layout")).toBeVisible();
  } else if (name === "programme-admin") {
    await expect(
      page.getByRole("heading", { name: "Current programme records" }),
    ).toBeVisible();
    await expect(page.locator(".programme-workspace-tabs")).toBeVisible();
  } else if (name === "public-speaker-gallery") {
    await expect(
      page.getByRole("heading", { name: "Speaker Gallery", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".speaker-gallery-grid")).toBeVisible();
    await expect(
      page.getByRole("searchbox", { name: "Search speaker gallery by name" }),
    ).toHaveCount(0);
  } else if (name === "speaker-profile") {
    await expect(page.locator("#profile")).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Display name" }),
    ).toBeVisible();
  } else if (name === "speaker-dashboard") {
    const main = page.locator(".speaker-dashboard-main");
    await expect(main).toBeVisible();
    await expect
      .poll(async () => (await main.boundingBox())?.width ?? 0)
      .toBeGreaterThan(280);
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

async function captureLaptopViewport(page: Page, name: string) {
  expect(page.viewportSize(), `${name} should use the laptop viewport`).toEqual(
    {
      width: 1280,
      height: 720,
    },
  );
  await expect(page.locator("main#main")).toBeInViewport();
  await expect(page).toHaveScreenshot(`${name}.png`);
  await expectDocumentContained(page, `${name} at the laptop viewport`);
}

/**
 * Panels arrive from the edge they belong to, so a box measured mid-flight is
 * still partly off screen. Containment is a statement about where a panel
 * comes to rest; wait for the arrival to finish before measuring it.
 */
async function settleOverlayMotion(overlay: Locator) {
  await overlay.evaluate(async (node) => {
    await Promise.all(
      node
        .getAnimations({ subtree: true })
        .map((animation) => animation.finished.catch(() => undefined)),
    );
  });
}

async function expectMobileCommandOverlaysContained(page: Page) {
  let releaseRecordSearch = () => {};
  const recordSearchGate = new Promise<void>((resolve) => {
    releaseRecordSearch = resolve;
  });
  await page.route("**/admin/search?**", async (route) => {
    await recordSearchGate;
    await route.fulfill({ json: { records: [] } });
  });

  await page.getByRole("button", { name: /Search or run a command/i }).click();
  const commandDialog = page.getByRole("dialog", {
    name: "Search or run a command",
  });
  await commandDialog
    .getByRole("combobox", { name: "Program Cue commands" })
    .fill("settings");
  await expect(
    commandDialog.getByText("Event settings", { exact: true }).first(),
  ).toBeVisible();
  await expect(
    commandDialog.getByText("Searching authorised records…"),
  ).toBeVisible();
  await expect(commandDialog.getByText(/Nothing matches/)).toHaveCount(0);
  await expect(
    commandDialog.getByText(/No authorised records match/),
  ).toHaveCount(0);
  releaseRecordSearch();
  await expect(
    commandDialog.getByText("No authorised records match “settings”."),
  ).toBeVisible();
  await expect(
    commandDialog.getByText("Searching authorised records…"),
  ).toHaveCount(0);
  await expect(commandDialog.getByText(/Nothing matches/)).toHaveCount(0);
  await settleOverlayMotion(commandDialog);
  const viewport = page.viewportSize();
  const commandBounds = await commandDialog.boundingBox();
  expect(viewport).not.toBeNull();
  expect(commandBounds).not.toBeNull();
  expect(commandBounds!.x).toBeGreaterThanOrEqual(0);
  expect(commandBounds!.y).toBeGreaterThanOrEqual(0);
  expect(commandBounds!.x + commandBounds!.width).toBeLessThanOrEqual(
    viewport!.width,
  );
  expect(commandBounds!.y + commandBounds!.height).toBeLessThanOrEqual(
    viewport!.height,
  );
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "Switch event" }).click();
  const eventDialog = page.getByRole("dialog", { name: "Current event" });
  const currentEvent = eventDialog.locator(
    "form.pc-event-option[aria-current='true']",
  );
  const currentStatus = currentEvent.getByText("Current", { exact: true });
  await expect(currentEvent).toHaveCount(1);
  await expect(currentStatus).toBeVisible();
  await settleOverlayMotion(eventDialog);
  const [eventDialogBounds, currentEventBounds, currentStatusBounds] =
    await Promise.all([
      eventDialog.boundingBox(),
      currentEvent.boundingBox(),
      currentStatus.boundingBox(),
    ]);
  expect(eventDialogBounds).not.toBeNull();
  expect(currentEventBounds).not.toBeNull();
  expect(currentStatusBounds).not.toBeNull();
  expect(eventDialogBounds!.x).toBeGreaterThanOrEqual(0);
  expect(eventDialogBounds!.y).toBeGreaterThanOrEqual(0);
  expect(eventDialogBounds!.x + eventDialogBounds!.width).toBeLessThanOrEqual(
    viewport!.width,
  );
  expect(eventDialogBounds!.y + eventDialogBounds!.height).toBeLessThanOrEqual(
    viewport!.height,
  );
  expect(currentStatusBounds!.x).toBeGreaterThanOrEqual(currentEventBounds!.x);
  expect(
    currentStatusBounds!.x + currentStatusBounds!.width,
  ).toBeLessThanOrEqual(currentEventBounds!.x + currentEventBounds!.width);

  // The demo baseline has no pending invitation. Reuse its real event row to
  // exercise the longest server-generated action without mutating fixture
  // state: this is the copy that previously squeezed the event name away.
  await currentEvent.evaluate((row) => {
    const meta = row.querySelector<HTMLElement>(".pc-menu-meta");
    if (!meta) throw new Error("Event row is missing its action area");
    const action = document.createElement("button");
    action.type = "button";
    action.className = "btn small primary";
    action.textContent = "Accept committee chair invitation and switch event";
    meta.replaceChildren(action);
  });
  const invitationAction = currentEvent.getByRole("button", {
    name: "Accept committee chair invitation and switch event",
  });
  const eventCopy = currentEvent.locator(".pc-menu-copy");
  await expect(invitationAction).toBeVisible();
  const invitationLayout = await currentEvent.evaluate((row) => {
    const copy = row.querySelector<HTMLElement>(".pc-menu-copy");
    const action = row.querySelector<HTMLElement>(".pc-menu-meta .btn");
    if (!copy || !action)
      throw new Error("Synthetic invitation row is incomplete");
    const copyBounds = copy.getBoundingClientRect();
    const actionBounds = action.getBoundingClientRect();
    const rowBounds = row.getBoundingClientRect();
    return {
      overflow: row.scrollWidth - row.clientWidth,
      copyBottom: copyBounds.bottom,
      actionLeft: actionBounds.left,
      actionTop: actionBounds.top,
      actionRight: actionBounds.right,
      rowLeft: rowBounds.left,
      rowRight: rowBounds.right,
    };
  });
  expect(invitationLayout.overflow).toBeLessThanOrEqual(1);
  expect(invitationLayout.actionTop).toBeGreaterThanOrEqual(
    invitationLayout.copyBottom,
  );
  expect(invitationLayout.actionLeft).toBeGreaterThanOrEqual(
    invitationLayout.rowLeft,
  );
  expect(invitationLayout.actionRight).toBeLessThanOrEqual(
    invitationLayout.rowRight,
  );
  await expect(eventCopy).toBeVisible();
  await page.keyboard.press("Escape");
}

test.describe
  .serial("common-laptop visual coverage", { tag: "@laptop-visual" }, () => {
    test.beforeAll(async ({ request }) => {
      await prepareVisualBaseline(request);
    });

    test.afterAll(async ({ request }) => {
      await resetDemoEvent(request);
    });

    test("Form Builder keeps the native visual editor visible", async ({
      page,
    }) => {
      await openHydrated(page, "/admin/submissions/form");
      await waitForSurfaceReady(page, "form-builder");
      await expect(
        page.getByRole("region", {
          name: "Visual call-for-speakers form editor",
        }),
      ).toBeInViewport();
      await captureLaptopViewport(page, "form-builder");
    });

    test("Tasks & Readiness keeps assigned work and plan controls legible", async ({
      page,
    }) => {
      await openHydrated(page, "/admin/tasks");
      await waitForSurfaceReady(page, "tasks-readiness");
      await expect(
        page.getByRole("heading", { name: "Tasks & readiness", level: 1 }),
      ).toBeInViewport();
      await expect(page.locator(".tasks-layout")).toBeInViewport();
      await captureLaptopViewport(page, "tasks-readiness");
    });

    test("Schedule Planner keeps the focused planning canvas visible", async ({
      page,
    }) => {
      await openHydrated(page, "/admin/schedule?session=demo-session-1");
      await expect(
        page.getByRole("heading", { name: "Schedule Planner", level: 1 }),
      ).toBeInViewport();
      await expect(page.locator(".schedule-canvas")).toBeInViewport();
      await captureLaptopViewport(page, "schedule-planner");
    });

    test("Communications keeps preview and confirmation context visible", async ({
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
      await expect(
        page.getByRole("heading", {
          name: "2. Verify the authoritative preview",
        }),
      ).toBeInViewport();
      const mergedPreview = page.getByRole("heading", {
        name: "Representative merged email",
      });
      await mergedPreview.scrollIntoViewIfNeeded();
      await expect(mergedPreview).toBeInViewport();
      const confirmation = page.getByRole("heading", {
        name: "3. Confirm durable delivery",
      });
      await confirmation.scrollIntoViewIfNeeded();
      await expect(confirmation).toBeInViewport();
      await expect(
        page.getByRole("button", { name: "Schedule 1 delivery" }),
      ).toBeInViewport();
      await captureLaptopViewport(page, "communications-preview");
    });
  });

test.describe
  .serial("responsive visual inventory", () => {
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
          surface.role === "speaker";
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
        if (
          testInfo.project.name === "mobile-chromium" &&
          surface.name === "command-centre"
        ) {
          await expectMobileCommandOverlaysContained(page);
        }
        await expectDocumentContained(page, surface.name);
      });
    }

    test("distinctive high-risk surfaces retain reviewed visual baselines", async ({
      page,
    }, testInfo) => {
      let surfaces: readonly Surface[];
      if (testInfo.project.name === "desktop-chromium") {
        surfaces = [
          { name: "evaluation-admin", path: "/admin/review" },
          { name: "programme-admin", path: "/admin/programme" },
        ];
      } else if (testInfo.project.name === "mobile-chromium") {
        surfaces = [
          { name: "evaluation-admin", path: "/admin/review" },
          { name: "tasks-readiness", path: "/admin/tasks" },
          {
            name: "public-speaker-gallery",
            path: "/public/programme/future-of-events-2027/gallery",
          },
          {
            name: "speaker-profile",
            path: "/participant/profile",
            role: "speaker",
          },
        ];
      } else {
        throw new Error(
          `High-risk visual surfaces are not configured for Playwright project "${testInfo.project.name}".`,
        );
      }

      for (const surface of surfaces) {
        if (surface.role) await selectDemoRole(page, surface.role);
        await openHydrated(page, surface.path);
        await expect(
          page.getByRole("heading", { level: 1 }).first(),
        ).toBeVisible();
        if (surface.name === "evaluation-admin") {
          await page.getByRole("link", { name: "Assignments" }).click();
        }
        await waitForSurfaceReady(page, surface.name);
        // Locator screenshots stitch long pages from viewport-sized tiles.
        // Normalize already-covered fixed navigation so it is not repeated at
        // every stitch boundary; the dashboard baseline owns the speaker nav.
        const fullPageCaptureCss =
          surface.name === "programme-admin"
            ? // The install snippet includes the local origin and port.
              ".programme-embed-code { color: transparent !important; }"
            : testInfo.project.name === "mobile-chromium" &&
                surface.name === "evaluation-admin"
              ? ".pc-admin-section-nav { position: static !important; }"
              : testInfo.project.name === "mobile-chromium" &&
                  surface.role === "speaker"
                ? ".speaker-nav { visibility: hidden !important; }"
                : null;
        const fullPageCaptureStyle = fullPageCaptureCss
          ? await page.addStyleTag({ content: fullPageCaptureCss })
          : null;
        try {
          await captureState(page, page.locator("body"), surface.name);
        } finally {
          await fullPageCaptureStyle?.evaluate((style) =>
            style.parentNode?.removeChild(style),
          );
        }
      }
    });
  });
