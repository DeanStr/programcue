import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
import { PublicProgrammeService } from "~/modules/programme/public-programme-service.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import {
  ensureDemoData,
  ensureDemoProgramme,
} from "~/platform/demo/seed.server";
import { action as evaluationResourceAction } from "~/routes/api-evaluation-resources";
import type { ApiError, ApiPrincipal } from "./api.server";
import { ApiEvaluationService } from "./api-evaluation-service.server";
import { ApiIntegrationService } from "./api-integration-service.server";
import {
  publicSchedulePage,
  publicSessionPage,
} from "./api-public-programme.server";

async function hash(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

const testEnv = env as unknown as CloudflareEnvironment;
const principal = {
  keyId: "expanded-api-key",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  scopes: new Set([
    "events:read",
    "sessions:read",
    "evaluation:read",
    "integrations:read",
  ]),
} satisfies ApiPrincipal & { eventId: string };

function routeContext() {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, {
    env: testEnv,
    ctx: {} as ExecutionContext,
  });
  return context;
}

beforeEach(async () => {
  await ensureDemoData(testEnv);
});

describe("evaluation and integration API reads", () => {
  it("returns multi-round evaluation resources with criteria and private review state", async () => {
    await ensureDemoEvaluationData(testEnv);
    const service = new ApiEvaluationService(testEnv);
    const rounds = await service.list(principal, "rounds", { limit: 20 });
    const roundRecords = rounds.rounds as unknown as Array<{
      createdAt: string;
      criteria: unknown[];
      advancementRule: Record<string, unknown>;
    }>;
    expect(roundRecords.length).toBeGreaterThan(0);
    expect(roundRecords[0]).toMatchObject({
      criteria: expect.any(Array),
      advancementRule: expect.any(Object),
    });
    expect(roundRecords[0]?.createdAt).toMatch(/Z$/u);
    const assignments = await service.list(principal, "assignments", {
      limit: 20,
    });
    const assignmentRecords = assignments.assignments as unknown as Array<{
      evaluatorPersonId: string;
    }>;
    expect(assignmentRecords.length).toBeGreaterThan(0);
    expect(assignmentRecords[0]).toHaveProperty("evaluatorPersonId");
    for (const resource of [
      "plans",
      "teams",
      "reviews",
      "round-reviewers",
      "conflicts",
      "moderations",
    ] as const) {
      const page = await service.list(principal, resource, { limit: 10 });
      const responseKey =
        resource === "round-reviewers" ? "roundReviewers" : resource;
      expect((page as unknown as Record<string, unknown>)[responseKey]).toEqual(
        expect.any(Array),
      );
    }
  });

  it("never returns encrypted integration credentials and scopes child records through the connection event", async () => {
    const suffix = crypto.randomUUID();
    const connectionId = `api-connection-${suffix}`;
    const runId = `api-run-${suffix}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO integration_connections (
          id, organisation_id, event_id, provider, status, direction,
          encrypted_credentials, configuration_json, created_at, updated_at
        ) VALUES (?, ?, ?, 'accelevents', 'connected', 'outbound',
                  'secret-ciphertext', '{"externalEventId":"event-1"}',
                  unixepoch(), unixepoch())`,
      ).bind(connectionId, principal.organisationId, principal.eventId),
      testEnv.DB.prepare(
        `INSERT INTO integration_runs (
          id, connection_id, idempotency_key, status, direction, dry_run,
          summary_json, created_at
        ) VALUES (?, ?, ?, 'succeeded', 'outbound', 1,
                  '{"total":1}', unixepoch())`,
      ).bind(runId, connectionId, `api-run-${suffix}`),
      testEnv.DB.prepare(
        `INSERT INTO integration_run_items (
          id, run_id, entity_type, entity_id, action, status, diff_json,
          updated_at
        ) VALUES (?, ?, 'session', ?, 'create', 'succeeded',
                  '{"title":"Example"}', unixepoch())`,
      ).bind(`api-run-item-${suffix}`, runId, `session-${suffix}`),
    ]);
    const service = new ApiIntegrationService(testEnv);
    const connections = await service.list(principal, "connections", {
      limit: 10,
    });
    const connectionRecords = connections.connections as unknown as Array<
      Record<string, unknown> & { id: string }
    >;
    const connection = connectionRecords.find(
      (record) => record.id === connectionId,
    );
    expect(connection).toMatchObject({
      hasCredentials: true,
      configuration: { externalEventId: "event-1" },
    });
    expect(connection).not.toHaveProperty("encryptedCredentials");
    expect(connection).not.toHaveProperty("encrypted_credentials");

    const items = await service.list(principal, "run-items", {
      limit: 10,
      runId,
    });
    expect(items.runItems).toEqual([
      expect.objectContaining({
        runId,
        diff: { title: "Example" },
      }),
    ]);
  });

  it("rejects a cursor from a changed public collection, filter, or resource", async () => {
    await ensureDemoProgramme(testEnv);
    const programme = await new PublicProgrammeService(testEnv).getPublished(
      "future-of-events-2027",
    );
    const page = await publicSessionPage(programme!, { limit: 1 });
    await expect(
      publicSessionPage(
        {
          ...programme!,
          sessions: programme!.sessions.map((session, index) =>
            index === 0
              ? { ...session, title: `${session.title} changed` }
              : session,
          ),
        },
        { limit: 1, cursor: page.nextCursor! },
      ),
    ).rejects.toThrowError(
      expect.objectContaining({
        status: 409,
        code: "PUBLICATION_CHANGED",
      } satisfies Partial<ApiError>),
    );
    await expect(
      publicSessionPage(programme!, {
        limit: 1,
        cursor: page.nextCursor!,
        q: "different filter",
      }),
    ).rejects.toMatchObject({ status: 409, code: "PUBLICATION_CHANGED" });
    await expect(
      publicSchedulePage(programme!, {
        limit: 1,
        cursor: page.nextCursor!,
      }),
    ).rejects.toMatchObject({ status: 409, code: "PUBLICATION_CHANGED" });
  });

  it("keeps public cursors stable across freshness-only cache changes", async () => {
    await ensureDemoProgramme(testEnv);
    const programme = await new PublicProgrammeService(testEnv).getPublished(
      "future-of-events-2027",
    );
    const airtableProgramme = {
      ...programme!,
      freshness: {
        source: "airtable" as const,
        fetchedAt: programme!.freshness.fetchedAt,
        cacheExpiresAt: programme!.freshness.fetchedAt + 60,
        cached: false as const,
      },
    };
    const first = await publicSessionPage(airtableProgramme, { limit: 1 });
    const second = await publicSessionPage(
      {
        ...airtableProgramme,
        contentRevision: `${programme!.contentRevision}-freshness-changed`,
        freshness: {
          ...airtableProgramme.freshness,
          cached: true as const,
        },
      },
      { limit: 1, cursor: first.nextCursor! },
    );
    expect(second.sessions).toHaveLength(1);
    expect(second.sessions[0]?.id).not.toBe(first.sessions[0]?.id);
  });

  it("executes a strict, audited and exactly replayable plan command through the API route", async () => {
    const suffix = crypto.randomUUID();
    const eventId = `api-evaluation-event-${suffix}`;
    const token = `pc_api_evaluation_${suffix}`;
    const keyId = `api-evaluation-key-${suffix}`;
    const sessionId = `api-evaluation-session-${suffix}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json
        ) VALUES (?, ?, 'API evaluation event', ?, 'UTC',
                  2000000000, 2000086400,
                  '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}')`,
      ).bind(eventId, principal.organisationId, `api-evaluation-${suffix}`),
      testEnv.DB.prepare(
        `INSERT INTO api_keys (
          id, organisation_id, event_id, name, key_prefix, key_hash,
          scopes_json, created_at
        ) VALUES (?, ?, ?, 'Evaluation route key', 'pc_api_', ?,
                  '["evaluation:write"]', unixepoch())`,
      ).bind(keyId, principal.organisationId, eventId, await hash(token)),
      testEnv.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role, accepted_at,
           invited_at, created_at
         ) VALUES (?, ?, ?, 'person-demo-evaluator', 'evaluator', unixepoch(),
                   unixepoch(), unixepoch())`,
      ).bind(
        `api-evaluation-membership-${suffix}`,
        principal.organisationId,
        eventId,
      ),
      testEnv.DB.prepare(
        `INSERT INTO sessions (
           id, event_id, title, slug, description, format, duration_minutes,
           status, revision, created_at, updated_at
         ) VALUES (?, ?, 'API direct session', ?, 'Frozen API evidence',
                   'workshop', 60, 'unscheduled', 1, unixepoch(), unixepoch())`,
      ).bind(sessionId, eventId, `api-direct-session-${suffix}`),
    ]);
    const context = routeContext();
    const body = {
      revision: 0,
      name: "API review plan",
      status: "active",
      decisionRole: "administrator",
      rounds: [
        {
          id: `api-round-${suffix}`,
          name: "First review",
          dueAt: null,
          anonymous: false,
          scorecardId: `api-scorecard-${suffix}`,
          scorecardVersion: 1,
          criteria: [
            {
              id: `api-criterion-${suffix}`,
              name: "Programme fit",
              description: "Fit for this event.",
              inputType: "scale_5",
              weightPercent: 100,
              required: true,
              position: 0,
            },
          ],
        },
      ],
    };
    const invoke = (value: unknown) =>
      evaluationResourceAction({
        request: new Request(
          `https://programcue.test/api/v1/events/${eventId}/evaluation/plans`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              "idempotency-key": `evaluation-plan-${suffix}`,
            },
            body: JSON.stringify(value),
          },
        ),
        params: { eventId, resource: "plans" },
        context,
      } as never);
    const { decisionRole: _decisionRole, ...withoutDecisionRole } = body;
    const missingDecisionRole = await invoke(withoutDecisionRole);
    expect(missingDecisionRole.status).toBe(422);
    await expect(missingDecisionRole.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
    const { anonymous: _anonymous, ...roundWithoutAnonymous } = body.rounds[0]!;
    const missingAnonymous = await invoke({
      ...body,
      rounds: [roundWithoutAnonymous],
    });
    expect(missingAnonymous.status).toBe(422);
    await expect(missingAnonymous.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
    const {
      scorecardId: _scorecardId,
      scorecardVersion: _scorecardVersion,
      ...roundWithoutScorecard
    } = body.rounds[0]!;
    const missingScorecard = await invoke({
      ...body,
      rounds: [roundWithoutScorecard],
    });
    expect(missingScorecard.status).toBe(422);
    await expect(missingScorecard.json()).resolves.toMatchObject({
      error: { code: "VALIDATION_ERROR" },
    });
    const first = await invoke(body);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { planId: string };
    const replay = await invoke(body);
    await expect(replay.json()).resolves.toMatchObject({
      planId: firstBody.planId,
    });
    const conflict = await invoke({ ...body, name: "Changed request" });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      error: { code: "EVALUATION_REVISION_CONFLICT" },
    });
    await expect(
      testEnv.DB.prepare(
        `SELECT actor_person_id AS actorPersonId, actor_id AS actorId
           FROM audit_events
          WHERE action = 'evaluation.plan.saved' AND entity_id = ?`,
      )
        .bind(firstBody.planId)
        .first(),
    ).resolves.toEqual({
      actorPersonId: null,
      actorId: `api_key:${keyId}`,
    });

    const invokeReviewer = (value: unknown, idempotencyKey: string) =>
      evaluationResourceAction({
        request: new Request(
          `https://programcue.test/api/v1/events/${eventId}/evaluation/round-reviewers`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              "idempotency-key": idempotencyKey,
            },
            body: JSON.stringify(value),
          },
        ),
        params: { eventId, resource: "round-reviewers" },
        context,
      } as never);
    const reviewerBody = {
      roundId: body.rounds[0]!.id,
      personId: "person-demo-evaluator",
      operation: "add",
    };
    const reviewerResponse = await invokeReviewer(
      reviewerBody,
      `evaluation-round-reviewer-${suffix}`,
    );
    expect(reviewerResponse.status).toBe(200);
    await expect(reviewerResponse.json()).resolves.toMatchObject({
      roundId: reviewerBody.roundId,
      personId: reviewerBody.personId,
      operation: "add",
      cancelledAssignmentCount: 0,
    });

    const assignmentBody = {
      roundId: body.rounds[0]!.id,
      targetType: "session",
      targetIds: [sessionId],
      evaluatorPersonIds: ["person-demo-evaluator"],
      teamId: null,
    };
    const invokeAssignment = (value: unknown, idempotencyKey: string) =>
      evaluationResourceAction({
        request: new Request(
          `https://programcue.test/api/v1/events/${eventId}/evaluation/assignments`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
              "idempotency-key": idempotencyKey,
            },
            body: JSON.stringify(value),
          },
        ),
        params: { eventId, resource: "assignments" },
        context,
      } as never);
    const assignmentResponse = await invokeAssignment(
      assignmentBody,
      `evaluation-assignment-${suffix}`,
    );
    expect(assignmentResponse.status).toBe(200);
    await expect(assignmentResponse.json()).resolves.toMatchObject({
      createdAssignmentCount: 1,
      requestedAssignmentCount: 1,
    });
    await expect(
      testEnv.DB.prepare(
        `SELECT submission_id AS submissionId, session_id AS sessionId,
                json_extract(session_snapshot_json, '$.title') AS snapshotTitle
           FROM evaluator_assignments
          WHERE event_id = ? AND session_id = ?`,
      )
        .bind(eventId, sessionId)
        .first(),
    ).resolves.toEqual({
      submissionId: null,
      sessionId,
      snapshotTitle: "API direct session",
    });
    const assignmentPage = await new ApiEvaluationService(testEnv).list(
      { ...principal, eventId },
      "assignments",
      { limit: 10, targetType: "session", targetId: sessionId },
    );
    expect(assignmentPage.assignments).toEqual([
      expect.objectContaining({
        targetType: "session",
        targetId: sessionId,
        targetTitle: "API direct session",
      }),
    ]);
    const unconfirmedRemoval = await invokeReviewer(
      { ...reviewerBody, operation: "remove" },
      `evaluation-round-reviewer-remove-unconfirmed-${suffix}`,
    );
    expect(unconfirmedRemoval.status).toBe(422);
    const removalResponse = await invokeReviewer(
      { ...reviewerBody, operation: "remove", confirmed: true },
      `evaluation-round-reviewer-remove-${suffix}`,
    );
    expect(removalResponse.status).toBe(200);
    await expect(removalResponse.json()).resolves.toMatchObject({
      operation: "remove",
      cancelledAssignmentCount: 1,
    });
    const legacyAssignment = await invokeAssignment(
      {
        roundId: body.rounds[0]!.id,
        submissionIds: [sessionId],
        evaluatorPersonIds: ["person-demo-evaluator"],
      },
      `legacy-evaluation-assignment-${suffix}`,
    );
    expect(legacyAssignment.status).toBe(422);

    const unknown = await invoke({ ...body, unsupported: true });
    expect(unknown.status).toBe(422);
  });
});
