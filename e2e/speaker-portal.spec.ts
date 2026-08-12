import { expect, test } from "@playwright/test";

test("speaker profile, sessions and D1 task state render through the production portal", async ({
  page,
}) => {
  await page.context().addCookies([
    {
      name: "program_cue_demo_identity",
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
  await page.goto("/participant/dashboard");
  await expect(
    page.getByRole("heading", { name: /Welcome back, Priya/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("progressbar", { name: /complete/ }),
  ).toHaveAttribute("aria-valuenow");
  await expect(page.getByRole("link", { name: "Overview" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await page.getByRole("link", { name: "My sessions", exact: true }).click();
  await expect(page).toHaveURL(/\/participant\/sessions$/u);
  await expect(
    page.getByRole("heading", { name: "Designing inclusive event technology" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Tasks" }).click();
  await expect(page).toHaveURL(/\/participant\/tasks$/u);
  await expect(
    page.getByRole("heading", { name: "Upload presentation slides" }).first(),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Tasks" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(
    page.getByRole("link", { name: "Overview" }),
  ).not.toHaveAttribute("aria-current");
  await page.getByRole("link", { name: "Files" }).click();
  await expect(page.getByRole("link", { name: /^Download / })).toHaveCount(0);
  await page.getByRole("link", { name: "Profile" }).click();
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByRole("status")).toContainText("Profile saved to D1");
  await page.reload();
  await expect(page.getByLabel("Job title")).toHaveValue(/Director/);
});

test("a submitter enters the same participant workspace and can open applications", async ({
  page,
}) => {
  await page.context().addCookies([
    {
      name: "program_cue_demo_identity",
      value: "submitter",
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
  await page.goto("/participant/dashboard");
  await expect(
    page.getByRole("navigation", { name: "Participant workspace" }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Applications" }).first().click();
  await expect(page).toHaveURL(/\/participant\/applications$/u);
  await expect(
    page.getByRole("heading", { name: "Applications", level: 1 }),
  ).toBeVisible();
});

test("an administrator demo identity cannot use a speaker-owned portal", async ({
  page,
}) => {
  await page.goto("/admin/event");
  await page.evaluate(
    () => (document.cookie = "program_cue_demo_identity=administrator; Path=/"),
  );
  const response = await page.goto("/participant/dashboard");
  expect(response?.status()).toBe(403);
  await expect(page.getByText(/do not have permission/i)).toBeVisible();
});

test("organiser speaker detail edits the profile and keeps a durable save confirmation", async ({
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
  await page.goto("/admin/speakers");
  await page.getByRole("link", { name: "Priya Shah" }).click();
  await expect(page).toHaveURL(/\/admin\/speakers\/person-demo-speaker$/u);
  await expect(
    page.getByRole("heading", { name: "Priya Shah", level: 1 }),
  ).toBeVisible();

  await expect(
    page.getByRole("heading", { name: "Linked sessions" }),
  ).toBeVisible();
  await expect(
    page.getByRole("cell", { name: /Designing inclusive event technology/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Uploaded files and versions" }),
  ).toBeVisible();

  const notice = page.locator(".pc-status-notice");
  await page.getByLabel("Job title").fill("Head of Experience Design");
  await page.getByLabel("Profile status").selectOption("published");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(notice).toContainText("Saved to D1 as revision");

  // The durable confirmation is server state, so it survives a reload while the
  // transient action notice does not.
  await page.reload();
  await expect(page.getByLabel("Job title")).toHaveValue(
    "Head of Experience Design",
  );
  await expect(page.getByText(/Last saved .* · revision \d+/)).toBeVisible();
  await expect(notice).toHaveCount(0);

  // A second organiser holding the previous revision is refused rather than
  // silently overwriting the saved profile.
  const stalePage = await page.context().newPage();
  await stalePage.goto("/admin/speakers/person-demo-speaker");
  await page.getByLabel("Name pronunciation").fill("PREE-yah SHAH");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(notice).toContainText("Saved to D1");
  await stalePage.getByLabel("Job title").fill("Stale Organiser Title");
  await stalePage.getByRole("button", { name: "Save profile" }).click();
  await expect(stalePage.getByRole("alert")).toContainText(
    "changed after the page loaded",
  );
  await stalePage.close();
  await page.reload();
  await expect(page.getByLabel("Job title")).toHaveValue(
    "Head of Experience Design",
  );

  // Restore the seeded demo identity for later specs.
  await page.getByLabel("Job title").fill("Director of Experience Design");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(notice).toContainText("Saved to D1 as revision");
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
