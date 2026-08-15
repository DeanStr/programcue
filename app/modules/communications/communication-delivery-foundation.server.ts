import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  CommunicationNotFoundError,
  CommunicationStateError,
  type EventMergeRow,
  type SenderRow,
} from "./communication-service-shared";
import { CommunicationTemplateService } from "./communication-template-service.server";
import { requireEmailProviderConfiguration } from "./email-provider.server";
import { representativeMergeValues } from "./merge-template";
import { RecipientQuery } from "./recipient-query.server";

export function representativeSourceSnapshot(variables: string[]) {
  return Object.fromEntries(
    variables.map((variable) => [
      variable,
      representativeMergeValues[variable],
    ]),
  );
}

export abstract class CommunicationDeliveryFoundation {
  protected readonly templates: CommunicationTemplateService;
  protected readonly recipients: RecipientQuery;
  protected readonly airtable: AirtableProviderBoundary;
  constructor(
    protected readonly env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    this.templates = new CommunicationTemplateService(env);
    this.recipients = new RecipientQuery(env);
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
  }

  protected async getEvent(viewer: Viewer) {
    const event = await this.env.DB.prepare(
      `
      SELECT e.name AS eventName, e.brand_accent AS brandAccent,
             CASE WHEN e.brand_logo_asset_id IS NOT NULL
               THEN '/public/brand/' || e.slug || '/logo'
               ELSE e.participant_logo_url
             END AS logoUrl,
             e.starts_at AS startsAt, e.ends_at AS endsAt
        FROM events e WHERE e.id = ? AND e.organisation_id = ?
    `,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<EventMergeRow>();
    if (!event)
      throw new CommunicationNotFoundError(
        "The event was not found in the authorised organisation.",
      );
    return event;
  }

  protected async getVerifiedSender(viewer: Viewer) {
    let provider: "resend" | "mailpit";
    try {
      provider = requireEmailProviderConfiguration(this.env).provider;
    } catch (error) {
      throw new CommunicationStateError(
        error instanceof Error
          ? error.message
          : "Email provider configuration is invalid.",
      );
    }
    return this.env.DB.prepare(
      `
      SELECT sp.id, sp.from_name AS fromName, sp.from_email AS fromEmail,
             sp.reply_to_email AS replyToEmail
        FROM sender_profiles sp
        JOIN events e ON e.id = sp.event_id AND e.organisation_id = ?
       WHERE sp.event_id = ? AND sp.status = 'verified' AND sp.provider = ?
       ORDER BY sp.updated_at DESC LIMIT 1
    `,
    )
      .bind(viewer.organisationId, viewer.eventId, provider)
      .first<SenderRow>();
  }
}
