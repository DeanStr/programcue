import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function openHydrated(page: Page, path: string) {
  const response = await page.goto(path);
  expect(response?.ok(), `${path} should load`).toBeTruthy();
  await page.locator("body[data-hydrated='true']").waitFor();
}

async function selectDemoRole(page: Page, role: string) {
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

const SURFACES = [
  { role: "administrator", path: "/admin/command" },
  { role: "administrator", path: "/admin/submissions" },
  { role: "administrator", path: "/admin/schedule" },
  { role: "evaluator", path: "/review/workbench" },
  { role: "submitter", path: "/apply/form" },
  { role: "speaker", path: "/participant/dashboard" },
  { role: "speaker", path: "/participant/tasks" },
  { role: "administrator", path: "/admin/communications/compose" },
  { role: "administrator", path: "/admin/speakers/person-demo-speaker" },
  { role: "administrator", path: "/admin/crm" },
  { role: "administrator", path: "/public/programme/future-of-events-2025" },
] as const;

/* The suite previously ran only at 1440x1000, so rules that fire inside a
   breakpoint — notably nav labels hidden with display:none, which strips the
   accessible name from a link — were never evaluated. Narrow viewports are
   where the responsive layer actually changes the accessibility tree. */
const VIEWPORTS = [
  { label: "phone", width: 375, height: 800 },
  { label: "tablet", width: 1024, height: 900 },
  { label: "desktop", width: 1440, height: 1000 },
] as const;

async function expectNoViolations(page: Page, label: string) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    result.violations,
    `${label} accessibility violations:\n${result.violations
      .map(
        (violation) =>
          `${violation.id}: ${violation.help} (${violation.nodes
            .map((node) => node.target.join(" "))
            .join(", ")})`,
      )
      .join("\n")}`,
  ).toEqual([]);
}

for (const viewport of VIEWPORTS) {
  test(`representative role surfaces have no detectable WCAG A/AA violations at ${viewport.label}`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: viewport.width,
      height: viewport.height,
    });
    for (const surface of SURFACES) {
      await selectDemoRole(page, surface.role);
      await openHydrated(page, surface.path);
      await expectNoViolations(page, `${surface.path} @ ${viewport.label}`);
    }
  });
}
