import { env } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { snapshotSourceValues } from "./communication-service-shared";

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

afterEach(() => vi.restoreAllMocks());

it("rejects decision merge values when no published decision exists", async () => {
  const { testEnv } = await communicationEnvironment();
  const submissionId = `decision-source-${crypto.randomUUID()}`;
  await testEnv.DB.prepare(
    `INSERT INTO submissions (
       id, event_id, submitter_email, public_reference, title, status,
       answers_json, submitted_snapshot_json, submitted_at, created_at, updated_at
     ) VALUES (?, ?, 'decision-source@example.com', ?, 'Decision source',
               'submitted', '{}', '{"answers":{},"speakers":[]}',
               unixepoch(), unixepoch(), unixepoch())`,
  )
    .bind(submissionId, viewer.eventId, `SOURCE-${submissionId.slice(-8)}`)
    .run();
  const recipients = [
    {
      personId: null,
      address: "decision-source@example.com",
      name: "Decision source",
      sourceId: submissionId,
    },
  ];

  await expect(
    snapshotSourceValues(
      testEnv,
      viewer.eventId,
      ["decision.outcome"],
      recipients,
    ),
  ).rejects.toThrow(/published decision.*unavailable/i);
  await expect(
    snapshotSourceValues(
      testEnv,
      viewer.eventId,
      ["submission.title"],
      recipients,
    ),
  ).resolves.toEqual(
    new Map([[submissionId, { "submission.title": "Decision source" }]]),
  );
});

async function communicationEnvironment() {
  const sent: unknown[] = [];
  const realtime: unknown[] = [];
  const eventChannel = {
    idFromName(name: string) {
      return name;
    },
    get() {
      return {
        async fetch(_input: RequestInfo | URL, init?: RequestInit) {
          realtime.push(JSON.parse(String(init?.body)));
          return Response.json({ accepted: true });
        },
      };
    },
  };
  const testEnv = {
    ...(env as unknown as CloudflareEnvironment),
    SOURCE_REVISION: "test-revision",
    DB: env.DB,
    RESEND_API_KEY: "test-resend-key",
    OPERATIONS_QUEUE: {
      send: async (message: unknown) => {
        sent.push(message);
      },
    },
    EVENT_CHANNEL: eventChannel,
  } as unknown as CloudflareEnvironment;
  await ensureDemoData(testEnv);
  await env.DB.prepare(
    "DELETE FROM webhook_endpoints WHERE event_id = ? AND name = 'Communication completion receiver'",
  )
    .bind(viewer.eventId)
    .run();
  await env.DB.prepare(
    `
    INSERT OR IGNORE INTO sender_profiles (
      id, event_id, name, from_name, from_email, reply_to_email, provider, status, created_at, updated_at
    ) VALUES ('sender-test-communications', ?, 'Test communications', 'Program Cue', 'events@example.com',
              'reply@example.com', 'resend', 'verified', unixepoch(), unixepoch())
  `,
  )
    .bind(viewer.eventId)
    .run();
  await env.DB.prepare(
    `UPDATE sender_profiles
        SET provider = 'resend', status = 'verified'
      WHERE id = 'sender-test-communications' AND event_id = ?`,
  )
    .bind(viewer.eventId)
    .run();
  return { testEnv, sent, realtime };
}
