import { expect, type Page, test } from "@playwright/test";

import { e2eOrigin } from "./support/e2e-origin";
import { openEvaluationView } from "./support/evaluation-admin";
import { resetDemoEvent } from "./support/reset-demo-event";
import { resetDemoSubmissions } from "./support/reset-demo-submissions";

const INITIAL_ROUND = "Initial Review";
const FINAL_ROUND = "Final Review";
const SUBMISSION_TITLE = "Taming the event data beast";
const SAM_EMAIL = "sbek-reviewer@example.com";
const PRIYA_EMAIL = "sbek-speaker@example.com";
const MARCUS_EMAIL = "sbek-speaker2@example.com";
const HIDDEN_IDENTITY = [
  "Priya Raman",
  "Marcus Okafor",
  "Latticework Systems",
  PRIYA_EMAIL,
  MARCUS_EMAIL,
] as const;

async function waitForInterface(page: Page, path: string) {
  const response = await page.goto(path);
  expect(response?.ok(), `${path} should load`).toBeTruthy();
  await page.locator("body[data-hydrated='true']").waitFor();
}

async function switchDemoRole(
  page: Page,
  identity:
    | "administrator"
    | "sbek_reviewer"
    | "sbek_speaker"
    | "sbek_co_speaker",
  returnTo: string,
) {
  const response = await page.request.post("/demo/role", {
    form: { identity, returnTo },
    headers: { origin: e2eOrigin },
  });
  expect(
    response.ok(),
    `switching to ${identity} failed with ${response.status()}: ${await response.text()}`,
  ).toBeTruthy();
}

async function expectReviewerCannotSeeIdentity(page: Page) {
  const body = await page.locator("body").innerText();
  for (const identity of HIDDEN_IDENTITY) {
    expect(body, `blinded reviewer output exposed ${identity}`).not.toContain(
      identity,
    );
  }
}

