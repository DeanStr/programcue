// Dialog review harness: captures every admin shell overlay at the viewports
// that matter. The design-shots harness only reaches page surfaces; overlays
// need a trigger interaction, so they were never in a screenshot.
//
//   node scripts/dialog-shots.mjs before
//   node scripts/dialog-shots.mjs after
//
// Output: .artifacts/dialogs/<label>/<viewport>/<dialog>.png
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";

import { chromium } from "playwright";

const ORIGIN = process.env.DESIGN_SHOT_ORIGIN ?? "http://127.0.0.1:5173";
const LABEL = process.argv[2] ?? "before";
const ONLY = process.argv.slice(3);
const OUT = path.resolve(".artifacts/dialogs", LABEL);
const DEMO_EVENT = "evt-foe-2025";

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 },
];

/** Each dialog: navigate to `path`, run `open`, screenshot the overlay. */
const DIALOGS = [
  {
    name: "create",
    path: "/admin/command",
    open: async (page) => {
      await page.getByRole("button", { name: "New", exact: true }).click();
    },
  },
  {
    name: "notifications",
    path: "/admin/command",
    open: async (page) => {
      await page
        .getByRole("button", { name: /operational notification/ })
        .click();
    },
  },
  {
    name: "account",
    path: "/admin/command",
    open: async (page) => {
      await page.getByRole("button", { name: "Open account menu" }).click();
    },
  },
  {
    name: "event-switcher",
    path: "/admin/command",
    open: async (page) => {
      await page.getByRole("button", { name: "Switch event" }).click();
    },
  },
  {
    name: "command-palette",
    path: "/admin/command",
    open: async (page) => {
      await page
        .getByRole("button", { name: "Search or run a command" })
        .click();
    },
  },
  {
    name: "command-palette-query",
    path: "/admin/command",
    open: async (page) => {
      await page
        .getByRole("button", { name: "Search or run a command" })
        .click();
      await page.waitForTimeout(200);
      await page.keyboard.type("ke");
      await page.waitForTimeout(900);
    },
  },
  {
    name: "shortcuts",
    path: "/admin/command",
    open: async (page) => {
      await page
        .getByRole("button", { name: "Search or run a command" })
        .click();
      await page.waitForTimeout(250);
      await page.getByRole("option", { name: /Keyboard shortcuts/ }).click();
    },
  },
  {
    name: "saved-views",
    path: "/admin/submissions",
    open: async (page) => {
      await page
        .getByRole("button", { name: "Search or run a command" })
        .click();
      await page.waitForTimeout(250);
      await page.getByRole("option", { name: /Save current view/ }).click();
    },
  },
  {
    name: "mobile-nav",
    path: "/admin/command",
    viewports: ["mobile"],
    open: async (page) => {
      await page.getByRole("button", { name: "Open navigation" }).click();
    },
  },
  // Not shell chrome: these prove the shared panel carries route dialogs too.
  {
    name: "add-room",
    path: "/admin/event",
    open: async (page) => {
      // Rooms live inside a collapsed <details>, so the trigger is not in the
      // accessibility tree until its summary is opened.
      await page
        .locator("details", { has: page.getByText("Rooms and capacities") })
        .first()
        .locator("summary")
        .click();
      await page.getByRole("button", { name: "Add room" }).first().click();
    },
  },
  {
    name: "invite-administrator",
    path: "/admin/event",
    open: async (page) => {
      await page
        .getByRole("button", { name: "Invite administrator" })
        .first()
        .click();
    },
  },
  {
    name: "confirm",
    path: "/admin/events/new",
    role: "owner",
    open: async (page) => {
      await page.getByLabel("Event name").fill("Design review event");
      await page.getByLabel("Public slug").fill("design-review-event");
      await page.getByRole("button", { name: "Create blank event" }).click();
    },
  },
];

function cookie(name, value) {
  return {
    name,
    value,
    domain: "127.0.0.1",
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
  };
}

async function main() {
  const wanted = ONLY.length
    ? DIALOGS.filter((dialog) => ONLY.includes(dialog.name))
    : DIALOGS;
  const browser = await chromium.launch();
  const failures = [];

  for (const viewport of VIEWPORTS) {
    await mkdir(path.join(OUT, viewport.name), { recursive: true });
    for (const dialog of wanted) {
      if (dialog.viewports && !dialog.viewports.includes(viewport.name))
        continue;
      await rm(path.join(OUT, viewport.name, `${dialog.name}.png`), {
        force: true,
      });
      const context = await browser.newContext({
        baseURL: ORIGIN,
        viewport: { width: viewport.width, height: viewport.height },
        deviceScaleFactor: 2,
        reducedMotion: "reduce",
      });
      await context.addCookies([
        cookie("program_cue_event", DEMO_EVENT),
        cookie("program_cue_demo_identity", dialog.role ?? "administrator"),
      ]);
      const page = await context.newPage();
      try {
        await page.goto(dialog.path, {
          waitUntil: "networkidle",
          timeout: 60_000,
        });
        // The overlay triggers are React handlers, so a click before hydration
        // is swallowed and the harness screenshots the bare page instead.
        await page.waitForFunction(
          () => Boolean(document.querySelector(".shell-motion-ready")),
          null,
          { timeout: 30_000 },
        );
        await page.waitForTimeout(500);
        await dialog.open(page);
        await page.waitForSelector('[role="dialog"]', { timeout: 15_000 });
        await page.waitForTimeout(700);
        await page.screenshot({
          path: path.join(OUT, viewport.name, `${dialog.name}.png`),
        });
      } catch (error) {
        failures.push(`${dialog.name} ${viewport.name} -> ${error.message}`);
      } finally {
        await context.close();
      }
    }
    process.stdout.write(`captured ${viewport.name}\n`);
  }

  await browser.close();
  process.stdout.write(`\nwrote ${OUT}\n`);
  if (failures.length) {
    // A capture that silently produced fewer screenshots than it was asked for
    // reads as a clean run, and the missing surface is the one nobody reviews.
    process.stderr.write(`\nissues:\n${failures.join("\n")}\n`);
    process.exitCode = 1;
  }
}

await main();
