import { expect, test } from "@playwright/test";

import { resetDemoSubmissions } from "./support/reset-demo-submissions";

// Every core rendered product surface is represented here. These snapshots protect the current
// product-quality baseline; they are not pixel-parity checks against the removed prototype.
// `/` and `/sign-in` redirect in the evaluator environment, resource routes are non-visual, and
// signed utility flows such as email preferences use focused browser-behavior coverage instead.
const SURFACES = [
  ["event-setup", "/admin/event", null],
  ["command-centre", "/admin/command", null],
  ["operation-centre", "/admin/operations", null],
  ["submissions-list", "/admin/submissions", null],
  ["form-builder", "/admin/submissions/form", null],
  ["evaluation-admin", "/admin/review", null],
  ["review-workbench", "/review/workbench", "evaluator"],
  ["speakers-list", "/admin/speakers", null],
  ["resources-admin", "/admin/resources", null],
  ["schedule-planner", "/admin/schedule", null],
  ["communications", "/admin/communications", null],
  ["tasks-readiness", "/admin/tasks", null],
  ["programme-admin", "/admin/programme", null],
  ["integrations", "/admin/integrations", null],
  ["settings", "/admin/settings", null],
  ["public-programme", "/public/programme", null],
  ["programme-embed", "/embed/future-of-events-2025", null],
  ["public-application", "/apply/form", null],
  ["speaker-dashboard", "/speaker/dashboard", null],
  ["speaker-resources", "/speaker/resources", null],
  ["design-system", "/design/system", null],
] as const;

test.beforeAll(async ({ request }) => {
  await resetDemoSubmissions(request);
  // The programme service owns the seeded schedule fixture. Initialise it before
  // capturing admin surfaces so snapshots do not depend on test order. The
  // command centre similarly initialises the evaluation fixture used by several
  // admin and reviewer surfaces, while resource authoring initialises the
  // speaker-owned session and task fixture.
  expect((await request.get("/admin/command")).ok()).toBeTruthy();
  expect((await request.get("/admin/resources")).ok()).toBeTruthy();
  expect((await request.get("/embed/future-of-events-2025")).ok()).toBeTruthy();
});

for (const [name, path, role] of SURFACES) {
  test(`${name} uses the Program Cue visual system`, async ({ page }) => {
    if (role) {
      await page.context().addCookies([{
        name: "program_cue_demo_role",
        value: role,
        domain: "127.0.0.1",
        path: "/",
        httpOnly: true,
        sameSite: "Lax",
      }]);
    }
    const response = await page.goto(path);
    expect(response?.ok()).toBeTruthy();
    await page.locator("body[data-hydrated='true']").waitFor();
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    if (name === "communications") {
      await expect(page.getByText("Operations Queue bound", { exact: true })).toBeVisible();
    }
    await expect(page.locator("body")).toHaveScreenshot(`${name}.png`);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });
}
