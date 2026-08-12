import { describe, expect, it } from "vitest";

import type { SendEmailInput } from "./email-provider";
import { MailpitEmailProvider } from "./mailpit.server";
import { ResendEmailProvider } from "./resend.server";

const message: SendEmailInput = {
  from: "Program Cue <events@example.com>",
  to: "speaker@example.com",
  subject: "Schedule update",
  html: "<p>Update</p>",
  text: "Update",
  idempotencyKey: "provider-response-bound-test",
};

describe("email provider response bounds", () => {
  it("invokes the Resend fetch dependency without the provider as its receiver", async () => {
    const fetcher = function (this: unknown) {
      if (this !== undefined) {
        throw new TypeError("fetch received an invalid this reference");
      }
      return Promise.resolve(Response.json({ id: "provider-id" }));
    } as typeof fetch;
    const provider = new ResendEmailProvider("provider-key", fetcher);

    await expect(provider.send(message)).resolves.toEqual({
      provider: "resend",
      messageId: "provider-id",
    });
  });

  it("rejects an oversized Resend response before accepting its message id", async () => {
    const provider = new ResendEmailProvider(
      "provider-key",
      async () =>
        new Response(
          JSON.stringify({ id: "provider-id", padding: "x".repeat(70_000) }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    await expect(provider.send(message)).rejects.toMatchObject({
      name: "ResendDeliveryError",
      code: "INVALID_PROVIDER_RESPONSE",
    });
  });

  it("rejects an unbounded Mailpit message identifier", async () => {
    const provider = new MailpitEmailProvider(
      "http://mailpit.test/api/v1/send",
      undefined,
      undefined,
      async () => Response.json({ ID: "m".repeat(513) }),
    );

    await expect(provider.send(message)).rejects.toMatchObject({
      name: "MailpitDeliveryError",
    });
  });
});
