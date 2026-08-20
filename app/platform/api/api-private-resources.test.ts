import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { ContentManagementService } from "~/modules/content/content-management-service.server";
import {
  type ScheduleIdempotencyConflictError,
  ScheduleRevisionConflictError,
  ScheduleService,
} from "~/modules/schedule/schedule-service.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { type ApiError, type ApiPrincipal, apiRequestHash } from "./api.server";
import {
  ApiTaskService,
  apiTaskCreateSchema,
  apiTaskListQuerySchema,
} from "./api-task-service.server";

const eventId = "evt-foe-2025";
const organisationId = "org-future-events";
const principal = {
  keyId: "api-test-private-resources",
  organisationId,
  eventId,
  scopes: new Set(["tasks:read", "tasks:write", "schedule:publish"]),
} satisfies ApiPrincipal & { eventId: string };

beforeEach(async () => {
  await ensureDemoData(env as unknown as CloudflareEnvironment);
});

describe("typed task API service", () => {
  it("checks repository authority for reads and projects task creation", async () => {
    const reads: string[] = [];
    const commands: Array<{ operation: string; eventId: string }> = [];
    const airtable = {
      assertReadable: async (scope: { eventId: string }) => {
        reads.push(scope.eventId);
        return null;
      },
      executeIdempotent: async <T>(
        scope: { eventId: string },
        command: { operation: string },
        execute: () => Promise<T>,
      ) => {
        commands.push({ operation: command.operation, eventId: scope.eventId });
        return execute();
      },
    } as unknown as AirtableProviderBoundary;
    const service = new ApiTaskService(
      env as unknown as CloudflareEnvironment,
      { airtable },
    );

    await service.list(principal, { limit: 1 });
    await service.get(principal, "task-speaker-profile");
    expect(reads).toEqual([eventId, eventId]);

    await service.create(
      principal,
      {
        title: "Authority-aware API task",
        description: null,
        targetType: "event",
        targetId: eventId,
        ownerPersonId: null,
        taskType: "checklist",
        impact: "medium",
        dueAt: null,
        dependencyIds: [],
      },
      "corr-task-authority",
      `task-authority-${crypto.randomUUID()}`,
    );
    expect(commands).toEqual([{ operation: "task.api.create", eventId }]);
  });

  it("persists the rich task model, dependencies, API audit actor and change cursor", async () => {
    const service = new ApiTaskService(env as unknown as CloudflareEnvironment);
    const dueAt = new Date(
      (Math.floor(Date.now() / 1_000) + 86_400) * 1_000,
    ).toISOString();
    const prerequisite = await service.create(
      principal,
      {
        title: "Confirm participation",
        description: "Acknowledge participation requirements.",
        targetType: "event",
        targetId: eventId,
        ownerPersonId: null,
        taskType: "acknowledgement",
        impact: "critical",
        dueAt: null,
        dependencyIds: [],
      },
      "corr-task-prerequisite",
      "task-prerequisite-key",
    );
    const created = await service.create(
      principal,
      {
        title: "Provide final session notes",
        description: "Add the final notes used by the stage manager.",
        targetType: "event",
        targetId: eventId,
        ownerPersonId: null,
        taskType: "short_form",
        impact: "high",
        dueAt,
        dependencyIds: [prerequisite.task.id],
      },
      "corr-task-created",
      "task-created-key",
    );

    expect(created.task).toMatchObject({
      title: "Provide final session notes",
      targetType: "event",
      targetId: eventId,
      taskType: "short_form",
      impact: "high",
      status: "blocked",
      readinessState: "blocked",
      dueAt,
      dependencyIds: [prerequisite.task.id],
    });
    expect(created.changeSequence).toBeGreaterThan(prerequisite.changeSequence);

    const [audit, change] = await Promise.all([
      env.DB.prepare(
        `
        SELECT actor_person_id AS actorPersonId, actor_id AS actorId, correlation_id AS correlationId
          FROM audit_events WHERE entity_id = ? AND action = 'task.created'
      `,
      )
        .bind(created.task.id)
        .first<{
          actorPersonId: string | null;
          actorId: string | null;
          correlationId: string | null;
        }>(),
      env.DB.prepare(
        `
        SELECT entity_type AS entityType, change_type AS changeType
          FROM event_changes WHERE sequence = ? AND event_id = ?
      `,
      )
        .bind(created.changeSequence, eventId)
        .first<{ entityType: string; changeType: string }>(),
    ]);
    expect(audit).toEqual({
      actorPersonId: null,
      actorId: `api_key:${principal.keyId}`,
      correlationId: "corr-task-created",
    });
    expect(change).toEqual({
      entityType: "task_instance",
      changeType: "created",
    });
    await expect(
      env.DB.prepare(
        `SELECT evidence_mode AS evidenceMode,
                configuration_json AS configurationJson
           FROM task_instances WHERE id = ? AND event_id = ?`,
      )
        .bind(created.task.id, eventId)
        .first(),
    ).resolves.toEqual({ evidenceMode: "text", configurationJson: "{}" });
    expect(
      (await service.list(principal, { limit: 200 })).tasks.some(
        (task) => task.id === created.task.id,
      ),
    ).toBe(true);
  });

  it("replays an API task idempotency key and rejects a different request", async () => {
    const service = new ApiTaskService(env as unknown as CloudflareEnvironment);
    const request = {
      title: "Idempotent API task",
      description: "A retried client request must converge on one task.",
      targetType: "event" as const,
      targetId: eventId,
      ownerPersonId: null,
      taskType: "checklist" as const,
      impact: "medium" as const,
      dueAt: null,
      dependencyIds: [],
    };
    const key = `task-replay-${crypto.randomUUID()}`;
    const first = await service.create(
      principal,
      request,
      "corr-task-replay-first",
      key,
    );
    const replay = await service.create(
      principal,
      request,
      "corr-task-replay-second",
      key,
    );

    expect(replay).toEqual(first);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM task_instances WHERE event_id = ? AND idempotency_key = (SELECT id FROM idempotency_records WHERE event_id = ? AND actor_id = ? AND scope = 'task.create' AND idempotency_key = ?)",
      )
        .bind(eventId, eventId, `api_key:${principal.keyId}`, key)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
    await expect(
      service.create(
        principal,
        { ...request, title: "Different task under reused key" },
        "corr-task-replay-conflict",
        key,
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_KEY_REUSED",
    } satisfies Partial<ApiError>);
  });

  it("treats an expired task idempotency key as a new command", async () => {
    const service = new ApiTaskService(env as unknown as CloudflareEnvironment);
    const key = `task-expired-${crypto.randomUUID()}`;
    const expiredId = `expired-${crypto.randomUUID()}`;
    const actorId = `api_key:${principal.keyId}`;
    await env.DB.prepare(
      `
      INSERT INTO idempotency_records (
        id, organisation_id, event_id, actor_id, scope, idempotency_key,
        request_hash, status, response_status, response_json, expires_at,
        created_at, completed_at
      ) VALUES (?, ?, ?, ?, 'task.create', ?, 'expired-request', 'completed',
                201, '{"changeSequence":1}', unixepoch() - 1,
                unixepoch() - 2, unixepoch() - 2)
    `,
    )
      .bind(expiredId, organisationId, eventId, actorId, key)
      .run();
    const request = {
      title: "Replacement after idempotency expiry",
      description: null,
      targetType: "event" as const,
      targetId: eventId,
      ownerPersonId: null,
      taskType: "checklist" as const,
      impact: "medium" as const,
      dueAt: null,
      dependencyIds: [],
    };

    const created = await service.create(
      principal,
      request,
      "corr-task-expired-replacement",
      key,
    );
    const record = await env.DB.prepare(
      `
      SELECT id, request_hash AS requestHash, expires_at AS expiresAt
        FROM idempotency_records
       WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
         AND scope = 'task.create' AND idempotency_key = ?
    `,
    )
      .bind(organisationId, eventId, actorId, key)
      .first<{ id: string; requestHash: string; expiresAt: number }>();

    expect(created.task.title).toBe(request.title);
    expect(record).toMatchObject({
      requestHash: await apiRequestHash(apiTaskCreateSchema.parse(request)),
    });
    expect(record?.id).not.toBe(expiredId);
    expect(record?.expiresAt).toBeGreaterThan(Math.floor(Date.now() / 1_000));
  });

  it("paginates tasks with an opaque stable cursor and RFC 3339 timestamps", async () => {
    const service = new ApiTaskService(env as unknown as CloudflareEnvironment);
    const pageEventId = `api-task-page-${crypto.randomUUID()}`;
    const pagePrincipal = { ...principal, eventId: pageEventId };
    await env.DB.prepare(
      `
      INSERT INTO events (
        id, organisation_id, name, slug, timezone, starts_at, ends_at,
        file_policy_json
      ) VALUES (?, ?, 'API pagination event', ?, 'UTC',
                unixepoch('2027-05-20T00:00:00Z'),
                unixepoch('2027-05-21T23:59:59Z'),
                '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}')
    `,
    )
      .bind(
        pageEventId,
        organisationId,
        `api-task-pagination-${crypto.randomUUID()}`,
      )
      .run();
    const dueAt = "2027-05-20T09:30:00-04:00";
    const createdIds: string[] = [];
    for (const suffix of ["A", "B", "C"]) {
      const created = await service.create(
        pagePrincipal,
        {
          title: `Paginated task ${suffix}`,
          description: null,
          targetType: "event",
          targetId: pageEventId,
          ownerPersonId: null,
          taskType: "checklist",
          impact: "medium",
          dueAt,
          dependencyIds: [],
        },
        `corr-paginated-task-${suffix}`,
        `paginated-task-${suffix}`,
      );
      createdIds.push(created.task.id);
      expect(created.task.dueAt).toBe("2027-05-20T13:30:00.000Z");
      expect(created.task.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(created.task.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }

    const first = await service.list(pagePrincipal, { limit: 2 });
    expect(first.tasks).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await service.list(pagePrincipal, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    expect(second.tasks).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(
      [...first.tasks, ...second.tasks].map((task) => task.id).sort(),
    ).toEqual(createdIds.sort());
    await expect(
      service.list(pagePrincipal, { limit: 2, cursor: "not-a-cursor" }),
    ).rejects.toMatchObject({
      status: 422,
      code: "VALIDATION_ERROR",
    } satisfies Partial<ApiError>);
  });

  it("lists large task pages and creates the maximum supported dependency set", async () => {
    const service = new ApiTaskService(env as unknown as CloudflareEnvironment);
    const largeEventId = `api-task-large-${crypto.randomUUID()}`;
    const largePrincipal = { ...principal, eventId: largeEventId };
    await env.DB.prepare(
      `
      INSERT INTO events (
        id, organisation_id, name, slug, timezone, starts_at, ends_at,
        file_policy_json
      ) VALUES (?, ?, 'Large API task event', ?, 'UTC',
                unixepoch('2027-05-20T00:00:00Z'),
                unixepoch('2027-05-21T23:59:59Z'),
                '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}')
    `,
    )
      .bind(
        largeEventId,
        organisationId,
        `api-task-large-${crypto.randomUUID()}`,
      )
      .run();
    const taskIds = Array.from(
      { length: 120 },
      (_, index) => `${largeEventId}-prerequisite-${index}`,
    );
    await env.DB.prepare(
      `
      INSERT INTO task_instances (
        id, event_id, target_type, target_id, title, task_type, impact,
        status, readiness_state, readiness_percent, revision, created_at, updated_at
      )
      SELECT CAST(value AS TEXT), ?, 'event', ?,
             'Large prerequisite ' || key, 'checklist', 'medium',
             'not_started', 'on_track', 0, 1, unixepoch(), unixepoch()
        FROM json_each(?)
    `,
    )
      .bind(largeEventId, largeEventId, JSON.stringify(taskIds))
      .run();

    const page = await service.list(largePrincipal, { limit: 200 });
    expect(page.tasks).toHaveLength(120);

    const created = await service.create(
      largePrincipal,
      {
        title: "Task with the maximum dependency set",
        description: null,
        targetType: "event",
        targetId: largeEventId,
        ownerPersonId: null,
        taskType: "checklist",
        impact: "critical",
        dueAt: null,
        dependencyIds: taskIds.slice(0, 100),
      },
      `corr-large-task-${crypto.randomUUID()}`,
      `large-task-${crypto.randomUUID()}`,
    );
    expect(created.task.status).toBe("blocked");
    expect(created.task.dependencyIds).toEqual(taskIds.slice(0, 100).sort());
  });

  it("derives overdue task state when no UI route has refreshed the stored row", async () => {
    const service = new ApiTaskService(env as unknown as CloudflareEnvironment);
    const taskId = `api-overdue-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO task_instances (
         id, event_id, target_type, target_id, title, task_type, impact,
         status, readiness_state, readiness_percent, due_at, created_at, updated_at
       ) VALUES (?, ?, 'event', ?, 'Overdue API task', 'checklist', 'high',
                 'not_started', 'on_track', 45, unixepoch() - 60,
                 unixepoch() - 120, unixepoch() - 120)`,
    )
      .bind(taskId, eventId, eventId)
      .run();

    const task = (await service.list(principal, { limit: 200 })).tasks.find(
      (candidate) => candidate.id === taskId,
    );
    expect(task).toMatchObject({
      status: "overdue",
      readinessState: "overdue",
      readinessPercent: 0,
    });
  });

  it("starts API tasks whose dependencies are already terminal without waiting for a UI refresh", async () => {
    const service = new ApiTaskService(env as unknown as CloudflareEnvironment);
    const completed = await service.create(
      principal,
      {
        title: "Completed prerequisite",
        description: null,
        targetType: "event",
        targetId: eventId,
        ownerPersonId: null,
        taskType: "checklist",
        impact: "low",
        dueAt: null,
        dependencyIds: [],
      },
      "corr-completed-prerequisite",
      "completed-prerequisite-key",
    );
    const waived = await service.create(
      principal,
      {
        title: "Waived prerequisite",
        description: null,
        targetType: "event",
        targetId: eventId,
        ownerPersonId: null,
        taskType: "checklist",
        impact: "low",
        dueAt: null,
        dependencyIds: [],
      },
      "corr-waived-prerequisite",
      "waived-prerequisite-key",
    );
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE task_instances SET status = 'completed' WHERE id = ?",
      ).bind(completed.task.id),
      env.DB.prepare(
        "UPDATE task_instances SET status = 'waived' WHERE id = ?",
      ).bind(waived.task.id),
    ]);

    const dependent = await service.create(
      principal,
      {
        title: "Ready dependent task",
        description: null,
        targetType: "event",
        targetId: eventId,
        ownerPersonId: null,
        taskType: "checklist",
        impact: "medium",
        dueAt: null,
        dependencyIds: [completed.task.id, waived.task.id],
      },
      "corr-ready-dependent",
      "ready-dependent-key",
    );

    expect(dependent.task).toMatchObject({
      status: "not_started",
      readinessState: "on_track",
      dependencyIds: [completed.task.id, waived.task.id].sort(),
    });
  });

  it("rejects shallow, unknown and cross-event task references", async () => {
    expect(() =>
      apiTaskCreateSchema.parse({ title: "Only title", impact: "high" }),
    ).toThrow();
    expect(() =>
      apiTaskCreateSchema.parse({
        title: "Duplicate dependency task",
        description: null,
        targetType: "event",
        targetId: eventId,
        ownerPersonId: null,
        taskType: "checklist",
        impact: "low",
        dueAt: null,
        dependencyIds: ["task-duplicate", "task-duplicate"],
      }),
    ).toThrow(/unique task IDs/);
    expect(() =>
      apiTaskCreateSchema.parse({
        title: "Unknown property task",
        description: null,
        targetType: "event",
        targetId: eventId,
        ownerPersonId: null,
        taskType: "checklist",
        impact: "low",
        dueAt: null,
        dependencyIds: [],
        unexpected: true,
      }),
    ).toThrow();
    expect(() => apiTaskListQuerySchema.parse({ limit: "201" })).toThrow();
    expect(() =>
      apiTaskCreateSchema.parse({
        title: "Visit the participant brief",
        targetType: "event",
        targetId: eventId,
        taskType: "link_visit",
        impact: "medium",
      }),
    ).toThrow(/require an HTTPS destination URL/);
    expect(() =>
      apiTaskCreateSchema.parse({
        title: "Visit the participant brief",
        targetType: "event",
        targetId: eventId,
        taskType: "link_visit",
        configuration: {
          destinationUrl: "https://user:secret@example.test/brief",
        },
        impact: "medium",
      }),
    ).toThrow(/credentials/);
    expect(() =>
      apiTaskCreateSchema.parse({
        title: "Upload session slides",
        targetType: "session",
        targetId: "session-demo-speaker",
        taskType: "file_upload",
        impact: "high",
      }),
    ).toThrow(/must identify a participant document or session deliverable/);
    expect(
      apiTaskCreateSchema.parse({
        title: "Upload session slides",
        targetType: "session",
        targetId: "session-demo-speaker",
        taskType: "file_upload",
        configuration: { fileScope: "session_deliverable" },
        impact: "high",
      }).configuration.fileScope,
    ).toBe("session_deliverable");
    expect(() =>
      apiTaskCreateSchema.parse({
        title: "Ambiguous slides",
        targetType: "speaker",
        targetId: "person-demo-speaker",
        taskType: "file_upload",
        configuration: { fileScope: "session_deliverable" },
        impact: "high",
      }),
    ).toThrow(/must use session scope/);

    const service = new ApiTaskService(env as unknown as CloudflareEnvironment);
    await expect(
      service.create(
        principal,
        {
          title: "Invalid dependency task",
          description: null,
          targetType: "event",
          targetId: eventId,
          ownerPersonId: null,
          taskType: "checklist",
          impact: "low",
          dueAt: null,
          dependencyIds: ["task-from-another-event"],
        },
        "corr-invalid-task",
        "invalid-task-key",
      ),
    ).rejects.toMatchObject({
      status: 422,
      code: "INVALID_TASK_DEPENDENCY",
    } satisfies Partial<ApiError>);
  });

  it("returns the immutable participant configuration written by the API", async () => {
    const service = new ApiTaskService(env as unknown as CloudflareEnvironment);
    const destinationUrl = "https://example.test/participant-brief";
    const created = await service.create(
      principal,
      {
        title: `Visit participant brief ${crypto.randomUUID()}`,
        description: "Review the organiser-provided participant brief.",
        targetType: "event",
        targetId: eventId,
        ownerPersonId: null,
        taskType: "link_visit",
        configuration: { destinationUrl },
        impact: "medium",
        dueAt: null,
        dependencyIds: [],
      },
      `corr-link-task-${crypto.randomUUID()}`,
      `link-task-${crypto.randomUUID()}`,
    );

    expect(created.task.configuration).toEqual({ destinationUrl });
    await expect(
      service.get(principal, created.task.id),
    ).resolves.toMatchObject({
      configuration: { destinationUrl },
    });
    const listed = await service.list(principal, { limit: 200 });
    expect(
      listed.tasks.find((task) => task.id === created.task.id)?.configuration,
    ).toEqual({ destinationUrl });
  });
});

