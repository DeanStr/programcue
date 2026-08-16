import type { Viewer } from "~/platform/auth/authorize.server";
import { CommunicationStateError } from "./communication-service-shared";
import {
  type EmailProviderConfiguration,
  requireEmailProviderConfiguration,
} from "./email-provider.server";
import { ResendDomainProvider } from "./resend-domain.server";
import {
  type SaveSenderProfileInput,
  saveSenderProfileSchema,
  senderProfileIdSchema,
} from "./sender-profile-schema";

export type SenderProfile = {
  id: string;
  name: string;
  fromName: string;
  fromEmail: string;
  replyToEmail: string | null;
  provider: "resend" | "mailpit";
  providerSenderId: string | null;
  status: "unverified" | "verified" | "disabled";
  updatedAt: number;
};

function emailDomain(address: string) {
  const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  if (!domain || domain === address)
    throw new CommunicationStateError("Sender email domain is invalid.");
  return domain;
}

export class SenderProfileService {
  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly domains = new ResendDomainProvider(env.RESEND_API_KEY),
  ) {}

  private configuration(): EmailProviderConfiguration {
    try {
      return requireEmailProviderConfiguration(this.env);
    } catch (error) {
      throw new CommunicationStateError(
        error instanceof Error
          ? error.message
          : "Email provider configuration is invalid.",
      );
    }
  }

  async list(viewer: Viewer) {
    const configuration = this.configuration();
    const result = await this.env.DB.prepare(
      `SELECT sp.id, sp.name, sp.from_name AS fromName, sp.from_email AS fromEmail,
              sp.reply_to_email AS replyToEmail, sp.provider_sender_id AS providerSenderId,
              sp.provider, sp.status, sp.updated_at AS updatedAt
         FROM sender_profiles sp
         JOIN events e ON e.id = sp.event_id AND e.organisation_id = ?
        WHERE sp.event_id = ? AND sp.provider = ?
        ORDER BY CASE sp.status WHEN 'verified' THEN 0 WHEN 'unverified' THEN 1 ELSE 2 END,
                 sp.updated_at DESC`,
    )
      .bind(viewer.organisationId, viewer.eventId, configuration.provider)
      .all<SenderProfile>();
    return result.results;
  }

  async save(viewer: Viewer, input: SaveSenderProfileInput) {
    const parsed = saveSenderProfileSchema.parse(input);
    const configuration = this.configuration();
    const enabledStatus =
      configuration.provider === "mailpit" ? "verified" : "unverified";
    const id = parsed.id ?? crypto.randomUUID();
    const previous = parsed.id
      ? await this.env.DB.prepare(
          `SELECT sp.from_name AS fromName, sp.from_email AS fromEmail,
                  sp.reply_to_email AS replyToEmail
             FROM sender_profiles sp
             JOIN events e ON e.id = sp.event_id AND e.organisation_id = ?
            WHERE sp.id = ? AND sp.event_id = ? AND sp.provider = ?`,
        )
          .bind(
            viewer.organisationId,
            id,
            viewer.eventId,
            configuration.provider,
          )
          .first<{
            fromName: string;
            fromEmail: string;
            replyToEmail: string | null;
          }>()
      : null;
    if (parsed.id && !previous)
      throw new CommunicationStateError(
        "Sender profile was not found in this event.",
      );
    const addressChanged =
      previous !== null &&
      previous.fromEmail.toLowerCase() !== parsed.fromEmail.toLowerCase();
    const deliveryFieldsChanged =
      previous !== null &&
      (previous.fromName !== parsed.fromName ||
        previous.fromEmail !== parsed.fromEmail ||
        previous.replyToEmail !== parsed.replyToEmail);
    const result = await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO sender_profiles (
           id, event_id, name, from_name, from_email, reply_to_email, provider,
           provider_sender_id, status, created_at, updated_at
         )
         SELECT ?, e.id, ?, ?, ?, ?, ?, NULL, ?, unixepoch(), unixepoch()
           FROM events e
          WHERE e.id = ? AND e.organisation_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM sender_profiles conflicting
               WHERE conflicting.event_id = e.id
                 AND conflicting.name = ? AND conflicting.id <> ?
            )
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           from_name = excluded.from_name,
           from_email = excluded.from_email,
           reply_to_email = excluded.reply_to_email,
           provider_sender_id = CASE WHEN ? THEN NULL ELSE sender_profiles.provider_sender_id END,
           status = CASE WHEN ? THEN ? ELSE sender_profiles.status END,
           updated_at = unixepoch()
         WHERE sender_profiles.event_id = excluded.event_id
           AND sender_profiles.provider = excluded.provider
           AND (
             ? = 0 OR NOT EXISTS (
               SELECT 1 FROM communications active_communication
                WHERE active_communication.sender_profile_id = sender_profiles.id
                  AND active_communication.event_id = sender_profiles.event_id
                  AND active_communication.status IN (
                    'scheduled','queued','sending','failed','partially_failed'
                  )
             )
           )`,
      ).bind(
        id,
        parsed.name,
        parsed.fromName,
        parsed.fromEmail,
        parsed.replyToEmail,
        configuration.provider,
        enabledStatus,
        viewer.eventId,
        viewer.organisationId,
        parsed.name,
        id,
        addressChanged,
        addressChanged,
        enabledStatus,
        deliveryFieldsChanged ? 1 : 0,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action, entity_type,
           entity_id, metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'communication.sender.saved', 'sender_profile', ?,
                json_object('fromEmail', ?, 'addressChanged', json(?), 'provider', ?), unixepoch()
          WHERE changes() = 1
            AND EXISTS (SELECT 1 FROM sender_profiles WHERE id = ? AND event_id = ?)`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        id,
        parsed.fromEmail,
        addressChanged ? "true" : "false",
        configuration.provider,
        id,
        viewer.eventId,
      ),
    ]);
    if ((result[0].meta.changes ?? 0) !== 1) {
      if (deliveryFieldsChanged) {
        const active = await this.env.DB.prepare(
          `SELECT 1
             FROM communications communication
             JOIN events event
               ON event.id = communication.event_id
              AND event.organisation_id = ?
            WHERE communication.sender_profile_id = ?
              AND communication.event_id = ?
              AND communication.status IN (
                'scheduled','queued','sending','failed','partially_failed'
              )
            LIMIT 1`,
        )
          .bind(viewer.organisationId, id, viewer.eventId)
          .first();
        if (active)
          throw new CommunicationStateError(
            "Sender delivery fields cannot change while a scheduled or retryable communication is active. Cancel or finish it first.",
          );
      }
      throw new CommunicationStateError(
        "Sender profile could not be saved. Use a unique profile name in this event.",
      );
    }
    return {
      id,
      provider: configuration.provider,
      status: parsed.id && !addressChanged ? undefined : enabledStatus,
    };
  }

  async provision(viewer: Viewer, profileId: string) {
    const id = senderProfileIdSchema.parse(profileId);
    const configuration = this.configuration();
    const profile = await this.find(viewer, id, configuration.provider);
    if (profile.status === "disabled")
      throw new CommunicationStateError(
        "Enable the sender profile before provisioning its domain.",
      );
    if (configuration.provider === "mailpit") {
      if (profile.status !== "verified") {
        throw new CommunicationStateError(
          "The Mailpit sender profile is not in the required verified local-capture state.",
        );
      }
      return {
        id,
        provider: "mailpit" as const,
        status: "verified" as const,
        providerStatus: "verified" as const,
        domain: null,
        records: [],
      };
    }
    const domainName = emailDomain(profile.fromEmail);
    const domains = await this.domains.list();
    let domain = domains.find(
      (candidate) => candidate.name.toLowerCase() === domainName,
    );
    if (!domain) domain = await this.domains.create(domainName);
    if (domain.status !== "verified") {
      await this.domains.verify(domain.id);
      domain = await this.domains.get(domain.id);
    }
    const status = domain.status === "verified" ? "verified" : "unverified";
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE sender_profiles
            SET provider_sender_id = ?, status = ?, updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND provider = 'resend'
            AND from_email = ?
            AND status = ? AND provider_sender_id IS ?
            AND EXISTS (SELECT 1 FROM events WHERE id = ? AND organisation_id = ?)`,
      ).bind(
        domain.id,
        status,
        id,
        viewer.eventId,
        profile.fromEmail,
        profile.status,
        profile.providerSenderId,
        viewer.eventId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action, entity_type,
           entity_id, metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'communication.sender.verification.checked',
                'sender_profile', ?, json_object('domain', ?, 'providerStatus', ?), unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM sender_profiles
             WHERE id = ? AND event_id = ? AND provider_sender_id = ? AND status = ?
          )`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        id,
        domainName,
        domain.status,
        id,
        viewer.eventId,
        domain.id,
        status,
      ),
    ]);
    if ((results[0].meta.changes ?? 0) !== 1)
      throw new CommunicationStateError(
        "Sender profile changed while its provider status was checked.",
      );
    return {
      id,
      provider: "resend" as const,
      status,
      providerStatus: domain.status,
      domain: domainName,
      records: domain.records ?? [],
    };
  }

  async setEnabled(viewer: Viewer, profileId: string, enabled: boolean) {
    const id = senderProfileIdSchema.parse(profileId);
    const configuration = this.configuration();
    const enabledStatus =
      configuration.provider === "mailpit" ? "verified" : "unverified";
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE sender_profiles
            SET status = ?, updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND provider = ?
            AND EXISTS (SELECT 1 FROM events WHERE id = ? AND organisation_id = ?)`,
      ).bind(
        enabled ? enabledStatus : "disabled",
        id,
        viewer.eventId,
        configuration.provider,
        viewer.eventId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action, entity_type,
           entity_id, metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, ?, 'sender_profile', ?, '{}', unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM sender_profiles WHERE id = ? AND event_id = ? AND status = ?
          )`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        enabled
          ? "communication.sender.enabled"
          : "communication.sender.disabled",
        id,
        id,
        viewer.eventId,
        enabled ? enabledStatus : "disabled",
      ),
    ]);
    if ((results[0].meta.changes ?? 0) !== 1)
      throw new CommunicationStateError(
        "Sender profile was not found in this event.",
      );
    // Resend re-enabling deliberately requires a fresh provider verification
    // check. Mailpit has no domain-verification boundary and is immediately
    // usable only in the explicitly selected local/test runtime.
    return { id, status: enabled ? enabledStatus : "disabled" };
  }

  private async find(
    viewer: Viewer,
    id: string,
    provider: "resend" | "mailpit",
  ) {
    const profile = await this.env.DB.prepare(
      `SELECT sp.id, sp.name, sp.from_name AS fromName, sp.from_email AS fromEmail,
              sp.reply_to_email AS replyToEmail, sp.provider_sender_id AS providerSenderId,
              sp.provider, sp.status, sp.updated_at AS updatedAt
         FROM sender_profiles sp
         JOIN events e ON e.id = sp.event_id AND e.organisation_id = ?
        WHERE sp.id = ? AND sp.event_id = ? AND sp.provider = ?`,
    )
      .bind(viewer.organisationId, id, viewer.eventId, provider)
      .first<SenderProfile>();
    if (!profile)
      throw new CommunicationStateError(
        "Sender profile was not found in this event.",
      );
    return profile;
  }
}
