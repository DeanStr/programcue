import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { AirtableRepositoryConfigurationError } from "~/modules/airtable/airtable-room-repository.server";
import { ScheduleService } from "~/modules/schedule/schedule-service.server";
import { eventLocalTimeEpoch } from "~/modules/schedule/schedule-time";
import {
  publishedForm,
  validAnswers,
  verifiedApplicant,
  viewer,
} from "~/modules/submissions/submission-co-speakers.test-support";
import {
  SessionSpeakerService,
  SessionSpeakerStateError,
} from "./session-speaker-service.server";

const PRIYA = {
  personId: "person-demo-speaker",
  name: "Priya Shah",
  email: "priya.speaker@example.com",
};

async function directSession(
  testEnv: CloudflareEnvironment,
  title: string,
  personId: string,
) {
  const sessionId = crypto.randomUUID();
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO sessions (
         id, event_id, title, slug, description, format, duration_minutes,
         status, visibility, revision, created_at, updated_at
       ) VALUES (?, ?, ?, ?, '', 'presentation', 60, 'unscheduled', 'public',
                 1, unixepoch(), unixepoch())`,
    ).bind(sessionId, viewer.eventId, title, `session-${sessionId}`),
    testEnv.DB.prepare(
      `INSERT INTO session_speakers (
         session_id, event_id, person_id, position, role_label,
         participation_status, participation_confirmed_at, visibility
       ) VALUES (?, ?, ?, 0, 'Primary speaker', 'confirmed', unixepoch(),
                 'public')`,
    ).bind(sessionId, viewer.eventId, personId),
  ]);
  return sessionId;
}

function speakerRows(testEnv: CloudflareEnvironment, sessionId: string) {
  return testEnv.DB.prepare(
    `SELECT person_id AS personId, position, role_label AS roleLabel,
            participation_status AS participationStatus
       FROM session_speakers WHERE session_id = ? ORDER BY position`,
  )
    .bind(sessionId)
    .all()
    .then((rows) => rows.results);
}

/** A session from a proposal accepted with one automatic speaker task,
 *  due an hour after acceptance. */
async function acceptedSession() {
  const { service, id, slug, testEnv } = await publishedForm();
  const applicant = await verifiedApplicant(service, slug);
  const submissionId = await service.createDraft(slug, applicant);
  const draft = (
    await service.repository.getApplicantDrafts(id, applicant)
  )[0]!;
  await service.submitDraft(slug, applicant, {
    submissionId,
    revision: draft.revision,
    answers: validAnswers,
    speakers: [{ name: "Applicant", email: applicant.email }],
  });
  const sessionId = crypto.randomUUID();
  const decisionId = crypto.randomUUID();
  const templateId = `added-speaker-task-${crypto.randomUUID()}`;
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO task_templates (
         id, event_id, name, target_type, task_type, impact, evidence_mode,
         due_anchor, due_offset_minutes, auto_assign_on_acceptance, status
       ) VALUES (?, ?, 'Added speaker task', 'speaker', 'checklist', 'high',
                 'checkbox', 'acceptance', 60, 1, 'active')`,
    ).bind(templateId, viewer.eventId),
    testEnv.DB.prepare(
      `UPDATE submissions SET status = 'accepted', updated_at = unixepoch()
        WHERE id = ? AND status = 'submitted'`,
    ).bind(submissionId),
    testEnv.DB.prepare(
      `INSERT INTO submission_decisions (
         id, event_id, submission_id, revision_number, status, decision,
         decided_by_person_id, notification_feedback_json,
         effect_preview_json, idempotency_key, published_at
       ) VALUES (?, ?, ?, 1, 'published', 'accepted', ?, '[]', '{}', ?,
                 unixepoch())`,
    ).bind(
      decisionId,
      viewer.eventId,
      submissionId,
      viewer.personId,
      `accepted-test:${decisionId}`,
    ),
    testEnv.DB.prepare(
      `INSERT INTO sessions (
         id, event_id, source_submission_id, title, slug, description, format,
         duration_minutes, status, visibility, revision, created_at, updated_at
       ) VALUES (?, ?, ?, 'Accepted proposal', ?, '', 'presentation', 60,
                 'unscheduled', 'public', 1, unixepoch(), unixepoch())`,
    ).bind(sessionId, viewer.eventId, submissionId, `accepted-${sessionId}`),
    testEnv.DB.prepare(
      `INSERT INTO session_speakers (
         session_id, event_id, person_id, position, role_label,
         participation_status, participation_confirmed_at, visibility
       )
       SELECT ?, event_id, person_id, 0, 'Primary speaker', 'confirmed',
              unixepoch(), 'public'
         FROM submission_speakers
        WHERE submission_id = ? AND is_primary = 1 AND person_id IS NOT NULL`,
    ).bind(sessionId, submissionId),
  ]);
  return { testEnv, sessionId, decisionId, templateId };
}

