import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { CANONICAL_EVENT_FILE_POLICY_JSON } from "~/modules/files/file-policy";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { action, loader } from "./admin-event-repository-recovery";

const workerEnv = env as unknown as CloudflareEnvironment;
const targetEventId = "route-incomplete-airtable-event";

function context() {
  const value = new RouterContextProvider();
  value.set(cloudflareContext, {
    env: workerEnv,
    ctx: {} as ExecutionContext,
  });
  return value;
}

function request(intent?: string) {
  return new Request(
    `http://localhost/admin/events/${targetEventId}/repository-recovery`,
    {
      method: intent ? "POST" : "GET",
      headers: {
        cookie:
          "program_cue_demo_identity=administrator; program_cue_event=evt-foe-2025",
        origin: "http://localhost",
      },
      ...(intent ? { body: new URLSearchParams({ intent }) } : {}),
    },
  );
}

beforeEach(async () => {
  await ensureDemoData(workerEnv);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO memberships (
       id, organisation_id, event_id, person_id, role,
       invited_at, accepted_at, created_at
     ) VALUES ('membership-recovery-route-admin', 'org-future-events', NULL,
               'person-demo-admin', 'administrator', unixepoch(),
               unixepoch(), unixepoch())`,
  ).run();
  await env.DB.prepare("DELETE FROM events WHERE id = ?")
    .bind(targetEventId)
    .run();
  const operationId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO events (
         id, organisation_id, name, slug, timezone, starts_at, ends_at,
         repository_provider, activation_status, file_policy_json,
         last_operation_id, last_updated_by_person_id
       ) VALUES (?, 'org-future-events', 'Route recovery event',
                 'route-recovery-event', 'UTC', 1800000000, 1800086400,
                 'airtable', 'provisioning_failed', ?, ?,
                 'person-demo-admin')`,
    ).bind(targetEventId, CANONICAL_EVENT_FILE_POLICY_JSON, operationId),
    env.DB.prepare(
      `INSERT INTO operation_jobs (
         id, organisation_id, event_id, requested_by_person_id, type,
         idempotency_key, correlation_id, status, payload_json,
         progress_total, progress_failed, last_error, cancellable
       ) VALUES (?, 'org-future-events', ?, 'person-demo-admin',
                 'event.create', ?, ?, 'failed', ?, 1, 1,
                 'Airtable rejected the request', 0)`,
    ).bind(
      operationId,
      targetEventId,
      `route-failed-${operationId}`,
      crypto.randomUUID(),
      JSON.stringify({
        type: "event.create",
        targetEventId,
        requestedRepositoryProvider: "airtable",
      }),
    ),
  ]);
});

describe("event repository recovery route", () => {
  it("loads an incomplete event without selecting it", async () => {
    const result = await loader({
      request: request(),
      params: { eventId: targetEventId },
      context: context(),
    } as never);

    expect(result).toMatchObject({
      id: targetEventId,
      activationStatus: "provisioning_failed",
      repositoryProvider: "airtable",
      lastError: "Airtable rejected the request",
    });
  });

  it("requires an explicit action before making the D1 projection active", async () => {
    const response = await action({
      request: request("keep_d1"),
      params: { eventId: targetEventId },
      context: context(),
    } as never);
    if (response instanceof Response)
      throw new Error("Recovery action returned a raw response.");

    expect(response.data).toMatchObject({
      ok: true,
      result: { eventId: targetEventId, activationStatus: "active" },
    });
    expect(
      await env.DB.prepare(
        `SELECT repository_provider AS provider,
                activation_status AS activationStatus
           FROM events WHERE id = ?`,
      )
        .bind(targetEventId)
        .first(),
    ).toEqual({ provider: "d1", activationStatus: "active" });
  });
});
