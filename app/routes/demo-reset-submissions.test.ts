import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { ensureDemoSubmissionForm } from "~/modules/submissions/demo-submissions.server";
import { SubmissionService } from "~/modules/submissions/submission-service.server";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { action } from "./demo-reset-submissions";

const EVENT_ID = "evt-foe-2025";
const ORGANISATION_ID = "org-future-events";
const ADMIN_ID = "person-demo-admin";
const SENDER_FIXTURE_ID = "sender-demo-submissions-e2e";

function localCaptureEnvironment() {
  return {
    ...(env as unknown as CloudflareEnvironment),
    APP_ENV: "test",
    EMAIL_PROVIDER: "mailpit",
    RESEND_API_KEY: undefined,
    MAILPIT_SEND_API_URL: "http://127.0.0.1:8025/api/v1/send",
  } as unknown as CloudflareEnvironment;
}

function context(environment: CloudflareEnvironment) {
  const provider = new RouterContextProvider();
  provider.set(cloudflareContext, {
    env: environment,
    ctx: {} as ExecutionContext,
  });
  return provider;
}

function resetRequest(senderFixture?: string) {
  return new Request("http://localhost/demo/reset/submissions", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "http://localhost",
    },
    body: new URLSearchParams({
      confirm: "reset-submissions-demo",
      ...(senderFixture === undefined ? {} : { senderFixture }),
    }),
  });
}

async function invokeReset(
  senderFixture?: string,
  environment = env as unknown as CloudflareEnvironment,
) {
  return action({
    request: resetRequest(senderFixture),
    params: {},
    context: context(environment),
  } as never);
}

