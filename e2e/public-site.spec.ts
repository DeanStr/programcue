import { expect, type Locator, type Page, test } from "@playwright/test";

import { acceptConfirm } from "./support/confirm-dialog";
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

async function openSiteCollection(page: Page, title: string) {
  const disclosure = page.locator("details").filter({
    has: page
      .locator(":scope > summary")
      .locator(":scope > strong, :scope > h2 > span:first-child")
      .filter({ hasText: new RegExp(`^${title}$`) }),
  });
  if (!(await disclosure.evaluate((el) => el.hasAttribute("open")))) {
    await disclosure.locator(":scope > summary").click();
  }
  await expect
    .poll(async () => disclosure.evaluate((el) => el.hasAttribute("open")))
    .toBe(true);
}

async function ensurePageContentOpen(editor: Locator) {
  const pageContent = editor.getByRole("textbox", { name: "Page content" });
  if (await pageContent.isVisible()) return;
  await editor.locator(":scope > details > summary").click();
  await expect(pageContent).toBeVisible();
}

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

/* A fixed page has no section heading between its title and its body, so the
   restricted Markdown subheads and the Sponsors page's tier headings all sit at
   level 2: the page reads title then peers rather than dropping to a subsection
   and climbing back out of it. `heading-order` is an axe best-practice rule
   rather than a WCAG one, so the axe surface added for these pages does not
   check it and this does. */
async function expectFixedPageOutline(page: Page) {
  const levels = await page
    .locator(".public-site-page")
    .evaluate((element) =>
      [...element.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((heading) =>
        Number(heading.tagName.slice(1)),
      ),
    );
  expect(levels.length).toBeGreaterThan(1);
  expect(levels[0]).toBe(1);
  expect([...new Set(levels.slice(1))]).toEqual([2]);
}

/* A 120x40 PNG served from the test process, so a sponsor mark is a real
   decoded image with real intrinsic dimensions and the suite still makes no
   outbound request. */
const SPONSOR_LOGO_URL = "https://example.com/partner-logo.png";
const SPONSOR_LOGO_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAHgAAAAoCAYAAAA16j4lAAAAWklEQVR42u3RQREAAAQAQYlU8Ne/" +
    "DzmYfVyB28iu0d/CBMACLMACLMACLMCABViABViABViAAQuwAAuwAAuwAAswYAEWYAEWYAEWYMAC" +
    "LMACLMACLMCABVg3W7uWFmEIQ/JRAAAAAElFTkSuQmCC",
  "base64",
);

