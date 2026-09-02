import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  DataExportIdempotencyConflictError,
  DataExportService,
} from "~/platform/operations/data-export-service.server";

const viewer: Viewer = {
  personId: "person-demo-owner",
  name: "Morgan Chen",
  email: "morgan.owner@example.com",
  role: "owner",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

describe("event CSV exports", () => {
  beforeEach(async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    await env.DB.prepare(
      "DELETE FROM operation_jobs WHERE event_id = ? AND type = 'data.export'",
    )
      .bind(viewer.eventId)
      .run();
  });

  it("exports authorised event records, neutralises formulas and audits the download", async () => {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO rooms (id, event_id, name, capacity, position)
       VALUES ('export-formula-room', ?, '=IMPORTXML(1)', 20, 999)`,
    )
      .bind(viewer.eventId)
      .run();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO rooms (id, event_id, name, capacity, position)
       VALUES ('export-whitespace-formula-room', ?, '  +1+1', 20, 1000)`,
    )
      .bind(viewer.eventId)
      .run();
    const exported = await new DataExportService(
      env as unknown as CloudflareEnvironment,
    ).export(viewer, "rooms", crypto.randomUUID());

    expect(exported.csv).toContain("id,name,capacity,position,status\r\n");
    expect(exported.csv).toContain(
      "export-formula-room,'=IMPORTXML(1),20,999,active",
    );
    expect(exported.csv).toContain(
      "export-whitespace-formula-room,'  +1+1,20,1000,active",
    );
    expect(
      await env.DB.prepare(
        "SELECT status, progress_total AS total, progress_completed AS completed FROM operation_jobs WHERE id = ?",
      )
        .bind(exported.operationId)
        .first(),
    ).toEqual({
      status: "completed",
      total: exported.rowCount,
      completed: exported.rowCount,
    });
    expect(
      await env.DB.prepare(
        "SELECT action FROM audit_events WHERE entity_type = 'operation' AND entity_id = ?",
      )
        .bind(exported.operationId)
        .first(),
    ).toEqual({ action: "data.exported" });
  });

  it("includes active organisation-scoped owners in every authorised event people export", async () => {
    const exported = await new DataExportService(
      env as unknown as CloudflareEnvironment,
    ).export(viewer, "people", crypto.randomUUID());

    expect(exported.csv).toContain(
      "person-demo-owner,morgan.owner@example.com,Morgan Chen",
    );
  });

  it("exports every ordered submission track from authoritative selections", async () => {
    const submissionId = `export-multi-track-${crypto.randomUUID()}`;
    const reference = `EXPORT-MULTI-${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO submissions (
           id, event_id, public_reference, title, category, format, status,
           answers_json, submitted_snapshot_json, submitted_at, created_at, updated_at
         ) VALUES (?, ?, ?, 'Multi-track export proposal', 'AI & Innovation',
                   'Presentation', 'submitted', '{}', '{"answers":{},"speakers":[]}',
                   unixepoch(), unixepoch(), unixepoch())`,
      ).bind(submissionId, viewer.eventId, reference),
      env.DB.prepare(
        `INSERT INTO submission_track_selections (
           submission_id, event_id, track_id, track_name_snapshot, position
         ) VALUES (?, ?, 'demo-track-ai', 'AI & Innovation', 0)`,
      ).bind(submissionId, viewer.eventId),
      env.DB.prepare(
        `INSERT INTO submission_track_selections (
           submission_id, event_id, track_id, track_name_snapshot, position
         ) VALUES (?, ?, 'demo-track-operations', 'Event Operations', 1)`,
      ).bind(submissionId, viewer.eventId),
    ]);
    try {
      const exported = await new DataExportService(
        env as unknown as CloudflareEnvironment,
      ).export(viewer, "submissions", crypto.randomUUID());
      expect(exported.csv).toContain(
        "id,publicReference,title,tracks,format,status,submitterEmail",
      );
      const row = exported.csv
        .split("\r\n")
        .find((candidate) => candidate.includes(reference));
      expect(row).toContain("demo-track-ai");
      expect(row).toContain("demo-track-operations");
      expect(row!.indexOf("demo-track-ai")).toBeLessThan(
        row!.indexOf("demo-track-operations"),
      );
    } finally {
      await env.DB.prepare(
        "DELETE FROM submissions WHERE id = ? AND event_id = ?",
      )
        .bind(submissionId, viewer.eventId)
        .run();
    }
  });

  it("exports participant readiness as one relational row per event participant", async () => {
    const taskId = `participant-readiness-export-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO task_instances (
         id, event_id, target_type, target_id, owner_person_id, title,
         task_type, impact, status, readiness_state, readiness_percent,
         revision, created_at, updated_at
       ) VALUES (
         ?, ?, 'speaker', ?, ?, 'Readiness export evidence', 'checklist',
         'medium', 'not_started', 'on_track', 0, 1,
         unixepoch(), unixepoch()
       )`,
    )
      .bind(taskId, viewer.eventId, viewer.personId, viewer.personId)
      .run();
    try {
      const exported = await new DataExportService(
        env as unknown as CloudflareEnvironment,
      ).export(viewer, "participant-readiness", crypto.randomUUID());

      expect(exported.csv).toContain(
        "personId,email,name,organisation,jobTitle,profileStatus,applicationCount,draftApplications,submittedApplications,sessionCount,pendingRoles,confirmedRoles,declinedRoles,outstandingTasks,completedTasks,missingRequiredFields,quarantinedFiles,readinessStatus\r\n",
      );
      const participantRows = exported.csv
        .split("\r\n")
        .filter((row) => row.startsWith(`${viewer.personId},`));
      expect(participantRows).toHaveLength(1);
      expect(participantRows[0]).toMatch(/,(ready|needs_attention)$/u);
    } finally {
      await env.DB.prepare("DELETE FROM task_instances WHERE id = ?")
        .bind(taskId)
        .run();
    }
  });

  it("does not treat an unclaimed application speaker as a participant", async () => {
    const personId = `unclaimed-export-person-${crypto.randomUUID()}`;
    const submissionId = `unclaimed-export-submission-${crypto.randomUUID()}`;
    const speakerId = `unclaimed-export-speaker-${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, profile_status, created_at, updated_at
         ) VALUES (?, ?, 'Unclaimed export person', 'draft',
                   unixepoch(), unixepoch())`,
      ).bind(personId, `${personId}@example.com`),
      env.DB.prepare(
        `INSERT INTO submissions (
           id, event_id, public_reference, title, status, created_at, updated_at
         ) VALUES (?, ?, ?, 'Unclaimed export application', 'draft',
                   unixepoch(), unixepoch())`,
      ).bind(submissionId, viewer.eventId, submissionId),
      env.DB.prepare(
        `INSERT INTO submission_speakers (
           id, event_id, submission_id, person_id, email, display_name,
           position, invitation_status, is_primary
         ) VALUES (?, ?, ?, ?, ?, 'Unclaimed export person', 0, 'pending', 0)`,
      ).bind(
        speakerId,
        viewer.eventId,
        submissionId,
        personId,
        `${personId}@example.com`,
      ),
    ]);

    try {
      const exported = await new DataExportService(
        env as unknown as CloudflareEnvironment,
      ).export(viewer, "participant-readiness", crypto.randomUUID());
      expect(exported.csv).not.toContain(personId);
    } finally {
      await env.DB.prepare("DELETE FROM submissions WHERE id = ?")
        .bind(submissionId)
        .run();
      await env.DB.prepare("DELETE FROM people WHERE id = ?")
        .bind(personId)
        .run();
    }
  });

  it("exports session staffing as one row per session, person and role with placement and requirements", async () => {
    const sessionId = `staffing-export-${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO sessions (
           id, event_id, title, slug, format, duration_minutes, status,
           visibility, created_at, updated_at
         ) VALUES (?, ?, 'Staffing export session', ?, 'panel', 60,
                   'unscheduled', 'public', unixepoch(), unixepoch())`,
      ).bind(sessionId, viewer.eventId, sessionId),
      env.DB.prepare(
        `INSERT INTO session_speakers (
           session_id, event_id, person_id, position, role_label,
           participation_status, participation_confirmed_at, visibility
         ) VALUES (?, ?, ?, 0, 'Speaker', 'confirmed', unixepoch(), 'public')`,
      ).bind(sessionId, viewer.eventId, viewer.personId),
    ]);
    try {
      const exported = await new DataExportService(
        env as unknown as CloudflareEnvironment,
      ).export(viewer, "session-staffing", crypto.randomUUID());

      expect(exported.csv).toContain(
        "sessionId,sessionTitle,sessionStatus,personId,personName,email,role,roleLabel,response,scheduleStatus,scheduleVersion,room,startsAt,endsAt,outstandingRequirements\r\n",
      );
      expect(exported.csv).toContain(sessionId);
      expect(exported.csv).toContain(viewer.personId);
      expect(exported.csv).toContain(",speaker,Speaker,confirmed,");
    } finally {
      await env.DB.prepare("DELETE FROM sessions WHERE id = ?")
        .bind(sessionId)
        .run();
    }
  });

  it("counts a shared session task for pending and confirmed participants but not a declined owner", async () => {
    const suffix = crypto.randomUUID();
    const sessionId = `shared-task-session-${suffix}`;
    const confirmedPersonId = `shared-task-confirmed-${suffix}`;
    const pendingPersonId = `shared-task-pending-${suffix}`;
    const declinedPersonId = `shared-task-declined-${suffix}`;
    const taskId = `shared-session-task-${suffix}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, profile_status, created_at, updated_at
         ) VALUES (?, ?, 'Confirmed presenter', 'published',
                   unixepoch(), unixepoch())`,
      ).bind(confirmedPersonId, `${confirmedPersonId}@example.com`),
      env.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, profile_status, created_at, updated_at
         ) VALUES (?, ?, 'Pending presenter', 'published',
                   unixepoch(), unixepoch())`,
      ).bind(pendingPersonId, `${pendingPersonId}@example.com`),
      env.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, profile_status, created_at, updated_at
         ) VALUES (?, ?, 'Declined presenter', 'published',
                   unixepoch(), unixepoch())`,
      ).bind(declinedPersonId, `${declinedPersonId}@example.com`),
      env.DB.prepare(
        `INSERT INTO sessions (
           id, event_id, title, slug, format, duration_minutes, status,
           visibility, created_at, updated_at
         ) VALUES (?, ?, 'Shared task export session', ?, 'panel', 60,
                   'unscheduled', 'public', unixepoch(), unixepoch())`,
      ).bind(sessionId, viewer.eventId, sessionId),
      env.DB.prepare(
        `INSERT INTO session_speakers (
           session_id, event_id, person_id, position, role_label,
           participation_status, participation_confirmed_at, visibility
         ) VALUES (?, ?, ?, 0, 'Speaker', 'confirmed', unixepoch(), 'public')`,
      ).bind(sessionId, viewer.eventId, confirmedPersonId),
      env.DB.prepare(
        `INSERT INTO session_speakers (
           session_id, event_id, person_id, position, role_label,
           participation_status, visibility
         ) VALUES (?, ?, ?, 1, 'Speaker', 'pending', 'public')`,
      ).bind(sessionId, viewer.eventId, pendingPersonId),
      env.DB.prepare(
        `INSERT INTO session_speakers (
           session_id, event_id, person_id, position, role_label,
           participation_status, participation_declined_at,
           participation_decline_reason, visibility
         ) VALUES (?, ?, ?, 2, 'Speaker', 'declined', unixepoch(),
                   'Unavailable', 'public')`,
      ).bind(sessionId, viewer.eventId, declinedPersonId),
      env.DB.prepare(
        `INSERT INTO task_instances (
           id, event_id, target_type, target_id, owner_person_id, title,
           task_type, impact, status, readiness_state, readiness_percent,
           revision, created_at, updated_at
         ) VALUES (?, ?, 'session', ?, ?, 'Shared session requirement',
                   'checklist', 'medium', 'not_started', 'on_track', 0, 1,
                   unixepoch(), unixepoch())`,
      ).bind(taskId, viewer.eventId, sessionId, declinedPersonId),
    ]);

    const columnValue = (
      csv: string,
      idColumn: string,
      id: string,
      valueColumn: string,
      session?: string,
    ) => {
      const [header, ...rows] = csv.trim().split("\r\n");
      const columns = header.split(",");
      const idIndex = columns.indexOf(idColumn);
      const sessionIndex = columns.indexOf("sessionId");
      const row = rows
        .map((candidate) => candidate.split(","))
        .find(
          (candidate) =>
            candidate[idIndex] === id &&
            (session === undefined || candidate[sessionIndex] === session),
        );
      expect(row).toBeDefined();
      return row![columns.indexOf(valueColumn)];
    };

    try {
      const service = new DataExportService(
        env as unknown as CloudflareEnvironment,
      );
      const readiness = await service.export(
        viewer,
        "participant-readiness",
        crypto.randomUUID(),
      );
      const staffing = await service.export(
        viewer,
        "session-staffing",
        crypto.randomUUID(),
      );

      for (const personId of [confirmedPersonId, pendingPersonId]) {
        expect(
          columnValue(readiness.csv, "personId", personId, "outstandingTasks"),
        ).toBe("1");
        expect(
          columnValue(
            staffing.csv,
            "personId",
            personId,
            "outstandingRequirements",
            sessionId,
          ),
        ).toBe("1");
      }
      expect(
        columnValue(
          readiness.csv,
          "personId",
          declinedPersonId,
          "outstandingTasks",
        ),
      ).toBe("0");
      expect(
        columnValue(
          staffing.csv,
          "personId",
          declinedPersonId,
          "outstandingRequirements",
          sessionId,
        ),
      ).toBe("0");
    } finally {
      await env.DB.prepare("DELETE FROM task_instances WHERE id = ?")
        .bind(taskId)
        .run();
      await env.DB.prepare("DELETE FROM sessions WHERE id = ?")
        .bind(sessionId)
        .run();
      await env.DB.prepare("DELETE FROM people WHERE id IN (?, ?, ?)")
        .bind(confirmedPersonId, pendingPersonId, declinedPersonId)
        .run();
    }
  });

  it("fails closed when the event is outside the viewer organisation", async () => {
    await expect(
      new DataExportService(env as unknown as CloudflareEnvironment).export(
        { ...viewer, organisationId: "different-organisation" },
        "rooms",
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects event-scoped administrators and records no export", async () => {
    const eventAdministrator: Viewer = {
      ...viewer,
      personId: "person-demo-admin",
      name: "Olivia Bennett",
      email: "olivia@example.com",
      role: "administrator",
    };

    await expect(
      new DataExportService(env as unknown as CloudflareEnvironment).export(
        eventAdministrator,
        "rooms",
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM operation_jobs WHERE event_id = ? AND type = 'data.export'",
      )
        .bind(viewer.eventId)
        .first(),
    ).toEqual({ count: 0 });
  });

  it("replays one durable operation for a stable export intent", async () => {
    const service = new DataExportService(
      env as unknown as CloudflareEnvironment,
    );
    const intent = crypto.randomUUID();
    const first = await service.export(viewer, "rooms", intent);
    const second = await service.export(viewer, "rooms", intent);

    expect(second.operationId).toBe(first.operationId);
    expect(second.csv).toBe(first.csv);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM operation_jobs WHERE event_id = ? AND type = 'data.export'",
      )
        .bind(viewer.eventId)
        .first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE event_id = ? AND action = 'data.exported' AND entity_id = ?",
      )
        .bind(viewer.eventId, first.operationId)
        .first(),
    ).toEqual({ count: 1 });
  });

  it("rejects an export retry when the event data snapshot changed", async () => {
    const service = new DataExportService(
      env as unknown as CloudflareEnvironment,
    );
    const intent = crypto.randomUUID();
    const first = await service.export(viewer, "rooms", intent);
    const changedRoomId = `export-retry-change-${crypto.randomUUID()}`;

    try {
      await env.DB.prepare(
        `INSERT INTO rooms (id, event_id, name, capacity, position)
         VALUES (?, ?, 'Changed after export', 12, 1001)`,
      )
        .bind(changedRoomId, viewer.eventId)
        .run();

      await expect(service.export(viewer, "rooms", intent)).rejects.toThrow(
        DataExportIdempotencyConflictError,
      );
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM operation_jobs WHERE event_id = ? AND type = 'data.export'",
        )
          .bind(viewer.eventId)
          .first(),
      ).toEqual({ count: 1 });
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM audit_events WHERE event_id = ? AND action = 'data.exported' AND entity_id = ?",
        )
          .bind(viewer.eventId, first.operationId)
          .first(),
      ).toEqual({ count: 1 });
    } finally {
      await env.DB.prepare("DELETE FROM rooms WHERE id = ?")
        .bind(changedRoomId)
        .run();
    }
  });
});
