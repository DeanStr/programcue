import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ScheduleService } from "~/modules/schedule/schedule-service.server";
import {
  approveScheduledTestContent,
  prepareScheduleServiceTest,
  scheduleTestEnv,
  scheduleTestViewer as viewer,
} from "~/modules/schedule/schedule-service-test-fixture";
import { eventLocalTimeEpoch } from "~/modules/schedule/schedule-time";
import { unavailableDirectSessionSpeakerEmails } from "~/modules/speakers/speaker-invitation.server";
import { SpeakerService } from "~/modules/speakers/speaker-service.server";
import { SubmissionService } from "./submission-service.server";

beforeEach(prepareScheduleServiceTest);

async function prospect() {
  const email = `invited-session-${crypto.randomUUID()}@example.com`;
  const record = await new SpeakerService(
    scheduleTestEnv,
  ).addManualSpeakerRecord(viewer, {
    idempotencyKey: crypto.randomUUID(),
    name: "Invited keynote speaker",
    email,
    biography: "Organiser-supplied biography",
  });
  return {
    ...record,
    input: {
      idempotencyKey: crypto.randomUUID(),
      title: `Invited keynote ${email}`,
      format: "presentation",
      trackId: "schedule-test-track",
      durationMinutes: 30,
      speakers: [
        {
          name: "Do not overwrite the person",
          email,
          biography: "Do not overwrite",
        },
      ],
    },
  };
}

describe("invited-speaker session preparation", () => {
  it("creates and places an active prospect's session without accepting access or participation", async () => {
    const record = await prospect();
    const before = await env.DB.prepare(
      "SELECT display_name, biography, profile_status FROM people WHERE id = ?",
    )
      .bind(record.personId)
      .first();
    const service = new SubmissionService(scheduleTestEnv);
    const created = await service.createDirectSession(viewer, record.input);
    expect(
      (await service.createDirectSession(viewer, record.input)).sessionId,
    ).toBe(created.sessionId);
    expect(
      await env.DB.prepare(
        "SELECT display_name, biography, profile_status FROM people WHERE id = ?",
      )
        .bind(record.personId)
        .first(),
    ).toEqual(before);
    expect(
      await env.DB.prepare(
        "SELECT accepted_at FROM memberships WHERE event_id = ? AND person_id = ? AND role = 'speaker'",
      )
        .bind(viewer.eventId, record.personId)
        .first(),
    ).toEqual({ accepted_at: null });
    expect(
      await env.DB.prepare(
        "SELECT participation_status, participation_confirmed_at FROM session_speakers WHERE session_id = ? AND person_id = ?",
      )
        .bind(created.sessionId, record.personId)
        .first(),
    ).toEqual({
      participation_status: "pending",
      participation_confirmed_at: null,
    });
    const schedule = new ScheduleService(scheduleTestEnv);
    const versionId = await schedule.createDraft(viewer);
    let workspace = await schedule.getWorkspace(viewer);
    const startsAt = eventLocalTimeEpoch(
      workspace.event.startsAt,
      workspace.event.timezone,
      9,
    );
    await schedule.place(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: created.sessionId,
      roomId: "main",
      startsAt,
      endsAt: startsAt + 1800,
    });
    workspace = await schedule.getWorkspace(viewer);
    expect(
      workspace.entries.some((entry) => entry.sessionId === created.sessionId),
    ).toBe(true);
    // Make every other publication requirement ready to isolate participation.
    await env.DB.prepare(
      "UPDATE people SET profile_status = 'published' WHERE id = ?",
    )
      .bind(record.personId)
      .run();
    await approveScheduledTestContent(versionId);
    workspace = await schedule.getWorkspace(viewer);
    await expect(
      schedule.publish(viewer, {
        scheduleVersionId: versionId,
        scheduleRevision: workspace.version!.revision,
      }),
    ).rejects.toThrow(/confirm.*participation/i);
    expect(
      await env.DB.prepare("SELECT status FROM schedule_versions WHERE id = ?")
        .bind(versionId)
        .first(),
    ).toEqual({ status: "draft" });
  });

  it.each(["declined", "withdrawn", "revoked", "merged"])(
    "does not use an inactive %s roster record as identity permission",
    async (state) => {
      const record = await prospect();
      if (state === "revoked")
        await env.DB.prepare(
          "UPDATE memberships SET revoked_at = unixepoch() WHERE event_id = ? AND person_id = ?",
        )
          .bind(viewer.eventId, record.personId)
          .run();
      else if (state === "merged") {
        const primary = await prospect();
        await env.DB.prepare(
          "UPDATE organisation_contacts SET status = 'merged', merged_into_person_id = ? WHERE organisation_id = ? AND person_id = ?",
        )
          .bind(primary.personId, viewer.organisationId, record.personId)
          .run();
      } else
        await env.DB.prepare(
          "UPDATE event_speaker_workflows SET status = ? WHERE event_id = ? AND person_id = ?",
        )
          .bind(state, viewer.eventId, record.personId)
          .run();
      await expect(
        new SubmissionService(scheduleTestEnv).createDirectSession(
          viewer,
          record.input,
        ),
      ).rejects.toThrow(/wait for acceptance/);
      expect(
        await env.DB.prepare(
          "SELECT count(*) AS total FROM session_speakers WHERE person_id = ?",
        )
          .bind(record.personId)
          .first(),
      ).toEqual({ total: 0 });
    },
  );

  it("rechecks roster eligibility atomically if it changes after preflight", async () => {
    const record = await prospect();
    let creatingSession = false;
    const database = new Proxy(scheduleTestEnv.DB, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => {
            if (sql.includes("INSERT INTO sessions")) creatingSession = true;
            return target.prepare(sql);
          };
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            if (creatingSession) {
              creatingSession = false;
              await target
                .prepare(
                  "UPDATE event_speaker_workflows SET status = 'withdrawn' WHERE event_id = ? AND person_id = ?",
                )
                .bind(viewer.eventId, record.personId)
                .run();
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const racingEnv = new Proxy(scheduleTestEnv, {
      get(target, property) {
        return property === "DB" ? database : Reflect.get(target, property);
      },
    });
    await expect(
      new SubmissionService(racingEnv).createDirectSession(
        viewer,
        record.input,
      ),
    ).rejects.toThrow(/event changed/);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS total FROM session_speakers WHERE person_id = ?",
      )
        .bind(record.personId)
        .first(),
    ).toEqual({ total: 0 });
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS total FROM sessions WHERE title = ? AND event_id = ?",
      )
        .bind(record.input.title, viewer.eventId)
        .first(),
    ).toEqual({ total: 0 });
  });

  it("does not let a roster association grant access in another event or organisation", async () => {
    const record = await prospect();
    for (const scope of [
      { organisationId: viewer.organisationId, eventId: "other-event" },
      { organisationId: "other-org", eventId: viewer.eventId },
    ]) {
      expect(
        await unavailableDirectSessionSpeakerEmails({
          env: scheduleTestEnv,
          ...scope,
          emails: [record.email],
        }),
      ).toEqual([record.email]);
    }
    const email = `unrelated-${crypto.randomUUID()}@example.com`;
    await env.DB.prepare(
      "INSERT INTO people (id, email, display_name) VALUES (?, ?, 'Unrelated identity')",
    )
      .bind(crypto.randomUUID(), email)
      .run();
    await expect(
      new SubmissionService(scheduleTestEnv).createDirectSession(viewer, {
        ...record.input,
        speakers: [{ name: "Unrelated", email }],
      }),
    ).rejects.toThrow(/wait for acceptance/);
  });
});
