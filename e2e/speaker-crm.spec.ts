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

test.setTimeout(180_000);

test("inactive speaker records explain restoration before onboarding", async ({
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
  await page.goto("/admin/speakers?person=person-demo-speaker");
  const nextSteps = page.getByRole("region", {
    name: "Next steps for Priya Shah",
  });
  for (const status of ["declined", "withdrawn"]) {
    const workflow = page.getByLabel("Workflow status for Priya Shah");
    await workflow.selectOption(status);
    await workflow
      .locator("..")
      .getByRole("button", { name: "Save", exact: true })
      .click();
    await expect(nextSteps).toContainText(
      `Onboarding tasks are unavailable while this speaker is ${status}`,
    );
    await expect(
      nextSteps.getByRole("link", { name: "Assign onboarding tasks" }),
    ).toHaveCount(0);
    await page
      .getByRole("row")
      .filter({
        has: page.getByRole("link", { name: "Priya Shah", exact: true }),
      })
      .getByRole("link", { name: "Priya Shah", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Priya Shah", exact: true, level: 1 }),
    ).toBeVisible();
    await expect(nextSteps).toContainText(
      `Onboarding tasks are unavailable while this speaker is ${status}`,
    );
    await expect(
      nextSteps.getByRole("link", { name: "Assign onboarding tasks" }),
    ).toHaveCount(0);
    await nextSteps.getByRole("link", { name: "Review roster status" }).click();
  }
  const workflow = page.getByLabel("Workflow status for Priya Shah");
  await workflow.selectOption("prospect");
  await workflow
    .locator("..")
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await nextSteps
    .getByRole("link", { name: "Assign onboarding tasks" })
    .click();
  await expect(
    page
      .getByRole("combobox", { name: "Speaker", exact: true })
      .locator("option:checked"),
  ).toContainText("priya.speaker@example.com");
});

test("adding a speaker hands off to portal access, a session and onboarding", async ({
  page,
}) => {
  page.setDefaultTimeout(15_000);
  const email = `handoff-${crypto.randomUUID()}@example.com`;
  const name = "Taylor Invited";
  const biography = "Shares practical conference design ideas.";
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
  await page.goto("/admin/speakers?query=Priya");
  await page.locator("body[data-hydrated='true']").waitFor();
  await page.getByRole("button", { name: "Add speaker", exact: true }).click();
  const form = page.locator("#add-speaker-record form");
  await form.locator('input[name="name"]').fill(name);
  await form.locator('input[name="email"]').fill(email);
  await form.locator('textarea[name="biography"]').fill(biography);
  await form.getByRole("button", { name: "Add speaker record" }).click();
  await expect(
    page
      .getByRole("status")
      .filter({ hasText: "No invitation email was sent" }),
  ).toBeVisible();
  const nextSteps = page.getByRole("region", {
    name: `Next steps for ${name}`,
  });
  await expect(nextSteps).toBeVisible();
  await expect(nextSteps.getByRole("heading")).toBeFocused();
  await expect(nextSteps).toContainText(
    "You can prepare their session before they accept portal access",
  );
  await nextSteps.screenshot({
    path: ".artifacts/speaker-creation-handoff.png",
  });
  await nextSteps
    .getByRole("link", { name: "Invite to speaker portal" })
    .click();
  const row = page.getByRole("row").filter({
    has: page.getByRole("link", { name, exact: true }),
  });
  await expect(row).toBeFocused();
  await row.getByLabel(`Confirm email to ${email}`).check();
  await row.getByRole("button", { name: /portal invitation/ }).click();
  await expect(
    page.getByRole("status").filter({
      hasText: "Demonstration mode does not send its sign-in email",
    }),
  ).toBeVisible();
  await page.reload();
  await expect(nextSteps).toBeVisible();
  await expect(
    nextSteps.getByRole("link", { name: "Add a session for this speaker" }),
  ).toBeVisible();
  await expect(
    nextSteps.getByRole("link", { name: "Assign onboarding tasks" }),
  ).toBeVisible();
  await row.getByRole("link", { name, exact: true }).click();
  await expect(
    page.getByRole("heading", { name, level: 1, exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name, level: 1, exact: true }),
  ).toBeVisible();
  await expect(nextSteps).toContainText(
    "You can prepare their session before they accept portal access",
  );
  await nextSteps
    .getByRole("link", { name: "Assign onboarding tasks" })
    .click();
  await expect(
    page
      .getByRole("combobox", { name: "Speaker", exact: true })
      .locator("option:checked"),
  ).toContainText(email);
  await page.getByRole("button", { name: /Assigned work/ }).click();
  await expect(page).toHaveURL(/\/admin\/tasks\?person=/u);
  const assignedHandoffUrl = page.url();
  await page.locator(".tasks-filters summary").click();
  await page.getByRole("link", { name: "Clear", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/tasks$/u);
  await page
    .getByRole("button", { name: "Plans & onboarding", exact: true })
    .click();
  await expect(page).toHaveURL(/\/admin\/tasks\?view=plans$/u);
  await expect(
    page
      .getByRole("combobox", { name: "Speaker", exact: true })
      .locator("option:checked"),
  ).not.toContainText(email);
  await page.goBack();
  await expect(page).toHaveURL(/\/admin\/tasks$/u);
  await page.goBack();
  await expect(page).toHaveURL(assignedHandoffUrl);
  await expect(
    page
      .locator(".tasks-plan-assignment select[name='targetId']")
      .locator("option:checked"),
  ).toContainText(email);
  await page
    .getByRole("button", { name: "Plans & onboarding", exact: true })
    .click();
  await expect(
    page
      .getByRole("combobox", { name: "Speaker", exact: true })
      .locator("option:checked"),
  ).toContainText(email);
  await page.getByRole("button", { name: "Assign with prerequisites" }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Task plan assigned" }),
  ).toBeVisible();

  await page.getByRole("link", { name: "Event speakers", exact: true }).click();
  await page.getByRole("textbox", { name: "Search", exact: true }).fill(email);
  await expect(page).toHaveURL(
    new RegExp(`query=${encodeURIComponent(email)}`),
  );
  await row.getByRole("link", { name, exact: true }).click();
  await expect(
    page.getByRole("heading", { name, level: 1, exact: true }),
  ).toBeVisible();
  await nextSteps
    .getByRole("link", { name: "Add a session for this speaker" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Add session", level: 1 }),
  ).toBeVisible();
  await expect(page.getByLabel("Speaker 1 name")).toHaveValue(name);
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue(email);
  await expect(page.getByRole("textbox", { name: /^Biography/ })).toHaveValue(
    biography,
  );
  await expect(
    page.getByRole("status").filter({ hasText: "needs portal access first" }),
  ).toHaveCount(0);
  await page.getByLabel("Session title").fill("Invited conference design talk");
  await page
    .getByRole("combobox", { name: "Track", exact: true })
    .selectOption({ index: 1 });
  await page.getByRole("button", { name: "Add session", exact: true }).click();
  await page.getByLabel(/I reviewed these identities/u).check();
  await page.getByRole("button", { name: "Add session", exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/schedule\?session=[^&]+&created=1/u);
  await page.reload();
  await expect(
    page.getByText("Invited conference design talk", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("link", { name: "Event speakers", exact: true }).click();
  await page.getByRole("textbox", { name: "Search", exact: true }).fill(email);
  await expect(page).toHaveURL(
    new RegExp(`query=${encodeURIComponent(email)}`),
  );
  await row.getByRole("link", { name, exact: true }).click();
  await nextSteps
    .getByRole("link", { name: "Add a session for this speaker" })
    .click();
  await page
    .getByRole("button", { name: "Search or run a command", exact: true })
    .click();
  const commands = page.getByRole("dialog", {
    name: "Search or run a command",
  });
  await commands.getByRole("option", { name: /Add session/ }).click();
  await expect(page).toHaveURL(/\/admin\/sessions\/new$/u);
  await expect(page.getByLabel("Speaker 1 name")).toHaveValue("");
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue("");
  await page.goBack();
  await expect(page.getByLabel("Speaker 1 name")).toHaveValue(name);
  await expect(page.getByLabel("Email", { exact: true })).toHaveValue(email);
  for (const path of [
    "/admin/sessions/new?person=",
    "/admin/tasks?person=%20",
  ]) {
    expect((await page.request.get(path)).status()).toBe(404);
  }
});

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
    {
      name: "program_cue_demo_identity",
      value: "owner",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const handoffSuffix = Date.now();
  const handoffEventName = `CRM handoff target ${handoffSuffix}`;
  await page.goto("/admin/events/new");
  await page.getByLabel("Event name").fill(handoffEventName);
  await page
    .getByLabel("Public slug")
    .fill(`crm-handoff-target-${handoffSuffix}`);
  await page.getByRole("button", { name: "Create blank event" }).click();
  await acceptConfirm(page);
  const openHandoffEvent = page.getByRole("button", {
    name: "Open new event",
  });
  await expect(openHandoffEvent).toBeVisible();
  const handoffEventId = await openHandoffEvent
    .locator("..")
    .locator('input[name="eventId"]')
    .inputValue();

  await page.goto("/admin/crm");
  await expect(page.getByText("Organisation-wide · all events")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Speaker directory", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByText("0 returning speakers", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByText(
      "Returning speakers have sessions in more than one active event in this organisation.",
    ),
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

  await page
    .locator("#main .page-actions")
    .getByRole("link", { name: "Speaker directory" })
    .click();
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

  await page.getByLabel("Target event").selectOption(handoffEventId);
  await page.getByRole("button", { name: "Add prospect to event" }).click();
  await expect(page).toHaveURL(/\/admin\/crm\/contacts\//u);
  await expect(page.locator(".validation-item[role='status']")).toContainText(
    "The current event was not changed",
  );
  await page
    .getByRole("button", {
      name: "Switch to target event and open prospect",
    })
    .click();
  await expect(page).toHaveURL(/\/admin\/speakers\?person=/u);
  await expect(page.locator(".event-switcher strong")).toHaveText(
    handoffEventName,
  );
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

  await page.goto(
    "/events/select?eventId=evt-foe-2025&returnTo=%2Fadmin%2Fcrm",
  );
  const originalEvent = page
    .locator("form")
    .filter({ hasText: "Future of Events 2027" });
  await originalEvent.getByRole("button", { name: "Use this event" }).click();

  await expect(
    page.getByRole("heading", { name: "Top companies" }),
  ).toBeVisible();
  await page.getByLabel("Select Priya Raman").check();
  await page.getByLabel("Select Marcus Okafor").check();
  await page.getByRole("button", { name: "Email selected contacts" }).click();
  await expect(
    page.getByRole("heading", { name: "Bulk speaker invitations" }),
  ).toBeVisible();
  await expect(page.getByText("Select at least two contacts.")).toBeVisible();
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

test("re-adding a confirmed speaker preserves workflow status and profile", async ({
  page,
}) => {
  const name = "Priya Shah";
  const email = "priya.speaker@example.com";
  const jobTitle = "Director of Experience Design";
  const organisationName = "EventLab";
  const biography =
    "Priya Shah helps event teams design useful, inclusive technology experiences. Her work brings together service design, accessible interaction patterns and the practical details that help busy conferences feel calm, welcoming and easy to navigate for every attendee.";

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

  const rosterRow = page.getByRole("row").filter({
    has: page.getByRole("link", { name, exact: true }),
  });
  await expect(rosterRow.getByLabel(`Workflow status for ${name}`)).toHaveValue(
    "confirmed",
  );
  await expect(rosterRow).toContainText(`${jobTitle} · ${organisationName}`);

  await page.getByRole("button", { name: "Add speaker", exact: true }).click();
  const addSpeakerForm = page.locator("#add-speaker-record form");
  await addSpeakerForm.locator('input[name="name"]').fill(name);
  await addSpeakerForm.locator('input[name="email"]').fill(email);
  await addSpeakerForm
    .locator('input[name="jobTitle"]')
    .fill("Attempted replacement title");
  await addSpeakerForm
    .locator('input[name="organisationName"]')
    .fill("Attempted replacement organisation");
  await addSpeakerForm
    .locator('textarea[name="biography"]')
    .fill("Attempted replacement biography.");
  await addSpeakerForm
    .getByRole("button", { name: "Add speaker record" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Likely existing person" }),
  ).toBeVisible();
  await addSpeakerForm.getByLabel(/I reviewed these identities/u).check();
  await addSpeakerForm
    .getByRole("button", { name: "Add speaker record" })
    .click();
  await expect(page.getByRole("alert")).toContainText(
    "This identity is already on this event roster. The entered profile values were not applied; edit the existing speaker record instead.",
  );

  await page.reload();
  const reloadedRow = page.getByRole("row").filter({
    has: page.getByRole("link", { name, exact: true }),
  });
  await expect(
    reloadedRow.getByLabel(`Workflow status for ${name}`),
  ).toHaveValue("confirmed");
  await expect(reloadedRow).toContainText(`${jobTitle} · ${organisationName}`);

  await page.context().addCookies([
    {
      name: "program_cue_demo_identity",
      value: "speaker",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  await page.goto("/participant/profile");
  await expect(page.getByLabel("Display name")).toHaveValue(name);
  await expect(page.getByLabel("Job title")).toHaveValue(jobTitle);
  await expect(page.getByLabel("Organisation")).toHaveValue(organisationName);
  await expect(page.getByLabel("Biography")).toHaveValue(biography);
});
