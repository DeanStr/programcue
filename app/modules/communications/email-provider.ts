export type EmailProviderName = "resend" | "mailpit";

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

export type SendEmailResult = {
  provider: EmailProviderName;
  messageId: string;
};

export interface EmailProvider {
  readonly name: EmailProviderName;
  send(input: SendEmailInput): Promise<SendEmailResult>;
}
