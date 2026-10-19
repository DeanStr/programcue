import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { e2eOrigin } from "./support/e2e-origin";
import { openSitePanel, openSiteRecord } from "./support/public-site";
import { resetDemoEvent } from "./support/reset-demo-event";
import { seedSponsorLogo } from "./support/sponsor-asset-fixture";

test("organisers request private assets and prepare filtered reminders; accepted contacts see upload requirements", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await resetDemoEvent(request);
  await page.goto("/");
  await page.goto("/admin/sponsors");
  const companyName = `Readiness company ${"x".repeat(121)}`;
  const companyDescription = "x".repeat(3000);
  await page.getByLabel("Company name", { exact: true }).fill(companyName);
  await page
    .getByRole("textbox", { name: "Company description", exact: true })
    .fill(companyDescription);
  await page
    .getByRole("button", { name: "Create sponsor", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Portal contacts" }),
  ).toBeVisible();
  const adminUrl = page.url();
  await page.getByLabel("Contact name", { exact: true }).fill("Priya Shah");
  await page
    .getByLabel("Contact email", { exact: true })
    .fill("priya.speaker@example.com");
  await page.getByRole("button", { name: "Add contact", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Sponsor contact updated" }),
  ).toBeVisible();
  const assets = page.getByRole("region", {
    name: "Sponsor assets",
    exact: true,
  });
  await assets.getByLabel("Asset name", { exact: true }).fill("Event logo");
  await assets
    .getByRole("button", { name: "Request asset", exact: true })
    .click();
  await expect(
    assets.getByRole("heading", { name: "Event logo · Required", exact: true }),
  ).toBeVisible();
  await assets
    .getByLabel("Asset name", { exact: true })
    .fill("Insurance document");
  await assets
    .getByRole("combobox", { name: "Asset type", exact: true })
    .selectOption("document");
  await assets
    .getByRole("button", { name: "Request asset", exact: true })
    .click();
  await expect(
    assets.getByRole("heading", {
      name: "Insurance document · Required",
      exact: true,
    }),
  ).toBeVisible();
  const readiness = page.getByRole("region", {
    name: "Sponsor readiness",
    exact: true,
  });
  await expect(
    readiness.getByText("2 need sponsor action", { exact: false }),
  ).toBeVisible();
  await readiness
    .getByLabel("Company", { exact: true })
    .fill("Readiness company");
  await readiness
    .getByRole("combobox", { name: "Readiness", exact: true })
    .selectOption("assets");
  await readiness
    .getByRole("button", { name: "Filter sponsors", exact: true })
    .click();
  await expect(page).toHaveURL(/state=assets/);
  await readiness.getByRole("link", { name: "Clear", exact: true }).click();
  await expect(readiness.getByLabel("Company", { exact: true })).toHaveValue(
    "",
  );
  await expect(
    readiness.getByRole("combobox", { name: "Readiness", exact: true }),
  ).toHaveValue("all");
  await page.goBack();
  await expect(readiness.getByLabel("Company", { exact: true })).toHaveValue(
    "Readiness company",
  );
  await expect(
    readiness.getByRole("combobox", { name: "Readiness", exact: true }),
  ).toHaveValue("assets");
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
  await readiness
    .getByRole("button", { name: "Prepare sponsor reminder", exact: true })
    .click();
  await expect(page).toHaveURL(/\/admin\/communications\/compose\//);
  await expect(
    page.getByText("priya.speaker@example.com", { exact: false }).first(),
  ).toBeVisible();
  await page
    .context()
    .addCookies([
      { name: "program_cue_demo_identity", value: "speaker", url: e2eOrigin },
    ]);
  await page.goto("/sponsor");
  await page.getByRole("link", { name: /Readiness company/ }).click();
  await expect(
    page.getByRole("heading", { name: "Sponsor assets", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("checkbox", { name: /I accept sponsor access/ }).check();
  await page
    .getByRole("button", { name: "Accept invitation", exact: true })
    .click();
  const logo = assets.getByRole("article").filter({
    has: page.getByRole("heading", {
      name: "Event logo · Required",
      exact: true,
    }),
  });
  await expect(
    logo.getByLabel("Choose file", { exact: false }),
  ).toHaveAttribute("accept", ".jpg,.jpeg,.png,.webp");
  const document = assets.getByRole("article").filter({
    has: page.getByRole("heading", {
      name: "Insurance document · Required",
      exact: true,
    }),
  });
  await expect(
    document.getByLabel("Choose file", { exact: false }),
  ).toHaveAttribute("accept", ".pdf,.doc,.docx,.xls,.xlsx,.zip");
  await expect(
    assets.getByRole("button", { name: "Save asset review" }),
  ).toHaveCount(0);
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
  // The local browser environment deliberately has no production S3 credentials.
  // Assert the real endpoint's honest failure, never simulated upload success.
  await logo.getByLabel("Choose file", { exact: false }).setInputFiles({
    name: "logo.png",
    mimeType: "image/png",
    buffer: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0]),
  });
  await logo.getByRole("button", { name: "Upload file", exact: true }).click();
  await expect(logo.getByRole("status")).toContainText(
    "Uploads are unavailable",
  );
  await expect(logo.getByRole("link", { name: /Download/ })).toHaveCount(0);
  await page.screenshot({
    path: "/tmp/programcue-sponsor-assets-browser.png",
    fullPage: true,
  });
  await page.context().addCookies([
    {
      name: "program_cue_demo_identity",
      value: "administrator",
      url: e2eOrigin,
    },
  ]);
  const sponsorId = new URL(adminUrl).searchParams.get("sponsor")!;
  const expired = seedSponsorLogo(sponsorId, "expired");
  try {
    await page.goto(adminUrl);
    await expect(
      assets.getByText(
        "Upload expired. Choose the file again to restart. · logo.png",
        { exact: true },
      ),
    ).toBeVisible();
    await readiness
      .getByLabel("Company", { exact: true })
      .fill("Readiness company");
    await readiness
      .getByRole("combobox", { name: "Readiness", exact: true })
      .selectOption("assets");
    await readiness
      .getByRole("button", { name: "Filter sponsors", exact: true })
      .click();
    await expect(
      readiness.getByText("2 need sponsor action", { exact: false }),
    ).toBeVisible();
    await expect(
      readiness.getByRole("button", {
        name: "Prepare sponsor reminder",
        exact: true,
      }),
    ).toBeEnabled();
  } finally {
    expired.abortPendingUpload();
  }
  const fixture = seedSponsorLogo(sponsorId, "clean");
  await page
    .context()
    .addCookies([
      { name: "program_cue_demo_identity", value: "speaker", url: e2eOrigin },
    ]);
  await page.goto(`/sponsor/evt-foe-2025/${sponsorId}`);
  const sponsorDownload = page.waitForEvent("download");
  await logo
    .getByRole("link", { name: "Download Event logo", exact: true })
    .click();
  const sponsorFile = await sponsorDownload;
  expect(await sponsorFile.failure()).toBeNull();
  expect(readFileSync((await sponsorFile.path())!)).toEqual(fixture.bytes);
  await page.context().addCookies([
    {
      name: "program_cue_demo_identity",
      value: "administrator",
      url: e2eOrigin,
    },
  ]);
  await page.goto(adminUrl);
  await expect(
    readiness.getByText("1/1 contacts accepted", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: "/tmp/programcue-sponsor-readiness-browser.png",
    fullPage: true,
  });
  const review = assets.getByRole("article").filter({
    has: page.getByRole("heading", {
      name: "Event logo · Required",
      exact: true,
    }),
  });
  await expect(
    review.getByText("Awaiting organiser review", { exact: false }),
  ).toBeVisible();
  const downloaded = page.waitForEvent("download");
  await review
    .getByRole("link", { name: "Download Event logo", exact: true })
    .click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe("logo.png");
  expect(await download.failure()).toBeNull();
  expect(readFileSync((await download.path())!)).toEqual(fixture.bytes);
  await review
    .getByRole("checkbox", { name: "I have reviewed logo.png." })
    .check();
  await review
    .getByRole("button", { name: "Save asset review", exact: true })
    .click();
  await expect(
    review.getByText("Approved · logo.png", { exact: true }),
  ).toBeVisible();
  await expect(
    review.getByRole("textbox", { name: "Website sponsor name", exact: true }),
  ).toHaveValue(companyName);
  await expect(
    review.getByRole("textbox", {
      name: "Website sponsor description",
      exact: true,
    }),
  ).toHaveValue(companyDescription);
  await expect(
    review.getByRole("textbox", { name: "Website sponsor tier", exact: true }),
  ).toHaveValue("");
  await review
    .getByRole("textbox", { name: "Website sponsor name", exact: true })
    .fill("Readiness company");
  await review
    .getByRole("textbox", { name: "Website sponsor description", exact: true })
    .fill("Public sponsor copy");
  await review
    .getByRole("textbox", { name: "Website sponsor tier", exact: true })
    .fill("Gold");
  expect(
    (await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze())
      .violations,
  ).toEqual([]);
  await review
    .getByRole("checkbox", { name: "Use logo.png in the website draft." })
    .check();
  await review
    .getByRole("button", { name: "Use logo in website draft", exact: true })
    .click();
  await expect(
    page.getByRole("status").filter({ hasText: "Approved logo copied" }),
  ).toBeVisible();
  await review
    .getByRole("link", { name: "Review website draft", exact: true })
    .click();
  await openSitePanel(page, "Sponsors");
  await openSiteRecord(page, "Readiness company");
  await expect(
    page.getByText("Approved sponsor logo.", { exact: false }),
  ).toBeVisible();
  const previewLogo = page
    .locator('img[src*="/admin/sponsor-assets/"]')
    .first();
  await expect(previewLogo).toBeAttached();
  await expect
    .poll(() =>
      previewLogo.evaluate((img) => (img as HTMLImageElement).naturalWidth),
    )
    .toBe(1);
  const privateUrl = await previewLogo.getAttribute("src");
  const requestId = privateUrl!.split("/")[4];
  const publicPath = `/public/sponsor-assets/evt-foe-2025/${requestId}/${fixture.versionId}`;
  expect((await request.get(publicPath)).status()).toBe(404);
  await page
    .getByRole("button", { name: "Publish event website", exact: true })
    .click();
  const confirmation = page.getByRole("dialog", {
    name: "Publish the event website?",
  });
  await expect(confirmation).toContainText("Readiness company");
  await confirmation
    .getByRole("button", { name: "Publish event website", exact: true })
    .click();
  await expect(
    page.getByText("Event website published.", { exact: true }),
  ).toBeVisible();
  const publicLogo = await request.get(publicPath);
  expect(publicLogo.status()).toBe(200);
  expect(await publicLogo.body()).toEqual(fixture.bytes);

  // A replacement invalidates the staged approval but must not trap the website editor.
  seedSponsorLogo(sponsorId, "clean");
  await page.goto("/admin/site");
  await openSitePanel(page, "Sponsors");
  let record = await openSiteRecord(page, "Readiness company");
  await record
    .getByRole("textbox", { name: "Description", exact: true })
    .fill("Updated public sponsor copy");
  await record
    .getByRole("button", { name: "Save sponsor", exact: true })
    .click();
  await expect(
    page.getByText("Sponsor saved to the website draft.", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Publish event website", exact: true })
    .click();
  await confirmation
    .getByRole("button", { name: "Publish event website", exact: true })
    .click();
  await expect(
    page.getByText(
      "Selected sponsor logo is no longer approved and available. Review the website draft.",
      { exact: true },
    ),
  ).toBeVisible();
  record = await openSiteRecord(page, "Readiness company");
  await record
    .getByRole("checkbox", {
      name: "Clear uploaded logo from website draft",
      exact: true,
    })
    .check();
  await record
    .getByRole("button", { name: "Save sponsor", exact: true })
    .click();
  await expect(
    page.getByText("Sponsor saved to the website draft.", { exact: true }),
  ).toBeVisible();
  record = await openSiteRecord(page, "Readiness company");
  await expect(record.getByLabel("Logo URL", { exact: true })).toHaveValue("");
  await expect(
    record.getByRole("textbox", { name: "Description", exact: true }),
  ).toHaveValue("Updated public sponsor copy");
  expect((await request.get(publicPath)).status()).toBe(200);
  await page
    .getByRole("button", { name: "Publish event website", exact: true })
    .click();
  await confirmation
    .getByRole("button", { name: "Publish event website", exact: true })
    .click();
  await expect(
    page.getByText("Event website published.", { exact: true }),
  ).toBeVisible();
  expect((await request.get(publicPath)).status()).toBe(404);
  await page.goto(adminUrl);
  await expect(page.getByLabel("Company name", { exact: true })).toHaveValue(
    companyName,
  );
  await expect(
    page.getByRole("textbox", { name: "Company description", exact: true }),
  ).toHaveValue(companyDescription);
  await expect(page.getByLabel("Tier", { exact: true })).toHaveValue("");
});
