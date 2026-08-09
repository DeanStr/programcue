import { z } from "zod";

const resendResponseSchema = z.object({ id: z.string().min(1) });

export type EmailAttachment = {
  filename: string;
  content: string;
  contentType: string;
};

export type SendEmailInput = {
  from: string;
  replyTo?: string | null;
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
  attachments?: EmailAttachment[];
};

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

export class ResendEmailProvider {
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
      body: JSON.stringify({
        from: input.from,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
        ...(input.replyTo ? { reply_to: input.replyTo } : {}),
        ...(input.attachments?.length ? {
          attachments: input.attachments.map((attachment) => ({
            filename: attachment.filename,
            content: bytesToBase64(attachment.content),
            content_type: attachment.contentType,
          })),
        } : {}),
      }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      const error = body && typeof body === "object" ? body as Record<string, unknown> : {};
      throw new ResendDeliveryError(
        response.status,
        String(error.name ?? error.code ?? "RESEND_ERROR"),
        String(error.message ?? `Resend returned HTTP ${response.status}.`),
      );
    }
    const parsed = resendResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new ResendDeliveryError(response.status, "INVALID_PROVIDER_RESPONSE", "Resend accepted the request without returning a message id.");
    }
    return { provider: "resend" as const, messageId: parsed.data.id };
  }
}
