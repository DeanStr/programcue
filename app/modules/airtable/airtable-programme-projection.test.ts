import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { ensureDemoProgramme } from "~/platform/demo/seed.server";
import { ensureJudgedDemoWorkflow } from "~/platform/demo/demo-reset.server";
import {
  EventService,
  EventRepositoryMigrationRequiredError,
} from "~/modules/events/event-service.server";
import { EventTrackInUseError } from "~/modules/events/event-repository.server";
import { EvaluationService } from "~/modules/evaluations/evaluation-service.server";
import { ScheduleService } from "~/modules/schedule/schedule-service.server";
import { SubmissionService } from "~/modules/submissions/submission-service.server";
import { TaskService } from "~/modules/tasks/task-service.server";
import { ParticipantRetentionService } from "~/modules/privacy/participant-retention-service.server";
import {
  AirtableProviderError,
  type AirtableRecord,
  type AirtableTable,
} from "./airtable-client.server";
import { AirtableEventDataRepository } from "./airtable-event-data-repository.server";
import {
  AirtableEventDataUnsynchronizedError,
  AirtableEventProjectionCommitError,
} from "./airtable-event-data-repository.server";
import { AIRTABLE_EVENT_TABLE_SPECS } from "./airtable-event-data-schema";
import {
  AirtableCommandReplayUnavailableError,
  AirtableProviderBoundary,
  airtableIntentCommand,
} from "./airtable-provider-boundary.server";
import { AirtableProjectionRecoveryService } from "./airtable-projection-recovery-service.server";
import {
  AirtableMigrationService,
  AirtableMigrationStateError,
} from "./airtable-migration-service.server";
import { AirtableProgrammeRepository } from "./airtable-programme-repository.server";
import {
  AirtableRepositoryConfigurationError,
  AirtableRepositoryReconciliationError,
  AirtableRepositorySchemaError,
  AirtableRoomRepository,
} from "./airtable-room-repository.server";
import {
  AIRTABLE_EVENT_DATA_TABLE_NAMES,
  AIRTABLE_ROOMS_TABLE,
  AIRTABLE_SCHEMA_VERSION,
  AIRTABLE_SYNCHRONOUS_MIGRATION_MAX_CHANGES,
} from "./airtable-schema";

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

const owner: Viewer = {
  ...viewer,
  personId: "person-demo-owner",
  name: "Maya Chen",
  email: "maya@example.com",
  role: "owner",
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

function eventInput(event: Awaited<ReturnType<EventService["getSetup"]>>) {
  return {
    revision: event.revision,
    name: event.name,
    timezone: event.timezone,
    startDate: event.startDate,
    endDate: event.endDate,
    venue: event.venue,
    city: event.city,
    publicSlug: event.publicSlug,
    brandAccent: event.brandAccent,
    participantLogoUrl: event.participantLogoUrl,
    participantWelcomeText: event.participantWelcomeText,
    participantSupportUrl: event.participantSupportUrl,
    description: event.description,
    repositoryProvider: event.repositoryProvider,
    retentionMonths: event.retentionMonths,
    submissionAccessMode: event.submissionAccessMode,
    allowAnonymousDrafts: event.allowAnonymousDrafts,
    duplicatePersonWarnings: event.duplicatePersonWarnings,
    rooms: event.rooms,
    tracks: event.tracks,
    sessionFormats: event.sessionFormats,
    filePolicy: event.filePolicy,
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

async function changeEventFormat(label: string) {
  const result = await env.DB.prepare(
    `UPDATE events SET session_formats_json = ?, updated_at = unixepoch()
      WHERE id = ?`,
  )
    .bind(
      JSON.stringify([
        {
          key: "talk",
          label,
          defaultDurationMinutes: 40,
          position: 0,
        },
      ]),
      viewer.eventId,
    )
    .run();
  expect(result.meta.changes).toBe(1);
}

async function initializeEventDataProjection(
  repository: AirtableEventDataRepository,
  suffix: string,
  rooms?: AirtableRoomRepository,
) {
  if (rooms) {
    const d1Rooms = await env.DB.prepare(
      `SELECT id, name, capacity, resources_json AS resourcesJson, position,
              building, level
         FROM rooms WHERE event_id = ? AND status = 'active'
         ORDER BY position, name, id`,
    )
      .bind(viewer.eventId)
      .all<{
        id: string;
        name: string;
        capacity: number;
        resourcesJson: string;
        position: number;
        building: string | null;
        level: string | null;
      }>();
    await rooms.replaceRooms(
      viewer.organisationId,
      viewer.eventId,
      d1Rooms.results.map(({ resourcesJson, ...room }) => ({
        ...room,
        resources: JSON.parse(resourcesJson) as string[],
      })),
      1,
    );
  }
  await repository.synchronizeFromD1(
    {
      organisationId: viewer.organisationId,
      eventId: viewer.eventId,
      personId: viewer.personId,
    },
    {
      idempotencyKey: `airtable-test-initial-sync:${suffix}`,
      reason: "Airtable repository contract test",
    },
  );
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
        `SELECT content.session_id AS sessionId, content.title
           FROM schedule_session_contents content
           JOIN schedule_versions version
             ON version.id = content.schedule_version_id
            AND version.event_id = content.event_id
          WHERE content.event_id = ? AND version.status = 'published'
          ORDER BY content.session_id LIMIT 1`,
      )
        .bind(viewer.eventId)
        .first<{ sessionId: string; title: string }>();
      expect(frozenContent).not.toBeNull();
      await env.DB.prepare(
        `UPDATE sessions SET title = 'Mutable title after publication',
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
