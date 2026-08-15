import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { INITIAL_EVENT_SESSION_FORMATS_JSON } from "~/modules/events/event-configuration";
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
      `UPDATE events
          SET repository_provider = 'd1', repository_locked_at = NULL,
              session_formats_json = ?
        WHERE id = ?`,
    )
      .bind(INITIAL_EVENT_SESSION_FORMATS_JSON, viewer.eventId)
      .run();
  });

  describe("authority migration workflows", () => {
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
      expect(preview.items.every((item) => item.action === "create")).toBe(
        true,
      );

      const confirmed = await migration.confirm(viewer, preview.previewId);
      expect(confirmed).toMatchObject({
        provider: "airtable",
        idempotent: false,
      });
      await expect(
        migration.confirm(viewer, preview.previewId),
      ).resolves.toEqual({
        runId: confirmed.runId,
        provider: "airtable",
        idempotent: true,
        changeSequence: null,
      });
      await expect(
        env.DB.prepare(
          `SELECT public_projection_revision AS publicProjectionRevision
             FROM events WHERE id = ?`,
        )
          .bind(viewer.eventId)
          .first(),
      ).resolves.toEqual({
        publicProjectionRevision: confirmed.changeSequence,
      });
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

      const service = new EventService(
        env as unknown as CloudflareEnvironment,
        {
          airtableRooms: repository,
          airtableEventData: eventData,
        },
      );
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
  });

  describe("authority migration workflows", () => {
    it("requires the migration workflow instead of changing provider through save", async () => {
      const provider = fakeAirtable();
      const repository = new AirtableRoomRepository(
        env as unknown as CloudflareEnvironment,
        { createClient: () => provider.client },
      );
      await repository.configure(viewer, connectionInput);
      const service = new EventService(
        env as unknown as CloudflareEnvironment,
        {
          airtableRooms: repository,
        },
      );
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
  });

  describe("authority migration workflows", () => {
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
      expect(retentionFailure).toBeInstanceOf(
        AirtableEventProjectionCommitError,
      );
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
});
