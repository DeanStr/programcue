import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { CrmService } from "~/modules/crm/crm-service.server";
import { ensureDemoSpeakerData } from "./demo.server";
import { SpeakerRosterImportService } from "./speaker-roster-import.server";
import { SpeakerService } from "./speaker-service.server";

const admin: Viewer = {
  personId: "person-demo-admin",
  name: "Jordan Alvarez",
  email: "sbek-organizer@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

describe("event speaker roster CSV import", () => {
  it("preserves system provenance on a status-less import and then promotes confirmed participation", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const suffix = crypto.randomUUID().slice(0, 8);
    const insertedPersonId = `workflow-insert-${suffix}`;
    const updatedPersonId = `workflow-update-${suffix}`;
    const insertedSessionId = `workflow-insert-session-${suffix}`;
    const preservedSessionId = `workflow-preserved-session-${suffix}`;
    const updatedSessionId = `workflow-update-session-${suffix}`;
    const membershipId = `workflow-membership-${suffix}`;
    const insertedEmail = `workflow-insert-${suffix}@example.com`;
    const updatedEmail = `workflow-update-${suffix}@example.com`;
    await testEnv.DB.batch([
      ...[
        [insertedPersonId, insertedEmail],
        [updatedPersonId, updatedEmail],
      ].map(([personId, email]) =>
        testEnv.DB.prepare(
          `INSERT INTO people (
             id, email, display_name, email_verified, profile_status,
             created_at, updated_at
           ) VALUES (?, ?, 'Derived workflow speaker', 1, 'draft',
                     unixepoch(), unixepoch())`,
        ).bind(personId, email),
      ),
      testEnv.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role,
           invited_at, accepted_at, created_at
         ) VALUES (?, ?, ?, ?, 'speaker', unixepoch(), unixepoch(), unixepoch())`,
      ).bind(
        membershipId,
        admin.organisationId,
        admin.eventId,
        insertedPersonId,
      ),
      ...[
        [insertedSessionId, insertedPersonId, "confirmed"],
        [preservedSessionId, insertedPersonId, "confirmed"],
        [updatedSessionId, updatedPersonId, "pending"],
      ].map(([sessionId]) =>
        testEnv.DB.prepare(
          `INSERT INTO sessions (
             id, event_id, title, slug, format, duration_minutes,
             status, visibility, created_at, updated_at
           ) VALUES (?, ?, 'Derived workflow session', ?, 'presentation', 45,
                     'unscheduled', 'public', unixepoch(), unixepoch())`,
        ).bind(sessionId, admin.eventId, sessionId),
      ),
      testEnv.DB.prepare(
        `INSERT INTO session_speakers (
           session_id, event_id, person_id, position, participation_status,
           participation_confirmed_at, visibility
         ) VALUES (?, ?, ?, 0, 'pending', NULL, 'public')`,
      ).bind(updatedSessionId, admin.eventId, updatedPersonId),
    ]);
    try {
      await expect(
        new SpeakerRosterImportService(testEnv).confirm(
          admin,
          `name,email\nDerived workflow speaker,${insertedEmail}`,
          `workflow-statusless-import:${suffix}`,
        ),
      ).resolves.toEqual({ imported: 1 });
      await expect(
        testEnv.DB.prepare(
          `SELECT status, source, updated_by_person_id AS updatedByPersonId
             FROM event_speaker_workflows
            WHERE event_id = ? AND person_id = ?`,
        )
          .bind(admin.eventId, insertedPersonId)
          .first(),
      ).resolves.toEqual({
        status: "invited",
        source: "membership",
        updatedByPersonId: null,
      });
      await testEnv.DB.prepare(
        `INSERT INTO session_speakers (
           session_id, event_id, person_id, position, participation_status,
           participation_confirmed_at, visibility
         ) VALUES (?, ?, ?, 0, 'confirmed', unixepoch(), 'public')`,
      )
        .bind(insertedSessionId, admin.eventId, insertedPersonId)
        .run();
      await expect(
        testEnv.DB.prepare(
          `SELECT status, source, revision
             FROM event_speaker_workflows
            WHERE event_id = ? AND person_id = ?`,
        )
          .bind(admin.eventId, insertedPersonId)
          .first(),
      ).resolves.toMatchObject({
        status: "confirmed",
        source: "session",
        revision: 3,
      });

      await testEnv.DB.prepare(
        `UPDATE event_speaker_workflows
            SET status = 'declined', source = 'manual',
                updated_by_person_id = ?, last_operation_id = ?
          WHERE event_id = ? AND person_id = ?`,
      )
        .bind(
          admin.personId,
          `workflow-manual:${suffix}`,
          admin.eventId,
          insertedPersonId,
        )
        .run();
      await testEnv.DB.prepare(
        `INSERT INTO session_speakers (
           session_id, event_id, person_id, position, participation_status,
           participation_confirmed_at, visibility
         ) VALUES (?, ?, ?, 0, 'confirmed', unixepoch(), 'public')`,
      )
        .bind(preservedSessionId, admin.eventId, insertedPersonId)
        .run();
      await expect(
        testEnv.DB.prepare(
          `SELECT status, source
             FROM event_speaker_workflows
            WHERE event_id = ? AND person_id = ?`,
        )
          .bind(admin.eventId, insertedPersonId)
          .first(),
      ).resolves.toMatchObject({ status: "declined", source: "manual" });

      await testEnv.DB.prepare(
        `UPDATE session_speakers
            SET participation_status = 'confirmed',
                participation_confirmed_at = unixepoch()
          WHERE session_id = ? AND event_id = ? AND person_id = ?`,
      )
        .bind(updatedSessionId, admin.eventId, updatedPersonId)
        .run();
      await expect(
        testEnv.DB.prepare(
          `SELECT status, source, revision
             FROM event_speaker_workflows
            WHERE event_id = ? AND person_id = ?`,
        )
          .bind(admin.eventId, updatedPersonId)
          .first(),
      ).resolves.toMatchObject({
        status: "confirmed",
        source: "session",
        revision: 2,
      });
    } finally {
      await testEnv.DB.prepare("DELETE FROM memberships WHERE id = ?")
        .bind(membershipId)
        .run();
      await testEnv.DB.prepare(
        `DELETE FROM sessions WHERE id IN (?, ?, ?)`,
      )
        .bind(insertedSessionId, preservedSessionId, updatedSessionId)
        .run();
      await testEnv.DB.prepare("DELETE FROM people WHERE id IN (?, ?)")
        .bind(insertedPersonId, updatedPersonId)
        .run();
    }
  });

  it("creates explicit system-attributed workflow state and rejects a missing durable row", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const suffix = crypto.randomUUID().slice(0, 8);
    const personId = `workflow-person-${suffix}`;
    const sessionId = `workflow-session-${suffix}`;
    const email = `workflow-${suffix}@example.com`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, email_verified, profile_status,
           created_at, updated_at
         ) VALUES (?, ?, 'Workflow speaker', 1, 'draft',
                   unixepoch(), unixepoch())`,
      ).bind(personId, email),
      testEnv.DB.prepare(
        `INSERT INTO sessions (
           id, event_id, title, slug, format, duration_minutes,
           status, visibility, created_at, updated_at
         ) VALUES (?, ?, 'Workflow session', ?, 'presentation', 45,
                   'unscheduled', 'public', unixepoch(), unixepoch())`,
      ).bind(sessionId, admin.eventId, sessionId),
      testEnv.DB.prepare(
        `INSERT INTO session_speakers (
           session_id, event_id, person_id, position, participation_status,
           participation_confirmed_at, visibility
         ) VALUES (?, ?, ?, 0, 'confirmed', unixepoch(), 'public')`,
      ).bind(sessionId, admin.eventId, personId),
    ]);
    try {
      await expect(
        testEnv.DB.prepare(
          `SELECT status, source, updated_by_person_id AS updatedByPersonId
             FROM event_speaker_workflows
            WHERE event_id = ? AND person_id = ?`,
        )
          .bind(admin.eventId, personId)
          .first(),
      ).resolves.toMatchObject({
        status: "confirmed",
        source: "session",
        updatedByPersonId: null,
      });
      await testEnv.DB.prepare(
        `DELETE FROM event_speaker_workflows
          WHERE event_id = ? AND person_id = ?`,
      )
        .bind(admin.eventId, personId)
        .run();
      await expect(
        new SpeakerService(testEnv).listAdminSpeakerPage(admin, {}, 1),
      ).rejects.toThrow(`Speaker ${personId} has no event workflow state.`);
    } finally {
      await testEnv.DB.prepare("DELETE FROM sessions WHERE id = ?")
        .bind(sessionId)
        .run();
      await testEnv.DB.prepare("DELETE FROM people WHERE id = ?")
        .bind(personId)
        .run();
    }
  });

  it("previews and idempotently imports useful profile data without claiming an invitation was sent", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const suffix = crypto.randomUUID().slice(0, 8);
    const email = `roster-${suffix}@example.com`;
    const csv = [
      "name,email,title,company,bio",
      `Robin Vega,${email},Principal Engineer,Northstar Labs,Builds reliable event systems.`,
    ].join("\n");
    const service = new SpeakerRosterImportService(testEnv);
    const preview = await service.preview(admin, csv);
    expect(preview.invalid).toEqual([]);
    expect(preview.valid).toEqual([
      expect.objectContaining({
        name: "Robin Vega",
        email,
        jobTitle: "Principal Engineer",
        organisationName: "Northstar Labs",
        workflowStatus: "prospect",
      }),
    ]);

    const idempotencyKey = `speaker-import:${suffix}`;
    await expect(service.confirm(admin, csv, idempotencyKey)).resolves.toEqual({
      imported: 1,
    });
    await expect(service.confirm(admin, csv, idempotencyKey)).resolves.toEqual({
      imported: 1,
    });

    const imported = await testEnv.DB.prepare(
      `SELECT person.id, person.display_name AS name, person.job_title AS jobTitle,
              person.organisation_name AS organisationName,
              membership.invited_at AS invitedAt,
              workflow.status AS workflowStatus
         FROM people person
         JOIN memberships membership
           ON membership.person_id = person.id AND membership.event_id = ?
          AND membership.role = 'speaker'
         JOIN event_speaker_workflows workflow
           ON workflow.event_id = membership.event_id
          AND workflow.person_id = membership.person_id
        WHERE person.email = ? COLLATE NOCASE`,
    )
      .bind(admin.eventId, email)
      .first<{
        id: string;
        name: string;
        jobTitle: string;
        organisationName: string;
        invitedAt: number | null;
        workflowStatus: string;
      }>();
    expect(imported).toMatchObject({
      name: "Robin Vega",
      jobTitle: "Principal Engineer",
      organisationName: "Northstar Labs",
      invitedAt: null,
      workflowStatus: "prospect",
    });
    const crmViewer = {
      ...admin,
      role: "administrator" as const,
      currentEventId: admin.eventId,
    };
    const directory = await new CrmService(testEnv).listDirectory(
      crmViewer,
      { query: email, company: "", jobTitle: "", tag: "" },
      1,
    );
    expect(directory.contacts).toEqual([
      expect.objectContaining({
        personId: imported!.id,
        email,
        eventCount: 1,
      }),
    ]);
    await expect(
      new CrmService(testEnv).getContact(crmViewer, imported!.id),
    ).resolves.toMatchObject({
      connections: [expect.objectContaining({ eventId: admin.eventId })],
    });

    const roster = await new SpeakerService(testEnv).listAdminSpeakerPage(
      admin,
      { query: email, workflowStatus: "prospect" },
      1,
    );
    expect(roster.speakers).toEqual([
      expect.objectContaining({
        id: imported!.id,
        workflowStatus: "prospect",
      }),
    ]);
    await expect(
      new SpeakerService(testEnv).updateSpeakerWorkflowStatus(
        admin,
        imported!.id,
        {
          idempotencyKey: `workflow:${suffix}`,
          status: "confirmed",
        },
      ),
    ).resolves.toMatchObject({ status: "confirmed" });
    await expect(
      testEnv.DB.prepare(
        `SELECT status, source, updated_by_person_id AS updatedByPersonId
           FROM event_speaker_workflows
          WHERE event_id = ? AND person_id = ?`,
      )
        .bind(admin.eventId, imported!.id)
        .first(),
    ).resolves.toEqual({
      status: "confirmed",
      source: "manual",
      updatedByPersonId: admin.personId,
    });

    await expect(
      service.confirm(admin, csv, `speaker-reimport-default:${suffix}`),
    ).resolves.toEqual({ imported: 1 });
    await expect(
      testEnv.DB.prepare(
        `SELECT status, source FROM event_speaker_workflows
          WHERE event_id = ? AND person_id = ?`,
      )
        .bind(admin.eventId, imported!.id)
        .first(),
    ).resolves.toMatchObject({ status: "confirmed", source: "manual" });

    const statusCsv = [
      "name,email,title,company,bio,status",
      `Robin Vega,${email},Principal Engineer,Northstar Labs,Builds reliable event systems.,declined`,
    ].join("\n");
    await expect(
      service.confirm(admin, statusCsv, `speaker-reimport:${suffix}`),
    ).resolves.toEqual({ imported: 1 });
    await expect(
      testEnv.DB.prepare(
        `SELECT status, source, revision
           FROM event_speaker_workflows
          WHERE event_id = ? AND person_id = ?`,
      )
        .bind(admin.eventId, imported!.id)
        .first(),
    ).resolves.toMatchObject({
      status: "declined",
      source: "import",
      revision: 4,
    });
  });

  it("rejects duplicate rows before mutating the roster", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const email = `duplicate-${crypto.randomUUID()}@example.com`;
    const csv = `name,email\nFirst Speaker,${email}\nSecond Speaker,${email}`;
    const preview = await new SpeakerRosterImportService(testEnv).preview(
      admin,
      csv,
    );
    expect(preview.invalid).toEqual([
      {
        rowNumber: 3,
        errors: ["Email duplicates another row in this import."],
      },
    ]);
  });

  it("rejects more than 200 data rows during preview", async () => {
    const rows = Array.from(
      { length: 201 },
      (_, index) => `Speaker ${index},speaker-${index}@example.com`,
    );
    await expect(
      new SpeakerRosterImportService(
        env as unknown as CloudflareEnvironment,
      ).preview(admin, ["name,email", ...rows].join("\n")),
    ).rejects.toThrow("CSV previews support at most 200 rows.");
  });

  it("fails closed if an identity becomes unavailable after preview", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const suffix = crypto.randomUUID().slice(0, 8);
    const email = `raced-${suffix}@example.com`;
    const otherOrganisationId = `speaker-race-org-${suffix}`;
    const otherPersonId = `speaker-race-person-${suffix}`;
    const auditBefore = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS count FROM audit_events
        WHERE event_id = ? AND action = 'speaker.roster.imported'`,
    )
      .bind(admin.eventId)
      .first<{ count: number }>();
    const service = new (class extends SpeakerRosterImportService {
      override async preview(viewer: Viewer, rawCsv: string) {
        const result = await super.preview(viewer, rawCsv);
        await testEnv.DB.batch([
          testEnv.DB.prepare(
            `INSERT INTO organisations (id, name, slug, created_at, updated_at)
             VALUES (?, 'Other organisation', ?, unixepoch(), unixepoch())`,
          ).bind(otherOrganisationId, otherOrganisationId),
          testEnv.DB.prepare(
            `INSERT INTO people (
               id, email, display_name, email_verified, profile_status,
               created_at, updated_at
             ) VALUES (?, ?, 'External identity', 1, 'draft',
                       unixepoch(), unixepoch())`,
          ).bind(otherPersonId, email),
          testEnv.DB.prepare(
            `INSERT INTO memberships (
               id, organisation_id, event_id, person_id, role,
               accepted_at, created_at
             ) VALUES (?, ?, NULL, ?, 'owner', unixepoch(), unixepoch())`,
          ).bind(
            `speaker-race-membership-${suffix}`,
            otherOrganisationId,
            otherPersonId,
          ),
        ]);
        return result;
      }
    })(testEnv);

    await expect(
      service.confirm(
        admin,
        `name,email\nRaced Identity,${email}`,
        `speaker-race:${suffix}`,
      ),
    ).rejects.toThrow();
    const linked = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM event_speaker_workflows workflow
        WHERE workflow.event_id = ? AND workflow.person_id = ?`,
    )
      .bind(admin.eventId, otherPersonId)
      .first<{ count: number }>();
    expect(Number(linked?.count)).toBe(0);
    const auditAfter = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS count FROM audit_events
        WHERE event_id = ? AND action = 'speaker.roster.imported'`,
    )
      .bind(admin.eventId)
      .first<{ count: number }>();
    expect(Number(auditAfter?.count)).toBe(Number(auditBefore?.count));
  });
});
