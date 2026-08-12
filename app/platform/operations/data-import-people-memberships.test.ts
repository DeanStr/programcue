import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  acceptEventInvitation,
  requireEventRole,
  type Viewer,
} from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { INITIAL_EVENT_SESSION_FORMATS_JSON } from "~/modules/events/event-configuration";
import { CANONICAL_EVENT_FILE_POLICY_JSON } from "~/modules/files/file-policy";
import {
  DataImportService,
  DataImportStateError,
} from "~/platform/operations/data-import-service.server";

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

async function createRoomImportEvent(suffix: string) {
  const eventId = `event-room-import-${suffix}`;
  const roomId = `room-import-${suffix}`;
  const roomName = `Import room ${suffix}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO events (
         id, organisation_id, name, slug, timezone, starts_at, ends_at,
         session_formats_json, file_policy_json
       ) VALUES (?, ?, ?, ?, 'UTC', 1760000000, 1760086400, ?, ?)`,
    ).bind(
      eventId,
      viewer.organisationId,
      `Room import event ${suffix}`,
      `room-import-event-${suffix}`,
      INITIAL_EVENT_SESSION_FORMATS_JSON,
      CANONICAL_EVENT_FILE_POLICY_JSON,
    ),
    env.DB.prepare(
      `INSERT INTO rooms (
         id, event_id, name, capacity, position, status
       ) VALUES (?, ?, ?, 100, 0, 'active')`,
    ).bind(roomId, eventId, roomName),
  ]);
  return {
    eventId,
    roomId,
    roomName,
    viewer: { ...viewer, eventId },
  };
}

