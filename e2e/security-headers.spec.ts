import { expect, test } from "@playwright/test";

test("a per-response CSP nonce authorises hydration without inline-script fallback", async ({
  page,
}) => {
  await page.addInitScript(() => {
    const violations: string[] = [];
    Object.assign(window, { __programCueCspViolations: violations });
    document.addEventListener("securitypolicyviolation", (event) => {
      violations.push(`${event.effectiveDirective}:${event.blockedURI}`);
    });
  });

  const response = await page.goto("/admin/review");
  expect(response?.ok()).toBe(true);
  await page.locator("body[data-hydrated='true']").waitFor();

  const policy = response?.headers()["content-security-policy"] ?? "";
  const nonce = policy.match(/script-src[^;]*'nonce-([A-Za-z0-9_-]+)'/u)?.[1];
  expect(nonce).toMatch(/^[A-Za-z0-9_-]{16,128}$/u);
  expect(policy).not.toContain("script-src 'self' 'unsafe-inline'");
  expect(policy).toContain("script-src-attr 'none'");

  const inlineNonces = await page
    .locator("script:not([src])")
    .evaluateAll((scripts) =>
      scripts.map((script) => (script as HTMLScriptElement).nonce),
    );
  expect(inlineNonces.length).toBeGreaterThan(0);
  expect(new Set(inlineNonces)).toEqual(new Set([nonce]));
  const violations = await page.evaluate(
    () =>
      (
        window as typeof window & {
          __programCueCspViolations?: string[];
        }
      ).__programCueCspViolations ?? [],
  );
  // Playwright's injected selector/evaluation utility probes `eval`; the CSP
  // correctly blocks that probe. It is not application script execution.
  expect(
    violations.filter((violation) => violation !== "script-src:eval"),
  ).toEqual([]);

  const nextResponse = await page.request.get("/admin/review");
  const nextPolicy = nextResponse.headers()["content-security-policy"] ?? "";
  const nextNonce = nextPolicy.match(
    /script-src[^;]*'nonce-([A-Za-z0-9_-]+)'/u,
  )?.[1];
  expect(nextNonce).toMatch(/^[A-Za-z0-9_-]{16,128}$/u);
  expect(nextNonce).not.toBe(nonce);
});
