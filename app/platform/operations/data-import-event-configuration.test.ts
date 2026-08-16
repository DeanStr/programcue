import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { INITIAL_EVENT_SESSION_FORMATS_JSON } from "~/modules/events/event-configuration";
import { CANONICAL_EVENT_FILE_POLICY_JSON } from "~/modules/files/file-policy";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { DataImportService } from "~/platform/operations/data-import-service.server";

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
      `UPDATE schedule_session_contents
          SET content_status = 'approved', approved_by_person_id = ?,
              approved_at = unixepoch(), approval_source = 'editorial'
        WHERE schedule_version_id = ? AND event_id = ? AND session_id = ?`,
    ).bind(viewer.personId, versionId, eventId, sessionId),
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