async function addPublishedRoomUse(
  eventId: string,
  roomId: string,
  suffix: string,
  expectedAttendance: number,
) {
  const sessionId = `session-room-import-${suffix}`;
  const versionId = `schedule-room-import-${suffix}`;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE schedule_policies
          SET capacity_action = 'block', updated_at = unixepoch()
        WHERE event_id = ?`,
    ).bind(eventId),
    env.DB.prepare(
      `INSERT INTO sessions (
         id, event_id, title, slug, format, duration_minutes,
         expected_attendance, status, visibility
       ) VALUES (?, ?, ?, ?, 'presentation', 45, ?, 'published', 'public')`,
    ).bind(
      sessionId,
      eventId,
      `Scheduled import session ${suffix}`,
      `scheduled-import-session-${suffix}`,
      expectedAttendance,
    ),
    env.DB.prepare(
      `INSERT INTO schedule_versions (
         id, event_id, version_number, name, status, created_by_person_id,
         published_at
       ) VALUES (?, ?, 1, 'Import guard schedule', 'published', ?, unixepoch())`,
    ).bind(versionId, eventId, viewer.personId),
    env.DB.prepare(
      `INSERT INTO schedule_entries (
         id, event_id, schedule_version_id, session_id, room_id,
         starts_at, ends_at
       ) VALUES (?, ?, ?, ?, ?, 1760010000, 1760012700)`,
    ).bind(
      `entry-room-import-${suffix}`,
      eventId,
      versionId,
      sessionId,
      roomId,
    ),
  ]);
}

describe("CSV imports", () => {
  beforeEach(async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    await env.DB.prepare(
      "DELETE FROM operation_jobs WHERE event_id = ? AND type = 'data.import'",
    )
      .bind(viewer.eventId)
      .run();
  });

  describe("people and membership imports", () => {
    it("persists a people preview and commits it only after explicit confirmation", async () => {
      const service = new DataImportService(
        env as unknown as CloudflareEnvironment,
      );
      const preview = await service.preview(viewer, {
        resource: "people",
        fileName: "people.csv",
        csv: [
          "email,name,organisation,jobTitle,profileStatus,role",
          "new.speaker@example.com,New Speaker,Example Org,Engineer,draft,speaker",
        ].join("\n"),
      });
      expect(preview).toMatchObject({ validCount: 1, invalidCount: 0 });
      expect(
        await env.DB.prepare("SELECT id FROM people WHERE email = ?")
          .bind("new.speaker@example.com")
          .first(),
      ).toBeNull();

      await service.confirm(viewer, preview.operationId);
      const person = await env.DB.prepare(
        "SELECT id, display_name AS name, last_operation_id AS operationId FROM people WHERE email = ?",
      )
        .bind("new.speaker@example.com")
        .first<{ id: string; name: string; operationId: string }>();
      expect(person).toMatchObject({
        name: "New Speaker",
        operationId: preview.operationId,
      });
      expect(
        await env.DB.prepare(
          "SELECT role, accepted_at AS acceptedAt FROM memberships WHERE event_id = ? AND person_id = ?",
        )
          .bind(viewer.eventId, person?.id)
          .first(),
      ).toEqual({ role: "speaker", acceptedAt: null });
      expect(
        await env.DB.prepare(
          "SELECT status, progress_completed AS completed FROM operation_jobs WHERE id = ?",
        )
          .bind(preview.operationId)
          .first(),
      ).toEqual({ status: "completed", completed: 1 });
      expect(
        await env.DB.prepare(
          `SELECT entity_type AS entityType, entity_id AS entityId
             FROM operation_items WHERE operation_id = ?`,
        )
          .bind(preview.operationId)
          .first(),
      ).toEqual({ entityType: "person", entityId: person?.id });
      expect(
        await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM audit_events
            WHERE action = 'data_import.record_upserted'
              AND entity_type = 'person' AND entity_id = ?`,
        )
          .bind(person?.id)
          .first(),
      ).toEqual({ count: 1 });

      const repeated = await service.preview(viewer, {
        resource: "people",
        fileName: "people-again.csv",
        csv: [
          "email,name,organisation,jobTitle,profileStatus,role",
          "new.speaker@example.com,New Speaker,Example Org,Engineer,draft,speaker",
        ].join("\n"),
      });
      await service.confirm(viewer, repeated.operationId);
      expect(
        await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM memberships
            WHERE event_id = ? AND person_id = ? AND role = 'speaker'
              AND revoked_at IS NULL`,
        )
          .bind(viewer.eventId, person?.id)
          .first(),
      ).toEqual({ count: 1 });
    });

    it("resolves existing people and memberships by normalized email keys", async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const personId = `person-mixed-email-${suffix}`;
      const membershipId = `membership-mixed-email-${suffix}`;
      const storedEmail = `Mixed-${suffix}@Example.COM`;
      const importedEmail = storedEmail.toLowerCase();
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO people (
             id, email, display_name, organisation_name, job_title,
             profile_status, profile_revision
           ) VALUES (?, ?, 'Mixed Case Person', 'Example Org', 'Engineer',
                     'published', 3)`,
        ).bind(personId, storedEmail),
        env.DB.prepare(
          `INSERT INTO memberships (
             id, organisation_id, event_id, person_id, role, invited_at,
             accepted_at
           ) VALUES (?, ?, ?, ?, 'speaker', unixepoch(), unixepoch())`,
        ).bind(membershipId, viewer.organisationId, viewer.eventId, personId),
      ]);
      const service = new DataImportService(
        env as unknown as CloudflareEnvironment,
      );
      const preview = await service.preview(viewer, {
        resource: "people",
        fileName: "mixed-case-email.csv",
        csv: [
          "email,name,organisation,jobTitle,profileStatus,role",
          `${importedEmail},Mixed Case Person,Example Org,Engineer,published,speaker`,
        ].join("\n"),
      });
      expect(preview).toMatchObject({ validCount: 1, invalidCount: 0 });

      await service.confirm(viewer, preview.operationId);

      await expect(
        env.DB.prepare(
          `SELECT person.id, person.email, membership.id AS membershipId,
                  membership.accepted_at AS acceptedAt
             FROM people person
             JOIN memberships membership ON membership.person_id = person.id
            WHERE person.email = ? COLLATE NOCASE
              AND membership.event_id = ? AND membership.role = 'speaker'`,
        )
          .bind(importedEmail, viewer.eventId)
          .first(),
      ).resolves.toEqual({
        id: personId,
        email: storedEmail,
        membershipId,
        acceptedAt: expect.any(Number),
      });
      await expect(
        env.DB.prepare(
          "SELECT COUNT(*) AS total FROM people WHERE email = ? COLLATE NOCASE",
        )
          .bind(importedEmail)
          .first(),
      ).resolves.toEqual({ total: 1 });
    });

    it("links an existing person without rewriting a profile shared with another event", async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const personId = `person-people-import-${suffix}`;
      const email = `shared-person-${suffix}@example.com`;
      const otherOrganisationId = `org-people-import-${suffix}`;
      const otherEventId = `event-people-import-${suffix}`;
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO people (
             id, email, display_name, organisation_name, job_title,
             profile_status, profile_revision, last_operation_id, updated_at
           ) VALUES (?, ?, 'Canonical Person', 'Canonical Organisation',
                     'Canonical Role', 'published', 7, 'canonical-operation', 123)`,
        ).bind(personId, email),
        env.DB.prepare(
          `INSERT INTO memberships (
             id, organisation_id, event_id, person_id, role, invited_at,
             accepted_at
           ) VALUES (?, ?, ?, ?, 'speaker', unixepoch(), unixepoch())`,
        ).bind(
          `membership-current-people-import-${suffix}`,
          viewer.organisationId,
          viewer.eventId,
          personId,
        ),
        env.DB.prepare(
          `INSERT INTO organisations (id, name, slug)
           VALUES (?, 'Other organisation', ?)`,
        ).bind(otherOrganisationId, `other-organisation-${suffix}`),
        env.DB.prepare(
          `INSERT INTO events (
             id, organisation_id, name, slug, timezone, starts_at, ends_at,
             file_policy_json
           ) VALUES (?, ?, 'Other event', ?, 'UTC', 1760000000, 1760086400, ?)`,
        ).bind(
          otherEventId,
          otherOrganisationId,
          `other-event-${suffix}`,
          CANONICAL_EVENT_FILE_POLICY_JSON,
        ),
        env.DB.prepare(
          `INSERT INTO memberships (
             id, organisation_id, event_id, person_id, role, invited_at,
             accepted_at
           ) VALUES (?, ?, ?, ?, 'speaker', unixepoch(), unixepoch())`,
        ).bind(
          `membership-people-import-${suffix}`,
          otherOrganisationId,
          otherEventId,
          personId,
        ),
      ]);

      const service = new DataImportService(
        env as unknown as CloudflareEnvironment,
      );
      const rejected = await service.preview(viewer, {
        resource: "people",
        fileName: "shared-person.csv",
        csv: [
          "email,name,organisation,jobTitle,profileStatus,role",
          `${email},Event-local Name,Event-local Organisation,Event-local Role,archived,evaluator`,
        ].join("\n"),
      });
      expect(rejected).toMatchObject({ validCount: 0, invalidCount: 1 });
      await expect(
        env.DB.prepare(
          `SELECT status, error_message AS errorMessage
             FROM operation_items WHERE operation_id = ?`,
        )
          .bind(rejected.operationId)
          .first(),
      ).resolves.toMatchObject({
        status: "failed",
        errorMessage: expect.stringContaining(
          "profile fields must match the existing identity",
        ),
      });

      const preview = await service.preview(viewer, {
        resource: "people",
        fileName: "shared-person-link.csv",
        csv: [
          "email,name,organisation,jobTitle,profileStatus,role",
          `${email},Canonical Person,Canonical Organisation,Canonical Role,published,evaluator`,
        ].join("\n"),
      });
      await expect(
        env.DB.prepare(
          `SELECT json_extract(result_json, '$.action') AS action
             FROM operation_items WHERE operation_id = ?`,
        )
          .bind(preview.operationId)
          .first(),
      ).resolves.toEqual({ action: "link" });

      await service.confirm(viewer, preview.operationId);

      await expect(
        env.DB.prepare(
          `SELECT display_name AS name, organisation_name AS organisation,
                  job_title AS jobTitle, profile_status AS profileStatus,
                  profile_revision AS revision,
                  last_operation_id AS operationId, updated_at AS updatedAt
             FROM people WHERE id = ?`,
        )
          .bind(personId)
          .first(),
      ).resolves.toEqual({
        name: "Canonical Person",
        organisation: "Canonical Organisation",
        jobTitle: "Canonical Role",
        profileStatus: "published",
        revision: 7,
        operationId: "canonical-operation",
        updatedAt: 123,
      });
      await expect(
        env.DB.prepare(
          `SELECT accepted_at AS acceptedAt
             FROM memberships
            WHERE event_id = ? AND person_id = ? AND role = 'evaluator'`,
        )
          .bind(viewer.eventId, personId)
          .first(),
      ).resolves.toEqual({ acceptedAt: null });
    });

    it("imports privileged membership as a finite pending invitation requiring explicit acceptance", async () => {
      await env.DB.prepare(
        `DELETE FROM memberships
          WHERE organisation_id = ? AND event_id = ? AND person_id = ?
            AND role = 'administrator'`,
      )
        .bind(viewer.organisationId, viewer.eventId, viewer.personId)
        .run();
      const service = new DataImportService(
        env as unknown as CloudflareEnvironment,
      );
      const preview = await service.preview(viewer, {
        resource: "people",
        fileName: "privileged-person.csv",
        csv: [
          "email,name,organisation,jobTitle,profileStatus,role",
          "sbek-organizer@example.com,Jordan Alvarez,,,published,administrator",
        ].join("\n"),
      });
      expect(preview).toMatchObject({ validCount: 1, invalidCount: 0 });

      await service.confirm(viewer, preview.operationId);
      const invitation = await env.DB.prepare(
        `SELECT invited_at AS invitedAt,
                invitation_expires_at AS invitationExpiresAt,
                accepted_at AS acceptedAt
           FROM memberships
          WHERE organisation_id = ? AND event_id = ? AND person_id = ?
            AND role = 'administrator' AND revoked_at IS NULL`,
      )
        .bind(viewer.organisationId, viewer.eventId, viewer.personId)
        .first<{
          invitedAt: number;
          invitationExpiresAt: number | null;
          acceptedAt: number | null;
        }>();
      expect(invitation).toMatchObject({
        invitedAt: expect.any(Number),
        invitationExpiresAt: expect.any(Number),
        acceptedAt: null,
      });
      expect(invitation!.invitationExpiresAt! - invitation!.invitedAt).toBe(
        7 * 24 * 60 * 60,
      );

      const readRequest = new Request("http://localhost/admin/event", {
        headers: { cookie: "program_cue_demo_identity=administrator" },
      });
      await expect(
        requireEventRole(
          readRequest,
          env as unknown as CloudflareEnvironment,
          viewer.eventId,
          ["administrator"],
        ),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        acceptEventInvitation(
          new Request("http://localhost/events/select", {
            method: "POST",
            headers: {
              cookie: "program_cue_demo_identity=administrator",
              origin: "http://localhost",
            },
          }),
          env as unknown as CloudflareEnvironment,
          viewer.eventId,
          ["administrator"],
        ),
      ).resolves.toMatchObject({ role: "administrator" });
    });

    it("renews revoked and expired memberships instead of reporting a false successful import", async () => {
      const suffix = crypto.randomUUID();
      const revokedPersonId = `import-revoked-person-${suffix}`;
      const expiredPersonId = `import-expired-person-${suffix}`;
      const revokedMembershipId = `import-revoked-membership-${suffix}`;
      const expiredMembershipId = `import-expired-membership-${suffix}`;
      const revokedEmail = `import-revoked-${suffix}@example.com`;
      const expiredEmail = `import-expired-${suffix}@example.com`;
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO people (id, email, display_name, email_verified, profile_status)
           VALUES (?, ?, 'Existing Revoked Identity', 1, 'published')`,
        ).bind(revokedPersonId, revokedEmail),
        env.DB.prepare(
          `INSERT INTO people (id, email, display_name, email_verified, profile_status)
           VALUES (?, ?, 'Existing Pending Identity', 1, 'published')`,
        ).bind(expiredPersonId, expiredEmail),
        env.DB.prepare(
          `INSERT INTO memberships (
             id, organisation_id, event_id, person_id, role, invited_at,
             invitation_expires_at, accepted_at, revoked_at
           ) VALUES (?, ?, ?, ?, 'speaker', unixepoch() - 300,
                     unixepoch() - 200, unixepoch() - 250, unixepoch() - 100)`,
        ).bind(
          revokedMembershipId,
          viewer.organisationId,
          viewer.eventId,
          revokedPersonId,
        ),
        env.DB.prepare(
          `INSERT INTO memberships (
             id, organisation_id, event_id, person_id, role, invited_at,
             invitation_expires_at, accepted_at, revoked_at
           ) VALUES (?, ?, ?, ?, 'speaker', unixepoch() - 300,
                     unixepoch() - 100, NULL, NULL)`,
        ).bind(
          expiredMembershipId,
          viewer.organisationId,
          viewer.eventId,
          expiredPersonId,
        ),
      ]);

      const service = new DataImportService(
        env as unknown as CloudflareEnvironment,
      );
      const preview = await service.preview(viewer, {
        resource: "people",
        fileName: "historical-memberships.csv",
        csv: [
          "email,name,organisation,jobTitle,profileStatus,role",
          `${revokedEmail},Existing Revoked Identity,,,published,speaker`,
          `${expiredEmail},Existing Pending Identity,,,published,speaker`,
        ].join("\n"),
      });
      await expect(
        service.confirm(viewer, preview.operationId),
      ).resolves.toEqual({
        operationId: preview.operationId,
        resource: "people",
        rowCount: 2,
      });

      const memberships = await env.DB.prepare(
        `SELECT id, accepted_at AS acceptedAt, revoked_at AS revokedAt,
                invitation_expires_at AS invitationExpiresAt
           FROM memberships
          WHERE id IN (?, ?)
          ORDER BY id`,
      )
        .bind(expiredMembershipId, revokedMembershipId)
        .all<{
          id: string;
          acceptedAt: number | null;
          revokedAt: number | null;
          invitationExpiresAt: number | null;
        }>();
      expect(memberships.results).toHaveLength(2);
      for (const membership of memberships.results) {
        expect(membership).toMatchObject({
          acceptedAt: null,
          revokedAt: null,
          invitationExpiresAt: expect.any(Number),
        });
        expect(membership.invitationExpiresAt).toBeGreaterThan(
          Math.floor(Date.now() / 1_000),
        );
      }
      await expect(
        env.DB.prepare(
          `SELECT display_name AS name, profile_status AS profileStatus
             FROM people WHERE id IN (?, ?) ORDER BY id`,
        )
          .bind(expiredPersonId, revokedPersonId)
          .all(),
      ).resolves.toMatchObject({
        results: [
          { name: "Existing Pending Identity", profileStatus: "published" },
          { name: "Existing Revoked Identity", profileStatus: "published" },
        ],
      });
    });
  });

  describe("people and membership imports", () => {
    it("imports a speaker-target task without broadening the email identity lookup", async () => {
      const speaker = await env.DB.prepare(
        `SELECT person_id AS personId
           FROM memberships
          WHERE event_id = ? AND role = 'speaker'
            AND accepted_at IS NOT NULL AND revoked_at IS NULL
          LIMIT 1`,
      )
        .bind(viewer.eventId)
        .first<{ personId: string }>();
      expect(speaker).not.toBeNull();
      const taskId = `speaker-target-import-${crypto.randomUUID().slice(0, 8)}`;
      const service = new DataImportService(
        env as unknown as CloudflareEnvironment,
      );
      const preview = await service.preview(viewer, {
        resource: "tasks",
        fileName: "speaker-task.csv",
        csv: [
          "id,title,description,targetType,targetId,ownerEmail,status,impact,dueAt",
          `${taskId},Speaker task,,speaker,${speaker!.personId},,not_started,medium,`,
        ].join("\n"),
      });
      expect(preview).toMatchObject({ validCount: 1, invalidCount: 0 });

      await service.confirm(viewer, preview.operationId);

      await expect(
        env.DB.prepare(
          `SELECT target_type AS targetType, target_id AS targetId
             FROM task_instances WHERE id = ? AND event_id = ?`,
        )
          .bind(taskId, viewer.eventId)
          .first(),
      ).resolves.toEqual({
        targetType: "speaker",
        targetId: speaker!.personId,
      });
    });
  });

  describe("people and membership imports", () => {
    it("rejects stale previews for people, submissions, rooms, tracks and tasks", async () => {
      const service = new DataImportService(
        env as unknown as CloudflareEnvironment,
      );
      const suffix = crypto.randomUUID().slice(0, 8);

      const personEmail = `import-race-${suffix}@example.com`;
      const personPreview = await service.preview(viewer, {
        resource: "people",
        fileName: "people-race.csv",
        csv: [
          "email,name,organisation,jobTitle,profileStatus,role",
          `${personEmail},Previewed Person,Example,Engineer,draft,speaker`,
        ].join("\n"),
      });
      await env.DB.prepare(
        `INSERT INTO people (id, email, display_name, profile_status)
         VALUES (?, ?, 'Concurrent Person', 'draft')`,
      )
        .bind(`person-import-race-${suffix}`, personEmail)
        .run();
      await expect(
        service.confirm(viewer, personPreview.operationId),
      ).rejects.toThrow("changed after preview");
      await expect(
        env.DB.prepare(
          "SELECT display_name AS name FROM people WHERE email = ?",
        )
          .bind(personEmail)
          .first(),
      ).resolves.toEqual({ name: "Concurrent Person" });

      const submissionId = `submission-import-race-${suffix}`;
      const publicReference = `IMPORT-${suffix}`;
      await env.DB.prepare(
        `INSERT INTO submissions (
           id, event_id, public_reference, title, status, answers_json, revision
         ) VALUES (?, ?, ?, 'Original title', 'draft', '{}', 1)`,
      )
        .bind(submissionId, viewer.eventId, publicReference)
        .run();
      const submissionPreview = await service.preview(viewer, {
        resource: "submissions",
        fileName: "submissions-race.csv",
        csv: [
          "publicReference,title,category,format,status,submitterEmail,submittedAt",
          `${publicReference},Previewed title,,,draft,,`,
        ].join("\n"),
      });
      await env.DB.prepare(
        "UPDATE submissions SET title = 'Concurrent title', revision = 2 WHERE id = ? AND event_id = ?",
      )
        .bind(submissionId, viewer.eventId)
        .run();
      await expect(
        service.confirm(viewer, submissionPreview.operationId),
      ).rejects.toThrow("changed after preview");
      await expect(
        env.DB.prepare(
          "SELECT title, revision FROM submissions WHERE id = ? AND event_id = ?",
        )
          .bind(submissionId, viewer.eventId)
          .first(),
      ).resolves.toEqual({ title: "Concurrent title", revision: 2 });

      const roomName = `Import race room ${suffix}`;
      const roomPreview = await service.preview(viewer, {
        resource: "rooms",
        fileName: "rooms-race.csv",
        csv: [
          "name,building,level,capacity,position,status",
          `${roomName},North,1,100,0,active`,
        ].join("\n"),
      });
      await env.DB.prepare(
        `INSERT INTO rooms (
           id, event_id, name, building, level, capacity, position, status
         ) VALUES (?, ?, ?, 'South', '2', 50, 1, 'active')`,
      )
        .bind(`room-import-race-${suffix}`, viewer.eventId, roomName)
        .run();
      await expect(
        service.confirm(viewer, roomPreview.operationId),
      ).rejects.toThrow("changed after preview");

      const trackSlug = `import-race-${suffix}`;
      const trackPreview = await service.preview(viewer, {
        resource: "tracks",
        fileName: "tracks-race.csv",
        csv: [
          "slug,name,colour,position,exclusive,public",
          `${trackSlug},Previewed track,,0,false,true`,
        ].join("\n"),
      });
      await env.DB.prepare(
        `INSERT INTO tracks (id, event_id, name, slug, position, exclusive, is_public)
         VALUES (?, ?, 'Concurrent track', ?, 1, 0, 1)`,
      )
        .bind(`track-import-race-${suffix}`, viewer.eventId, trackSlug)
        .run();
      await expect(
        service.confirm(viewer, trackPreview.operationId),
      ).rejects.toThrow("changed after preview");

      const taskId = `task-import-race-${suffix}`;
      await env.DB.prepare(
        `INSERT INTO task_instances (
           id, event_id, target_type, target_id, title, task_type, impact,
           status, readiness_state, readiness_percent, revision
         ) VALUES (?, ?, 'event', ?, 'Original task', 'checklist', 'medium',
                   'not_started', 'on_track', 0, 1)`,
      )
        .bind(taskId, viewer.eventId, viewer.eventId)
        .run();
      const taskPreview = await service.preview(viewer, {
        resource: "tasks",
        fileName: "tasks-race.csv",
        csv: [
          "id,title,description,targetType,targetId,ownerEmail,status,impact,dueAt",
          `${taskId},Previewed task,,event,${viewer.eventId},,not_started,medium,`,
        ].join("\n"),
      });
      await env.DB.prepare(
        "UPDATE task_instances SET title = 'Concurrent task', revision = 2 WHERE id = ? AND event_id = ?",
      )
        .bind(taskId, viewer.eventId)
        .run();
      await expect(
        service.confirm(viewer, taskPreview.operationId),
      ).rejects.toThrow("changed after preview");
      await expect(
        env.DB.prepare(
          "SELECT title, revision FROM task_instances WHERE id = ? AND event_id = ?",
        )
          .bind(taskId, viewer.eventId)
          .first(),
      ).resolves.toEqual({ title: "Concurrent task", revision: 2 });
    });
  });
});
