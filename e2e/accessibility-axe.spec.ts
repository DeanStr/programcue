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
      name: "program_cue_demo_role",
      value: role,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
}

test("representative role surfaces have no detectable WCAG A/AA violations", async ({
  page,
}) => {
  const surfaces = [
    { role: "administrator", path: "/admin/command" },
    { role: "evaluator", path: "/review/workbench" },
    { role: "submitter", path: "/apply/form" },
    { role: "speaker", path: "/speaker/dashboard" },
    { role: "speaker", path: "/speaker/tasks" },
    { role: "administrator", path: "/admin/communications/compose" },
    { role: "administrator", path: "/admin/speakers/person-demo-speaker" },
    {
      role: "administrator",
      path: "/public/programme/future-of-events-2025",
    },
  ] as const;

  for (const surface of surfaces) {
    await selectDemoRole(page, surface.role);
    await openHydrated(page, surface.path);
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(
      result.violations,
      `${surface.path} accessibility violations:\n${result.violations
        .map(
          (violation) =>
            `${violation.id}: ${violation.help} (${violation.nodes
              .map((node) => node.target.join(" "))
              .join(", ")})`,
        )
        .join("\n")}`,
    ).toEqual([]);
  }
});
