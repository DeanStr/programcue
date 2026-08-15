import { expect, test } from "@playwright/test";

import {
  applicationTurnstileAppearances,
  completeApplicationTurnstile,
  installApplicationTurnstileMock,
  waitForApplicationTurnstileActions,
} from "./support/mock-turnstile";
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
    const invitationHeading = `Bring your clearest idea ${unique}`;
    const invitationText =
      "Explain the practical lesson and what attendees will be able to use.";
    await page.getByText("Public landing page", { exact: true }).click();
    await page.getByLabel("Invitation heading").fill(invitationHeading);
    await page.getByLabel("Invitation copy").fill(invitationText);
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(
      page.locator(".validation-item.ok[role='status']").filter({
        hasText: "Draft form saved.",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Publish version" }),
    ).toBeEnabled();
    await page.reload();
    await page.getByText("Public landing page", { exact: true }).click();
    await expect(page.getByLabel("Invitation heading")).toHaveValue(
      invitationHeading,
    );
    await expect(page.getByLabel("Invitation copy")).toHaveValue(
      invitationText,
    );
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
    await page.getByLabel("Public URL").fill(`unsaved-public-url-${unique}`);
    await expect(
      page.getByRole("link", { name: /Open public form/ }),
    ).toHaveAttribute("href", "/apply/form");
    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByRole("button", { name: "Copy public form link" }).click();
    await expect(page.getByText("Public form link copied.")).toBeVisible();
    const expectedPublicFormUrl = new URL("/apply/form", page.url()).href;
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(expectedPublicFormUrl);
    await page.goto("/apply/form");
    await expect(
      page.getByRole("heading", { name: invitationHeading }),
    ).toBeVisible();
    await expect(page.getByText(invitationText)).toBeVisible();
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
      editor.getByRole("textbox", { name: visualLabel }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole("button", { name: "Save draft" }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(
      page.locator(".validation-item.ok[role='status']").filter({
        hasText: "Draft form saved.",
      }),
    ).toBeVisible();

    await page.reload();
    await expect(
      page.getByLabel("Visual call-for-speakers form editor"),
    ).toBeVisible();
    await expect(
      page
        .getByLabel("Visual call-for-speakers form editor")
        .getByRole("textbox", { name: visualLabel }),
    ).toBeVisible({ timeout: 10_000 });
  });

  test("application entry waits for an interaction-only security token", async ({
    page,
  }) => {
    await installApplicationTurnstileMock(page);

    await page.goto("/apply/form");
    const checking = page
      .getByRole("button", { name: "Security check in progress…" })
      .first();
    await expect(checking).toBeDisabled();
    await waitForApplicationTurnstileActions(page, [
      "application_request_code",
      "application_start_anonymous",
    ]);
    expect(await applicationTurnstileAppearances(page)).toEqual({
      application_request_code: "interaction-only",
      application_start_anonymous: "interaction-only",
    });

    await completeApplicationTurnstile(
      page,
      "application_start_anonymous",
      "test-start-token",
    );
    const start = page.getByRole("button", { name: "Start application" });
    await expect(start).toBeEnabled();
    await expect(
      start
        .locator("xpath=ancestor::form")
        .locator('input[name="turnstile-token"]'),
    ).toHaveValue("test-start-token");

    await completeApplicationTurnstile(
      page,
      "application_request_code",
      "test-request-token",
    );
    await page
      .getByLabel("Email address")
      .fill(`turnstile-transition-${Date.now()}@example.com`);
    const requestCode = page.getByRole("button", {
      name: "Send verification code",
    });
    await expect(requestCode).toBeEnabled();
    await requestCode.click();

    await expect(
      page.getByRole("heading", { name: "Enter your verification code" }),
    ).toBeVisible();
    const verify = page.getByRole("button", {
      name: "Security check in progress…",
    });
    await expect(verify).toBeDisabled();
    await waitForApplicationTurnstileActions(page, ["application_verify_code"]);
    await completeApplicationTurnstile(
      page,
      "application_verify_code",
      "test-verify-token",
    );
    await expect(
      page.getByRole("button", { name: "Verify and open drafts" }),
    ).toBeEnabled();
  });

  test("applicant verifies email, saves a multi-speaker draft, submits it and appears in the admin queue", async ({
    page,
  }) => {
    const unique = Date.now();
    const email = `browser-applicant-${unique}@example.com`;
    const title = `Operational clarity ${unique}`;

    await page.goto("/apply/form");
    await expect(
      page.getByRole("heading", { name: "Future of Events 2027" }),
    ).toBeVisible();
    await expect(page.getByText("Preview the application")).toBeVisible();
    await expect(page.getByText(/Up to \d+ proposal questions/)).toBeVisible();
    await expect(page.getByText("about 12 minutes")).toBeVisible();
    const applicationEntry = page.getByRole("link", {
      name: "Continue to application",
    });
    await expect(applicationEntry).toBeVisible();
    await applicationEntry.click();
    await expect(page).toHaveURL(/#apply$/u);
    await expect(
      page.getByRole("button", { name: "Start application" }),
    ).toBeVisible();
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
    await page.route("**/apply/form/import/sessionize", async (route) => {
      await route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          profile: {
            name: "Imported Speaker",
            biography: "Imported public biography for review.",
            tagline: "Practical systems speaker",
            sourceUrl: "https://sessionize.com/imported-speaker/",
          },
        }),
      });
    });
    await page.getByLabel("Sessionize public profile").fill("imported-speaker");
    await page.getByRole("button", { name: "Import profile" }).click();
    await expect(page.getByText("Imported for review")).toBeVisible();
    await expect(page.getByLabel("Speaker 1 name")).toHaveValue(
      "Imported Speaker",
    );
    await expect(page.getByLabel("Biography").last()).toHaveValue(
      "Imported public biography for review.",
    );
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
        hasText: "Your draft has been saved.",
      }),
    ).toBeVisible();
    await page.getByText("I have reviewed this application").click();
    await page.getByRole("button", { name: "Submit application" }).click();
    await expect(
      page.locator(".validation-item.ok[role='status']").filter({
        hasText: "Your application has been submitted.",
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Save revised application" }),
    ).toBeVisible();
    await page
      .locator("summary")
      .filter({ hasText: "Withdraw application" })
      .click();
    await expect(
      page.getByRole("button", { name: "Withdraw application" }),
    ).toBeVisible();
    const revisionSentence = "Updated: now includes 2026 benchmark data.";
    const description = page.getByLabel("Session description *");
    await description.fill(
      `${await description.inputValue()} ${revisionSentence}`,
    );
    await page
      .getByText(
        "I have reviewed these changes and am ready to replace the current submitted version.",
      )
      .click();
    await page
      .getByRole("button", { name: "Save revised application" })
      .click();
    await expect(
      page.locator(".validation-item.ok[role='status']").filter({
        hasText: "Your revised application has been submitted.",
      }),
    ).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Session description *")).toHaveValue(
      new RegExp(`${revisionSentence.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
    );

    await page.goto("/admin/submissions");
    const filters = page.getByRole("search");
    await filters.getByLabel("Search", { exact: true }).fill(title);
    await filters.getByRole("button", { name: "Apply filters" }).click();
    await expect(page.getByRole("link", { name: title })).toBeVisible();
    await page.getByRole("link", { name: title }).click();
    await expect(page.getByRole("heading", { name: title })).toBeVisible();
    await expect(page.locator("body")).toContainText(revisionSentence);
    const routing = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Routing", exact: true }),
    });
    await expect(
      routing.getByText(/Call for Speakers · Form version \d+/),
    ).toBeVisible();
    await expect(
      routing.getByText(/Selected “Event Operations” →/),
    ).toContainText("No automatic review-team route configured");
    await expect(routing).toContainText(
      "Review-team routing records the intended review destination",
    );
    await expect(
      page.getByRole("link", { name: "Open in Review" }),
    ).toHaveAttribute(
      "href",
      /\/admin\/review\?submission=[^#]+#review-submission-/,
    );
    await expect(
      page.getByRole("link", { name: "View activity" }),
    ).toHaveAttribute("href", /panel=activity&activityQuery=/);
    await expect(
      page.getByRole("link", { name: "Return to filtered queue" }),
    ).toBeVisible();
    await expect(page.getByText("Casey Collaborator")).toBeVisible();
    await page.getByRole("link", { name: "Return to filtered queue" }).click();
    const routingFilters = page.getByRole("search");
    await routingFilters
      .getByLabel("Routing attention")
      .selectOption("missing_automatic");
    await routingFilters.getByRole("button", { name: "Apply filters" }).click();
    const filteredSubmissionRow = page.getByRole("row").filter({
      has: page.getByRole("link", { name: title }),
    });
    await expect(filteredSubmissionRow).toBeVisible();
    await expect(filteredSubmissionRow).toContainText(
      "No automatic team route",
    );
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
