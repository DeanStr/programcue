import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { EventService } from "~/modules/events/event-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureJudgedDemoWorkflow } from "~/platform/demo/demo-reset.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  AirtableProviderError,
  type AirtableRecord,
  type AirtableTable,
} from "./airtable-client.server";
import { AirtableEventDataRepository } from "./airtable-event-data-repository.server";
import { AirtableMigrationService } from "./airtable-migration-service.server";
import { AirtableProgrammeRepository } from "./airtable-programme-repository.server";
import {
  AirtableProviderBoundary,
  airtableIntentCommand,
} from "./airtable-provider-boundary.server";
import {
  AirtableRepositoryReconciliationError,
  AirtableRoomRepository,
} from "./airtable-room-repository.server";
import {
  AIRTABLE_EVENT_DATA_TABLE_NAMES,
  AIRTABLE_ROOMS_TABLE,
  AIRTABLE_SCHEMA_VERSION,
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
    venueAddress: event.venueAddress,
    venueMapUrl: event.venueMapUrl,
    city: event.city,
    publicSlug: event.publicSlug,
    brandAccent: event.brandAccent,
    programmeHeroImageUrl: event.programmeHeroImageUrl,
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

  describe("room authority workflows", () => {
    it("validates and prepares an event connection without persisting it", async () => {
      const provider = fakeAirtable();
      const repository = new AirtableRoomRepository(
        env as unknown as CloudflareEnvironment,
        { createClient: () => provider.client },
      );
      const prepared = await repository.provisionForEvent(
        owner,
        owner.eventId,
        connectionInput,
      );

      expect(prepared.configuration.baseId).toBe(connectionInput.baseId);
      expect(prepared.configuration.tables.rooms.name).toBe(
        AIRTABLE_ROOMS_TABLE,
      );
      expect(prepared.encryptedCredentials).not.toContain(
        connectionInput.personalAccessToken,
      );
      expect(provider.records).toEqual([]);
      expect(
        await env.DB.prepare(
          "SELECT 1 FROM integration_connections WHERE id = ?",
        )
          .bind(prepared.connectionId)
          .first(),
      ).toBeNull();
    });

    it("rejects event-scoped administrators before provisioning a repository", async () => {
      const provider = fakeAirtable();
      const repository = new AirtableRoomRepository(
        env as unknown as CloudflareEnvironment,
        { createClient: () => provider.client },
      );

      await expect(
        repository.provisionForEvent(viewer, viewer.eventId, connectionInput),
      ).rejects.toMatchObject({ status: 403 });
      expect(provider.tables).toEqual([]);
    });

    it("provisions the managed schema, encrypts credentials and audits configuration", async () => {
      const provider = fakeAirtable();
      const repository = new AirtableRoomRepository(
        env as unknown as CloudflareEnvironment,
        { createClient: () => provider.client },
      );

      const configured = await repository.configure(viewer, connectionInput);
      expect(provider.tables[0]).toMatchObject({
        id: configured.configuration.tables.rooms.id,
        name: "Program Cue Rooms",
        fields: expect.arrayContaining([
          expect.objectContaining({
            name: "Program Cue ID",
            type: "singleLineText",
          }),
          expect.objectContaining({ name: "Capacity", type: "number" }),
        ]),
      });
      expect(provider.tables.map((table) => table.name)).toEqual([
        "Program Cue Rooms",
        "Program Cue Published Speakers",
        "Program Cue Published Sessions",
        "Program Cue Published Schedule",
        ...Object.values(AIRTABLE_EVENT_DATA_TABLE_NAMES),
      ]);
      expect(provider.records).toEqual([]);
      const row = await env.DB.prepare(
        `SELECT status, direction, encrypted_credentials AS encryptedCredentials,
                configuration_json AS configurationJson
           FROM integration_connections WHERE id = ?`,
      )
        .bind(configured.connectionId)
        .first<{
          status: string;
          direction: string;
          encryptedCredentials: string;
          configurationJson: string;
        }>();
      expect(row).toMatchObject({
        status: "connected",
        direction: "bidirectional",
      });
      expect(row?.encryptedCredentials).not.toContain(
        connectionInput.personalAccessToken,
      );
      expect(JSON.parse(row?.configurationJson ?? "{}")).toMatchObject({
        schemaVersion: AIRTABLE_SCHEMA_VERSION,
        authoritativeEntities: [
          "rooms",
          "event_configuration",
          "forms",
          "submissions",
          "evaluations",
          "sessions",
          "tasks",
          "published_programme",
        ],
      });
      await expect(
        env.DB.prepare(
          "SELECT 1 FROM audit_events WHERE event_id = ? AND action = 'airtable.repository.configured'",
        )
          .bind(viewer.eventId)
          .first(),
      ).resolves.not.toBeNull();
    });
  });

  describe("room authority workflows", () => {
    it("does not save credentials when record-write verification fails", async () => {
      const provider = fakeAirtable();
      const repository = new AirtableRoomRepository(
        env as unknown as CloudflareEnvironment,
        {
          createClient: () => ({
            ...provider.client,
            upsertRecords: async () => {
              throw new AirtableProviderError(
                "Token cannot write records in this base",
                403,
                "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND",
              );
            },
          }),
        },
      );

      await expect(
        repository.configure(viewer, connectionInput),
      ).rejects.toEqual(
        expect.objectContaining({
          status: 403,
          providerCode: "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND",
        }),
      );
      await expect(
        env.DB.prepare(
          `SELECT 1 FROM integration_connections
            WHERE event_id = ? AND provider = 'airtable_repository'`,
        )
          .bind(viewer.eventId)
          .first(),
      ).resolves.toBeNull();
    });
  });

  describe("room authority workflows", () => {
    it("writes Airtable first, reconciles the Program Cue copy, and retires removed rooms", async () => {
      const provider = fakeAirtable();
      const repository = new AirtableRoomRepository(
        env as unknown as CloudflareEnvironment,
        { createClient: () => provider.client },
      );
      await repository.configure(viewer, connectionInput);
      const eventData = eventDataRepository(
        env as unknown as CloudflareEnvironment,
        repository,
        provider,
      );
      const migration = new AirtableMigrationService(
        env as unknown as CloudflareEnvironment,
        {
          rooms: repository,
          eventData,
        },
      );
      const preview = await migration.preview(viewer, "airtable");
      await migration.confirm(viewer, preview.previewId);

      const service = new EventService(
        env as unknown as CloudflareEnvironment,
        {
          airtableRooms: repository,
          airtableEventData: eventData,
        },
      );
      const before = await service.getSetup(viewer);
      const retained = before.rooms.slice(1);
      await service.saveSetup(viewer, {
        ...eventInput(before),
        rooms: retained.map((room, position) => ({
          ...room,
          name: position === 0 ? "Renamed in Airtable" : room.name,
          position,
        })),
      });

      const after = await service.getSetup(viewer);
      expect(after.rooms).toHaveLength(retained.length);
      expect(after.rooms[0]?.name).toBe("Renamed in Airtable");
      const retiredId = before.rooms[0]!.id;
      expect(
        provider.records.find(
          (record) => record.fields["Program Cue ID"] === retiredId,
        )?.fields.Status,
      ).toBe("retired");
      await expect(
        env.DB.prepare("SELECT status FROM rooms WHERE event_id = ? AND id = ?")
          .bind(viewer.eventId, retiredId)
          .first<{ status: string }>(),
      ).resolves.toMatchObject({ status: "retired" });
    });
  });

  describe("room authority workflows", () => {
    it("synchronizes the complete managed event-data projection with explicit domain schemas", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureJudgedDemoWorkflow(testEnv);
      const teamId = `airtable-routing-team-${crypto.randomUUID()}`;
      await testEnv.DB.prepare(
        `INSERT INTO evaluation_teams (id, event_id, name, status)
         VALUES (?, ?, ?, 'active')`,
      )
        .bind(teamId, viewer.eventId, `Airtable routing ${teamId}`)
        .run();
      const submission = await testEnv.DB.prepare(
        `SELECT id FROM submissions WHERE event_id = ? ORDER BY id LIMIT 1`,
      )
        .bind(viewer.eventId)
        .first<{ id: string }>();
      const track = await testEnv.DB.prepare(
        `SELECT id, name FROM tracks WHERE event_id = ? ORDER BY id LIMIT 1`,
      )
        .bind(viewer.eventId)
        .first<{ id: string; name: string }>();
      expect(submission).not.toBeNull();
      expect(track).not.toBeNull();
      await testEnv.DB.batch([
        testEnv.DB.prepare(
          `DELETE FROM submission_track_selections
            WHERE submission_id = ? AND event_id = ?`,
        ).bind(submission!.id, viewer.eventId),
        testEnv.DB.prepare(
          `DELETE FROM submission_routing_teams
            WHERE submission_id = ? AND event_id = ?`,
        ).bind(submission!.id, viewer.eventId),
        testEnv.DB.prepare(
          `INSERT INTO submission_track_selections (
             submission_id, event_id, track_id, track_name_snapshot, position
           ) VALUES (?, ?, ?, ?, 0)`,
        ).bind(submission!.id, viewer.eventId, track!.id, track!.name),
        testEnv.DB.prepare(
          `INSERT INTO submission_routing_teams (submission_id, event_id, team_id)
           VALUES (?, ?, ?)`,
        ).bind(submission!.id, viewer.eventId, teamId),
      ]);
      const provider = fakeAirtable();
      const rooms = new AirtableRoomRepository(testEnv, {
        createClient: () => provider.client,
      });
      await rooms.configure(viewer, connectionInput);
      const repository = eventDataRepository(testEnv, rooms, provider);

      const d1 = await repository.readD1Projection(viewer.eventId);
      expect(new Set(d1.entities.map((entity) => entity.domain))).toEqual(
        new Set([
          "event_setup",
          "forms",
          "submissions",
          "evaluations",
          "sessions",
          "tasks",
        ]),
      );
      expect(d1.entities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tableKey: "submissionTrackSelections",
            entityType: "submission_track_selection",
            entityId: `${submission!.id}:${track!.id}`,
            payload: expect.objectContaining({
              submission_id: submission!.id,
              track_id: track!.id,
              track_name_snapshot: track!.name,
              position: 0,
            }),
          }),
          expect.objectContaining({
            tableKey: "submissionRoutingTeams",
            entityType: "submission_routing_team",
            entityId: `${submission!.id}:${teamId}`,
            payload: expect.objectContaining({
              submission_id: submission!.id,
              team_id: teamId,
            }),
          }),
        ]),
      );
      await initializeEventDataProjection(repository, "complete-slice", rooms);

      const airtable = await repository.readAuthoritative(
        viewer.organisationId,
        viewer.eventId,
        { bypassCache: true },
      );
      expect(airtable.hash).toBe(d1.hash);
      expect(airtable.entities).toHaveLength(d1.entities.length);
      expect(airtable.entities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tableKey: "submissionTrackSelections",
            entityId: `${submission!.id}:${track!.id}`,
          }),
          expect.objectContaining({
            tableKey: "submissionRoutingTeams",
            entityId: `${submission!.id}:${teamId}`,
          }),
        ]),
      );
      await expect(
        repository.assertSynchronized(viewer.organisationId, viewer.eventId),
      ).resolves.toMatchObject({ d1: { hash: d1.hash } });
    });
  });

  describe("room authority workflows", () => {
    it("blocks stale D1 room projections and reconciles them explicitly through Event Setup", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      const provider = fakeAirtable();
      const rooms = new AirtableRoomRepository(testEnv, {
        createClient: () => provider.client,
      });
      await rooms.configure(viewer, connectionInput);
      const eventData = eventDataRepository(testEnv, rooms, provider);
      const migration = new AirtableMigrationService(testEnv, {
        rooms,
        programme: new AirtableProgrammeRepository(testEnv, {
          rooms,
          createClient: () => provider.client,
        }),
        eventData,
      });
      const preview = await migration.preview(viewer, "airtable");
      await migration.confirm(viewer, preview.previewId);
      const boundary = new AirtableProviderBoundary(testEnv, {
        repository: eventData,
      });

      const authoritativeRoom = provider.records.find(
        (record) =>
          record.fields["Event ID"] === viewer.eventId &&
          typeof record.fields["Program Cue ID"] === "string" &&
          record.fields.Status === "active",
      );
      expect(authoritativeRoom).toBeDefined();
      const changedCapacity = Number(authoritativeRoom!.fields.Capacity) + 17;
      authoritativeRoom!.fields.Capacity = changedCapacity;

      let commandCalled = false;
      const identity = await airtableIntentCommand(
        "test.room-dependent-command",
        viewer,
        crypto.randomUUID(),
        { roomId: authoritativeRoom!.fields["Program Cue ID"] },
      );
      await expect(
        boundary.executeIdempotent(viewer, identity, async () => {
          commandCalled = true;
        }),
      ).rejects.toBeInstanceOf(AirtableRepositoryReconciliationError);
      expect(commandCalled).toBe(false);
      await expect(boundary.assertReadable(viewer)).rejects.toBeInstanceOf(
        AirtableRepositoryReconciliationError,
      );

      const events = new EventService(testEnv, {
        airtableRooms: rooms,
        airtableEventData: eventData,
      });
      const setup = await events.getSetup(viewer);
      expect(
        setup.rooms.find(
          (room) => room.id === authoritativeRoom!.fields["Program Cue ID"],
        )?.capacity,
      ).toBe(changedCapacity);
      await events.saveSetup(viewer, eventInput(setup));

      await expect(boundary.assertReadable(viewer)).resolves.toBeDefined();
      await expect(
        testEnv.DB.prepare(
          "SELECT capacity FROM rooms WHERE event_id = ? AND id = ?",
        )
          .bind(viewer.eventId, authoritativeRoom!.fields["Program Cue ID"])
          .first<{ capacity: number }>(),
      ).resolves.toEqual({ capacity: changedCapacity });
    });
  });
});
