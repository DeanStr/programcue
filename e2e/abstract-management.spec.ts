import { expect, test, type Page } from "@playwright/test";

import { e2eOrigin } from "./support/e2e-origin";
import { resetDemoEvent } from "./support/reset-demo-event";
import { resetDemoSubmissions } from "./support/reset-demo-submissions";

const INITIAL_ROUND = "Initial Review";
const FINAL_ROUND = "Final Review";
const SUBMISSION_TITLE = "Taming the event data beast";
const SAM_EMAIL = "sbek-reviewer@example.com";
const PRIYA_EMAIL = "sbek-speaker@example.com";
const MARCUS_EMAIL = "sbek-speaker2@example.com";
const DEMO_EVALUATION_RESET_CONFIRMATION = "clear-abstract-evaluation";
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
  identity: "administrator" | "sbek_reviewer" | "sbek_speaker",
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

async function createInitialRoundThroughAdminAction(page: Page) {
  const form = new URLSearchParams();
  const fields = {
    intent: "create-plan",
    planName: "Abstract management review",
    roundName: INITIAL_ROUND,
    roundOpensAt: "2026-08-01T09:00",
    roundClosesAt: "2099-10-15T17:00",
    anonymous: "true",
    decisionRole: "administrator",
  };
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  const criteria = [
    ["Originality", "scale_5", "50", "true", "Original perspective"],
    ["Relevance", "scale_5", "50", "true", "Fit for the programme"],
    [
      "Recommendation",
      "dropdown",
      "0",
      "true",
      "Choose the committee recommendation",
    ],
    ["Comments", "free_text", "0", "false", "Long-form reviewer comments"],
  ] as const;
  for (const [name, inputType, weight, required, description] of criteria) {
    form.append("criterionName", name);
    form.append("criterionInputType", inputType);
    form.append("criterionWeight", weight);
    form.append("criterionRequired", required);
    form.append("criterionDescription", description);
    form.append(
      "criterionOptions",
      inputType === "dropdown" ? "Accept, Maybe, Reject" : "",
    );
  }
  const response = await page.request.post("/admin/review", {
    data: form.toString(),
    headers: {
      origin: e2eOrigin,
      "content-type": "application/x-www-form-urlencoded",
    },
  });
  expect(
    response.ok(),
    `create-plan failed with ${response.status()}: ${await response.text()}`,
  ).toBeTruthy();
}

