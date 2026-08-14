import { expect, test, type Page } from "@playwright/test";

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
  const sessionCard = page
    .locator(".speaker-session-card")
    .filter({ hasText: "Designing inclusive event technology" });
  await expect(sessionCard).toContainText("Confirmation needed");
  await sessionCard
    .getByRole("button", { name: "Confirm participation" })
    .click();
  await expect(page.getByRole("status")).toContainText(
    "Participation confirmed",
  );
  await expect(sessionCard).toContainText("Confirmed");
  await expect(
    sessionCard.getByRole("button", { name: "Confirm participation" }),
  ).toHaveCount(0);
  await page.reload();
  await expect(sessionCard).toContainText("Confirmed");
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
  await expect(
    page.getByRole("link", { name: "Upload headshot" }),
  ).toHaveAttribute("href", "/participant/files#headshot-upload");
  await page
    .getByLabel("LinkedIn profile URL")
    .fill("https://www.linkedin.com/in/priya-shah");
  await page.getByLabel("X handle").fill("@priya_shah");
  await page
    .getByLabel("Travel and logistics preferences")
    .fill("Arrival May 11, aisle seat; dietary: Vegetarian");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByRole("status")).toContainText("Your profile was saved");
  await page.reload();
  await expect(page.getByLabel("Job title")).toHaveValue(/Director/);
  await expect(page.getByLabel("LinkedIn profile URL")).toHaveValue(
    "https://www.linkedin.com/in/priya-shah",
  );
  await expect(page.getByLabel("X handle")).toHaveValue("@priya_shah");
  await expect(page.getByLabel("Travel and logistics preferences")).toHaveValue(
    "Arrival May 11, aisle seat; dietary: Vegetarian",
  );

  await page.getByLabel("LinkedIn profile URL").fill("");
  await page.getByLabel("X handle").fill("");
  await page.getByLabel("Travel and logistics preferences").fill("");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(page.getByRole("status")).toContainText("Your profile was saved");
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
  await expect(
    page.getByRole("heading", { name: "You do not have access" }),
  ).toBeVisible();
});

async function useDemoEvent(page: Page) {
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
}

/**
 * Adds a speaker who exists in this event and nowhere else, and returns their
 * detail path.
 *
 * Editing is refused for an identity shared with another event, which is why
 * the seeded demo speaker cannot be used here: `event-context.spec.ts` adds
 * Priya Shah to a second event, and no product action removes a person from a
 * roster once added, so that association is permanent for the rest of the run.
 * A speaker created here has exactly one event association by construction, so
 * this test no longer depends on which specs ran before it.
 */
async function addEventOwnedSpeaker(page: Page, name: string, email: string) {
  await page.goto("/admin/speakers");
  await page.locator("body[data-hydrated='true']").waitFor();
  const addSpeaker = page.locator("details").filter({
    has: page.getByText("Add speaker record", { exact: true }),
  });
  await addSpeaker.locator("summary").click();
  await addSpeaker.getByLabel("Name", { exact: true }).fill(name);
  await addSpeaker.getByLabel("Email", { exact: true }).fill(email);
  await addSpeaker.getByRole("button", { name: "Add speaker record" }).click();
  // A new address matches no existing identity, so the duplicate confirmation
  // usually does not appear; accept it when it does rather than assume.
  const duplicateConfirmation = addSpeaker.getByLabel(
    /I reviewed these identities/,
  );
  if (await duplicateConfirmation.isVisible().catch(() => false)) {
    await duplicateConfirmation.check();
    await addSpeaker.getByRole("button", { name: "Add speaker record" }).click();
  }
  const row = page.getByRole("row").filter({
    has: page.getByRole("link", { name, exact: true }),
  });
  await expect(row).toBeVisible();
  await row.getByRole("link", { name, exact: true }).click();
  await expect(
    page.getByRole("heading", { name, level: 1, exact: true }),
  ).toBeVisible();
}

test("organiser speaker detail shows the event-scoped record for a seeded speaker", async ({
  page,
}) => {
  await useDemoEvent(page);
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
    page
      .locator('td[data-label="Session"]')
      .filter({ hasText: "Designing inclusive event technology" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Uploaded files and versions" }),
  ).toBeVisible();
  await expect(
    page.getByText("Upload speaker headshot", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Choose file")).toHaveAttribute(
    "accept",
    "image/jpeg,image/png,image/webp",
  );
});

test("organiser speaker detail edits the profile and keeps a durable save confirmation", async ({
  page,
}) => {
  await useDemoEvent(page);
  const suffix = Date.now();
  const name = `Rowan Ellis ${suffix}`;
  await addEventOwnedSpeaker(page, name, `rowan.ellis.${suffix}@example.com`);
  const detailPath = new URL(page.url()).pathname;

  const notice = page.locator(".pc-status-notice");
  await page.getByLabel("Job title").fill("Head of Experience Design");
  await page
    .getByLabel("LinkedIn profile URL")
    .fill("https://www.linkedin.com/in/rowan-ellis");
  await page.getByLabel("X handle").fill("@rowan_ellis");
  await page
    .getByLabel("Travel and logistics preferences")
    .fill("Arrival May 11, aisle seat; dietary: Vegetarian");
  await page.getByLabel("Profile status").selectOption("published");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(notice).toContainText("Profile saved.");

  // The durable confirmation is server state, so it survives a reload while the
  // transient action notice does not.
  await page.reload();
  await expect(page.getByLabel("Job title")).toHaveValue(
    "Head of Experience Design",
  );
  await expect(page.getByLabel("LinkedIn profile URL")).toHaveValue(
    "https://www.linkedin.com/in/rowan-ellis",
  );
  await expect(page.getByLabel("X handle")).toHaveValue("@rowan_ellis");
  await expect(page.getByLabel("Travel and logistics preferences")).toHaveValue(
    "Arrival May 11, aisle seat; dietary: Vegetarian",
  );
  await expect(page.getByText(/Last saved .* · revision \d+/)).toBeVisible();
  await expect(notice).toHaveCount(0);

  // A second organiser holding the previous revision is refused rather than
  // silently overwriting the saved profile.
  const stalePage = await page.context().newPage();
  await stalePage.goto(detailPath);
  await page.getByLabel("Name pronunciation").fill("ROH-an ELL-iss");
  await page.getByRole("button", { name: "Save profile" }).click();
  await expect(notice).toContainText("Profile saved.");
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
});

test("administrator speaker filters use the event-scoped server list", async ({
  page,
}) => {
  await page.goto("/admin/speakers");
  await expect(
    page.getByRole("heading", { name: "Speaker readiness" }),
  ).toBeVisible();
  await expect(page.getByText("Priya Shah", { exact: true })).toBeVisible();

  const readinessFilter = page.locator('select[name="readiness"]');
  await readinessFilter.selectOption("needs_attention");
  await page.getByRole("button", { name: "Apply filters" }).click();

  await expect(page).toHaveURL(/readiness=needs_attention/u);
  await expect(readinessFilter).toHaveValue("needs_attention");
  await expect(page.getByText("Priya Shah", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("cell", { name: "Needs attention", exact: true }),
  ).toBeVisible();
});
