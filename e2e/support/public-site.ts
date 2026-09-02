import { expect, type Locator, type Page } from "@playwright/test";

const SITE_PANELS = {
  Homepage: "Homepage and appearance",
  Pages: "Event pages",
  Sponsors: "Sponsors",
  Recordings: "Session recordings",
} as const;

export async function openSitePanel(page: Page, tab: keyof typeof SITE_PANELS) {
  await page
    .locator(".public-site-editor-tabs button")
    .filter({ hasText: new RegExp(`^${tab}`) })
    .click();
  await expect(
    page.getByRole("region", { name: SITE_PANELS[tab] }),
  ).toBeVisible();
}

async function openDisclosure(disclosure: Locator) {
  if (!(await disclosure.evaluate((element) => element.hasAttribute("open")))) {
    await disclosure.locator(":scope > summary").click();
  }
  await expect
    .poll(async () =>
      disclosure.evaluate((element) => element.hasAttribute("open")),
    )
    .toBe(true);
  return disclosure;
}

export async function openHomepageSection(page: Page, label: string) {
  await openSitePanel(page, "Homepage");
  return openDisclosure(
    page
      .locator(".public-site-section-row")
      .filter({ hasText: label })
      .locator("details.public-site-section-editor"),
  );
}

export async function openSiteRecord(page: Page, name: string) {
  return openDisclosure(
    page.locator("details.public-site-record-disclosure").filter({
      has: page.locator("summary strong", {
        hasText: new RegExp(`^${name}$`),
      }),
    }),
  );
}

export async function ensurePageContentOpen(editor: Locator) {
  const pageContent = editor.getByRole("textbox", { name: "Page content" });
  if (await pageContent.isVisible()) return;
  await editor.locator(":scope > details > summary").click();
  await expect(pageContent).toBeVisible();
}

export async function paintedColours(locator: Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return { ink: style.color, background: style.backgroundColor };
  });
}

export async function resolvedColorMix(locator: Locator, mix: string) {
  return locator.evaluate((element, value) => {
    const probe = document.createElement("span");
    probe.style.backgroundColor = value;
    element.appendChild(probe);
    const color = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return color;
  }, mix);
}

export async function expectFixedPageOutline(page: Page) {
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

export const SPONSOR_LOGO_URL = "https://example.com/partner-logo.png";
const SPONSOR_LOGO_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAHgAAAAoCAYAAAA16j4lAAAAWklEQVR42u3RQREAAAQAQYlU8Ne/" +
    "DzmYfVyB28iu0d/CBMACLMACLMACLMCABViABViABViAAQuwAAuwAAuwAAswYAEWYAEWYAEWYMAC" +
    "LMACLMACLMCABVg3W7uWFmEIQ/JRAAAAAElFTkSuQmCC",
  "base64",
);

export async function serveSponsorLogo(page: Page) {
  await page.route(SPONSOR_LOGO_URL, (route) =>
    route.fulfill({ contentType: "image/png", body: SPONSOR_LOGO_PNG }),
  );
}

export async function homeColumnCounts(home: Locator) {
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
