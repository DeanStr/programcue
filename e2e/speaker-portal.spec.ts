import { expect, test } from "@playwright/test";

test("speaker profile, sessions and D1 task state render through the production portal", async ({
  page,
}) => {
  await page.context().addCookies([
    {
      name: "program_cue_demo_role",
      value: "speaker",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
    {
      name: "program_cue_event",
      value: "evt-foe-2025",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto("/speaker/dashboard");
  await expect(
    page.getByRole("heading", { name: /Welcome back, Priya/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Designing inclusive event technology" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Upload presentation slides" }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole("progressbar", { name: /complete/ }),
  ).toHaveAttribute("aria-valuenow");
  await expect(page.getByRole("link", { name: "Dashboard" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.getByRole("link", { name: "Tasks" }).click();
  await expect(page.getByRole("link", { name: "Tasks" })).toHaveAttribute(
    "aria-current",
    "location",
  );
  await expect(
    page.getByRole("link", { name: "Dashboard" }),
  ).not.toHaveAttribute("aria-current");
  await expect(page.getByRole("link", { name: /^Download / })).toHaveCount(0);
  await page.locator("#profile").scrollIntoViewIfNeeded();
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByRole("status")).toContainText("Profile saved to D1");
  await page.reload();
  await expect(page.getByLabel("Job title")).toHaveValue(/Director/);
});

test("an administrator demo identity cannot use a speaker-owned portal", async ({
  page,
}) => {
  await page.goto("/admin/event");
  await page.evaluate(
    () => (document.cookie = "program_cue_demo_role=administrator; Path=/"),
  );
  const response = await page.goto("/speaker/dashboard");
  expect(response?.status()).toBe(403);
  await expect(page.getByText(/do not have permission/i)).toBeVisible();
});

test("administrator speaker filters use the event-scoped server list", async ({
  page,
}) => {
  await page.goto("/admin/speakers");
  await expect(
    page.getByRole("heading", { name: "Speaker readiness" }),
  ).toBeVisible();
  await expect(page.getByText("Priya Shah", { exact: true })).toBeVisible();

  await page.getByLabel("Readiness").selectOption("needs_attention");
  await page.getByRole("button", { name: "Apply filters" }).click();

  await expect(page).toHaveURL(/readiness=needs_attention/u);
  await expect(page.getByLabel("Readiness")).toHaveValue("needs_attention");
  await expect(page.getByText("Priya Shah", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "Needs attention", exact: true }),
  ).toBeVisible();
});
