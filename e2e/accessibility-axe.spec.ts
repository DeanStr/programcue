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
  { role: "administrator", path: "/admin/crm/pipeline" },
  { role: "administrator", path: "/admin/resources" },
  { role: "administrator", path: "/api/docs" },
  { role: "administrator", path: "/public/programme/future-of-events-2027" },
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
      if (surface.path === "/api/docs") {
        const copyButtons = page.locator("button.scalar-code-copy");
        await expect(copyButtons.first()).toHaveAttribute(
          "aria-label",
          "Copy code",
        );
        expect(
          await copyButtons.evaluateAll((buttons) =>
            buttons.every(
              (button) => button.getAttribute("aria-label") === "Copy code",
            ),
          ),
        ).toBe(true);
      }
      await expectNoViolations(page, `${surface.path} @ ${viewport.label}`);
    }
  });
}

test("API reference remains accessible with its persisted dark theme", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("colorMode", "dark"));
  await openHydrated(page, "/api/docs");
  await expect(page.locator("body")).toHaveClass(/dark-mode/);
  await expect(page.locator("button.scalar-code-copy").first()).toHaveAttribute(
    "aria-label",
    "Copy code",
  );
  await expectNoViolations(page, "/api/docs @ persisted dark theme");
});

test("public programme embeds retain contrast with a light event accent", async ({
  page,
}) => {
  await openHydrated(page, "/embed/future-of-events-2027?accent=%23ffffff");
  await expectNoViolations(page, "public programme @ light event accent");
});
