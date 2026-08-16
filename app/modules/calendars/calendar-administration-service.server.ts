import { z } from "zod";
import { requireValue } from "~/lib/required-value";

import type { Viewer } from "~/platform/auth/authorize.server";
import { CalendarStateError } from "./calendar-errors";
import { CalendarOAuthService } from "./calendar-oauth.server";
import {
  decryptCalendarCredentials,
  GoogleCalendarProvider,
  MicrosoftCalendarProvider,
} from "./calendar-providers.server";

const connectionIdSchema = z.string().trim().min(1).max(128);

const connectionLinkedToCurrentEvent = `(
  cc.event_id = e.id
  OR (
    cc.event_id IS NULL
    AND (
      EXISTS (
        SELECT 1 FROM memberships membership
         WHERE membership.event_id = e.id
           AND membership.person_id = cc.person_id
           AND membership.accepted_at IS NOT NULL
           AND membership.revoked_at IS NULL
      )
      OR EXISTS (
        SELECT 1 FROM memberships owner_membership
         WHERE owner_membership.organisation_id = e.organisation_id
           AND owner_membership.event_id IS NULL
           AND owner_membership.person_id = cc.person_id
           AND owner_membership.role = 'owner'
           AND owner_membership.accepted_at IS NOT NULL
           AND owner_membership.revoked_at IS NULL
      )
      OR EXISTS (
        SELECT 1 FROM session_speakers speaker
         WHERE speaker.event_id = e.id AND speaker.person_id = cc.person_id
      )
      OR EXISTS (
        SELECT 1 FROM calendar_invitations invitation
         WHERE invitation.event_id = e.id
           AND invitation.connection_id = cc.id
      )
    )
  )
)`;

type CalendarRsvpRow = {
  id: string;
  personId: string;
  connectionId: string;
  providerEventId: string | null;
  status: string;
  attendeeEmail: string;
  provider: "google" | "microsoft";
  connectionStatus: "connected" | "needs_attention";
  encryptedCredentials: string | null;
  expiresAt: number | null;
};

