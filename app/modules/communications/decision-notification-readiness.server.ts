import type { z } from "zod";

import { templateContentSchema } from "./communication-schema";
import { emailDeliveryIssue } from "./email-deliverability";
import {
  type EmailProviderConfiguration,
  requireEmailProviderConfiguration,
} from "./email-provider.server";

export type DecisionTemplateRow = {
  id: string;
  name: string;
  versionNumber: number;
  subjectTemplate: string | null;
  contentJson: string;
};

export type DecisionSenderRow = {
  id: string;
  fromName: string;
  fromEmail: string;
  replyToEmail: string | null;
};

export type DecisionNotificationReadiness = {
  error: string | null;
  provider: EmailProviderConfiguration | null;
  template: DecisionTemplateRow | null;
  content: z.infer<typeof templateContentSchema> | null;
  sender: DecisionSenderRow | null;
};

export async function inspectDecisionNotificationReadiness(
  env: CloudflareEnvironment,
  input: {
    organisationId: string;
    eventId: string;
    recipientAddress: string | null;
  },
): Promise<DecisionNotificationReadiness> {
  let provider: EmailProviderConfiguration | null = null;
  let providerError: string | null = null;
  try {
    provider = requireEmailProviderConfiguration(env);
  } catch (error) {
    providerError =
      error instanceof Error
        ? error.message
        : "Email provider configuration is invalid.";
  }

  const templatePromise = env.DB.prepare(
    `SELECT version.id, version.name, version.version_number AS versionNumber,
            version.subject_template AS subjectTemplate,
            version.content_json AS contentJson
       FROM communication_template_versions version
       JOIN communication_templates template
         ON template.id = version.template_id
        AND template.event_id = version.event_id
       JOIN events event
         ON event.id = template.event_id AND event.organisation_id = ?
      WHERE template.event_id = ? AND template.status = 'active'
        AND version.status = 'published' AND version.channel = 'email'
        AND version.category = 'decision'
      ORDER BY version.published_at DESC, version.version_number DESC
      LIMIT 1`,
  )
    .bind(input.organisationId, input.eventId)
    .first<DecisionTemplateRow>();
  const senderPromise = provider
    ? env.DB.prepare(
        `SELECT sender.id, sender.from_name AS fromName,
                sender.from_email AS fromEmail,
                sender.reply_to_email AS replyToEmail
           FROM sender_profiles sender
           JOIN events event
             ON event.id = sender.event_id AND event.organisation_id = ?
          WHERE sender.event_id = ? AND sender.provider = ?
            AND sender.status = 'verified'
          ORDER BY sender.updated_at DESC
          LIMIT 1`,
      )
        .bind(input.organisationId, input.eventId, provider.provider)
        .first<DecisionSenderRow>()
    : Promise.resolve(null);
  const [template, sender] = await Promise.all([
    templatePromise,
    senderPromise,
  ]);

  let error: string | null = null;
  let content: z.infer<typeof templateContentSchema> | null = null;
  const recipientIssue = input.recipientAddress
    ? emailDeliveryIssue(input.recipientAddress, env.APP_ENV)
    : "Invalid email address";
  if (recipientIssue) {
    error =
      recipientIssue === "Reserved or local-only domain"
        ? "The decision recipient uses a reserved or local-only email domain. Update the recipient before releasing the decision."
        : "The decision recipient does not have a valid verified email address.";
  } else if (!template) {
    error =
      "Publish and activate a decision email template before releasing decisions.";
  } else if (
    template.subjectTemplate === null ||
    template.subjectTemplate !== template.subjectTemplate.trim() ||
    template.subjectTemplate.length < 1 ||
    template.subjectTemplate.length > 200
  ) {
    error = "The published decision email template has an invalid subject.";
  } else {
    let rawContent: unknown = null;
    try {
      rawContent = JSON.parse(template.contentJson);
    } catch {
      // Invalid JSON is reported through the same persisted-template error.
    }
    const parsedContent = templateContentSchema.safeParse(rawContent);
    if (parsedContent.success) content = parsedContent.data;
    else
      error = "The published decision email template contains invalid content.";
  }
  if (!error && providerError) error = providerError;
  if (!error && !sender)
    error = "A verified sender profile is required for decision notifications.";

  return { error, provider, template, content, sender };
}
