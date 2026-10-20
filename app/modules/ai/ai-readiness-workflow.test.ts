import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { EventService } from "~/modules/events/event-service.server";
import { ReadinessService } from "~/modules/readiness/readiness-service.server";
import { ScheduleService } from "~/modules/schedule/schedule-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  READINESS_ACCEPTANCE_PROMPT,
  runDemonstrationReadinessScenario,
  seedReadinessAcceptanceEvent,
} from "~/platform/demo/assistant-readiness-fixture.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { AiAssistantService } from "./ai-assistant-service.server";
import {
  AnthropicMessagesProvider,
  WORKERS_AI_MODEL,
  WorkersAiProvider,
} from "./ai-provider.server";
import { loadReadinessTaskContext } from "./ai-readiness-task.server";
import {
  aggregateModelCalls,
  measureModelCall,
  readInferencePricing,
} from "./ai-run-measurements.server";
import { listAssistantRunReports } from "./ai-run-report.server";
import { AiToolExecutor } from "./ai-tools.server";
import {
  AiProviderError,
  OpenAiResponsesProvider,
} from "./openai-responses-provider.server";

const runtime = env as unknown as CloudflareEnvironment;
const organiser: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};
beforeEach(async () => {
  await ensureDemoData(runtime);
});

describe("readiness to approved task workflow (explicit simulated model)", () => {
  it("answers a populated event without overflowing retained readiness audit evidence", async () => {
    const fixture = await seedReadinessAcceptanceEvent(
      runtime,
      organiser,
      "success",
    );
    await env.DB.batch(
      Array.from({ length: 54 }, () => {
        const id = crypto.randomUUID();
        return env.DB.prepare(
          `INSERT INTO schedule_conflicts (id, event_id, schedule_version_id, conflict_type, severity, fingerprint, details_json, primary_entry_id, conflicting_entry_id) SELECT ?, event_id, schedule_version_id, conflict_type, severity, ?, json_object('message', ?), primary_entry_id, conflicting_entry_id FROM schedule_conflicts WHERE id = ? AND event_id = ?`,
        ).bind(
          id,
          id,
          "Recorded blocking collision. ".repeat(15),
          fixture.conflictId,
          fixture.eventId,
        );
      }),
    );
    let attempt = 0;
    const service = new AiAssistantService(runtime, {
      providerConfiguration: {
        apiKey: "explicit-simulated-large-readiness",
        model: "fixture",
      },
      fetcher: async () =>
        Response.json({
          id: `large-readiness-${++attempt}`,
          model: "fixture",
          status: "completed",
          output:
            attempt === 1
              ? [
                  {
                    type: "function_call",
                    call_id: "readiness",
                    name: "get_event_readiness",
                    arguments: "{}",
                  },
                ]
              : [
                  {
                    type: "message",
                    role: "assistant",
                    content: [
                      {
                        type: "output_text",
                        text: "The recorded blocking conflicts need review. Only a bounded subset of evidence is available; inspect the schedule before proposing work.",
                      },
                    ],
                  },
                ],
        }),
    });
    const result = await service.ask(
      fixture.viewer,
      "Read event readiness and answer only; do not propose work.",
    );
    expect(result.proposals).toEqual([]);
    const [report] = await listAssistantRunReports(runtime, fixture.viewer);
    expect(report.status).toBe("completed");
    const observation = report.history.find(
      (item) =>
        item.action === "assistant.tool.completed" &&
        item.details.toolName === "get_event_readiness",
    );
    expect(JSON.stringify(observation?.details).length).toBeLessThan(32_768);
    const context = observation?.details.snapshot.recommendedAction;
    expect(context.count).toBe(55);
    expect(context.records.length).toBeGreaterThan(0);
    expect(context.records.length).toBeLessThan(55);
    expect(context.sufficient).toBe(false);
    expect(context.limitation).toMatch(/evidence limit/);
  });

  it.each(["owner", "administrator"] as const)(
    "creates an approved task for an organisation-wide %s without event membership",
    async (role) => {
      const personId = `org-only-${crypto.randomUUID()}`;
      const membershipId = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO people (id, email, display_name) VALUES (?, ?, 'Organisation organiser')",
        ).bind(personId, `${personId}@example.com`),
        env.DB.prepare(
          "INSERT INTO memberships (id, organisation_id, person_id, role, accepted_at) VALUES (?, ?, ?, ?, unixepoch())",
        ).bind(membershipId, organiser.organisationId, personId, role),
      ]);
      try {
        const requester = { ...organiser, personId, role };
        const fixture = await seedReadinessAcceptanceEvent(
          runtime,
          requester,
          "success",
        );
        await env.DB.prepare(
          "DELETE FROM memberships WHERE event_id = ? AND person_id = ?",
        )
          .bind(fixture.eventId, personId)
          .run();
        const generated = await runDemonstrationReadinessScenario(
          runtime,
          requester,
          "success",
          READINESS_ACCEPTANCE_PROMPT,
          fixture,
        );
        expect(generated.error).toBeNull();
        const proposal = generated.result?.proposals[0];
        expect(
          proposal?.toolName === "propose_task" && proposal.task?.ownerPersonId,
        ).toBe(personId);
        await expect(
          new AiAssistantService(runtime).approveProposal(
            fixture.viewer,
            proposal?.id,
            true,
          ),
        ).resolves.toMatchObject({ kind: "task" });
        expect(
          await env.DB.prepare(
            "SELECT owner_person_id AS owner FROM task_instances WHERE event_id = ?",
          )
            .bind(fixture.eventId)
            .first(),
        ).toMatchObject({ owner: personId });
      } finally {
        await env.DB.prepare("DELETE FROM memberships WHERE id = ?")
          .bind(membershipId)
          .run();
      }
    },
  );

  it("returns registered review links for unassigned submission evidence", async () => {
    const fixture = await seedReadinessAcceptanceEvent(
      runtime,
      organiser,
      "no_blockers",
    );
    const id = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO submissions (id, event_id, public_reference, title, status, submitted_at, submitted_snapshot_json) VALUES (?, ?, ?, 'Needs review assignment', 'submitted', unixepoch(), '{}')`,
    )
      .bind(id, fixture.eventId, id)
      .run();
    const observation = await new AiToolExecutor(
      runtime,
      fixture.viewer,
      crypto.randomUUID(),
      "fixture",
    ).execute("get_event_readiness", "{}");
    expect(observation.evidence).toContainEqual(
      expect.objectContaining({ id, href: `/admin/review?submission=${id}` }),
    );
  });

  it("links another organiser to existing coordination work instead of duplicating it", async () => {
    const fixture = await runDemonstrationReadinessScenario(
      runtime,
      organiser,
      "success",
    );
    const approved = await new AiAssistantService(runtime).approveProposal(
      fixture.viewer,
      fixture.result?.proposals[0].id,
      true,
    );
    if (approved.kind !== "task") throw new Error("Expected created task");
    const other = {
      ...fixture.viewer,
      personId: "person-demo-owner",
      role: "owner" as const,
    };
    const observation = await new AiToolExecutor(
      runtime,
      other,
      crypto.randomUUID(),
      "fixture",
    ).execute("get_event_readiness", "{}");
    expect(observation.evidence).toContainEqual(
      expect.objectContaining({
        id: approved.taskId,
        href: `/admin/tasks?task=${approved.taskId}`,
      }),
    );
    expect(new Set(observation.evidence.map((record) => record.id)).size).toBe(
      observation.evidence.length,
    );
    expect(await listAssistantRunReports(runtime, other)).toEqual([]);
  });

  it.each(["replaces", "adds to"])(
    "allows new work when an unrelated conflict %s the original task's scope",
    async (change) => {
      const fixture = await runDemonstrationReadinessScenario(
        runtime,
        organiser,
        "success",
      );
      const original = await new AiAssistantService(runtime).approveProposal(
        fixture.viewer,
        fixture.result?.proposals[0].id,
        true,
      );
      if (original.kind !== "task") throw new Error("Expected created task");
      const conflictId = crypto.randomUUID();
      await env.DB.prepare(
        `INSERT INTO schedule_conflicts (id, event_id, schedule_version_id, conflict_type, severity, fingerprint, details_json, primary_entry_id, conflicting_entry_id) SELECT ?, event_id, schedule_version_id, 'speaker', 'blocking', ?, json_object('message', 'A different speaker is scheduled in overlapping sessions.'), primary_entry_id, conflicting_entry_id FROM schedule_conflicts WHERE id = ? AND event_id = ?`,
      )
        .bind(conflictId, conflictId, fixture.conflictId, fixture.eventId)
        .run();
      if (change === "replaces")
        await env.DB.prepare(
          "UPDATE schedule_conflicts SET resolved_at = unixepoch() WHERE id = ? AND event_id = ?",
        )
          .bind(fixture.conflictId, fixture.eventId)
          .run();
      const next = await runDemonstrationReadinessScenario(
        runtime,
        organiser,
        "success",
        READINESS_ACCEPTANCE_PROMPT,
        fixture,
      );
      expect(next.error).toBeNull();
      expect(next.result?.proposals).toHaveLength(1);
      expect(next.result?.proposals[0].affectedRecords).toContainEqual(
        expect.objectContaining({ id: conflictId, label: "speaker" }),
      );
      expect(next.result?.proposals[0].affectedRecords).toHaveLength(1);
      if (change === "adds to") {
        expect(next.result?.evidence.map((record) => record.id)).toContain(
          original.taskId,
        );
      } else {
        expect(next.result?.evidence.map((record) => record.id)).not.toContain(
          original.taskId,
        );
      }
      await new AiAssistantService(runtime).approveProposal(
        fixture.viewer,
        next.result?.proposals[0].id,
        true,
      );
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM task_instances WHERE event_id = ?",
        )
          .bind(fixture.eventId)
          .first(),
      ).toMatchObject({ count: 2 });
      const covered = await runDemonstrationReadinessScenario(
        runtime,
        organiser,
        "success",
        READINESS_ACCEPTANCE_PROMPT,
        fixture,
      );
      expect(covered.error).toBeNull();
      expect(covered.result?.proposals).toEqual([]);
      if (change === "adds to") {
        const observation = await new AiToolExecutor(
          runtime,
          fixture.viewer,
          crypto.randomUUID(),
          "fixture",
        ).execute("get_event_readiness", "{}");
        expect(observation.output).toMatchObject({
          recommendedAction: {
            records: expect.arrayContaining([
              expect.objectContaining({
                id: fixture.conflictId,
                covered: true,
              }),
              expect.objectContaining({ id: conflictId, covered: true }),
            ]),
            existingWork: expect.arrayContaining([
              expect.objectContaining({ id: original.taskId }),
            ]),
          },
        });
        // The newer task owns only the added conflict, not the already-covered one.
        await env.DB.prepare(
          "UPDATE task_instances SET status = 'waived' WHERE id = ? AND event_id = ?",
        )
          .bind(original.taskId, fixture.eventId)
          .run();
        const uncoveredAgain = await runDemonstrationReadinessScenario(
          runtime,
          organiser,
          "success",
          READINESS_ACCEPTANCE_PROMPT,
          fixture,
        );
        expect(uncoveredAgain.error).toBeNull();
        expect(uncoveredAgain.result?.proposals[0].affectedRecords).toEqual([
          expect.objectContaining({ id: fixture.conflictId }),
        ]);
      }
    },
  );

  it("keeps existing work when it still covers every remaining affected record", async () => {
    const fixture = await seedReadinessAcceptanceEvent(
      runtime,
      organiser,
      "success",
    );
    const conflictId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO schedule_conflicts (id, event_id, schedule_version_id, conflict_type, severity, fingerprint, details_json, primary_entry_id, conflicting_entry_id) SELECT ?, event_id, schedule_version_id, 'speaker', 'blocking', ?, json_object('message', 'A speaker is scheduled in overlapping sessions.'), primary_entry_id, conflicting_entry_id FROM schedule_conflicts WHERE id = ? AND event_id = ?`,
    )
      .bind(conflictId, conflictId, fixture.conflictId, fixture.eventId)
      .run();
    const generated = await runDemonstrationReadinessScenario(
      runtime,
      organiser,
      "success",
      READINESS_ACCEPTANCE_PROMPT,
      fixture,
    );
    expect(generated.result?.proposals[0].affectedRecords).toHaveLength(2);
    const approved = await new AiAssistantService(runtime).approveProposal(
      fixture.viewer,
      generated.result?.proposals[0].id,
      true,
    );
    if (approved.kind !== "task") throw new Error("Expected created task");
    await env.DB.prepare(
      "UPDATE schedule_conflicts SET resolved_at = unixepoch() WHERE id = ? AND event_id = ?",
    )
      .bind(fixture.conflictId, fixture.eventId)
      .run();
    const next = await runDemonstrationReadinessScenario(
      runtime,
      organiser,
      "success",
      READINESS_ACCEPTANCE_PROMPT,
      fixture,
    );
    expect(next.error).toBeNull();
    expect(next.result?.proposals).toEqual([]);
    expect(next.result?.evidence).toContainEqual(
      expect.objectContaining({ id: approved.taskId }),
    );
  });

  it("retains coordination work after an unchanged schedule conflict rebuild", async () => {
    const fixture = await seedReadinessAcceptanceEvent(
      runtime,
      organiser,
      "success",
    );
    const schedules = new ScheduleService(runtime);
    const savePolicies = async () => {
      const workspace = await schedules.getWorkspace(fixture.viewer);
      await schedules.updatePolicies(fixture.viewer, {
        revision: workspace.policyRevision,
        roomAction: "block",
        speakerAction: "block",
        resourceAction: "block",
        trackAction: "warn",
        boundaryAction: "block",
        capacityAction: "warn",
        speakerUnavailableAction: "block",
        minimumTurnaroundMinutes: 0,
      });
    };
    await savePolicies();
    const generated = await runDemonstrationReadinessScenario(
      runtime,
      organiser,
      "success",
      READINESS_ACCEPTANCE_PROMPT,
      fixture,
    );
    expect(generated.error).toBeNull();
    const approved = await new AiAssistantService(runtime).approveProposal(
      fixture.viewer,
      generated.result?.proposals[0].id,
      true,
    );
    if (approved.kind !== "task") throw new Error("Expected created task");
    const records = async () =>
      (
        await env.DB.prepare(
          "SELECT id, fingerprint FROM schedule_conflicts WHERE event_id = ? ORDER BY fingerprint, id",
        )
          .bind(fixture.eventId)
          .all<{ id: string; fingerprint: string }>()
      ).results;
    const before = await records();
    await savePolicies();
    const after = await records();
    expect(after.map((record) => record.fingerprint)).toEqual(
      before.map((record) => record.fingerprint),
    );
    expect(after.map((record) => record.id)).not.toEqual(
      before.map((record) => record.id),
    );
    const next = await runDemonstrationReadinessScenario(
      runtime,
      organiser,
      "success",
      READINESS_ACCEPTANCE_PROMPT,
      fixture,
    );
    expect(next.error).toBeNull();
    expect(next.result?.proposals).toEqual([]);
    expect(next.result?.evidence).toContainEqual(
      expect.objectContaining({ id: approved.taskId }),
    );
  });

  it("links failed delivery evidence to the selected communication's delivery health", async () => {
    const fixture = await seedReadinessAcceptanceEvent(
      runtime,
      organiser,
      "delivery_failures",
    );
    const delivery = await env.DB.prepare(
      "SELECT id, communication_id AS communicationId FROM communication_deliveries WHERE event_id = ? AND status = 'failed'",
    )
      .bind(fixture.eventId)
      .first<{ id: string; communicationId: string }>();
    if (!delivery) throw new Error("Expected a failed fixture delivery");
    const observation = await new AiToolExecutor(
      runtime,
      fixture.viewer,
      crypto.randomUUID(),
      "fixture",
    ).execute("get_event_readiness", "{}");
    expect(observation.evidence).toContainEqual(
      expect.objectContaining({
        id: delivery.id,
        href: `/admin/communications?deliveryCommunication=${delivery.communicationId}#communications-health`,
      }),
    );
  });

  it("identifies the requesting organiser among multiple eligible owners", async () => {
    const fixture = await seedReadinessAcceptanceEvent(
      runtime,
      organiser,
      "success",
    );
    await env.DB.prepare(
      `INSERT INTO memberships (id, organisation_id, event_id, person_id, role, accepted_at, created_at) VALUES (?, ?, ?, 'person-demo-owner', 'owner', unixepoch(), unixepoch())`,
    )
      .bind(crypto.randomUUID(), organiser.organisationId, fixture.eventId)
      .run();
    const observation = await new AiToolExecutor(
      runtime,
      fixture.viewer,
      crypto.randomUUID(),
      "fixture",
    ).execute("get_event_readiness", "{}");
    expect(observation.output).toMatchObject({
      requestingOrganiserPersonId: organiser.personId,
      recommendedAction: {
        eligibleOwners: expect.arrayContaining([
          expect.objectContaining({ personId: organiser.personId }),
          expect.objectContaining({ personId: "person-demo-owner" }),
        ]),
      },
    });
    const ownerViewer = {
      ...fixture.viewer,
      personId: "person-demo-owner",
      role: "owner" as const,
    };
    const generated = await runDemonstrationReadinessScenario(
      runtime,
      ownerViewer,
      "success",
      READINESS_ACCEPTANCE_PROMPT,
      { ...fixture, viewer: ownerViewer },
    );
    expect(generated.error).toBeNull();
    const preview = generated.result?.proposals[0];
    expect(
      preview?.toolName === "propose_task" && preview.task?.ownerPersonId,
    ).toBe(ownerViewer.personId);
  });
  it("accepts inspected readiness links and rejects invented origins or filters while retaining the failed run", async () => {
    for (const [href, valid] of [
      ["/admin/schedule?filter=conflicts", true],
      ["/admin/submissions/form", true],
      [
        "https://example.admin/programcue/admin/schedule?filter=conflicts",
        false,
      ],
      ["/admin/schedule?filter=invented", false],
      ["/made-up-record", false],
    ] as const) {
      const fixture = await seedReadinessAcceptanceEvent(
        runtime,
        organiser,
        "success",
      );
      let attempt = 0;
      const service = new AiAssistantService(runtime, {
        providerConfiguration: {
          apiKey: "explicit-simulated-link-test",
          model: "fixture-links",
        },
        fetcher: async () => {
          attempt += 1;
          return Response.json({
            id: `link-check-${attempt}`,
            model: "fixture-links",
            status: "completed",
            usage: { input_tokens: 100, output_tokens: 20 },
            output:
              attempt === 1
                ? [
                    {
                      type: "function_call",
                      call_id: "readiness-link-call",
                      name: "get_event_readiness",
                      arguments: "{}",
                    },
                  ]
                : [
                    {
                      type: "message",
                      role: "assistant",
                      content: [
                        {
                          type: "output_text",
                          text: `The room conflict blocks publication. [Inspect the conflict](${href}).`,
                        },
                      ],
                    },
                  ],
          });
        },
      });
      const run = service.ask(
        fixture.viewer,
        "Read event readiness and answer only. Do not propose work.",
      );
      if (valid) await expect(run).resolves.toMatchObject({ proposals: [] });
      else
        await expect(run).rejects.toThrow(
          /readiness link.*not returned by an inspected source/,
        );
      const [report] = await listAssistantRunReports(runtime, fixture.viewer);
      expect(report.status).toBe(valid ? "completed" : "failed");
      expect(report.measurements?.totals.callCount).toBe(2);
      expect(report.result?.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "event-readiness" }),
        ]),
      );
    }
  });
  it("retains source evidence, edits the proposal, creates exactly one approved task and reloads its report", async () => {
    const fixture = await runDemonstrationReadinessScenario(
      runtime,
      organiser,
      "success",
      READINESS_ACCEPTANCE_PROMPT,
    );
    expect(fixture.error).toBeNull();
    const proposal = fixture.result?.proposals[0];
    expect(proposal?.toolName).toBe("propose_task");
    expect(proposal?.affectedRecords?.map((record) => record.id)).toContain(
      fixture.conflictId,
    );
    expect(
      proposal?.changes.find((change) => change.field === "Owner")?.after,
    ).not.toBe("Unassigned");
    const service = new AiAssistantService(runtime);
    const [awaiting] = await listAssistantRunReports(runtime, fixture.viewer);
    expect(awaiting).toMatchObject({
      requestLabel: READINESS_ACCEPTANCE_PROMPT,
      outcome: "Awaiting approval",
      status: "completed",
      answer: fixture.result?.answer,
    });
    const edited = await service.reviewTaskProposal(
      fixture.viewer,
      proposal?.id,
      {
        decision: "edit",
        title: "Arrange a room change with the venue",
        description:
          "Coordinate the recorded room collision with the venue and verify the schedule again.",
        ownerPersonId: organiser.personId,
      },
    );
    expect(edited.replacementProposalId).toBeTruthy();
    await expect(
      service.approveProposal(fixture.viewer, proposal?.id, true),
    ).rejects.toThrow(/no longer current/);
    const approved = await service.approveProposal(
      fixture.viewer,
      edited.replacementProposalId,
      true,
    );
    expect(approved.kind).toBe("task");
    if (approved.kind !== "task") throw new Error("Expected task result");
    await expect(
      service.approveProposal(
        fixture.viewer,
        edited.replacementProposalId,
        true,
      ),
    ).resolves.toMatchObject({ taskId: approved.taskId, replayed: true });
    const saved = await env.DB.prepare(
      "SELECT title, owner_person_id AS owner FROM task_instances WHERE event_id = ? AND id = ?",
    )
      .bind(fixture.eventId, approved.taskId)
      .first();
    expect(saved).toMatchObject({
      title: "Arrange a room change with the venue",
      owner: organiser.personId,
    });
    const [reloaded] = await listAssistantRunReports(runtime, fixture.viewer);
    expect(reloaded.outcome).toBe("Task created");
    expect(reloaded.measurements?.totals).toMatchObject({
      callCount: 3,
      inputTokens: 300,
      outputTokens: 60,
      totalTokens: 360,
      estimatedCostUsd: null,
    });
    expect(
      reloaded.history.some(
        (item) =>
          item.action === "assistant.proposal.superseded" &&
          item.details.decision === "edit",
      ),
    ).toBe(true);
    expect(
      reloaded.history.some(
        (item) => item.action === "assistant.approval.recorded",
      ),
    ).toBe(true);
    expect(
      reloaded.history.find(
        (item) => item.action === "assistant.action.executed",
      )?.details.result.taskId,
    ).toBe(approved.taskId);
    expect(
      (
        await new AiAssistantService(runtime).listRecentProposals(
          fixture.viewer,
        )
      )[0].executedTaskId,
    ).toBe(approved.taskId);
    await expect(
      service.reviewTaskProposal(fixture.viewer, edited.replacementProposalId, {
        decision: "reject",
        confirmed: true,
      }),
    ).rejects.toThrow(/already approved/);
  });

  it("uses a refreshed observation when two reads share the same audit timestamp", async () => {
    const fixture = await runDemonstrationReadinessScenario(
      runtime,
      organiser,
      "success",
    );
    const result = fixture.result;
    if (!result) throw new Error("Expected generated proposal");
    await env.DB.prepare(
      "UPDATE schedule_conflicts SET details_json = ? WHERE id = ? AND event_id = ?",
    )
      .bind(
        JSON.stringify({
          message:
            "The venue confirmed that the room collision still needs a new time.",
        }),
        fixture.conflictId,
        fixture.eventId,
      )
      .run();
    const current = await loadReadinessTaskContext(
      runtime,
      fixture.viewer,
      await new ReadinessService(runtime).getCommandCentre(fixture.viewer),
    );
    const source = fixture.reports[0].history.find(
      (item) =>
        item.action === "assistant.tool.completed" &&
        item.details.toolName === "get_event_readiness",
    );
    await env.DB.prepare(
      `INSERT INTO audit_events (id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, actor_id, action, entity_type, entity_id, correlation_id, metadata_json, created_at) VALUES (?, 'agent', 'admin_ui', 1, ?, ?, ?, 'program_cue_agent', 'assistant.tool.completed', 'assistant_run', ?, ?, ?, ?)`,
    )
      .bind(
        `!refresh-${crypto.randomUUID()}`,
        organiser.organisationId,
        fixture.eventId,
        organiser.personId,
        result.runId,
        result.runId,
        JSON.stringify({
          toolName: "get_event_readiness",
          toolSequence: 2,
          snapshot: { recommendedAction: current },
        }),
        source?.createdAt ?? 0,
      )
      .run();
    const proposal = result.proposals[0];
    if (proposal.toolName !== "propose_task")
      throw new Error("Expected task preview");
    const refreshed = await new AiToolExecutor(
      runtime,
      fixture.viewer,
      result.runId,
      result.attribution.model,
    ).execute("propose_task", JSON.stringify(proposal.task));
    expect(refreshed.proposals).toHaveLength(1);
    expect(refreshed.proposals[0].affectedRecords?.[0].detail).toContain(
      "venue confirmed",
    );
  });

  it("allows an explicitly unrelated task after reading readiness, including later edits", async () => {
    const fixture = await runDemonstrationReadinessScenario(
      runtime,
      organiser,
      "success",
    );
    const result = fixture.result;
    const original = result?.proposals[0];
    if (!result || original?.toolName !== "propose_task")
      throw new Error("Expected readiness preview");
    const execution = await new AiToolExecutor(
      runtime,
      fixture.viewer,
      result.runId,
      result.attribution.model,
    ).execute(
      "propose_task",
      JSON.stringify({
        ...original.task,
        readinessBlockerKey: null,
        title: "Confirm welcome signage",
        description: "Confirm printed welcome signage with the venue team.",
      }),
    );
    const proposal = execution.proposals[0];
    expect(proposal.affectedRecords).toBeUndefined();
    await env.DB.prepare(
      "UPDATE schedule_conflicts SET resolved_at = unixepoch() WHERE id = ? AND event_id = ?",
    )
      .bind(fixture.conflictId, fixture.eventId)
      .run();
    const service = new AiAssistantService(runtime);
    const edited = await service.reviewTaskProposal(
      fixture.viewer,
      proposal.id,
      {
        decision: "edit",
        title: "Confirm entrance signage",
        description: "Confirm the printed entrance signs.",
        ownerPersonId: organiser.personId,
      },
    );
    await expect(
      service.approveProposal(
        fixture.viewer,
        edited.replacementProposalId,
        true,
      ),
    ).resolves.toMatchObject({ kind: "task" });
  });

  it("rejects a proposal durably without creating work and preserves the review decision", async () => {
    const fixture = await runDemonstrationReadinessScenario(
      runtime,
      organiser,
      "success",
    );
    const proposalId = fixture.result?.proposals[0].id;
    const service = new AiAssistantService(runtime);
    await service.reviewTaskProposal(fixture.viewer, proposalId, {
      decision: "reject",
      confirmed: true,
    });
    await expect(
      service.approveProposal(fixture.viewer, proposalId, true),
    ).rejects.toThrow(/no longer current/);
    expect(await service.listRecentProposals(fixture.viewer)).toEqual([]);
    const [report] = await listAssistantRunReports(runtime, fixture.viewer);
    expect(report.outcome).toBe("Rejected");
    expect(
      report.history.some(
        (item) =>
          item.action === "assistant.proposal.superseded" &&
          item.details.decision === "reject",
      ),
    ).toBe(true);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM task_instances WHERE event_id = ?",
      )
        .bind(fixture.eventId)
        .first(),
    ).toMatchObject({ count: 0 });
  });

  it("rolls back an edited preview if its terminal audit cannot be recorded", async () => {
    const fixture = await runDemonstrationReadinessScenario(
      runtime,
      organiser,
      "success",
    );
    const service = new AiAssistantService(runtime);
    await env.DB.prepare(
      `CREATE TRIGGER reject_task_review_audit BEFORE INSERT ON audit_events WHEN NEW.action = 'assistant.proposal.superseded' AND json_extract(NEW.metadata_json, '$.decision') = 'edit' BEGIN SELECT RAISE(ABORT, 'task review audit unavailable'); END`,
    ).run();
    try {
      await expect(
        service.reviewTaskProposal(
          fixture.viewer,
          fixture.result?.proposals[0].id,
          {
            decision: "edit",
            title: "Review the room conflict with the venue",
            description:
              "Coordinate the room change and check the schedule again.",
            ownerPersonId: organiser.personId,
          },
        ),
      ).rejects.toThrow(/task review audit unavailable/);
      const pending = await service.listRecentProposals(fixture.viewer);
      expect(pending.map((proposal) => proposal.id)).toEqual([
        fixture.result?.proposals[0].id,
      ]);
      const [report] = await listAssistantRunReports(runtime, fixture.viewer);
      expect(
        report.history.some(
          (item) => item.action === "assistant.proposal.revision.failed",
        ),
      ).toBe(true);
    } finally {
      await env.DB.prepare("DROP TRIGGER reject_task_review_audit").run();
    }
  });

  it("abstains when source detail is insufficient and distinguishes an event with no blockers", async () => {
    for (const scenario of [
      "insufficient_information",
      "no_blockers",
    ] as const) {
      const fixture = await runDemonstrationReadinessScenario(
        runtime,
        organiser,
        scenario,
      );
      expect(fixture.error).toBeNull();
      expect(fixture.result?.proposals).toEqual([]);
      expect(fixture.result?.answer).toMatch(
        scenario === "no_blockers"
          ? /No readiness blockers.*setup is incomplete/
          : /lacks enough detail/,
      );
      const observation = fixture.reports[0].history.find(
        (item) => item.action === "assistant.tool.completed",
      )?.details.snapshot;
      expect(observation.recommendedAction?.sufficient ?? false).toBe(false);
      expect(fixture.reports[0].measurements?.totals.callCount).toBe(2);
    }
  });

  it("refuses stale approval when the motivating conflict has been resolved", async () => {
    const fixture = await runDemonstrationReadinessScenario(
      runtime,
      organiser,
      "stale_before_approval",
    );
    await expect(
      new AiAssistantService(runtime).approveProposal(
        fixture.viewer,
        fixture.result?.proposals[0].id,
        true,
      ),
    ).rejects.toThrow(/changed after inspection/);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM task_instances WHERE event_id = ?",
      )
        .bind(fixture.eventId)
        .first(),
    ).toMatchObject({ count: 0 });
    const [report] = await listAssistantRunReports(runtime, fixture.viewer);
    expect(report.status).toBe("completed"); // Generation succeeded; execution failed.
    expect(
      report.history.some((item) => item.action === "assistant.action.failed"),
    ).toBe(true);
    expect(report.proposals[0].review).toBe("stale");
    expect(report.outcome).toBe("Needs a fresh preview");
    expect(
      await new AiAssistantService(runtime).listRecentProposals(fixture.viewer),
    ).toEqual([]);
  });

  it("keeps timings and partial usage for every attempted call when a provider fails", async () => {
    const fixture = await runDemonstrationReadinessScenario(
      runtime,
      organiser,
      "provider_failure",
    );
    expect(fixture.result).toBeNull();
    expect(fixture.error).toMatch(/injected acceptance provider failure/);
    const [report] = fixture.reports;
    expect(report.status).toBe("failed");
    expect(report.outcome).toBe("Could not complete response");
    expect(report.answer).toBeNull();
    expect(report.measurements?.totals).toMatchObject({
      callCount: 2,
      inputTokens: null,
      estimatedCostUsd: null,
      callsWithUnknownCost: 2,
    });
    expect(
      report.history
        .filter((item) =>
          ["assistant.model.completed", "assistant.model.failed"].includes(
            item.action,
          ),
        )
        .map((item) => item.action)
        .sort(),
    ).toEqual(["assistant.model.completed", "assistant.model.failed"]);
    expect(report.result?.evidence).not.toEqual([]);
    expect(report.measurements?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("enforces actor and event isolation for review and retained reports", async () => {
    const fixture = await runDemonstrationReadinessScenario(
      runtime,
      organiser,
      "success",
    );
    const service = new AiAssistantService(runtime);
    await expect(
      service.reviewTaskProposal(organiser, fixture.result?.proposals[0].id, {
        decision: "reject",
        confirmed: true,
      }),
    ).rejects.toThrow(/not found/i);
    expect(
      await listAssistantRunReports(runtime, {
        ...fixture.viewer,
        personId: "person-demo-owner",
      }),
    ).toEqual([]);
    await expect(
      service.approveProposal(
        { ...fixture.viewer, role: "evaluator" },
        fixture.result?.proposals[0].id,
        true,
      ),
    ).rejects.toThrow();
  });

  it("blocks event changes between source revalidation and the atomic task creation", async () => {
    const fixture = await runDemonstrationReadinessScenario(
      runtime,
      organiser,
      "success",
    );
    const service = new AiAssistantService(runtime, {
      beforeProposalMutation: async () => {
        await env.DB.prepare(
          "INSERT INTO event_changes (event_id, entity_type, entity_id, change_type) VALUES (?, 'schedule_conflict', ?, 'updated')",
        )
          .bind(fixture.eventId, fixture.conflictId)
          .run();
      },
    });
    await expect(
      service.approveProposal(
        fixture.viewer,
        fixture.result?.proposals[0].id,
        true,
      ),
    ).rejects.toThrow(/inspected event state changed/);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM task_instances WHERE event_id = ?",
      )
        .bind(fixture.eventId)
        .first(),
    ).toMatchObject({ count: 0 });
  });

  it("refuses an organiser revoked from another event even when they remain an active speaker", async () => {
    const fixture = await seedReadinessAcceptanceEvent(
      runtime,
      organiser,
      "success",
    );
    const personId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO people (id, email, display_name) VALUES (?, ?, 'Venue organiser')",
      ).bind(personId, `${personId}@example.com`),
      env.DB.prepare(
        "INSERT INTO memberships (id, organisation_id, person_id, role, accepted_at) VALUES (?, ?, ?, 'administrator', unixepoch())",
      ).bind(membershipId, organiser.organisationId, personId),
      env.DB.prepare(
        "INSERT INTO session_speakers (session_id, event_id, person_id, position, participation_status, participation_confirmed_at) SELECT id, event_id, ?, 0, 'confirmed', unixepoch() FROM sessions WHERE event_id = ? LIMIT 1",
      ).bind(personId, fixture.eventId),
    ]);
    try {
      const generated = await runDemonstrationReadinessScenario(
        runtime,
        organiser,
        "success",
        READINESS_ACCEPTANCE_PROMPT,
        fixture,
      );
      expect(generated.error).toBeNull();
      const edited = await new AiAssistantService(runtime).reviewTaskProposal(
        fixture.viewer,
        generated.result?.proposals[0].id,
        {
          decision: "edit",
          title: "Coordinate the venue room change",
          description: "Coordinate resolution of the evidenced room collision.",
          ownerPersonId: personId,
        },
      );
      const cursor = () =>
        env.DB.prepare(
          "SELECT COALESCE(MAX(sequence), 0) AS cursor FROM event_changes WHERE event_id = ?",
        )
          .bind(fixture.eventId)
          .first<{ cursor: number }>();
      const before = await cursor();
      const service = new AiAssistantService(runtime, {
        beforeProposalMutation: async () => {
          await new EventService(runtime).revokeAdministrator(
            { ...organiser, personId: "person-demo-owner", role: "owner" },
            { membershipId },
          );
        },
      });
      await expect(
        service.approveProposal(
          fixture.viewer,
          edited.replacementProposalId,
          true,
        ),
      ).rejects.toThrow(/owner or inspected event state changed/);
      expect(await cursor()).toEqual(before);
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM session_speakers WHERE event_id = ? AND person_id = ? AND participation_status = 'confirmed'",
        )
          .bind(fixture.eventId, personId)
          .first(),
      ).toMatchObject({ count: 1 });
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM task_instances WHERE event_id = ?",
        )
          .bind(fixture.eventId)
          .first(),
      ).toMatchObject({ count: 0 });
      expect(
        await new AiAssistantService(runtime).listRecentProposals(
          fixture.viewer,
        ),
      ).toEqual([]);
      const [report] = await listAssistantRunReports(runtime, fixture.viewer);
      expect(report.proposals).toContainEqual(
        expect.objectContaining({
          id: edited.replacementProposalId,
          review: "stale",
          execution: "failed",
        }),
      );
    } finally {
      await env.DB.prepare("DELETE FROM memberships WHERE id = ?")
        .bind(membershipId)
        .run();
    }
  });

  it("recovers a created task after interrupted settlement without treating its new work as stale", async () => {
    const fixture = await runDemonstrationReadinessScenario(
      runtime,
      organiser,
      "success",
    );
    const service = new AiAssistantService(runtime, {
      beforeProposalExecutionCommit: () => {
        throw new Error("Interrupted settlement");
      },
    });
    await expect(
      service.approveProposal(
        fixture.viewer,
        fixture.result?.proposals[0].id,
        true,
      ),
    ).rejects.toThrow("Interrupted settlement");
    const [interrupted] = await listAssistantRunReports(
      runtime,
      fixture.viewer,
    );
    expect(interrupted.proposals[0]).toMatchObject({
      execution: "completed",
      settlement: "pending",
      taskId: expect.any(String),
    });
    expect(interrupted.proposals[0].failure).toBeUndefined();
    const contextAfterCreation = await loadReadinessTaskContext(
      runtime,
      fixture.viewer,
      await new ReadinessService(runtime).getCommandCentre(fixture.viewer),
    );
    expect(contextAfterCreation?.existingWork).toHaveLength(1);
    const recovered = await new AiAssistantService(runtime).approveProposal(
      fixture.viewer,
      fixture.result?.proposals[0].id,
      true,
    );
    expect(recovered.kind).toBe("task");
    const [settled] = await listAssistantRunReports(runtime, fixture.viewer);
    expect(settled.proposals[0]).toMatchObject({
      execution: "completed",
      settlement: "completed",
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM task_instances WHERE event_id = ?",
      )
        .bind(fixture.eventId)
        .first(),
    ).toMatchObject({ count: 1 });
  });
});

