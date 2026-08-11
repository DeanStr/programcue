import { expect, test } from "@playwright/test";

import { resetDemoSubmissions } from "./support/reset-demo-submissions";

test.describe.serial("submissions vertical slice", () => {
  test.beforeEach(async ({ page }) => {
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
  });

  test.beforeAll(async ({ request }) => {
    await resetDemoSubmissions(request, { verifiedLocalSender: true });
  });

  test.afterAll(async ({ request }) => {
    await resetDemoSubmissions(request);
  });

  test("administrator edits and publishes an immutable form version", async ({
    page,
  }) => {
    const unique = Date.now();
    await page.goto("/admin/submissions/form");
    await expect(
      page.getByRole("heading", { name: "Call for Speakers Form Builder" }),
    ).toBeVisible();
    await page
      .getByLabel("Introduction")
      .fill(
        "Bring a practical idea, evidence from real delivery, and a clear attendee takeaway.",
      );
    await page
      .locator(".field-library")
      .getByRole("button", { name: /^＋\s*URL$/u })
      .click();
    await page.getByLabel("Stable field ID").fill(`takeaway_url_${unique}`);
    await page
      .getByLabel("Label", { exact: true })
      .fill(`Attendee takeaway link ${unique}`);
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(
      page.locator(".validation-item.ok[role='status']").filter({
        hasText: "Draft form saved to D1",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Publish version" }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Publish version" }).click();
    await expect(
      page.getByRole("heading", {
        name: "Publish this application form version?",
      }),
    ).toBeVisible();
    await expect(
      page.getByText("will immediately replace the current public application"),
    ).toBeVisible();
    await page.getByRole("button", { name: "Confirm publication" }).click();
    await expect(
      page.locator(".validation-item.ok[role='status']").filter({
        hasText: "Published a new immutable form version",
      }),
    ).toBeVisible();
    await expect(page.getByText("published").first()).toBeVisible();
  });

  test("visual form authoring maps through the Program Cue adapter before saving", async ({
    page,
  }) => {
    const visualLabel = `Session title visual ${Date.now()}`;
    await page.goto("/admin/submissions/form");

    const editor = page.getByLabel("Visual call-for-speakers form editor");
    await expect(editor).toBeVisible();
    await expect(editor.getByTitle("Powered by bpmn.io")).toBeVisible();
    await editor
      .locator('.fjs-element[data-id="ProgramCue_Field_title"]')
      .click();
    await editor.getByText("General", { exact: true }).click();
    await expect(editor.getByLabel("Field label")).toBeVisible();
    await editor.getByLabel("Field label").fill(visualLabel);

    await expect(
      page.getByText(visualLabel, { exact: true }).first(),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Save draft" }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(
      page.locator(".validation-item.ok[role='status']").filter({
        hasText: "Draft form saved to D1",
      }),
    ).toBeVisible();

    await page.reload();
    await expect(
      page.getByLabel("Visual call-for-speakers form editor"),
    ).toBeVisible();
    await expect(
      page.getByText(visualLabel, { exact: true }).first(),
    ).toBeVisible();
  });

  test("applicant verifies email, saves a multi-speaker draft, submits it and appears in the admin queue", async ({
    page,
  }) => {
    const unique = Date.now();
    const email = `browser-applicant-${unique}@example.com`;
    const title = `Operational clarity ${unique}`;

    await page.goto("/apply/form");
    await page.getByLabel("Email address").fill(email);
    await page.getByRole("button", { name: "Send verification code" }).click();
    await expect(page.getByText("No email was sent")).toBeVisible();
    await page.getByLabel("Six-digit code").fill("000000");
    await page.getByRole("button", { name: "Verify and open drafts" }).click();
    await expect(page.getByRole("alert")).toContainText(/verification code/i);
    await expect(page.getByLabel("Six-digit code")).toBeVisible();
    await page.getByLabel("Six-digit code").fill("424242");
    await page.getByRole("button", { name: "Verify and open drafts" }).click();
    await expect(
      page.getByRole("heading", { name: "Call for Speakers" }),
    ).toBeVisible();

    await page.getByRole("button", { name: "Start application" }).click();
    await page.getByLabel("Session title *").fill(title);
    await page
      .getByLabel("Session description *")
      .fill(
        "A detailed, practical case study about removing ambiguity from event programme delivery.",
      );
    await page.getByLabel("Event Operations").check();
    await page.getByLabel("Format *").selectOption("Workshop");
    await expect(page.getByLabel("Materials and room setup *")).toBeVisible();
    await page
      .getByLabel("Materials and room setup *")
      .fill("Moveable tables, a projector, and sticky notes.");
    await page.getByLabel("Speaker 1 name").fill("Avery Applicant");
    await page.getByRole("button", { name: "Add co-speaker" }).click();
    await page.getByLabel("Speaker 2 name").fill("Casey Collaborator");
    const coSpeakerEmail = page.getByLabel("Email").nth(1);
    await coSpeakerEmail.click();
    await coSpeakerEmail.pressSequentially(
      `browser-cospeaker-${unique}@example.com`,
    );
    await expect(coSpeakerEmail).toBeFocused();

    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(
      page.locator(".validation-item.ok[role='status']").filter({
        hasText: "This draft is stored in D1.",
      }),
    ).toBeVisible();
    await page.getByText("I have reviewed this application").click();
    await page.getByRole("button", { name: "Submit application" }).click();
    await expect(
      page.locator(".validation-item.ok[role='status']").filter({
        hasText: "This application is submitted and stored in D1.",
      }),
    ).toBeVisible();
    await expect(
      page.getByText("This immutable application was received"),
    ).toBeVisible();

    await page.goto("/admin/submissions");
    const filters = page.getByRole("search");
    await filters.getByLabel("Search", { exact: true }).fill(title);
    await filters.getByRole("button", { name: "Apply filters" }).click();
    await expect(page.getByRole("link", { name: title })).toBeVisible();
    await page.getByRole("link", { name: title }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    const routing = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Routing", exact: true }),
    });
    await expect(
      routing.locator("p").filter({ hasText: "Assigned team" }),
    ).toContainText("Unassigned");
    await expect(page.getByText("Casey Collaborator")).toBeVisible();
  });

  test("administrator creates a guaranteed direct session", async ({
    page,
  }) => {
    const unique = Date.now();
    await page.goto("/admin/submissions");
    const directSession = page.locator("details").filter({
      has: page.getByText("Create a guaranteed direct session", {
        exact: true,
      }),
    });
    await directSession
      .getByText("Create a guaranteed direct session", { exact: true })
      .click();
    await directSession
      .getByLabel("Session title")
      .fill(`Sponsor briefing ${unique}`);
    await directSession.getByLabel("Track").selectOption({ index: 1 });
    await directSession
      .getByLabel("Description")
      .fill("A confirmed sponsor programme contribution.");
    await directSession.getByLabel("Speaker 1 name").fill("Morgan Sponsor");
    await directSession
      .getByLabel("Email", { exact: true })
      .fill(`sponsor-${unique}@example.com`);
    await directSession
      .getByRole("button", { name: "Create unscheduled session" })
      .click();
    await expect(
      page.locator(".validation-item.ok[role='status']").filter({
        hasText: "Direct session created in the unscheduled programme.",
      }),
    ).toBeVisible();
  });
});
