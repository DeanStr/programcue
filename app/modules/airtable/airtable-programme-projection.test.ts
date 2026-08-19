import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import {
  ensureDemoData,
  ensureDemoProgramme,
} from "~/platform/demo/seed.server";
import type { AirtableRecord, AirtableTable } from "./airtable-client.server";
import { AirtableEventDataRepository } from "./airtable-event-data-repository.server";
import { AirtableMigrationService } from "./airtable-migration-service.server";
import { AirtableProgrammeRepository } from "./airtable-programme-repository.server";
import { AirtableRoomRepository } from "./airtable-room-repository.server";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    APP_ENV: string;
    DEMO_MODE: string;
    DEFAULT_EVENT_ID: string;
    BETTER_AUTH_URL: string;
    INTEGRATION_CREDENTIALS_KEY: string;
  }
}

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

const connectionInput = {
  personalAccessToken: "pat-test-token-at-least-twenty",
  baseId: "app12345678901234",
  tableName: "Program Cue Rooms",
};

function fakeAirtable(initialTables: AirtableTable[] = []) {
  const tables = initialTables;
  const records: Array<AirtableRecord & { tableId: string }> = [];
  let sequence = 0;
  let listCalls = 0;
  let nextUpsertError: Error | null = null;
  const client = {
    async getBaseSchema() {
      return tables;
    },
    async createTable(
      name: string,
      fields: ReadonlyArray<{
        name: string;
        type: "singleLineText" | "number";
      }>,
    ) {
      const table: AirtableTable = {
        id: `tbl-${++sequence}`,
        name,
        primaryFieldId: "fld-primary",
        fields: fields.map((field, index) => ({
          id: index === 0 ? "fld-primary" : `fld-${index}`,
          name: field.name,
          type: field.type,
        })),
      };
      tables.push(table);
      return table;
    },
    async createField(
      _tableId: string,
      field: { name: string; type: "singleLineText" | "number" },
    ) {
      return { id: `fld-${++sequence}`, name: field.name, type: field.type };
    },
    async listRecords(tableId: string) {
      listCalls += 1;
      return records
        .filter((record) => record.tableId === tableId)
        .map((record) => ({
          ...record,
          fields: Object.fromEntries(
            Object.entries(record.fields).filter(
              ([, value]) => value !== "" && value !== false,
            ),
          ),
        }));
    },
    async upsertRecords(
      _tableId: string,
      batch: ReadonlyArray<{ fields: Record<string, unknown> }>,
    ) {
      if (nextUpsertError) {
        const error = nextUpsertError;
        nextUpsertError = null;
        throw error;
      }
      const output: AirtableRecord[] = [];
      for (const input of batch) {
        const keyName = Object.hasOwn(input.fields, "Program Cue Key")
          ? "Program Cue Key"
          : "Program Cue ID";
        const key = input.fields[keyName];
        let record = records.find(
          (candidate) =>
            candidate.tableId === _tableId && candidate.fields[keyName] === key,
        );
        if (!record) {
          record = { id: `rec-${++sequence}`, fields: {}, tableId: _tableId };
          records.push(record);
        }
        record.fields = { ...input.fields };
        output.push(record);
      }
      return { records: output };
    },
    async deleteRecords(_tableId: string, recordIds: readonly string[]) {
      for (const recordId of recordIds) {
        const index = records.findIndex(
          (record) => record.tableId === _tableId && record.id === recordId,
        );
        if (index >= 0) records.splice(index, 1);
      }
      return {
        records: recordIds.map((id) => ({ id, deleted: true as const })),
      };
    },
  };
  return {
    client,
    records,
    tables,
    listCalls: () => listCalls,
    failNextUpsert(error = new Error("simulated Airtable outage")) {
      nextUpsertError = error;
    },
  };
}

function eventDataRepository(
  testEnv: CloudflareEnvironment,
  rooms: AirtableRoomRepository,
  provider: ReturnType<typeof fakeAirtable>,
  now?: () => number,
) {
  return new AirtableEventDataRepository(testEnv, {
    rooms,
    createClient: () => provider.client,
    now,
  });
}

