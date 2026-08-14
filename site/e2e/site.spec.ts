import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const PUBLISHED_PAGES = ["/", "/privacy", "/terms"] as const;

async function openReady(page: Page, path: string) {
  const response = await page.goto(path);
  expect(response?.status(), `${path} should answer successfully`).toBe(200);
  await page.evaluate(() => document.fonts.ready);
}

async function expectContained(page: Page, label: string) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(
    dimensions.scrollWidth,
    `${label} should not overflow the viewport`,
  ).toBeLessThanOrEqual(dimensions.clientWidth);
}

test(
  "published pages and the account journey are reachable",
  { tag: "@single-viewport" },
  async ({ page }) => {
    for (const path of PUBLISHED_PAGES) {
      await openReady(page, path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    }

    await openReady(page, "/");
    const accountAction = page
      .getByRole("link", { name: "Sign in or create an account" })
      .first();
    await expect(accountAction).toHaveAttribute(
      "href",
      "https://app.programcue.com/sign-in",
    );
    await expect(page.getByText("Illustrative event workspace")).toBeVisible();
  },
);

test(
  "the local Worker enforces the static-site security contract",
  { tag: "@single-viewport" },
  async ({ page, request }) => {
    const response = await page.goto("/");
    const policy = response?.headers()["content-security-policy"] ?? "";
    expect(policy).toContain("script-src 'none'");
    expect(policy).toContain("connect-src 'none'");
    expect(response?.headers()["set-cookie"]).toBeUndefined();
    await expect(page.locator("script")).toHaveCount(0);

    const writeResponse = await request.post("/", { data: "not allowed" });
    expect(writeResponse.status()).toBe(405);
    expect(writeResponse.headers().allow).toBe("GET, HEAD");
  },
);

test(
  "the official favicon retains its adaptive brand colours",
  { tag: "@single-viewport" },
  async ({ page }) => {
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await openReady(page, "/brand-mark.svg");
      await expect(page.locator(".ink").first()).toHaveCSS(
        "fill",
        scheme === "dark" ? "rgb(249, 250, 251)" : "rgb(17, 24, 39)",
      );
      await expect(page.locator(".accent")).toHaveCSS(
        "fill",
        scheme === "dark" ? "rgb(129, 140, 248)" : "rgb(79, 70, 229)",
      );
    }
  },
);

test("public pages have no detectable WCAG A or AA violations", async ({
  page,
}) => {
  for (const path of [...PUBLISHED_PAGES, "/missing"]) {
    const response = await page.goto(path);
    expect(response?.status()).toBe(path === "/missing" ? 404 : 200);
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
      .analyze();
    expect(
      result.violations,
      `${path} accessibility violations:\n${result.violations
        .map((violation) => `${violation.id}: ${violation.help}`)
        .join("\n")}`,
    ).toEqual([]);
  }
});

test("responsive documents remain contained", async ({ page }, testInfo) => {
  for (const path of [...PUBLISHED_PAGES, "/missing"]) {
    await page.goto(path);
    await expectContained(page, `${path} in ${testInfo.project.name}`);
  }

  if (testInfo.project.name === "site-mobile-chromium") {
    await page.setViewportSize({ width: 320, height: 568 });
    for (const path of PUBLISHED_PAGES) {
      await page.goto(path);
      await expectContained(page, `${path} at 320 CSS pixels`);
    }
  }
});

test(
  "keyboard visitors can skip directly to the page content",
  { tag: "@single-viewport" },
  async ({ page }) => {
    await openReady(page, "/");
    await page.keyboard.press("Tab");
    const skipLink = page.getByRole("link", { name: "Skip to main content" });
    await expect(skipLink).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/#main$/);
  },
);

test("homepage retains its responsive marketing hierarchy", async ({
  page,
}) => {
  await openReady(page, "/");
  await expect(page.locator("body")).toHaveScreenshot("public-home.png");
  await expectContained(page, "public homepage visual");
});

test("privacy introduction and contents remain readable", async ({ page }) => {
  await openReady(page, "/privacy");
  await expect(page.locator(".page-head")).toHaveScreenshot(
    "public-privacy.png",
  );
  await expect(page.locator(".contents")).toHaveScreenshot(
    "public-privacy-contents.png",
  );
  await expectContained(page, "public privacy visual");
});
