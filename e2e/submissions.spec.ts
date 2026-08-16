import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  applicationTurnstileAppearances,
  completeApplicationTurnstile,
  installApplicationTurnstileMock,
  waitForApplicationTurnstileActions,
} from "./support/mock-turnstile";
import { resetDemoSubmissions } from "./support/reset-demo-submissions";

async function dragWithPointer(page: Page, source: Locator, target: Locator) {
  await expect(target).toBeVisible();
  await target.scrollIntoViewIfNeeded();
  const sourceStartsInCanvas = await source.evaluate((element) =>
    Boolean(element.closest(".fb-canvas-page")),
  );
  const canvas = page.locator(".fb-canvas-page");
  const canvasBox = await canvas.boundingBox();
  const visibleSourceBox = await source.boundingBox();
  if (sourceStartsInCanvas && canvasBox && visibleSourceBox) {
    const topMargin = canvasBox.y + 24;
    if (visibleSourceBox.y < topMargin) {
      await canvas.evaluate(
        (element, distance) => element.scrollBy({ top: distance }),
        visibleSourceBox.y - topMargin,
      );
    }
  } else {
    await target.evaluate((element) => {
      const scrollport = element.closest(".fb-canvas-page");
      if (!(scrollport instanceof HTMLElement)) return;
      const targetRect = element.getBoundingClientRect();
      const scrollportRect = scrollport.getBoundingClientRect();
      if (
        targetRect.top + targetRect.height / 2 >
        scrollportRect.top + scrollportRect.height * 0.75
      ) {
        scrollport.scrollBy({ top: scrollportRect.height * 0.2 });
      }
    });
  }
  await expect(source).toBeVisible();
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) {
    throw new Error("Drag source and insertion target need visible bounds.");
  }

  await page.mouse.move(
    sourceBox.x + sourceBox.width / 2,
    sourceBox.y + sourceBox.height / 2,
  );
  await page.mouse.down();
  await page.mouse.move(
    sourceBox.x + sourceBox.width / 2 + 8,
    sourceBox.y + sourceBox.height / 2 + 8,
    { steps: 2 },
  );
  await page.mouse.move(
    targetBox.x + targetBox.width / 2,
    targetBox.y + targetBox.height / 2,
    { steps: 12 },
  );
  if ((await target.getAttribute("data-drop-index")) !== null) {
    await expect(target).toHaveClass(/is-over/);
  }
  await page.mouse.up();
}

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
    await expect(
      page.getByRole("button", { name: "Save draft" }),
    ).toBeEnabled();
    await page.getByLabel("Closing date").fill("2035-12-31");
    await expect(
      page.getByText("The closing-date change is still a draft"),
    ).toBeVisible();
    await page
      .getByLabel("Introduction")
      .fill(
        "Bring a practical idea, evidence from real delivery, and a clear attendee takeaway.",
      );
    await page
      .getByRole("region", { name: "Visual call-for-speakers form editor" })
      .getByRole("button", { name: "Add URL" })
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
      page.getByText("The closing-date change is still a draft"),
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

  test("native visual form authoring supports drag creation and reordering", async ({
    page,
  }) => {
    const visualLabel = `Session title visual ${Date.now()}`;
    await page.goto("/admin/submissions/form");

    const editor = page.getByLabel("Visual call-for-speakers form editor");
    await expect(editor).toBeVisible();
    const fields = editor.locator(".fb-canvas-field");
    const initialFieldCount = await fields.count();
    await expect(editor.locator('[data-field-id="materials"]')).toContainText(
      "Shown when Format = Workshop",
    );

    await editor
      .getByRole("button", { name: "Add Video upload or URL" })
      .click();
    await expect(fields).toHaveCount(initialFieldCount);
    await expect(
      page.getByRole("alert").filter({
        hasText: "A form can contain at most one native video upload field.",
      }),
    ).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(1);
    await expect(page.getByText("Canvas action blocked")).toBeVisible();

    await page.getByRole("button", { name: "Move Format down" }).press("Enter");
    await expect(fields.nth(3)).toHaveAttribute("data-field-id", "format");
    await expect(fields.nth(4)).toHaveAttribute("data-field-id", "materials");
    await expect(
      page.getByRole("alert").filter({
        hasText:
          "Materials and room setup” must remain after “Format” because its condition depends on that field.",
      }),
    ).toBeVisible();
    await expect(page.getByText("Reorder blocked")).toBeVisible();

    await page
      .getByRole("button", { name: "Move Session description up" })
      .press("Enter");
    await expect(fields.first()).toHaveAttribute(
      "data-field-id",
      "description",
    );
    await page
      .getByRole("button", { name: "Move Session description down" })
      .press("Enter");
    await expect(fields.first()).toHaveAttribute("data-field-id", "title");

    await dragWithPointer(
      page,
      editor.getByRole("button", { name: "Add URL" }),
      editor.locator('[data-drop-index="0"]'),
    );
    await expect(fields).toHaveCount(initialFieldCount + 1);

    const created = fields.first();
    await expect(created).toHaveAttribute("data-field-id", /^field_/);
    await page.getByLabel("Label", { exact: true }).fill(visualLabel);
    await expect(created).toContainText(visualLabel);

    await dragWithPointer(
      page,
      created.locator(`[title="Drag to reorder ${visualLabel}"]`),
      editor.locator('[data-drop-index="2"]'),
    );
    await expect(fields.nth(1)).toContainText(visualLabel);

    await dragWithPointer(
      page,
      fields.nth(1).locator(`[title="Drag to reorder ${visualLabel}"]`),
      editor.getByRole("button", { name: "Add Long text" }),
    );
    await expect(fields.nth(1)).toContainText(visualLabel);

    await dragWithPointer(
      page,
      editor.getByRole("button", { name: "Add Short text" }),
      editor.locator(`[data-drop-index="${initialFieldCount + 1}"]`),
    );
    await expect(fields).toHaveCount(initialFieldCount + 2);
    await expect(fields.last()).toContainText("Short text");

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
    const reloadedEditor = page.getByLabel(
      "Visual call-for-speakers form editor",
    );
    await expect(reloadedEditor).toBeVisible();
    await expect(
      reloadedEditor.locator(".fb-canvas-field").nth(1),
    ).toContainText(visualLabel);

    await page.setViewportSize({ width: 390, height: 844 });
    await reloadedEditor
      .locator(".fb-canvas-field")
      .nth(1)
      .getByRole("button")
      .click();
    await page.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(page.locator("#form-builder-field-settings")).toBeHidden();
    await page.getByRole("button", { name: "Close preview" }).click();
    await reloadedEditor
      .getByRole("link", { name: `Edit ${visualLabel} settings` })
      .click();
    const fieldSettings = page.locator("#form-builder-field-settings");
    await expect(fieldSettings).toBeInViewport();
    await expect(fieldSettings).toBeFocused();
  });

  test("form builder fails closed before JavaScript is available", async ({
    baseURL,
    browser,
    page,
  }) => {
    if (!baseURL) throw new Error("The browser test base URL is required.");
    const context = await browser.newContext({
      baseURL,
      javaScriptEnabled: false,
      storageState: await page.context().storageState(),
    });
    try {
      const noScriptPage = await context.newPage();
      await noScriptPage.goto("/admin/submissions/form");
      await expect(
        noScriptPage.getByRole("heading", {
          name: "Call for Speakers Form Builder",
        }),
      ).toBeVisible();
      await expect(
        noScriptPage.getByRole("button", { name: "Save draft" }),
      ).toBeDisabled();
      await expect(
        noScriptPage.getByRole("button", { name: "Publish version" }),
      ).toBeDisabled();
      await expect(
        noScriptPage.getByText(
          "JavaScript is required to edit or save this form.",
        ),
      ).toBeVisible();
    } finally {
      await context.close();
    }
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
    await expect(
      page.getByRole("heading", { name: "Status history" }),
    ).toBeVisible();
    const savedRevisions = page.locator("section").filter({
      has: page.getByRole("heading", { name: "Saved application revisions" }),
    });
    await expect(
      savedRevisions.getByText(/Revision \d+ · submitted/).first(),
    ).toBeVisible();
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
    await page.goto("/admin/schedule");
    await page
      .getByRole("link", { name: "Create direct session", exact: true })
      .click();
    await expect(page).toHaveURL(
      /\/admin\/submissions#create-direct-session$/u,
    );
    const directSession = page.locator("details").filter({
      has: page.getByText("Create a guaranteed direct session", {
        exact: true,
      }),
    });
    await expect(directSession).toHaveAttribute("open", "");
    await directSession
      .getByLabel("Session title")
      .fill(`Sponsor briefing ${unique}`);
    await directSession.getByLabel("Track").selectOption({ index: 1 });
    await directSession
      .getByLabel("Description")
      .fill("A confirmed sponsor programme contribution.");
    await directSession.getByLabel("Find existing speaker 1").fill("Priya");
    const existingEventSpeaker = directSession.getByRole("button", {
      name: /Priya Shah.*Already on this event roster/,
    });
    await expect(existingEventSpeaker).toBeEnabled();
    await existingEventSpeaker.click();
    await expect(directSession.getByLabel("Speaker 1 name")).toHaveValue(
      "Priya Shah",
    );
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

  test("authored conditional fields survive publication and toggle on the public form", async ({
    page,
  }) => {
    const unique = Date.now();
    await page.goto("/admin/submissions/form");

    const editor = page.getByLabel("Visual call-for-speakers form editor");
    await editor.getByRole("button", { name: "Add Long text" }).click();
    await page.getByLabel("Stable field ID").fill(`key_takeaway_${unique}`);
    await page.getByLabel("Label", { exact: true }).fill("Key takeaway");
    await page.getByLabel("Required when visible").check();

    await editor.getByRole("button", { name: "Add Dropdown" }).click();
    await page.getByLabel("Stable field ID").fill(`audience_level_${unique}`);
    await page.getByLabel("Label", { exact: true }).fill("Audience level");
    await page
      .getByLabel("Options, one per line")
      .fill("Beginner\nIntermediate\nAdvanced");

    await editor.getByRole("button", { name: "Add Long text" }).click();
    await page
      .getByLabel("Stable field ID")
      .fill(`workshop_prerequisites_${unique}`);
    await page
      .getByLabel("Label", { exact: true })
      .fill("Workshop prerequisites");
    await page
      .getByLabel("Show this field when")
      .selectOption(`audience_level_${unique}`);
    await page.getByLabel("Equals").selectOption("Advanced");

    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(
      page.locator(".validation-item.ok[role='status']").filter({
        hasText: "Draft form saved.",
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Publish version" }).click();
    await page.getByRole("button", { name: "Confirm publication" }).click();
    await expect(
      page.locator(".validation-item.ok[role='status']").filter({
        hasText: "Published a new immutable form version",
      }),
    ).toBeVisible();

    await page.goto("/apply/form");
    await expect(page.getByText("Key takeaway", { exact: true })).toBeVisible();
    await expect(
      page.getByText("Audience level", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Shown when Audience level is “Advanced”.", {
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Continue to application" }).click();

    await page
      .getByLabel("Email address")
      .fill(`conditional-form-${unique}@example.com`);
    await page.getByRole("button", { name: "Send verification code" }).click();
    await page.getByLabel("Six-digit code").fill("424242");
    await page.getByRole("button", { name: "Verify and open drafts" }).click();
    await page.getByRole("button", { name: "Start application" }).click();

    await expect(page.getByLabel("Key takeaway *")).toBeVisible();
    const audienceLevel = page.getByLabel("Audience level");
    await expect(audienceLevel).toBeVisible();
    await expect(page.getByLabel("Workshop prerequisites")).toBeHidden();
    await audienceLevel.selectOption("Advanced");
    await expect(page.getByLabel("Workshop prerequisites")).toBeVisible();
    await audienceLevel.selectOption("Beginner");
    await expect(page.getByLabel("Workshop prerequisites")).toBeHidden();
  });
});