test.describe
  .serial("ABS-S2/S3 abstract management workflow", () => {
    test.beforeAll(async ({ request }) => {
      await resetDemoEvent(request);
    });

    test.afterAll(async ({ request }) => {
      await resetDemoEvent(request);
    });

    test("retains independent rounds and enforces round-level blind review", async ({
      page,
    }) => {
      test.setTimeout(120_000);

      await switchDemoRole(page, "administrator", "/admin/review");
      await resetDemoSubmissions(page.request, { verifiedLocalSender: true });
      await waitForInterface(page, "/admin/review");
      await openEvaluationView(page, "Setup");
      const cyclePanel = page.locator("details").filter({
        hasText: "Start a new review cycle",
      });
      await cyclePanel
        .getByText("Start a new review cycle", { exact: true })
        .click();
      await cyclePanel
        .getByLabel("New plan name")
        .fill("Abstract management review");
      await cyclePanel.getByLabel("First round name").fill(INITIAL_ROUND);
      await cyclePanel
        .getByLabel(/Opens \(America\/Toronto\)/)
        .fill("2026-08-01T09:00");
      await cyclePanel
        .getByLabel(/Closes \(America\/Toronto\)/)
        .fill("2099-10-15T17:00");
      await cyclePanel.getByLabel("Hide author and co-author identity").check();
      await cyclePanel
        .getByRole("button", { name: "Review and start new cycle" })
        .click();
      await expect(
        page.getByRole("heading", { name: "Start a new review cycle?" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Start new cycle" }).click();
      await expect(
        page.locator(".validation-item.ok[role='status']"),
      ).toContainText("New review cycle started");
      await expect(
        page.getByRole("heading", { name: INITIAL_ROUND, exact: true }),
      ).toBeVisible();
      const initialCard = page.locator("section.card").filter({
        has: page.getByRole("heading", { name: INITIAL_ROUND, exact: true }),
      });
      await initialCard
        .getByText("Edit unassigned round and rubric", { exact: true })
        .click();
      const roundEditor = initialCard.locator("form").filter({
        has: page.locator('input[name="intent"][value="update-draft-round"]'),
      });
      const criterionNames = roundEditor.locator('[name="criterionName"]');
      const criterionTypes = roundEditor.locator('[name="criterionInputType"]');
      const criterionWeights = roundEditor.locator('[name="criterionWeight"]');
      const criterionRequired = roundEditor.locator(
        '[name="criterionRequired"]',
      );
      const criterionDescriptions = roundEditor.locator(
        '[name="criterionDescription"]',
      );
      const criterionOptions = roundEditor.locator('[name="criterionOptions"]');
      const recommendationLabels = roundEditor.locator(
        '[name="recommendationChoiceLabel"]',
      );
      await recommendationLabels.nth(0).fill("Strong accept");
      await recommendationLabels.nth(1).fill("Discuss");
      await recommendationLabels.nth(2).fill("Decline");
      await roundEditor
        .getByRole("button", { name: "Remove Waitlist" })
        .click();
      await roundEditor.getByRole("button", { name: "Remove Reject" }).click();
      await expect(roundEditor).toContainText(
        "Every review already includes a required overall recommendation and confidence rating",
      );
      await expect(criterionOptions.first()).toHaveAttribute(
        "placeholder",
        "Introductory, Intermediate, Advanced",
      );
      await criterionNames.nth(2).fill("Recommendation");
      await expect(
        roundEditor.getByText(
          "Every review already requires an overall recommendation. Rename this criterion to avoid asking reviewers twice.",
        ),
      ).toBeVisible();
      await criterionNames.nth(2).fill("Confidence");
      await expect(
        roundEditor.getByText(
          "Every review already requires a confidence rating. Rename this criterion to avoid asking reviewers twice.",
        ),
      ).toBeVisible();
      const rubric = [
        ["Originality", "scale_5", "2", "true", "Original perspective", ""],
        ["Relevance", "scale_5", "1", "true", "Fit for the programme", ""],
        [
          "Audience level",
          "dropdown",
          "0",
          "true",
          "Which audience experience level best matches this proposal?",
          "Introductory, Intermediate, Advanced",
        ],
        [
          "Comments",
          "free_text",
          "0",
          "false",
          "Long-form reviewer comments",
          "",
        ],
      ] as const;
      for (const [index, criterion] of rubric.entries()) {
        const [name, type, weight, required, description, options] = criterion;
        await criterionNames.nth(index).fill(name);
        await criterionTypes.nth(index).selectOption(type);
        await criterionWeights.nth(index).fill(weight);
        await criterionRequired.nth(index).selectOption(required);
        await criterionDescriptions.nth(index).fill(description);
        await criterionOptions.nth(index).fill(options);
      }
      await criterionNames.nth(4).fill("");
      await expect(
        roundEditor.getByText(
          /Rename this criterion to avoid asking reviewers twice/u,
        ),
      ).toHaveCount(0);
      await roundEditor.getByRole("button", { name: "Save round" }).click();
      await expect(
        page.locator(".validation-item.ok[role='status']"),
      ).toContainText("Round and scorecard saved");
      await expect(
        page.getByText("Dropdown: Introductory, Intermediate, Advanced"),
      ).toBeVisible();
      await page.reload();
      await openEvaluationView(page, "Setup");
      await expect(initialCard).toContainText("Weight 2");
      await expect(initialCard).toContainText("Weight 1");
      await expect(initialCard).toContainText("blind review");
      await expect(initialCard).toContainText("2099");

      const invitation = page.locator("details").filter({
        hasText: "Manage evaluation access",
      });
      await invitation
        .getByText("Manage evaluation access", { exact: true })
        .click();
      await invitation.getByLabel("Name").fill("Sam Whitfield");
      await invitation.getByLabel("Email").fill(SAM_EMAIL);
      await invitation.getByRole("button", { name: "Send invitation" }).click();
      await expect(
        page.getByText(/fixed demo identity was activated locally/i),
      ).toBeVisible();

      await initialCard
        .getByLabel(`Reviewer for ${INITIAL_ROUND}`)
        .selectOption("person-sbek-reviewer");
      await initialCard.getByRole("button", { name: "Add reviewer" }).click();
      await expect(initialCard).toContainText("Sam Whitfield");

      const progression = page.locator("section.card").filter({
        has: page.getByRole("heading", { name: "Round progression" }),
      });
      await progression.getByLabel("Next round name").fill(FINAL_ROUND);
      await progression.getByLabel("Scorecard to use").selectOption("");
      const nextRoundOpens = progression.getByLabel(
        /Opens \(America\/Toronto\)/,
      );
      const nextRoundCloses = progression.getByLabel(
        /Closes \(America\/Toronto\)/,
      );
      await nextRoundOpens.fill("2099-10-16T09:00");
      await nextRoundCloses.fill("2099-11-30T17:00");
      await progression.getByRole("button", { name: "Add next round" }).click();
      await expect(
        page
          .getByRole("status")
          .filter({ hasText: "Next round created from the rubric" }),
      ).toBeVisible();

      const finalCard = page.locator("section.card").filter({
        has: page.getByRole("heading", { name: FINAL_ROUND, exact: true }),
      });
      await expect(finalCard).toContainText("identity visible");
      await expect(finalCard).toContainText("2099");
      await expect(finalCard).toContainText(
        "No reviewers are in this round pool.",
      );
      await expect(initialCard).toContainText("Sam Whitfield");
      await expect(cyclePanel).toContainText(
        `Prefilled from Round 2 — ${FINAL_ROUND} · Scorecard v1`,
      );

      await progression.getByLabel("Next round name").fill("Accidental round");
      await progression.getByRole("button", { name: "Add next round" }).click();
      await expect(
        page
          .getByRole("status")
          .filter({ hasText: "Next round created from the rubric" }),
      ).toBeVisible();
      const accidentalRound = page.locator("section.card").filter({
        has: page.getByRole("heading", {
          name: "Accidental round",
          exact: true,
        }),
      });
      await accidentalRound
        .getByRole("button", { name: "Delete unused round" })
        .click();
      const deleteRoundDialog = page.getByRole("dialog", {
        name: "Delete unused final round?",
      });
      await expect(deleteRoundDialog).toContainText(
        "Accidental round · 4 criteria · 0 reviewers",
      );
      await deleteRoundDialog
        .getByRole("button", { name: "Delete round" })
        .click();
      await expect(
        page
          .getByRole("status")
          .filter({ hasText: "Unused final draft round deleted" }),
      ).toBeVisible();
      await expect(
        page.getByRole("heading", { name: "Accidental round", exact: true }),
      ).toHaveCount(0);

      await switchDemoRole(page, "sbek_speaker", "/apply/form");
      await waitForInterface(page, "/apply/form");
      await expect(
        page.getByRole("heading", { name: "Resume an application" }),
      ).toBeVisible();
      await page.getByLabel("Email address").fill(PRIYA_EMAIL);
      await page
        .getByRole("button", { name: "Send verification code" })
        .click();
      await page.getByLabel("Six-digit code").fill("424242");
      await page
        .getByRole("button", { name: "Verify and open applications" })
        .click();
      await page.getByRole("button", { name: "Start application" }).click();
      await page.getByLabel("Session title").fill(SUBMISSION_TITLE);
      await page
        .getByLabel("Session description")
        .fill(
          "A practical talk about making event data useful to programme teams.",
        );
      await page.getByLabel("Event Operations").check();
      await page.getByLabel("Format").selectOption("Presentation");
      await page.getByLabel("Speaker 1 name").fill("Priya Raman");
      await page
        .getByLabel("Biography")
        .last()
        .fill("Priya Raman builds data systems at Latticework Systems.");
      await page.getByRole("button", { name: "Save draft" }).click();
      await expect(
        page.locator(".validation-item.ok[role='status']").filter({
          hasText: "Your draft has been saved",
        }),
      ).toBeVisible();
      await page.getByText("I have reviewed this application").click();
      await page.getByRole("button", { name: "Submit application" }).click();
      await expect(
        page.locator(".validation-item.ok[role='status']").filter({
          hasText: "Your application has been submitted",
        }),
      ).toBeVisible();

      await switchDemoRole(page, "administrator", "/admin/review");
      await waitForInterface(page, "/admin/review");
      await openEvaluationView(page, "Assignments");
      const submissionRow = page
        .getByRole("region", { name: "Evaluation proposal queue" })
        .locator("tr")
        .filter({ hasText: SUBMISSION_TITLE });
      await expect(submissionRow).toBeVisible();
      // This local runtime has no OpenAI credential; do not invent provider readiness.
      await expect(
        submissionRow.getByRole("button", {
          name: "Review AI request details",
        }),
      ).toBeDisabled();
      await expect(page.locator("#evaluation-proposals")).toContainText(
        "Opening the request details sends nothing",
      );
      await expect(page.locator("#evaluation-proposals")).toContainText(
        "OpenAI credentials are not configured",
      );
      const assignmentSelect = submissionRow.getByLabel(
        `Evaluator or team for ${SUBMISSION_TITLE}`,
      );
      await expect(assignmentSelect.locator("option")).toHaveText([
        "Sam Whitfield",
      ]);
      await assignmentSelect.selectOption({ label: "Sam Whitfield" });
      await submissionRow.getByRole("button", { name: "Assign" }).click();
      await expect(
        page.locator(".validation-item.ok[role='status']"),
      ).toContainText(/assignment/i);
      await openEvaluationView(page, "Setup");
      await expect(initialCard).toContainText(
        "1 assigned · 0 reviews submitted · 0% resolved",
      );
      await initialCard.getByLabel("Include Sam Whitfield in reminder").check();
      await initialCard
        .getByRole("button", { name: "Prepare selected reminders" })
        .click();
      await expect(page).toHaveURL(/\/admin\/communications\/compose\//u);
      await expect(
        page.getByRole("heading", { name: "Compose communication" }),
      ).toBeVisible();
      await expect(
        page.locator('textarea[name="manualRecipients"]'),
      ).toHaveValue(`"Sam Whitfield" <${SAM_EMAIL}>`);

      await waitForInterface(page, "/admin/review");
      await openEvaluationView(page, "Results");
      await page.getByLabel("Sort results").selectOption("title_asc");
      await page.getByRole("button", { name: "Apply" }).click();
      await expect(page).toHaveURL(/sort=title_asc/u);
      const exportIntentKeys: string[] = [];
      page.on("request", (request) => {
        if (
          request.method() === "POST" &&
          new URL(request.url()).pathname === "/admin/review/results.csv"
        ) {
          const intent = new URLSearchParams(request.postData() ?? "").get(
            "idempotencyKey",
          );
          if (intent) exportIntentKeys.push(intent);
        }
      });
      for (let downloadIndex = 0; downloadIndex < 2; downloadIndex += 1) {
        const downloadPromise = page.waitForEvent("download");
        await page
          .getByRole("button", { name: "Download proposal results CSV" })
          .click();
        const download = await downloadPromise;
        expect(download.suggestedFilename()).toBe(
          "program-cue-abstract-review-results.csv",
        );
      }
      expect(exportIntentKeys).toHaveLength(2);
      expect(new Set(exportIntentKeys).size).toBe(2);

      await switchDemoRole(page, "sbek_reviewer", "/review/workbench");
      await waitForInterface(page, "/review/workbench");
      await expect(
        page.getByRole("heading", { name: SUBMISSION_TITLE }).last(),
      ).toBeVisible();
      const assignmentHref = await page
        .getByRole("link", { name: new RegExp(SUBMISSION_TITLE) })
        .first()
        .getAttribute("href");
      expect(assignmentHref).toMatch(/^\/review\/workbench\?assignment=/);
      await expectReviewerCannotSeeIdentity(page);
      await page.goto(`${e2eOrigin}${assignmentHref}`);
      await page.locator("body[data-hydrated='true']").waitFor();
      await expectReviewerCannotSeeIdentity(page);
      const audienceLevel = page.getByLabel("Audience level");
      await expect(audienceLevel).toBeVisible();
      await expect(audienceLevel.locator("option")).toHaveText([
        "Choose…",
        "Introductory",
        "Intermediate",
        "Advanced",
      ]);
      const recommendationGroup = page.getByRole("radiogroup", {
        name: "Recommendation",
      });
      await expect(recommendationGroup).toHaveCount(1);
      await expect(
        recommendationGroup.locator(".review-choice-option"),
      ).toHaveText(["Strong accept", "Discuss", "Decline"]);
      await expect(
        page.getByLabel("Recommendation", { exact: true }),
      ).toHaveCount(1);

      await page.getByRole("radio", { name: /No conflict/ }).check();
      const scoreGroups = page.locator("[data-review-scale]");
      await scoreGroups
        .nth(0)
        .getByRole("radio", { name: "4", exact: true })
        .check();
      await scoreGroups
        .nth(1)
        .getByRole("radio", { name: "2", exact: true })
        .check();
      await expect(page.locator(".score-summary-value")).toHaveText("3.33 / 5");

      await switchDemoRole(page, "administrator", "/admin/review");
      await waitForInterface(
        page,
        `/admin/submissions?query=${encodeURIComponent(SUBMISSION_TITLE)}`,
      );
      await page.getByRole("link", { name: SUBMISSION_TITLE }).click();
      await expect(
        page.getByRole("heading", { name: SUBMISSION_TITLE }),
      ).toBeVisible();
      await expect(page.locator("body")).toContainText("Priya Raman");
      await expect(page.locator("body")).toContainText("Latticework Systems");
      await expect(page.locator("body")).toContainText(PRIYA_EMAIL);

      await waitForInterface(page, "/admin/review");
      await openEvaluationView(page, "Assignments");
      const decisionRow = page
        .getByRole("region", { name: "Evaluation proposal queue" })
        .locator("tr")
        .filter({ hasText: SUBMISSION_TITLE });
      await decisionRow.getByRole("button", { name: "Decide" }).click();
      const decisionDialog = page.getByRole("dialog", {
        name: `Decision · ${SUBMISSION_TITLE}`,
      });
      await decisionDialog
        .locator('select[name="decision"]')
        .selectOption("accepted");
      await decisionDialog
        .getByLabel("Confirm review-evidence override")
        .check();
      await decisionDialog
        .getByRole("button", { name: "Release decision" })
        .click();
      await expect(
        page.locator(".validation-item.ok[role='status']"),
      ).toContainText(/decision released|acceptance/i);

      await switchDemoRole(page, "sbek_speaker", "/participant/applications");
      await waitForInterface(page, "/participant/applications");
      const applicationCard = page.locator("article.card").filter({
        has: page.getByRole("heading", { name: SUBMISSION_TITLE, exact: true }),
      });
      await applicationCard
        .getByRole("link", { name: "View application" })
        .click();
      const applicationDetail = page.locator("#participant-application-detail");
      await applicationDetail.getByLabel("Name").fill("Marcus Okafor");
      await applicationDetail.getByLabel("Email").fill(MARCUS_EMAIL);
      await applicationDetail.getByLabel("Role").selectOption("Co-speaker");
      await applicationDetail
        .getByRole("button", { name: "Send co-speaker invitation" })
        .click();
      const coSpeakerDialog = page.getByRole("dialog", {
        name: "Send this co-speaker invitation?",
      });
      await expect(coSpeakerDialog).toContainText("Marcus Okafor");
      await expect(coSpeakerDialog).toContainText(MARCUS_EMAIL);
      await expect(coSpeakerDialog).toContainText("Co-speaker");
      await coSpeakerDialog
        .getByRole("button", { name: "Send invitation" })
        .click();
      await expect(
        applicationDetail
          .getByRole("status")
          .filter({ hasText: "Marcus Okafor was added as co-speaker" }),
      ).toContainText("Marcus Okafor was added as co-speaker");
      const marcusRelationship = applicationDetail.locator("li").filter({
        hasText: "Marcus Okafor",
      });
      await expect(marcusRelationship).toContainText("Co-speaker");
      await expect(marcusRelationship).toContainText(MARCUS_EMAIL);
      await expect(marcusRelationship).toContainText(
        "Claim invitation prepared",
      );
    });
  });

test("Marcus claims his submitted co-speaker invitation before review assignment", async ({
  page,
  request,
  browser,
}) => {
  test.setTimeout(90_000);
  await resetDemoEvent(request);
  try {
    await switchDemoRole(page, "administrator", "/admin/command");
    await resetDemoSubmissions(page.request, { verifiedLocalSender: true });
    await switchDemoRole(page, "sbek_speaker", "/apply/form");
    await waitForInterface(page, "/apply/form");
    await page.getByLabel("Email address").fill(PRIYA_EMAIL);
    await page.getByRole("button", { name: "Send verification code" }).click();
    await page.getByLabel("Six-digit code").fill("424242");
    await page
      .getByRole("button", { name: "Verify and open applications" })
      .click();
    await page
      .getByRole("button", { name: "Start application", exact: true })
      .click();
    await page.getByLabel("Session title").fill("Claim before review");
    await page
      .getByLabel("Session description")
      .fill(
        "A practical talk about making event data useful to programme teams.",
      );
    await page.getByLabel("Event Operations").check();
    await page.getByLabel("Format").selectOption("Presentation");
    await page.getByLabel("Speaker 1 name").fill("Priya Raman");
    await page
      .getByLabel("Biography")
      .last()
      .fill("Priya builds data systems.");
    await page.getByRole("button", { name: "Add co-speaker" }).click();
    await page.getByLabel("Speaker 2 name").fill("Marcus Okafor");
    await page.getByLabel("Email").nth(1).fill(MARCUS_EMAIL);
    await page
      .getByLabel("Biography")
      .last()
      .fill("Marcus helps teams ship reliable platforms.");
    await page.getByRole("button", { name: "Save draft", exact: true }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Your draft has been saved" }),
    ).toBeVisible();
    await page.getByText("I have reviewed this application").click();
    await page
      .getByRole("button", { name: "Submit application", exact: true })
      .click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Your application has been submitted" }),
    ).toBeVisible();
    const marcusContext = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    try {
      const marcusPage = await marcusContext.newPage();
      await switchDemoRole(marcusPage, "sbek_co_speaker", "/apply/form");
      await waitForInterface(marcusPage, "/apply/form");
      await marcusPage.getByLabel("Email address").fill(MARCUS_EMAIL);
      await marcusPage
        .getByRole("button", { name: "Send verification code" })
        .click();
      await expect(marcusPage.getByText("No email was sent")).toBeVisible();
      await marcusPage.getByLabel("Six-digit code").fill("424242");
      await marcusPage
        .getByRole("button", { name: "Verify and open applications" })
        .click();
      const invitation = marcusPage
        .locator(".row-main")
        .filter({ hasText: "Claim before review" });
      await expect(invitation).toContainText("Invited as Marcus Okafor");
      await invitation
        .getByRole("button", { name: "Claim speaker profile" })
        .click();
      await expect(
        marcusPage.getByRole("button", { name: "Claim speaker profile" }),
      ).toHaveCount(0);
      await marcusPage.reload();
      await expect(
        marcusPage.getByText("Your claimed speaker profile", { exact: true }),
      ).toBeVisible();
      await marcusPage
        .getByText("Your claimed speaker profile", { exact: true })
        .click();
      await expect(
        marcusPage.getByRole("textbox", { name: "Biography", exact: true }),
      ).toHaveValue("Marcus helps teams ship reliable platforms.");
    } finally {
      await marcusContext.close();
    }
    await switchDemoRole(page, "sbek_speaker", "/participant/applications");
    await waitForInterface(page, "/participant/applications");
    await page
      .locator("article.card")
      .filter({ hasText: "Claim before review" })
      .getByRole("link", { name: "View application" })
      .click();
    const marcus = page
      .locator("#participant-application-detail")
      .getByRole("listitem")
      .filter({ hasText: "Marcus Okafor" });
    await expect(marcus).toContainText("Relationship status: claimed");
  } finally {
    await resetDemoEvent(request);
  }
});