describe("inference measurement", () => {
  it("estimates only complete usage with explicit dated rates and keeps missing totals unknown", () => {
    const prices = readInferencePricing(
      JSON.stringify([
        {
          provider: "OpenAI",
          model: "fixture",
          source: "https://example.invalid/test-pricing",
          asOf: "2026-10-19",
          inputUsdPerMillion: 2,
          outputUsdPerMillion: 8,
          cachedInputUsdPerMillion: 1,
        },
      ]),
    );
    const call = measureModelCall({
      attemptId: "a",
      provider: "OpenAI",
      requestedModel: "fixture",
      durationMs: 120,
      response: {
        id: "r",
        model: "fixture",
        status: "completed",
        output: [],
        usage: {
          input_tokens: 1000,
          output_tokens: 100,
          input_tokens_details: { cached_tokens: 200, cache_write_tokens: 0 },
        },
      },
      prices,
    });
    expect(call.estimatedCostUsd).toBeCloseTo(0.0026);
    const writeResponse = {
      id: "write",
      model: "fixture",
      status: "completed" as const,
      output: [],
      usage: {
        input_tokens: 1000,
        output_tokens: 100,
        input_tokens_details: { cached_tokens: 200, cache_write_tokens: 100 },
      },
    };
    expect(
      measureModelCall({
        attemptId: "write",
        provider: "OpenAI",
        requestedModel: "fixture",
        durationMs: 1,
        response: writeResponse,
        prices,
      }).estimatedCostUsd,
    ).toBeNull();
    expect(
      measureModelCall({
        attemptId: "write-priced",
        provider: "OpenAI",
        requestedModel: "fixture",
        durationMs: 1,
        response: writeResponse,
        prices: [{ ...prices[0], cacheWriteInputUsdPerMillion: 5 }],
      }).estimatedCostUsd,
    ).toBeCloseTo(0.0029);
    const missingWriteUsage = {
      ...writeResponse,
      usage: {
        ...writeResponse.usage,
        input_tokens_details: { cached_tokens: 200 },
      },
    };
    const sameRate = measureModelCall({
      attemptId: "equal-write-rate",
      provider: "OpenAI",
      requestedModel: "fixture",
      durationMs: 1,
      response: missingWriteUsage,
      prices: [{ ...prices[0], cacheWriteInputUsdPerMillion: 2 }],
    });
    expect(sameRate.estimatedCostUsd).toBeCloseTo(0.0026);
    expect(sameRate.usage.cacheWriteInputTokens).toBeNull();
    expect(
      measureModelCall({
        attemptId: "unknown-write-rate",
        provider: "OpenAI",
        requestedModel: "fixture",
        durationMs: 1,
        response: missingWriteUsage,
        prices,
      }).estimatedCostUsd,
    ).toBeNull();
    expect(call.usage.totalTokens).toBeNull();
    const failed = measureModelCall({
      attemptId: "b",
      provider: "OpenAI",
      requestedModel: "fixture",
      durationMs: 250,
      failure: "Timeout",
      prices,
    });
    expect(aggregateModelCalls([call, failed])).toMatchObject({
      inputTokens: null,
      outputTokens: null,
      estimatedCostUsd: null,
      knownEstimatedCostUsd: call.estimatedCostUsd,
      callsWithUnknownCost: 1,
    });
    expect(() => readInferencePricing("bad configuration")).toThrow(
      /AI_INFERENCE_PRICING/,
    );
  });
});

