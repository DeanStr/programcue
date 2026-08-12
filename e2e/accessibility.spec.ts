import { expect, test } from "@playwright/test";

import { e2eOrigin } from "./support/e2e-origin";

async function waitForInterface(
  page: import("@playwright/test").Page,
  path: string,
) {
  const response = await page.goto(path);
  expect(response?.ok()).toBeTruthy();
  await page.locator("body[data-hydrated='true']").waitFor();
}

async function selectDemoRole(
  page: import("@playwright/test").Page,
  role: "administrator" | "speaker",
) {
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

test("skip navigation and command palette preserve keyboard focus", async ({
  page,
}) => {
  await waitForInterface(page, "/admin/event");

  await page.keyboard.press("Tab");
  const skipLink = page.getByRole("link", { name: "Skip to main content" });
  await expect(skipLink).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();

  const trigger = page.getByRole("button", {
    name: /search or run a command/i,
  });
  await trigger.click();
  await expect(
    page.getByRole("dialog", { name: "Search or run a command" }),
  ).toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Program Cue commands" }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();

  await page.keyboard.press("Control+k");
  await expect(
    page.getByRole("dialog", { name: "Search or run a command" }),
  ).toBeVisible();
});

test("route announcements describe page changes but ignore same-page actions", async ({
  page,
}) => {
  await page.context().addCookies([
    {
      name: "program_cue_event",
      value: "evt-foe-2025",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await waitForInterface(page, "/admin/event");
  const announcement = page.locator("[data-pc-route-announcement]");
  await expect(announcement).toBeEmpty();

  await page.getByLabel("End date").fill("2025-05-19");
  await page.getByRole("button", { name: "Save event" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "End date cannot be before the start date",
  );
  await expect(announcement).toBeEmpty();

  await page.getByRole("link", { name: "Command Centre", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Command Centre", level: 1 }),
  ).toBeVisible();
  await expect(announcement).toHaveText(await page.title());
});

test("admin child-route errors preserve navigation and event context", async ({
  page,
}) => {
  const response = await page.goto("/admin/speakers/not-a-speaker");
  expect(response?.status()).toBe(404);
  await page.locator("body[data-hydrated='true']").waitFor();

  await expect(
    page.getByRole("heading", { name: "Page not found", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Primary navigation" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Switch event" })).toContainText(
    "Future of Events 2025",
  );
});

test("shared form errors connect labels, help and corrective links", async ({
  page,
}) => {
  await waitForInterface(page, "/design/system");

  const email = page.getByRole("textbox", { name: /operations email/i });
  await expect(email).toHaveAttribute("aria-invalid", "true");
  await expect(email).toHaveAttribute("aria-required", "true");
  const describedBy = await email.getAttribute("aria-describedby");
  expect(describedBy?.split(" ")).toHaveLength(2);

  const summary = page.getByRole("alert", { name: "There is a problem" });
  await expect(summary).toContainText(
    "Enter a complete operations email address.",
  );
  await summary.getByRole("link").click();
  await expect(email).toBeFocused();

  const pendingButton = page.getByRole("button", { name: "Saving" });
  await expect(pendingButton).toBeDisabled();
  await expect(pendingButton).toHaveAttribute("aria-busy", "true");
});

for (const path of ["/admin/submissions/form", "/design/system"] as const) {
  test(`${path} exposes a name for every form control`, async ({ page }) => {
    await waitForInterface(page, path);
    if (path === "/admin/submissions/form") {
      await page.locator(".fjs-palette-search").waitFor();
    }
    const unnamedControls = await page
      .locator("input:not([type='hidden']), select, textarea")
      .evaluateAll((controls) =>
        controls
          .filter((control) => {
            const element = control as HTMLInputElement;
            return (
              !element.labels?.length &&
              !element.getAttribute("aria-label") &&
              !element.getAttribute("aria-labelledby")
            );
          })
          .map((control) => control.outerHTML),
      );
    expect(unnamedControls).toEqual([]);
  });
}

test("review scoring exposes every criterion control at mobile width", async ({
  page,
}) => {
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
  await page.setViewportSize({ width: 412, height: 915 });
  await waitForInterface(page, "/review/workbench");

  for (const name of [
    "Audience relevance",
    "Content substance",
    "Practical value",
    "Delivery approach",
  ]) {
    await expect(page.getByRole("combobox", { name })).toBeVisible();
  }
  await expect(
    page.getByRole("button", { name: "Return to organizer demo" }),
  ).toBeVisible();
  const overflow = await page.evaluate(
    () =>
      document.documentElement.scrollWidth -
      document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test("representative shells remain usable at a 200 percent equivalent layout viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 720, height: 500 });
  for (const path of [
    "/admin/submissions",
    "/apply/form",
    "/public/programme/future-of-events-2025",
    "/participant/dashboard",
    "/participant/tasks",
    "/admin/communications/compose",
    "/design/system",
  ] as const) {
    if (path.startsWith("/participant/")) await selectDemoRole(page, "speaker");
    if (path.startsWith("/admin/")) await selectDemoRole(page, "administrator");
    await waitForInterface(page, path);
    await expect(page.locator("#main")).toBeVisible();
    const overflow = await page.evaluate(
      () =>
        document.documentElement.scrollWidth -
        document.documentElement.clientWidth,
    );
    expect(
      overflow,
      `${path} should contain horizontal overflow inside its local work area`,
    ).toBeLessThanOrEqual(1);
  }
});

test("fixed mobile admin chrome does not cover the page title", async ({
  page,
}) => {
  await page.setViewportSize({ width: 412, height: 915 });
  await waitForInterface(page, "/admin/submissions");
  const topbar = await page.locator(".topbar").boundingBox();
  const heading = await page
    .getByRole("heading", { name: "Submissions", level: 1 })
    .boundingBox();
  expect(topbar).not.toBeNull();
  expect(heading).not.toBeNull();
  expect(heading!.y).toBeGreaterThanOrEqual(topbar!.y + topbar!.height);
});

test("representative surfaces have one primary main landmark and unique ids", async ({
  page,
}) => {
  for (const path of [
    "/admin/event",
    "/admin/review",
    "/apply/form",
    "/public/programme/future-of-events-2025",
    "/participant/resources",
    "/participant/tasks",
    "/admin/communications/compose",
    "/design/system",
  ] as const) {
    if (path.startsWith("/participant/")) await selectDemoRole(page, "speaker");
    if (path.startsWith("/admin/")) await selectDemoRole(page, "administrator");
    await waitForInterface(page, path);
    await expect(page.locator("main#main")).toHaveCount(1);
    const duplicateIds = await page.locator("[id]").evaluateAll((elements) => {
      const ids = elements.map((element) => element.id);
      return ids.filter((id, index) => ids.indexOf(id) !== index);
    });
    expect(duplicateIds).toEqual([]);
  }
});

test("resource authoring exposes the rich editor and formatting state", async ({
  page,
}) => {
  await waitForInterface(page, "/admin/resources");
  await expect(
    page.locator('[contenteditable="true"][aria-label="Page content"]'),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Bold" })).toHaveAttribute(
    "aria-pressed",
  );
});

test("server-rendered timestamps hydrate in a non-UTC browser timezone", async ({
  browser,
}) => {
  const context = await browser.newContext({
    baseURL: e2eOrigin,
    locale: "en-US",
    timezoneId: "America/Los_Angeles",
  });
  const page = await context.newPage();
  const hydrationErrors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /hydration|didn't match/i.test(message.text())
    )
      hydrationErrors.push(message.text());
  });
  for (const path of [
    "/admin/operations",
    "/admin/settings",
    "/admin/submissions/form",
    "/participant/resources",
    "/admin/communications/compose",
    "/admin/integrations",
  ] as const) {
    if (path.startsWith("/participant/")) await selectDemoRole(page, "speaker");
    if (path.startsWith("/admin/")) await selectDemoRole(page, "administrator");
    await waitForInterface(page, path);
  }
  expect(hydrationErrors).toEqual([]);
  await context.close();
});
