import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { AiAssistantService } from "~/modules/ai/ai-assistant-service.server";
import { assistantProposalMetadataSchema } from "~/modules/ai/ai-tools.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { DEMO_ASSISTANT_FIXTURE_MODEL } from "~/platform/demo/demo-identities";
import { ensureDemoData } from "./seed.server";
import {
  DEMO_EVENT_ID,
  DEMO_ORGANISATION_ID,
  DEMO_R2_PREFIX,
  DEMO_RESET_CONFIRMATION,
  DEMO_RESET_EVENT_TABLES,
  DemoResetBusyError,
  DemoResetRetentionError,
  DemoResetUnavailableError,
  ensureJudgedDemoWorkflow,
  resetDemoEvent,
} from "./demo-reset.server";

function demoEnvironment(overrides: Partial<CloudflareEnvironment> = {}) {
  return {
    ...(env as unknown as CloudflareEnvironment),
    APP_ENV: "demo",
    DEMO_MODE: "true",
    DEFAULT_EVENT_ID: DEMO_EVENT_ID,
    ...overrides,
  } as CloudflareEnvironment;
}

const demoAdministrator: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: DEMO_ORGANISATION_ID,
  eventId: DEMO_EVENT_ID,
  demo: true,
};

function taskProposalMetadata(proposalId: string, model: string) {
  return assistantProposalMetadataSchema.parse({
    version: 1,
    toolName: "propose_task",
    runId: crypto.randomUUID(),
    model,
    arguments: {
      title: "Confirm venue accessibility handoff",
      description: "Confirm the documented handoff with the venue team.",
      targetType: "event",
      targetId: DEMO_EVENT_ID,
      ownerPersonId: null,
      taskType: "administrator_only",
      impact: "high",
      dueAt: null,
      dependencyIds: [],
    },
    preview: {
      id: proposalId,
      toolName: "propose_task",
      title: "Confirm venue accessibility handoff",
      summary: "Create one administrator task for the demo event.",
      consequence: "Approval creates one durable event task.",
      changes: [
        {
          field: "Task",
          before: null,
          after: "Confirm venue accessibility handoff",
        },
      ],
      approvalRequired: true,
    },
  });
}

