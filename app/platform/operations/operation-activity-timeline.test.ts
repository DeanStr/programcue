import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { OperationService } from "./operation-service.server";

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Jordan Alvarez",
  email: "sbek-organizer@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

describe("activity timeline", () => {
  it("classifies and filters immutable event activity", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const decisionId = crypto.randomUUID();
    const scheduleId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         ) VALUES (?, 'person', 'internal', 1, ?, ?, ?, 'decision.recorded', 'submission_decision',
                   'decision-filter-target', '{"outcome":"accepted"}', unixepoch())`,
      ).bind(
        decisionId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
      ),
      env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         ) VALUES (?, 'person', 'internal', 1, ?, ?, ?, 'schedule.published', 'schedule_version',
                   'schedule-filter-target', '{"entryCount":1}', unixepoch())`,
      ).bind(
        scheduleId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
      ),
      env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id,
           actor_person_id, actor_id, action, entity_type, entity_id,
           metadata_json, created_at
         ) VALUES (?, 'agent', 'admin_ui', 1, ?, ?, ?, 'program_cue_agent',
                   'assistant.completed', 'assistant_run', ?, '{}', unixepoch())`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        crypto.randomUUID(),
      ),
    ]);

    const activity = await new OperationService(
      env as unknown as CloudflareEnvironment,
    ).activity(viewer, {
      area: "evaluation",
      actorKey: `person:${viewer.personId}`,
      query: "decision-filter-target",
    });

    expect(activity.items).toHaveLength(1);
    expect(activity.nextCursor).toBeNull();
    expect(activity.items[0]).toMatchObject({
      id: decisionId,
      area: "evaluation",
      actorName: viewer.name,
      entityId: "decision-filter-target",
      summary: "Outcome: accepted",
      actorKind: "person",
      origin: "internal",
    });
    await expect(
      new OperationService(
        env as unknown as CloudflareEnvironment,
      ).activityActors(viewer),
    ).resolves.toEqual(
      expect.arrayContaining([
        {
          key: "agent:program_cue_agent",
          name: "Agent · program_cue_agent",
          kind: "agent",
        },
      ]),
    );
  });

  it("classifies every reviewer AI action as evaluation activity", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const prefix = crypto.randomUUID();
    const actions = [
      ["ai.reviewer_suggestion.requested", "evaluator_assignment"],
      ["ai.reviewer_suggestion.generated", "reviewer_ai_suggestion"],
      ["ai.reviewer_suggestion.failed", "operation"],
      ["ai.reviewer_suggestion.interrupted", "operation"],
      ["ai.reviewer_suggestion.dismissed", "reviewer_ai_suggestion"],
    ] as const;
    await env.DB.batch(
      actions.map(([action, entityType], index) =>
        env.DB.prepare(
          `INSERT INTO audit_events (
             id, actor_kind, origin, metadata_version, organisation_id,
             event_id, actor_person_id, action, entity_type, entity_id,
             metadata_json, created_at
           ) VALUES (?, 'person', 'internal', 1, ?, ?, ?, ?, ?, ?, '{}', unixepoch())`,
        ).bind(
          `${prefix}:${index}`,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          action,
          entityType,
          `${prefix}:entity:${index}`,
        ),
      ),
    );

    const activity = await new OperationService(
      env as unknown as CloudflareEnvironment,
    ).activity(viewer, { area: "evaluation", query: prefix });

    expect(activity.items).toHaveLength(actions.length);
    expect(activity.items.map((item) => item.action).sort()).toEqual(
      actions.map(([action]) => action).sort(),
    );
    expect(activity.items.every((item) => item.area === "evaluation")).toBe(
      true,
    );
  });

  it("uses a filter-bound keyset cursor without overlap", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const prefix = crypto.randomUUID();
    await env.DB.prepare(
      `WITH RECURSIVE sequence(value) AS (
         VALUES (1) UNION ALL SELECT value + 1 FROM sequence WHERE value < 51
       )
       INSERT INTO audit_events (
         id, actor_kind, origin, metadata_version, organisation_id, event_id,
         actor_person_id, action, entity_type, entity_id, metadata_json,
         created_at
       )
       SELECT ? || ':' || printf('%03d', value), 'person', 'internal', 1,
              ?, ?, ?, 'schedule.published', 'schedule_version',
              ? || ':' || value, json_object('entryCount', value),
              2100000000 + value
         FROM sequence`,
    )
      .bind(
        prefix,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        prefix,
      )
      .run();
    const service = new OperationService(
      env as unknown as CloudflareEnvironment,
    );
    const first = await service.activity(viewer, {
      area: "schedule",
      query: prefix,
    });
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).not.toBeNull();
    const second = await service.activity(viewer, {
      area: "schedule",
      query: prefix,
      cursor: first.nextCursor!,
    });
    expect(second.items).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
    expect(
      new Set([...first.items, ...second.items].map((item) => item.id)).size,
    ).toBe(51);
    await expect(
      service.activity(viewer, {
        area: "evaluation",
        query: prefix,
        cursor: first.nextCursor!,
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("rejects invalid or oversized filters instead of changing them", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const service = new OperationService(
      env as unknown as CloudflareEnvironment,
    );
    await expect(
      service.activity(viewer, { area: "not-an-area" }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.activity(viewer, { query: "x".repeat(121) }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.activityActors(viewer, { search: "x".repeat(81) }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.activity(viewer, {
        scope: "invalid" as "event",
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
