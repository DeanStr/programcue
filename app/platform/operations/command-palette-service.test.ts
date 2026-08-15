import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
import { CANONICAL_EVENT_FILE_POLICY_JSON } from "~/modules/files/file-policy";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";

import { CommandPaletteService } from "./command-palette-service.server";

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

describe("command palette record search", () => {
  beforeEach(async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM integration_runs WHERE id = 'command-search-run'",
      ),
      env.DB.prepare(
        "DELETE FROM integration_connections WHERE id = 'command-search-connection'",
      ),
      env.DB.prepare(
        "DELETE FROM operation_jobs WHERE id = 'command-search-operation'",
      ),
      env.DB.prepare(
        "DELETE FROM resource_pages WHERE id = 'command-search-resource'",
      ),
      env.DB.prepare("DELETE FROM tracks WHERE id = 'command-search-track'"),
      env.DB.prepare(
        `INSERT INTO tracks (
           id,event_id,name,slug,colour_token,position,exclusive,is_public
         ) VALUES ('command-search-track',?,'Command Search Stream',
                   'command-search-stream','#0f766e',99,0,1)`,
      ).bind(viewer.eventId),
      env.DB.prepare(
        `INSERT INTO resource_pages (
           id,event_id,title,slug,category,status,audience_scope,
           acknowledgement_required,revision,created_by_person_id
         ) VALUES ('command-search-resource',?,'Speaker briefing guide',
                   'speaker-briefing-guide','Preparation','draft',
                   'all_speakers',0,1,?)`,
      ).bind(viewer.eventId, viewer.personId),
      env.DB.prepare(
        `INSERT INTO integration_connections (
           id,organisation_id,event_id,provider,status,direction,configuration_json
         ) VALUES ('command-search-connection',?,?,'accelevents','connected',
                   'outbound','{}')`,
      ).bind(viewer.organisationId, viewer.eventId),
      env.DB.prepare(
        `INSERT INTO operation_jobs (
           id,organisation_id,event_id,requested_by_person_id,type,
           idempotency_key,correlation_id,status,payload_json
         ) VALUES ('command-search-operation',?,?,?,
                   'integration.accelevents.export','command-search-operation',
                   'command-search-correlation','failed','{}')`,
      ).bind(viewer.organisationId, viewer.eventId, viewer.personId),
      env.DB.prepare(
        `INSERT INTO integration_runs (
           id,connection_id,operation_id,idempotency_key,status,direction,
           dry_run,summary_json
         ) VALUES ('command-search-run','command-search-connection',
                   'command-search-operation','command-search-run','failed',
                   'outbound',0,'{}')`,
      ),
    ]);
  });

  it("uses domain aliases to find rooms, tracks, resources and operations", async () => {
    const service = new CommandPaletteService(
      env as unknown as CloudflareEnvironment,
    );

    await expect(
      service.search(viewer, { query: "venue main stage", scope: "event" }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        id: "main",
        kind: "room",
        href: "/admin/event?room=main",
      }),
    );
    await expect(
      service.search(viewer, {
        query: "stream command search",
        scope: "event",
      }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        id: "command-search-track",
        kind: "track",
        href: "/admin/event?track=command-search-track",
      }),
    );
    await expect(
      service.search(viewer, {
        query: "wiki speaker briefing",
        scope: "event",
      }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        id: "command-search-resource",
        kind: "resource",
        href: "/admin/resources?resource=command-search-resource",
      }),
    );
    await expect(
      service.search(viewer, { query: "job accelevents", scope: "event" }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        id: "command-search-operation",
        kind: "operation",
        href: "/admin/operations?operation=command-search-operation",
      }),
    );
    await expect(
      service.search(viewer, {
        query: "integration command-search-run",
        scope: "event",
      }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        id: "command-search-operation",
        kind: "operation",
      }),
    );
  });

  it("humanises enum descriptions without rewriting record data", async () => {
    const token = crypto.randomUUID();
    const personId = `command-humanisation-person-${token}`;
    const sessionId = `command-humanisation-session-${token}`;
    const taskId = `command-humanisation-task-${token}`;
    const email = `speaker_name_${token}@example.com`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO people (
           id,email,display_name,email_verified,profile_status
         ) VALUES (?,?,'Underscore Speaker',1,'published')`,
      ).bind(personId, email),
      env.DB.prepare(
        `INSERT INTO memberships (
           id,organisation_id,event_id,person_id,role,invited_at,accepted_at
         ) VALUES (?,?,?,?, 'speaker',unixepoch(),unixepoch())`,
      ).bind(
        `command-humanisation-membership-${token}`,
        viewer.organisationId,
        viewer.eventId,
        personId,
      ),
      env.DB.prepare(
        `INSERT INTO sessions (
           id,event_id,title,slug,format,duration_minutes,status
         ) VALUES (?,?,'Humanisation session',?,'fireside_chat',30,
                   'unscheduled')`,
      ).bind(sessionId, viewer.eventId, `humanisation_session_${token}`),
      env.DB.prepare(
        `INSERT INTO task_instances (
           id,event_id,target_type,target_id,title,impact,status
         ) VALUES (?,?,'event',?,'Humanisation task','medium','not_started')`,
      ).bind(taskId, viewer.eventId, viewer.eventId),
    ]);
    const service = new CommandPaletteService(
      env as unknown as CloudflareEnvironment,
    );

    await expect(
      service.search(viewer, { query: "Underscore Speaker", scope: "event" }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        id: personId,
        kind: "speaker",
        description: email,
      }),
    );
    await expect(
      service.search(viewer, { query: "Humanisation session", scope: "event" }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        id: sessionId,
        kind: "session",
        description: "unscheduled · fireside chat",
      }),
    );
    await expect(
      service.search(viewer, { query: "Humanisation task", scope: "event" }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        id: taskId,
        kind: "task",
        description: "not started · medium",
      }),
    );
  });

  it("returns one operation when several communications share it", async () => {
    const token = crypto.randomUUID();
    const operationId = `command-communication-operation-${token}`;
    const firstCommunicationId = `command-communication-first-${token}`;
    const secondCommunicationId = `command-communication-second-${token}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO operation_jobs (
           id,organisation_id,event_id,requested_by_person_id,type,
           idempotency_key,correlation_id,status,payload_json
         ) VALUES (?,?,?,?,'communication.send',?,?,'queued','{}')`,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        operationId,
        operationId,
      ),
      env.DB.prepare(
        `INSERT INTO communications (
           id,event_id,operation_id,idempotency_key,status,audience_json,
           content_snapshot_json
         ) VALUES (?,?,?,?,'queued','{}',?)`,
      ).bind(
        firstCommunicationId,
        viewer.eventId,
        operationId,
        firstCommunicationId,
        JSON.stringify({ subjectTemplate: `Shared briefing ${token} A` }),
      ),
      env.DB.prepare(
        `INSERT INTO communications (
           id,event_id,operation_id,idempotency_key,status,audience_json,
           content_snapshot_json
         ) VALUES (?,?,?,?,'queued','{}',?)`,
      ).bind(
        secondCommunicationId,
        viewer.eventId,
        operationId,
        secondCommunicationId,
        JSON.stringify({ subjectTemplate: `Shared briefing ${token} B` }),
      ),
    ]);

    const records = await new CommandPaletteService(
      env as unknown as CloudflareEnvironment,
    ).search(viewer, {
      query: `communication Shared briefing ${token}`,
      scope: "event",
    });

    expect(records.filter((record) => record.id === operationId)).toHaveLength(
      1,
    );
    await expect(
      new CommandPaletteService(env as unknown as CloudflareEnvironment).search(
        viewer,
        {
          query: `communication ${secondCommunicationId}`,
          scope: "event",
        },
      ),
    ).resolves.toContainEqual(expect.objectContaining({ id: operationId }));
  });

  it("narrows communication and integration aliases to their operation family", async () => {
    const token = crypto.randomUUID();
    const communicationOperationId = `command-family-communication-${token}`;
    const communicationId = `command-family-message-${token}`;
    const decisionNotificationId = `command-family-decision-${token}`;
    const submissionNotificationId = `command-family-submission-${token}`;
    const importOperationId = `command-family-import-${token}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO operation_jobs (
           id,organisation_id,event_id,requested_by_person_id,type,
           idempotency_key,correlation_id,status,payload_json
         ) VALUES (?,?,?,?,'communication.send',?,?,'failed','{}')`,
      ).bind(
        communicationOperationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        communicationOperationId,
        communicationOperationId,
      ),
      env.DB.prepare(
        `INSERT INTO communications (
           id,event_id,operation_id,idempotency_key,status,audience_json,
           content_snapshot_json
         ) VALUES (?,?,?,?,'failed','{}',?)`,
      ).bind(
        communicationId,
        viewer.eventId,
        communicationOperationId,
        communicationId,
        JSON.stringify({ subjectTemplate: `Failed family message ${token}` }),
      ),
      env.DB.prepare(
        `INSERT INTO operation_jobs (
           id,organisation_id,event_id,requested_by_person_id,type,
           idempotency_key,correlation_id,status,payload_json
         ) VALUES (?,?,?,?,'decision.notification',?,?,'queue_failed','{}')`,
      ).bind(
        decisionNotificationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        decisionNotificationId,
        decisionNotificationId,
      ),
      env.DB.prepare(
        `INSERT INTO operation_jobs (
           id,organisation_id,event_id,requested_by_person_id,type,
           idempotency_key,correlation_id,status,payload_json
         ) VALUES (?,?,?,?,'submission.notification',?,?,'queued','{}')`,
      ).bind(
        submissionNotificationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        submissionNotificationId,
        submissionNotificationId,
      ),
      env.DB.prepare(
        `INSERT INTO operation_jobs (
           id,organisation_id,event_id,requested_by_person_id,type,
           idempotency_key,correlation_id,status,payload_json
         ) VALUES (?,?,?,?,'data.import',?,?,'failed','{}')`,
      ).bind(
        importOperationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        importOperationId,
        importOperationId,
      ),
    ]);
    const service = new CommandPaletteService(
      env as unknown as CloudflareEnvironment,
    );

    const communications = await service.search(viewer, {
      query: "communication",
      scope: "event",
    });
    expect(communications).toContainEqual(
      expect.objectContaining({ id: communicationOperationId }),
    );
    expect(communications).toContainEqual(
      expect.objectContaining({ id: decisionNotificationId }),
    );
    expect(communications).toContainEqual(
      expect.objectContaining({ id: submissionNotificationId }),
    );
    expect(communications).not.toContainEqual(
      expect.objectContaining({ id: "command-search-operation" }),
    );
    expect(communications).not.toContainEqual(
      expect.objectContaining({ id: importOperationId }),
    );

    const integrations = await service.search(viewer, {
      query: "integration failed",
      scope: "event",
    });
    expect(integrations).toContainEqual(
      expect.objectContaining({ id: "command-search-operation" }),
    );
    expect(integrations).not.toContainEqual(
      expect.objectContaining({ id: communicationOperationId }),
    );
    expect(integrations).not.toContainEqual(
      expect.objectContaining({ id: decisionNotificationId }),
    );
    expect(integrations).not.toContainEqual(
      expect.objectContaining({ id: submissionNotificationId }),
    );
    expect(integrations).not.toContainEqual(
      expect.objectContaining({ id: importOperationId }),
    );

    const failedOperations = await service.search(viewer, {
      query: "operation failed",
      scope: "event",
    });
    expect(failedOperations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: communicationOperationId }),
        expect.objectContaining({ id: decisionNotificationId }),
        expect.objectContaining({ id: "command-search-operation" }),
        expect.objectContaining({ id: importOperationId }),
      ]),
    );
  });

  it("excludes retired rooms whose Event Setup links cannot be opened", async () => {
    const token = crypto.randomUUID();
    const roomId = `command-retired-room-${token}`;
    const roomName = `Retired command room ${token}`;
    await env.DB.prepare(
      `INSERT INTO rooms (
         id,event_id,name,capacity,resources_json,position,status
       ) VALUES (?,?,?,20,'[]',99,'retired')`,
    )
      .bind(roomId, viewer.eventId, roomName)
      .run();

    const records = await new CommandPaletteService(
      env as unknown as CloudflareEnvironment,
    ).search(viewer, {
      query: `room ${token}`,
      scope: "event",
    });

    expect(records).not.toContainEqual(expect.objectContaining({ id: roomId }));
  });

  it("excludes inactive events from organisation-wide provider checks and results", async () => {
    const token = crypto.randomUUID();
    const eventId = `command-inactive-event-${token}`;
    const roomId = `command-inactive-room-${token}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO events (
           id, organisation_id, name, slug, timezone, starts_at, ends_at,
           repository_provider, activation_status, file_policy_json
         ) VALUES (?, ?, 'Inactive command event', ?, 'UTC', 1800000000,
                   1800086400, 'airtable', 'provisioning_failed', ?)`,
      ).bind(
        eventId,
        viewer.organisationId,
        `inactive-command-${token}`,
        CANONICAL_EVENT_FILE_POLICY_JSON,
      ),
      env.DB.prepare(
        `INSERT INTO rooms (
           id, event_id, name, capacity, resources_json, position, status
         ) VALUES (?, ?, ?, 20, '[]', 1, 'active')`,
      ).bind(roomId, eventId, `Hidden recovery room ${token}`),
    ]);

    const records = await new CommandPaletteService(
      env as unknown as CloudflareEnvironment,
    ).search(
      {
        ...viewer,
        personId: "person-demo-owner",
        role: "owner",
      },
      { query: `room ${token}`, scope: "organisation" },
    );

    expect(records).not.toContainEqual(expect.objectContaining({ id: roomId }));
  });

  it("does not let a record alias broaden a committee chair's assignment scope", async () => {
    const records = await new CommandPaletteService(
      env as unknown as CloudflareEnvironment,
    ).search(
      {
        ...viewer,
        personId: "person-demo-evaluator",
        role: "committee_chair",
      },
      { query: "room main", scope: "event" },
    );

    expect(records).toEqual([]);
  });

  it("returns only current workbench assignments to committee chairs", async () => {
    await ensureDemoEvaluationData(env as unknown as CloudflareEnvironment);
    const token = crypto.randomUUID();
    const archivedPlanId = `command-archived-plan-${token}`;
    const archivedRoundId = `command-archived-round-${token}`;
    const archivedAssignmentId = `command-archived-assignment-${token}`;
    const archivedAuditId = `command-archived-audit-${token}`;
    const currentAuditId = `command-current-audit-${token}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO evaluation_plans (
           id,event_id,name,status,blinded_reviewing,decision_role,revision,
           created_by_person_id
         ) VALUES (?,?,'Archived command cycle','archived',0,
                   'administrator',1,?)`,
      ).bind(archivedPlanId, viewer.eventId, viewer.personId),
      env.DB.prepare(
        `INSERT INTO evaluation_rounds (
           id,event_id,plan_id,round_number,name,status,blinded_reviewing,
           scorecard_id,scorecard_version,advancement_rule_json,revision
         ) VALUES (?,?,?,1,'Archived command round','archived',0,?,1,'{}',1)`,
      ).bind(archivedRoundId, viewer.eventId, archivedPlanId, archivedRoundId),
      env.DB.prepare(
        `INSERT INTO evaluation_round_reviewers (
           id,event_id,round_id,person_id,added_by_person_id
         ) VALUES (?,?,?,?,?)`,
      ).bind(
        `command-archived-pool-${token}`,
        viewer.eventId,
        archivedRoundId,
        "person-demo-evaluator",
        viewer.personId,
      ),
      env.DB.prepare(
        `INSERT INTO evaluator_assignments (
           id,event_id,round_id,submission_id,evaluator_person_id,status
         ) VALUES (?,?,?,'demo-evaluation-submission-calm',?,'assigned')`,
      ).bind(
        archivedAssignmentId,
        viewer.eventId,
        archivedRoundId,
        "person-demo-evaluator",
      ),
      env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version,organisation_id,event_id,actor_person_id,action,entity_type,
           entity_id,created_at
         ) VALUES (?, 'person', 'internal', 1,?,?,?,'evaluation.assignment.created',
                   'evaluator_assignment',?,2000000102)`,
      ).bind(
        archivedAuditId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        archivedAssignmentId,
      ),
      env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version,organisation_id,event_id,actor_person_id,action,entity_type,
           entity_id,created_at
         ) VALUES (?, 'person', 'internal', 1,?,?,?,'evaluation.assignment.created',
                   'evaluator_assignment','demo-evaluation-assignment-1',
                   2000000101)`,
      ).bind(
        currentAuditId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
      ),
    ]);
    const committeeChair: Viewer = {
      ...viewer,
      personId: "person-demo-evaluator",
      name: "Jordan Lee",
      email: "jordan.evaluator@example.com",
      role: "committee_chair",
    };
    const service = new CommandPaletteService(
      env as unknown as CloudflareEnvironment,
    );

    const searchResults = await service.search(committeeChair, {
      query: "calm",
      scope: "event",
    });
    expect(searchResults).toContainEqual(
      expect.objectContaining({
        href: "/review/workbench?assignment=demo-evaluation-assignment-1",
      }),
    );
    expect(searchResults).not.toContainEqual(
      expect.objectContaining({
        href: `/review/workbench?assignment=${archivedAssignmentId}`,
      }),
    );

    const recentResults = await service.recent(committeeChair);
    expect(recentResults).toContainEqual(
      expect.objectContaining({
        id: currentAuditId,
        href: "/review/workbench?assignment=demo-evaluation-assignment-1",
      }),
    );
    expect(recentResults.map((record) => record.id)).not.toContain(
      archivedAuditId,
    );
  });
});
