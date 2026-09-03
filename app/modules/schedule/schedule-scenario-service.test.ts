import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ScheduleConfigurationError } from "./schedule-errors";
import { MAX_ACTIVE_SCHEDULE_SCENARIOS } from "./schedule-scenario-service.server";
import { ScheduleService } from "./schedule-service.server";
import {
  prepareScheduleServiceTest,
  scheduleTestEnv,
  scheduleTestViewer as viewer,
} from "./schedule-service-test-fixture";

beforeEach(async () => {
  await prepareScheduleServiceTest();
});

describe("schedule scenarios", () => {
  it("saves a named deterministic proposal without creating another draft", async () => {
    const service = new ScheduleService(scheduleTestEnv);
    await service.createDraft(viewer);
    const preview = await service.previewAutoPlacement(viewer);
    const selectedSessionId = preview.placements[0]!.sessionId;
    const scenarioId = crypto.randomUUID();
    const scenario = await service.createScenario(viewer, {
      scenarioId,
      name: "First-fit baseline",
      selectedSessionIds: [selectedSessionId],
    });

    expect(scenario).toMatchObject({
      id: scenarioId,
      name: "First-fit baseline",
      stale: false,
    });
    expect(scenario.preview.placements.length).toBeGreaterThan(0);
    expect(scenario.preview.selectedSessionIds).toEqual([selectedSessionId]);
    await expect(service.listScenarios(viewer)).resolves.toEqual([
      expect.objectContaining({
        id: scenarioId,
        stale: false,
        preview: expect.objectContaining({
          selectedSessionIds: [selectedSessionId],
        }),
      }),
    ]);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM schedule_versions
          WHERE event_id = ? AND status = 'draft'`,
      )
        .bind(viewer.eventId)
        .first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM schedule_entries
          WHERE event_id = ?`,
      )
        .bind(viewer.eventId)
        .first(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
          WHERE event_id = ? AND action = 'schedule.scenario.created'
            AND entity_id = ?`,
      )
        .bind(viewer.eventId, scenarioId)
        .first(),
    ).toEqual({ count: 1 });
  });

  it("uses the existing confirmation path and then marks the saved proposal stale", async () => {
    const service = new ScheduleService(scheduleTestEnv);
    await service.createDraft(viewer);
    const preview = await service.previewAutoPlacement(viewer);
    const selected = preview.placements[0]!.sessionId;
    const scenario = await service.createScenario(viewer, {
      scenarioId: crypto.randomUUID(),
      name: "Selective placement",
      selectedSessionIds: [selected],
    });

    await expect(
      service.confirmAutoPlacement(viewer, {
        ...scenario.preview,
        selectedSessionIds: [selected],
      }),
    ).resolves.toMatchObject({ appliedCount: 1 });

    const [saved] = await service.listScenarios(viewer);
    expect(saved).toMatchObject({
      id: scenario.id,
      stale: true,
      staleReason: expect.stringMatching(/draft schedule changed/i),
    });
  });

  it("rejects selections outside the current proposal and conflicting intent replays", async () => {
    const service = new ScheduleService(scheduleTestEnv);
    await service.createDraft(viewer);
    const preview = await service.previewAutoPlacement(viewer);
    const [first, second] = preview.placements;
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    const scenarioId = crypto.randomUUID();

    await expect(
      service.createScenario(viewer, {
        scenarioId: crypto.randomUUID(),
        name: "Unavailable selection",
        selectedSessionIds: ["not-in-the-proposal"],
      }),
    ).rejects.toThrow(/no longer available/i);

    await service.createScenario(viewer, {
      scenarioId,
      name: "One selected move",
      selectedSessionIds: [first!.sessionId],
    });
    await expect(
      service.createScenario(viewer, {
        scenarioId,
        name: "One selected move",
        selectedSessionIds: [first!.sessionId],
      }),
    ).resolves.toMatchObject({ id: scenarioId });
    await expect(
      service.createScenario(viewer, {
        scenarioId,
        name: "One selected move",
        selectedSessionIds: [second!.sessionId],
      }),
    ).rejects.toThrow(/different details/i);
  });

  it("rejects duplicate active names and event-scoped discards", async () => {
    const service = new ScheduleService(scheduleTestEnv);
    await service.createDraft(viewer);
    const selectedSessionIds = [
      (await service.previewAutoPlacement(viewer)).placements[0]!.sessionId,
    ];
    const scenario = await service.createScenario(viewer, {
      scenarioId: crypto.randomUUID(),
      name: "Named proposal",
      selectedSessionIds,
    });
    await expect(
      service.createScenario(viewer, {
        scenarioId: crypto.randomUUID(),
        name: "Named proposal",
        selectedSessionIds,
      }),
    ).rejects.toBeInstanceOf(ScheduleConfigurationError);
    await expect(
      service.discardScenario(
        { ...viewer, eventId: "unrelated-event" },
        { scenarioId: scenario.id },
      ),
    ).rejects.toThrow(/not found/i);
    await service.discardScenario(viewer, { scenarioId: scenario.id });
    await expect(service.listScenarios(viewer)).resolves.toEqual([]);
  });

  it("enforces the active scenario limit and releases capacity on discard", async () => {
    const service = new ScheduleService(scheduleTestEnv);
    await service.createDraft(viewer);
    const selectedSessionIds = [
      (await service.previewAutoPlacement(viewer)).placements[0]!.sessionId,
    ];
    const scenarioIds: string[] = [];
    for (let index = 0; index < MAX_ACTIVE_SCHEDULE_SCENARIOS; index += 1) {
      const scenarioId = crypto.randomUUID();
      scenarioIds.push(scenarioId);
      await service.createScenario(viewer, {
        scenarioId,
        name: `Alternative ${index + 1}`,
        selectedSessionIds,
      });
    }

    await expect(
      service.createScenario(viewer, {
        scenarioId: crypto.randomUUID(),
        name: "One too many",
        selectedSessionIds,
      }),
    ).rejects.toThrow(/fewer than 10 active scenarios/i);

    await service.discardScenario(viewer, { scenarioId: scenarioIds[0] });
    await expect(
      service.createScenario(viewer, {
        scenarioId: crypto.randomUUID(),
        name: "Replacement alternative",
        selectedSessionIds,
      }),
    ).resolves.toMatchObject({ name: "Replacement alternative" });
  });
});
