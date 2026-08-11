import { z } from "zod";

import { readBoundedResponseJson } from "~/platform/http/read-response";
import type { EmailProvider, SendEmailInput } from "./email-provider";

const resendResponseSchema = z.object({ id: z.string().min(1).max(512) });
const PROVIDER_REQUEST_TIMEOUT_MS = 20_000;
const PROVIDER_RESPONSE_MAX_BYTES = 64 * 1_024;

export class ResendConfigurationError extends Error {
  constructor() {
    super("RESEND_API_KEY is required before email can be delivered.");
    this.name = "ResendConfigurationError";
  }
}

export class ResendDeliveryError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "ResendDeliveryError";
  }
}

function bytesToBase64(value: string) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export class ResendEmailProvider implements EmailProvider {
  readonly name = "resend" as const;
  constructor(
    private readonly apiKey: string | undefined,
    private readonly fetcher: typeof fetch = fetch,
    private readonly endpoint = "https://api.resend.com/emails",
  ) {}

  async send(input: SendEmailInput) {
    if (!this.apiKey?.trim()) throw new ResendConfigurationError();
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
        "idempotency-key": input.idempotencyKey,
      },
      signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        from: input.from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
        ...(input.tags?.length ? { tags: input.tags } : {}),
        ...(input.attachments?.length ? {
          attachments: input.attachments.map((attachment) => ({
            filename: attachment.filename,
            content: bytesToBase64(attachment.content),
            content_type: attachment.contentType,
          })),
        } : {}),
      }),
    });
    const body = await readBoundedResponseJson(
      response,
      PROVIDER_RESPONSE_MAX_BYTES,
    ).catch(() => null);
    if (!response.ok) {
      const error = body && typeof body === "object" ? body as Record<string, unknown> : {};
      throw new ResendDeliveryError(
        response.status,
        String(error.name ?? error.code ?? "RESEND_ERROR").slice(0, 128),
        String(
          error.message ?? `Resend returned HTTP ${response.status}.`,
        ).slice(0, 500),
      );
    }
    const parsed = resendResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new ResendDeliveryError(response.status, "INVALID_PROVIDER_RESPONSE", "Resend accepted the request without returning a message id.");
    }
    return { provider: this.name, messageId: parsed.data.id };
  }
}
