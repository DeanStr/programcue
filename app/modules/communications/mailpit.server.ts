import { z } from "zod";

import { readBoundedResponseJson } from "~/platform/http/read-response";
import type {
  EmailProvider,
  SendEmailInput,
} from "./email-provider";

const mailpitResponseSchema = z.object({ ID: z.string().min(1).max(512) });
const emailSchema = z.email();
const PROVIDER_REQUEST_TIMEOUT_MS = 20_000;
const PROVIDER_RESPONSE_MAX_BYTES = 64 * 1_024;

type MailpitAddress = { Email: string; Name?: string };

export class MailpitDeliveryError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "MailpitDeliveryError";
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

function parseAddress(value: string): MailpitAddress {
  const trimmed = value.trim();
  const named = /^(.*?)\s*<([^<>]+)>$/.exec(trimmed);
  const email = (named?.[2] ?? trimmed).trim();
  if (!emailSchema.safeParse(email).success) {
    throw new MailpitDeliveryError(0, "Mailpit email delivery requires a valid address.");
  }
  const name = named?.[1]?.trim().replace(/^(["'])(.*)\1$/, "$2");
  return { Email: email, ...(name ? { Name: name } : {}) };
}

async function deterministicMessageId(idempotencyKey: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(idempotencyKey),
  );
  const token = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `<program-cue-${token}@mailpit.local>`;
}

export class MailpitEmailProvider implements EmailProvider {
  readonly name = "mailpit" as const;

  constructor(
    private readonly endpoint: string,
    private readonly username?: string,
    private readonly password?: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async send(input: SendEmailInput) {
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.username && this.password
          ? {
              authorization: `Basic ${bytesToBase64(`${this.username}:${this.password}`)}`,
            }
          : {}),
      },
      signal: AbortSignal.timeout(PROVIDER_REQUEST_TIMEOUT_MS),
      body: JSON.stringify({
        From: parseAddress(input.from),
        To: [parseAddress(input.to)],
        Subject: input.subject,
        HTML: input.html,
        Text: input.text,
        Headers: {
          "Message-ID": await deterministicMessageId(input.idempotencyKey),
          "X-Program-Cue-Idempotency-Key": input.idempotencyKey,
        },
        ...(input.replyTo
          ? { ReplyTo: [parseAddress(input.replyTo)] }
          : {}),
        ...(input.attachments?.length
          ? {
              Attachments: input.attachments.map((attachment) => ({
                Filename: attachment.filename,
                Content: bytesToBase64(attachment.content),
                ContentType: attachment.contentType,
              })),
            }
          : {}),
      }),
    });
    const body = await readBoundedResponseJson(
      response,
      PROVIDER_RESPONSE_MAX_BYTES,
    ).catch(() => null);
    if (!response.ok) {
      const error = body && typeof body === "object"
        ? body as Record<string, unknown>
        : {};
      throw new MailpitDeliveryError(
        response.status,
        String(
          error.Error ?? `Mailpit returned HTTP ${response.status}.`,
        ).slice(0, 500),
      );
    }
    const parsed = mailpitResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new MailpitDeliveryError(
        response.status,
        "Mailpit accepted the request without returning a message id.",
      );
    }
    return { provider: this.name, messageId: parsed.data.ID };
  }
}
