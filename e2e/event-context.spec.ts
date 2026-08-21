import { expect, test } from "@playwright/test";
import { acceptConfirm } from "./support/confirm-dialog";
import { e2eOrigin } from "./support/e2e-origin";

test("home recovers from a stale event selection", async ({
  context,
  page,
}) => {
  await context.addCookies([
    {
      name: "program_cue_event",
      value: "evt-no-longer-authorised",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
    {
      name: "program_cue_demo_identity",
      value: "owner",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);

  await page.goto("/");

  await expect(page).toHaveURL(/\/events\/select\?returnTo=%2F$/u);
  await expect(
    page.getByRole("heading", { name: "Choose an event" }),
  ).toBeVisible();
  expect(
    (await context.cookies()).some(
      (cookie) => cookie.name === "program_cue_event",
    ),
  ).toBe(false);
});

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
      name: "program_cue_demo_identity",
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
  await page.getByRole("button", { name: "Create blank event" }).click();
  await acceptConfirm(page);
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
  await page.locator("body[data-hydrated='true']").waitFor();
  await expect(page.locator(".event-switcher strong")).toHaveText(eventName);
  await page.getByLabel("Event name").fill("   ");
  await page.getByRole("button", { name: "Save event" }).click();
  const priorEventError = page.getByRole("link", {
    name: "Event name is required.",
  });
  await expect(priorEventError).toBeVisible();

  await page.getByRole("button", { name: /Search or run a command/ }).click();
  await page
    .getByRole("button", { name: "Whole organisation", exact: true })
    .click();
  await page
    .getByRole("combobox", { name: "Program Cue commands" })
    .fill("room Main Stage");
  await page
    .getByRole("option", { name: /Main Stage.*Future of Events 2027/ })
    .click();
  const warning = page.getByRole("dialog", { name: "Leave without saving?" });
  await warning.getByRole("button", { name: "Leave and discard" }).click();

  await expect(page.locator(".event-switcher strong")).toHaveText(
    "Future of Events 2027",
  );
  await expect(page.getByLabel("Event name")).toHaveValue(
    "Future of Events 2027",
  );
  await expect(priorEventError).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Structure", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
});

test("an invited speaker can explicitly choose the created event and see its tasks", async ({
  context,
  page,
}) => {
  test.setTimeout(120_000);
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
      name: "program_cue_demo_identity",
      value: "owner",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const suffix = Date.now();
  const eventName = `DevFlow evaluator journey ${suffix}`;
  await page.goto("/admin/events/new");
  await page.getByLabel("Event name").fill(eventName);
  await page
    .getByLabel("Public slug")
    .fill(`devflow-evaluator-journey-${suffix}`);
  await page.getByRole("button", { name: "Create blank event" }).click();
  await acceptConfirm(page);
  await page.getByRole("button", { name: "Open new event" }).click();
  await expect(page.locator(".event-switcher strong")).toHaveText(eventName);
  const eventId = (await context.cookies()).find(
    (cookie) => cookie.name === "program_cue_event",
  )?.value;
  expect(eventId).toBeTruthy();

  await page.goto("/admin/speakers");
  await page.locator("body[data-hydrated='true']").waitFor();
  const addSpeakerSummary = page
    .locator("summary")
    .filter({ hasText: "Add speaker record" });
  await addSpeakerSummary.click();
  await page.locator("#manual-speaker-name").fill("Priya Shah");
  await page
    .locator('input[name="email"]')
    .filter({ visible: true })
    .fill("priya.speaker@example.com");
  await page
    .getByRole("button", { name: "Add speaker record", exact: true })
    .click();
  await page.getByLabel(/I reviewed these identities/).check();
  await page
    .getByRole("button", { name: "Add speaker record", exact: true })
    .click();
  await expect(
    page.getByText(
      /existing identity was added or restored on this event roster/i,
    ),
  ).toBeVisible();
  const priya = page.getByRole("row").filter({
    has: page.getByRole("link", { name: "Priya Shah" }),
  });
  await priya.getByLabel(/Confirm email to/).check();
  await priya.getByRole("button", { name: "Send portal invitation" }).click();
  await expect(
    page.getByText(/Demonstration mode does not send its sign-in email/i),
  ).toBeVisible();

  await page.goto("/admin/tasks");
  await page.locator("body[data-hydrated='true']").waitFor();
  await page.getByText("Create a template", { exact: true }).click();
  const createTemplate = page.getByRole("region", {
    name: "Create task template",
  });
  const taskName = `Confirm DevFlow participation ${suffix}`;
  await createTemplate.getByLabel("Name").fill(taskName);
  await createTemplate
    .getByLabel("Description")
    .fill("Confirm the event participation details.");
  await createTemplate.getByRole("button", { name: "Create template" }).click();
  await expect(page.getByText("Task template created.")).toBeVisible();
  await expect(createTemplate.getByLabel("Name")).toHaveValue("");
  await page.getByText("Plan and onboarding", { exact: true }).click();
  const assignment = page.locator("section").filter({
    has: page.getByRole("heading", { name: "Assign a plan" }),
  });
  await assignment
    .getByRole("button", { name: "Assign with prerequisites" })
    .click();
  await expect(page.getByText(/Task plan assigned/)).toBeVisible();

  const switched = await page.request.post("/demo/role", {
    form: { identity: "speaker", returnTo: "/events/select" },
    headers: { origin: e2eOrigin },
  });
  expect(switched.ok()).toBeTruthy();
  await page.goto(`/events/select?eventId=${encodeURIComponent(eventId!)}`);
  const devFlow = page.locator("main form").filter({ hasText: eventName });
  await expect(devFlow).toContainText("speaker invitation pending");
  await devFlow
    .getByRole("button", { name: "Accept speaker invitation and use event" })
    .click();
  await expect(page).toHaveURL(/\/participant\/dashboard$/);
  await expect(page.getByText(eventName, { exact: true })).toBeVisible();
  await page.goto("/participant/tasks");
  await expect(
    page.getByRole("heading", { name: "Tasks", exact: true, level: 1 }),
  ).toBeVisible();
  await expect(page.getByText(taskName, { exact: true })).toBeVisible();
});
