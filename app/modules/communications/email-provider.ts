export type EmailProviderName = "resend" | "mailpit";

export type EmailAttachment = {
  filename: string;
  content: string;
  contentType: string;
};

export type EmailTag = {
  name: string;
  value: string;
};

export const TRACKED_DELIVERY_EMAIL_TAG = {
  name: "program_cue_delivery",
  value: "tracked",
} as const satisfies EmailTag;

export type SendEmailInput = {
  from: string;
  replyTo?: string | null;
  to: string;
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
  attachments?: EmailAttachment[];
  tags?: EmailTag[];
};

export type SendEmailResult = {
  provider: EmailProviderName;
  messageId: string;
};

export interface EmailProvider {
  readonly name: EmailProviderName;
  send(input: SendEmailInput): Promise<SendEmailResult>;
}
