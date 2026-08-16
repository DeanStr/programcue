import { expect, test } from "@playwright/test";

import { resetDemoEvent } from "./support/reset-demo-event";

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

test("organisers compose, preview and publish the bounded public event site", async ({
  page,
}) => {
  await page.goto("/admin/site");
  await expect(
    page.getByRole("heading", { name: "Public event site" }),
  ).toBeVisible();
  await expect(page.getByLabel("Publication status")).toContainText("Branding");
  await expect(page.getByLabel("Publication status")).toContainText(
    "Programme",
  );

  await page.getByLabel("Tagline").fill("One destination for the whole event.");
  await page.getByLabel("Theme").selectOption("dark");
  const firstSection = page.locator(".public-site-section-order > li").first();
  await firstSection.getByRole("button", { name: "Move down" }).focus();
  await page.keyboard.press("Enter");
  await expect(
    page.locator(".public-site-section-order > li").first(),
  ).toContainText("Featured speakers");

  const aboutPage = page
    .locator(".public-site-page-editor fieldset")
    .filter({ has: page.locator("legend", { hasText: "About" }) });
  await aboutPage.getByLabel("Publish this page with the site").check();
  const longAboutNavigationLabel = "A".repeat(40);
  await aboutPage.getByLabel("Navigation label").fill(longAboutNavigationLabel);
  await aboutPage
    .getByLabel("Restricted Markdown")
    .fill("## Why attend\n\nMeet practitioners building better events.");
  const sponsorsPage = page
    .locator(".public-site-page-editor fieldset")
    .filter({ has: page.locator("legend", { hasText: "Sponsors" }) });
  await sponsorsPage.getByLabel("Publish this page with the site").check();
  const longSponsorsNavigationLabel = "S".repeat(40);
  await sponsorsPage
    .getByLabel("Navigation label")
    .fill(longSponsorsNavigationLabel);
  await sponsorsPage
    .getByLabel("Restricted Markdown")
    .fill("Thanks to the organisations supporting this event.");

  await page
    .getByRole("complementary", { name: "Primary navigation" })
    .getByRole("link", { name: "Speakers", exact: true })
    .click();
  const unsavedDialog = page.getByRole("dialog", {
    name: "Leave without saving the public site?",
  });
  await expect(unsavedDialog).toBeVisible();
  await unsavedDialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(page).toHaveURL(/\/admin\/site$/u);
  await expect(page.getByLabel("Tagline")).toHaveValue(
    "One destination for the whole event.",
  );

  await expect(
    page.getByLabel("Preview content").locator("option"),
  ).toHaveCount(6);
  await page.getByLabel("Preview content").selectOption("about");
  await expect(
    page
      .locator(".public-site-preview-frame")
      .getByRole("heading", { name: "Why attend" }),
  ).toBeVisible();
  await page.getByLabel("Preview content").selectOption("code-of-conduct");
  await expect(
    page.locator(".public-site-preview-frame > header"),
  ).toContainText("Not enabled for publication");
  await page.getByLabel("Preview content").selectOption("home");
  await page.getByRole("button", { name: "Mobile" }).click();
  await expect(page.locator(".public-site-preview-frame")).toHaveClass(
    /is-mobile/,
  );
  await expect(page.locator(".public-site-preview-frame")).toHaveAttribute(
    "data-public-theme",
    "dark",
  );
  const previewFrame = page.locator(".public-site-preview-frame");
  await expect(previewFrame.getByText("Explore the programme")).toBeVisible();
  await expect(
    previewFrame.getByRole("link", { name: "Explore the programme" }),
  ).toHaveCount(0);
  const previewAccent = await previewFrame.evaluate((element) =>
    getComputedStyle(element).getPropertyValue("--event-accent").trim(),
  );
  expect(previewAccent).toMatch(/^#[0-9a-f]{6}$/iu);
  await page.getByRole("button", { name: "Create site draft" }).click();
  await expect(
    page.getByText("Public-site draft saved. Public pages are unchanged."),
  ).toBeVisible();

  await page
    .getByLabel("Tagline")
    .fill("One destination for the event and every attendee.");
  await expect(
    page.getByRole("button", { name: "Add sponsor" }),
  ).toBeDisabled();
  await expect(
    page.getByText(
      "Save the homepage and page edits before changing sponsors or recording drafts. Published recordings can still be withdrawn.",
    ),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save site draft" }).click();
  await expect(
    page.getByText("Public-site draft saved. Public pages are unchanged."),
  ).toBeVisible();
  await expect(page.getByLabel("Tagline")).toHaveValue(
    "One destination for the event and every attendee.",
  );

  await page.getByLabel("New sponsor name").fill("Example Partner");
  const newSponsor = page
    .locator("form.public-site-record-editor")
    .filter({ has: page.getByLabel("New sponsor name") });
  await newSponsor.getByLabel("Tier").fill("Community");
  await newSponsor
    .getByLabel("Website URL")
    .fill("https://example.com/partner");
  await newSponsor.getByRole("button", { name: "Add sponsor" }).click();
  await expect(
    page.getByText("Sponsor saved to the site draft."),
  ).toBeVisible();

  await page.getByRole("button", { name: "Publish public site" }).click();
  const confirmation = page.getByRole("dialog", {
    name: "Publish the public event site?",
  });
  await expect(confirmation).toContainText("Pages to publish: About, Sponsors");
  await expect(confirmation).toContainText(
    "Sponsors to publish: Example Partner",
  );
  await confirmation
    .getByRole("button", { name: "Publish public site" })
    .click();
  await expect(page.getByText("Public event site published.")).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Generated social sharing preview" }),
  ).toHaveAttribute("src", /social-card\.webp\?v=.+/u);
  await expect(page.getByText("Speaker promotion links")).toBeVisible();

  await page.goto("/public/programme/future-of-events-2027");
  await expect(
    page.getByText("One destination for the event and every attendee."),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "About the event" }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Apply to speak" }),
  ).toHaveAttribute("href", "/apply/form");
  await expect(
    page.getByRole("heading", { name: "Supported by" }),
  ).toBeVisible();
  await expect(page.getByText("Example Partner")).toBeVisible();
  await expect(page.locator(".public-shell")).toHaveAttribute(
    "data-public-theme",
    "dark",
  );
  expect(
    await page
      .locator(".public-shell")
      .evaluate((element) =>
        getComputedStyle(element).getPropertyValue("--event-accent").trim(),
      ),
  ).toBe(previewAccent);
  const eventNavigation = page
    .getByRole("navigation", { name: "Event navigation" })
    .first();
  await expect(
    eventNavigation.getByRole("link", { name: "Event home" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    eventNavigation.getByRole("link", { name: "All sessions" }),
  ).toHaveAttribute("href", "/public/programme/future-of-events-2027/sessions");
  await expect(
    eventNavigation.getByRole("link", { name: "Speakers", exact: true }),
  ).toBeVisible();
  await expect(
    eventNavigation.getByLabel("Browse programme and event pages"),
  ).toBeVisible();
  expect(
    await page
      .locator(".public-top")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);

  await page.setViewportSize({ width: 900, height: 720 });
  await expect(page.locator(".public-nav")).toBeHidden();
  await expect(
    page.locator(".public-mobile-nav").getByText("Browse", { exact: true }),
  ).toBeVisible();
  expect(
    await page
      .locator(".public-top")
      .evaluate((element) => element.scrollWidth <= element.clientWidth),
  ).toBe(true);
  await page.setViewportSize({ width: 1280, height: 720 });

  await eventNavigation.getByLabel("Browse programme and event pages").click();
  const longAboutNavigationLink = eventNavigation.getByRole("link", {
    name: longAboutNavigationLabel,
  });
  expect(
    await longAboutNavigationLink.evaluate(
      (element) => element.scrollWidth <= element.clientWidth,
    ),
  ).toBe(true);
  await longAboutNavigationLink.click();
  await expect(page).toHaveURL(
    /\/public\/programme\/future-of-events-2027\/pages\/about$/u,
  );
  await expect(
    page
      .getByRole("navigation", { name: "Event navigation" })
      .first()
      .getByLabel(`Browse, current page ${longAboutNavigationLabel}`),
  ).toBeVisible();
  await expect(page.getByRole("heading", { name: "Why attend" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "All sessions" }),
  ).toHaveAttribute("href", "/public/programme/future-of-events-2027/sessions");
  const fixedPageResponse = await page.request.get(page.url());
  const fixedPageEtag = fixedPageResponse.headers().etag;
  expect(fixedPageResponse.headers()["cache-control"]).toContain("public");
  expect(fixedPageEtag).toBeTruthy();
  const notModified = await page.request.get(page.url(), {
    headers: { "if-none-match": fixedPageEtag },
  });
  expect(notModified.status()).toBe(304);

  await page.getByRole("link", { name: "All sessions" }).first().click();
  await expect(page).toHaveURL(
    /\/public\/programme\/future-of-events-2027\/sessions$/u,
  );
  await expect(
    page.getByRole("link", { name: "All sessions" }).first(),
  ).toHaveAttribute("aria-current", "page");
  const pageNavigation = page
    .getByRole("navigation", { name: "Event navigation" })
    .first();
  await pageNavigation.getByLabel("Browse programme and event pages").click();
  await pageNavigation
    .getByRole("link", { name: longSponsorsNavigationLabel })
    .click();
  await expect(page.getByRole("heading", { name: "Community" })).toBeVisible();
  await expect(page.getByText("Example Partner")).toBeVisible();

  const socialCard = await page.request.get(
    "/public/programme/future-of-events-2027/social-card.webp",
  );
  expect(socialCard.ok()).toBe(true);
  expect(socialCard.headers()["content-type"]).toBe("image/webp");

  await page.goto("/admin/site");
  await page
    .locator(".public-site-page-editor fieldset")
    .filter({ has: page.locator("legend", { hasText: "About" }) })
    .getByLabel("Publish this page with the site")
    .uncheck();
  await page
    .locator(".public-site-page-editor fieldset")
    .filter({ has: page.locator("legend", { hasText: "Sponsors" }) })
    .getByLabel("Publish this page with the site")
    .uncheck();
  await page.getByRole("button", { name: "Save site draft" }).click();
  const sponsorEditor = page.locator("form.public-site-record-editor").filter({
    has: page.locator('input[name="name"][value="Example Partner"]'),
  });
  await sponsorEditor.getByRole("button", { name: "Remove" }).click();
  await page
    .getByRole("dialog", { name: "Remove Example Partner?" })
    .getByRole("button", { name: "Remove sponsor" })
    .click();
  await page.getByRole("button", { name: "Publish public site" }).click();
  const replacement = page.getByRole("dialog", {
    name: "Publish the public event site?",
  });
  await expect(replacement).toContainText("Pages removed: About, Sponsors");
  await expect(replacement).toContainText("Sponsors removed: Example Partner");
});
