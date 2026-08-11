import { expect, test } from "@playwright/test";

test("the submissions grid keeps server filters authoritative while managing the visible page", async ({
  context,
  page,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);

  // Evaluation setup supplies realistic routed records without bypassing the
  // production services used by the submissions queue.
  await page.goto("/admin/review");
  await page.locator("body[data-hydrated='true']").waitFor();
  await page.goto("/admin/submissions?status=assigned");
  await page.locator("body[data-hydrated='true']").waitFor();

  await expect(page.locator('select[name="status"]')).toHaveValue("assigned");
  const gridRegion = page.getByRole("region", {
    name: /Application queue table/,
  });
  const table = gridRegion.getByRole("table");
  const selectVisiblePage = gridRegion.getByRole("checkbox", {
    name: "Select every application on this page",
    exact: true,
  });
  await expect(selectVisiblePage).toBeEnabled();

  await selectVisiblePage.check();
  await expect(
    page.getByRole("main").getByText(/[1-9]\d* of [1-9]\d* selected/),
  ).toBeVisible();
  await page.getByRole("button", { name: "Copy references" }).click();
  const clipboardStatus = page
    .getByRole("main")
    .getByRole("status")
    .filter({ hasText: /application references? copied/ });
  await expect(clipboardStatus).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toMatch(/^Reference\tApplication\n/);

  await page.getByLabel("Density").selectOption("compact");
  await expect(table).toHaveClass(/is-compact/);
  await page.getByText("Columns", { exact: true }).click();
  const visibleColumns = page.getByRole("group", {
    name: "Visible columns",
  });
  await expect(visibleColumns).toBeVisible();
  await visibleColumns.getByLabel("Submitter").uncheck();
  await expect(
    table.getByRole("columnheader", { name: "Submitter" }),
  ).toHaveCount(0);

  expect(new URL(page.url()).searchParams.get("status")).toBe("assigned");
});
