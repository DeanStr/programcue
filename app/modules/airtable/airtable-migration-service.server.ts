import { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";
import { AirtableEventDataRepository } from "./airtable-event-data-repository.server";
import { AirtableProgrammeRepository } from "./airtable-programme-repository.server";
import {
  AIRTABLE_REPOSITORY_PROVIDER,
  AirtableRepositoryConfigurationError,
  AirtableRoomRepository,
} from "./airtable-room-repository.server";
import {
  AIRTABLE_SYNCHRONOUS_MIGRATION_MAX_CHANGES,
  type AirtableRoom,
  airtableRoomSchema,
} from "./airtable-schema";

const migrationTargetSchema = z.enum(["d1", "airtable"]);

const migrationSummarySchema = z.object({
  kind: z.literal("airtable_repository_migration_preview"),
  from: migrationTargetSchema,
  to: migrationTargetSchema,
  eventRevision: z.number().int().positive(),
  connectionRevision: z.number().int().positive(),
  fingerprint: z.string().min(1),
  expiresAt: z.number().int().positive(),
  sourceFetchedAt: z.number().int().nullable(),
  counts: z.object({
    create: z.number().int().nonnegative(),
    update: z.number().int().nonnegative(),
    noop: z.number().int().nonnegative(),
  }),
});

type RepositoryProvider = z.infer<typeof migrationTargetSchema>;

type ControlRow = {
  repositoryProvider: RepositoryProvider;
  revision: number;
};

type D1Room = Pick<
  AirtableRoom,
  "id" | "name" | "capacity" | "position" | "building" | "level" | "resources"
> & { status: "active" | "retired" };

export type AirtableMigrationPlanItem = {
  entityType: string;
  entityId: string;
  label: string;
  action: "create" | "update" | "noop";
  before: Record<string, unknown> | D1Room | AirtableRoom | null;
  after: Record<string, unknown> | D1Room | AirtableRoom | null;
  beforeLabel: string;
  afterLabel: string;
};

export type AirtableMigrationPreview = {
  previewId: string;
  from: RepositoryProvider;
  to: RepositoryProvider;
  eventRevision: number;
  expiresAt: number;
  sourceFetchedAt: number | null;
  counts: { create: number; update: number; noop: number };
  items: AirtableMigrationPlanItem[];
};

export class AirtableMigrationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AirtableMigrationStateError";
  }
}

function assertAdministrator(viewer: Viewer) {
  if (!(["owner", "administrator"] as string[]).includes(viewer.role))
    throw new Response("Administrator access is required", { status: 403 });
}

function sortRooms<
  T extends Pick<AirtableRoom, "id" | "name" | "capacity" | "position">,
>(rooms: T[]) {
  return rooms.sort(
    (left, right) =>
      left.position - right.position ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  );
}

function comparable(room: D1Room | AirtableRoom | null) {
  if (!room) return null;
  return {
    id: room.id,
    name: room.name,
    capacity: room.capacity,
    position: room.position,
    status: room.status,
    building: room.building,
    level: room.level,
    resources: room.resources,
  };
}

function planMigration(
  from: RepositoryProvider,
  d1Rooms: D1Room[],
  airtableRooms: AirtableRoom[],
) {
  const source = from === "d1" ? d1Rooms : airtableRooms;
  const target = from === "d1" ? airtableRooms : d1Rooms;
  const sourceActive = source.filter((room) => room.status === "active");
  const targetById = new Map(target.map((room) => [room.id, room]));
  const sourceIds = new Set(sourceActive.map((room) => room.id));
  const items: AirtableMigrationPlanItem[] = sourceActive.map((room) => {
    const current = targetById.get(room.id) ?? null;
    const desired = { ...room, status: "active" as const };
    return {
      entityType: "room",
      entityId: room.id,
      label: room.name,
      action: !current
        ? ("create" as const)
        : JSON.stringify(comparable(current)) ===
            JSON.stringify(comparable(desired))
          ? ("noop" as const)
          : ("update" as const),
      before: current,
      after: desired,
      beforeLabel: current
        ? `${current.capacity} seats · ${current.status}`
        : "—",
      afterLabel: `${desired.capacity} seats · ${desired.status}`,
    };
  });
  for (const room of target) {
    if (room.status !== "active" || sourceIds.has(room.id)) continue;
    items.push({
      entityType: "room",
      entityId: room.id,
      label: room.name,
      action: "update",
      before: room,
      after: { ...room, status: "retired" },
      beforeLabel: `${room.capacity} seats · ${room.status}`,
      afterLabel: `${room.capacity} seats · retired`,
    });
  }
  return items.sort(
    (left, right) =>
      left.label.localeCompare(right.label) ||
      left.entityId.localeCompare(right.entityId),
  );
}

