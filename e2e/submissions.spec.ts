import { expect, test } from "@playwright/test";

import { resetDemoSubmissions } from "./support/reset-demo-submissions";

test.describe.serial("submissions vertical slice", () => {
  test.beforeAll(async ({ request }) => {
    await resetDemoSubmissions(request);
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
    await page.getByRole("button", { name: /URL$/ }).click();
    await page.getByLabel("Stable field ID").fill(`takeaway_url_${unique}`);
    await page
      .getByLabel("Label", { exact: true })
      .fill(`Attendee takeaway link ${unique}`);
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(page.getByRole("status")).toContainText(
      "Draft form saved to D1",
    );
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
    await expect(page.getByRole("status")).toContainText(
      "Published a new immutable form version",
    );
    await expect(page.getByText("published").first()).toBeVisible();
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
    await page
      .getByLabel("Session category *")
      .selectOption("Event Operations");
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
    await expect(page.getByRole("status")).toContainText(
      "This draft is stored in D1.",
    );
    await page.getByText("I have reviewed this application").click();
    await page.getByRole("button", { name: "Submit application" }).click();
    await expect(page.getByRole("status")).toContainText(
      "This application is submitted and stored in D1.",
    );
    await expect(
      page.getByText("This immutable application was received"),
    ).toBeVisible();

    await page.goto("/admin/submissions");
    await page.getByLabel("Search").fill(title);
    await page.getByRole("button", { name: "Apply filters" }).click();
    await expect(page.getByRole("link", { name: title })).toBeVisible();
    await page.getByRole("link", { name: title }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(page.getByText("Programme committee")).toBeVisible();
    await expect(page.getByText("Casey Collaborator")).toBeVisible();
  });

  test("administrator creates a guaranteed direct session", async ({
    page,
  }) => {
    const unique = Date.now();
    await page.goto("/admin/submissions");
    await page.getByText("Create a guaranteed direct session").click();
    await page.getByLabel("Session title").fill(`Sponsor briefing ${unique}`);
    await page
      .getByLabel("Description")
      .fill("A confirmed sponsor programme contribution.");
    await page.getByLabel("Speaker name").fill("Morgan Sponsor");
    await page
      .getByLabel("Speaker email")
      .fill(`sponsor-${unique}@example.com`);
    await page
      .getByRole("button", { name: "Create unscheduled session" })
      .click();
    await expect(page.getByRole("status")).toContainText(
      "Direct session created",
    );
  });
});
