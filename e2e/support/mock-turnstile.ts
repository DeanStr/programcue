import type { Page } from "@playwright/test";

type ApplicationTurnstileAction =
  | "application_request_code"
  | "application_start_anonymous"
  | "application_verify_code";

type MockTurnstileOptions = {
  appearance: string;
  callback(token: string): void;
};

function withMockSiteKeyPayload(payload: string) {
  const flattened = JSON.parse(payload) as unknown[];
  const keyIndex = flattened.indexOf("turnstileSiteKey");
  if (keyIndex < 0) throw new Error("Turnstile loader field not found.");
  const loaderData = flattened.find(
    (value): value is Record<string, unknown> =>
      typeof value === "object" &&
      value !== null &&
      Object.hasOwn(value, `_${keyIndex}`),
  );
  if (!loaderData) throw new Error("Application loader record not found.");

  flattened.push("test-turnstile-site-key");
  loaderData[`_${keyIndex}`] = flattened.length - 1;
  return JSON.stringify(flattened);
}

function withMockSiteKey(document: string) {
  const marker = "window.__reactRouterContext.streamController.enqueue(";
  const argumentStart = document.indexOf(marker) + marker.length;
  const argumentEnd = document.indexOf(");</script>", argumentStart);
  if (argumentStart < marker.length || argumentEnd < 0)
    throw new Error("Application loader payload not found.");

  const payload = JSON.parse(
    document.slice(argumentStart, argumentEnd),
  ) as string;
  const replacement = JSON.stringify(withMockSiteKeyPayload(payload));
  return `${document.slice(0, argumentStart)}${replacement}${document.slice(argumentEnd)}`;
}

export async function installApplicationTurnstileMock(page: Page) {
  await page.route("**/apply/form", async (route) => {
    if (route.request().resourceType() !== "document") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: withMockSiteKey(await response.text()),
    });
  });
  await page.route("**/apply/form.data*", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    await route.fulfill({
      response,
      body: withMockSiteKeyPayload(await response.text()),
    });
  });
  await page.route(
    "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit",
    async (route) => {
      await route.fulfill({
        contentType: "application/javascript",
        body: `window.turnstile = {
          render: (_container, options) => {
            (window.__programCueTurnstile ||= {})[options.action] = options;
            return options.action;
          },
          reset: () => {},
          remove: () => {}
        };`,
      });
    },
  );
}

export async function waitForApplicationTurnstileActions(
  page: Page,
  actions: ApplicationTurnstileAction[],
) {
  await page.waitForFunction((expectedActions) => {
    const harness = (
      window as unknown as {
        __programCueTurnstile?: Record<string, MockTurnstileOptions>;
      }
    ).__programCueTurnstile;
    return Boolean(
      harness && expectedActions.every((action) => action in harness),
    );
  }, actions);
}

export async function applicationTurnstileAppearances(page: Page) {
  return page.evaluate(() => {
    const harness = (
      window as unknown as {
        __programCueTurnstile?: Record<string, MockTurnstileOptions>;
      }
    ).__programCueTurnstile;
    if (!harness) throw new Error("Turnstile browser mock was not installed.");
    return Object.fromEntries(
      Object.entries(harness).map(([action, options]) => [
        action,
        options.appearance,
      ]),
    );
  });
}

export async function completeApplicationTurnstile(
  page: Page,
  action: ApplicationTurnstileAction,
  token: string,
) {
  await page.evaluate(
    ({ actionName, tokenValue }) => {
      const harness = (
        window as unknown as {
          __programCueTurnstile?: Record<string, MockTurnstileOptions>;
        }
      ).__programCueTurnstile;
      const options = harness?.[actionName];
      if (!options)
        throw new Error(`Turnstile action ${actionName} not found.`);
      options.callback(tokenValue);
    },
    { actionName: action, tokenValue: token },
  );
}