describe("schedule publication API actor", () => {
  it("uses authoritative revision publication while auditing the API key, not a person", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO schedule_policies (event_id) VALUES (?)",
      ).bind(eventId),
      env.DB.prepare(
        "INSERT OR IGNORE INTO tracks (id, event_id, name, slug, position) VALUES ('api-schedule-track', ?, 'API Track', 'api-track', 0)",
      ).bind(eventId),
      env.DB.prepare(
        `
        INSERT OR IGNORE INTO sessions (
          id, event_id, track_id, title, slug, description, format, duration_minutes,
          expected_attendance, status, visibility, revision, created_at, updated_at
        ) VALUES ('api-schedule-session', ?, 'api-schedule-track', 'API session',
          'api-session', 'API-managed session content.', 'presentation', 60, 50,
          'unscheduled', 'public', 1, unixepoch(), unixepoch())
      `,
      ).bind(eventId),
    ]);
    const queued: unknown[] = [];
    const scheduleEnv = {
      ...(env as unknown as CloudflareEnvironment),
      OPERATIONS_QUEUE: {
        send: async (message: unknown) => queued.push(message),
      },
    } as unknown as CloudflareEnvironment;
    const service = new ScheduleService(scheduleEnv);
    const personViewer = {
      personId: "person-demo-admin",
      name: "Admin",
      email: "admin@example.test",
      role: "administrator" as const,
      organisationId,
      eventId,
      demo: true,
    };
    const versionId = await service.createDraft(personViewer);
    let workspace = await service.getWorkspace(principal);
    const startsAt = workspace.event.startsAt + 13 * 3_600;
    await service.place(personViewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "api-schedule-session",
      roomId: "main",
      startsAt,
      endsAt: startsAt + 3_600,
    });
    const content = new ContentManagementService(scheduleEnv);
    const contentDetail = await content.getSession(
      personViewer,
      "api-schedule-session",
    );
    await content.changeStatus(personViewer, {
      scheduleVersionId: versionId,
      sessionId: "api-schedule-session",
      scheduleRevision: contentDetail.current.scheduleRevision,
      contentRevision: contentDetail.current.contentRevision,
      status: "approved",
      confirmed: true,
    });
    workspace = await service.getWorkspace(principal);

    await expect(
      service.publish(
        principal,
        {
          scheduleVersionId: versionId,
          scheduleRevision: workspace.version!.revision - 1,
        },
        { personId: null, actorId: `api_key:${principal.keyId}` },
      ),
    ).rejects.toBeInstanceOf(ScheduleRevisionConflictError);

    const publishInput = {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
    };
    const actorId = `api_key:${principal.keyId}`;
    const command = {
      actorId,
      idempotencyKey: `schedule-publish-${crypto.randomUUID()}`,
      requestHash: await apiRequestHash(publishInput),
    };
    const publication = await service.publish(
      principal,
      publishInput,
      { personId: null, actorId },
      command,
    );
    expect(queued).toHaveLength(1);
    await expect(
      service.publish(
        principal,
        publishInput,
        { personId: null, actorId },
        command,
      ),
    ).resolves.toEqual(publication);
    await expect(
      service.publish(
        principal,
        {
          ...publishInput,
          scheduleRevision: publishInput.scheduleRevision + 1,
        },
        { personId: null, actorId },
        {
          ...command,
          requestHash: await apiRequestHash({
            ...publishInput,
            scheduleRevision: publishInput.scheduleRevision + 1,
          }),
        },
      ),
    ).rejects.toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
    } satisfies Partial<ScheduleIdempotencyConflictError>);
    const audit = await env.DB.prepare(
      `
      SELECT actor_person_id AS actorPersonId, actor_id AS actorId
        FROM audit_events
       WHERE event_id = ? AND entity_id = ? AND action = 'schedule.published'
    `,
    )
      .bind(eventId, versionId)
      .first<{ actorPersonId: string | null; actorId: string | null }>();
    expect(audit).toEqual({
      actorPersonId: null,
      actorId,
    });
    expect(publication.changeSequence).toBeGreaterThan(0);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM event_changes WHERE event_id = ? AND entity_type = 'schedule_version' AND entity_id = ? AND change_type = 'published'",
      )
        .bind(eventId, versionId)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });
});
