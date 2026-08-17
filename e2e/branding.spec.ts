import { expect, test } from "@playwright/test";

import { resetDemoEvent } from "./support/reset-demo-event";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

test.beforeEach(async ({ context, request }) => {
  await resetDemoEvent(request);
  await context.addCookies([
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

test.afterAll(async ({ request }) => {
  await resetDemoEvent(request);
});

test("branding draft previews and publishes across participant-facing surfaces", async ({
  page,
}) => {
  await page.goto("/admin/branding");
  await expect(page.getByRole("heading", { name: "Branding" })).toBeVisible();

  await page.getByLabel("Brand accent").fill("#0d9488");
  await page
    .getByLabel("Welcome message")
    .fill("Welcome to the browser-verified participant workspace.");
  await page
    .getByLabel("Support URL")
    .fill("https://support.example.test/participants");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(
    page.getByText(
      "Branding draft saved. Public surfaces are unchanged until you publish it.",
    ),
  ).toBeVisible();

  const logoUpload = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Upload logo" }) });
  await logoUpload.locator('input[type="file"]').setInputFiles({
    name: "event-logo.png",
    mimeType: "image/png",
    buffer: png,
  });
  await logoUpload.getByRole("button", { name: "Upload logo" }).click();
  await expect(
    page.getByText("Logo uploaded to the private branding draft."),
  ).toBeVisible();

  const bannerUpload = page
    .locator("form")
    .filter({ has: page.getByRole("button", { name: "Upload banner" }) });
  await bannerUpload.locator('input[type="file"]').setInputFiles({
    name: "event-banner.png",
    mimeType: "image/png",
    buffer: png,
  });
  await bannerUpload.getByRole("button", { name: "Upload banner" }).click();
  await expect(
    page.getByText("Banner uploaded to the private branding draft."),
  ).toBeVisible();

  await page.getByRole("button", { name: "Email" }).click();
  await expect(page.getByText("Sent with Program Cue")).toBeVisible();
  await page.getByRole("button", { name: "Mobile" }).click();
  await expect(page.locator(".branding-preview-frame")).toHaveClass(
    /is-mobile/,
  );

  await page.getByRole("button", { name: "Publish branding" }).click();
  const confirmation = page.getByRole("dialog", {
    name: "Publish event branding?",
  });
  await expect(confirmation).toContainText("Public application");
  await expect(confirmation).toContainText("Communication email templates");
  await confirmation.getByRole("button", { name: "Publish branding" }).click();
  await expect(
    page.getByText(
      "Branding published to the application, participant workspace, programme and email templates.",
    ),
  ).toBeVisible();

  await page.goto("/apply/form");
  await expect(
    page.getByText("Welcome to the browser-verified participant workspace."),
  ).toBeVisible();
  await expect(page.getByAltText("Future of Events 2027 logo")).toHaveAttribute(
    "src",
    "/public/brand/future-of-events-2027/logo",
  );

  await page.goto("/public/programme/future-of-events-2027");
  await expect(page.locator(".public-event-logo")).toHaveAttribute(
    "src",
    "/public/brand/future-of-events-2027/logo",
  );
  await expect(page.locator(".hero")).toHaveClass(/has-image/);
  await expect(page.getByText("Powered by Program Cue")).toBeVisible();

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
  await page.goto("/participant/dashboard");
  await expect(
    page.getByText("Welcome to the browser-verified participant workspace."),
  ).toBeVisible();
  await expect(page.getByAltText("Future of Events 2027 logo")).toHaveAttribute(
    "src",
    "/public/brand/future-of-events-2027/logo",
  );
  await expect(
    page.getByRole("link", { name: "Product guide" }),
  ).toHaveAttribute("href", "https://programcue.com/guide");
  await expect(
    page.getByRole("link", { name: "Support", exact: true }),
  ).toHaveAttribute("href", "https://support.example.test/participants");
});
