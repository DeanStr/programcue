import type { Page } from "@playwright/test";

/**
 * Event Setup collapses its three record editors — rooms, tracks and session
 * formats — because their height grows with the event. Opening one is a
 * precondition for touching the rows inside it. Deep links such as
 * `?room=<id>` open the relevant panel on their own.
 */
export async function openRecordPanel(page: Page, heading: string) {
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
