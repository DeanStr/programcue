import type { Page } from "@playwright/test";

type ApplicationTurnstileAction =
  | "application_request_code"
  | "application_start_anonymous"
  | "application_verify_code";

type MockTurnstileOptions = {
  appearance: string;
  callback(token: string): void;
};

export async function installApplicationTurnstileMock(page: Page) {
  await page.setExtraHTTPHeaders({
    "x-program-cue-e2e-turnstile": "true",
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
