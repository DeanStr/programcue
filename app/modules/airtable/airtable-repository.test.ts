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

  it("fails when an existing managed table has an incompatible primary field", async () => {
    const provider = fakeAirtable([
      {
        id: "tbl-bad",
        name: "Program Cue Rooms",
        primaryFieldId: "fld-name",
        fields: [{ id: "fld-name", name: "Name", type: "singleLineText" }],
      },
    ]);
    const repository = new AirtableRoomRepository(
      env as unknown as CloudflareEnvironment,
      { createClient: () => provider.client },
    );

    await expect(
      repository.configure(viewer, connectionInput),
    ).rejects.toBeInstanceOf(AirtableRepositorySchemaError);
    await expect(
      env.DB.prepare(
        "SELECT 1 FROM integration_connections WHERE event_id = ? AND provider = 'airtable_repository'",
      )
        .bind(viewer.eventId)
        .first(),
    ).resolves.toBeNull();
  });

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

    await expect(repository.configure(viewer, connectionInput)).rejects.toEqual(
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

  it("quarantines a validation record when record-delete verification fails", async () => {
    const provider = fakeAirtable();
    const repository = new AirtableRoomRepository(
      env as unknown as CloudflareEnvironment,
      {
        createClient: () => ({
          ...provider.client,
          deleteRecords: async () => {
            throw new AirtableProviderError(
              "Token cannot delete records in this base",
              403,
              "INVALID_PERMISSIONS_OR_MODEL_NOT_FOUND",
            );
          },
        }),
      },
    );

    await expect(repository.configure(viewer, connectionInput)).rejects.toEqual(
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
    expect(provider.records).toHaveLength(1);
    expect(provider.records[0]?.fields["Program Cue ID"]).toMatch(
      /^connection-validation-[a-f0-9-]+$/u,
    );
    expect(provider.records[0]?.fields["Event ID"]).not.toBe(viewer.eventId);

    const retry = new AirtableRoomRepository(
      env as unknown as CloudflareEnvironment,
      { createClient: () => provider.client },
    );
    await retry.configure(viewer, connectionInput);
    await expect(
      retry.readRooms(viewer.organisationId, viewer.eventId, {
        bypassCache: true,
      }),
    ).resolves.toMatchObject({ rooms: [] });
  });

  it("records a diff, confirms D1 to Airtable migration, and exposes freshness", async () => {
    const provider = fakeAirtable();
    let now = 2_000_000;
    const repository = new AirtableRoomRepository(
      env as unknown as CloudflareEnvironment,
      { createClient: () => provider.client, now: () => now },
    );
    await repository.configure(viewer, connectionInput);
    const eventData = eventDataRepository(
      env as unknown as CloudflareEnvironment,
      repository,
      provider,
      () => now,
    );
    const migration = new AirtableMigrationService(
      env as unknown as CloudflareEnvironment,
      {
        rooms: repository,
        eventData,
        now: () => now,
      },
    );

    const preview = await migration.preview(viewer, "airtable");
    expect(preview.from).toBe("d1");
    expect(preview.to).toBe("airtable");
    expect(preview.counts.create).toBeGreaterThan(0);
    expect(preview.items.every((item) => item.action === "create")).toBe(true);

    const confirmed = await migration.confirm(viewer, preview.previewId);
    expect(confirmed).toMatchObject({
      provider: "airtable",
      idempotent: false,
    });
    await expect(migration.confirm(viewer, preview.previewId)).resolves.toEqual(
      {
        runId: confirmed.runId,
        provider: "airtable",
        idempotent: true,
      },
    );
    const event = await env.DB.prepare(
      `SELECT repository_provider AS repositoryProvider,
              repository_locked_at AS repositoryLockedAt
         FROM events WHERE id = ?`,
    )
      .bind(viewer.eventId)
      .first<{
        repositoryProvider: string;
        repositoryLockedAt: number | null;
      }>();
    expect(event?.repositoryProvider).toBe("airtable");
    expect(event?.repositoryLockedAt).not.toBeNull();
    expect(provider.records.length).toBeGreaterThan(0);
    await expect(
      repository.configure(viewer, {
        ...connectionInput,
        baseId: "app99999999999999",
      }),
    ).rejects.toBeInstanceOf(AirtableRepositoryConfigurationError);

    const service = new EventService(env as unknown as CloudflareEnvironment, {
      airtableRooms: repository,
      airtableEventData: eventData,
    });
    const setup = await service.getSetup(viewer);
    expect(setup.repositoryFreshness).toMatchObject({
      source: "airtable",
      fetchedAt: Math.floor(now / 1_000),
    });
    const callsAfterFirstRead = provider.listCalls();
    now += 1_000;
    const cached = await service.getSetup(viewer);
    expect(cached.repositoryFreshness.cached).toBe(true);
    expect(provider.listCalls()).toBe(callsAfterFirstRead);
  });

  it("writes Airtable first, reconciles the D1 projection, and retires removed rooms", async () => {
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

    const service = new EventService(env as unknown as CloudflareEnvironment, {
      airtableRooms: repository,
      airtableEventData: eventData,
    });
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

  it("aborts a concurrent Event Setup revision conflict without an early Airtable write", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    const provider = fakeAirtable();
    const rooms = new AirtableRoomRepository(testEnv, {
      createClient: () => provider.client,
    });
    await rooms.configure(viewer, connectionInput);
    const eventData = eventDataRepository(testEnv, rooms, provider);
    const migration = new AirtableMigrationService(testEnv, {
      rooms,
      eventData,
    });
    const preview = await migration.preview(viewer, "airtable");
    await migration.confirm(viewer, preview.previewId);
    const service = new EventService(testEnv, {
      airtableRooms: rooms,
      airtableEventData: eventData,
    });
    const setup = await service.getSetup(viewer);
    const beforeRooms = await rooms.readRooms(
      viewer.organisationId,
      viewer.eventId,
      { bypassCache: true },
    );
    const beginCommand = eventData.beginCommand.bind(eventData);
    vi.spyOn(eventData, "beginCommand").mockImplementationOnce(
      async (...args) => {
        const token = await beginCommand(...args);
        await testEnv.DB.prepare(
          "UPDATE events SET revision = revision + 1 WHERE id = ?",
        )
          .bind(viewer.eventId)
          .run();
        return token;
      },
    );

    const failure = await service
      .saveSetup(viewer, {
        ...eventInput(setup),
        rooms: setup.rooms.map((room, index) => ({
          ...room,
          name: index === 0 ? "Must not reach Airtable" : room.name,
        })),
      })
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ name: "EventRevisionConflictError" });
    expect(
      provider.records.find(
        (record) =>
          record.fields["Program Cue ID"] === beforeRooms.rooms[0]!.id &&
          record.fields["Event ID"] === viewer.eventId,
      )?.fields.Name,
    ).toBe(beforeRooms.rooms[0]!.name);
    await expect(
      testEnv.DB.prepare(
        `SELECT status, json_extract(summary_json, '$.phase') AS phase
           FROM integration_runs
          WHERE json_extract(summary_json, '$.operation') = 'event_setup.save'
          ORDER BY created_at DESC LIMIT 1`,
      ).first<{ status: string; phase: string }>(),
    ).resolves.toEqual({ status: "cancelled", phase: "aborted" });
    await expect(
      rooms.getConnectionSummary(viewer.organisationId, viewer.eventId),
    ).resolves.toMatchObject({ status: "connected" });
  });

  it("requires the migration workflow instead of changing provider through save", async () => {
    const provider = fakeAirtable();
    const repository = new AirtableRoomRepository(
      env as unknown as CloudflareEnvironment,
      { createClient: () => provider.client },
    );
    await repository.configure(viewer, connectionInput);
    const service = new EventService(env as unknown as CloudflareEnvironment, {
      airtableRooms: repository,
    });
    const current = await service.getSetup(viewer);

    await expect(
      service.saveSetup(viewer, {
        ...eventInput(current),
        repositoryProvider: "airtable",
      }),
    ).rejects.toBeInstanceOf(EventRepositoryMigrationRequiredError);
    await expect(
      env.DB.prepare(
        "SELECT repository_provider AS provider FROM events WHERE id = ?",
      )
        .bind(viewer.eventId)
        .first<{ provider: string }>(),
    ).resolves.toEqual({ provider: "d1" });
    expect(provider.records).toHaveLength(0);
  });

  it("supports a reconciled Airtable to D1 authority migration", async () => {
    const provider = fakeAirtable();
    const repository = new AirtableRoomRepository(
      env as unknown as CloudflareEnvironment,
      { createClient: () => provider.client },
    );
    await repository.configure(viewer, connectionInput);
    const migration = new AirtableMigrationService(
      env as unknown as CloudflareEnvironment,
      {
        rooms: repository,
        eventData: eventDataRepository(
          env as unknown as CloudflareEnvironment,
          repository,
          provider,
        ),
      },
    );
    const outbound = await migration.preview(viewer, "airtable");
    await migration.confirm(viewer, outbound.previewId);

    const inbound = await migration.preview(viewer, "d1");
    expect(inbound.counts.noop).toBeGreaterThan(0);
    expect(inbound.items).toEqual([]);
    await migration.confirm(viewer, inbound.previewId);

    await expect(
      env.DB.prepare(
        "SELECT repository_provider AS provider FROM events WHERE id = ?",
      )
        .bind(viewer.eventId)
        .first<{ provider: string }>(),
    ).resolves.toEqual({ provider: "d1" });
  });

  it("fails before starting an oversized synchronous Airtable migration", async () => {
    const provider = fakeAirtable();
    const repository = new AirtableRoomRepository(
      env as unknown as CloudflareEnvironment,
      { createClient: () => provider.client },
    );
    await repository.configure(viewer, connectionInput);
    const ids = Array.from(
      { length: AIRTABLE_SYNCHRONOUS_MIGRATION_MAX_CHANGES + 1 },
      (_, index) => `airtable-limit-track-${index}`,
    );
    await env.DB.batch(
      ids.map((id, index) =>
        env.DB.prepare(
          `INSERT INTO tracks (
             id, event_id, name, slug, position, exclusive, is_public
           ) VALUES (?, ?, ?, ?, ?, 0, 1)`,
        ).bind(id, viewer.eventId, `Limit track ${index}`, id, index + 100),
      ),
    );
    const migration = new AirtableMigrationService(
      env as unknown as CloudflareEnvironment,
      {
        rooms: repository,
        eventData: eventDataRepository(
          env as unknown as CloudflareEnvironment,
          repository,
          provider,
        ),
      },
    );

    await expect(migration.preview(viewer, "airtable")).rejects.toEqual(
      expect.objectContaining<AirtableMigrationStateError>({
        name: "AirtableMigrationStateError",
        message: expect.stringMatching(
          /synchronous Airtable migration limit/iu,
        ),
      }),
    );
    await expect(
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM integration_runs run
          JOIN integration_connections connection ON connection.id = run.connection_id
         WHERE connection.event_id = ?`,
      )
        .bind(viewer.eventId)
        .first(),
    ).resolves.toEqual({ count: 0 });
    await env.DB.prepare(
      `DELETE FROM tracks WHERE event_id = ? AND id LIKE 'airtable-limit-track-%'`,
    )
      .bind(viewer.eventId)
      .run();
  });

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
    ).rejects.toThrow(/no longer matches its immutable Program Cue snapshot/iu);
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
    ).rejects.toThrow(/changed outside the Program Cue publication boundary/i);
    await expect(
      rooms.getConnectionSummary(viewer.organisationId, viewer.eventId),
    ).resolves.toMatchObject({ status: "needs_attention" });
  });

  it("synchronizes the complete managed event-data projection with explicit domain schemas", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureJudgedDemoWorkflow(testEnv);
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
    await initializeEventDataProjection(repository, "complete-slice", rooms);

    const airtable = await repository.readAuthoritative(
      viewer.organisationId,
      viewer.eventId,
      { bypassCache: true },
    );
    expect(airtable.hash).toBe(d1.hash);
    expect(airtable.entities).toHaveLength(d1.entities.length);
    await expect(
      repository.assertSynchronized(viewer.organisationId, viewer.eventId),
    ).resolves.toMatchObject({ d1: { hash: d1.hash } });
  });

  it("serves the seeded golden path through one Airtable-authoritative service contract", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureJudgedDemoWorkflow(testEnv);
    const provider = fakeAirtable();
    const rooms = new AirtableRoomRepository(testEnv, {
      createClient: () => provider.client,
    });
    await rooms.configure(viewer, connectionInput);
    const eventData = eventDataRepository(testEnv, rooms, provider);
    const programme = new AirtableProgrammeRepository(testEnv, {
      rooms,
      createClient: () => provider.client,
    });
    const migration = new AirtableMigrationService(testEnv, {
      rooms,
      programme,
      eventData,
    });
    const preview = await migration.preview(viewer, "airtable");
    await migration.confirm(viewer, preview.previewId);
    const boundary = new AirtableProviderBoundary(testEnv, {
      repository: eventData,
    });

    const forms = await new SubmissionService(testEnv, {
      airtable: boundary,
    }).listAdminForms(viewer);
    const evaluations = await new EvaluationService(testEnv, {
      airtable: boundary,
    }).getAdminWorkspace(viewer);
    const schedule = await new ScheduleService(testEnv, {
      airtable: boundary,
    }).getWorkspace(viewer);
    const taskService = new TaskService(testEnv, { airtable: boundary });
    const tasks = await taskService.getAdminWorkspace(viewer);

    expect(forms.length).toBeGreaterThan(0);
    expect(evaluations.assignments.length).toBeGreaterThan(0);
    expect(tasks.tasks.length).toBeGreaterThan(0);
    expect(schedule.version?.status).toBe("published");

    await taskService.addComment(
      viewer,
      tasks.tasks[0]!.id,
      "Airtable-backed golden-path reconciliation",
      "administrator",
    );
    const synchronized = await eventData.assertSynchronized(
      viewer.organisationId,
      viewer.eventId,
    );
    expect(synchronized.airtable.hash).toBe(synchronized.d1.hash);
    expect(
      synchronized.airtable.entities.some(
        (entity) =>
          entity.entityType === "task_comment" &&
          entity.payload.body === "Airtable-backed golden-path reconciliation",
      ),
    ).toBe(true);
  });

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

  it("recovers a crash after D1 commits but before Airtable is written", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    const provider = fakeAirtable();
    const rooms = new AirtableRoomRepository(testEnv, {
      createClient: () => provider.client,
    });
    await rooms.configure(viewer, connectionInput);
    const repository = eventDataRepository(testEnv, rooms, provider);
    await initializeEventDataProjection(
      repository,
      "before-airtable-crash",
      rooms,
    );
    const token = await repository.beginCommand(viewer, {
      idempotencyKey: "airtable-command:before-airtable-crash",
      operation: "event_setup.save",
    });

    await changeEventFormat("Talk after D1 crash window");
    await expect(
      repository.assertSynchronized(viewer.organisationId, viewer.eventId),
    ).rejects.toBeInstanceOf(AirtableEventDataUnsynchronizedError);

    await expect(
      repository.recoverCommand(viewer, token.runId),
    ).resolves.toMatchObject({ runId: token.runId });
    await expect(
      repository.assertSynchronized(viewer.organisationId, viewer.eventId),
    ).resolves.toBeDefined();
  });

  it("recovers a crash after Airtable accepts the write but before finalization", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    const provider = fakeAirtable();
    const rooms = new AirtableRoomRepository(testEnv, {
      createClient: () => provider.client,
    });
    await rooms.configure(viewer, connectionInput);
    const repository = eventDataRepository(testEnv, rooms, provider);
    await initializeEventDataProjection(
      repository,
      "before-finalize-crash",
      rooms,
    );
    const token = await repository.beginCommand(viewer, {
      idempotencyKey: "airtable-command:before-finalize-crash",
      operation: "event_setup.save",
    });
    await changeEventFormat("Talk after Airtable crash window");

    await repository.prepareCommandCompletion(token);
    await expect(
      repository.assertSynchronized(viewer.organisationId, viewer.eventId),
    ).rejects.toBeInstanceOf(AirtableEventDataUnsynchronizedError);
    await expect(
      repository.recoverCommand(viewer, token.runId),
    ).resolves.toMatchObject({ runId: token.runId });
    await expect(
      repository.assertSynchronized(viewer.organisationId, viewer.eventId),
    ).resolves.toBeDefined();
  });

  it("reports committed-partial failure, blocks the event and replays recovery after an Airtable outage", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    const provider = fakeAirtable();
    const rooms = new AirtableRoomRepository(testEnv, {
      createClient: () => provider.client,
    });
    await rooms.configure(viewer, connectionInput);
    const repository = eventDataRepository(testEnv, rooms, provider);
    await initializeEventDataProjection(repository, "provider-outage", rooms);
    const token = await repository.beginCommand(viewer, {
      idempotencyKey: "airtable-command:provider-outage",
      operation: "event_setup.save",
    });
    await changeEventFormat("Talk during provider outage");
    provider.failNextUpsert();

    const failure = await repository
      .completeCommand(token)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AirtableEventProjectionCommitError);
    expect(failure).toMatchObject({ committed: true, runId: token.runId });
    await expect(
      rooms.getConnectionSummary(viewer.organisationId, viewer.eventId),
    ).resolves.toMatchObject({ status: "needs_attention" });
    await expect(
      repository.assertSynchronized(viewer.organisationId, viewer.eventId),
    ).rejects.toBeDefined();

    const recovery = new AirtableProjectionRecoveryService(testEnv, {
      boundary: new AirtableProviderBoundary(testEnv, { repository }),
    });
    await expect(recovery.list(viewer)).resolves.toEqual([
      expect.objectContaining({
        runId: token.runId,
        status: "partially_failed",
        phase: "d1_committed",
      }),
    ]);
    await expect(
      recovery.list({ ...viewer, eventId: "evt-unrelated" }),
    ).resolves.toEqual([]);
    await expect(recovery.recover(viewer, token.runId)).resolves.toMatchObject({
      runId: token.runId,
    });
    await expect(
      rooms.getConnectionSummary(viewer.organisationId, viewer.eventId),
    ).resolves.toMatchObject({ status: "connected" });
  });

  it("returns an explicit replay token and blocks divergent Airtable edits", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    let now = 3_000_000;
    const provider = fakeAirtable();
    const rooms = new AirtableRoomRepository(testEnv, {
      createClient: () => provider.client,
      now: () => now,
    });
    await rooms.configure(viewer, connectionInput);
    const repository = eventDataRepository(testEnv, rooms, provider, () => now);
    await initializeEventDataProjection(repository, "replay-divergence", rooms);
    const providerReadsBeforeCommand = provider.listCalls();
    const input = {
      idempotencyKey: "airtable-command:replay-divergence",
      operation: "event_setup.save",
    };
    const token = await repository.beginCommand(viewer, input);
    await changeEventFormat("Talk for replay");
    await repository.completeCommand(token);
    expect(provider.listCalls() - providerReadsBeforeCommand).toBe(
      AIRTABLE_EVENT_TABLE_SPECS.length * 3,
    );
    await expect(repository.beginCommand(viewer, input)).resolves.toMatchObject(
      {
        runId: token.runId,
        replayed: true,
      },
    );

    const eventTableId = provider.tables.find(
      (table) =>
        table.name === AIRTABLE_EVENT_DATA_TABLE_NAMES.eventConfiguration,
    )!.id;
    const external = provider.records.find(
      (record) =>
        record.tableId === eventTableId &&
        record.fields["Event ID"] === viewer.eventId &&
        record.fields.Status === "active",
    );
    expect(external).toBeDefined();
    const payload = JSON.parse(String(external!.fields["Payload JSON"]));
    payload.session_formats_json = JSON.stringify([
      {
        key: "talk",
        label: "Direct Airtable edit",
        defaultDurationMinutes: 35,
        position: 0,
      },
    ]);
    external!.fields["Payload JSON"] = JSON.stringify(payload);
    now += 16_000;

    await expect(
      repository.assertSynchronized(viewer.organisationId, viewer.eventId),
    ).rejects.toThrow(/diverged/i);
    await expect(
      rooms.getConnectionSummary(viewer.organisationId, viewer.eventId),
    ).resolves.toMatchObject({ status: "needs_attention" });
  });

  it("returns stored results without re-running profile, submission, evaluation, task or schedule commands", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    const provider = fakeAirtable();
    const rooms = new AirtableRoomRepository(testEnv, {
      createClient: () => provider.client,
    });
    await rooms.configure(viewer, connectionInput);
    const repository = eventDataRepository(testEnv, rooms, provider);
    await initializeEventDataProjection(
      repository,
      "stored-command-results",
      rooms,
    );
    await testEnv.DB.prepare(
      "UPDATE events SET repository_provider = 'airtable' WHERE id = ?",
    )
      .bind(viewer.eventId)
      .run();
    const boundary = new AirtableProviderBoundary(testEnv, { repository });
    const operations = [
      "speaker.profile.update",
      "submission.form.save",
      "evaluation.plan.save",
      "task.template.create",
      "schedule.draft.create",
    ];

    for (const [index, operation] of operations.entries()) {
      const command = {
        idempotencyKey: `airtable-result-replay:${operation}`,
        operation,
      };
      let calls = 0;
      const execute = async () => {
        calls += 1;
        await changeEventFormat(`${operation} result ${index}`);
        return { operation, ordinal: index, values: [null, true, 3] };
      };
      const first = await boundary.executeIdempotent(viewer, command, execute);
      const replay = await boundary.executeIdempotent(viewer, command, execute);
      expect(replay).toEqual(first);
      expect(calls).toBe(1);
    }
  });

  it("separates identical user intents, replays the same intent exactly, and serializes concurrent mutations", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    const provider = fakeAirtable();
    const rooms = new AirtableRoomRepository(testEnv, {
      createClient: () => provider.client,
    });
    await rooms.configure(viewer, connectionInput);
    const repository = eventDataRepository(testEnv, rooms, provider);
    await initializeEventDataProjection(
      repository,
      "user-intent-identity",
      rooms,
    );
    await testEnv.DB.prepare(
      "UPDATE events SET repository_provider = 'airtable' WHERE id = ?",
    )
      .bind(viewer.eventId)
      .run();
    const boundary = new AirtableProviderBoundary(testEnv, { repository });
    const tasks = new TaskService(testEnv, { airtable: boundary });
    const templateInput = {
      name: "Identical intent test",
      description: "The payload is deliberately identical.",
      targetType: "speaker",
      taskType: "checklist",
      impact: "high",
      evidenceMode: "checkbox",
      dueAnchor: "none",
      dueOffsetDays: null,
      fixedDueDate: null,
      autoAssignOnAcceptance: false,
      dependencyIds: [],
    } as const;
    const firstIntent = "task-template-intent-0001";
    const firstId = await tasks.createTemplate(
      viewer,
      templateInput,
      firstIntent,
    );
    await expect(
      tasks.createTemplate(viewer, templateInput, firstIntent),
    ).resolves.toBe(firstId);
    const secondId = await tasks.createTemplate(
      viewer,
      templateInput,
      "task-template-intent-0002",
    );
    expect(secondId).not.toBe(firstId);
    await expect(
      tasks.createTemplate(
        viewer,
        { ...templateInput, description: "A changed payload." },
        firstIntent,
      ),
    ).rejects.toThrow(/request payload/i);
    await expect(
      testEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM task_templates WHERE event_id = ? AND name = ?",
      )
        .bind(viewer.eventId, templateInput.name)
        .first<{ count: number }>(),
    ).resolves.toMatchObject({ count: 2 });

    const mutationInput = { formatLabel: "Serialized mutation" };
    const mutationIdentity = await airtableIntentCommand(
      "event_setup.concurrent_test",
      viewer,
      "event-mutation-intent-0001",
      mutationInput,
    );
    let commandCalls = 0;
    let releaseCommand!: () => void;
    let commandStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      commandStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseCommand = resolve;
    });
    const firstMutation = boundary.executeIdempotent(
      viewer,
      mutationIdentity,
      async () => {
        commandCalls += 1;
        commandStarted();
        await release;
        await changeEventFormat(mutationInput.formatLabel);
        return { revision: 1 };
      },
    );
    await started;
    await expect(
      boundary.executeIdempotent(viewer, mutationIdentity, async () => {
        commandCalls += 1;
        return { revision: 2 };
      }),
    ).rejects.toThrow(/active or recoverable projection|is running/i);
    releaseCommand();
    await expect(firstMutation).resolves.toEqual({ revision: 1 });
    await expect(
      boundary.executeIdempotent(viewer, mutationIdentity, async () => {
        commandCalls += 1;
        return { revision: 3 };
      }),
    ).resolves.toEqual({ revision: 1 });
    expect(commandCalls).toBe(1);
  });

  it("recovers a stored command result after provider failure and rejects replay of sensitive responses", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    const provider = fakeAirtable();
    const rooms = new AirtableRoomRepository(testEnv, {
      createClient: () => provider.client,
    });
    await rooms.configure(viewer, connectionInput);
    const repository = eventDataRepository(testEnv, rooms, provider);
    await initializeEventDataProjection(
      repository,
      "stored-result-recovery",
      rooms,
    );
    await testEnv.DB.prepare(
      "UPDATE events SET repository_provider = 'airtable' WHERE id = ?",
    )
      .bind(viewer.eventId)
      .run();
    const boundary = new AirtableProviderBoundary(testEnv, { repository });
    const command = {
      idempotencyKey: "airtable-result-recovery:task-comment",
      operation: "task.comment.add",
    };
    let calls = 0;
    provider.failNextUpsert();
    await expect(
      boundary.executeIdempotent(viewer, command, async () => {
        calls += 1;
        await changeEventFormat("Stored result during provider outage");
        return { commentId: "comment-after-outage", revision: 2 };
      }),
    ).rejects.toBeInstanceOf(AirtableEventProjectionCommitError);
    const run = await testEnv.DB.prepare(
      `SELECT id FROM integration_runs
        WHERE idempotency_key = ?`,
    )
      .bind(command.idempotencyKey)
      .first<{ id: string }>();
    expect(run).toBeDefined();
    const recovery = new AirtableProjectionRecoveryService(testEnv, {
      boundary,
    });
    await recovery.recover(viewer, run!.id);
    await expect(
      boundary.executeIdempotent(viewer, command, async () => {
        calls += 1;
        throw new Error("The committed task mutation must not run again.");
      }),
    ).resolves.toEqual({ commentId: "comment-after-outage", revision: 2 });
    expect(calls).toBe(1);

    const sensitiveCommand = {
      idempotencyKey: "airtable-result-recovery:anonymous-cookie",
      operation: "submission.anonymous_draft.start",
    };
    let sensitiveCalls = 0;
    await boundary.executeIdempotent(
      viewer,
      sensitiveCommand,
      async () => {
        sensitiveCalls += 1;
        return { draftId: "draft-sensitive", cookie: "secret-cookie" };
      },
      { replay: "reject" },
    );
    await expect(
      boundary.executeIdempotent(
        viewer,
        sensitiveCommand,
        async () => {
          sensitiveCalls += 1;
          return { draftId: "duplicate", cookie: "duplicate-cookie" };
        },
        { replay: "reject" },
      ),
    ).rejects.toBeInstanceOf(AirtableCommandReplayUnavailableError);
    expect(sensitiveCalls).toBe(1);
  });

  it("blocks Airtable-backed retention after a partial provider failure and explicitly reconciles the redacted projection", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureJudgedDemoWorkflow(testEnv);
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `UPDATE events
            SET starts_at = unixepoch('2020-01-01T00:00:00Z'),
                ends_at = unixepoch('2020-01-02T00:00:00Z'),
                retention_months = 12
          WHERE id = ?`,
      ).bind(owner.eventId),
      testEnv.DB.prepare(
        "UPDATE form_definitions SET status = 'archived' WHERE event_id = ?",
      ).bind(owner.eventId),
      testEnv.DB.prepare(
        `INSERT OR IGNORE INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         )
         SELECT 'file-erasure-complete:' || asset.id, event.organisation_id,
                asset.event_id, ?, 'file.erasure.completed', 'file_asset',
                asset.id, '{}', unixepoch()
           FROM file_assets asset JOIN events event ON event.id = asset.event_id
          WHERE asset.event_id = ?`,
      ).bind(owner.personId, owner.eventId),
      testEnv.DB.prepare(
        `UPDATE calendar_invitations
            SET method = 'CANCEL', status = 'cancelled'
          WHERE event_id = ? AND method <> 'CANCEL'`,
      ).bind(owner.eventId),
    ]);
    const provider = fakeAirtable();
    const rooms = new AirtableRoomRepository(testEnv, {
      createClient: () => provider.client,
    });
    await rooms.configure(owner, connectionInput);
    const repository = eventDataRepository(testEnv, rooms, provider);
    const migration = new AirtableMigrationService(testEnv, {
      rooms,
      eventData: repository,
      programme: new AirtableProgrammeRepository(testEnv, {
        rooms,
        createClient: () => provider.client,
      }),
    });
    const migrationPreview = await migration.preview(owner, "airtable");
    await migration.confirm(owner, migrationPreview.previewId);
    const boundary = new AirtableProviderBoundary(testEnv, { repository });
    const retention = new ParticipantRetentionService(testEnv, {
      airtable: boundary,
    });
    const preview = await retention.preview(owner);
    expect(preview.blockers).toEqual([]);
    expect(preview.pendingParticipants).toBeGreaterThan(0);

    provider.failNextUpsert();
    const retentionFailure = await retention
      .anonymiseExpiredParticipants(owner, {
        confirmation: preview.name,
        acknowledged: true,
        limit: 20,
      })
      .catch((error: unknown) => error);
    expect(retentionFailure).toBeInstanceOf(AirtableEventProjectionCommitError);
    await expect(retention.preview(owner)).rejects.toBeInstanceOf(
      AirtableRepositoryConfigurationError,
    );
    const run = await testEnv.DB.prepare(
      `SELECT id FROM integration_runs
        WHERE json_extract(summary_json, '$.operation') =
              'participant.retention.anonymise'
        ORDER BY created_at DESC LIMIT 1`,
    ).first<{ id: string }>();
    expect(run).toBeDefined();
    const recovery = new AirtableProjectionRecoveryService(testEnv, {
      boundary,
    });
    await recovery.recover(owner, run!.id);

    let state = await retention.preview(owner);
    while (!state.completed) {
      const result = await retention.anonymiseExpiredParticipants(owner, {
        confirmation: state.name,
        acknowledged: true,
        limit: 20,
      });
      state = result.state;
    }
    expect(state.completed).toBe(true);
    const synchronized = await repository.assertSynchronized(
      owner.organisationId,
      owner.eventId,
    );
    expect(synchronized.airtable.hash).toBe(synchronized.d1.hash);
  });
});