describe("complete evaluator demo reset", () => {
  it("keeps the cleanup inventory aligned with every event-owned table except append-only audit", async () => {
    const tables = await env.DB.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all<{ name: string }>();
    const eventTables: string[] = [];
    for (const { name } of tables.results) {
      if (!/^[a-z][a-z0-9_]*$/u.test(name)) continue;
      const columns = await env.DB.prepare(`PRAGMA table_info(${name})`).all<{
        name: string;
      }>();
      if (columns.results.some((column) => column.name === "event_id")) {
        eventTables.push(name);
      }
    }
    expect(eventTables.sort()).toEqual(
      [...DEMO_RESET_EVENT_TABLES, "audit_events"].sort(),
    );
  });

  it("clears only the demo R2 prefix, preserves audit history and restores the judged D1 baseline", async () => {
    const testEnvironment = demoEnvironment();
    await ensureJudgedDemoWorkflow(testEnvironment);
    await testEnvironment.DB.batch([
      testEnvironment.DB.prepare(
        "UPDATE events SET name = 'Evaluator changed this', brand_accent = '#123456' WHERE id = ?",
      ).bind(DEMO_EVENT_ID),
      testEnvironment.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         ) VALUES ('demo-reset-preserved-audit', ?, ?, 'person-demo-admin',
                   'test.sentinel', 'event', ?, '{}', unixepoch())
         ON CONFLICT(id) DO NOTHING`,
      ).bind(DEMO_ORGANISATION_ID, DEMO_EVENT_ID, DEMO_EVENT_ID),
      testEnvironment.DB.prepare(
        `INSERT INTO assistant_proposal_executions (
           proposal_id, organisation_id, event_id, actor_person_id, tool_name,
           status, result_json, created_at, updated_at, completed_at
         ) VALUES ('demo-reset-stale-assistant-execution', ?, ?,
                   'person-demo-admin', 'propose_task', 'completed', '{}',
                   unixepoch(), unixepoch(), unixepoch())`,
      ).bind(DEMO_ORGANISATION_ID, DEMO_EVENT_ID),
      testEnvironment.DB.prepare(
        `UPDATE schedule_session_contents
            SET title = 'Demo reset stale session content',
                updated_at = unixepoch()
          WHERE schedule_version_id = 'demo-schedule-published'
            AND event_id = ? AND session_id = 'demo-session-1'`,
      ).bind(DEMO_EVENT_ID),
    ]);
    await testEnvironment.FILES.put(`${DEMO_R2_PREFIX}old/slides.pdf`, "old");
    await testEnvironment.FILES.put(
      "private/events/another-event/keep.pdf",
      "keep",
    );

    const reset = await resetDemoEvent(
      testEnvironment,
      "person-demo-admin",
      DEMO_RESET_CONFIRMATION,
    );

    expect(reset.objectCount).toBe(1);
    expect(reset.baseline).toMatchObject({
      submissions: 2,
      assignments: 2,
      publishedSchedules: 1,
      publishedTemplates: 1,
    });
    await expect(
      testEnvironment.FILES.head(`${DEMO_R2_PREFIX}old/slides.pdf`),
    ).resolves.toBeNull();
    await expect(
      testEnvironment.FILES.head("private/events/another-event/keep.pdf"),
    ).resolves.not.toBeNull();
    const event = await testEnvironment.DB.prepare(
      "SELECT name, brand_accent AS accent, repository_provider AS provider FROM events WHERE id = ?",
    )
      .bind(DEMO_EVENT_ID)
      .first<{ name: string; accent: string; provider: string }>();
    expect(event).toEqual({
      name: "Future of Events 2025",
      accent: "#4f46e5",
      provider: "d1",
    });
    await expect(
      testEnvironment.DB.prepare(
        "SELECT proposal_id FROM assistant_proposal_executions WHERE proposal_id = 'demo-reset-stale-assistant-execution'",
      ).first(),
    ).resolves.toBeNull();
    await expect(
      testEnvironment.DB.prepare(
        `SELECT title FROM schedule_session_contents
          WHERE schedule_version_id = 'demo-schedule-published'
            AND event_id = ? AND session_id = 'demo-session-1'`,
      )
        .bind(DEMO_EVENT_ID)
        .first<{ title: string }>(),
    ).resolves.toEqual({ title: "The Future of Attendee Engagement" });
    const audits = await testEnvironment.DB.prepare(
      "SELECT action FROM audit_events WHERE id = 'demo-reset-preserved-audit' OR action = 'demo.reset' ORDER BY created_at",
    ).all<{ action: string }>();
    expect(audits.results.map((row) => row.action)).toEqual(
      expect.arrayContaining(["test.sentinel", "demo.reset"]),
    );
  });

  it("tombstones only stale demo assistant fixture proposals while preserving their audits", async () => {
    const testEnvironment = demoEnvironment();
    await ensureJudgedDemoWorkflow(testEnvironment);
    const fixtureProposalId = crypto.randomUUID();
    const ordinaryProposalId = crypto.randomUUID();
    await testEnvironment.DB.batch([
      testEnvironment.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         ) VALUES (?, ?, ?, ?, 'assistant.proposal.previewed',
                   'assistant_proposal', ?, ?, ?, unixepoch())`,
      ).bind(
        crypto.randomUUID(),
        DEMO_ORGANISATION_ID,
        DEMO_EVENT_ID,
        demoAdministrator.personId,
        fixtureProposalId,
        crypto.randomUUID(),
        JSON.stringify(
          taskProposalMetadata(
            fixtureProposalId,
            DEMO_ASSISTANT_FIXTURE_MODEL,
          ),
        ),
      ),
      testEnvironment.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         ) VALUES (?, ?, ?, ?, 'assistant.proposal.previewed',
                   'assistant_proposal', ?, ?, ?, unixepoch())`,
      ).bind(
        crypto.randomUUID(),
        DEMO_ORGANISATION_ID,
        DEMO_EVENT_ID,
        demoAdministrator.personId,
        ordinaryProposalId,
        crypto.randomUUID(),
        JSON.stringify(taskProposalMetadata(ordinaryProposalId, "gpt-5.6")),
      ),
    ]);

    const reset = await resetDemoEvent(
      testEnvironment,
      demoAdministrator.personId,
      DEMO_RESET_CONFIRMATION,
    );

    expect(reset.supersededAssistantFixtureProposals).toBe(1);
    await expect(
      resetDemoEvent(
        testEnvironment,
        demoAdministrator.personId,
        DEMO_RESET_CONFIRMATION,
      ),
    ).resolves.toMatchObject({ supersededAssistantFixtureProposals: 0 });
    const fixtureAudits = await testEnvironment.DB.prepare(
      `SELECT action, metadata_json AS metadataJson
         FROM audit_events
        WHERE event_id = ? AND entity_type = 'assistant_proposal'
          AND entity_id = ?
        ORDER BY created_at, id`,
    )
      .bind(DEMO_EVENT_ID, fixtureProposalId)
      .all<{ action: string; metadataJson: string }>();
    expect(fixtureAudits.results).toHaveLength(2);
    expect(fixtureAudits.results.map(({ action }) => action)).toEqual(
      expect.arrayContaining([
        "assistant.proposal.previewed",
        "assistant.proposal.superseded",
      ]),
    );
    const tombstone = fixtureAudits.results.find(
      ({ action }) => action === "assistant.proposal.superseded",
    );
    expect(
      JSON.parse(tombstone?.metadataJson ?? "{}"),
    ).toMatchObject({
      proposalId: fixtureProposalId,
      reason: "demo_fixture_reset",
      fixtureModel: DEMO_ASSISTANT_FIXTURE_MODEL,
    });
    await expect(
      testEnvironment.DB.prepare(
        `SELECT action FROM audit_events
          WHERE event_id = ? AND entity_type = 'assistant_proposal'
            AND entity_id = ? AND action = 'assistant.proposal.superseded'`,
      )
        .bind(DEMO_EVENT_ID, ordinaryProposalId)
        .first(),
    ).resolves.toBeNull();
    const recent = await new AiAssistantService(
      testEnvironment,
    ).listRecentProposals(demoAdministrator);
    expect(recent.map(({ id }) => id)).not.toContain(fixtureProposalId);
    expect(recent.map(({ id }) => id)).toContain(ordinaryProposalId);
  });

  it("deletes routed submissions before their evaluation teams", async () => {
    const testEnvironment = demoEnvironment();
    await ensureJudgedDemoWorkflow(testEnvironment);
    await testEnvironment.DB.batch([
      testEnvironment.DB.prepare(
        `INSERT INTO evaluation_teams (
           id, event_id, name, description, status, created_at, updated_at
         ) VALUES (
           'demo-reset-routed-team', ?, 'Reset routing sentinel',
           'Exercises the restrictive submissions routing foreign key.',
           'active', unixepoch(), unixepoch()
         )`,
      ).bind(DEMO_EVENT_ID),
      testEnvironment.DB.prepare(
        `UPDATE submissions
            SET routed_team_id = 'demo-reset-routed-team'
          WHERE id = 'demo-evaluation-submission-calm' AND event_id = ?`,
      ).bind(DEMO_EVENT_ID),
    ]);

    await expect(
      resetDemoEvent(
        testEnvironment,
        "person-demo-admin",
        DEMO_RESET_CONFIRMATION,
      ),
    ).resolves.toMatchObject({
      baseline: { submissions: 2, assignments: 2 },
    });
    await expect(
      testEnvironment.DB.prepare(
        "SELECT id FROM evaluation_teams WHERE id = 'demo-reset-routed-team'",
      ).first(),
    ).resolves.toBeNull();
    await expect(
      testEnvironment.DB.prepare(
        `SELECT routed_team_id AS routedTeamId
           FROM submissions
          WHERE id = 'demo-evaluation-submission-calm' AND event_id = ?`,
      )
        .bind(DEMO_EVENT_ID)
        .first<{ routedTeamId: string | null }>(),
    ).resolves.toEqual({ routedTeamId: null });
  });

  it("refuses non-terminal work before changing D1 or R2", async () => {
    const testEnvironment = demoEnvironment();
    await ensureDemoData(testEnvironment);
    const suffix = crypto.randomUUID();
    await testEnvironment.DB.prepare(
      `INSERT INTO operation_jobs (
         id, organisation_id, event_id, requested_by_person_id, type,
         idempotency_key, correlation_id, status, payload_json,
         progress_total, progress_completed, progress_failed,
         created_at, updated_at
       ) VALUES (?, ?, ?, 'person-demo-admin', 'demo.test', ?, ?, 'running', '{}',
                 1, 0, 0, unixepoch(), unixepoch())`,
    )
      .bind(
        `demo-active-${suffix}`,
        DEMO_ORGANISATION_ID,
        DEMO_EVENT_ID,
        `demo-active-${suffix}`,
        `demo-active-${suffix}`,
      )
      .run();
    const objectKey = `${DEMO_R2_PREFIX}active/file.txt`;
    await testEnvironment.FILES.put(objectKey, "active");

    await expect(
      resetDemoEvent(
        testEnvironment,
        "person-demo-admin",
        DEMO_RESET_CONFIRMATION,
      ),
    ).rejects.toMatchObject({
      name: DemoResetBusyError.name,
      activeWork: { operations: 1 },
    });
    await expect(testEnvironment.FILES.head(objectKey)).resolves.not.toBeNull();
    await expect(
      testEnvironment.DB.prepare(
        "SELECT status FROM operation_jobs WHERE id = ?",
      )
        .bind(`demo-active-${suffix}`)
        .first<{ status: string }>(),
    ).resolves.toEqual({ status: "running" });

    await testEnvironment.DB.prepare(
      "UPDATE operation_jobs SET status = 'failed' WHERE id = ?",
    )
      .bind(`demo-active-${suffix}`)
      .run();
    await resetDemoEvent(
      testEnvironment,
      "person-demo-admin",
      DEMO_RESET_CONFIRMATION,
    );
  });

  it("cannot run under production runtime settings", async () => {
    await expect(
      resetDemoEvent(
        demoEnvironment({ APP_ENV: "production", DEMO_MODE: "false" }),
        "person-demo-admin",
        DEMO_RESET_CONFIRMATION,
      ),
    ).rejects.toBeInstanceOf(DemoResetUnavailableError);
  });

  it("fails before D1 mutation when the required private-file binding is absent", async () => {
    const testEnvironment = demoEnvironment();
    await ensureDemoData(testEnvironment);
    await testEnvironment.DB.prepare(
      "UPDATE events SET name = 'Binding failure sentinel' WHERE id = ?",
    )
      .bind(DEMO_EVENT_ID)
      .run();
    await expect(
      resetDemoEvent(
        {
          ...testEnvironment,
          FILES: undefined,
        } as unknown as CloudflareEnvironment,
        "person-demo-admin",
        DEMO_RESET_CONFIRMATION,
      ),
    ).rejects.toThrow("Required Cloudflare binding FILES is unavailable");
    await expect(
      testEnvironment.DB.prepare("SELECT name FROM events WHERE id = ?")
        .bind(DEMO_EVENT_ID)
        .first<{ name: string }>(),
    ).resolves.toEqual({ name: "Binding failure sentinel" });
    await resetDemoEvent(
      testEnvironment,
      "person-demo-admin",
      DEMO_RESET_CONFIRMATION,
    );
  });

  it("does not clear an irreversible participant-retention tombstone", async () => {
    const testEnvironment = demoEnvironment();
    await ensureDemoData(testEnvironment);
    const objectKey = `${DEMO_R2_PREFIX}retained/file.txt`;
    await testEnvironment.FILES.put(objectKey, "retained");
    await testEnvironment.DB.prepare(
      `UPDATE events SET participant_retention_completed_at = unixepoch()
        WHERE id = ? AND organisation_id = ?`,
    )
      .bind(DEMO_EVENT_ID, DEMO_ORGANISATION_ID)
      .run();

    await expect(
      resetDemoEvent(
        testEnvironment,
        "person-demo-admin",
        DEMO_RESET_CONFIRMATION,
      ),
    ).rejects.toBeInstanceOf(DemoResetRetentionError);
    await expect(testEnvironment.FILES.head(objectKey)).resolves.not.toBeNull();
    await expect(
      testEnvironment.DB.prepare(
        `UPDATE events SET participant_retention_completed_at = NULL
          WHERE id = ?`,
      )
        .bind(DEMO_EVENT_ID)
        .run(),
    ).rejects.toThrow("retention completion is immutable");
  });
});
