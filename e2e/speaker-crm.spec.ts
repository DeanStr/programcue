import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { acceptConfirm } from "./support/confirm-dialog";
import { resetDemoEvent } from "./support/reset-demo-event";

const fixture = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "speakers.csv",
);

test.beforeEach(async ({ request }) => {
  await resetDemoEvent(request);
});

test.setTimeout(120_000);

test("organization CRM covers directory, relationship, pipeline, handoff and outreach workflows", async ({
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
  await page.goto("/admin/crm");
  await expect(
    page.getByText("Organization workspace · all events"),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Speaker Network", level: 1 }),
  ).toBeVisible();

  await page.getByText("Import speaker contacts from CSV").click();
  await page.getByLabel("CSV file").setInputFiles(fixture);
  await page.getByRole("button", { name: "Preview import" }).click();
  await expect(
    page.getByRole("heading", { name: "Column mapping" }),
  ).toBeVisible();
  await expect(page.getByText("company → organisationName")).toBeVisible();
  await expect(page.getByRole("cell", { name: "Priya Raman" })).toBeVisible();
  await page.getByRole("button", { name: "Confirm import" }).click();
  await expect(page.getByRole("link", { name: "Priya Raman" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Marcus Okafor" })).toBeVisible();

  await page.getByLabel("Search contacts").fill("Priya");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByRole("link", { name: "Priya Raman" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Marcus Okafor" })).toHaveCount(
    0,
  );
  await page.getByRole("link", { name: "Clear filters" }).click();
  await page
    .locator('select[name="company"]')
    .selectOption({ label: "Latticework Systems" });
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByLabel("Active directory filters")).toContainText(
    "Latticework Systems",
  );
  await page.getByRole("link", { name: "Priya Raman" }).click();

  await page
    .getByLabel("New internal note")
    .fill("Met at DevFlow 2026 - strong on CI topics; shortlist for keynote.");
  await page.getByRole("button", { name: "Save note" }).click();
  await expect(page).toHaveURL(/saved=note/u);
  await expect(page.getByText(/shortlist for keynote/)).toBeVisible();
  await page.getByLabel("Add tag").fill("AI");
  await page.getByRole("button", { name: "Add tag" }).click();
  await expect(
    page.getByRole("button", { name: "Remove AI tag" }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Speaker Network directory" }).click();
  await expect(page).toHaveURL(/\/admin\/crm$/u);
  await page.locator('select[name="tag"]').selectOption("AI");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await page.getByLabel("Segment name").fill("AI Experts");
  await page.getByRole("button", { name: "Save dynamic segment" }).click();
  await page.getByRole("link", { name: "AI Experts" }).click();
  await expect(
    page.getByRole("heading", { name: "AI Experts segment" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: "Priya Raman" })).toBeVisible();

  await page.getByText("Add speaker contact manually").click();
  await page.getByLabel("Name", { exact: true }).fill("Priya Raman");
  await page
    .getByLabel("Email", { exact: true })
    .fill("priya.raman.alt@sbek-test.example.com");
  await page.getByRole("button", { name: "Create speaker contact" }).click();
  await expect(
    page.getByRole("heading", { name: "Possible duplicate contacts" }),
  ).toBeVisible();
  await page
    .getByRole("button", {
      name: "Keep priya.speaker@sbek-test.example.com as primary",
    })
    .click();
  await acceptConfirm(page);
  await expect(page).toHaveURL(/merged=yes/u);

  await page.getByRole("link", { name: "Pipeline" }).click();
  await expect(
    page.getByRole("heading", { name: "Speaker sourcing pipeline", level: 1 }),
  ).toBeVisible();
  await page.getByText("Enroll a contact").click();
  await page.locator('select[name="personId"]').selectOption({
    label: "Marcus Okafor · marcus.speaker@sbek-test.example.com",
  });
  await page.getByLabel("Speaker fit score (optional)").fill("85");
  await page
    .getByLabel("Fit rationale")
    .fill(
      "Strong platform-engineering track record; ideal for Platform & Infra track.",
    );
  await page.getByRole("button", { name: "Enroll contact" }).click();
  const identified = page
    .getByRole("heading", { name: "Identified" })
    .locator("..")
    .locator("..");
  await expect(
    identified.getByRole("link", { name: "Marcus Okafor" }),
  ).toBeVisible();
  await identified.getByLabel("Move to").selectOption("contacted");
  await identified.getByRole("button", { name: "Move card" }).click();
  const contacted = page
    .getByRole("heading", { name: "Contacted" })
    .locator("..")
    .locator("..");
  await contacted.getByLabel("Move to").selectOption("interested");
  await contacted.getByRole("button", { name: "Move card" }).click();
  const interested = page
    .getByRole("heading", { name: "Interested" })
    .locator("..")
    .locator("..");
  await expect(
    interested.getByRole("link", { name: "Marcus Okafor" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    interested.getByRole("link", { name: "Marcus Okafor" }),
  ).toBeVisible();
  await interested.getByRole("link", { name: "Marcus Okafor" }).click();
  await page
    .getByLabel("Pipeline note")
    .fill("Left voicemail 2027-01-15; follow up next week.");
  await page.getByRole("button", { name: "Save pipeline note" }).click();
  await expect(page).toHaveURL(/saved=pipeline-note/u);
  await expect(page.getByText(/Left voicemail/)).toBeVisible();
  await expect(page.getByText("contacted → interested")).toBeVisible();

  await page.getByLabel("Target event").selectOption("evt-foe-2025");
  await page.getByRole("button", { name: "Add prospect to event" }).click();
  await expect(page).toHaveURL(/\/admin\/crm\/contacts\//u);
  await expect(page.locator(".validation-item[role='status']")).toContainText(
    "The current event was not changed",
  );
  await page.goto("/admin/speakers?query=Marcus%20Okafor");
  const focusedSpeaker = page.getByRole("row").filter({
    has: page.getByRole("link", { name: "Marcus Okafor" }),
  });
  await expect(
    focusedSpeaker.getByText("marcus.speaker@sbek-test.example.com", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    focusedSpeaker.getByLabel("Workflow status for Marcus Okafor"),
  ).toHaveValue("prospect");
  await expect(
    focusedSpeaker.getByRole("button", {
      name: "Send portal invitation",
    }),
  ).toBeVisible();
  const pendingMarcusInvitation = page
    .locator("section")
    .filter({
      has: page.getByRole("heading", {
        name: "Speaker invitations awaiting acceptance",
      }),
    })
    .filter({ hasText: "marcus.speaker@sbek-test.example.com" });
  await expect(pendingMarcusInvitation).toHaveCount(0);

  await page
    .getByRole("main")
    .getByRole("link", { name: "Speaker Network" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Top companies" }),
  ).toBeVisible();
  await page.getByLabel("Select Priya Raman").check();
  await page.getByLabel("Select Marcus Okafor").check();
  await page.getByRole("button", { name: "Email selected contacts" }).click();
  await expect(
    page.getByRole("heading", { name: "Bulk speaker invitations" }),
  ).toBeVisible();
  await page.getByLabel("Subject").fill("Speak at DevFlow Conf 2027?");
  await page
    .getByLabel("Email footer physical address")
    .fill("100 Programme Way, Toronto");
  await page
    .getByRole("button", { name: "Create draft and preview recipients" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Compose communication" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Generate current preview" }).click();
  await expect(
    page.getByText("All selected recipients are deliverable."),
  ).toBeVisible();
  await expect(
    page.getByRole("table", { name: "Deliverable recipient sample" }),
  ).toContainText("Priya Raman");
  await expect(
    page.getByRole("table", { name: "Deliverable recipient sample" }),
  ).toContainText("Marcus Okafor");
});

test("event roster previews CSV speakers and exposes explicit workflow status", async ({
  page,
}) => {
  /* A reset intentionally removes organisation contacts but retains global
     person identities. Unique addresses keep this event-import test
     independent of identities created by earlier CRM runs. */
  const emailToken = crypto.randomUUID();
  const eventRosterCsv = [
    "name,email,title,company,bio",
    `Priya Raman,priya-${emailToken}@sbek-test.example.com,Principal Engineer,Latticework Systems,"Leads the build-tooling platform team at Latticework Systems."`,
    `Marcus Okafor,marcus-${emailToken}@sbek-test.example.com,Staff Developer Advocate,Cloudreach Labs,"Focused on AI agents in production; writes Agents Weekly."`,
    `Dana Kowalski,dana-${emailToken}@sbek-test.example.com,Engineering Manager,Substrate,"Runs the developer-experience org at Substrate; ex-CI lead at a fintech."`,
  ].join("\n");
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
  await page
    .locator("details")
    .filter({ hasText: "Add speaker record" })
    .locator("summary")
    .click();
  await page
    .locator("details")
    .filter({ hasText: "Import event speakers from CSV" })
    .locator("summary")
    .click();
  await expect(
    page.getByRole("button", { name: "Add speaker record" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Preview speaker import" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Speaker readiness" })
      .locator("thead th")
      .first(),
  ).toHaveCSS("position", "static");
  await page.getByLabel("Event speaker CSV").setInputFiles({
    name: "event-speakers.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(eventRosterCsv),
  });
  await page.getByRole("button", { name: "Preview speaker import" }).click();
  await expect(
    page.getByRole("heading", { name: "Import preview" }),
  ).toBeVisible();
  await expect(page.getByRole("cell", { name: "Priya Raman" })).toBeVisible();
  const priyaPreview = page.getByRole("row", { name: /Priya Raman/ });
  await expect(priyaPreview).toContainText("Principal Engineer");
  await expect(priyaPreview).toContainText("Latticework Systems");
  await expect(priyaPreview).toContainText(
    "New neutral identity and organisation profile",
  );
  await expect(
    page.getByRole("cell", { name: "Prospect" }).first(),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Confirm event roster import" })
    .click();
  await expect(
    page.getByText(
      "3 speakers imported to this event roster. No invitation email was sent.",
      { exact: true },
    ),
  ).toBeVisible();
  const status = page.getByLabel("Workflow status for Dana Kowalski");
  await expect(status).toHaveValue("prospect");
  await status.selectOption("confirmed");
  await status.locator("..").getByRole("button", { name: "Save" }).click();
  await expect(
    page.getByText("Speaker marked as confirmed.", { exact: true }),
  ).toBeVisible();
});
