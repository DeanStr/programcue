import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { ensureDemoProgramme } from "~/platform/demo/seed.server";
import { ensureJudgedDemoWorkflow } from "~/platform/demo/demo-reset.server";
import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
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

  describe("additional workflow coverage", () => {
    it("projects round-owned evaluation depth through the managed Airtable schema", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoEvaluationData(testEnv);
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE evaluation_rounds
              SET opens_at = unixepoch() - 60,
                  closes_at = unixepoch() + 3600,
                  blinded_reviewing = 1,
                  revision = revision + 1
            WHERE id = 'demo-evaluation-round' AND event_id = ?`,
        ).bind(viewer.eventId),
        env.DB.prepare(
          `UPDATE evaluation_criteria
              SET input_type = 'dropdown',
                  options_json = '["Accept","Maybe","Reject"]'
            WHERE id = 'demo-evaluation-criterion-relevance'
              AND event_id = ?`,
        ).bind(viewer.eventId),
      ]);

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

      const synchronized = await eventData.assertSynchronized(
        viewer.organisationId,
        viewer.eventId,
      );
      const round = synchronized.d1.entities.find(
        (entity) =>
          entity.entityType === "evaluation_round" &&
          entity.entityId === "demo-evaluation-round",
      );
      const criterion = synchronized.d1.entities.find(
        (entity) =>
          entity.entityType === "evaluation_criterion" &&
          entity.entityId === "demo-evaluation-criterion-relevance",
      );
      const poolMember = synchronized.d1.entities.find(
        (entity) => entity.entityType === "evaluation_round_reviewer",
      );
      const assignment = synchronized.d1.entities.find(
        (entity) => entity.entityType === "evaluator_assignment",
      );

      expect(round?.payload).toMatchObject({
        opens_at: expect.any(Number),
        closes_at: expect.any(Number),
        blinded_reviewing: 1,
        scorecard_id: "demo-evaluation-round",
        scorecard_version: 1,
      });
      expect(criterion?.payload).toMatchObject({
        input_type: "dropdown",
        options_json: '["Accept","Maybe","Reject"]',
      });
      expect(poolMember?.payload).toMatchObject({
        event_id: viewer.eventId,
        round_id: "demo-evaluation-round",
        person_id: "person-demo-evaluator",
      });
      expect(assignment?.payload).toHaveProperty("cancellation_reason", null);
      expect(synchronized.airtable.hash).toBe(synchronized.d1.hash);
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
  });

  describe("additional workflow coverage", () => {
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
      expect(provider.records).toHaveLength(1);
      expect(provider.records[0]?.fields["Program Cue ID"]).toMatch(
        /^connection-validation-[a-f0-9-]+$/u,
      );
      expect(provider.records[0]?.fields["Event ID"]).not.toBe(viewer.eventId);
      expect(provider.tables.map((table) => table.name)).toEqual([
        AIRTABLE_ROOMS_TABLE,
      ]);

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
  });

  describe("additional workflow coverage", () => {
    it("creates, reads and updates event tracks through Airtable authority", async () => {
      const testEnv = env as unknown as CloudflareEnvironment;
      const submissionId = `airtable-track-submission-${crypto.randomUUID()}`;
      await testEnv.DB.prepare(
        `INSERT INTO submissions (
           id, event_id, public_reference, title, status, answers_json
         ) VALUES (?, ?, ?, 'Airtable track test', 'draft', '{}')`,
      )
        .bind(submissionId, viewer.eventId, submissionId)
        .run();
      const routingTeamId = `airtable-track-team-${crypto.randomUUID()}`;
      await testEnv.DB.prepare(
        `INSERT INTO evaluation_teams (id, event_id, name, status)
         VALUES (?, ?, ?, 'active')`,
      )
        .bind(routingTeamId, viewer.eventId, `Track team ${routingTeamId}`)
        .run();
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

      const before = await service.getSetup(viewer);
      const trackId = `airtable-track-${crypto.randomUUID()}`;
      await service.saveSetup(viewer, {
        ...eventInput(before),
        tracks: [
          ...before.tracks,
          {
            id: trackId,
            name: "Airtable authority track",
            slug: "airtable-authority-track",
            colourToken: "#123456",
            position: before.tracks.length,
            exclusive: false,
            isPublic: true,
          },
        ],
      });

      const created = await service.getSetup(viewer);
      expect(created.tracks).toContainEqual(
        expect.objectContaining({
          id: trackId,
          name: "Airtable authority track",
          colourToken: "#123456",
        }),
      );
      let authoritative = await eventData.readAuthoritative(
        viewer.organisationId,
        viewer.eventId,
        { bypassCache: true },
      );
      expect(
        authoritative.entities.find(
          (entity) =>
            entity.entityType === "track" && entity.entityId === trackId,
        )?.payload,
      ).toMatchObject({
        id: trackId,
        name: "Airtable authority track",
        colour_token: "#123456",
      });

      await service.saveSetup(viewer, {
        ...eventInput(created),
        tracks: created.tracks.map((track) =>
          track.id === trackId
            ? {
                ...track,
                name: "Updated Airtable authority track",
                slug: "updated-airtable-authority-track",
                colourToken: "#654321",
                exclusive: true,
              }
            : track,
        ),
      });

      const updated = await service.getSetup(viewer);
      expect(updated.tracks).toContainEqual(
        expect.objectContaining({
          id: trackId,
          name: "Updated Airtable authority track",
          slug: "updated-airtable-authority-track",
          colourToken: "#654321",
          exclusive: true,
        }),
      );
      authoritative = await eventData.readAuthoritative(
        viewer.organisationId,
        viewer.eventId,
        { bypassCache: true },
      );
      expect(
        authoritative.entities.find(
          (entity) =>
            entity.entityType === "track" && entity.entityId === trackId,
        )?.payload,
      ).toMatchObject({
        id: trackId,
        name: "Updated Airtable authority track",
        slug: "updated-airtable-authority-track",
        colour_token: "#654321",
        exclusive: 1,
      });

      const boundary = new AirtableProviderBoundary(testEnv, {
        repository: eventData,
      });
      const routingIdentity = await airtableIntentCommand(
        "test.submission-track-routing",
        viewer,
        crypto.randomUUID(),
        { submissionId, trackId, routingTeamId },
      );
      await boundary.executeIdempotent(viewer, routingIdentity, async () => {
        await testEnv.DB.batch([
          testEnv.DB.prepare(
            `INSERT INTO submission_track_selections (
               submission_id, event_id, track_id, track_name_snapshot, position
             ) VALUES (?, ?, ?, ?, 0)`,
          ).bind(
            submissionId,
            viewer.eventId,
            trackId,
            "Updated Airtable authority track",
          ),
          testEnv.DB.prepare(
            `INSERT INTO submission_routing_teams (
               submission_id, event_id, team_id
             ) VALUES (?, ?, ?)`,
          ).bind(submissionId, viewer.eventId, routingTeamId),
        ]);
        return { submissionId };
      });
      authoritative = await eventData.readAuthoritative(
        viewer.organisationId,
        viewer.eventId,
        { bypassCache: true },
      );
      expect(authoritative.entities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            tableKey: "submissionTrackSelections",
            entityId: `${submissionId}:${trackId}`,
          }),
          expect.objectContaining({
            tableKey: "submissionRoutingTeams",
            entityId: `${submissionId}:${routingTeamId}`,
          }),
        ]),
      );

      await expect(
        service.saveSetup(viewer, {
          ...eventInput(updated),
          tracks: updated.tracks.filter((track) => track.id !== trackId),
        }),
      ).rejects.toBeInstanceOf(EventTrackInUseError);
      await expect(
        eventData.assertSynchronized(viewer.organisationId, viewer.eventId),
      ).resolves.toBeDefined();
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
  });

  describe("additional workflow coverage", () => {
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
        `comment-intent:${crypto.randomUUID()}`,
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
            entity.payload.body ===
              "Airtable-backed golden-path reconciliation",
        ),
      ).toBe(true);
    });
  });
});