/** Runs `hook` just before the service's first batch, as a concurrent
 *  change committed between its checks and its write would. */
function beforeFirstBatch(
  testEnv: CloudflareEnvironment,
  hook: () => Promise<unknown>,
): CloudflareEnvironment {
  const db = testEnv.DB;
  let pending = true;
  const DB = new Proxy(db, {
    get(target, key) {
      if (key === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (pending) {
            pending = false;
            await hook();
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...testEnv, DB };
}

describe("session speaker editing", () => {
  it("adds an existing speaker to an accepted session with their acceptance tasks", async () => {
    const { testEnv, sessionId, decisionId, templateId } =
      await acceptedSession();
    const speakers = new SessionSpeakerService(testEnv);
    const operationId = crypto.randomUUID();
    const input = { sessionId, ...PRIYA, operationId };

    await expect(speakers.add(viewer, input)).resolves.toEqual({
      name: "Priya Shah",
      replayed: false,
      invitationWarning: null,
    });
    expect((await speakerRows(testEnv, sessionId))[1]).toEqual({
      personId: PRIYA.personId,
      position: 1,
      roleLabel: "Co-speaker",
      participationStatus: "pending",
    });
    const task = await testEnv.DB.prepare(
      `SELECT task.due_at - decision.published_at AS dueOffset
         FROM task_instances task
         JOIN submission_decisions decision ON decision.id = ?
        WHERE task.template_id = ? AND task.target_type = 'speaker'
          AND task.target_id = ?`,
    )
      .bind(decisionId, templateId, PRIYA.personId)
      .first();
    expect(task).toEqual({ dueOffset: 3_600 });

    // A retried request returns the original result and changes nothing.
    await expect(speakers.add(viewer, input)).resolves.toMatchObject({
      replayed: true,
    });
    expect(await speakerRows(testEnv, sessionId)).toHaveLength(2);
    expect(
      await testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
          WHERE action = 'session.speaker.added' AND entity_id = ?`,
      )
        .bind(sessionId)
        .first(),
    ).toEqual({ count: 1 });
    await expect(
      speakers.add(viewer, { ...input, operationId: crypto.randomUUID() }),
    ).rejects.toThrow("Priya Shah is already a speaker on this session.");
    await expect(speakers.list(viewer, sessionId)).resolves.toMatchObject({
      lockedReason: null,
      speakers: [
        expect.objectContaining({ participationStatus: "confirmed" }),
        expect.objectContaining({
          name: "Priya Shah",
          participationStatus: "pending",
        }),
      ],
    });
  });

  it("creates a new speaker identity but never attaches an unrelated one", async () => {
    const { testEnv } = await publishedForm();
    const sessionId = await directSession(
      testEnv,
      "Direct session",
      PRIYA.personId,
    );
    const speakers = new SessionSpeakerService(testEnv);
    const email = `new-speaker-${crypto.randomUUID()}@example.com`;
    const operationId = crypto.randomUUID();
    await speakers.add(viewer, {
      sessionId,
      name: "Sam Newcomer",
      email: email.toUpperCase(),
      operationId,
    });
    expect(
      await testEnv.DB.prepare(
        `SELECT person.display_name AS name, membership.role,
                membership.accepted_at AS acceptedAt,
                membership.invitation_expires_at > unixepoch() AS invited,
                membership.last_operation_id AS operationId
           FROM people person
           JOIN memberships membership
             ON membership.person_id = person.id AND membership.event_id = ?
          WHERE person.email = ?`,
      )
        .bind(viewer.eventId, email)
        .first(),
    ).toEqual({
      name: "Sam Newcomer",
      role: "speaker",
      acceptedAt: null,
      invited: 1,
      operationId,
    });

    const outsider = `outsider-${crypto.randomUUID()}@example.com`;
    await testEnv.DB.prepare(
      `INSERT INTO people (
         id, email, display_name, email_verified, profile_status,
         created_at, updated_at
       ) VALUES (?, ?, 'Outside Organisation', 0, 'draft', unixepoch(),
                 unixepoch())`,
    )
      .bind(crypto.randomUUID(), outsider)
      .run();
    await expect(
      speakers.add(viewer, {
        sessionId,
        name: "Outside Organisation",
        email: outsider,
        operationId: crypto.randomUUID(),
      }),
    ).rejects.toThrow(`Invite ${outsider} to the event`);
    expect(await speakerRows(testEnv, sessionId)).toHaveLength(2);
  });

  it("removes a speaker but never the last, and locks published sessions", async () => {
    const { testEnv } = await publishedForm();
    const sessionId = await directSession(
      testEnv,
      "Removal session",
      PRIYA.personId,
    );
    const speakers = new SessionSpeakerService(testEnv);
    await expect(
      speakers.remove(viewer, {
        sessionId,
        personId: PRIYA.personId,
        operationId: crypto.randomUUID(),
        confirmed: "true",
      }),
    ).rejects.toThrow(
      "A session needs at least one speaker. Add the replacement before removing Priya Shah.",
    );
    const email = `removable-${crypto.randomUUID()}@example.com`;
    await speakers.add(viewer, {
      sessionId,
      name: "Removable Speaker",
      email,
      operationId: crypto.randomUUID(),
    });
    const added = (await speakerRows(testEnv, sessionId))[1] as {
      personId: string;
    };
    await expect(
      speakers.remove(viewer, {
        sessionId,
        personId: added.personId,
        operationId: crypto.randomUUID(),
      }),
    ).rejects.toThrow(ZodError);
    const operationId = crypto.randomUUID();
    const removal = {
      sessionId,
      personId: added.personId,
      operationId,
      confirmed: "true",
    };
    await expect(speakers.remove(viewer, removal)).resolves.toEqual({
      name: "Removable Speaker",
      replayed: false,
    });
    await expect(speakers.remove(viewer, removal)).resolves.toEqual({
      name: "Removable Speaker",
      replayed: true,
    });
    expect(await speakerRows(testEnv, sessionId)).toEqual([
      expect.objectContaining({ personId: PRIYA.personId }),
    ]);
    expect(
      await testEnv.DB.prepare(
        `SELECT json_extract(metadata_json, '$.email') AS email,
                json_extract(metadata_json, '$.participationStatus') AS status
           FROM audit_events
          WHERE action = 'session.speaker.removed' AND correlation_id = ?`,
      )
        .bind(operationId)
        .first(),
    ).toEqual({ email, status: "pending" });

    await testEnv.DB.prepare(
      "UPDATE sessions SET status = 'published' WHERE id = ?",
    )
      .bind(sessionId)
      .run();
    await expect(speakers.list(viewer, sessionId)).resolves.toMatchObject({
      lockedReason:
        "This session is on the published programme, so its speakers are locked.",
    });
    await expect(
      speakers.add(viewer, {
        sessionId,
        name: "Late Speaker",
        email: `late-${crypto.randomUUID()}@example.com`,
        operationId: crypto.randomUUID(),
      }),
    ).rejects.toThrow(SessionSpeakerStateError);
  });

  it("rebuilds draft speaker conflicts as speakers change", async () => {
    const { testEnv } = await publishedForm();
    const otherEmail = `other-speaker-${crypto.randomUUID()}@example.com`;
    const speakers = new SessionSpeakerService(testEnv);
    const first = await directSession(
      testEnv,
      "First overlapping session",
      PRIYA.personId,
    );
    const second = await directSession(
      testEnv,
      "Second overlapping session",
      PRIYA.personId,
    );
    // The second session's only speaker becomes someone else.
    await speakers.add(viewer, {
      sessionId: second,
      name: "Other Speaker",
      email: otherEmail,
      operationId: crypto.randomUUID(),
    });
    await speakers.remove(viewer, {
      sessionId: second,
      personId: PRIYA.personId,
      operationId: crypto.randomUUID(),
      confirmed: "true",
    });

    const schedule = new ScheduleService(testEnv);
    const versionId = await schedule.createDraft(viewer);
    let workspace = await schedule.getWorkspace(viewer);
    const [roomA, roomB] = workspace.rooms;
    const startsAt = eventLocalTimeEpoch(
      workspace.event.startsAt,
      workspace.event.timezone,
      8,
    );
    for (const [sessionId, roomId] of [
      [first, roomA!.id],
      [second, roomB!.id],
    ] as const) {
      await schedule.place(viewer, {
        scheduleVersionId: versionId,
        scheduleRevision: workspace.version!.revision,
        sessionId,
        roomId,
        startsAt,
        endsAt: startsAt + 3_600,
      });
      workspace = await schedule.getWorkspace(viewer);
    }
    const speakerConflicts = () =>
      testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM schedule_conflicts
          WHERE schedule_version_id = ? AND conflict_type = 'speaker'`,
      )
        .bind(versionId)
        .first<{ count: number }>()
        .then((row) => row?.count);
    expect(await speakerConflicts()).toBe(0);

    await speakers.add(viewer, {
      sessionId: second,
      ...PRIYA,
      operationId: crypto.randomUUID(),
    });
    expect(await speakerConflicts()).toBeGreaterThan(0);

    await speakers.remove(viewer, {
      sessionId: second,
      personId: PRIYA.personId,
      operationId: crypto.randomUUID(),
      confirmed: "true",
    });
    expect(await speakerConflicts()).toBe(0);
  });

  it("leaves speakers unchanged while Airtable is authoritative but not connected", async () => {
    const { testEnv } = await publishedForm();
    const sessionId = await directSession(
      testEnv,
      "Airtable session",
      PRIYA.personId,
    );
    const speakers = new SessionSpeakerService(testEnv);
    await speakers.add(viewer, {
      sessionId,
      name: "Second Speaker",
      email: `second-${crypto.randomUUID()}@example.com`,
      operationId: crypto.randomUUID(),
    });
    const audits = () =>
      testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
          WHERE action LIKE 'session.speaker.%' AND entity_id = ?`,
      )
        .bind(sessionId)
        .first<{ count: number }>();
    const before = await audits();
    const provider = (value: string) =>
      testEnv.DB.prepare(
        "UPDATE events SET repository_provider = ? WHERE id = ? AND organisation_id = ?",
      )
        .bind(value, viewer.eventId, viewer.organisationId)
        .run();
    await provider("airtable");
    try {
      await expect(
        speakers.add(viewer, {
          sessionId,
          name: "Third Speaker",
          email: `third-${crypto.randomUUID()}@example.com`,
          operationId: crypto.randomUUID(),
        }),
      ).rejects.toThrow(AirtableRepositoryConfigurationError);
      await expect(
        speakers.remove(viewer, {
          sessionId,
          personId: PRIYA.personId,
          operationId: crypto.randomUUID(),
          confirmed: "true",
        }),
      ).rejects.toThrow(AirtableRepositoryConfigurationError);
    } finally {
      await provider("d1");
    }
    expect(await speakerRows(testEnv, sessionId)).toHaveLength(2);
    expect(await audits()).toEqual(before);
  });

  it("refuses an identity whose access is revoked before the add commits", async () => {
    const { testEnv } = await publishedForm();
    const sessionId = await directSession(
      testEnv,
      "Revocation session",
      PRIYA.personId,
    );
    // Their accepted speaker access is their only link to the organisation.
    const personId = crypto.randomUUID();
    const email = `revoked-${crypto.randomUUID()}@example.com`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, email_verified, profile_status,
           created_at, updated_at
         ) VALUES (?, ?, 'Revoked Speaker', 1, 'draft', unixepoch(),
                   unixepoch())`,
      ).bind(personId, email),
      testEnv.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role, invited_at,
           accepted_at
         ) VALUES (?, ?, ?, ?, 'speaker', unixepoch(), unixepoch())`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        personId,
      ),
    ]);
    const revoking = beforeFirstBatch(testEnv, () =>
      testEnv.DB.prepare(
        "UPDATE memberships SET revoked_at = unixepoch() WHERE person_id = ?",
      )
        .bind(personId)
        .run(),
    );

    await expect(
      new SessionSpeakerService(revoking).add(viewer, {
        sessionId,
        name: "Revoked Speaker",
        email,
        operationId: crypto.randomUUID(),
      }),
    ).rejects.toThrow(`Invite ${email} to the event`);
    expect(await speakerRows(testEnv, sessionId)).toHaveLength(1);
    expect(
      await testEnv.DB.prepare(
        "SELECT revoked_at IS NOT NULL AS revoked FROM memberships WHERE person_id = ?",
      )
        .bind(personId)
        .first(),
    ).toEqual({ revoked: 1 });
  });

  it("refuses a speaker for an accepted session whose onboarding plan acceptance would refuse", async () => {
    const { testEnv, sessionId, templateId } = await acceptedSession();
    // The automatic task gains a prerequisite due from session start, which
    // a speaker added before scheduling could never be given a deadline for.
    const invalidTemplateId = `session-start-task-${crypto.randomUUID()}`;
    await testEnv.DB.prepare(
      `INSERT INTO task_templates (
         id, event_id, name, target_type, task_type, impact, evidence_mode,
         due_anchor, due_offset_minutes, auto_assign_on_acceptance, status
       ) VALUES (?, ?, 'Before the session', 'speaker', 'checklist', 'high',
                 'checkbox', 'session_start', -1440, 0, 'active')`,
    )
      .bind(invalidTemplateId, viewer.eventId)
      .run();
    const addPrerequisite = () =>
      testEnv.DB.prepare(
        `INSERT INTO task_template_dependencies (
           template_id, depends_on_template_id
         ) VALUES (?, ?)`,
      )
        .bind(templateId, invalidTemplateId)
        .run();
    const removePrerequisite = () =>
      testEnv.DB.prepare(
        `DELETE FROM task_template_dependencies
          WHERE template_id = ? AND depends_on_template_id = ?`,
      )
        .bind(templateId, invalidTemplateId)
        .run();
    const input = () => ({
      sessionId,
      ...PRIYA,
      operationId: crypto.randomUUID(),
    });
    const refusal =
      "Fix it in Tasks before adding a speaker to this accepted session.";
    try {
      await addPrerequisite();
      await expect(
        new SessionSpeakerService(testEnv).add(viewer, input()),
      ).rejects.toThrow(refusal);
      await removePrerequisite();
      // The batch repeats the check for a template added after it.
      await expect(
        new SessionSpeakerService(
          beforeFirstBatch(testEnv, addPrerequisite),
        ).add(viewer, input()),
      ).rejects.toThrow(refusal);
    } finally {
      await testEnv.DB.prepare("DELETE FROM task_templates WHERE id = ?")
        .bind(invalidTemplateId)
        .run();
    }
    expect(await speakerRows(testEnv, sessionId)).toHaveLength(1);
    // Neither template gave the refused speaker a task.
    expect(
      await testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM task_instances
          WHERE template_id IN (?, ?) AND target_type = 'speaker'
            AND target_id = ?`,
      )
        .bind(templateId, invalidTemplateId, PRIYA.personId)
        .first(),
    ).toEqual({ count: 0 });
  });
});
