import type { Page } from "@playwright/test";

/**
 * Event Setup starts its primary Rooms editor open and collapses the longer
 * Tracks and Session formats editors. Opening a collapsed editor is a
 * precondition for touching the rows inside it. Deep links such as
 * `?room=<id>` open the relevant panel on their own.
 */
export async function openRecordPanel(page: Page, heading: string) {
  const structure = page.getByRole("button", {
    name: /^Structure$/,
    pressed: false,
  });
  if (await structure.isVisible()) await structure.click();
  const panel = page
    .locator("details.event-record-panel")
    .filter({ has: page.getByRole("heading", { name: heading, exact: true }) });
  await panel.waitFor();
  if (await panel.evaluate((element) => (element as HTMLDetailsElement).open))
    return;
  await panel.locator("summary").click();
  await panel.locator("summary").evaluate((element) => {
    // The click toggles synchronously; waiting for the row to paint keeps the
    // caller from racing the first interaction inside the panel.
    element.scrollIntoView({ block: "center" });
  });
}
