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
          "olivia@example.com,Olivia Bennett,,,published,administrator",
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
        headers: { cookie: "program_cue_demo_role=administrator" },
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
              cookie: "program_cue_demo_role=administrator",
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

  describe("submission imports", () => {
    it("rejects submission lifecycle states that require the evaluation and decision workflows", async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const existingReference = `IMPORT-ACCEPTED-${suffix}`;
      await env.DB.prepare(
        `INSERT INTO submissions (
         id, event_id, public_reference, title, status, answers_json,
         submitted_snapshot_json, submitted_at
       ) VALUES (?, ?, ?, 'Released decision', 'accepted', '{}', '{}', unixepoch())`,
      )
        .bind(
          `submission-import-accepted-${suffix}`,
          viewer.eventId,
          existingReference,
        )
        .run();

      const preview = await new DataImportService(
        env as unknown as CloudflareEnvironment,
      ).preview(viewer, {
        resource: "submissions",
        fileName: "submission-lifecycle.csv",
        csv: [
          "publicReference,title,category,format,status,submitterEmail,submittedAt",
          `${existingReference},Attempted reopen,,,draft,,`,
          `IMPORT-NEW-ACCEPTED-${suffix},Attempted acceptance,,,accepted,,2026-08-10T12:00:00Z`,
        ].join("\n"),
      });

      expect(preview).toMatchObject({ validCount: 0, invalidCount: 2 });
      const items = await env.DB.prepare(
        `SELECT error_message AS errorMessage
         FROM operation_items WHERE operation_id = ? ORDER BY item_key`,
      )
        .bind(preview.operationId)
        .all<{ errorMessage: string }>();
      expect(items.results[0]?.errorMessage).toContain(
        "must be changed through the submission, evaluation or decision workflow",
      );
      expect(items.results[1]?.errorMessage).toContain("must be draft");
      await expect(
        new DataImportService(env as unknown as CloudflareEnvironment).confirm(
          viewer,
          preview.operationId,
        ),
      ).rejects.toBeInstanceOf(DataImportStateError);
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

  describe("task imports", () => {
    it("rejects invalid task lifecycle changes and task IDs owned by another event", async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const otherEventId = `event-import-task-${suffix}`;
      const crossEventTaskId = `task-cross-event-${suffix}`;
      const currentTaskId = `task-current-event-${suffix}`;
      const unblockedTaskId = `task-unblocked-${suffix}`;
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO events (
           id, organisation_id, name, slug, timezone, starts_at, ends_at,
           brand_accent, session_formats_json, file_policy_json
         ) SELECT ?, organisation_id, 'Import collision event', ?, timezone,
                  starts_at, ends_at, brand_accent, session_formats_json,
                  file_policy_json
             FROM events WHERE id = ? AND organisation_id = ?`,
        ).bind(
          otherEventId,
          `import-collision-${suffix}`,
          viewer.eventId,
          viewer.organisationId,
        ),
        env.DB.prepare(
          `INSERT INTO task_instances (
           id, event_id, target_type, target_id, title, task_type, impact,
           status, readiness_state, readiness_percent, revision
         ) VALUES (?, ?, 'event', ?, 'Other event task', 'checklist', 'medium',
                   'not_started', 'on_track', 0, 1)`,
        ).bind(crossEventTaskId, otherEventId, otherEventId),
        env.DB.prepare(
          `INSERT INTO task_instances (
           id, event_id, target_type, target_id, title, task_type, impact,
           status, readiness_state, readiness_percent, revision
         ) VALUES (?, ?, 'event', ?, 'Completed task', 'checklist', 'medium',
                   'completed', 'on_track', 100, 1)`,
        ).bind(currentTaskId, viewer.eventId, viewer.eventId),
        env.DB.prepare(
          `INSERT INTO task_instances (
           id, event_id, target_type, target_id, title, task_type, impact,
           status, readiness_state, readiness_percent, revision
         ) VALUES (?, ?, 'event', ?, 'Unblocked task', 'checklist', 'medium',
                   'not_started', 'on_track', 0, 1)`,
        ).bind(unblockedTaskId, viewer.eventId, viewer.eventId),
      ]);

      const preview = await new DataImportService(
        env as unknown as CloudflareEnvironment,
      ).preview(viewer, {
        resource: "tasks",
        fileName: "task-lifecycle.csv",
        csv: [
          "id,title,description,targetType,targetId,ownerEmail,status,impact,dueAt",
          `${crossEventTaskId},Collision,,event,${viewer.eventId},,not_started,medium,`,
          `${currentTaskId},Attempted progress,,event,${viewer.eventId},,in_progress,medium,`,
          `task-new-completed-${suffix},Attempted completion,,event,${viewer.eventId},,completed,medium,`,
          `${unblockedTaskId},Attempted block,,event,${viewer.eventId},,blocked,medium,`,
        ].join("\n"),
      });

      expect(preview).toMatchObject({ validCount: 0, invalidCount: 4 });
      const errors = await env.DB.prepare(
        `SELECT error_message AS errorMessage
         FROM operation_items WHERE operation_id = ? ORDER BY item_key`,
      )
        .bind(preview.operationId)
        .all<{ errorMessage: string }>();
      expect(errors.results.map((row) => row.errorMessage)).toEqual([
        "id is already owned by a task in another event",
        "a completed task cannot transition to in progress by CSV import",
        "a new task must start in not_started status; import later lifecycle changes against its assigned id",
        "blocked status requires at least one unfinished prerequisite task",
      ]);
    });

    it("applies explicit task completion, waiver and reopen lifecycle transitions", async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const completedTaskId = `task-import-complete-${suffix}`;
      const waivedTaskId = `task-import-waive-${suffix}`;
      const reopenedTaskId = `task-import-reopen-${suffix}`;
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO task_instances (
           id, event_id, target_type, target_id, title, task_type, impact,
           status, readiness_state, readiness_percent, revision
         ) VALUES (?, ?, 'event', ?, 'Import completion', 'checklist', 'high',
                   'in_progress', 'at_risk', 40, 1)`,
        ).bind(completedTaskId, viewer.eventId, viewer.eventId),
        env.DB.prepare(
          `INSERT INTO task_instances (
           id, event_id, target_type, target_id, title, task_type, impact,
           status, readiness_state, readiness_percent, revision
         ) VALUES (?, ?, 'event', ?, 'Import waiver', 'checklist', 'medium',
                   'not_started', 'on_track', 0, 1)`,
        ).bind(waivedTaskId, viewer.eventId, viewer.eventId),
        env.DB.prepare(
          `INSERT INTO task_instances (
           id, event_id, target_type, target_id, title, task_type, impact,
           status, readiness_state, readiness_percent, revision,
           waiver_json, completed_at, completed_by_person_id
         ) VALUES (?, ?, 'event', ?, 'Import reopen', 'checklist', 'low',
                   'waived', 'on_track', 100, 1,
                   '{"reason":"Previous waiver","by":"person-demo-admin"}',
                   unixepoch(), ?)`,
        ).bind(reopenedTaskId, viewer.eventId, viewer.eventId, viewer.personId),
      ]);

      const service = new DataImportService(
        env as unknown as CloudflareEnvironment,
      );
      const preview = await service.preview(viewer, {
        resource: "tasks",
        fileName: "task-statuses.csv",
        csv: [
          "id,title,description,targetType,targetId,ownerEmail,status,statusReason,impact,dueAt",
          `${completedTaskId},Imported completion,,event,${viewer.eventId},,completed,,high,`,
          `${waivedTaskId},Imported waiver,,event,${viewer.eventId},,waived,No longer required,medium,`,
          `${reopenedTaskId},Imported reopen,,event,${viewer.eventId},,not_started,,low,`,
        ].join("\n"),
      });
      expect(preview).toMatchObject({ validCount: 3, invalidCount: 0 });

      await service.confirm(viewer, preview.operationId);
      const tasks = await env.DB.prepare(
        `SELECT id, status, readiness_state AS readinessState,
              readiness_percent AS readinessPercent, revision,
              waiver_json AS waiverJson, completed_at AS completedAt,
              completed_by_person_id AS completedByPersonId,
              last_operation_id AS operationId
         FROM task_instances
        WHERE id IN (?, ?, ?) ORDER BY id`,
      )
        .bind(completedTaskId, waivedTaskId, reopenedTaskId)
        .all<{
          id: string;
          status: string;
          readinessState: string;
          readinessPercent: number;
          revision: number;
          waiverJson: string | null;
          completedAt: number | null;
          completedByPersonId: string | null;
          operationId: string;
        }>();
      const byId = Object.fromEntries(
        tasks.results.map((task) => [task.id, task]),
      );
      expect(byId[completedTaskId]).toMatchObject({
        status: "completed",
        readinessState: "on_track",
        readinessPercent: 100,
        revision: 2,
        completedByPersonId: viewer.personId,
        operationId: preview.operationId,
      });
      expect(byId[completedTaskId]?.completedAt).toEqual(expect.any(Number));
      expect(byId[waivedTaskId]).toMatchObject({
        status: "waived",
        readinessState: "on_track",
        readinessPercent: 100,
        revision: 2,
        completedByPersonId: viewer.personId,
        operationId: preview.operationId,
      });
      expect(JSON.parse(byId[waivedTaskId]!.waiverJson!)).toEqual({
        reason: "No longer required",
        by: viewer.personId,
      });
      expect(byId[reopenedTaskId]).toMatchObject({
        status: "not_started",
        readinessState: "on_track",
        readinessPercent: 0,
        revision: 2,
        waiverJson: null,
        completedAt: null,
        completedByPersonId: null,
        operationId: preview.operationId,
      });
      const lifecycleAudits = await env.DB.prepare(
        `SELECT action FROM audit_events
        WHERE event_id = ? AND correlation_id = ?
          AND entity_type = 'task_instance'
        ORDER BY action`,
      )
        .bind(viewer.eventId, preview.operationId)
        .all<{ action: string }>();
      expect(lifecycleAudits.results.map((row) => row.action)).toEqual([
        "task.complete",
        "task.reopen",
        "task.waive",
      ]);
    });

    it("fails before mutation when webhook fan-out would exceed the D1 query budget", async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const taskIds = Array.from(
        { length: 66 },
        (_, index) => `task-import-budget-${suffix}-${index}`,
      );
      await env.DB.prepare("DELETE FROM webhook_endpoints WHERE event_id = ?")
        .bind(viewer.eventId)
        .run();
      await env.DB.batch(
        taskIds.map((taskId, index) =>
          env.DB.prepare(
            `INSERT INTO task_instances (
             id, event_id, target_type, target_id, title, task_type, impact,
             status, readiness_state, readiness_percent, revision
           ) VALUES (?, ?, 'event', ?, ?, 'checklist', 'medium',
                     'in_progress', 'at_risk', 40, 1)`,
          ).bind(
            taskId,
            viewer.eventId,
            viewer.eventId,
            `Budget task ${index}`,
          ),
        ),
      );
      const service = new DataImportService(
        env as unknown as CloudflareEnvironment,
      );
      const preview = await service.preview(viewer, {
        resource: "tasks",
        fileName: "task-budget.csv",
        csv: [
          "id,title,description,targetType,targetId,ownerEmail,status,statusReason,impact,dueAt",
          ...taskIds.map(
            (taskId, index) =>
              `${taskId},Budget task ${index},,event,${viewer.eventId},,completed,,medium,`,
          ),
        ].join("\n"),
      });
      await env.DB.prepare(
        `INSERT INTO webhook_endpoints (
         id, organisation_id, event_id, name, url, secret_ciphertext,
         event_types_json, status, failure_count, created_at, updated_at
       ) VALUES (?, ?, ?, 'Task import budget', 'https://example.com/webhook',
                 'test-ciphertext', '["task.updated"]', 'active', 0,
                 unixepoch(), unixepoch())`,
      )
        .bind(
          `webhook-import-budget-${suffix}`,
          viewer.organisationId,
          viewer.eventId,
        )
        .run();

      await expect(
        service.confirm(viewer, preview.operationId),
      ).rejects.toThrow("exceeds the safe D1 query budget");
      await expect(
        env.DB.prepare(
          "SELECT status, revision FROM task_instances WHERE id = ?",
        )
          .bind(taskIds[0])
          .first(),
      ).resolves.toEqual({ status: "in_progress", revision: 1 });
      await expect(
        env.DB.prepare("SELECT status FROM operation_jobs WHERE id = ?")
          .bind(preview.operationId)
          .first(),
      ).resolves.toEqual({ status: "received" });
    });

    it("rejects a cross-event task ID claimed after preview without reporting completion", async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const taskId = `task-late-cross-event-${suffix}`;
      const service = new DataImportService(
        env as unknown as CloudflareEnvironment,
      );
      const preview = await service.preview(viewer, {
        resource: "tasks",
        fileName: "task-id-race.csv",
        csv: [
          "id,title,description,targetType,targetId,ownerEmail,status,impact,dueAt",
          `${taskId},Previewed task,,event,${viewer.eventId},,not_started,medium,`,
        ].join("\n"),
      });
      expect(preview).toMatchObject({ validCount: 1, invalidCount: 0 });

      const otherEventId = `event-late-task-${suffix}`;
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO events (
           id, organisation_id, name, slug, timezone, starts_at, ends_at,
           brand_accent, session_formats_json, file_policy_json
         ) SELECT ?, organisation_id, 'Late task collision', ?, timezone,
                  starts_at, ends_at, brand_accent, session_formats_json,
                  file_policy_json
             FROM events WHERE id = ? AND organisation_id = ?`,
        ).bind(
          otherEventId,
          `late-task-collision-${suffix}`,
          viewer.eventId,
          viewer.organisationId,
        ),
        env.DB.prepare(
          `INSERT INTO task_instances (
           id, event_id, target_type, target_id, title, task_type, impact,
           status, readiness_state, readiness_percent, revision
         ) VALUES (?, ?, 'event', ?, 'Concurrent task', 'checklist', 'medium',
                   'not_started', 'on_track', 0, 1)`,
        ).bind(taskId, otherEventId, otherEventId),
      ]);

      await expect(
        service.confirm(viewer, preview.operationId),
      ).rejects.toThrow("changed after preview");
      await expect(
        env.DB.prepare(
          "SELECT status, progress_completed AS completed FROM operation_jobs WHERE id = ?",
        )
          .bind(preview.operationId)
          .first(),
      ).resolves.toEqual({ status: "received", completed: 0 });
    });
  });

  describe("additional workflow coverage", () => {
    it("shows row-level reconciliation errors and refuses confirmation", async () => {
      const service = new DataImportService(
        env as unknown as CloudflareEnvironment,
      );
      const preview = await service.preview(viewer, {
        resource: "sessions",
        fileName: "sessions.csv",
        csv: [
          "slug,title,description,trackSlug,format,durationMinutes,expectedAttendance,status,visibility",
          "missing-track,Missing track,,does-not-exist,presentation,45,100,unscheduled,public",
        ].join("\n"),
      });
      expect(preview).toMatchObject({ validCount: 0, invalidCount: 1 });
      expect(
        await env.DB.prepare(
          "SELECT status, error_code AS errorCode, error_message AS errorMessage FROM operation_items WHERE operation_id = ?",
        )
          .bind(preview.operationId)
          .first(),
      ).toMatchObject({
        status: "failed",
        errorCode: "VALIDATION_ERROR",
        errorMessage: "trackSlug does not match a track in this event",
      });
      await expect(
        service.confirm(viewer, preview.operationId),
      ).rejects.toBeInstanceOf(DataImportStateError);
    });
  });

  describe("event-configuration imports", () => {
    it("reports invalid session attendance in the preview instead of failing during commit", async () => {
      const preview = await new DataImportService(
        env as unknown as CloudflareEnvironment,
      ).preview(viewer, {
        resource: "sessions",
        fileName: "sessions.csv",
        csv: [
          "slug,title,description,trackSlug,format,durationMinutes,expectedAttendance,status,visibility",
          "negative-room,Negative attendance,,other,presentation,45,-2,unscheduled,public",
        ].join("\n"),
      });
      expect(preview).toMatchObject({ validCount: 0, invalidCount: 1 });
      expect(
        await env.DB.prepare(
          "SELECT error_message AS errorMessage FROM operation_items WHERE operation_id = ?",
        )
          .bind(preview.operationId)
          .first<{ errorMessage: string }>(),
      ).toMatchObject({
        errorMessage: expect.stringContaining("expectedAttendance"),
      });
    });
  });

  describe("task imports", () => {
    it("uses canonical room limits and strict RFC 3339 task timestamps", async () => {
      const service = new DataImportService(
        env as unknown as CloudflareEnvironment,
      );
      const roomPreview = await service.preview(viewer, {
        resource: "rooms",
        fileName: "invalid-rooms.csv",
        csv: [
          "name,building,level,capacity,position,status",
          `${"R".repeat(121)},,,,0,active`,
          "Oversized capacity,,,100001,1,active",
        ].join("\n"),
      });
      expect(roomPreview).toMatchObject({ validCount: 0, invalidCount: 2 });

      const taskPreview = await service.preview(viewer, {
        resource: "tasks",
        fileName: "invalid-task-dates.csv",
        csv: [
          "id,title,description,targetType,targetId,ownerEmail,status,impact,dueAt",
          `invalid-calendar-date,Invalid calendar date,,event,${viewer.eventId},,not_started,medium,2026-02-30T00:00:00Z`,
          `locale-date,Locale date,,event,${viewer.eventId},,not_started,medium,02/03/2026`,
        ].join("\n"),
      });
      expect(taskPreview).toMatchObject({ validCount: 0, invalidCount: 2 });
      const errors = await env.DB.prepare(
        `SELECT error_message AS errorMessage
         FROM operation_items WHERE operation_id = ? ORDER BY item_key`,
      )
        .bind(taskPreview.operationId)
        .all<{ errorMessage: string }>();
      expect(errors.results.map((row) => row.errorMessage)).toEqual([
        expect.stringContaining("RFC 3339"),
        expect.stringContaining("RFC 3339"),
      ]);
    });
  });

  describe("event-configuration imports", () => {
    it("rejects an ambiguous case-insensitive room name during preview", async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const firstId = `ambiguous-room-a-${suffix}`;
      const secondId = `ambiguous-room-b-${suffix}`;
      const roomName = `Ambiguous Room ${suffix}`;
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO rooms (id, event_id, name, capacity)
         VALUES (?, ?, ?, 100)`,
        ).bind(firstId, viewer.eventId, roomName),
        env.DB.prepare(
          `INSERT INTO rooms (id, event_id, name, capacity)
         VALUES (?, ?, ?, 100)`,
        ).bind(secondId, viewer.eventId, roomName.toLowerCase()),
      ]);
      try {
        const preview = await new DataImportService(
          env as unknown as CloudflareEnvironment,
        ).preview(viewer, {
          resource: "rooms",
          fileName: "ambiguous-room.csv",
          csv: [
            "name,building,level,capacity,position,status",
            `${roomName},,,100,0,active`,
          ].join("\n"),
        });
        expect(preview).toMatchObject({ validCount: 0, invalidCount: 1 });
        await expect(
          env.DB.prepare(
            `SELECT error_message AS errorMessage FROM operation_items
            WHERE operation_id = ?`,
          )
            .bind(preview.operationId)
            .first(),
        ).resolves.toEqual({
          errorMessage:
            "name matches multiple existing rooms; make room names unique before importing",
        });
      } finally {
        await env.DB.prepare("DELETE FROM rooms WHERE id IN (?, ?)")
          .bind(firstId, secondId)
          .run();
      }
    });

    it("blocks room retirement and insufficient capacity when a schedule uses the room", async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const fixture = await createRoomImportEvent(suffix);
      await addPublishedRoomUse(fixture.eventId, fixture.roomId, suffix, 90);
      const preview = await new DataImportService(
        env as unknown as CloudflareEnvironment,
      ).preview(fixture.viewer, {
        resource: "rooms",
        fileName: "schedule-invalid-rooms.csv",
        csv: [
          "name,building,level,capacity,position,status",
          `${fixture.roomName},,,100,0,retired`,
          `${fixture.roomName},,,80,0,active`,
        ].join("\n"),
      });
      expect(preview).toMatchObject({ validCount: 0, invalidCount: 2 });
      const errors = await env.DB.prepare(
        `SELECT error_message AS errorMessage
         FROM operation_items WHERE operation_id = ? ORDER BY item_key`,
      )
        .bind(preview.operationId)
        .all<{ errorMessage: string }>();
      expect(errors.results.map((row) => row.errorMessage)).toEqual([
        expect.stringContaining("cannot be retired"),
        expect.stringContaining("published schedule requirement of 90"),
      ]);
    });

    it("atomically blocks a room import when a published capacity requirement appears after revalidation", async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const fixture = await createRoomImportEvent(suffix);
      const preview = await new DataImportService(
        env as unknown as CloudflareEnvironment,
      ).preview(fixture.viewer, {
        resource: "rooms",
        fileName: "room-capacity-race.csv",
        csv: [
          "name,building,level,capacity,position,status",
          `${fixture.roomName},,,80,0,active`,
        ].join("\n"),
      });
      expect(preview).toMatchObject({ validCount: 1, invalidCount: 0 });

      let injected = false;
      const racingDb = new Proxy(env.DB, {
        get(target, property) {
          if (property === "batch") {
            return async (statements: D1PreparedStatement[]) => {
              if (!injected) {
                injected = true;
                await addPublishedRoomUse(
                  fixture.eventId,
                  fixture.roomId,
                  suffix,
                  90,
                );
              }
              return target.batch(statements);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const racingEnvironment = new Proxy(env, {
        get(target, property) {
          return property === "DB"
            ? racingDb
            : Reflect.get(target, property, target);
        },
      });

      await expect(
        new DataImportService(
          racingEnvironment as unknown as CloudflareEnvironment,
        ).confirm(fixture.viewer, preview.operationId),
      ).rejects.toThrow("import changed before it could be confirmed");
      expect(injected).toBe(true);
      await expect(
        env.DB.prepare("SELECT capacity FROM rooms WHERE id = ?")
          .bind(fixture.roomId)
          .first(),
      ).resolves.toEqual({ capacity: 100 });
      await expect(
        env.DB.prepare("SELECT status FROM operation_jobs WHERE id = ?")
          .bind(preview.operationId)
          .first(),
      ).resolves.toEqual({ status: "received" });
    });

    it("uses the event's configured session formats and revalidates them on confirmation", async () => {
      const service = new DataImportService(
        env as unknown as CloudflareEnvironment,
      );
      const event = await env.DB.prepare(
        "SELECT session_formats_json AS sessionFormatsJson FROM events WHERE id = ? AND organisation_id = ?",
      )
        .bind(viewer.eventId, viewer.organisationId)
        .first<{ sessionFormatsJson: string }>();
      expect(event).not.toBeNull();
      const customFormats = JSON.stringify([
        {
          key: "fireside-chat",
          label: "Fireside chat",
          defaultDurationMinutes: 35,
          position: 0,
        },
      ]);
      const replacementFormats = JSON.stringify([
        {
          key: "roundtable",
          label: "Roundtable",
          defaultDurationMinutes: 50,
          position: 0,
        },
      ]);
      const csv = (slug: string, format: string) =>
        [
          "slug,title,description,trackSlug,format,durationMinutes,expectedAttendance,status,visibility",
          `${slug},Configured format,,,${format},42,,unscheduled,public`,
        ].join("\n");
      await env.DB.prepare(
        "UPDATE events SET session_formats_json = ? WHERE id = ? AND organisation_id = ?",
      )
        .bind(customFormats, viewer.eventId, viewer.organisationId)
        .run();
      try {
        const removedLegacy = await service.preview(viewer, {
          resource: "sessions",
          fileName: "legacy-format.csv",
          csv: csv("removed-legacy-format", "presentation"),
        });
        expect(removedLegacy).toMatchObject({ validCount: 0, invalidCount: 1 });
        expect(
          await env.DB.prepare(
            "SELECT error_message AS errorMessage FROM operation_items WHERE operation_id = ?",
          )
            .bind(removedLegacy.operationId)
            .first(),
        ).toEqual({ errorMessage: "format is not configured for this event" });

        const preview = await service.preview(viewer, {
          resource: "sessions",
          fileName: "custom-format.csv",
          csv: csv("configured-format-session", "fireside-chat"),
        });
        expect(preview).toMatchObject({ validCount: 1, invalidCount: 0 });
        await env.DB.prepare(
          "UPDATE events SET session_formats_json = ? WHERE id = ? AND organisation_id = ?",
        )
          .bind(replacementFormats, viewer.eventId, viewer.organisationId)
          .run();

        await expect(
          service.confirm(viewer, preview.operationId),
        ).rejects.toThrow("session format was removed after preview");
        expect(
          await env.DB.prepare("SELECT status FROM operation_jobs WHERE id = ?")
            .bind(preview.operationId)
            .first(),
        ).toEqual({ status: "received" });
        expect(
          await env.DB.prepare(
            "SELECT id FROM sessions WHERE event_id = ? AND slug = 'configured-format-session'",
          )
            .bind(viewer.eventId)
            .first(),
        ).toBeNull();
      } finally {
        await env.DB.prepare(
          "UPDATE events SET session_formats_json = ? WHERE id = ? AND organisation_id = ?",
        )
          .bind(
            event!.sessionFormatsJson,
            viewer.eventId,
            viewer.organisationId,
          )
          .run();
      }
    });

    it("atomically rejects a session import when lifecycle changes after revalidation", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      const existingId = `import-session-${crypto.randomUUID()}`;
      const existingSlug = `existing-${crypto.randomUUID()}`;
      const newSlug = `new-${crypto.randomUUID()}`;
      await testEnv.DB.prepare(
        `INSERT INTO sessions (
         id, event_id, title, slug, description, format, duration_minutes,
         status, visibility, revision, created_at, updated_at
       ) VALUES (?, ?, 'Original session', ?, 'Original description',
                 'presentation', 45, 'unscheduled', 'public', 1,
                 unixepoch(), unixepoch())`,
      )
        .bind(existingId, viewer.eventId, existingSlug)
        .run();
      const service = new DataImportService(testEnv);
      const preview = await service.preview(viewer, {
        resource: "sessions",
        fileName: "session-lifecycle-race.csv",
        csv: [
          "slug,title,description,trackSlug,format,durationMinutes,expectedAttendance,status,visibility",
          `${newSlug},New atomic row,,,presentation,45,,unscheduled,public`,
          `${existingSlug},Stale overwrite,,,presentation,60,,cancelled,public`,
        ].join("\n"),
      });
      expect(preview).toMatchObject({ validCount: 2, invalidCount: 0 });

      let injectedLifecycleChange = false;
      const racingDb = new Proxy(testEnv.DB, {
        get(target, property) {
          if (property === "batch") {
            return async (statements: D1PreparedStatement[]) => {
              if (!injectedLifecycleChange) {
                injectedLifecycleChange = true;
                await target
                  .prepare(
                    `UPDATE sessions
                      SET status = 'scheduled', revision = revision + 1,
                          updated_at = unixepoch()
                    WHERE id = ? AND event_id = ?`,
                  )
                  .bind(existingId, viewer.eventId)
                  .run();
              }
              return target.batch(statements);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const racingEnvironment = new Proxy(testEnv, {
        get(target, property) {
          return property === "DB"
            ? racingDb
            : Reflect.get(target, property, target);
        },
      });

      await expect(
        new DataImportService(racingEnvironment).confirm(
          viewer,
          preview.operationId,
        ),
      ).rejects.toThrow("import changed before it could be confirmed");
      expect(injectedLifecycleChange).toBe(true);
      await expect(
        testEnv.DB.prepare(
          "SELECT id FROM sessions WHERE event_id = ? AND slug = ?",
        )
          .bind(viewer.eventId, newSlug)
          .first(),
      ).resolves.toBeNull();
      await expect(
        testEnv.DB.prepare(
          "SELECT title, status, revision FROM sessions WHERE id = ? AND event_id = ?",
        )
          .bind(existingId, viewer.eventId)
          .first(),
      ).resolves.toEqual({
        title: "Original session",
        status: "scheduled",
        revision: 2,
      });
      await expect(
        testEnv.DB.prepare("SELECT status FROM operation_jobs WHERE id = ?")
          .bind(preview.operationId)
          .first(),
      ).resolves.toEqual({ status: "received" });
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

  describe("event-configuration imports", () => {
    it("rejects a new track-key race atomically before importing another row", async () => {
      const suffix = crypto.randomUUID().slice(0, 8);
      const safeSlug = `safe-track-${suffix}`;
      const racedSlug = `raced-track-${suffix}`;
      const preview = await new DataImportService(
        env as unknown as CloudflareEnvironment,
      ).preview(viewer, {
        resource: "tracks",
        fileName: "track-key-race.csv",
        csv: [
          "slug,name,colour,position,exclusive,public",
          `${safeSlug},Safe track,,0,false,true`,
          `${racedSlug},Previewed track,,1,false,true`,
        ].join("\n"),
      });

      let injected = false;
      const racingDb = new Proxy(env.DB, {
        get(target, property) {
          if (property === "batch") {
            return async (statements: D1PreparedStatement[]) => {
              if (!injected) {
                injected = true;
                await target
                  .prepare(
                    `INSERT INTO tracks (
                     id, event_id, name, slug, position, exclusive, is_public
                   ) VALUES (?, ?, 'Concurrent track', ?, 4, 0, 1)`,
                  )
                  .bind(`track-raced-${suffix}`, viewer.eventId, racedSlug)
                  .run();
              }
              return target.batch(statements);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const racingEnvironment = new Proxy(env, {
        get(target, property) {
          return property === "DB"
            ? racingDb
            : Reflect.get(target, property, target);
        },
      });

      await expect(
        new DataImportService(
          racingEnvironment as unknown as CloudflareEnvironment,
        ).confirm(viewer, preview.operationId),
      ).rejects.toThrow("import changed before it could be confirmed");
      expect(injected).toBe(true);
      await expect(
        env.DB.prepare("SELECT id FROM tracks WHERE event_id = ? AND slug = ?")
          .bind(viewer.eventId, safeSlug)
          .first(),
      ).resolves.toBeNull();
      await expect(
        env.DB.prepare(
          "SELECT name FROM tracks WHERE event_id = ? AND slug = ?",
        )
          .bind(viewer.eventId, racedSlug)
          .first(),
      ).resolves.toEqual({ name: "Concurrent track" });
    });

    it("rejects Airtable-authoritative programme imports before intent or data changes", async () => {
      const service = new DataImportService(
        env as unknown as CloudflareEnvironment,
      );
      const input = {
        resource: "sessions",
        fileName: "sessions.csv",
        csv: [
          "slug,title,description,trackSlug,format,durationMinutes,expectedAttendance,status,visibility",
          "authority-guard-session,Authority guard,,,presentation,45,,unscheduled,public",
        ].join("\n"),
      };
      await env.DB.prepare(
        "UPDATE events SET repository_provider = 'airtable' WHERE id = ? AND organisation_id = ?",
      )
        .bind(viewer.eventId, viewer.organisationId)
        .run();
      try {
        const before = await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM operation_jobs WHERE event_id = ? AND type = 'data.import'",
        )
          .bind(viewer.eventId)
          .first<{ count: number }>();
        for (const resource of [
          "people",
          "submissions",
          "rooms",
          "tracks",
          "tasks",
        ] as const) {
          await expect(
            service.preview(viewer, {
              resource,
              fileName: `${resource}.csv`,
              csv: "header\n",
            }),
          ).rejects.toThrow(
            `CSV import for ${resource} is unavailable while Airtable is authoritative`,
          );
        }
        await expect(service.preview(viewer, input)).rejects.toThrow(
          "CSV import for sessions is unavailable while Airtable is authoritative",
        );
        expect(
          await env.DB.prepare(
            "SELECT COUNT(*) AS count FROM operation_jobs WHERE event_id = ? AND type = 'data.import'",
          )
            .bind(viewer.eventId)
            .first(),
        ).toEqual(before);

        await env.DB.prepare(
          "UPDATE events SET repository_provider = 'd1' WHERE id = ? AND organisation_id = ?",
        )
          .bind(viewer.eventId, viewer.organisationId)
          .run();
        const preview = await service.preview(viewer, input);
        await env.DB.prepare(
          "UPDATE events SET repository_provider = 'airtable' WHERE id = ? AND organisation_id = ?",
        )
          .bind(viewer.eventId, viewer.organisationId)
          .run();

        await expect(
          service.confirm(viewer, preview.operationId),
        ).rejects.toThrow(
          "CSV import for sessions is unavailable while Airtable is authoritative",
        );
        expect(
          await env.DB.prepare("SELECT status FROM operation_jobs WHERE id = ?")
            .bind(preview.operationId)
            .first(),
        ).toEqual({ status: "received" });
        expect(
          await env.DB.prepare(
            "SELECT id FROM sessions WHERE event_id = ? AND slug = 'authority-guard-session'",
          )
            .bind(viewer.eventId)
            .first(),
        ).toBeNull();
      } finally {
        await env.DB.prepare(
          "UPDATE events SET repository_provider = 'd1' WHERE id = ? AND organisation_id = ?",
        )
          .bind(viewer.eventId, viewer.organisationId)
          .run();
      }
    });
  });
});