describe("Airtable authoritative room repository", () => {
  beforeEach(async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    await env.DB.prepare(
      "DELETE FROM integration_connections WHERE event_id = ? AND provider = 'airtable_repository'",
    )
      .bind(viewer.eventId)
      .run();
    await env.DB.prepare(
      "UPDATE events SET repository_provider = 'd1', repository_locked_at = NULL WHERE id = ?",
    )
      .bind(viewer.eventId)
      .run();
  });

  describe("programme projection workflows", () => {
    it("stages and reads a version-scoped published programme from Airtable", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoProgramme(testEnv);
      await env.DB.prepare(
        `UPDATE rooms SET status = 'active'
          WHERE event_id = ? AND id IN ('main','301a','301b','302','303')`,
      )
        .bind(viewer.eventId)
        .run();
      await env.DB.prepare(
        `UPDATE rooms SET building = 'North Hall', level = 'Ground'
          WHERE event_id = ? AND id = 'main'`,
      )
        .bind(viewer.eventId)
        .run();
      const frozenContent = await env.DB.prepare(
        `SELECT content.session_id AS sessionId, content.title,
                content.content_status AS contentStatus
           FROM schedule_session_contents content
           JOIN schedule_versions version
             ON version.id = content.schedule_version_id
            AND version.event_id = content.event_id
          WHERE content.event_id = ? AND version.status = 'published'
          ORDER BY content.session_id LIMIT 1`,
      )
        .bind(viewer.eventId)
        .first<{
          sessionId: string;
          title: string;
          contentStatus: string;
        }>();
      expect(frozenContent).not.toBeNull();
      expect(frozenContent?.contentStatus).toBe("approved");
      await env.DB.prepare(
        `UPDATE sessions SET title = 'Mutable title after publication',
                             visibility = 'private',
                             updated_at = unixepoch()
          WHERE id = ? AND event_id = ?`,
      )
        .bind(frozenContent!.sessionId, viewer.eventId)
        .run();
      const provider = fakeAirtable();
      const rooms = new AirtableRoomRepository(testEnv, {
        createClient: () => provider.client,
      });
      await rooms.configure(viewer, connectionInput);
      const programme = new AirtableProgrammeRepository(testEnv, {
        rooms,
        createClient: () => provider.client,
      });
      const migration = new AirtableMigrationService(testEnv, {
        rooms,
        programme,
        eventData: eventDataRepository(testEnv, rooms, provider),
      });
      const preview = await migration.preview(viewer, "airtable");
      expect(
        preview.items.some((item) => item.entityType === "published_session"),
      ).toBe(true);
      expect(
        preview.items.some(
          (item) => item.entityType === "published_schedule_entry",
        ),
      ).toBe(true);
      const confirmation = await migration.confirm(viewer, preview.previewId);
      const migrationEntityTypes = await env.DB.prepare(
        `SELECT DISTINCT entity_type AS entityType
           FROM integration_run_items WHERE run_id = ? ORDER BY entity_type`,
      )
        .bind(confirmation.runId)
        .all<{ entityType: string }>();
      expect(migrationEntityTypes.results.map((row) => row.entityType)).toEqual(
        expect.arrayContaining([
          "room",
          "published_speaker",
          "published_session",
          "published_schedule_entry",
        ]),
      );
      const version = await env.DB.prepare(
        `SELECT id FROM schedule_versions
          WHERE event_id = ? AND status = 'published'
          ORDER BY published_at DESC LIMIT 1`,
      )
        .bind(viewer.eventId)
        .first<{ id: string }>();
      expect(version).not.toBeNull();

      const snapshot = await programme.readPublished(
        viewer.organisationId,
        viewer.eventId,
        version!.id,
        { bypassCache: true },
      );
      expect(snapshot.sessions.length).toBeGreaterThan(0);
      expect(
        snapshot.sessions.find(
          (session) => session.id === frozenContent!.sessionId,
        )?.title,
      ).toBe(frozenContent!.title);
      expect(snapshot.speakers.length).toBeGreaterThan(0);
      expect(snapshot.freshness).toMatchObject({
        source: "airtable",
        cached: false,
      });
      const providerReadsAfterValidation = provider.listCalls();
      const cachedSnapshot = await programme.readPublished(
        viewer.organisationId,
        viewer.eventId,
        version!.id,
      );
      expect(cachedSnapshot.freshness.cached).toBe(true);
      expect(provider.listCalls()).toBe(providerReadsAfterValidation);
      expect(
        provider.records.find(
          (record) => record.fields["Program Cue ID"] === "main",
        )?.fields,
      ).toMatchObject({ Building: "North Hall", Level: "Ground" });
      expect(
        provider.records.filter(
          (record) =>
            record.fields["Version ID"] === version!.id &&
            record.fields.Status === "active",
        ).length,
      ).toBe(snapshot.sessions.length * 2 + snapshot.speakers.length);

      const privateCandidate = snapshot.sessions.find(
        (session) => session.id !== frozenContent!.sessionId,
      );
      expect(privateCandidate).toBeDefined();
      const draftVersionId = `airtable-snapshot-visibility-${crypto.randomUUID()}`;
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO schedule_versions (
             id, event_id, version_number, status, created_by_person_id
           )
           SELECT ?, event.id,
                  COALESCE((SELECT MAX(version_number) + 1
                              FROM schedule_versions
                             WHERE event_id = event.id), 1),
                  'draft', ?
             FROM events event
            WHERE event.id = ? AND event.organisation_id = ?`,
        ).bind(
          draftVersionId,
          viewer.personId,
          viewer.eventId,
          viewer.organisationId,
        ),
        env.DB.prepare(
          `INSERT INTO schedule_entries (
             id, event_id, schedule_version_id, session_id, room_id,
             starts_at, ends_at
           )
           SELECT lower(hex(randomblob(16))), event_id, ?, session_id, room_id,
                  starts_at, ends_at
             FROM schedule_entries
            WHERE event_id = ? AND schedule_version_id = ?`,
        ).bind(draftVersionId, viewer.eventId, version!.id),
        env.DB.prepare(
          `UPDATE schedule_session_contents
              SET visibility = 'private', content_status = 'draft',
                  approved_by_person_id = NULL, approved_at = NULL,
                  approval_source = NULL, updated_at = unixepoch()
            WHERE schedule_version_id = ? AND event_id = ? AND session_id = ?`,
        ).bind(draftVersionId, viewer.eventId, privateCandidate!.id),
      ]);
      await expect(
        programme.stagePublication(
          {
            organisationId: viewer.organisationId,
            eventId: viewer.eventId,
            personId: viewer.personId,
          },
          draftVersionId,
        ),
      ).resolves.toMatchObject({ idempotent: false });
      expect(
        provider.records.some(
          (record) =>
            record.fields["Version ID"] === draftVersionId &&
            record.fields["Session ID"] === privateCandidate!.id &&
            record.fields.Status === "active",
        ),
      ).toBe(false);
      await expect(
        programme.stagePublication(
          {
            organisationId: viewer.organisationId,
            eventId: viewer.eventId,
            personId: viewer.personId,
          },
          version!.id,
        ),
      ).resolves.toMatchObject({ idempotent: true });

      const sessionRecord = provider.records.find(
        (record) =>
          record.fields["Version ID"] === version!.id &&
          typeof record.fields["Session ID"] === "string" &&
          typeof record.fields.Title === "string",
      );
      expect(sessionRecord).toBeDefined();
      sessionRecord!.fields.Title = "Edited outside Program Cue";
      await expect(
        programme.stagePublication(
          {
            organisationId: viewer.organisationId,
            eventId: viewer.eventId,
            personId: viewer.personId,
          },
          version!.id,
        ),
      ).rejects.toThrow(
        /no longer matches its immutable Program Cue snapshot/iu,
      );
      await expect(
        rooms.getConnectionSummary(viewer.organisationId, viewer.eventId),
      ).resolves.toMatchObject({ status: "needs_attention" });
      await env.DB.prepare(
        `UPDATE integration_connections SET status = 'connected'
          WHERE event_id = ? AND organisation_id = ?
            AND provider = 'airtable_repository'`,
      )
        .bind(viewer.eventId, viewer.organisationId)
        .run();
      await expect(
        programme.readPublished(
          viewer.organisationId,
          viewer.eventId,
          version!.id,
          { bypassCache: true },
        ),
      ).rejects.toThrow(
        /changed outside the Program Cue publication boundary/i,
      );
      await expect(
        rooms.getConnectionSummary(viewer.organisationId, viewer.eventId),
      ).resolves.toMatchObject({ status: "needs_attention" });
    });
  });
});
