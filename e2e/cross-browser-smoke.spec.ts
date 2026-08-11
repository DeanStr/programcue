import { expect, test, type Page } from "@playwright/test";

async function openHydrated(page: Page, path: string) {
  const response = await page.goto(path);
  expect(response?.ok(), `${path} should load`).toBeTruthy();
  await page.locator("body[data-hydrated='true']").waitFor();
  await expect(page.locator("main#main")).toHaveCount(1);
}

test("admin, reviewer and public workflows render in the browser engine", async ({
  page,
}) => {
  await openHydrated(page, "/admin/command");
  await expect(
    page.getByRole("heading", { level: 1, name: /command centre/i }),
  ).toBeVisible();

  await page.context().addCookies([
    {
      name: "program_cue_demo_role",
      value: "evaluator",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await openHydrated(page, "/review/workbench");
  await expect(page.getByRole("main")).toContainText(/proposal|review/i);

  await openHydrated(page, "/public/programme/future-of-events-2025");
  await expect(page.getByRole("main")).toContainText(/programme|session/i);
});
