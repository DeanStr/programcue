import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { RouterContextProvider } from "react-router";

import routeConfig from "~/routes";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import { ensureDemoSubmissionForm } from "~/modules/submissions/demo-submissions.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import {
  ensureDemoData,
  ensureDemoProgramme,
} from "~/platform/demo/seed.server";
import { loader as administrationItemLoader } from "~/routes/api-administration-item";
import { loader as taskItemLoader } from "~/routes/api-task-item";

const testEnv = env as unknown as CloudflareEnvironment;
const eventId = "evt-foe-2025";
const organisationId = "org-future-events";

function context() {
  const provider = new RouterContextProvider();
  provider.set(cloudflareContext, {
    env: testEnv,
    ctx: {} as ExecutionContext,
  });
  return provider;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function apiKey(scopes: string[]) {
  const suffix = crypto.randomUUID();
  const token = `pc_api_items_${suffix}`;
  await testEnv.DB.prepare(
    `INSERT INTO api_keys (
       id, organisation_id, event_id, name, key_prefix, key_hash,
       scopes_json, created_at
     ) VALUES (?, ?, ?, ?, 'pc_api_', ?, ?, unixepoch())`,
  )
    .bind(
      `api-items-${suffix}`,
      organisationId,
      eventId,
      `API item ${suffix}`,
      await sha256(token),
      JSON.stringify(scopes),
    )
    .run();
  return token;
}

beforeEach(async () => {
  await ensureDemoData(testEnv);
  await ensureDemoSpeakerData(testEnv);
  await ensureDemoSubmissionForm(testEnv);
  await ensureDemoProgramme(testEnv);
});

describe("administration API item reachability", () => {
  it("registers the concrete item routes ahead of collection fallbacks", () => {
    const configured = JSON.stringify(routeConfig);
    expect(configured).toContain("api/v1/events/:eventId/:resource/:itemId");
    expect(configured).toContain("routes/api-administration-item.ts");
    expect(configured).toContain("api/v1/events/:eventId/tasks/:taskId");
    expect(configured).toContain("routes/api-task-item.ts");
  });

  it("reads tenant-scoped people, form, session and schedule-version items", async () => {
    const token = await apiKey([
      "people:read",
      "forms:read",
      "sessions:read",
      "schedule:read",
    ]);
    const targets = [
      {
        resource: "people",
        itemId: "person-demo-speaker",
      },
      {
        resource: "forms",
        itemId: (await testEnv.DB.prepare(
          "SELECT id FROM form_definitions WHERE event_id = ? ORDER BY id LIMIT 1",
        )
          .bind(eventId)
          .first<{ id: string }>())!.id,
      },
      {
        resource: "sessions",
        itemId: (await testEnv.DB.prepare(
          "SELECT id FROM sessions WHERE event_id = ? ORDER BY id LIMIT 1",
        )
          .bind(eventId)
          .first<{ id: string }>())!.id,
      },
      {
        resource: "schedule-versions",
        itemId: (await testEnv.DB.prepare(
          "SELECT id FROM schedule_versions WHERE event_id = ? ORDER BY id LIMIT 1",
        )
          .bind(eventId)
          .first<{ id: string }>())!.id,
      },
    ];
    for (const target of targets) {
      const response = await administrationItemLoader({
        request: new Request(
          `https://programcue.test/api/v1/events/${eventId}/${target.resource}/${target.itemId}`,
          { headers: { authorization: `Bearer ${token}` } },
        ),
        params: { eventId, ...target },
        context: context(),
      } as never);
      expect(response.status, target.resource).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        item: { id: target.itemId },
        related: expect.any(Array),
        relatedHasMore: false,
      });
    }
  });

  it("enforces each item family's scope and returns no record from an unknown id", async () => {
    const token = await apiKey(["people:read"]);
    const denied = await administrationItemLoader({
      request: new Request(
        `https://programcue.test/api/v1/events/${eventId}/forms/form`,
        { headers: { authorization: `Bearer ${token}` } },
      ),
      params: { eventId, resource: "forms", itemId: "form" },
      context: context(),
    } as never);
    expect(denied.status).toBe(403);

    const missing = await administrationItemLoader({
      request: new Request(
        `https://programcue.test/api/v1/events/${eventId}/people/missing-person`,
        { headers: { authorization: `Bearer ${token}` } },
      ),
      params: {
        eventId,
        resource: "people",
        itemId: "missing-person",
      },
      context: context(),
    } as never);
    expect(missing.status).toBe(404);
  });

  it("does not expose an unaccepted speaker invitation through the item route", async () => {
    const suffix = crypto.randomUUID();
    const personId = `invited-speaker-${suffix}`;
    const membershipId = `invited-speaker-membership-${suffix}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO people (id, email, display_name)
         VALUES (?, ?, 'Invited speaker')`,
      ).bind(personId, `invited-speaker-${suffix}@example.com`),
      testEnv.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role, invited_at
         ) VALUES (?, ?, ?, ?, 'speaker', unixepoch())`,
      ).bind(membershipId, organisationId, eventId, personId),
    ]);
    const token = await apiKey(["speakers:read"]);
    const invoke = () =>
      administrationItemLoader({
        request: new Request(
          `https://programcue.test/api/v1/events/${eventId}/speakers/${personId}`,
          { headers: { authorization: `Bearer ${token}` } },
        ),
        params: { eventId, resource: "speakers", itemId: personId },
        context: context(),
      } as never);

    const invited = await invoke();
    expect(invited.status).toBe(404);

    await testEnv.DB.prepare(
      "UPDATE memberships SET accepted_at = unixepoch() WHERE id = ?",
    )
      .bind(membershipId)
      .run();
    const accepted = await invoke();
    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toMatchObject({
      item: { id: personId },
    });
  });

  it("exposes a task item only through tasks:read", async () => {
    const task = await testEnv.DB.prepare(
      "SELECT id FROM task_instances WHERE event_id = ? ORDER BY id LIMIT 1",
    )
      .bind(eventId)
      .first<{ id: string }>();
    expect(task).toBeTruthy();
    const token = await apiKey(["tasks:read"]);
    const response = await taskItemLoader({
      request: new Request(
        `https://programcue.test/api/v1/events/${eventId}/tasks/${task!.id}`,
        { headers: { authorization: `Bearer ${token}` } },
      ),
      params: { eventId, taskId: task!.id },
      context: context(),
    } as never);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      task: { id: task!.id },
    });
  });
});
