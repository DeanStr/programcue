import { expect, type Page, test } from "@playwright/test";
import { expectLongTrackFilterContained } from "./support/application-grid";

test("long track filters do not create page overflow in the browser engine", async ({
  page,
}) => {
  await expectLongTrackFilterContained(page);
});

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
      name: "program_cue_demo_identity",
      value: "evaluator",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await openHydrated(page, "/review/workbench");
  await expect(page.getByRole("main")).toContainText(/proposal|review/i);

  await openHydrated(page, "/public/programme/future-of-events-2027");
  await expect(page.getByRole("main")).toContainText(/programme|session/i);
});

test("live list filters keep typing and restore history in the browser engine", async ({
  page,
}) => {
  await openHydrated(page, "/admin/submissions");
  const requests: string[] = [];
  // Hold each data request open so typing lands while one is loading.
  await page.route(/\/admin\/submissions\.data/u, async (route) => {
    requests.push(route.request().url());
    await new Promise((resolve) => setTimeout(resolve, 400));
    await route.continue();
  });
  const filters = page.getByRole("search");
  const search = filters.getByLabel("Search", { exact: true });
  await search.click();
  await page.keyboard.type("incl");
  await expect.poll(() => requests.length).toBe(1);
  await page.keyboard.type("usive");
  await expect(page).toHaveURL(/query=inclusive/u);
  await expect(search).toHaveValue("inclusive");
  await expect(search).toBeFocused();

  // Clear pushes a new entry. A search typed after it asks for exactly the
  // entry Back returns to; Back still restores that entry, and neither the
  // pending edit nor its debounce lands on it.
  await filters.getByRole("link", { name: "Clear", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/submissions$/u);
  await expect(search).toHaveValue("");
  const sent = requests.length;
  await search.click();
  await page.keyboard.type("inclusive");
  await expect.poll(() => requests.length).toBe(sent + 1);
  await page.keyboard.type("-more");
  await page.goBack();
  await expect(page).toHaveURL(/query=inclusive(?:&|$)/u);
  await expect(search).toHaveValue("inclusive");
  await page.waitForTimeout(900);
  await expect(page).toHaveURL(/query=inclusive(?:&|$)/u);
  await expect(search).toHaveValue("inclusive");

  const status = filters.getByRole("combobox", {
    name: "Status",
    exact: true,
  });
  await status.selectOption("assigned");
  await expect(page).toHaveURL(/status=assigned/u);
  await expect(search).toHaveValue("inclusive");
});
