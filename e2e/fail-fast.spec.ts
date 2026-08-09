import { expect, test } from "@playwright/test";

test("explicit unknown admin record links show not found instead of another record", async ({ page }) => {
  const response = await page.goto(
    "/admin/submissions/form?form=missing-browser-record",
  );
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});
