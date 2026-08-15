import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { ensureDemoEvaluationData } from "./demo.server";
import {
  EvaluationService,
  EvaluationStateError,
} from "./evaluation-service.server";

const admin: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

const evaluator: Viewer = {
  personId: "person-demo-evaluator",
  name: "Jordan Lee",
  email: "jordan.evaluator@example.com",
  role: "evaluator",
  organisationId: admin.organisationId,
  eventId: admin.eventId,
  demo: true,
};

const target = {
  roundId: "demo-evaluation-round",
  targetType: "submission" as const,
  targetId: "demo-evaluation-submission-calm",
};

describe("evaluation discussion", () => {
  beforeEach(async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    await ensureDemoEvaluationData(testEnv);
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM evaluation_discussion_messages WHERE event_id = ?",
      ).bind(admin.eventId),
      env.DB.prepare(
        `DELETE FROM reviews
          WHERE event_id = ? AND assignment_id LIKE 'demo-evaluation-assignment-%'`,
      ).bind(admin.eventId),
      env.DB.prepare(
        `UPDATE evaluator_assignments
            SET status = 'assigned', submitted_at = NULL
          WHERE event_id = ? AND id LIKE 'demo-evaluation-assignment-%'`,
      ).bind(admin.eventId),
      env.DB.prepare(
        `UPDATE evaluation_rounds SET status = 'active'
          WHERE id = ? AND event_id = ?`,
      ).bind(target.roundId, admin.eventId),
      env.DB.prepare(
        `UPDATE evaluation_plans SET status = 'active'
          WHERE id = 'demo-evaluation-plan' AND event_id = ?`,
      ).bind(admin.eventId),
      env.DB.prepare(
        `DELETE FROM evaluation_rounds
          WHERE id = 'discussion-second-round' AND event_id = ?`,
      ).bind(admin.eventId),
      env.DB.prepare(
        `INSERT OR IGNORE INTO sessions (
           id, event_id, title, slug, description, format, duration_minutes,
           status, visibility, revision, created_at, updated_at
         ) VALUES (
           'discussion-session-target', ?, 'Discussion session target',
           'discussion-session-target', '', 'presentation', 45,
           'unscheduled', 'public', 1, unixepoch(), unixepoch()
         )`,
      ).bind(admin.eventId),
    ]);
  });

  it("opens only after the evaluator submitted the exact assignment", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    const unavailable = await service
      .listDiscussion(evaluator, target)
      .catch((error: unknown) => error);
    expect(unavailable).toBeInstanceOf(Response);
    expect((unavailable as Response).status).toBe(403);

    await env.DB.batch([
      env.DB.prepare(
        `UPDATE evaluator_assignments
            SET status = 'submitted', submitted_at = unixepoch()
          WHERE id = 'demo-evaluation-assignment-1' AND event_id = ?`,
      ).bind(admin.eventId),
      env.DB.prepare(
        `INSERT INTO reviews (
           id, event_id, assignment_id, status, scores_json, revision,
           created_at, updated_at, submitted_at
         ) VALUES (
           'discussion-review', ?, 'demo-evaluation-assignment-1',
           'submitted', '{}', 1, unixepoch(), unixepoch(), unixepoch()
         )`,
      ).bind(admin.eventId),
    ]);

    const input = {
      ...target,
      body: "The evidence is strong, but the delivery plan needs one question.",
      idempotencyKey: crypto.randomUUID(),
    };
    const added = await service.addDiscussionMessage(evaluator, input);
    const replayed = await service.addDiscussionMessage(evaluator, input);
    expect(replayed).toMatchObject({ id: added.id, replayed: true });
    await expect(
      service.addDiscussionMessage(evaluator, {
        ...input,
        body: "A different message must not reuse the same intent.",
      }),
    ).rejects.toThrow(
      "This discussion intent was already used for a different message",
    );

    await expect(
      service.listDiscussion(evaluator, target),
    ).resolves.toMatchObject({
      writable: true,
      messages: [
        {
          id: added.id,
          authorPersonId: evaluator.personId,
          body: input.body,
        },
      ],
    });
    await expect(
      service.listDiscussion(admin, {
        ...target,
        targetId: "demo-evaluation-submission-inclusive",
      }),
    ).resolves.toMatchObject({ messages: [] });

    const concurrentInput = {
      ...target,
      body: "Concurrent retries must converge on one message.",
      idempotencyKey: crypto.randomUUID(),
    };
    const concurrent = await Promise.all([
      service.addDiscussionMessage(evaluator, concurrentInput),
      service.addDiscussionMessage(evaluator, concurrentInput),
    ]);
    expect(new Set(concurrent.map((result) => result.id)).size).toBe(1);
    expect(concurrent.filter((result) => !result.replayed)).toHaveLength(1);

    const audit = await env.DB.prepare(
      `SELECT action, entity_id AS entityId
         FROM audit_events
        WHERE event_id = ? AND entity_id = ?`,
    )
      .bind(admin.eventId, added.id)
      .first<{ action: string; entityId: string }>();
    expect(audit).toEqual({
      action: "evaluation.discussion.message.added",
      entityId: added.id,
    });

    await env.DB.prepare(
      `UPDATE evaluator_assignments
          SET status = 'reopened', submitted_at = NULL
        WHERE id = 'demo-evaluation-assignment-1' AND event_id = ?`,
    )
      .bind(admin.eventId)
      .run();
    const reopened = await service
      .listDiscussion(evaluator, target)
      .catch((error: unknown) => error);
    expect(reopened).toBeInstanceOf(Response);
    expect((reopened as Response).status).toBe(403);
    const replayAfterReopen = await service
      .addDiscussionMessage(evaluator, input)
      .catch((error: unknown) => error);
    expect(replayAfterReopen).toBeInstanceOf(Response);
    expect((replayAfterReopen as Response).status).toBe(403);
  });

  it("keeps rounds isolated and archived threads read-only", async () => {
    const service = new EvaluationService(
      env as unknown as CloudflareEnvironment,
    );
    await service.addDiscussionMessage(admin, {
      ...target,
      body: "This belongs to the initial review only.",
      idempotencyKey: crypto.randomUUID(),
    });
    await service.addDiscussionMessage(admin, {
      roundId: target.roundId,
      targetType: "session",
      targetId: "discussion-session-target",
      body: "This session thread is separate from the proposal thread.",
      idempotencyKey: crypto.randomUUID(),
    });
    await expect(
      service.listDiscussion(admin, {
        roundId: target.roundId,
        targetType: "session",
        targetId: "discussion-session-target",
      }),
    ).resolves.toMatchObject({
      messages: [
        { body: "This session thread is separate from the proposal thread." },
      ],
    });
    await env.DB.prepare(
      `INSERT INTO evaluation_rounds (
         id, event_id, plan_id, round_number, name, status,
         blinded_reviewing, scorecard_id, scorecard_version,
         advancement_rule_json, revision, created_at, updated_at
       ) VALUES (
         'discussion-second-round', ?, 'demo-evaluation-plan', 2,
         'Final review', 'active', 1, 'discussion-second-round', 1,
         '{}', 1, unixepoch(), unixepoch()
       )`,
    )
      .bind(admin.eventId)
      .run();

    await expect(
      service.listDiscussion(admin, {
        ...target,
        roundId: "discussion-second-round",
      }),
    ).resolves.toMatchObject({ messages: [] });

    await env.DB.prepare(
      "UPDATE evaluation_rounds SET status = 'archived' WHERE id = ? AND event_id = ?",
    )
      .bind(target.roundId, admin.eventId)
      .run();
    await expect(service.listDiscussion(admin, target)).resolves.toMatchObject({
      writable: false,
      messages: [{ body: "This belongs to the initial review only." }],
    });
    await expect(
      service.addDiscussionMessage(admin, {
        ...target,
        body: "This must not be added after archival.",
        idempotencyKey: crypto.randomUUID(),
      }),
    ).rejects.toBeInstanceOf(EvaluationStateError);

    await expect(
      service.listDiscussion(
        { ...admin, organisationId: "another-organisation" },
        target,
      ),
    ).rejects.toThrow("Event not found in the authorised organisation");
  });
});