async function serveSponsorLogo(page: Page) {
  await page.route(SPONSOR_LOGO_URL, (route) =>
    route.fulfill({ contentType: "image/png", body: SPONSOR_LOGO_PNG }),
  );
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
    {
      name: "program_cue_demo_identity",
      value: "administrator",
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

test("reset restores a published public event site", async ({ page }) => {
  test.setTimeout(180_000);
  await page.goto("/admin/site");
  await expect(
    page.getByRole("heading", { name: "Event website" }),
  ).toBeVisible();
  await expect(page.getByLabel("Publication status")).toContainText(
    "Event website",
  );
  await expect(page.getByLabel("Publication status")).toContainText(
    "Published",
  );
  await expect(page.getByLabel("Publication status")).toContainText("Branding");
  await expect(page.getByLabel("Publication status")).toContainText(
    "Programme",
  );
  await expect(page.getByLabel("Tagline")).toHaveValue(
    "One destination for the whole event.",
  );
  await expect(page.getByLabel("Theme")).toHaveValue("light");
  await expect(
    page.locator("fieldset.public-site-featured-picker").filter({
      has: page.locator("legend", { hasText: "Featured speakers" }),
    }),
  ).toContainText("Featured · 2 of 12");
  await expect(
    page.locator("fieldset.public-site-featured-picker").filter({
      has: page.locator("legend", { hasText: "Featured sessions" }),
    }),
  ).toContainText("Featured · 2 of 12");
  await expect(
    page
      .locator("details.public-site-rail-disclosure")
      .filter({
        has: page.locator("summary h2 > span:first-child", {
          hasText: /^Sponsors$/,
        }),
      })
      .locator(":scope > summary"),
  ).toContainText("Northstar Events");
  await openSiteCollection(page, "Sponsors");
  await expect(page.getByLabel("New sponsor name")).toBeVisible();
  await expect(
    page.locator('input[name="name"][value="Northstar Events"]'),
  ).toBeVisible();
  await expect(
    page.locator('input[name="name"][value="EventLab"]'),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Open event website" }),
  ).toHaveAttribute("href", "/public/programme/future-of-events-2027");

  await page.goto("/public/programme/future-of-events-2027");
  await expect(
    page.getByText("One destination for the whole event."),
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
  await expect(
    page.locator(".public-site-sponsor-grid a").filter({
      hasText: "Northstar Events",
    }),
  ).toHaveAttribute(
    "href",
    "/public/programme/future-of-events-2027/pages/sponsors",
  );
  await expect(
    page.locator(".public-site-sponsor-grid a").filter({ hasText: "EventLab" }),
  ).toHaveAttribute(
    "href",
    "/public/programme/future-of-events-2027/pages/sponsors",
  );
  await expect(page.locator(".public-site-faq-section")).toHaveCount(0);
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
  const canonicalisedSession = await page.request.get(
    "/public/programme/future-of-events-2027?session=demo-session-1",
  );
  expect(canonicalisedSession.status()).toBe(200);
  expect(canonicalisedSession.url()).toMatch(
    /\/public\/programme\/future-of-events-2027\/sessions\?session=demo-session-1$/u,
  );
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
  const featuredSpeaker = page
    .locator(".public-site-speakers a.public-site-feature-card")
    .filter({ hasText: "Priya Shah" });
  await expect(featuredSpeaker).toContainText("View profile");
  await expect(featuredSpeaker).toHaveAttribute(
    "href",
    /\/public\/programme\/future-of-events-2027\?speaker=person-demo-speaker/u,
  );
  await expect(
    page.locator(".public-site-speakers a.public-site-feature-card"),
  ).toHaveCount(2);
  await expect(page.locator(".public-shell")).toHaveAttribute(
    "data-public-theme",
    "light",
  );
  const eventNavigation = page
    .getByRole("navigation", { name: "Event navigation" })
    .first();
  await expect(
    eventNavigation.getByRole("link", { name: "Event home" }),
  ).toHaveAttribute("aria-current", "page");
  await expect(
    eventNavigation.getByRole("link", { name: "Programme" }),
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
  const headingSizes = await page
    .locator(".public-site-section-heading h2")
    .evaluateAll((headings) =>
      headings
        .filter((heading) => {
          const section = heading.closest(".public-site-section");
          return (
            !section?.classList.contains("public-site-introduction") &&
            !section?.classList.contains("public-site-statistics-section") &&
            !section?.classList.contains("is-credits")
          );
        })
        .map((heading) =>
          Number.parseFloat(getComputedStyle(heading).fontSize),
        ),
    );
  expect(headingSizes.length).toBeGreaterThan(1);
  for (const size of headingSizes) expect(size).toBeGreaterThanOrEqual(28);

  const statisticsBand = page.locator(".public-site-statistics-section");
  if (
    await statisticsBand.evaluate((element) =>
      element.classList.contains("is-quiet"),
    )
  ) {
    const glanceLine = page.locator(".public-site-glance-line");
    await expect(glanceLine).toContainText(/speakers/i);
    await expect(glanceLine).toContainText(/sessions/i);
  } else {
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
    expect(
      cssColourContrastRatio(statisticFigure.ink, glanceStop),
    ).toBeLessThan(15);
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
  }
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

  await expect(page.locator(".public-site-venue")).toHaveCount(1);
  await expect(page.locator(".public-venue")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Full programme" }),
  ).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect(page.locator(".public-shell")).toHaveScreenshot(
    "published-public-site-desktop.png",
  );
  const publishedHome = page.locator(".public-site-home");
  const hiddenHeader = await page.addStyleTag({
    content: ".public-top { visibility: hidden !important; }",
  });
  await expect(publishedHome).toHaveScreenshot("public-site-home-desktop.png");
  await page.locator(".public-shell").evaluate((element) => {
    element.setAttribute("data-public-theme", "dark");
  });
  await expect(publishedHome).toHaveScreenshot(
    "public-site-home-desktop-dark.png",
  );
  await page.locator(".public-shell").evaluate((element) => {
    element.setAttribute("data-public-theme", "light");
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
  const publishedColumnCounts = await homeColumnCounts(publishedHome);
  expect(publishedColumnCounts.features).toBeGreaterThanOrEqual(1);
  if ((await publishedHome.locator(".public-site-glance-line").count()) > 0) {
    expect(publishedColumnCounts.statistics).toBe(0);
  } else {
    expect(publishedColumnCounts.statistics).toBeGreaterThanOrEqual(2);
  }
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
    overflowing: false,
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

  await eventNavigation.getByLabel(/^Browse/u).click();
  await expect(eventNavigation.getByText("Programme views")).toBeVisible();
  await expect(eventNavigation.getByText("Event information")).toBeVisible();
  await eventNavigation.getByRole("link", { name: "FAQ", exact: true }).click();
  await expect(page).toHaveURL(
    /\/public\/programme\/future-of-events-2027\/pages\/faq$/u,
  );
  const publishedFaq = page
    .locator(".public-site-faq details")
    .filter({ hasText: "When and where does the conference take place?" });
  await publishedFaq.locator("summary").click();
  await expect(publishedFaq).toHaveAttribute("open", "");

  await eventNavigation.getByLabel(/^Browse/u).click();
  await eventNavigation.getByRole("link", { name: "About" }).click();
  await expect(page).toHaveURL(
    /\/public\/programme\/future-of-events-2027\/pages\/about$/u,
  );
  await expect(page.getByRole("heading", { name: "Who comes" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Programme", exact: true }),
  ).toHaveAttribute("href", "/public/programme/future-of-events-2027/sessions");
  await expectFixedPageOutline(page);
  const fixedPageResponse = await page.request.get(page.url());
  const fixedPageEtag = fixedPageResponse.headers().etag;
  expect(fixedPageResponse.headers()["cache-control"]).toContain("public");
  expect(fixedPageEtag).toBeTruthy();
  const notModified = await page.request.get(page.url(), {
    headers: { "if-none-match": fixedPageEtag },
  });
  expect(notModified.status()).toBe(304);

  await page.getByRole("link", { name: "Programme" }).first().click();
  await expect(page).toHaveURL(
    /\/public\/programme\/future-of-events-2027\/sessions$/u,
  );
  await expect(
    page.getByRole("link", { name: "Programme" }).first(),
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

  const socialCard = await page.request.get(
    "/public/programme/future-of-events-2027/social-card.webp",
  );
  expect(socialCard.ok()).toBe(true);
  expect(socialCard.headers()["content-type"]).toBe("image/webp");
});

test("organisers preview unpublished edits and publish a replacement", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await serveSponsorLogo(page);
  await page.goto("/admin/site");
  await page.locator("body[data-hydrated='true']").waitFor();
  await expect(
    page.getByRole("heading", { name: "Event website" }),
  ).toBeVisible();
  const tagline = page.locator(".public-site-rail-form").getByLabel("Tagline");
  await expect(tagline).toHaveValue("One destination for the whole event.");

  await tagline.fill("One destination for the event and every attendee.");
  await page.getByLabel("Theme").selectOption("dark");
  const firstSection = page.locator(".public-site-section-order > li").first();
  await firstSection.getByRole("button", { name: "Move down" }).focus();
  await page.keyboard.press("Enter");
  const featuredSpeakerSection = page
    .locator(".public-site-section-order > li")
    .first();
  await expect(featuredSpeakerSection).toContainText("Featured speakers");

  const featuredSpeakers = page
    .locator("fieldset.public-site-featured-picker")
    .filter({ has: page.locator("legend", { hasText: "Featured speakers" }) });
  await expect(featuredSpeakers).toContainText("Featured · 2 of 12");

  const featuredSessions = page
    .locator("fieldset.public-site-featured-picker")
    .filter({ has: page.locator("legend", { hasText: "Featured sessions" }) });
  await featuredSessions
    .getByLabel("Search available")
    .fill("Designing Inclusive Hybrid Experiences");
  await featuredSessions
    .locator(".public-site-featured-available > div")
    .filter({ hasText: "Designing Inclusive Hybrid Experiences" })
    .getByRole("button", { name: "Add" })
    .click();
  const selectedSessions = featuredSessions.locator(
    ".public-site-featured-selected > li",
  );
  await selectedSessions
    .filter({ hasText: "Designing Inclusive Hybrid Experiences" })
    .getByRole("button", { name: "Move up" })
    .click();
  await expect(selectedSessions.nth(1)).toContainText(
    "Designing Inclusive Hybrid Experiences",
  );
  await expect(featuredSessions).toContainText("Featured · 3 of 12");

  await expect(
    page.locator(".public-site-faq-editor > fieldset").first(),
  ).toBeHidden();
  await page
    .locator(".public-site-section-order > li")
    .filter({ hasText: "Frequently asked questions" })
    .getByRole("checkbox")
    .check();
  await openSiteCollection(page, "FAQ");
  /* The new question is appended, so it starts wherever the seeded baseline
     ends. Walking it to the top from there is what proves reordering works
     over a list the organiser did not just create. The count is read through
     an assertion so the row is in the DOM before it is addressed by index. */
  const faqQuestions = page.locator(".public-site-faq-editor > fieldset");
  const seededFaq = await faqQuestions.count();
  await page.getByRole("button", { name: "Add question" }).click();
  await expect(faqQuestions).toHaveCount(seededFaq + 1);
  await faqQuestions
    .nth(seededFaq)
    .getByLabel("Question")
    .fill("Priority question");
  const priorityAnswer = faqQuestions
    .nth(seededFaq)
    .getByRole("textbox", { name: "Answer" });
  await priorityAnswer.fill("Priority answer");
  await priorityAnswer.press("ControlOrMeta+a");
  await faqQuestions
    .nth(seededFaq)
    .getByRole("button", { name: "Bold" })
    .click();
  for (let position = seededFaq; position > 0; position -= 1) {
    await faqQuestions
      .nth(position)
      .getByRole("button", { name: "Move up" })
      .click();
    await expect(
      faqQuestions.nth(position - 1).getByLabel("Question"),
    ).toHaveValue("Priority question");
  }

  await openSiteCollection(page, "Event pages");
  const aboutPage = page
    .locator(".public-site-page-editor fieldset")
    .filter({ has: page.locator("legend", { hasText: "About" }) });
  await aboutPage.getByLabel("Publish this page with the site").check();
  await ensurePageContentOpen(aboutPage);
  const longAboutNavigationLabel = "A".repeat(40);
  await aboutPage.getByLabel("Navigation label").fill(longAboutNavigationLabel);
  const aboutContent = aboutPage.getByRole("textbox", {
    name: "Page content",
  });
  await aboutContent.fill("Why attend");
  const counterId = await aboutContent.getAttribute("aria-describedby");
  expect(counterId).toBeTruthy();
  const aboutCounter = aboutPage.locator(`[id="${counterId}"]`);
  await expect(aboutCounter).not.toHaveAttribute("aria-live");
  await aboutContent.press("End");
  await aboutContent.press("Enter");
  await aboutContent.type("Meet practitioners building better events.");
  await expect(aboutContent.locator("p")).toHaveCount(2);
  await expect(aboutContent.locator("p").first()).toHaveText("Why attend");
  await aboutContent.locator("p").first().click();
  await aboutPage.getByRole("button", { name: "Subheading" }).click();
  await expect(aboutCounter).toContainText("57 of 8,000 characters");
  await expect(aboutContent.locator("h2")).toHaveText("Why attend");
  await expect(aboutContent.locator("p")).toHaveText(
    "Meet practitioners building better events.",
  );
  await aboutContent.locator("p").click();
  await aboutContent.press("End");
  for (let character = 0; character < "events.".length; character += 1)
    await aboutContent.press("Shift+ArrowLeft");
  await aboutPage.getByRole("button", { name: "Link" }).click();
  const linkSettings = aboutPage.getByRole("group", {
    name: "Link settings",
  });
  const linkInput = linkSettings.getByLabel("HTTPS link");
  await linkInput.fill("https://example.test/events");
  await linkSettings.getByRole("button", { name: "Apply link" }).click();
  const sponsorsPage = page
    .locator(".public-site-page-editor fieldset")
    .filter({ has: page.locator("legend", { hasText: "Sponsors" }) });
  await sponsorsPage.getByLabel("Publish this page with the site").check();
  await ensurePageContentOpen(sponsorsPage);
  const longSponsorsNavigationLabel = "S".repeat(40);
  await sponsorsPage
    .getByLabel("Navigation label")
    .fill(longSponsorsNavigationLabel);
  const sponsorsContent = sponsorsPage.getByRole("textbox", {
    name: "Page content",
  });
  const sponsorsCharacterStatus = sponsorsPage
    .locator(".public-site-rich-text-field")
    .locator('.sr-only[aria-live="polite"]');
  await sponsorsContent.fill("A".repeat(8_001));
  await expect(sponsorsCharacterStatus).toHaveText(
    "Character limit exceeded. Shorten this content before saving.",
  );
  await sponsorsContent.fill(
    "Thanks to the organisations supporting this event.",
  );
  await expect(sponsorsCharacterStatus).toBeEmpty();
  await sponsorsContent.press("ControlOrMeta+a");
  const sponsorsLinkButton = sponsorsPage.getByRole("button", { name: "Link" });
  await sponsorsLinkButton.focus();
  await sponsorsLinkButton.press("Enter");
  const sponsorsLinkInput = sponsorsPage.getByLabel("HTTPS link");
  await expect(sponsorsLinkInput).toBeFocused();
  await sponsorsLinkInput.press("Escape");
  await expect(sponsorsLinkInput).toBeHidden();
  /* Every page ships enabled in the baseline, so one is switched off here to
     exercise the preview's "not enabled" notice below. */
  const codeOfConductPage = page
    .locator(".public-site-page-editor fieldset")
    .filter({ has: page.locator("legend", { hasText: "Code of conduct" }) });
  await codeOfConductPage
    .getByLabel("Publish this page with the site")
    .uncheck();

  await page
    .getByRole("complementary", { name: "Primary navigation" })
    .getByRole("link", { name: "Speakers", exact: true })
    .click();
  const unsavedDialog = page.getByRole("dialog", {
    name: "Leave without saving the event website?",
  });
  await expect(unsavedDialog).toBeVisible();
  await unsavedDialog.getByRole("button", { name: "Keep editing" }).click();
  await expect(unsavedDialog).toBeHidden();
  await expect(page).toHaveURL(/\/admin\/site$/u);
  await expect(tagline).toHaveValue(
    "One destination for the event and every attendee.",
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
  await expect(
    page
      .locator(".public-site-preview-frame")
      .getByRole("link", { name: "events." }),
  ).toHaveAttribute("href", "https://example.test/events");
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
  expect(previewColumnCounts.features).toBeGreaterThanOrEqual(1);
  if ((await previewFrame.locator(".public-site-glance-line").count()) > 0) {
    expect(previewColumnCounts.statistics).toBe(0);
  } else {
    expect(previewColumnCounts.statistics).toBe(2);
  }
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
  await expect(previewFaq.locator("strong")).toHaveText("Priority answer");
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
  await openSiteCollection(page, "Sponsors");
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

  await openSiteCollection(page, "Sponsors");
  await page.getByLabel("New sponsor name").fill("Example Partner");
  const newSponsor = page
    .locator("form.public-site-record-editor")
    .filter({ has: page.getByLabel("New sponsor name") });
  await newSponsor.getByLabel("Tier").fill("Community");
  await newSponsor
    .getByLabel("Website URL")
    .fill("https://example.com/partner");
  /* The showcase fixture's organisations are fictional, so none of them carries
     a logo and the published homepage always renders the strip's other state —
     the typographic credits lockup. A logo here is the only place the mark
     layout is exercised in a browser at all. The route registered before the
     editor opened serves the bytes, so this reaches the layout a decoded image
     produces rather than the one a broken `src` leaves behind, and no request
     leaves the machine. */
  await newSponsor.getByLabel("Logo URL").fill(SPONSOR_LOGO_URL);
  await newSponsor.getByRole("button", { name: "Add sponsor" }).click();
  await expect(
    page.getByText("Sponsor saved to the website draft."),
  ).toBeVisible();

  await page.getByRole("button", { name: "Publish event website" }).click();
  const confirmation = page.getByRole("dialog", {
    name: "Publish the event website?",
  });
  await expect(confirmation).toContainText("Sponsors added: Example Partner");
  await expect(confirmation).toContainText(
    "Featured sessions added: Designing Inclusive Hybrid Experiences",
  );
  await expect(confirmation).toContainText("Theme: Light → Dark");
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
  await expect(
    page.locator(".public-site-sponsor-grid strong", {
      hasText: "Example Partner",
    }),
  ).toBeVisible();
  await expect(
    page.locator(".public-site-sponsor-grid strong", {
      hasText: "Northstar Events",
    }),
  ).toBeVisible();
  /* One sponsor carrying a mark takes the whole strip out of the credits
     lockup, because a band of names ruled for typography is not the layout a
     row of logos needs. The link follows the sponsor's own site rather than
     this event's sponsors page once there is a site to follow. */
  await expect(page.locator(".public-site-sponsor-strip")).not.toHaveClass(
    /is-credits/u,
  );
  const stripMark = page.locator(".public-site-sponsor-grid img");
  await expect(stripMark).toHaveAttribute("src", SPONSOR_LOGO_URL);
  /* The bytes decoded, and the strip scaled the mark into its 36px cap with the
     aspect kept — 120x40 lands at 108x36. That is the laid-out logo rather than
     a broken `src`, which would occupy no space at all. */
  expect(
    await stripMark.evaluate((image: HTMLImageElement) => {
      const box = image.getBoundingClientRect();
      return {
        decoded: `${image.naturalWidth}x${image.naturalHeight}`,
        rendered: `${Math.round(box.width)}x${Math.round(box.height)}`,
      };
    }),
  ).toEqual({ decoded: "120x40", rendered: "108x36" });
  await expect(
    page.locator(".public-site-sponsor-grid a").filter({
      hasText: "Example Partner",
    }),
  ).toHaveAttribute("href", "https://example.com/partner");
  await expect(page.getByText("Priority question")).toBeVisible();
  await expect(page.locator(".public-shell")).toHaveAttribute(
    "data-public-theme",
    "dark",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await homeColumnCounts(page.locator(".public-site-home"))).toEqual(
    previewColumnCounts,
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  const eventNavigation = page
    .getByRole("navigation", { name: "Event navigation" })
    .first();
  await expect(
    page.getByRole("link", {
      name: "The Future of Attendee Engagement",
    }),
  ).toHaveAttribute(
    "href",
    "/public/programme/future-of-events-2027/sessions?session=demo-session-1",
  );
  await expect(
    page.getByRole("link", {
      name: "Designing Inclusive Hybrid Experiences",
    }),
  ).toBeVisible();
  expect(
    await page
      .locator(".public-shell")
      .evaluate((element) =>
        getComputedStyle(element).getPropertyValue("--event-accent").trim(),
      ),
  ).toBe(previewAccent);

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
  await expect(page.getByRole("link", { name: "Programme" })).toHaveAttribute(
    "href",
    "/public/programme/future-of-events-2027/sessions",
  );
  const fixedPageResponse = await page.request.get(page.url());
  const fixedPageEtag = fixedPageResponse.headers().etag;
  expect(fixedPageResponse.headers()["cache-control"]).toContain("public");
  expect(fixedPageEtag).toBeTruthy();
  const notModified = await page.request.get(page.url(), {
    headers: { "if-none-match": fixedPageEtag },
  });
  expect(notModified.status()).toBe(304);

  const pageNavigation = page
    .getByRole("navigation", { name: "Event navigation" })
    .first();
  await pageNavigation.getByLabel(/^Browse/).click();
  await pageNavigation
    .getByRole("link", { name: longSponsorsNavigationLabel })
    .click();
  await expect(
    page.getByRole("heading", { name: "Community", exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Example Partner")).toBeVisible();
  const communitySponsors = page.locator(".public-site-sponsor-tier").filter({
    has: page.getByRole("heading", { name: "Community", exact: true }),
  });
  await expect(communitySponsors.getByRole("list")).toBeVisible();
  await expect(communitySponsors.getByRole("listitem")).toHaveCount(1);
  /* A sponsor entry carries the mark, the name and the way out to the sponsor's
     own site. The seeded organisations supply none of the two optional fields,
     so this is where the complete entry is rendered. */
  const markedSponsor = page.locator(".public-site-sponsor-card").filter({
    hasText: "Example Partner",
  });
  const cardMark = markedSponsor.locator("img");
  await expect(cardMark).toHaveAttribute("src", SPONSOR_LOGO_URL);
  /* The page card allows a larger mark than the strip, so the same image sits
     at its intrinsic size here instead of being scaled down. */
  expect(
    await cardMark.evaluate((image: HTMLImageElement) => {
      const box = image.getBoundingClientRect();
      return {
        decoded: `${image.naturalWidth}x${image.naturalHeight}`,
        rendered: `${Math.round(box.width)}x${Math.round(box.height)}`,
      };
    }),
  ).toEqual({ decoded: "120x40", rendered: "120x40" });
  await expect(
    markedSponsor.getByRole("link", { name: "Visit sponsor" }),
  ).toHaveAttribute("href", "https://example.com/partner");
  await expectFixedPageOutline(page);

  await page.goto("/admin/site");
  await openSiteCollection(page, "Event pages");
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
  await openSiteCollection(page, "Sponsors");
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
  await expect(replacement).toContainText(
    "Pages removed: About the conference, Partners and sponsors",
  );
  await expect(replacement).toContainText("Sponsors removed: Example Partner");
});

test("organisers first-publish a bounded site on a blank event", async ({
  page,
}) => {
  test.setTimeout(180_000);
  await page.context().addCookies([
    {
      name: "program_cue_demo_identity",
      value: "owner",
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    },
  ]);
  const unique = Date.now();
  const slug = `first-publish-site-${unique}`;
  await page.goto("/admin/events/new");
  await page.locator("body[data-hydrated='true']").waitFor();
  await expect(page.getByRole("heading", { name: "New event" })).toBeVisible();
  await page.getByLabel("Event name").fill(`First publish site ${unique}`);
  await page.getByLabel("Public slug").fill(slug);
  await page.getByRole("button", { name: "Create blank event" }).click();
  await acceptConfirm(page);
  await expect(page.getByText("Event created", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open new event" }).click();
  await expect(page.locator(".event-switcher strong")).toHaveText(
    `First publish site ${unique}`,
  );

  await page.goto("/admin/event");
  await page.getByLabel("Venue", { exact: true }).fill("Civic Hall");
  await page.getByLabel("City", { exact: true }).fill("Toronto");
  await page.getByLabel("Venue address").fill("100 Queen Street West, Toronto");
  await page
    .getByLabel("Programme description")
    .fill(
      "A new event used to compose the public website from an empty draft.",
    );
  await page.getByRole("button", { name: "Save event" }).click();
  await expect(
    page.getByText("Event settings saved.", { exact: true }),
  ).toBeVisible();

  await page.goto("/admin/site");
  await expect(page.getByLabel("Publication status")).toContainText(
    "Not published",
  );
  await expect(
    page.getByRole("button", { name: "Create website draft" }),
  ).toBeVisible();
  await page.getByLabel("Tagline").fill("A first public homepage.");
  await page
    .locator(".public-site-section-order > li")
    .filter({ hasText: "Programme statistics" })
    .getByRole("checkbox")
    .uncheck();
  await page
    .locator(".public-site-section-order > li")
    .filter({ hasText: "Frequently asked questions" })
    .getByRole("checkbox")
    .check();
  await openSiteCollection(page, "FAQ");
  await page.getByRole("button", { name: "Add question" }).click();
  const faq = page.locator(".public-site-faq-editor > fieldset").first();
  await faq.getByLabel("Question").fill("When does registration open?");
  await faq
    .getByRole("textbox", { name: "Answer" })
    .fill("The organiser will publish dates here.");
  await openSiteCollection(page, "Event pages");
  const aboutPage = page
    .locator(".public-site-page-editor fieldset")
    .filter({ has: page.locator("legend", { hasText: "About" }) });
  await aboutPage.getByLabel("Publish this page with the site").check();
  await ensurePageContentOpen(aboutPage);
  await aboutPage
    .getByRole("textbox", { name: "Page content" })
    .fill("This site was published before a programme existed.");
  const sponsorsPage = page
    .locator(".public-site-page-editor fieldset")
    .filter({ has: page.locator("legend", { hasText: "Sponsors" }) });
  await sponsorsPage.getByLabel("Publish this page with the site").check();
  await page.getByRole("button", { name: "Create website draft" }).click();
  await expect(
    page.getByText("Website draft saved. Public pages are unchanged."),
  ).toBeVisible();

  await openSiteCollection(page, "Sponsors");
  await page.getByLabel("New sponsor name").fill("Civic Partner");
  const newSponsor = page
    .locator("form.public-site-record-editor")
    .filter({ has: page.getByLabel("New sponsor name") });
  await newSponsor.getByLabel("Tier").fill("Community");
  await newSponsor.getByRole("button", { name: "Add sponsor" }).click();
  await expect(
    page.getByText("Sponsor saved to the website draft."),
  ).toBeVisible();

  await page.getByRole("button", { name: "Publish event website" }).click();
  const confirmation = page.getByRole("dialog", {
    name: "Publish the event website?",
  });
  await expect(confirmation.locator(".pc-confirm-count")).toHaveCount(0);
  await expect(confirmation).toContainText("Pages added: About, Sponsors");
  await expect(confirmation).toContainText("Sponsors added: Civic Partner");
  await expect(confirmation).toContainText("Theme: Follow visitor system");
  await expect(confirmation).toContainText(
    "Editorial homepage content will be published.",
  );
  await confirmation
    .getByRole("button", { name: "Publish event website" })
    .click();
  await expect(page.getByText("Event website published.")).toBeVisible();

  await page.goto(`/public/programme/${slug}`);
  await expect(page.getByText("A first public homepage.")).toBeVisible();
  await expect(page.getByText("Civic Partner")).toBeVisible();
  await expect(page.getByText("When does registration open?")).toBeVisible();
  const eventNavigation = page
    .getByRole("navigation", { name: "Event navigation" })
    .first();
  await eventNavigation.getByLabel(/^Browse/).click();
  await expect(
    eventNavigation.getByRole("link", { name: "About" }),
  ).toBeVisible();
});

test("draft preview stays in its column and does not cover promotion", async ({
  page,
}) => {
  await page.goto("/admin/site");
  await expect(
    page.getByRole("heading", { name: "Draft preview" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Announcement handoff" }),
  ).toBeVisible();

  const stack = page.locator(".public-site-preview-stack");
  const preview = page.locator(".public-site-preview");
  await expect
    .poll(() => stack.evaluate((element) => getComputedStyle(element).position))
    .toBe("sticky");
  await expect
    .poll(() =>
      preview.evaluate((element) => getComputedStyle(element).position),
    )
    .not.toBe("sticky");

  await openSiteCollection(page, "Sponsors");
  await openSiteCollection(page, "Session recordings");
  await page
    .locator(".public-site-editor-stack")
    .getByRole("heading", { name: "Session recordings" })
    .scrollIntoViewIfNeeded();

  await expect(
    page.getByRole("heading", { name: "Draft preview" }),
  ).toBeInViewport();

  const overlap = await page.evaluate(() => {
    const previewCard = document.querySelector(".public-site-preview");
    const promotion = document.querySelector(".public-site-promotion");
    if (
      !(previewCard instanceof HTMLElement) ||
      !(promotion instanceof HTMLElement)
    ) {
      return true;
    }
    const a = previewCard.getBoundingClientRect();
    const b = promotion.getBoundingClientRect();
    return (
      a.right > b.left + 1 &&
      a.left < b.right - 1 &&
      a.bottom > b.top + 1 &&
      a.top < b.bottom - 1
    );
  });
  expect(overlap).toBe(false);

  await page
    .getByRole("heading", { name: "Announcement handoff" })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole("heading", { name: "Announcement handoff" }),
  ).toBeInViewport();
});