async function thrownResponse(operation: Promise<unknown>) {
  try {
    await operation;
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  throw new Error("Expected the reset route to throw a Response.");
}

beforeEach(async () => {
  await ensureDemoSubmissionForm(env as unknown as CloudflareEnvironment);
});

describe("submission demo reset", () => {
  it("rejects a demo runtime that does not target the canonical event", async () => {
    const invalidEnvironment = {
      ...(env as unknown as CloudflareEnvironment),
      DEFAULT_EVENT_ID: "evt-not-the-canonical-demo",
    } as unknown as CloudflareEnvironment;
    const response = await thrownResponse(
      invokeReset(undefined, invalidEnvironment),
    );

    expect(response.status).toBe(404);
  });

  it("fails before cleanup when the active-operation count is unavailable", async () => {
    const database = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (query: string) => {
            if (query.includes("AS activeOperationCount")) {
              return {
                bind: () => ({ first: async () => null }),
              } as unknown as D1PreparedStatement;
            }
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await expect(
      invokeReset(undefined, {
        ...(env as unknown as CloudflareEnvironment),
        DB: database,
      }),
    ).rejects.toThrow(
      "The active demo submission operation count is unavailable.",
    );
  });

  it("fails before cleanup when the active-operation count is invalid", async () => {
    const database = new Proxy(env.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (query: string) => {
            if (query.includes("AS activeOperationCount")) {
              return {
                bind: () => ({
                  first: async () => ({ activeOperationCount: null }),
                }),
              } as unknown as D1PreparedStatement;
            }
            return target.prepare(query);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    await expect(
      invokeReset(undefined, {
        ...(env as unknown as CloudflareEnvironment),
        DB: database,
      }),
    ).rejects.toThrow("The active demo submission operation count is invalid.");
  });

  it("rejects unsupported sender fixtures before changing the baseline", async () => {
    const response = await thrownResponse(invokeReset("unexpected_sender"));
    expect(response.status).toBe(400);
    await expect(
      env.DB.prepare("SELECT id FROM sender_profiles WHERE id = ?")
        .bind(SENDER_FIXTURE_ID)
        .first(),
    ).resolves.toBeNull();
  });

  it("waits for co-speaker work and removes only its scoped derived records", async () => {
    const testEnvironment = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnvironment);
    await env.DB.prepare(
      `
      INSERT INTO task_templates (
        id, event_id, name, description, target_type, task_type, impact,
        evidence_mode, due_anchor, auto_assign_on_acceptance,
        configuration_json, status, created_at, updated_at
      ) VALUES (
        'resource-ack:resource-speaker-handbook', ?,
        'Acknowledge the speaker handbook', 'Generated resource task',
        'speaker', 'acknowledgement', 'medium', 'checkbox', 'none', 0,
        '{"resourcePageId":"resource-speaker-handbook"}', 'active',
        unixepoch(), unixepoch()
      )
    `,
    )
      .bind(EVENT_ID)
      .run();

    const token = crypto.randomUUID();
    const sponsorEmail = `sponsor-${token}@example.com`;
    const directSessionId = await new SubmissionService(
      testEnvironment,
    ).createDirectSession(
      {
        organisationId: ORGANISATION_ID,
        eventId: EVENT_ID,
        personId: ADMIN_ID,
        name: "Demo Administrator",
        email: "admin@example.com",
        role: "administrator",
        demo: true,
      },
      {
        idempotencyKey: crypto.randomUUID(),
        title: `Sponsor briefing ${token}`,
        description: "Disposable direct-session reset fixture.",
        format: "presentation",
        trackId: "demo-track-ai",
        speakers: [
          {
            name: "Reset Sponsor",
            email: sponsorEmail,
            biography: "Disposable reset fixture speaker.",
          },
        ],
      },
    );
    const sponsor = await env.DB.prepare(
      "SELECT id FROM people WHERE email = ? COLLATE NOCASE",
    )
      .bind(sponsorEmail)
      .first<{ id: string }>();
    if (!sponsor)
      throw new Error("The direct-session speaker was not created.");
    const acknowledgementTaskId = `resource-ack:resource-speaker-handbook:${sponsor.id}`;
    await expect(
      env.DB.prepare("SELECT id FROM task_instances WHERE id = ?")
        .bind(acknowledgementTaskId)
        .first(),
    ).resolves.toEqual({ id: acknowledgementTaskId });
    const retainedTaskId = `retained-sponsor-task-${token}`;
    await env.DB.prepare(
      `
      INSERT INTO task_instances (
        id, event_id, target_type, target_id, owner_person_id, title,
        task_type, impact, status, readiness_state, readiness_percent,
        revision, created_at, updated_at
      ) VALUES (
        ?, ?, 'speaker', ?, ?, 'Retained sponsor task', 'checklist', 'low',
        'not_started', 'on_track', 0, 1, unixepoch(), unixepoch()
      )
    `,
    )
      .bind(retainedTaskId, EVENT_ID, sponsor.id, sponsor.id)
      .run();

    const form = await env.DB.prepare(
      `
      SELECT definition.id AS formId, version.id AS versionId
        FROM form_definitions definition
        JOIN form_versions version
          ON version.form_id = definition.id
         AND version.event_id = definition.event_id
         AND version.status = 'published'
       WHERE definition.event_id = ? AND definition.public_slug = 'form'
    `,
    )
      .bind(EVENT_ID)
      .first<{ formId: string; versionId: string }>();
    if (!form) throw new Error("The published demo form is unavailable.");
    const submissionId = `reset-submission-${token}`;
    const operationId = `reset-co-speaker-operation-${token}`;
    const communicationId = `reset-co-speaker-communication-${token}`;
    const deliveryId = `reset-co-speaker-delivery-${token}`;
    const operationItemId = `reset-co-speaker-item-${token}`;
    const operationKey = `co-speaker:reset-${token}`;
    await env.DB.batch([
      env.DB.prepare(
        `
        INSERT INTO sender_profiles (
          id, event_id, name, from_name, from_email, reply_to_email,
          provider, status, created_at, updated_at
        ) VALUES (
          ?, ?, 'Submissions E2E local capture', 'Program Cue E2E',
          'submissions-e2e@example.invalid', 'submissions-e2e@example.invalid',
          'resend', 'verified', unixepoch(), unixepoch()
        )
      `,
      ).bind(SENDER_FIXTURE_ID, EVENT_ID),
      env.DB.prepare(
        `
        INSERT INTO submissions (
          id, event_id, form_version_id, submitter_email, public_reference,
          title, status, answers_json, submitted_snapshot_json, submitted_at,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, 'Reset co-speaker application', 'submitted', '{}',
          '{}', unixepoch(), unixepoch(), unixepoch()
        )
      `,
      ).bind(
        submissionId,
        EVENT_ID,
        form.versionId,
        `browser-reset-${token}@example.com`,
        `RESET-${token}`,
      ),
      env.DB.prepare(
        `
        INSERT INTO operation_jobs (
          id, organisation_id, event_id, requested_by_person_id, type,
          idempotency_key, correlation_id, status, payload_json,
          progress_total, progress_completed, progress_failed, cancellable,
          created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, 'communication.send', ?, ?, 'queued', ?, 1, 0, 0, 0,
          unixepoch(), unixepoch()
        )
      `,
      ).bind(
        operationId,
        ORGANISATION_ID,
        EVENT_ID,
        ADMIN_ID,
        operationKey,
        crypto.randomUUID(),
        JSON.stringify({
          type: "communication.send",
          operationId,
          communicationId,
          eventId: EVENT_ID,
          organisationId: ORGANISATION_ID,
          idempotencyKey: operationKey,
        }),
      ),
      env.DB.prepare(
        `
        INSERT INTO communications (
          id, event_id, sender_profile_id, operation_id, idempotency_key,
          kind, channel, status, audience_json, content_snapshot_json,
          recipient_count, queued_at, created_by_person_id, created_at,
          updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, 'transactional', 'email', 'queued', ?, ?, 1,
          unixepoch(), ?, unixepoch(), unixepoch()
        )
      `,
      ).bind(
        communicationId,
        EVENT_ID,
        SENDER_FIXTURE_ID,
        operationId,
        operationKey,
        JSON.stringify({
          type: "co_speaker_invitation",
          submissionId,
        }),
        JSON.stringify({
          schemaVersion: 1,
          category: "co_speaker_invitation",
        }),
        ADMIN_ID,
      ),
      env.DB.prepare(
        `
        INSERT INTO communication_deliveries (
          id, event_id, communication_id, recipient_address, channel,
          provider, idempotency_key, status, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, 'email', 'mailpit', ?, 'queued', unixepoch(), unixepoch()
        )
      `,
      ).bind(
        deliveryId,
        EVENT_ID,
        communicationId,
        `browser-cospeaker-${token}@example.com`,
        `${operationKey}:recipient`,
      ),
      env.DB.prepare(
        `
        INSERT INTO operation_items (
          id, operation_id, item_key, entity_type, entity_id, status, updated_at
        ) VALUES (?, ?, ?, 'communication_delivery', ?, 'pending', unixepoch())
      `,
      ).bind(
        operationItemId,
        operationId,
        `${operationKey}:recipient`,
        deliveryId,
      ),
      env.DB.prepare(
        `
        INSERT INTO event_changes (
          event_id, entity_type, entity_id, change_type, correlation_id,
          created_at
        ) VALUES (?, 'communication', ?, 'created', ?, unixepoch())
      `,
      ).bind(EVENT_ID, communicationId, operationId),
      env.DB.prepare(
        `
        INSERT INTO event_changes (
          event_id, entity_type, entity_id, change_type, created_at
        ) VALUES (?, 'task_instance', ?, 'created', unixepoch())
      `,
      ).bind(EVENT_ID, acknowledgementTaskId),
    ]);

    const otherEventId = `evt-reset-other-${token}`;
    const otherPersonId = `person-reset-other-${token}`;
    const otherSessionId = `session-reset-other-${token}`;
    const otherTemplateId = `resource-ack:resource-reset-other-${token}`;
    const otherTaskId = `${otherTemplateId}:${otherPersonId}`;
    const otherSenderId = `sender-reset-other-${token}`;
    const otherOperationId = `operation-reset-other-${token}`;
    const otherCommunicationId = `communication-reset-other-${token}`;
    await env.DB.batch([
      env.DB.prepare(
        `
        INSERT INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at,
          file_policy_json
        )
        SELECT ?, organisation_id, 'Other reset event', ?, timezone,
               starts_at, ends_at, file_policy_json
          FROM events WHERE id = ?
      `,
      ).bind(otherEventId, `other-reset-${token}`, EVENT_ID),
      env.DB.prepare(
        `
        INSERT INTO people (
          id, email, display_name, email_verified, profile_status,
          created_at, updated_at
        ) VALUES (?, ?, 'Other Sponsor', 1, 'draft', unixepoch(), unixepoch())
      `,
      ).bind(otherPersonId, `sponsor-other-${token}@example.com`),
      env.DB.prepare(
        `
        INSERT INTO sessions (
          id, event_id, title, slug, format, duration_minutes, status,
          created_at, updated_at
        ) VALUES (
          ?, ?, 'Sponsor briefing other event', ?, 'presentation', 30,
          'unscheduled', unixepoch(), unixepoch()
        )
      `,
      ).bind(otherSessionId, otherEventId, `other-session-${token}`),
      env.DB.prepare(
        `
        INSERT INTO session_speakers (
          session_id, event_id, person_id, position, role_label
        ) VALUES (?, ?, ?, 0, 'Primary speaker')
      `,
      ).bind(otherSessionId, otherEventId, otherPersonId),
      env.DB.prepare(
        `
        INSERT INTO task_templates (
          id, event_id, name, target_type, task_type, impact, evidence_mode,
          due_anchor, auto_assign_on_acceptance, configuration_json, status,
          created_at, updated_at
        ) VALUES (
          ?, ?, 'Other resource acknowledgement', 'speaker',
          'acknowledgement', 'medium', 'checkbox', 'none', 0, ?, 'active',
          unixepoch(), unixepoch()
        )
      `,
      ).bind(
        otherTemplateId,
        otherEventId,
        JSON.stringify({ resourcePageId: `resource-reset-other-${token}` }),
      ),
      env.DB.prepare(
        `
        INSERT INTO task_instances (
          id, event_id, template_id, target_type, target_id, owner_person_id,
          title, task_type, impact, status, readiness_state,
          readiness_percent, revision, created_at, updated_at
        ) VALUES (
          ?, ?, ?, 'speaker', ?, ?, 'Other acknowledgement',
          'acknowledgement', 'medium', 'not_started', 'on_track', 0, 1,
          unixepoch(), unixepoch()
        )
      `,
      ).bind(
        otherTaskId,
        otherEventId,
        otherTemplateId,
        otherPersonId,
        otherPersonId,
      ),
      env.DB.prepare(
        `
        INSERT INTO sender_profiles (
          id, event_id, name, from_name, from_email, provider, status,
          created_at, updated_at
        ) VALUES (
          ?, ?, 'Other sender', 'Other sender', ?, 'resend', 'verified',
          unixepoch(), unixepoch()
        )
      `,
      ).bind(
        otherSenderId,
        otherEventId,
        `other-sender-${token}@example.invalid`,
      ),
      env.DB.prepare(
        `
        INSERT INTO operation_jobs (
          id, organisation_id, event_id, requested_by_person_id, type,
          idempotency_key, correlation_id, status, payload_json,
          progress_total, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, 'communication.send', ?, ?, 'queued', ?, 1,
          unixepoch(), unixepoch()
        )
      `,
      ).bind(
        otherOperationId,
        ORGANISATION_ID,
        otherEventId,
        ADMIN_ID,
        `other-operation-${token}`,
        crypto.randomUUID(),
        JSON.stringify({
          type: "communication.send",
          operationId: otherOperationId,
          communicationId: otherCommunicationId,
          eventId: otherEventId,
          organisationId: ORGANISATION_ID,
          idempotencyKey: `other-operation-${token}`,
        }),
      ),
      env.DB.prepare(
        `
        INSERT INTO communications (
          id, event_id, sender_profile_id, operation_id, idempotency_key,
          kind, channel, status, audience_json, content_snapshot_json,
          recipient_count, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?, 'transactional', 'email', 'queued', ?, '{}', 0,
          unixepoch(), unixepoch()
        )
      `,
      ).bind(
        otherCommunicationId,
        otherEventId,
        otherSenderId,
        otherOperationId,
        `other-communication-${token}`,
        JSON.stringify({
          type: "co_speaker_invitation",
          submissionId: `other-submission-${token}`,
        }),
      ),
    ]);

    const busy = await invokeReset(
      "verified_local_capture",
      localCaptureEnvironment(),
    );
    expect(busy.init?.status).toBe(409);
    expect(busy.data).toMatchObject({
      ok: false,
      code: "ACTIVE_SUBMISSION_OPERATIONS",
      activeOperationCount: 1,
    });
    await expect(
      env.DB.prepare("SELECT status FROM operation_jobs WHERE id = ?")
        .bind(operationId)
        .first(),
    ).resolves.toEqual({ status: "queued" });
    await expect(
      env.DB.prepare("SELECT id FROM sessions WHERE id = ?")
        .bind(directSessionId)
        .first(),
    ).resolves.toEqual({ id: directSessionId });

    await env.DB.prepare(
      `
      UPDATE operation_jobs
         SET status = 'completed', progress_completed = progress_total,
             completed_at = unixepoch(), updated_at = unixepoch()
       WHERE id = ? AND event_id = ?
    `,
    )
      .bind(operationId, EVENT_ID)
      .run();
    const completed = await invokeReset(
      "verified_local_capture",
      localCaptureEnvironment(),
    );
    expect(completed.init).toBeNull();
    expect(completed.data).toMatchObject({
      ok: true,
      baseline: {
        versionCount: 2,
        publishedVersionCount: 1,
        draftVersionCount: 1,
        submissionCount: 0,
        senderFixtureConfigured: true,
      },
    });

    for (const [table, id] of [
      ["operation_jobs", operationId],
      ["operation_items", operationItemId],
      ["communications", communicationId],
      ["communication_deliveries", deliveryId],
      ["submissions", submissionId],
      ["sessions", directSessionId],
      ["task_instances", acknowledgementTaskId],
    ] as const) {
      await expect(
        env.DB.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(id).first(),
      ).resolves.toBeNull();
    }
    await expect(
      env.DB.prepare("SELECT id FROM task_instances WHERE id = ?")
        .bind(retainedTaskId)
        .first(),
    ).resolves.toEqual({ id: retainedTaskId });
    await expect(
      env.DB.prepare("SELECT id FROM task_templates WHERE id = ?")
        .bind("resource-ack:resource-speaker-handbook")
        .first(),
    ).resolves.toEqual({ id: "resource-ack:resource-speaker-handbook" });
    await expect(
      env.DB.prepare(
        `
        SELECT id, provider, status, from_email AS fromEmail
          FROM sender_profiles WHERE id = ? AND event_id = ?
      `,
      )
        .bind(SENDER_FIXTURE_ID, EVENT_ID)
        .first(),
    ).resolves.toEqual({
      id: SENDER_FIXTURE_ID,
      provider: "mailpit",
      status: "verified",
      fromEmail: "submissions-e2e@example.invalid",
    });
    await expect(
      env.DB.prepare(
        `
        SELECT
          (SELECT COUNT(*) FROM sessions WHERE id = ?) AS sessionCount,
          (SELECT COUNT(*) FROM task_instances WHERE id = ?) AS taskCount,
          (SELECT COUNT(*) FROM operation_jobs WHERE id = ?) AS operationCount,
          (SELECT COUNT(*) FROM communications WHERE id = ?) AS communicationCount
      `,
      )
        .bind(
          otherSessionId,
          otherTaskId,
          otherOperationId,
          otherCommunicationId,
        )
        .first(),
    ).resolves.toEqual({
      sessionCount: 1,
      taskCount: 1,
      operationCount: 1,
      communicationCount: 1,
    });

    const withoutSender = await invokeReset();
    expect(withoutSender.data).toMatchObject({
      ok: true,
      baseline: { senderFixtureConfigured: false },
    });
    await expect(
      env.DB.prepare("SELECT id FROM sender_profiles WHERE id = ?")
        .bind(SENDER_FIXTURE_ID)
        .first(),
    ).resolves.toBeNull();
  });
});
