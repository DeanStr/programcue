import { expect, test } from "@playwright/test";

test("an event switch persists across reloads on the local HTTP Worker", async ({
  context,
  page,
}) => {
  await context.addCookies([
    {
      name: "program_cue_event",
      value: "evt-foe-2025",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
    {
      name: "program_cue_demo_role",
      value: "owner",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const eventName = "Event context browser check";
  await page.goto("/admin/events/new");
  await page.getByLabel("Event name").fill(eventName);
  await page.getByLabel("Public slug").fill("event-context-browser-check");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Create blank event" }).click();
  await expect(page.getByText("Event created", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Open new event" }).click();
  await expect(page.locator(".event-switcher strong")).toHaveText(eventName);

  const selectionCookie = (await context.cookies()).find(
    (cookie) => cookie.name === "program_cue_event",
  );
  expect(selectionCookie).toMatchObject({
    httpOnly: true,
    secure: false,
    sameSite: "Lax",
  });

  await page.reload();
  await expect(page.locator(".event-switcher strong")).toHaveText(eventName);
  await page
    .getByLabel("Event name")
    .fill("Unsaved configuration from the previous event");

  await page.locator(".event-switcher").click();
  const originalChoice = page
    .getByRole("dialog", { name: "Current event" })
    .locator("form")
    .filter({ hasText: "Future of Events 2025" });
  await originalChoice.getByRole("button", { name: "Switch event" }).click();
  await expect(page.locator(".event-switcher strong")).toHaveText(
    "Future of Events 2025",
  );
  await expect(page.getByLabel("Event name")).toHaveValue(
    "Future of Events 2025",
  );
});
