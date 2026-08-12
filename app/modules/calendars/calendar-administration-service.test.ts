import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoProgramme } from "~/platform/demo/seed.server";
import { CalendarAdministrationService } from "./calendar-administration-service.server";
import { encryptCalendarCredentials } from "./calendar-providers.server";

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

const credentialKey = btoa(
  String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index + 31)),
);

describe("calendar administration", () => {
  it("lists shared accounts only when their owner participates in the current event", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoProgramme(testEnv);
    const otherEventId = `calendar-event-${crypto.randomUUID()}`;
    const otherPersonId = `calendar-person-${crypto.randomUUID()}`;
    const otherConnectionId = `calendar-connection-${crypto.randomUUID()}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO events (
           id, organisation_id, name, slug, timezone, starts_at, ends_at,
           file_policy_json, last_updated_by_person_id
         )
         SELECT ?, organisation_id, 'Other calendar event', ?, timezone,
                starts_at, ends_at, file_policy_json, last_updated_by_person_id
           FROM events WHERE id = ?`,
      ).bind(
        otherEventId,
        `other-calendar-event-${crypto.randomUUID()}`,
        viewer.eventId,
      ),
      testEnv.DB.prepare(
        `INSERT INTO people (id,email,display_name,email_verified,profile_status)
         VALUES (?,?,'Other event participant',1,'published')`,
      ).bind(otherPersonId, `${crypto.randomUUID()}@example.com`),
      testEnv.DB.prepare(
        `INSERT INTO memberships (
           id,organisation_id,event_id,person_id,role,invited_at,accepted_at
         ) VALUES (?,?,?,?, 'speaker',unixepoch(),unixepoch())`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        otherEventId,
        otherPersonId,
      ),
      testEnv.DB.prepare(
        `INSERT INTO calendar_connections (
           id,organisation_id,event_id,person_id,provider,account_reference,
           encrypted_credentials,scopes_json,status,expires_at
         ) VALUES (?,?,NULL,?,'google',?,'encrypted','[]','connected',unixepoch()+3600)`,
      ).bind(
        otherConnectionId,
        viewer.organisationId,
        otherPersonId,
        `other-account-${crypto.randomUUID()}`,
      ),
    ]);

    const service = new CalendarAdministrationService(testEnv);
    expect(
      (await service.listConnections(viewer)).map(
        (connection) => connection.id,
      ),
    ).not.toContain(otherConnectionId);
    await expect(service.disconnect(viewer, otherConnectionId)).rejects.toThrow(
      "not found in this event",
    );
  });

  it("does not disconnect shared credentials while another event has an active invitation", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoProgramme(testEnv);
    const otherEventId = `calendar-active-event-${crypto.randomUUID()}`;
    const otherSessionId = `calendar-active-session-${crypto.randomUUID()}`;
    const connectionId = `calendar-shared-connection-${crypto.randomUUID()}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO events (
           id, organisation_id, name, slug, timezone, starts_at, ends_at,
           file_policy_json, last_updated_by_person_id
         )
         SELECT ?, organisation_id, 'Other active calendar event', ?, timezone,
                starts_at, ends_at, file_policy_json, last_updated_by_person_id
           FROM events WHERE id = ?`,
      ).bind(
        otherEventId,
        `other-active-calendar-${crypto.randomUUID()}`,
        viewer.eventId,
      ),
      testEnv.DB.prepare(
        `INSERT INTO sessions (
           id,event_id,title,slug,format,duration_minutes,status,visibility
         ) VALUES (?,?,'Other event session','other-event-session','presentation',
                   45,'scheduled','public')`,
      ).bind(otherSessionId, otherEventId),
      testEnv.DB.prepare(
        `INSERT INTO session_speakers (
           session_id,event_id,person_id,position,
           participation_status,participation_confirmed_at,visibility
         ) VALUES (?,?,'person-demo-speaker',0,'confirmed',unixepoch(),'public')`,
      ).bind(otherSessionId, otherEventId),
      testEnv.DB.prepare(
        `INSERT INTO calendar_connections (
           id,organisation_id,event_id,person_id,provider,account_reference,
           encrypted_credentials,scopes_json,status,expires_at
         ) VALUES (?,?,NULL,'person-demo-speaker','google',?,'encrypted','[]',
                   'connected',unixepoch()+3600)`,
      ).bind(
        connectionId,
        viewer.organisationId,
        `shared-account-${crypto.randomUUID()}`,
      ),
      testEnv.DB.prepare(
        `INSERT INTO calendar_invitations (
           id,event_id,session_id,person_id,connection_id,ical_uid,
           sequence_number,method,status
         ) VALUES (?,?,?,'person-demo-speaker',?,?,0,'REQUEST','sent')`,
      ).bind(
        crypto.randomUUID(),
        otherEventId,
        otherSessionId,
        connectionId,
        `${crypto.randomUUID()}@calendar.programcue.app`,
      ),
    ]);

    const service = new CalendarAdministrationService(testEnv);
    await expect(service.disconnect(viewer, connectionId)).rejects.toThrow(
      "in every event",
    );
    await expect(
      testEnv.DB.prepare(
        "SELECT status, encrypted_credentials AS credentials FROM calendar_connections WHERE id = ?",
      )
        .bind(connectionId)
        .first(),
    ).resolves.toEqual({ status: "connected", credentials: "encrypted" });
  });

  it("reconciles factual provider RSVP state without preserving stale acceptance", async () => {
    const testEnv = {
      ...(env as unknown as CloudflareEnvironment),
      DB: env.DB,
      DEMO_MODE: "true",
      CALENDAR_CREDENTIALS_KEY: credentialKey,
    } as unknown as CloudflareEnvironment;
    await ensureDemoProgramme(testEnv);
    const session = await testEnv.DB.prepare(
      `SELECT session.id, person.email
         FROM sessions session
         JOIN session_speakers speaker
           ON speaker.session_id = session.id AND speaker.event_id = session.event_id
         JOIN people person ON person.id = speaker.person_id
        WHERE session.event_id = ? AND speaker.person_id = 'person-demo-speaker'
        LIMIT 1`,
    )
      .bind(viewer.eventId)
      .first<{ id: string; email: string }>();
    expect(session).not.toBeNull();
    const expiresAt = Math.floor(Date.now() / 1_000) + 3_600;
    const connectionId = crypto.randomUUID();
    const invitationId = crypto.randomUUID();
    const credentials = await encryptCalendarCredentials(
      {
        accessToken: "calendar-access-token",
        refreshToken: "calendar-refresh-token",
        accessTokenExpiresAt: expiresAt,
        tokenType: "Bearer",
        calendarId: "primary",
      },
      credentialKey,
    );
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO calendar_connections (
           id, organisation_id, event_id, person_id, provider, account_reference,
           encrypted_credentials, scopes_json, status, expires_at, created_at, updated_at
         ) VALUES (?, ?, NULL, 'person-demo-speaker', 'google', ?, ?, '[]',
                   'connected', ?, unixepoch(), unixepoch())`,
      ).bind(
        connectionId,
        viewer.organisationId,
        `rsvp-${crypto.randomUUID()}`,
        credentials,
        expiresAt,
      ),
      testEnv.DB.prepare(
        `INSERT INTO calendar_invitations (
           id, event_id, session_id, person_id, connection_id, ical_uid,
           sequence_number, method, provider_event_id, status, created_at, updated_at
         ) VALUES (?, ?, ?, 'person-demo-speaker', ?, ?, 0, 'REQUEST',
                   'google-provider-event', 'sent', unixepoch(), unixepoch())`,
      ).bind(
        invitationId,
        viewer.eventId,
        session!.id,
        connectionId,
        `${crypto.randomUUID()}@calendar.programcue.app`,
      ),
    ]);
    let responseStatus: "accepted" | "declined" = "accepted";
    const requests: string[] = [];
    const administration = new CalendarAdministrationService(
      testEnv,
      async (input) => {
        requests.push(String(input));
        return Response.json({
          attendees: [
            {
              email: session!.email,
              responseStatus,
            },
          ],
        });
      },
    );

    await expect(
      administration.reconcileAttendance(viewer, invitationId),
    ).resolves.toEqual({ response: "accepted" });
    responseStatus = "declined";
    await expect(
      administration.reconcileAttendance(viewer, invitationId),
    ).resolves.toEqual({ response: "declined" });

    await expect(
      testEnv.DB.prepare(
        `SELECT invitation.status,
                json_extract(audit.metadata_json, '$.response') AS response
           FROM calendar_invitations invitation
           JOIN audit_events audit
             ON audit.entity_type = 'calendar_invitation'
            AND audit.entity_id = invitation.id
            AND audit.action = 'calendar.rsvp.reconciled'
          WHERE invitation.id = ?
          ORDER BY audit.rowid DESC
          LIMIT 1`,
      )
        .bind(invitationId)
        .first(),
    ).resolves.toEqual({ status: "sent", response: "declined" });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toContain("/events/google-provider-event");
  });
});
