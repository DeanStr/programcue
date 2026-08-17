import { expect, type Locator, test } from "@playwright/test";

import { cssColourContrastRatio } from "./support/css-contrast";
import { resetDemoEvent } from "./support/reset-demo-event";

/* The editor renders the published homepage markup inside a 390px frame in a
   desktop viewport, so the only way to say the frame behaves as a phone is to
   compare what the two actually lay out. Column counts are the observable
   difference: viewport-relative spacing fitted one more statistics column in
   the preview than any phone shows. */
/* WCAG 2 contrast for colours read off the rendered page. Event accents are
   customer data and the homepage paints text on mixed fills, so the guarantee
   is measured where the text lands. Chromium serialises those mixes as
   `color(srgb …)`; the shared parser is what stops that looking near-black. */

async function paintedColours(locator: Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return { ink: style.color, background: style.backgroundColor };
  });
}

async function resolvedColorMix(locator: Locator, mix: string) {
  return locator.evaluate((element, value) => {
    const probe = document.createElement("span");
    probe.style.backgroundColor = value;
    element.appendChild(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  }, mix);
}

async function homeColumnCounts(home: Locator) {
  return home.evaluate((element) => {
    const columns = (selector: string) => {
      const parent = element.querySelector(selector);
      if (!parent) return 0;
      return new Set(
        [...parent.children].map((child) => (child as HTMLElement).offsetLeft),
      ).size;
    };
    return {
      features: columns(".public-site-feature-grid"),
      statistics: columns(".public-site-statistics"),
    };
  });
}

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
  test.slow();
  await page.goto("/admin/site");
  await expect(
    page.getByRole("heading", { name: "Event website" }),
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
  const featuredSpeakerSection = page
    .locator(".public-site-section-order > li")
    .first();
  await expect(featuredSpeakerSection).toContainText("Featured speakers");
  await featuredSpeakerSection.getByRole("checkbox").check();
  const featuredSessionSection = page
    .locator(".public-site-section-order > li")
    .filter({ hasText: "Featured sessions" });
  await featuredSessionSection.getByRole("checkbox").check();
  for (const legend of ["Featured speakers", "Featured sessions"]) {
    const choices = page
      .locator("fieldset.public-site-selection")
      .filter({ has: page.locator("legend", { hasText: legend }) });
    for (const choice of await choices.getByRole("checkbox").all()) {
      await choice.check();
    }
  }

  for (const section of [
    "Featured speakers",
    "Featured sessions",
    "Frequently asked questions",
  ]) {
    await page
      .locator(".public-site-section-order > li")
      .filter({ hasText: section })
      .getByRole("checkbox")
      .check();
  }
  const featuredSpeakers = page
    .locator("fieldset.public-site-featured-picker")
    .filter({ has: page.locator("legend", { hasText: "Featured speakers" }) });
  await featuredSpeakers.getByLabel("Search available").fill("Priya Shah");
  await featuredSpeakers
    .locator(".public-site-featured-available > div")
    .filter({ hasText: "Priya Shah" })
    .getByRole("button", { name: "Add" })
    .click();
  await expect(featuredSpeakers).toContainText("Featured · 1 of 12");

  const featuredSessions = page
    .locator("fieldset.public-site-featured-picker")
    .filter({ has: page.locator("legend", { hasText: "Featured sessions" }) });
  await featuredSessions
    .getByLabel("Search available")
    .fill("AI in Event Operations");
  await featuredSessions
    .locator(".public-site-featured-available > div")
    .filter({ hasText: "AI in Event Operations" })
    .getByRole("button", { name: "Add" })
    .click();
  await featuredSessions
    .getByLabel("Search available")
    .fill("The Future of Attendee Engagement");
  await featuredSessions
    .locator(".public-site-featured-available > div")
    .filter({ hasText: "The Future of Attendee Engagement" })
    .getByRole("button", { name: "Add" })
    .click();
  const selectedSessions = featuredSessions.locator(
    ".public-site-featured-selected > li",
  );
  await selectedSessions
    .filter({ hasText: "The Future of Attendee Engagement" })
    .getByRole("button", { name: "Move up" })
    .click();
  await expect(selectedSessions.first()).toContainText(
    "The Future of Attendee Engagement",
  );
  await expect(featuredSessions).toContainText("Featured · 2 of 12");

  await page.getByRole("button", { name: "Add question" }).click();
  await page.getByRole("button", { name: "Add question" }).click();
  const faqQuestions = page.locator(".public-site-faq-editor > fieldset");
  await faqQuestions.nth(0).getByLabel("Question").fill("First question");
  await faqQuestions.nth(0).getByLabel("Answer").fill("First answer");
  await faqQuestions.nth(1).getByLabel("Question").fill("Priority question");
  await faqQuestions.nth(1).getByLabel("Answer").fill("Priority answer");
  await faqQuestions.nth(1).getByRole("button", { name: "Move up" }).click();
  await expect(faqQuestions.nth(0).getByLabel("Question")).toHaveValue(
    "Priority question",
  );

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
    name: "Leave without saving the event website?",
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
  const previewFrame = page.getByRole("region", {
    name: "Event website preview",
  });
  await expect(previewFrame).toHaveAttribute("tabindex", "0");
  await expect(previewFrame.getByText("Explore the programme")).toBeVisible();
  await expect(
    previewFrame.getByRole("link", { name: "Explore the programme" }),
  ).toHaveCount(0);
  const previewColumnCounts = await homeColumnCounts(
    previewFrame.locator(".public-site-home"),
  );
  /* Two by two, not one row of four: at a phone's measure four columns give a
     statistic 87px, which is narrower than "Event Days" sets, so one label
     wrapped and the row of figures sat on a ragged baseline. */
  expect(previewColumnCounts).toEqual({ features: 1, statistics: 2 });
  await previewFrame.evaluate((element) => {
    element.scrollTop = 0;
  });
  await expect(previewFrame).toHaveScreenshot("public-site-preview-mobile.png");
  await page.getByLabel("Theme").selectOption("light");
  await expect(previewFrame).toHaveAttribute("data-public-theme", "light");
  const previewFaq = previewFrame
    .locator(".public-site-faq details")
    .filter({ hasText: "Priority question" });
  await previewFaq.locator("summary").click();
  await expect(previewFaq).toHaveAttribute("open", "");
  await previewFaq.scrollIntoViewIfNeeded();
  await expect(previewFrame).toHaveScreenshot(
    "public-site-preview-mobile-light-faq-open.png",
  );
  await page.getByLabel("Theme").selectOption("dark");
  await expect(previewFrame).toHaveAttribute("data-public-theme", "dark");
  await previewFrame.evaluate((element) => {
    element.scrollTop = 0;
  });
  const previewAccent = await previewFrame.evaluate((element) =>
    getComputedStyle(element).getPropertyValue("--event-accent").trim(),
  );
  expect(previewAccent).toMatch(/^#[0-9a-f]{6}$/iu);
  await page.getByRole("button", { name: "Create website draft" }).click();
  await expect(
    page.getByText("Website draft saved. Public pages are unchanged."),
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
  await page.getByRole("button", { name: "Save website draft" }).click();
  await expect(
    page.getByText("Website draft saved. Public pages are unchanged."),
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
    page.getByText("Sponsor saved to the website draft."),
  ).toBeVisible();

  await page.getByRole("button", { name: "Publish event website" }).click();
  const confirmation = page.getByRole("dialog", {
    name: "Publish the event website?",
  });
  await expect(confirmation).toContainText("Pages to publish: About, Sponsors");
  await expect(confirmation).toContainText(
    "Sponsors to publish: Example Partner",
  );
  await confirmation
    .getByRole("button", { name: "Publish event website" })
    .click();
  await expect(page.getByText("Event website published.")).toBeVisible();
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
  await expect(page.getByText("Priority question")).toBeVisible();
  const featuredSessionLink = page.getByRole("link", {
    name: "The Future of Attendee Engagement",
  });
  await expect(featuredSessionLink).toHaveAttribute(
    "href",
    "/public/programme/future-of-events-2027/sessions?session=demo-session-1",
  );
  await featuredSessionLink.click();
  await expect(page).toHaveURL(
    /\/public\/programme\/future-of-events-2027\/sessions\?session=demo-session-1$/u,
  );
  await expect(
    page.getByRole("heading", {
      name: "The Future of Attendee Engagement",
      exact: true,
      level: 2,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Save The Future of Attendee Engagement to my itinerary",
    }),
  ).toBeVisible();
  await page.evaluate(() => {
    window.history.pushState(
      null,
      "",
      "/public/programme/future-of-events-2027/sessions?session=not-published",
    );
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(
    page.getByRole("heading", { name: "Programme not found" }),
  ).toBeVisible();
  await expect(page.getByText("Published session not found")).toBeVisible();
  expect(
    (
      await page.request.get(
        "/public/programme/future-of-events-2027/sessions?session=not-published",
      )
    ).status(),
  ).toBe(404);
  expect(
    (
      await page.request.get(
        "/public/programme/future-of-events-2027?session=demo-session-1",
      )
    ).status(),
  ).toBe(400);
  expect(
    (
      await page.request.get(
        "/public/programme/future-of-events-2027/sessions?session=demo-session-1&session=demo-session-2",
      )
    ).status(),
  ).toBe(400);
  expect(
    (
      await page.request.get(
        "/public/programme/future-of-events-2027/sessions?speaker=person-demo-speaker&session=demo-session-1",
      )
    ).status(),
  ).toBe(400);
  expect(
    (
      await page.request.get(
        "/embed/future-of-events-2027/sessions?session=demo-session-1",
      )
    ).status(),
  ).toBe(400);
  await page.goto("/public/programme/future-of-events-2027");
  const featuredSpeaker = page.locator(
    ".public-site-speakers a.public-site-feature-card",
  );
  await expect(featuredSpeaker).toContainText("View profile");
  await expect(featuredSpeaker).toHaveAttribute(
    "href",
    /\/public\/programme\/future-of-events-2027\?speaker=/u,
  );
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
  const publishedFaq = page
    .locator(".public-site-faq details")
    .filter({ hasText: "Priority question" });
  await publishedFaq.locator("summary").click();
  await expect(publishedFaq).toHaveAttribute("open", "");
  /* Section headings are headings. An unresolvable custom property makes a
     whole `clamp()` invalid at computed-value time and `font-size` silently
     falls back to the inherited value, which had every heading below the
     introduction rendering at 14px on every desktop while the container query
     kept them correct on a phone. */
  const headingSizes = await page
    .locator(".public-site-section-heading h2")
    .evaluateAll((headings) =>
      headings
        .filter((heading) => {
          const section = heading.closest(".public-site-section");
          return (
            !section?.classList.contains("public-site-introduction") &&
            !section?.classList.contains("public-site-statistics-section")
          );
        })
        .map((heading) =>
          Number.parseFloat(getComputedStyle(heading).fontSize),
        ),
    );
  expect(headingSizes.length).toBeGreaterThan(1);
  for (const size of headingSizes) expect(size).toBeGreaterThanOrEqual(28);

  /* The glance panel is a dark event surface. `backgroundColor` is only the
     canvas under the gradient; the first figures sit on the 28% accent stop.
     Resolve that mix in the page so a louder fill cannot pass against #101817. */
  const statisticsBand = page.locator(".public-site-statistics-section");
  const glanceStop = await resolvedColorMix(
    statisticsBand,
    "color-mix(in srgb, var(--event-accent) 28%, var(--public-dark-canvas))",
  );
  const statisticLabel = await paintedColours(
    page.locator(".public-site-statistics dt").first(),
  );
  const statisticFigure = await paintedColours(
    page.locator(".public-site-statistics dd").first(),
  );
  expect(
    cssColourContrastRatio(statisticLabel.ink, glanceStop),
  ).toBeGreaterThanOrEqual(4.5);
  expect(
    cssColourContrastRatio(statisticFigure.ink, glanceStop),
  ).toBeGreaterThanOrEqual(4.5);
  /* White on the canvas, or on a `color(srgb)` stop parsed as 0–255, is ~18:1.
     The painted brown stop is about 10:1. An upper bound is what says we did
     not measure near-black again. */
  expect(cssColourContrastRatio(statisticFigure.ink, glanceStop)).toBeLessThan(
    15,
  );
  await statisticsBand.evaluate((element) => {
    (element as HTMLElement).style.setProperty("--event-accent", "#ffffff");
  });
  const paleAccentGlanceStop = await resolvedColorMix(
    statisticsBand,
    "color-mix(in srgb, var(--event-accent) 28%, var(--public-dark-canvas))",
  );
  expect(
    cssColourContrastRatio(statisticLabel.ink, paleAccentGlanceStop),
  ).toBeGreaterThanOrEqual(4.5);
  expect(
    cssColourContrastRatio(statisticFigure.ink, paleAccentGlanceStop),
  ).toBeGreaterThanOrEqual(4.5);
  await statisticsBand.evaluate((element) => {
    (element as HTMLElement).style.removeProperty("--event-accent");
  });
  const speakerCue = await paintedColours(
    page.locator(".public-site-speaker-profile-cue").first(),
  );
  const speakerWash = await resolvedColorMix(
    page.locator(".public-site-speakers"),
    "color-mix(in srgb, var(--event-accent) 12%, var(--surface))",
  );
  expect(
    cssColourContrastRatio(speakerCue.ink, speakerWash),
  ).toBeGreaterThanOrEqual(4.5);

  /* The homepage states the venue on its own rail, so the programme's sidebar
     card stands down rather than printing the same address twice on one page. */
  await expect(page.locator(".public-site-venue")).toHaveCount(1);
  await expect(page.locator(".public-venue")).toHaveCount(0);
  /* The curated homepage and the filterable programme are different surfaces;
     the seam between them is named rather than left as an unannounced change
     of visual language. */
  await expect(
    page.getByRole("heading", { name: "Full programme" }),
  ).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.locator(".public-shell")).toHaveScreenshot(
    "published-public-site-desktop.png",
  );
  const publishedHome = page.locator(".public-site-home");
  /* The event header is sticky, so scrolling the homepage into view for an
     element screenshot paints the header over its first section. The header is
     covered by the public-programme baselines in visual.spec.ts. */
  const hiddenHeader = await page.addStyleTag({
    content: ".public-top { visibility: hidden !important; }",
  });
  await expect(publishedHome).toHaveScreenshot("public-site-home-desktop.png");
  /* Light is an event-site choice, and the homepage leans on a dark canvas:
     a near-black masthead, an accent field behind the speakers and a solid
     accent band. A baseline in the other theme is what says those surfaces
     were composed for both. */
  await page.locator(".public-shell").evaluate((element) => {
    element.setAttribute("data-public-theme", "light");
  });
  await expect(publishedHome).toHaveScreenshot(
    "public-site-home-desktop-light.png",
  );
  await page.locator(".public-shell").evaluate((element) => {
    element.setAttribute("data-public-theme", "dark");
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await hiddenHeader.evaluate((style) => style.parentNode?.removeChild(style));
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.locator(".public-shell")).toHaveScreenshot(
    "published-public-site-mobile.png",
  );
  const mobileHiddenHeader = await page.addStyleTag({
    content: ".public-top { visibility: hidden !important; }",
  });
  await expect(publishedHome).toHaveScreenshot("public-site-home-mobile.png");
  expect(await homeColumnCounts(publishedHome)).toEqual(previewColumnCounts);
  /* The event name is truncated rather than sliced. `text-overflow` does
     nothing to a flex container, so a display value chosen for the application
     sidebar cut "Future of Events 2027" through a digit here. */
  const brandName = page.locator(".public-brand-name");
  expect(
    await brandName.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        overflowing: element.scrollWidth > element.clientWidth,
        display: style.display,
        textOverflow: style.textOverflow,
      };
    }),
  ).toEqual({
    overflowing: true,
    display: "block",
    textOverflow: "ellipsis",
  });
  await mobileHiddenHeader.evaluate((style) =>
    style.parentNode?.removeChild(style),
  );
  await page.setViewportSize({ width: 1440, height: 1000 });

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
  await expect(eventNavigation.getByText("Programme views")).toBeVisible();
  await expect(eventNavigation.getByText("Event information")).toBeVisible();
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
  const heroAction = await paintedColours(
    page.locator(".hero").getByRole("link", { name: "Add to calendar" }),
  );
  const hero = await paintedColours(page.locator(".hero"));
  expect(
    cssColourContrastRatio(heroAction.ink, heroAction.background),
  ).toBeGreaterThanOrEqual(4.5);
  expect(
    cssColourContrastRatio(heroAction.background, hero.background),
  ).toBeGreaterThanOrEqual(3);
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
  await page.getByRole("button", { name: "Save website draft" }).click();
  const sponsorEditor = page.locator("form.public-site-record-editor").filter({
    has: page.locator('input[name="name"][value="Example Partner"]'),
  });
  await sponsorEditor.getByRole("button", { name: "Remove" }).click();
  await page
    .getByRole("dialog", { name: "Remove Example Partner?" })
    .getByRole("button", { name: "Remove sponsor" })
    .click();
  await page.getByRole("button", { name: "Publish event website" }).click();
  const replacement = page.getByRole("dialog", {
    name: "Publish the event website?",
  });
  await expect(replacement).toContainText("Pages removed: About, Sponsors");
  await expect(replacement).toContainText("Sponsors removed: Example Partner");
});