export class CalendarAdministrationService {
  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async listConnections(viewer: Viewer) {
    const result = await this.env.DB.prepare(
      `SELECT cc.id, cc.person_id AS personId, p.display_name AS personName,
              p.email, cc.provider, cc.account_reference AS accountReference,
              cc.status, cc.expires_at AS expiresAt, cc.last_synced_at AS lastSyncedAt,
              cc.updated_at AS updatedAt
        FROM calendar_connections cc
         JOIN events e ON e.organisation_id = cc.organisation_id
         JOIN people p ON p.id = cc.person_id
        WHERE e.id = ? AND e.organisation_id = ?
          AND ${connectionLinkedToCurrentEvent}
        ORDER BY CASE cc.status WHEN 'needs_attention' THEN 0 WHEN 'connected' THEN 1 ELSE 2 END,
                 cc.updated_at DESC`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .all<{
        id: string;
        personId: string;
        personName: string;
        email: string;
        provider: "google" | "microsoft";
        accountReference: string;
        status: string;
        expiresAt: number | null;
        lastSyncedAt: number | null;
        updatedAt: number;
      }>();
    return result.results;
  }

  async listTargets(viewer: Viewer) {
    const result = await this.env.DB.prepare(
      `SELECT s.id AS sessionId, content.title AS sessionTitle,
              p.id AS personId, p.display_name AS personName, p.email,
              ci.id AS invitationId, ci.method, ci.status AS invitationStatus,
              ci.sequence_number AS sequenceNumber,
              ci.connection_id AS invitationConnectionId,
              (SELECT json_extract(audit.metadata_json, '$.response')
                 FROM audit_events audit
                WHERE audit.event_id = ci.event_id
                  AND audit.entity_type = 'calendar_invitation'
                  AND audit.entity_id = ci.id
                  AND audit.action = 'calendar.rsvp.reconciled'
                ORDER BY audit.rowid DESC LIMIT 1) AS rsvpStatus,
              current_attempt.provider AS invitationProvider,
              active_connection.id AS activeConnectionId,
              active_connection.provider AS activeProvider
         FROM schedule_entries se
         JOIN schedule_versions sv
           ON sv.id = se.schedule_version_id AND sv.event_id = se.event_id
          AND sv.status = 'published'
         JOIN sessions s ON s.id = se.session_id AND s.event_id = se.event_id
         JOIN schedule_session_contents content
           ON content.schedule_version_id = sv.id AND content.event_id = sv.event_id
          AND content.session_id = s.id
         JOIN session_speakers ss
           ON ss.session_id = s.id AND ss.event_id = s.event_id
         JOIN people p ON p.id = ss.person_id
         JOIN events e ON e.id = se.event_id AND e.organisation_id = ?
         LEFT JOIN calendar_invitations ci
           ON ci.event_id = se.event_id AND ci.session_id = s.id AND ci.person_id = p.id
         LEFT JOIN calendar_sync_attempts current_attempt
           ON current_attempt.id = ci.current_attempt_id AND current_attempt.invitation_id = ci.id
         LEFT JOIN calendar_connections active_connection
           ON active_connection.id = (
             SELECT connection.id
               FROM calendar_connections connection
              WHERE connection.organisation_id = e.organisation_id
                AND connection.person_id = p.id
                AND (connection.event_id IS NULL OR connection.event_id = e.id)
                AND connection.status = 'connected'
              ORDER BY CASE connection.provider WHEN 'google' THEN 0 ELSE 1 END,
                       connection.updated_at DESC
              LIMIT 1
           )
        WHERE se.event_id = ?
        ORDER BY se.starts_at, content.title, ss.position`,
    )
      .bind(viewer.organisationId, viewer.eventId)
      .all<{
        sessionId: string;
        sessionTitle: string;
        personId: string;
        personName: string;
        email: string;
        invitationId: string | null;
        method: "REQUEST" | "CANCEL" | null;
        invitationStatus: string | null;
        sequenceNumber: number | null;
        invitationConnectionId: string | null;
        invitationProvider: "email_ics" | "google" | "microsoft" | null;
        rsvpStatus: string | null;
        activeConnectionId: string | null;
        activeProvider: "google" | "microsoft" | null;
      }>();
    return result.results;
  }

  async refreshConnection(viewer: Viewer, input: string) {
    const connectionId = connectionIdSchema.parse(input);
    const target = await this.env.DB.prepare(
      `SELECT cc.person_id AS personId
         FROM calendar_connections cc
         JOIN events e ON e.id = ? AND e.organisation_id = cc.organisation_id
        WHERE cc.id = ? AND ${connectionLinkedToCurrentEvent}`,
    )
      .bind(viewer.eventId, connectionId)
      .first<{ personId: string }>();
    if (!target)
      throw new CalendarStateError(
        "Calendar connection was not found in this event.",
      );
    const result = await new CalendarOAuthService(this.env).refreshConnection(
      { ...viewer, personId: target.personId },
      connectionId,
      Number.POSITIVE_INFINITY,
    );
    await this.env.DB.prepare(
      `INSERT INTO audit_events (
         id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action, entity_type,
         entity_id, metadata_json, created_at
       ) VALUES (?, 'person', 'admin_ui', 1, ?, ?, ?, 'calendar.connection.refreshed',
                 'calendar_connection', ?, '{}', unixepoch())`,
    )
      .bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        connectionId,
      )
      .run();
    return result;
  }

