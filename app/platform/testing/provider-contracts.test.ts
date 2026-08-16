import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { GoogleCalendarProvider } from "~/modules/calendars/calendar-providers.server";
import { TRACKED_DELIVERY_EMAIL_TAG } from "~/modules/communications/email-provider";
import {
  createEmailProvider,
  requireEmailProviderConfiguration,
} from "~/modules/communications/email-provider.server";
import { ResendEmailProvider } from "~/modules/communications/resend.server";

const server = setupServer();

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const emailInput = {
  from: "Program Cue <events@example.com>",
  replyTo: "reply@example.com",
  to: "speaker@example.com",
  subject: "Your programme invitation",
  html: "<p>Your invitation</p>",
  text: "Your invitation",
  idempotencyKey: "calendar:session-1:speaker-1:0",
  tags: [TRACKED_DELIVERY_EMAIL_TAG],
  attachments: [
    {
      filename: "program-cue-invitation.ics",
      content: "BEGIN:VCALENDAR\r\nMETHOD:REQUEST\r\nEND:VCALENDAR\r\n",
      contentType: "text/calendar; charset=utf-8; method=REQUEST",
    },
  ],
};

describe("provider HTTP contracts through MSW", () => {
  it("sends the Resend idempotency header and attachment contract", async () => {
    server.use(
      http.post("https://api.resend.com/emails", async ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer resend-key");
        expect(request.headers.get("idempotency-key")).toBe(
          emailInput.idempotencyKey,
        );
        await expect(request.json()).resolves.toMatchObject({
          from: emailInput.from,
          to: [emailInput.to],
          reply_to: emailInput.replyTo,
          tags: [TRACKED_DELIVERY_EMAIL_TAG],
          attachments: [
            {
              filename: "program-cue-invitation.ics",
              content: btoa(emailInput.attachments[0].content),
              content_type: emailInput.attachments[0].contentType,
            },
          ],
        });
        return HttpResponse.json({ id: "resend-message-42" });
      }),
    );

    await expect(
      new ResendEmailProvider("resend-key").send(emailInput),
    ).resolves.toEqual({
      provider: "resend",
      messageId: "resend-message-42",
    });
  });

  it("sends Mailpit's documented Send API shape and returns its real database id", async () => {
    server.use(
      http.post("https://mailpit.test/api/v1/send", async ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          `Basic ${btoa("program-cue:local-secret")}`,
        );
        const body = (await request.json()) as Record<string, unknown>;
        expect(body).toMatchObject({
          From: { Email: "events@example.com", Name: "Program Cue" },
          To: [{ Email: "speaker@example.com" }],
          ReplyTo: [{ Email: "reply@example.com" }],
          Subject: emailInput.subject,
          HTML: emailInput.html,
          Text: emailInput.text,
          Attachments: [
            {
              Filename: "program-cue-invitation.ics",
              Content: btoa(emailInput.attachments[0].content),
              ContentType: emailInput.attachments[0].contentType,
            },
          ],
        });
        expect(body.Headers).toMatchObject({
          "X-Program-Cue-Idempotency-Key": emailInput.idempotencyKey,
          "Message-ID": expect.stringMatching(
            /^<program-cue-[a-f0-9]{64}@mailpit\.local>$/,
          ),
        });
        return HttpResponse.json({ ID: "mailpit-database-id-7" });
      }),
    );
    const provider = createEmailProvider({
      APP_ENV: "development",
      DEMO_MODE: "true",
      EVALUATION_MODE: "false",
      EMAIL_PROVIDER: "mailpit",
      MAILPIT_SEND_API_URL: "https://mailpit.test/api/v1/send",
      MAILPIT_SEND_API_USERNAME: "program-cue",
      MAILPIT_SEND_API_PASSWORD: "local-secret",
    });

    await expect(provider.send(emailInput)).resolves.toEqual({
      provider: "mailpit",
      messageId: "mailpit-database-id-7",
    });
  });

  it("keeps Google Calendar on its authenticated event boundary", async () => {
    server.use(
      http.post(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events",
        async ({ request }) => {
          expect(request.headers.get("authorization")).toBe(
            "Bearer google-access-token",
          );
          expect(new URL(request.url).searchParams.get("sendUpdates")).toBe(
            "all",
          );
          await expect(request.json()).resolves.toMatchObject({
            summary: "Opening session",
            attendees: [{ email: "speaker@example.com" }],
            extendedProperties: {
              private: { programCueSequence: "0" },
            },
          });
          return HttpResponse.json({ id: "google-event-81" });
        },
      ),
    );

    await expect(
      new GoogleCalendarProvider("google-access-token").apply({
        uid: "session-1.speaker-1@calendar.programcue.app",
        title: "Opening session",
        description: "Welcome",
        location: "Main room",
        startsAtIso: "2027-05-20T13:00:00Z",
        endsAtIso: "2027-05-20T14:00:00Z",
        timezone: "America/Toronto",
        attendeeEmail: "speaker@example.com",
        attendeeName: "Speaker",
        sequence: 0,
        method: "REQUEST",
      }),
    ).resolves.toEqual({ providerEventId: "google-event-81" });
  });
});

describe("email provider selection", () => {
  it("accepts the explicitly configured Mailpit provider in the local demo runtime", () => {
    expect(
      requireEmailProviderConfiguration({
        APP_ENV: "demo",
        DEMO_MODE: "true",
        EVALUATION_MODE: "false",
        EMAIL_PROVIDER: "mailpit",
        MAILPIT_SEND_API_URL: "http://127.0.0.1:8025/api/v1/send",
      }),
    ).toEqual({
      provider: "mailpit",
      endpoint: "http://127.0.0.1:8025/api/v1/send",
    });
  });

  it("never selects Mailpit in production or falls back when Resend is missing", () => {
    expect(() =>
      requireEmailProviderConfiguration({
        APP_ENV: "production",
        DEMO_MODE: "false",
        EVALUATION_MODE: "false",
        EMAIL_PROVIDER: "mailpit",
        MAILPIT_SEND_API_URL: "https://mailpit.test/api/v1/send",
      }),
    ).toThrow("Production email delivery requires EMAIL_PROVIDER=resend");
    expect(() =>
      requireEmailProviderConfiguration({
        APP_ENV: "production",
        DEMO_MODE: "false",
        EVALUATION_MODE: "false",
        EMAIL_PROVIDER: "resend",
        MAILPIT_SEND_API_URL: "https://mailpit.test/api/v1/send",
      }),
    ).toThrow("RESEND_API_KEY is required");
  });

  it("rejects partial Mailpit authentication before creating a provider", () => {
    expect(() =>
      requireEmailProviderConfiguration({
        APP_ENV: "test",
        DEMO_MODE: "true",
        EVALUATION_MODE: "false",
        EMAIL_PROVIDER: "mailpit",
        MAILPIT_SEND_API_URL: "https://mailpit.test/api/v1/send",
        MAILPIT_SEND_API_USERNAME: "program-cue",
      }),
    ).toThrow("requires both MAILPIT_SEND_API_USERNAME");
  });
});
