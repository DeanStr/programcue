import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { TaskService } from "~/modules/tasks/task-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  DEMO_VENUE_ADDRESS,
  DEMO_VENUE_MAP_URL,
} from "~/platform/demo/demo-identities";
import { ensureDemoData } from "~/platform/demo/seed.server";
import type { AirtableRecord, AirtableTable } from "./airtable-client.server";
import {
  AirtableEventDataRepository,
  AirtableEventDataUnsynchronizedError,
  AirtableEventProjectionCommitError,
} from "./airtable-event-data-repository.server";
import { AIRTABLE_EVENT_TABLE_SPECS } from "./airtable-event-data-schema";
import { AirtableProjectionRecoveryService } from "./airtable-projection-recovery-service.server";
import {
  AirtableProviderBoundary,
  airtableIntentCommand,
} from "./airtable-provider-boundary.server";
import { AirtableRoomRepository } from "./airtable-room-repository.server";
import { AIRTABLE_EVENT_DATA_TABLE_NAMES } from "./airtable-schema";

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

  describe("event-data command workflows", () => {
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
      await expect(
        recovery.recover(viewer, token.runId),
      ).resolves.toMatchObject({
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
      const repository = eventDataRepository(
        testEnv,
        rooms,
        provider,
        () => now,
      );
      await initializeEventDataProjection(
        repository,
        "replay-divergence",
        rooms,
      );
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
      await expect(
        repository.beginCommand(viewer, input),
      ).resolves.toMatchObject({
        runId: token.runId,
        replayed: true,
      });

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
      expect(payload).toMatchObject({
        venue_address: DEMO_VENUE_ADDRESS,
        venue_map_url: DEMO_VENUE_MAP_URL,
        programme_hero_image_url: null,
      });
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
        const first = await boundary.executeIdempotent(
          viewer,
          command,
          execute,
        );
        const replay = await boundary.executeIdempotent(
          viewer,
          command,
          execute,
        );
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
  });
});