async function clearDemoEvaluation(page: Page) {
  const response = await page.request.post("/demo.data", {
    form: {
      intent: "clear-evaluation",
      confirmation: DEMO_EVALUATION_RESET_CONFIRMATION,
    },
    headers: { origin: e2eOrigin },
  });
  expect(
    response.ok(),
    `clear-evaluation failed with ${response.status()}: ${await response.text()}`,
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

test.describe.serial("ABS-S2/S3 abstract management workflow", () => {
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
    await clearDemoEvaluation(page);
    await resetDemoSubmissions(page.request, { verifiedLocalSender: true });
    await createInitialRoundThroughAdminAction(page);
    await waitForInterface(page, "/admin/review");
    await expect(
      page.getByRole("heading", { name: INITIAL_ROUND, exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Dropdown: Accept, Maybe, Reject")).toBeVisible();
    const initialCard = page.locator("section.card").filter({
      has: page.getByRole("heading", { name: INITIAL_ROUND, exact: true }),
    });
    await expect(initialCard).toContainText("blind review");
    await expect(initialCard).toContainText("2099");

    const invitation = page.locator("details").filter({
      hasText: "Manage evaluation access",
    });
    await invitation.getByText("Manage evaluation access", { exact: true }).click();
    await invitation.getByLabel("Name").fill("Sam Whitfield");
    await invitation.getByLabel("Email").fill(SAM_EMAIL);
    await invitation.getByRole("button", { name: "Send invitation" }).click();
    await expect(
      page.getByText(/exact SBEK fixture identity was activated locally/i),
    ).toBeVisible();

    await initialCard
      .getByLabel(`Reviewer for ${INITIAL_ROUND}`)
      .selectOption("person-sbek-reviewer");
    await initialCard.getByRole("button", { name: "Add reviewer" }).click();
    await expect(initialCard).toContainText("Sam Whitfield");

    await page.getByLabel("Next round name").fill(FINAL_ROUND);
    await page.getByLabel("Scorecard to use").selectOption("");
    const nextRoundOpens = page.getByLabel(/Opens \(America\/Toronto\)/);
    const nextRoundCloses = page.getByLabel(/Closes \(America\/Toronto\)/);
    await nextRoundOpens.fill("2099-10-16T09:00");
    await nextRoundCloses.fill("2099-11-30T17:00");
    await page.getByRole("button", { name: "Add next round" }).click();
    await expect(
      page.getByRole("status").filter({ hasText: "Next round created from the rubric" }),
    ).toBeVisible();

    const finalCard = page.locator("section.card").filter({
      has: page.getByRole("heading", { name: FINAL_ROUND, exact: true }),
    });
    await expect(finalCard).toContainText("identity visible");
    await expect(finalCard).toContainText("2099");
    await expect(finalCard).toContainText("No reviewers are in this round pool.");
    await expect(initialCard).toContainText("Sam Whitfield");

    await switchDemoRole(page, "sbek_speaker", "/apply/form");
    await waitForInterface(page, "/apply/form");
    await page.getByLabel("Email address").fill(PRIYA_EMAIL);
    await page.getByRole("button", { name: "Send verification code" }).click();
    await page.getByLabel("Six-digit code").fill("424242");
    await page.getByRole("button", { name: "Verify and open drafts" }).click();
    await page.getByRole("button", { name: "Start application" }).click();
    await page.getByLabel("Session title *").fill(SUBMISSION_TITLE);
    await page
      .getByLabel("Session description *")
      .fill("A practical talk about making event data useful to programme teams.");
    await page.getByLabel("Event Operations").check();
    await page.getByLabel("Format *").selectOption("Presentation");
    await page.getByLabel("Speaker 1 name").fill("Priya Raman");
    await page
      .getByLabel("Biography")
      .last()
      .fill("Priya Raman builds data systems at Latticework Systems.");
    await page.getByRole("button", { name: "Add co-speaker" }).click();
    await page.getByLabel("Speaker 2 name").fill("Marcus Okafor");
    await page.locator('input[type="email"]:visible').nth(1).fill(MARCUS_EMAIL);
    await page
      .getByLabel("Biography")
      .last()
      .fill("Marcus Okafor collaborates with Priya at Latticework Systems.");
    await page.getByRole("button", { name: "Save draft" }).click();
    await expect(
      page.locator(".validation-item.ok[role='status']"),
    ).toContainText("This draft is stored in D1");
    await page.getByText("I have reviewed this application").click();
    await page.getByRole("button", { name: "Submit application" }).click();
    await expect(page.locator(".validation-item.ok[role='status']")).toContainText(
      "This application is submitted and stored in D1",
    );

    await switchDemoRole(page, "administrator", "/admin/review");
    await waitForInterface(page, "/admin/review");
    const submissionRow = page.locator("tr").filter({ hasText: SUBMISSION_TITLE });
    await expect(submissionRow).toBeVisible();
    const assignmentSelect = submissionRow.getByLabel(
      `Evaluator or team for ${SUBMISSION_TITLE}`,
    );
    await expect(assignmentSelect.locator("option")).toHaveText([
      "Sam Whitfield",
    ]);
    await assignmentSelect.selectOption({ label: "Sam Whitfield" });
    await submissionRow.getByRole("button", { name: "Assign" }).click();
    await expect(page.locator(".validation-item.ok[role='status']")).toContainText(
      /assignment/i,
    );

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

    await switchDemoRole(page, "administrator", "/admin/review");
    await waitForInterface(
      page,
      `/admin/submissions?query=${encodeURIComponent(SUBMISSION_TITLE)}`,
    );
    await page.getByRole("link", { name: SUBMISSION_TITLE }).click();
    await expect(page.getByRole("heading", { name: SUBMISSION_TITLE })).toBeVisible();
    await expect(page.locator("body")).toContainText("Priya Raman");
    await expect(page.locator("body")).toContainText("Marcus Okafor");
    await expect(page.locator("body")).toContainText("Latticework Systems");
    await expect(page.locator("body")).toContainText(PRIYA_EMAIL);
    await expect(page.locator("body")).toContainText(MARCUS_EMAIL);
  });
});
