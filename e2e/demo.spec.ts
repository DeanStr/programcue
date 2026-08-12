import { expect, test } from "@playwright/test";
import { acceptConfirm } from "./support/confirm-dialog";

const resetConfirmation = "Future of Events 2025";

async function waitForInterface(
  page: import("@playwright/test").Page,
  path: string,
) {
  const response = await page.goto(path);
  expect(response?.ok()).toBeTruthy();
  await page.locator("body[data-hydrated='true']").waitFor();
}

test("the evaluator guide exposes honest identities, a walkthrough and a complete reset", async ({
  page,
}) => {
  await waitForInterface(page, "/admin/command");
  await page.getByTitle("Open evaluator guide and reset controls").click();
  await expect(page).toHaveURL(/\/demo$/);
  await expect(
    page.getByRole("heading", { name: "Try the complete conference workflow" }),
  ).toBeVisible();
  await expect(page.getByText(/These people have no password/)).toBeVisible();
  await expect(
    page.getByRole("row", { name: /administrator.*Jordan Alvarez/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("row", { name: /evaluator.*Jordan Lee/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("row", { name: /sbek reviewer.*Sam Whitfield/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("row", { name: /sbek speaker.*Priya Raman/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "What to try" }),
  ).toBeVisible();
  await expect(
    page.getByText("No success is simulated.").first(),
  ).toBeVisible();

  const formBuilder = page.locator("li").filter({
    has: page.getByRole("heading", { name: "Form builder" }),
  });
  await formBuilder
    .getByRole("button", { name: "Open as Jordan Alvarez" })
    .click();
  await expect(page).toHaveURL(/\/admin\/submissions\/form$/);
  await waitForInterface(page, "/demo");

  const evaluatorRow = page.getByRole("row", {
    name: /evaluator.*Jordan Lee/i,
  });
  await evaluatorRow
    .getByRole("button", { name: "Continue as Jordan Lee" })
    .click();
  await expect(page).toHaveURL(/\/review\/workbench/);
  await expect(
    page.getByRole("heading", { name: "Review Workbench" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Return to organizer demo" }).click();
  await expect(page).toHaveURL(/\/admin\/command/);

  await waitForInterface(page, "/admin/event");
  await page.getByLabel("Venue").fill("Temporary evaluator reset venue");
  await page.getByRole("button", { name: "Save event" }).click();
  await expect(
    page.getByText("Event settings saved to D1.", { exact: true }),
  ).toBeVisible();

  await waitForInterface(page, "/demo");
  await page
    .getByLabel(/Type Future of Events 2025 to confirm/)
    .fill(resetConfirmation);
  await page.getByRole("button", { name: "Reset complete demo event" }).click();
  await acceptConfirm(page);
  await expect(page.getByText("Demo restored", { exact: true })).toBeVisible();
  await expect(page.getByText("2", { exact: true }).first()).toBeVisible();

  await waitForInterface(page, "/admin/event");
  await expect(page.getByLabel("Venue")).toHaveValue(
    "Metro Toronto Convention Centre",
  );

  await waitForInterface(page, "/admin/communications");
  await page.getByRole("link", { name: "New communication" }).first().click();
  const draftComposer = page.locator("section").filter({
    has: page.getByRole("heading", { name: "1. Create the durable draft" }),
  });
  await expect(draftComposer.getByLabel("Published template")).toHaveValue(
    "c4be71b7-cf55-4e8a-ac28-73f2c83bde42",
  );
  await draftComposer
    .getByRole("button", { name: "Create durable draft" })
    .click();
  await page.getByRole("button", { name: "Generate current preview" }).click();
  await expect(
    page.getByRole("heading", { name: "2. Verify the authoritative preview" }),
  ).toBeVisible();
  await expect(page.getByText("Nothing queued", { exact: true })).toBeVisible();
  await expect(
    page
      .getByRole("table", { name: "Deliverable recipient sample" })
      .getByRole("cell", { name: "Priya Shah", exact: true }),
  ).toBeVisible();
  const savedConfiguration = page.locator("section").filter({
    has: page.getByRole("heading", { name: "1. Saved draft configuration" }),
  });
  await savedConfiguration
    .getByRole("textbox", { name: /Manual addresses/ })
    .fill("unsaved@example.com");
  await expect(
    page.getByText(/visible configuration has unsaved changes/i),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Generate current preview" }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: /Confirm \d+ deliver/ }),
  ).toBeDisabled();

  await waitForInterface(
    page,
    "/admin/communications?composed=queued&communication=00000000-0000-4000-8000-000000000000",
  );
  await expect(page.getByText(/authoritative delivery result/i)).toHaveCount(0);
  const missingDraftActionStatus = await page.evaluate(async () => {
    const response = await fetch("/admin/communications/compose", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ intent: "preview-draft" }),
    });
    return response.status;
  });
  expect(missingDraftActionStatus).toBe(404);
  const missingDraft = await page.goto(
    "/admin/communications/compose/00000000-0000-4000-8000-000000000000",
  );
  expect(missingDraft?.status()).toBe(404);
  await expect(
    page.getByRole("heading", { name: "Page not found" }),
  ).toBeVisible();
});

test("an unselected demo browser is anonymous on private routes", async ({
  page,
}) => {
  await page.context().clearCookies();
  await waitForInterface(page, "/demo");
  await expect(
    page.getByText(
      /Private workspaces do not silently assign an administrator/,
    ),
  ).toBeVisible();

  await page.goto("/admin/schedule");
  await expect(page).toHaveURL(/\/demo\?returnTo=%2Fadmin%2Fschedule$/);
  await page
    .getByRole("row", { name: /administrator.*Jordan Alvarez/i })
    .getByRole("button", { name: "Continue as Jordan Alvarez" })
    .click();
  await expect(page).toHaveURL(/\/admin\/schedule$/);

  const publicResponse = await page.goto(
    "/public/programme/future-of-events-2025",
  );
  expect(publicResponse?.ok()).toBeTruthy();
  await expect(
    page.getByRole("heading", { name: "Future of Events 2025" }),
  ).toBeVisible();
});