describe("provider usage normalisation", () => {
  const input = {
    instructions: "Inspect recorded evidence",
    input: "Readiness",
    safetyIdentifier: "acceptance-fixture",
  };
  it("retains usage from a completed OpenAI stream and an incomplete response", async () => {
    const response = {
      id: "usage-response",
      model: "fixture",
      status: "completed",
      output: [],
      output_text: "Recorded answer",
      usage: {
        input_tokens: 40,
        output_tokens: 10,
        total_tokens: 50,
        input_tokens_details: { cached_tokens: 5, cache_write_tokens: 8 },
        output_tokens_details: { reasoning_tokens: 2 },
      },
    };
    const provider = new OpenAiResponsesProvider(
      {
        apiKey: "explicit-test-key-with-more-than-twenty-characters",
        model: "fixture",
      },
      async () =>
        new Response(
          `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    expect(
      (await provider.create({ ...input, onTextDelta: () => {} })).usage,
    ).toEqual(response.usage);
    const incomplete = new OpenAiResponsesProvider(
      {
        apiKey: "explicit-test-key-with-more-than-twenty-characters",
        model: "fixture",
      },
      async () => Response.json({ ...response, status: "incomplete" }),
    );
    try {
      await incomplete.create(input);
      throw new Error("Expected incomplete failure");
    } catch (error) {
      expect(error).toBeInstanceOf(AiProviderError);
      expect((error as AiProviderError).response?.usage).toEqual(
        response.usage,
      );
    }
  });
  it("merges Anthropic streaming usage without inventing missing totals", async () => {
    const events = [
      {
        type: "message_start",
        message: {
          id: "anthropic-usage",
          model: "fixture",
          usage: {
            input_tokens: 80,
            cache_read_input_tokens: 20,
            cache_creation_input_tokens: 0,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "Recorded answer" },
      },
      { type: "message_delta", usage: { output_tokens: 25 } },
      { type: "message_stop" },
    ];
    const provider = new AnthropicMessagesProvider(
      { apiKey: "explicit-test-key-with-more-than-twenty-characters" },
      "fixture",
      async () =>
        new Response(
          events
            .map(
              (event) =>
                `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
            )
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    const response = await provider.create({ ...input, onTextDelta: () => {} });
    expect(response.usage).toMatchObject({
      input_tokens: 100,
      output_tokens: 25,
      input_tokens_details: {
        cached_tokens: 20,
        cache_write_tokens: 0,
        uncached_tokens: 80,
      },
    });
    expect(response.usage?.total_tokens).toBeUndefined();
  });
  it("retains observed Anthropic usage when a stream fails or ends early", async () => {
    for (const terminal of [
      { type: "error", error: { message: "Injected stream failure" } },
      null,
    ]) {
      const events = [
        {
          type: "message_start",
          message: {
            id: "partial-usage",
            model: "fixture",
            usage: {
              input_tokens: 80,
              cache_read_input_tokens: 20,
              cache_creation_input_tokens: 0,
            },
          },
        },
        { type: "message_delta", usage: { output_tokens: 25 } },
        ...(terminal ? [terminal] : []),
      ];
      const provider = new AnthropicMessagesProvider(
        { apiKey: "explicit-test-key-with-more-than-twenty-characters" },
        "fixture",
        async () =>
          new Response(
            events
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join(""),
          ),
      );
      const failure = await provider
        .create({ ...input, onTextDelta: () => {} })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AiProviderError);
      expect((failure as AiProviderError).response).toMatchObject({
        id: "partial-usage",
        model: "fixture",
        status: "failed",
        usage_is_partial: true,
        output: [],
        usage: {
          input_tokens: 100,
          output_tokens: 25,
          input_tokens_details: {
            cached_tokens: 20,
            cache_write_tokens: 0,
            uncached_tokens: 80,
          },
        },
      });
      const measurement = measureModelCall({
        attemptId: "interrupted-stream",
        provider: "Anthropic",
        requestedModel: "fixture",
        durationMs: 1,
        response: (failure as AiProviderError).response,
        failure: "Interrupted stream",
        prices: [
          {
            provider: "Anthropic",
            model: "fixture",
            source: "https://example.test/prices",
            asOf: "2026-10-19",
            inputUsdPerMillion: 2,
            outputUsdPerMillion: 3,
            cachedInputUsdPerMillion: 1,
            cacheWriteInputUsdPerMillion: 2,
          },
        ],
      });
      expect(measurement.usage.outputTokens).toBe(25);
      expect(measurement.usageIsPartial).toBe(true);
      expect(measurement.estimatedCostUsd).toBeNull();
      expect(aggregateModelCalls([measurement])).toMatchObject({
        inputTokens: null,
        outputTokens: null,
        estimatedCostUsd: null,
      });
    }
  });
  it("normalises Workers AI chat usage and retains genuinely absent categories as unknown", async () => {
    const provider = new WorkersAiProvider(
      {
        aiGatewayLogId: null,
        run: async () => ({
          id: "worker-usage",
          model: WORKERS_AI_MODEL,
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: { role: "assistant", content: "Recorded answer" },
            },
          ],
          usage: {
            prompt_tokens: 90,
            completion_tokens: 10,
            total_tokens: 100,
          },
        }),
      },
      WORKERS_AI_MODEL,
    );
    const response = await provider.create(input);
    expect(response.usage).toMatchObject({
      input_tokens: 90,
      output_tokens: 10,
      total_tokens: 100,
    });
    const call = measureModelCall({
      attemptId: "usage",
      provider: "Workers AI",
      requestedModel: WORKERS_AI_MODEL,
      durationMs: 1,
      response,
      prices: [],
    });
    expect(call.usage.cachedInputTokens).toBeNull();
    expect(call.estimatedCostUsd).toBeNull();
  });
  it("retains returned Workers AI usage when the completion budget rejects the answer", async () => {
    const fixture = await seedReadinessAcceptanceEvent(
      runtime,
      organiser,
      "success",
    );
    await env.DB.prepare(
      "UPDATE organisation_ai_settings SET provider = 'workers_ai', model = ? WHERE organisation_id = ?",
    )
      .bind(WORKERS_AI_MODEL, organiser.organisationId)
      .run();
    let reasoningEffort: unknown;
    const service = new AiAssistantService({
      ...runtime,
      AI: {
        aiGatewayLogId: null,
        run: async (_model: string, request: Record<string, unknown>) => {
          reasoningEffort = request.reasoning_effort;
          return {
            id: "workers-budget-exhausted",
            model: WORKERS_AI_MODEL,
            choices: [
              {
                index: 0,
                finish_reason: "length",
                message: { role: "assistant", content: "Incomplete answer" },
              },
            ],
            usage: {
              prompt_tokens: 90,
              completion_tokens: 4000,
              total_tokens: 4090,
            },
          };
        },
      } as unknown as Ai,
    });
    await expect(
      service.ask(fixture.viewer, READINESS_ACCEPTANCE_PROMPT),
    ).rejects.toThrow(/completion-token budget/);
    const [report] = await listAssistantRunReports(runtime, fixture.viewer);
    expect(reasoningEffort).toBe("none");
    expect(
      report.history.find((item) => item.action === "assistant.model.requested")
        ?.details.configuration.reasoningEffort,
    ).toBe("none");
    expect(report.status).toBe("failed");
    expect(report.proposals).toEqual([]);
    expect(report.measurements?.totals).toMatchObject({
      callCount: 1,
      inputTokens: 90,
      outputTokens: 4000,
      estimatedCostUsd: null,
    });
    expect(
      report.history.find((item) => item.action === "assistant.model.failed")
        ?.details,
    ).toMatchObject({
      status: "failed",
      responseId: "workers-budget-exhausted",
    });
  });
});