  async disconnect(viewer: Viewer, input: string) {
    const connectionId = connectionIdSchema.parse(input);
    const target = await this.env.DB.prepare(
      `SELECT cc.person_id AS personId, cc.event_id AS eventId
         FROM calendar_connections cc
         JOIN events e ON e.id = ? AND e.organisation_id = cc.organisation_id
        WHERE cc.id = ? AND ${connectionLinkedToCurrentEvent}`,
    )
      .bind(viewer.eventId, connectionId)
      .first<{ personId: string; eventId: string | null }>();
    if (!target)
      throw new CalendarStateError(
        "Calendar connection was not found in this event.",
      );
    const active = await this.env.DB.prepare(
      `SELECT COUNT(*) AS total
         FROM calendar_invitations ci
         JOIN calendar_connections cc ON cc.id = ci.connection_id
         JOIN events e ON e.id = ci.event_id AND e.organisation_id = ?
        WHERE cc.id = ?
          AND ci.status IN ('pending','queued','sent','confirmed','failed')
          AND ci.method <> 'CANCEL'`,
    )
      .bind(viewer.organisationId, connectionId)
      .first<{ total: number }>();
    if ((active?.total ?? 0) > 0)
      throw new CalendarStateError(
        `Cancel the ${requireValue(active, "Required active is unavailable.").total} active direct calendar invitation${requireValue(active, "Required active is unavailable.").total === 1 ? "" : "s"} in every event before disconnecting this shared account.`,
      );
    const result = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE calendar_connections
            SET status = 'disconnected', encrypted_credentials = NULL,
                scopes_json = '[]', expires_at = NULL, last_synced_at = NULL,
                updated_at = unixepoch()
          WHERE id = ? AND organisation_id = ?
            AND person_id = ? AND event_id IS ?
            AND status IN ('connected','needs_attention')
            AND NOT EXISTS (
              SELECT 1 FROM calendar_invitations ci
               JOIN events invitation_event ON invitation_event.id = ci.event_id
                AND invitation_event.organisation_id = calendar_connections.organisation_id
               WHERE ci.connection_id = calendar_connections.id
                 AND ci.status IN ('pending','queued','sent','confirmed','failed')
                 AND ci.method <> 'CANCEL'
            )`,
      ).bind(
        connectionId,
        viewer.organisationId,
        target.personId,
        target.eventId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action, entity_type,
           entity_id, metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'calendar.connection.disconnected',
                'calendar_connection', ?, '{}', unixepoch()
          WHERE changes() = 1
            AND EXISTS (
            SELECT 1 FROM calendar_connections
             WHERE id = ? AND organisation_id = ? AND status = 'disconnected'
          )`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        connectionId,
        connectionId,
        viewer.organisationId,
      ),
    ]);
    if ((result[0].meta.changes ?? 0) !== 1) {
      const racedActive = await this.env.DB.prepare(
        `SELECT COUNT(*) AS total
          FROM calendar_invitations ci
          JOIN calendar_connections cc ON cc.id = ci.connection_id
          JOIN events e ON e.id = ci.event_id AND e.organisation_id = ?
          WHERE cc.id = ?
            AND ci.status IN ('pending','queued','sent','confirmed','failed')
            AND ci.method <> 'CANCEL'`,
      )
        .bind(viewer.organisationId, connectionId)
        .first<{ total: number }>();
      if ((racedActive?.total ?? 0) > 0)
        throw new CalendarStateError(
          `Cancel the ${requireValue(racedActive, "Required racedActive is unavailable.").total} active direct calendar invitation${requireValue(racedActive, "Required racedActive is unavailable.").total === 1 ? "" : "s"} in every event before disconnecting this shared account.`,
        );
      throw new CalendarStateError(
        "Only a connected calendar account can be disconnected.",
      );
    }
  }

  async reconcileAttendance(viewer: Viewer, invitationInput: string) {
    const invitationId = connectionIdSchema.parse(invitationInput);
    let invitation = await this.env.DB.prepare(
      `SELECT invitation.id, invitation.person_id AS personId,
              invitation.connection_id AS connectionId,
              invitation.provider_event_id AS providerEventId,
              invitation.status, person.email AS attendeeEmail,
              connection.provider, connection.status AS connectionStatus,
              connection.encrypted_credentials AS encryptedCredentials,
              connection.expires_at AS expiresAt
         FROM calendar_invitations invitation
         JOIN events event
           ON event.id = invitation.event_id AND event.organisation_id = ?
         JOIN people person ON person.id = invitation.person_id
         JOIN calendar_connections connection
           ON connection.id = invitation.connection_id
          AND connection.organisation_id = event.organisation_id
          AND (connection.event_id IS NULL OR connection.event_id = event.id)
        WHERE invitation.id = ? AND invitation.event_id = ?
          AND invitation.method = 'REQUEST'
          AND invitation.status IN ('sent','confirmed')
          AND connection.status IN ('connected','needs_attention')`,
    )
      .bind(viewer.organisationId, invitationId, viewer.eventId)
      .first<CalendarRsvpRow>();
    if (!invitation?.providerEventId)
      throw new CalendarStateError(
        "RSVP reconciliation requires a delivered direct-calendar invitation.",
      );
    if (!invitation.encryptedCredentials)
      throw new CalendarStateError(
        "Calendar connection credentials were erased and the account must be connected again.",
      );
    if (invitation.expiresAt === null)
      throw new CalendarStateError(
        "The calendar connection is missing OAuth token expiry and must be connected again.",
      );
    if (
      invitation.connectionStatus === "needs_attention" ||
      invitation.expiresAt <= Math.floor(Date.now() / 1_000) + 300
    ) {
      await new CalendarOAuthService(this.env).refreshConnection(
        { ...viewer, personId: invitation.personId },
        invitation.connectionId,
      );
      invitation = await this.env.DB.prepare(
        `SELECT invitation.id, invitation.person_id AS personId,
                invitation.connection_id AS connectionId,
                invitation.provider_event_id AS providerEventId,
                invitation.status, person.email AS attendeeEmail,
                connection.provider, connection.status AS connectionStatus,
                connection.encrypted_credentials AS encryptedCredentials,
                connection.expires_at AS expiresAt
           FROM calendar_invitations invitation
           JOIN events event
             ON event.id = invitation.event_id AND event.organisation_id = ?
           JOIN people person ON person.id = invitation.person_id
           JOIN calendar_connections connection
             ON connection.id = invitation.connection_id
            AND connection.organisation_id = event.organisation_id
            AND (connection.event_id IS NULL OR connection.event_id = event.id)
          WHERE invitation.id = ? AND invitation.event_id = ?
            AND connection.status = 'connected'`,
      )
        .bind(viewer.organisationId, invitationId, viewer.eventId)
        .first<CalendarRsvpRow>();
      if (
        !invitation?.providerEventId ||
        !invitation.encryptedCredentials ||
        invitation.expiresAt === null ||
        invitation.expiresAt <= Math.floor(Date.now() / 1_000)
      )
        throw new CalendarStateError(
          "Calendar connection changed while its access token was refreshed.",
        );
    }
    const credentials = await decryptCalendarCredentials(
      invitation.encryptedCredentials,
      this.env.CALENDAR_CREDENTIALS_KEY,
    );
    if (
      invitation.expiresAt === null ||
      credentials.accessTokenExpiresAt !== invitation.expiresAt ||
      credentials.accessTokenExpiresAt <= Math.floor(Date.now() / 1_000)
    )
      throw new CalendarStateError(
        "Connected calendar credential expiry does not match its durable connection state.",
      );
    const response =
      invitation.provider === "google"
        ? await new GoogleCalendarProvider(
            credentials.accessToken,
            credentials.calendarId,
            this.fetcher,
          ).attendance(invitation.providerEventId, invitation.attendeeEmail)
        : await new MicrosoftCalendarProvider(
            credentials.accessToken,
            this.fetcher,
          ).attendance(invitation.providerEventId, invitation.attendeeEmail);
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE calendar_invitations
            SET status = CASE WHEN ? = 'accepted' THEN 'confirmed' ELSE 'sent' END,
                updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND method = 'REQUEST'
            AND provider_event_id = ? AND status IN ('sent','confirmed')`,
      ).bind(
        response,
        invitation.id,
        viewer.eventId,
        invitation.providerEventId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action, entity_type,
           entity_id, metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'calendar.rsvp.reconciled',
                'calendar_invitation', ?, ?, unixepoch()
          WHERE changes() = 1
            AND EXISTS (
            SELECT 1 FROM calendar_invitations
             WHERE id = ? AND event_id = ? AND provider_event_id = ?
          )`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        invitation.id,
        JSON.stringify({ provider: invitation.provider, response }),
        invitation.id,
        viewer.eventId,
        invitation.providerEventId,
      ),
    ]);
    if ((results[0].meta.changes ?? 0) !== 1)
      throw new CalendarStateError(
        "Calendar invitation changed while RSVP status was reconciled.",
      );
    return { response };
  }
}
