import { expect, type Page } from "@playwright/test";

/**
 * Consequential actions used to be guarded by window.confirm, which Playwright
 * drove with page.on("dialog"). They now use the in-app ConfirmDialog, which
 * can show the affected records and restore focus. These drive that instead.
 */
export function confirmDialog(page: Page) {
  return page.getByRole("dialog").filter({ has: page.locator("[data-pc-confirm]") });
}

export async function acceptConfirm(page: Page) {
  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.locator("[data-pc-confirm='accept']").click();
  await expect(dialog).toBeHidden();
}

export async function dismissConfirm(page: Page) {
  const dialog = confirmDialog(page);
  await expect(dialog).toBeVisible();
  await dialog.locator("[data-pc-confirm='cancel']").click();
  await expect(dialog).toBeHidden();
}
