import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CalendarOAuthUnexpectedError,
  CalendarProviderRequestError,
} from "~/modules/calendars/calendar-providers.server";
import { calendarOAuthCallbackFailure } from "~/modules/calendars/calendar-oauth-callback.server";

afterEach(() => vi.restoreAllMocks());

describe("calendar OAuth callback failures", () => {
  it.each(["google", "microsoft"] as const)(
    "logs bounded %s identity without logging the raw provider error",
    async (provider) => {
      const log = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const providerDetail = "provider-secret-response-detail";

      const response = calendarOAuthCallbackFailure(
        new CalendarProviderRequestError(provider, 401, providerDetail),
        env as unknown as CloudflareEnvironment,
        "event-calendar-log-test",
      );

      expect(response.status).toBe(502);
      await expect(response.text()).resolves.not.toContain(providerDetail);
      expect(log).toHaveBeenCalledOnce();
      const serialized = String(log.mock.calls[0]?.[0]);
      expect(serialized).toContain('"subsystem":"calendar-oauth"');
      expect(serialized).toContain(`"provider":"${provider}"`);
      expect(serialized).toContain(
        '"errorName":"CalendarProviderRequestError"',
      );
      expect(serialized).not.toContain(providerDetail);
    },
  );

  it("logs a bounded unexpected callback phase without logging its cause", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sensitiveCause = "database-provider-secret-detail";

    const response = calendarOAuthCallbackFailure(
      new CalendarOAuthUnexpectedError(
        "google",
        "connection-persistence",
        new Error(sensitiveCause),
      ),
      env as unknown as CloudflareEnvironment,
      "event-calendar-log-test",
    );

    expect(response.status).toBe(500);
    await expect(response.text()).resolves.not.toContain(sensitiveCause);
    expect(log).toHaveBeenCalledOnce();
    const serialized = String(log.mock.calls[0]?.[0]);
    expect(serialized).toContain('"provider":"google"');
    expect(serialized).toContain('"phase":"connection-persistence"');
    expect(serialized).toContain('"errorName":"CalendarOAuthUnexpectedError"');
    expect(serialized).not.toContain(sensitiveCause);
  });
});