function counts(items: AirtableMigrationPlanItem[]) {
  return {
    create: items.filter((item) => item.action === "create").length,
    update: items.filter((item) => item.action === "update").length,
    noop: items.filter((item) => item.action === "noop").length,
  };
}

async function fingerprint(items: AirtableMigrationPlanItem[]) {
  const stableValue = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, entry]) => [key, stableValue(entry)]),
      );
    return value;
  };
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(stableValue(items))),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

type AirtableMigrationDependencies = {
  rooms?: AirtableRoomRepository;
  programme?: AirtableProgrammeRepository;
  eventData?: AirtableEventDataRepository;
  now?: () => number;
};

export class AirtableMigrationService {
  private readonly rooms;
  private readonly programme;
  private readonly eventData;
  private readonly now;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: AirtableMigrationDependencies = {},
  ) {
    this.rooms = dependencies.rooms ?? new AirtableRoomRepository(env);
    this.programme =
      dependencies.programme ??
      new AirtableProgrammeRepository(env, { rooms: this.rooms });
    this.eventData =
      dependencies.eventData ??
      new AirtableEventDataRepository(env, { rooms: this.rooms });
    this.now = dependencies.now ?? Date.now;
  }

  private async control(viewer: Viewer) {
    const row = await this.env.DB.prepare(
      `SELECT repository_provider AS repositoryProvider, revision
         FROM events
        WHERE id = ? AND organisation_id = ?`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<ControlRow>();
    if (!row) throw new AirtableMigrationStateError("Event not found.");
    return {
      repositoryProvider: migrationTargetSchema.parse(row.repositoryProvider),
      revision: row.revision,
    };
  }

  private async d1Rooms(viewer: Viewer) {
    const result = await this.env.DB.prepare(
      `SELECT id, name, capacity, position, status, building, level,
              resources_json AS resourcesJson
         FROM rooms
        WHERE event_id = ?
        ORDER BY position, name, id`,
    )
      .bind(viewer.eventId)
      .all<{
        id: string;
        name: string;
        capacity: number;
        position: number;
        status: string;
        building: string | null;
        level: string | null;
        resourcesJson: string;
      }>();
    return result.results.map((room) => ({
      id: room.id,
      name: room.name,
      capacity: room.capacity,
      position: room.position,
      status: z.enum(["active", "retired"]).parse(room.status),
      building: room.building,
      level: room.level,
      resources: z.array(z.string()).parse(JSON.parse(room.resourcesJson)),
    }));
  }

  private async currentPlan(
    viewer: Viewer,
    from: RepositoryProvider,
    revision: number,
  ) {
    const [d1Rooms, airtable, eventData] = await Promise.all([
      this.d1Rooms(viewer),
      this.rooms.readRooms(viewer.organisationId, viewer.eventId, {
        bypassCache: true,
      }),
      this.eventData.previewFromD1(viewer.organisationId, viewer.eventId),
    ]);
    const normalizedAirtable = airtable.rooms.map((room) =>
      airtableRoomSchema.parse({
        ...room,
        revision: room.revision || revision,
      }),
    );
    const roomItems = planMigration(from, d1Rooms, normalizedAirtable);
    const publishedVersion = await this.env.DB.prepare(
      `SELECT id FROM schedule_versions
        WHERE event_id = ? AND status = 'published'
        ORDER BY published_at DESC LIMIT 1`,
    )
      .bind(viewer.eventId)
      .first<{ id: string }>();
    const programmeItems = publishedVersion
      ? (
          await this.programme.previewPublication(
            viewer.eventId,
            publishedVersion.id,
          )
        ).map((item) => {
          const changedFields = Object.keys(item.fields).filter(
            (field) =>
              JSON.stringify(item.before?.[field]) !==
              JSON.stringify(item.fields[field]),
          );
          return {
            entityType: item.entityType,
            entityId: item.entityId,
            label: item.label,
            action: item.action,
            before: item.before,
            after: item.fields,
            beforeLabel: item.before ? "Existing Airtable snapshot" : "—",
            afterLabel:
              item.action === "noop"
                ? "No material change"
                : changedFields.length
                  ? `Change ${changedFields.join(", ")}`
                  : "Retire stale snapshot",
          } satisfies AirtableMigrationPlanItem;
        })
      : [];
    const eventDataItems = eventData.items.map((item) => {
      const before = from === "d1" ? item.before : item.after;
      const after = from === "d1" ? item.after : item.before;
      return {
        entityType: item.entityType,
        entityId: item.entityId,
        label: `${item.entityType.replaceAll("_", " ")} · ${item.entityId}`,
        action: item.action,
        before,
        after,
        beforeLabel: before ? "Existing record" : "—",
        afterLabel:
          item.action === "noop"
            ? "No material change"
            : after
              ? `Reconcile ${item.entityType.replaceAll("_", " ")}`
              : "Remove stale projection",
      } satisfies AirtableMigrationPlanItem;
    });
    return {
      items: [...roomItems, ...eventDataItems, ...programmeItems],
      airtable,
      d1Rooms,
      eventData,
      programmeItems,
    };
  }

  async preview(viewer: Viewer, rawTarget: unknown) {
    assertAdministrator(viewer);
    const target = migrationTargetSchema.parse(rawTarget);
    const control = await this.control(viewer);
    if (target === control.repositoryProvider) {
      throw new AirtableMigrationStateError(
        `${target === "airtable" ? "Airtable" : "D1"} is already authoritative for this event repository slice.`,
      );
    }
    const connection = await this.rooms.getConnection(
      viewer.organisationId,
      viewer.eventId,
      { requireConnected: true },
    );
    if (!connection)
      throw new AirtableRepositoryConfigurationError(
        "Airtable repository connection not found.",
      );
    const plan = await this.currentPlan(
      viewer,
      control.repositoryProvider,
      control.revision,
    );
    const changedItems = plan.items.filter((item) => item.action !== "noop");
    if (changedItems.length > AIRTABLE_SYNCHRONOUS_MIGRATION_MAX_CHANGES)
      throw new AirtableMigrationStateError(
        `This migration would change ${changedItems.length} managed records; the synchronous Airtable migration limit is ${AIRTABLE_SYNCHRONOUS_MIGRATION_MAX_CHANGES}. Keep this event on D1 rather than starting a migration that cannot finish safely in one request.`,
      );
    const planFingerprint = await fingerprint(plan.items);
    const previewId = crypto.randomUUID();
    const now = Math.floor(this.now() / 1_000);
    const summary = {
      kind: "airtable_repository_migration_preview" as const,
      from: control.repositoryProvider,
      to: target,
      eventRevision: control.revision,
      connectionRevision: connection.revision,
      fingerprint: planFingerprint,
      expiresAt: now + 15 * 60,
      sourceFetchedAt:
        control.repositoryProvider === "airtable"
          ? plan.airtable.fetchedAt
          : null,
      counts: counts(plan.items),
    };
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `INSERT INTO integration_runs (
           id, connection_id, idempotency_key, status, direction, dry_run,
           summary_json, started_at, completed_at, created_at
         ) VALUES (?, ?, ?, 'succeeded', ?, 1, ?, unixepoch(), unixepoch(), unixepoch())`,
      ).bind(
        previewId,
        connection.id,
        `airtable-repository-preview:${previewId}`,
        control.repositoryProvider === "d1" ? "outbound" : "inbound",
        JSON.stringify(summary),
      ),
      ...changedItems.map((item) =>
        this.env.DB.prepare(
          `INSERT INTO integration_run_items (
             id, run_id, entity_type, entity_id, action, status, diff_json,
             attempt_count, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, unixepoch())`,
        ).bind(
          crypto.randomUUID(),
          previewId,
          item.entityType,
          item.entityId,
          item.action,
          item.action === "noop" ? "skipped" : "succeeded",
          JSON.stringify({ before: item.before, after: item.after }),
        ),
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         ) VALUES (?, 'person', 'admin_ui', 1, ?, ?, ?, 'airtable.repository.migration.previewed',
                   'integration_run', ?, ?, ?, unixepoch())`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        previewId,
        previewId,
        JSON.stringify(summary),
      ),
    ];
    const results = await this.env.DB.batch(statements);
    if (results.some((result) => (result.meta.changes ?? 0) !== 1))
      throw new AirtableMigrationStateError(
        "The Airtable migration preview could not be recorded completely.",
      );
    return {
      previewId,
      from: summary.from,
      to: summary.to,
      eventRevision: summary.eventRevision,
      expiresAt: summary.expiresAt,
      sourceFetchedAt: summary.sourceFetchedAt,
      counts: summary.counts,
      items: changedItems,
    } satisfies AirtableMigrationPreview;
  }

  private async loadPreview(viewer: Viewer, previewId: string) {
    const row = await this.env.DB.prepare(
      `SELECT run.summary_json AS summaryJson
         FROM integration_runs run
         JOIN integration_connections connection ON connection.id = run.connection_id
        WHERE run.id = ? AND run.dry_run = 1 AND run.status = 'succeeded'
          AND connection.organisation_id = ? AND connection.event_id = ?
          AND connection.provider = ?`,
    )
      .bind(
        previewId,
        viewer.organisationId,
        viewer.eventId,
        AIRTABLE_REPOSITORY_PROVIDER,
      )
      .first<{ summaryJson: string }>();
    if (!row)
      throw new AirtableMigrationStateError(
        "The confirmed Airtable migration preview was not found.",
      );
    try {
      return migrationSummarySchema.parse(JSON.parse(row.summaryJson));
    } catch {
      throw new AirtableMigrationStateError(
        "The Airtable migration preview is invalid and cannot be confirmed.",
      );
    }
  }

  private async validateD1ProjectionChange(
    viewer: Viewer,
    activeRooms: AirtableRoom[],
  ) {
    const roomIds = activeRooms.map((room) => room.id);
    const roomIdsJson = JSON.stringify(roomIds);
    const foreignRoom = roomIds.length
      ? await this.env.DB.prepare(
          `SELECT id FROM rooms
            WHERE id IN (SELECT value FROM json_each(?))
              AND event_id <> ? LIMIT 1`,
        )
          .bind(roomIdsJson, viewer.eventId)
          .first<{ id: string }>()
      : null;
    if (foreignRoom)
      throw new AirtableMigrationStateError(
        `Airtable room ID “${foreignRoom.id}” belongs to another event in D1.`,
      );

    const removedInUse = await this.env.DB.prepare(
      `SELECT room.id, room.name
         FROM rooms room
         JOIN schedule_entries entry
           ON entry.event_id = room.event_id AND entry.room_id = room.id
         JOIN schedule_versions version
           ON version.event_id = entry.event_id
          AND version.id = entry.schedule_version_id
        WHERE room.event_id = ? AND room.status = 'active'
          AND room.id NOT IN (SELECT value FROM json_each(?))
          AND version.status IN ('draft','publishing','published')
        LIMIT 1`,
    )
      .bind(viewer.eventId, roomIdsJson)
      .first<{ id: string; name: string }>();
    if (removedInUse)
      throw new AirtableMigrationStateError(
        `Room “${removedInUse.name}” is used by an active schedule and cannot be retired during migration.`,
      );
  }

  private async completeD1Migration(
    viewer: Viewer,
    summary: z.infer<typeof migrationSummarySchema>,
    runId: string,
    activeRooms: AirtableRoom[],
    expectedCompletedItems: number,
  ) {
    await this.validateD1ProjectionChange(viewer, activeRooms);
    const operationId = runId;
    const auditId = crypto.randomUUID();
    const roomIdsJson = JSON.stringify(activeRooms.map((room) => room.id));
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `UPDATE events
            SET repository_provider = 'd1',
                repository_locked_at = COALESCE(repository_locked_at, unixepoch()),
                revision = revision + 1, last_operation_id = ?,
                last_updated_by_person_id = ?, updated_at = unixepoch()
          WHERE id = ? AND organisation_id = ? AND revision = ?
            AND repository_provider = 'airtable'
            AND EXISTS (
              SELECT 1 FROM integration_connections connection
               WHERE connection.organisation_id = ?
                 AND connection.event_id = ?
                 AND connection.provider = ?
                 AND connection.status = 'connected'
                 AND connection.revision = ?
            )`,
      ).bind(
        operationId,
        viewer.personId,
        viewer.eventId,
        viewer.organisationId,
        summary.eventRevision,
        viewer.organisationId,
        viewer.eventId,
        AIRTABLE_REPOSITORY_PROVIDER,
        summary.connectionRevision,
      ),
      ...activeRooms.map((room) =>
        this.env.DB.prepare(
          `INSERT INTO rooms (
             id, event_id, name, building, level, capacity, resources_json,
             position, status
           )
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'active'
            WHERE EXISTS (
              SELECT 1 FROM events
               WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
            )
           ON CONFLICT(id) DO UPDATE SET
             name = excluded.name, building = excluded.building,
             level = excluded.level, capacity = excluded.capacity,
             resources_json = excluded.resources_json,
             position = excluded.position, status = 'active'
           WHERE rooms.event_id = excluded.event_id`,
        ).bind(
          room.id,
          viewer.eventId,
          room.name,
          room.building,
          room.level,
          room.capacity,
          JSON.stringify(room.resources),
          room.position,
          viewer.eventId,
          viewer.organisationId,
          operationId,
        ),
      ),
      this.env.DB.prepare(
        `UPDATE rooms SET status = 'retired'
          WHERE event_id = ? AND status = 'active'
            AND id NOT IN (SELECT value FROM json_each(?))
            AND EXISTS (
              SELECT 1 FROM events
               WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
            )`,
      ).bind(
        viewer.eventId,
        roomIdsJson,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `UPDATE integration_run_items
            SET status = 'succeeded', attempt_count = 1,
                updated_at = unixepoch()
          WHERE run_id = ? AND status IN ('running','pending')`,
      ).bind(runId),
      this.env.DB.prepare(
        `UPDATE integration_runs
            SET status = 'succeeded', completed_at = unixepoch()
          WHERE id = ? AND status = 'running'
            AND EXISTS (
              SELECT 1 FROM events
               WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
            )`,
      ).bind(runId, viewer.eventId, viewer.organisationId, operationId),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         ) SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'airtable.repository.migrated',
                  'event', ?, ?, ?, unixepoch()
            WHERE EXISTS (
              SELECT 1 FROM events
               WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
            )`,
      ).bind(
        auditId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        viewer.eventId,
        runId,
        JSON.stringify({
          from: summary.from,
          to: summary.to,
          previewFingerprint: summary.fingerprint,
          roomCount: activeRooms.length,
        }),
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO event_changes (
           event_id, entity_type, entity_id, change_type,
           correlation_id, created_at
         )
         SELECT ?, 'event', ?, 'updated', ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM audit_events audit
             WHERE audit.id = ? AND audit.organisation_id = ?
               AND audit.event_id = ?
               AND audit.action = 'airtable.repository.migrated'
               AND audit.entity_id = ?
          )
         RETURNING sequence`,
      ).bind(
        viewer.eventId,
        viewer.eventId,
        runId,
        auditId,
        viewer.organisationId,
        viewer.eventId,
        viewer.eventId,
      ),
    ];
    const results = await this.env.DB.batch(statements);
    if ((results[0]?.meta.changes ?? 0) !== 1)
      throw new AirtableMigrationStateError(
        "The event changed after the migration preview. Create a new preview before confirming.",
      );
    if ((results.at(-4)?.meta.changes ?? 0) !== expectedCompletedItems)
      throw new AirtableMigrationStateError(
        "The D1 migration completed without recording every migration item result.",
      );
    if ((results.at(-3)?.meta.changes ?? 0) !== 1)
      throw new AirtableMigrationStateError(
        "The D1 migration completed without recording its run result.",
      );
    if ((results.at(-2)?.meta.changes ?? 0) !== 1)
      throw new AirtableMigrationStateError(
        "The D1 migration completed without recording its audit result.",
      );
    const change = results.at(-1)?.results[0] as
      | { sequence: number }
      | undefined;
    if (!change || !Number.isSafeInteger(change.sequence))
      throw new AirtableMigrationStateError(
        "The D1 authority switch did not commit its public change cursor.",
      );
    return change.sequence;
  }

  private async completeAirtableMigration(
    viewer: Viewer,
    summary: z.infer<typeof migrationSummarySchema>,
    runId: string,
    d1Rooms: D1Room[],
    expectedCompletedItems: number,
  ) {
    const activeRooms = sortRooms(
      d1Rooms.filter((room) => room.status === "active"),
    );
    try {
      await this.eventData.synchronizeFromD1(
        {
          organisationId: viewer.organisationId,
          eventId: viewer.eventId,
          personId: viewer.personId,
        },
        {
          idempotencyKey: `airtable-event-data-initial-sync:${runId}`,
          reason: "confirmed repository authority migration",
        },
      );
      await this.rooms.replaceRooms(
        viewer.organisationId,
        viewer.eventId,
        activeRooms,
        summary.eventRevision + 1,
      );
      const publishedVersion = await this.env.DB.prepare(
        `SELECT id FROM schedule_versions
          WHERE event_id = ? AND status = 'published'
          ORDER BY published_at DESC LIMIT 1`,
      )
        .bind(viewer.eventId)
        .first<{ id: string }>();
      if (publishedVersion) {
        await this.programme.stagePublication(
          {
            organisationId: viewer.organisationId,
            eventId: viewer.eventId,
            personId: viewer.personId,
          },
          publishedVersion.id,
        );
      }
    } catch (error) {
      await this.env.DB.prepare(
        `UPDATE integration_runs
            SET status = 'failed', completed_at = unixepoch(),
                summary_json = json_set(summary_json, '$.error', ?)
          WHERE id = ? AND status = 'running'`,
      )
        .bind(error instanceof Error ? error.message : String(error), runId)
        .run();
      throw error;
    }

    const auditId = crypto.randomUUID();
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE events
            SET repository_provider = 'airtable',
                repository_locked_at = COALESCE(repository_locked_at, unixepoch()),
                revision = revision + 1, last_operation_id = ?,
                last_updated_by_person_id = ?, updated_at = unixepoch()
          WHERE id = ? AND organisation_id = ? AND revision = ?
            AND repository_provider = 'd1'
            AND EXISTS (
              SELECT 1 FROM integration_connections connection
               WHERE connection.organisation_id = ?
                 AND connection.event_id = ?
                 AND connection.provider = ?
                 AND connection.status = 'connected'
                 AND connection.revision = ?
            )`,
      ).bind(
        runId,
        viewer.personId,
        viewer.eventId,
        viewer.organisationId,
        summary.eventRevision,
        viewer.organisationId,
        viewer.eventId,
        AIRTABLE_REPOSITORY_PROVIDER,
        summary.connectionRevision,
      ),
      this.env.DB.prepare(
        `UPDATE integration_run_items
            SET status = 'succeeded', attempt_count = 1,
                updated_at = unixepoch()
          WHERE run_id = ? AND status IN ('running','pending')`,
      ).bind(runId),
      this.env.DB.prepare(
        `UPDATE integration_runs
            SET status = 'succeeded', completed_at = unixepoch()
          WHERE id = ? AND status = 'running'
            AND EXISTS (
              SELECT 1 FROM events
               WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
            )`,
      ).bind(runId, viewer.eventId, viewer.organisationId, runId),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         ) SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'airtable.repository.migrated',
                  'event', ?, ?, ?, unixepoch()
            WHERE EXISTS (
              SELECT 1 FROM events
               WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
            )`,
      ).bind(
        auditId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        viewer.eventId,
        runId,
        JSON.stringify({
          from: summary.from,
          to: summary.to,
          previewFingerprint: summary.fingerprint,
          roomCount: activeRooms.length,
        }),
        viewer.eventId,
        viewer.organisationId,
        runId,
      ),
      this.env.DB.prepare(
        `INSERT INTO event_changes (
           event_id, entity_type, entity_id, change_type,
           correlation_id, created_at
         )
         SELECT ?, 'event', ?, 'updated', ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM audit_events audit
             WHERE audit.id = ? AND audit.organisation_id = ?
               AND audit.event_id = ?
               AND audit.action = 'airtable.repository.migrated'
               AND audit.entity_id = ?
          )
         RETURNING sequence`,
      ).bind(
        viewer.eventId,
        viewer.eventId,
        runId,
        auditId,
        viewer.organisationId,
        viewer.eventId,
        viewer.eventId,
      ),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1) {
      const reason =
        "Airtable was updated, but the D1 authority switch lost its optimistic revision claim.";
      await Promise.all([
        this.env.DB.prepare(
          `UPDATE integration_runs
              SET status = 'failed', completed_at = unixepoch(),
                  summary_json = json_set(summary_json, '$.error', ?)
            WHERE id = ? AND status = 'running'`,
        )
          .bind(reason, runId)
          .run(),
        this.rooms.markNeedsAttention(
          viewer.organisationId,
          viewer.eventId,
          reason,
        ),
      ]);
      throw new AirtableMigrationStateError(
        `${reason} Revalidate the connection and create a new migration preview.`,
      );
    }
    if (
      (results[1]?.meta.changes ?? 0) !== expectedCompletedItems ||
      (results[2]?.meta.changes ?? 0) !== 1 ||
      (results[3]?.meta.changes ?? 0) !== 1
    )
      throw new AirtableMigrationStateError(
        "The authority switch completed without recording its run and audit results completely.",
      );
    const change = results[4]?.results[0] as { sequence: number } | undefined;
    if (!change || !Number.isSafeInteger(change.sequence))
      throw new AirtableMigrationStateError(
        "The Airtable authority switch did not commit its public change cursor.",
      );
    return change.sequence;
  }

  async confirm(viewer: Viewer, rawPreviewId: unknown) {
    assertAdministrator(viewer);
    const previewId = z.string().uuid().parse(rawPreviewId);
    const summary = await this.loadPreview(viewer, previewId);
    const [control, connection] = await Promise.all([
      this.control(viewer),
      this.rooms.getConnection(viewer.organisationId, viewer.eventId, {
        requireConnected: true,
      }),
    ]);
    if (!connection)
      throw new AirtableRepositoryConfigurationError(
        "Airtable repository connection not found.",
      );
    const idempotencyKey = `airtable-repository-migration:${previewId}`;
    const existing = await this.env.DB.prepare(
      `SELECT id, status FROM integration_runs
        WHERE connection_id = ? AND idempotency_key = ?`,
    )
      .bind(connection.id, idempotencyKey)
      .first<{ id: string; status: string }>();
    if (existing?.status === "succeeded")
      return {
        runId: existing.id,
        provider: summary.to,
        idempotent: true,
        changeSequence: null,
      };
    if (existing)
      throw new AirtableMigrationStateError(
        `The confirmed migration is already ${existing.status.replaceAll("_", " ")}. Create a new preview after inspecting that run.`,
      );
    const now = Math.floor(this.now() / 1_000);
    if (summary.expiresAt <= now)
      throw new AirtableMigrationStateError(
        "The Airtable migration preview expired. Create a new preview.",
      );
    if (
      control.repositoryProvider !== summary.from ||
      control.revision !== summary.eventRevision ||
      connection.revision !== summary.connectionRevision
    ) {
      throw new AirtableMigrationStateError(
        "The event or Airtable connection changed after preview. Create a new preview before confirming.",
      );
    }
    const plan = await this.currentPlan(viewer, summary.from, control.revision);
    const changedItems = plan.items.filter((item) => item.action !== "noop");
    if (changedItems.length > AIRTABLE_SYNCHRONOUS_MIGRATION_MAX_CHANGES)
      throw new AirtableMigrationStateError(
        `The migration now contains ${changedItems.length} managed changes, above the ${AIRTABLE_SYNCHRONOUS_MIGRATION_MAX_CHANGES}-record synchronous limit. Create a smaller event or keep it on D1.`,
      );
    if ((await fingerprint(plan.items)) !== summary.fingerprint)
      throw new AirtableMigrationStateError(
        "The D1 or Airtable event data changed after preview. Review a new migration diff before confirming.",
      );
    if (
      summary.to === "d1" &&
      (plan.eventData.items.some((item) => item.action !== "noop") ||
        plan.programmeItems.some((item) => item.action !== "noop"))
    )
      throw new AirtableMigrationStateError(
        "Airtable event data or its published programme differs from the Program Cue copy. Reconcile that divergence before migrating authority to D1; the authority switch will not silently discard Airtable edits.",
      );

    const runId = crypto.randomUUID();
    const liveSummary = {
      kind: "airtable_repository_migration",
      previewId,
      from: summary.from,
      to: summary.to,
      fingerprint: summary.fingerprint,
      counts: summary.counts,
    };
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `INSERT INTO integration_runs (
           id, connection_id, idempotency_key, status, direction, dry_run,
           summary_json, started_at, created_at
         ) VALUES (?, ?, ?, 'running', ?, 0, ?, unixepoch(), unixepoch())`,
      ).bind(
        runId,
        connection.id,
        idempotencyKey,
        summary.from === "d1" ? "outbound" : "inbound",
        JSON.stringify(liveSummary),
      ),
      ...changedItems.map((item) =>
        this.env.DB.prepare(
          `INSERT INTO integration_run_items (
             id, run_id, entity_type, entity_id, action, status, diff_json,
             attempt_count, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, unixepoch())`,
        ).bind(
          crypto.randomUUID(),
          runId,
          item.entityType,
          item.entityId,
          item.action,
          item.action === "noop" ? "skipped" : "running",
          JSON.stringify({ before: item.before, after: item.after }),
        ),
      ),
    ];
    const results = await this.env.DB.batch(statements);
    if (results.some((result) => (result.meta.changes ?? 0) !== 1))
      throw new AirtableMigrationStateError(
        "The confirmed Airtable migration could not be recorded completely.",
      );

    const expectedCompletedItems = changedItems.length;
    let changeSequence: number;
    if (summary.to === "airtable") {
      changeSequence = await this.completeAirtableMigration(
        viewer,
        summary,
        runId,
        plan.d1Rooms,
        expectedCompletedItems,
      );
    } else {
      const activeRooms = plan.airtable.rooms.filter(
        (room) => room.status === "active",
      );
      try {
        changeSequence = await this.completeD1Migration(
          viewer,
          summary,
          runId,
          activeRooms,
          expectedCompletedItems,
        );
      } catch (error) {
        await this.env.DB.prepare(
          `UPDATE integration_runs
              SET status = 'failed', completed_at = unixepoch(),
                  summary_json = json_set(summary_json, '$.error', ?)
            WHERE id = ? AND status = 'running'`,
        )
          .bind(error instanceof Error ? error.message : String(error), runId)
          .run();
        throw error;
      }
    }
    return {
      runId,
      provider: summary.to,
      idempotent: false,
      changeSequence,
    };
  }
}
