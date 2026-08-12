import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CalendarOAuthUnexpectedError,
  CalendarProviderRequestError,
} from "~/modules/calendars/calendar-providers.server";
import {
  CALENDAR_OAUTH_COOKIE,
  calendarOAuthCallbackFailure,
} from "~/modules/calendars/calendar-oauth-callback.server";
import { CalendarOAuthService } from "~/modules/calendars/calendar-oauth.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { loader as callbackLoader } from "./calendar-oauth-callback";
import { loader as startLoader } from "./calendar-oauth-start";

const workerEnv = env as unknown as CloudflareEnvironment;

function context() {
  const value = new RouterContextProvider();
  value.set(cloudflareContext, {
    env: workerEnv,
    ctx: {} as ExecutionContext,
  });
  return value;
}

const submitterCookie =
  "program_cue_demo_identity=submitter; program_cue_event=evt-foe-2025";

afterEach(() => vi.restoreAllMocks());

describe("calendar OAuth callback failures", () => {
  it("allows an accepted participant through calendar OAuth start and callback", async () => {
    await ensureDemoData(workerEnv);
    const start = vi
      .spyOn(CalendarOAuthService.prototype, "start")
      .mockResolvedValue({
        authorizationUrl: "https://accounts.example.com/authorize",
        nonce: "submitter-calendar-nonce",
        expiresAt: Math.floor(Date.now() / 1_000) + 600,
      });
    const started = await startLoader({
      request: new Request("http://localhost/oauth/calendar/google", {
        headers: { cookie: submitterCookie },
      }),
      params: { provider: "google" },
      context: context(),
    });
    expect(started.status).toBe(302);
    expect(started.headers.get("location")).toBe(
      "https://accounts.example.com/authorize",
    );
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({ personId: "person-demo-submitter" }),
      "google",
      "/participant/dashboard",
    );

    vi.spyOn(CalendarOAuthService.prototype, "callback").mockResolvedValue({
      provider: "google",
      account: "submitter@example.com",
      returnTo: "/participant/dashboard",
    });
    const callback = await callbackLoader({
      request: new Request(
        "http://localhost/oauth/calendar/callback?state=state&code=code",
        {
          headers: {
            cookie: `${submitterCookie}; ${CALENDAR_OAUTH_COOKIE}=submitter-calendar-nonce`,
          },
        },
      ),
      context: context(),
    });
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toBe(
      "/participant/dashboard?calendarConnected=google&account=submitter%40example.com",
    );
  });

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
