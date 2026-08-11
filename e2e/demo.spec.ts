import { expect, test } from "@playwright/test";

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
  await expect(
    page.getByText("These identities have no password"),
  ).toBeVisible();
  await expect(
    page.getByRole("row", { name: /evaluator.*Jordan Lee/i }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "What to try" }),
  ).toBeVisible();
  await expect(
    page.getByText("No success is simulated.").first(),
  ).toBeVisible();

  const evaluatorRow = page.getByRole("row", {
    name: /evaluator.*Jordan Lee/i,
  });
  await evaluatorRow
    .getByRole("button", { name: "Enter as evaluator" })
    .click();
  await expect(page).toHaveURL(/\/review\/workbench/);
  await expect(
    page.getByRole("heading", { name: "Review Workbench" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Return to administrator demo" })
    .click();
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
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reset complete demo event" }).click();
  await expect(page.getByText("Demo restored", { exact: true })).toBeVisible();
  await expect(page.getByText("2", { exact: true }).first()).toBeVisible();

  await waitForInterface(page, "/admin/event");
  await expect(page.getByLabel("Venue")).toHaveValue(
    "Metro Toronto Convention Centre",
  );

  await waitForInterface(page, "/admin/communications");
  const audienceComposer = page.locator("section").filter({
    has: page.getByRole("heading", { name: "1. Configure audience" }),
  });
  await expect(audienceComposer.getByLabel("Published template")).toHaveValue(
    "c4be71b7-cf55-4e8a-ac28-73f2c83bde42",
  );
  await audienceComposer
    .getByRole("button", { name: "Preview recipients and content" })
    .click();
  await expect(
    page.getByRole("heading", { name: "Verify preview" }),
  ).toBeVisible();
  await expect(page.getByText("Nothing queued", { exact: true })).toBeVisible();
  await expect(
    page
      .getByRole("table", { name: "Deliverable recipient sample" })
      .getByRole("cell", { name: "Priya Shah", exact: true }),
  ).toBeVisible();
});
