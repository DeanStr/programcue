import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CalendarProviderRequestError } from "~/modules/calendars/calendar-providers.server";
import { calendarOAuthCallbackFailure } from "~/modules/calendars/calendar-oauth-callback.server";

afterEach(() => vi.restoreAllMocks());

describe("calendar OAuth callback failures", () => {
  it("logs bounded provider identity without logging the raw provider error", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const providerDetail = "provider-secret-response-detail";

    const response = calendarOAuthCallbackFailure(
      new CalendarProviderRequestError("google", 401, providerDetail),
      env as unknown as CloudflareEnvironment,
      "event-calendar-log-test",
    );

    expect(response.status).toBe(502);
    await expect(response.text()).resolves.not.toContain(providerDetail);
    expect(log).toHaveBeenCalledOnce();
    const serialized = String(log.mock.calls[0]?.[0]);
    expect(serialized).toContain('"subsystem":"calendar-oauth"');
    expect(serialized).toContain('"provider":"google"');
    expect(serialized).toContain('"errorName":"CalendarProviderRequestError"');
    expect(serialized).not.toContain(providerDetail);
  });
});
