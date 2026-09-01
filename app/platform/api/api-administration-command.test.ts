import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
import { ensureEvaluationDecisionTemplateFixture } from "~/modules/evaluations/evaluation-test-fixtures";
import { ScheduleService } from "~/modules/schedule/schedule-service.server";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import { SubmissionService } from "~/modules/submissions/submission-service.server";
import { apiRequestHash } from "~/platform/api/api.server";
import { ApiParticipantService } from "~/platform/api/api-participant-service.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import {
  ensureDemoData,
  ensureDemoProgramme,
} from "~/platform/demo/seed.server";
import { encryptWebhookSecret } from "~/platform/operations/webhook-crypto.server";
import { action as administrationAction } from "~/routes/api-administration-command";
import { action as participantTaskAction } from "~/routes/api-participant-task-completion";

const queuedOperations: unknown[] = [];
const testEnv = {
  ...(env as unknown as CloudflareEnvironment),
  OPERATIONS_QUEUE: {
    send: async (message: unknown) => queuedOperations.push(message),
  },
} as unknown as CloudflareEnvironment;
const eventId = "evt-foe-2025";
const administrator = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator" as const,
  organisationId: "org-future-events",
  eventId,
  demo: true,
};

function context(environment: CloudflareEnvironment = testEnv) {
  const provider = new RouterContextProvider();
  provider.set(cloudflareContext, {
    env: environment,
    ctx: {} as ExecutionContext,
  });
  return provider;
}

function headers(
  role: "owner" | "administrator" | "speaker",
  idempotencyKey: string,
  origin = "https://programcue.test",
) {
  return new Headers({
    cookie: `program_cue_demo_identity=${role}`,
    origin,
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
  });
}

async function command(
  role: "owner" | "administrator",
  family: string,
  itemId: string,
  commandName: string,
  body: unknown,
  idempotencyKey: string,
  environment: CloudflareEnvironment = testEnv,
) {
  return administrationAction({
    request: new Request(
      `https://programcue.test/api/v1/events/${eventId}/administration/${family}/${itemId}/${commandName}`,
      {
        method: "POST",
        headers: headers(role, idempotencyKey),
        body: JSON.stringify(body),
      },
    ),
    params: {
      eventId,
      family,
      itemId,
      command: commandName,
    },
    context: context(environment),
  } as never);
}

async function result(response: Response) {
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as {
    result: Record<string, unknown>;
    correlationId: string;
  };
}

beforeEach(async () => {
  vi.restoreAllMocks();
  queuedOperations.length = 0;
  await ensureDemoData(testEnv);
  await ensureDemoSpeakerData(testEnv);
  await ensureDemoProgramme(testEnv);
  await ensureDemoEvaluationData(testEnv);
  await ensureEvaluationDecisionTemplateFixture(
    testEnv.DB,
    eventId,
    administrator.personId,
  );
});

describe("versioned administration commands", () => {
  it("rejects cross-origin mutation before dispatch", async () => {
    const response = await administrationAction({
      request: new Request(
        `https://programcue.test/api/v1/events/${eventId}/administration/forms/new/save`,
        {
          method: "POST",
          headers: headers(
            "administrator",
            `cross-origin-${crypto.randomUUID()}`,
            "https://attacker.test",
          ),
          body: "{}",
        },
      ),
      params: { eventId, family: "forms", itemId: "new", command: "save" },
      context: context(),
    } as never);
    expect(response.status).toBe(403);
  });

  it("saves and publishes forms and resources with exact replay and hash rejection", async () => {
    const suffix = crypto.randomUUID();
    const formInput = {
      ...(await new SubmissionService(testEnv).getDefaultFormInput({
        ...administrator,
      })),
      name: `API form ${suffix}`,
      publicSlug: `api-form-${suffix}`,
    };
    const undeclaredFormField = await command(
      "administrator",
      "forms",
      "new",
      "save",
      { ...formInput, undeclaredCredential: "must-not-be-accepted" },
      `form-strict-${suffix}`,
    );
    expect(undeclaredFormField.status).toBe(422);
    const undeclaredNestedFormField = await command(
      "administrator",
      "forms",
      "new",
      "save",
      {
        ...formInput,
        schema: {
          ...formInput.schema,
          fields: formInput.schema.fields.map((field, index) =>
            index === 0
              ? { ...field, undeclaredCredential: "must-not-be-accepted" }
              : field,
          ),
        },
      },
      `form-nested-strict-${suffix}`,
    );
    expect(undeclaredNestedFormField.status).toBe(422);
    const requiredOmitted = await command(
      "administrator",
      "forms",
      "new",
      "save",
      {
        ...formInput,
        schema: {
          ...formInput.schema,
          fields: formInput.schema.fields.map((field) => {
            if (field.id !== "description") return field;
            const { required: _required, ...withoutRequired } = field;
            return withoutRequired;
          }),
        },
      },
      `form-required-explicit-${suffix}`,
    );
    expect(requiredOmitted.status).toBe(422);
    const visibilityOmitted = await command(
      "administrator",
      "forms",
      "new",
      "save",
      {
        ...formInput,
        schema: {
          ...formInput.schema,
          fields: formInput.schema.fields.map((field) => {
            if (field.id !== "description") return field;
            const { reviewVisibility: _visibility, ...withoutVisibility } =
              field;
            return withoutVisibility;
          }),
        },
      },
      `form-visibility-explicit-${suffix}`,
    );
    expect(visibilityOmitted.status).toBe(422);
    const { categories: _categories, ...routingWithoutCategories } =
      formInput.routing;
    const categoriesOmitted = await command(
      "administrator",
      "forms",
      "new",
      "save",
      { ...formInput, routing: routingWithoutCategories },
      `form-routing-explicit-${suffix}`,
    );
    expect(categoriesOmitted.status).toBe(422);
    const formKey = `form-save-${suffix}`;
    const firstForm = await result(
      await command(
        "administrator",
        "forms",
        "new",
        "save",
        formInput,
        formKey,
      ),
    );
    expect(firstForm.result).toMatchObject({
      replayed: false,
      status: "draft",
      revision: 1,
      draftRevision: 1,
    });
    const formId = String(firstForm.result.formId);
    const replayedForm = await result(
      await command(
        "administrator",
        "forms",
        "new",
        "save",
        formInput,
        formKey,
      ),
    );
    expect(replayedForm.result).toMatchObject({ formId, replayed: true });
    const reused = await command(
      "administrator",
      "forms",
      "new",
      "save",
      { ...formInput, name: `${formInput.name} changed` },
      formKey,
    );
    expect(reused.status).toBe(409);

    const publishedForm = await result(
      await command(
        "administrator",
        "forms",
        formId,
        "publish",
        {
          formRevision: firstForm.result.revision,
          draftRevision: firstForm.result.draftRevision,
        },
        `form-publish-${suffix}`,
      ),
    );
    expect(publishedForm.result).toMatchObject({
      formId,
      status: "published",
      replayed: false,
    });

    const resourceInput = {
      title: `API resource ${suffix}`,
      slug: `api-resource-${suffix}`,
      category: "Preparation",
      audienceScope: "all_speakers",
      audiencePersonIds: [],
      acknowledgementRequired: false,
      document: {
        type: "doc",
        content: [{ type: "paragraph" }],
      },
    };
    const undeclaredResourceField = await command(
      "administrator",
      "resources",
      "new",
      "save",
      { ...resourceInput, undeclaredCredential: "must-not-be-accepted" },
      `resource-strict-${suffix}`,
    );
    expect(undeclaredResourceField.status).toBe(422);
    const savedResource = await result(
      await command(
        "administrator",
        "resources",
        "new",
        "save",
        resourceInput,
        `resource-save-${suffix}`,
      ),
    );
    expect(savedResource.result).toMatchObject({
      status: "draft",
      revision: 1,
    });
    const pageId = String(savedResource.result.pageId);
    const publishedResource = await result(
      await command(
        "administrator",
        "resources",
        pageId,
        "publish",
        { revision: savedResource.result.revision },
        `resource-publish-${suffix}`,
      ),
    );
    expect(publishedResource.result).toMatchObject({
      pageId,
      status: "published",
    });
  });

  it("creates and assigns a task, then replays one participant completion", async () => {
    const suffix = crypto.randomUUID();
    const template = await result(
      await command(
        "administrator",
        "task-templates",
        "new",
        "save",
        {
          name: `API checklist ${suffix}`,
          description: "Confirm the API task requirement.",
          targetType: "speaker",
          taskType: "checklist",
          impact: "high",
          evidenceMode: "checkbox",
          dueAnchor: "none",
          dueOffsetDays: null,
          fixedDueDate: null,
          autoAssignOnAcceptance: false,
          dependencyIds: [],
        },
        `task-template-${suffix}`,
      ),
    );
    const assignmentKey = `task-assignment-${suffix}`;
    const assignmentBody = {
      templateId: template.result.templateId,
      targetId: "person-demo-speaker",
    };
    const assignment = await result(
      await command(
        "administrator",
        "task-assignments",
        "new",
        "assign",
        assignmentBody,
        assignmentKey,
      ),
    );
    const taskId = String(assignment.result.taskId);
    expect(taskId).toMatch(/^task:/u);
    const replayedAssignment = await result(
      await command(
        "administrator",
        "task-assignments",
        "new",
        "assign",
        assignmentBody,
        assignmentKey,
      ),
    );
    expect(replayedAssignment.result).toMatchObject({ taskId, replayed: true });

    const completionKey = `task-completion-${suffix}`;
    const complete = () =>
      participantTaskAction({
        request: new Request(
          `https://programcue.test/api/v1/events/${eventId}/participant/tasks/${taskId}/complete`,
          {
            method: "POST",
            headers: headers("speaker", completionKey),
            body: JSON.stringify({ taskId, revision: 1, confirmed: true }),
          },
        ),
        params: { eventId, taskId },
        context: context(),
      } as never);
    const completed = await result(await complete());
    expect(completed.result).toEqual({
      taskId,
      status: "completed",
      revision: 2,
      replayed: false,
    });
    const replayed = await result(await complete());
    expect(replayed.result).toEqual({
      taskId,
      status: "completed",
      revision: 2,
      replayed: true,
    });

    const committed = await testEnv.DB.prepare(
      `SELECT last_operation_id AS operationId
         FROM task_instances WHERE id = ? AND event_id = ?`,
    )
      .bind(taskId, eventId)
      .first<{ operationId: string }>();
    const speaker = {
      personId: "person-demo-speaker",
      name: "Priya Shah",
      email: "priya.speaker@example.com",
      role: "speaker" as const,
      organisationId: "org-future-events",
      eventId,
      demo: true,
    };
    const recovery = new ApiParticipantService(testEnv);
    await expect(
      recovery.recoverTaskCompletion(
        speaker,
        taskId,
        1,
        committed!.operationId,
      ),
    ).resolves.toEqual({ taskId, status: "completed", revision: 2 });
    for (const [viewer, previousRevision] of [
      [{ ...speaker, personId: "person-demo-submitter" }, 1],
      [{ ...speaker, organisationId: "org-other" }, 1],
      [{ ...speaker, eventId: "event-other" }, 1],
      [speaker, 2],
    ] as const) {
      await expect(
        recovery.recoverTaskCompletion(
          viewer,
          taskId,
          previousRevision,
          committed!.operationId,
        ),
      ).resolves.toBeNull();
    }
  });

  it("returns and replays a participant submission awaiting administrator approval", async () => {
    const suffix = crypto.randomUUID();
    const template = await result(
      await command(
        "administrator",
        "task-templates",
        "new",
        "save",
        {
          name: `API approval task ${suffix}`,
          description: "Submit this requirement for administrator approval.",
          targetType: "speaker",
          taskType: "checklist",
          impact: "high",
          evidenceMode: "admin_approval",
          dueAnchor: "none",
          dueOffsetDays: null,
          fixedDueDate: null,
          autoAssignOnAcceptance: false,
          dependencyIds: [],
        },
        `approval-template-${suffix}`,
      ),
    );
    const assignment = await result(
      await command(
        "administrator",
        "task-assignments",
        "new",
        "assign",
        {
          templateId: template.result.templateId,
          targetId: "person-demo-speaker",
        },
        `approval-assignment-${suffix}`,
      ),
    );
    const taskId = String(assignment.result.taskId);
    const idempotencyKey = `approval-completion-${suffix}`;
    const complete = () =>
      participantTaskAction({
        request: new Request(
          `https://programcue.test/api/v1/events/${eventId}/participant/tasks/${taskId}/complete`,
          {
            method: "POST",
            headers: headers("speaker", idempotencyKey),
            body: JSON.stringify({ taskId, revision: 1, confirmed: true }),
          },
        ),
        params: { eventId, taskId },
        context: context(),
      } as never);

    await expect(result(await complete())).resolves.toMatchObject({
      result: { taskId, status: "submitted", revision: 2, replayed: false },
    });
    await expect(result(await complete())).resolves.toMatchObject({
      result: { taskId, status: "submitted", revision: 2, replayed: true },
    });
  });

  it("recovers the canonical session-review preset and rejects drifted preset claims", async () => {
    const suffix = crypto.randomUUID();
    const presetInput = {
      name: "Review session details",
      description:
        "Review the shared session title, description, format, duration and track. Any active session participant may confirm them for the session or leave a correction comment.",
      targetType: "session",
      taskType: "acknowledgement",
      impact: "high",
      evidenceMode: "checkbox",
      dueAnchor: "none",
      dueOffsetDays: null,
      fixedDueDate: null,
      autoAssignOnAcceptance: true,
      dependencyIds: [],
      configuration: { preset: "session_details_review_v1" },
    };
    const rejected = await command(
      "administrator",
      "task-templates",
      "new",
      "save",
      { ...presetInput, impact: "low" },
      `session-review-drift-${suffix}`,
    );
    expect(rejected.status).toBe(422);

    const idempotencyKey = `session-review-${suffix}`;
    const created = await result(
      await command(
        "administrator",
        "task-templates",
        "new",
        "save",
        presetInput,
        idempotencyKey,
      ),
    );
    const templateId = String(created.result.templateId);
    expect(templateId).toContain("preset:session-details-review:v1");
    const reset = await testEnv.DB.prepare(
      `UPDATE idempotency_records
          SET status = 'processing', response_json = NULL, completed_at = NULL
        WHERE event_id = ? AND actor_id = ? AND scope = 'api.task-template.save'
          AND idempotency_key = ? AND status = 'completed'`,
    )
      .bind(eventId, `person:${administrator.personId}`, idempotencyKey)
      .run();
    expect(reset.meta.changes).toBe(1);

    const recovered = await result(
      await command(
        "administrator",
        "task-templates",
        "new",
        "save",
        presetInput,
        idempotencyKey,
      ),
    );
    expect(recovered.result).toEqual({ templateId, replayed: true });

    const conflicting = await command(
      "administrator",
      "task-templates",
      "new",
      "save",
      { ...presetInput, name: "A different session review request" },
      `session-review-conflict-${suffix}`,
    );
    expect(conflicting.status).toBe(409);
    await expect(conflicting.json()).resolves.toMatchObject({
      error: { code: "TASK_STATE_ERROR" },
    });
  });

  it("recovers a committed shared-session completion after cancellation", async () => {
    const speaker = {
      personId: "person-demo-speaker",
      name: "Priya Shah",
      email: "priya.speaker@example.com",
      role: "speaker" as const,
      organisationId: "org-future-events",
      eventId,
      demo: true,
    };
    const relationship = await testEnv.DB.prepare(
      `SELECT session_id AS sessionId FROM session_speakers
        WHERE event_id = ? AND person_id = ? LIMIT 1`,
    )
      .bind(eventId, speaker.personId)
      .first<{ sessionId: string }>();
    if (!relationship) throw new Error("Demo session relationship is missing.");
    const session = await testEnv.DB.prepare(
      `SELECT status FROM sessions WHERE id = ? AND event_id = ?`,
    )
      .bind(relationship.sessionId, eventId)
      .first<{ status: string }>();
    if (!session) throw new Error("Demo session is missing.");
    const taskId = `cancelled-review-recovery-${crypto.randomUUID()}`;
    const operationId = `cancelled-review-operation-${crypto.randomUUID()}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO task_instances (
           id, event_id, target_type, target_id, title, task_type, impact,
           evidence_mode, configuration_json, status, readiness_state,
           readiness_percent, revision, last_operation_id,
           completed_by_person_id, completed_at
         ) VALUES (?, ?, 'session', ?, 'Review session details',
                   'acknowledgement', 'high', 'checkbox',
                   '{"preset":"session_details_review_v1"}', 'completed',
                   'on_track', 100, 2, ?, ?, unixepoch())`,
      ).bind(
        taskId,
        eventId,
        relationship.sessionId,
        operationId,
        speaker.personId,
      ),
      testEnv.DB.prepare(
        `UPDATE sessions SET status = 'cancelled', updated_at = unixepoch()
          WHERE id = ? AND event_id = ?`,
      ).bind(relationship.sessionId, eventId),
    ]);

    try {
      const recovery = new ApiParticipantService(testEnv);
      await expect(
        recovery.recoverTaskCompletion(speaker, taskId, 1, operationId),
      ).resolves.toEqual({ taskId, status: "completed", revision: 2 });
      await expect(
        recovery.recoverTaskCompletion(
          { ...speaker, personId: "person-demo-submitter" },
          taskId,
          1,
          operationId,
        ),
      ).resolves.toBeNull();
    } finally {
      await testEnv.DB.prepare(
        `UPDATE sessions SET status = ?, updated_at = unixepoch()
          WHERE id = ? AND event_id = ?`,
      )
        .bind(session.status, relationship.sessionId, eventId)
        .run();
    }
  });

  it("persists people, session and decision lifecycle commands without synthesising delivery", async () => {
    const suffix = crypto.randomUUID();
    const invited = await result(
      await command(
        "owner",
        "people",
        "new",
        "invite",
        {
          name: "API administrator",
          email: `api-admin-${suffix}@example.com`,
          scope: "event",
        },
        `person-invite-${suffix}`,
      ),
    );
    expect(invited.result).toMatchObject({
      status: "invited",
      scope: "event",
    });
    const membershipId = String(invited.result.membershipId);
    const revoked = await result(
      await command(
        "owner",
        "memberships",
        membershipId,
        "revoke",
        { membershipId, confirmed: true },
        `membership-revoke-${suffix}`,
      ),
    );
    expect(revoked.result).toMatchObject({
      membershipId,
      status: "revoked",
    });

    const schedule = new ScheduleService(testEnv);
    await schedule.createDraft(administrator, `api-session-draft-${suffix}`);
    const workspace = await schedule.getWorkspace(administrator);
    const editableSession = workspace.sessions[0];
    expect(workspace.version?.status).toBe("draft");
    expect(editableSession).toBeTruthy();
    const sessionWebhookEndpointId = `api-session-hook-${suffix}`;
    await testEnv.DB.prepare(
      `INSERT INTO webhook_endpoints (
         id, organisation_id, event_id, name, url, secret_ciphertext,
         event_types_json, status, created_by_person_id
       ) VALUES (?, ?, ?, 'API session updates',
                 'https://hooks.example.com/api-session', 'test-only',
                 '["session.updated"]', 'active', ?)`,
    )
      .bind(
        sessionWebhookEndpointId,
        administrator.organisationId,
        eventId,
        administrator.personId,
      )
      .run();
    const editKey = crypto.randomUUID();
    const edited = await result(
      await command(
        "administrator",
        "sessions",
        editableSession!.id,
        "edit",
        {
          scheduleVersionId: workspace.version!.id,
          scheduleRevision: workspace.version!.revision,
          sessionId: editableSession!.id,
          sessionRevision: editableSession!.revision,
          idempotencyKey: editKey,
          title: `${editableSession!.title} API edit`,
          description: editableSession!.description,
          format: editableSession!.format,
          durationMinutes: editableSession!.durationMinutes,
          trackId: editableSession!.trackId,
          visibility: editableSession!.visibility,
          requiredResources: editableSession!.requiredResources,
        },
        editKey,
      ),
    );
    expect(edited.result).toMatchObject({
      sessionId: editableSession!.id,
      revision: editableSession!.revision + 1,
    });
    await expect(
      testEnv.DB.prepare(
        `SELECT origin FROM audit_events
          WHERE event_id = ? AND entity_id = ?
            AND action = 'session.content.updated'`,
      )
        .bind(eventId, editableSession!.id)
        .first(),
    ).resolves.toEqual({ origin: "api" });
    await expect(
      testEnv.DB.prepare(
        `SELECT audit.origin
           FROM webhook_deliveries delivery
           JOIN audit_events audit
             ON audit.entity_type = 'webhook_delivery'
            AND audit.entity_id = delivery.id
            AND audit.action = 'webhook.queued'
          WHERE delivery.endpoint_id = ?
            AND delivery.event_type = 'session.updated'
            AND delivery.entity_id = ?`,
      )
        .bind(sessionWebhookEndpointId, editableSession!.id)
        .first(),
    ).resolves.toEqual({ origin: "api" });

    const sessionId = `api-lifecycle-${suffix}`;
    await testEnv.DB.prepare(
      `INSERT INTO sessions (
         id, event_id, title, slug, format, duration_minutes, status, visibility
       ) VALUES (?, ?, ?, ?, 'presentation', 30, 'cancelled', 'public')`,
    )
      .bind(sessionId, eventId, `API lifecycle ${suffix}`, sessionId)
      .run();
    const archived = await result(
      await command(
        "administrator",
        "sessions",
        sessionId,
        "archive",
        { confirmed: true },
        `session-archive-${suffix}`,
      ),
    );
    expect(archived.result).toMatchObject({
      action: "archive",
      changedCount: 1,
    });
    const restored = await result(
      await command(
        "administrator",
        "sessions",
        sessionId,
        "restore",
        { confirmed: true },
        `session-restore-${suffix}`,
      ),
    );
    expect(restored.result).toMatchObject({
      action: "restore",
      changedCount: 1,
    });
    await expect(
      testEnv.DB.prepare(
        "SELECT status FROM sessions WHERE id = ? AND event_id = ?",
      )
        .bind(sessionId, eventId)
        .first(),
    ).resolves.toEqual({ status: "cancelled" });

    const decision = await result(
      await command(
        "administrator",
        "decisions",
        "demo-evaluation-submission-calm",
        "draft",
        {
          submissionId: "demo-evaluation-submission-calm",
          decision: "rejected",
          rationale: "Not selected for this programme.",
          confirmedWithoutReview: true,
          sessionDurationMinutes: null,
          confirmed: true,
        },
        `decision-draft-${suffix}`,
      ),
    );
    expect(decision.result).toMatchObject({
      decision: "rejected",
      status: "draft",
    });
    const released = await result(
      await command(
        "administrator",
        "decisions",
        "demo-evaluation-submission-inclusive",
        "release",
        {
          submissionId: "demo-evaluation-submission-inclusive",
          decision: "rejected",
          rationale: "The released programme decision.",
          confirmedWithoutReview: true,
          sessionDurationMinutes: null,
          confirmed: true,
        },
        `decision-release-${suffix}`,
      ),
    );
    expect(released.result).toMatchObject({
      decision: "rejected",
      status: "published",
    });
    expect(queuedOperations).toContainEqual(
      expect.objectContaining({ type: "decision.notification" }),
    );
  });

  it("validates integration connections and protects replayable webhook secrets", async () => {
    const suffix = crypto.randomUUID();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ data: [] })),
    );
    await testEnv.DB.prepare(
      "DELETE FROM integration_connections WHERE event_id = ?",
    )
      .bind(eventId)
      .run();
    const connected = await result(
      await command(
        "administrator",
        "integration-connections",
        "new",
        "connect",
        {
          provider: "accelevents",
          apiKey: `test-key-${suffix}`,
          eventUrl: `event-${suffix}`,
          externalEventId: 1234,
          sessionTypeFormat: "IN_PERSON",
        },
        `integration-connect-${suffix}`,
      ),
    );
    expect(connected.result).toMatchObject({
      status: "connected",
      replayed: false,
    });
    const connectionId = String(connected.result.connectionId);
    const session = await testEnv.DB.prepare(
      "SELECT id FROM sessions WHERE event_id = ? ORDER BY id LIMIT 1",
    )
      .bind(eventId)
      .first<{ id: string }>();
    expect(session).toBeTruthy();
    const mappingBody = {
      entityType: "session",
      entityId: session!.id,
      externalId: `external-${suffix}`,
      sourceHash: "a".repeat(64),
      metadata: { source: "api-test" },
    };
    const mapping = await result(
      await command(
        "administrator",
        "integration-mappings",
        connectionId,
        "save",
        mappingBody,
        `mapping-save-${suffix}`,
      ),
    );
    expect(mapping.result.mappingId).toBeTruthy();
    await result(
      await command(
        "administrator",
        "integration-mappings",
        connectionId,
        "delete",
        {
          entityType: mappingBody.entityType,
          entityId: mappingBody.entityId,
          confirmed: true,
        },
        `mapping-delete-${suffix}`,
      ),
    );

    await testEnv.DB.prepare("DELETE FROM webhook_endpoints WHERE event_id = ?")
      .bind(eventId)
      .run();
    const queued: unknown[] = [];
    const environment = {
      ...testEnv,
      OPERATIONS_QUEUE: {
        send: async (message: unknown) => queued.push(message),
      },
    } as unknown as CloudflareEnvironment;
    const webhookKey = `webhook-save-${suffix}`;
    const webhookBody = {
      name: `API webhook ${suffix}`,
      url: "https://hooks.example.com/program-cue",
      eventTypes: ["task.updated"],
    };
    const webhook = await result(
      await command(
        "administrator",
        "webhook-endpoints",
        "new",
        "save",
        webhookBody,
        webhookKey,
        environment,
      ),
    );
    const endpointId = String(webhook.result.endpointId);
    const secret = String(webhook.result.secret);
    expect(secret.length).toBeGreaterThan(20);
    const replayedWebhook = await result(
      await command(
        "administrator",
        "webhook-endpoints",
        "new",
        "save",
        webhookBody,
        webhookKey,
        environment,
      ),
    );
    expect(replayedWebhook.result).toMatchObject({
      endpointId,
      secret,
      replayed: true,
    });
    const stored = await testEnv.DB.prepare(
      `SELECT endpoint.secret_ciphertext AS ciphertext,
              idempotency.response_json AS responseJson
         FROM webhook_endpoints endpoint
         JOIN idempotency_records idempotency
           ON idempotency.id = endpoint.last_operation_id
        WHERE endpoint.id = ? AND endpoint.event_id = ?`,
    )
      .bind(endpointId, eventId)
      .first<{ ciphertext: string; responseJson: string }>();
    expect(stored).not.toBeNull();
    expect(stored!.ciphertext).not.toContain(secret);
    expect(stored!.responseJson).not.toContain(secret);
    expect(stored!.responseJson).not.toContain(stored!.ciphertext);

    await testEnv.DB.prepare(
      `UPDATE idempotency_records
          SET response_json = ?
        WHERE id = (SELECT last_operation_id FROM webhook_endpoints WHERE id = ?)`,
    )
      .bind(
        JSON.stringify({
          endpointId,
          secretFingerprint: await apiRequestHash(stored!.ciphertext),
        }),
        endpointId,
      )
      .run();
    const legacyReplay = await result(
      await command(
        "administrator",
        "webhook-endpoints",
        "new",
        "save",
        webhookBody,
        webhookKey,
        environment,
      ),
    );
    expect(legacyReplay.result).toMatchObject({
      endpointId,
      secret,
      replayed: true,
    });
    await testEnv.DB.prepare(
      `UPDATE idempotency_records
          SET response_json = ?
        WHERE id = (SELECT last_operation_id FROM webhook_endpoints WHERE id = ?)`,
    )
      .bind(
        JSON.stringify({
          endpointId,
          secretFingerprint: await apiRequestHash(secret),
          secretFingerprintVersion: 2,
        }),
        endpointId,
      )
      .run();

    const rewrappedCiphertext = await encryptWebhookSecret(
      secret,
      endpointId,
      environment.WEBHOOK_CREDENTIALS_KEY,
    );
    await testEnv.DB.prepare(
      `UPDATE webhook_endpoints
          SET secret_ciphertext = ?, updated_at = unixepoch()
        WHERE id = ? AND event_id = ?`,
    )
      .bind(rewrappedCiphertext, endpointId, eventId)
      .run();
    const replayedAfterRewrap = await result(
      await command(
        "administrator",
        "webhook-endpoints",
        "new",
        "save",
        webhookBody,
        webhookKey,
        environment,
      ),
    );
    expect(replayedAfterRewrap.result).toMatchObject({
      endpointId,
      secret,
      replayed: true,
    });

    const testKey = `webhook-test-${suffix}`;
    const tested = await result(
      await command(
        "administrator",
        "webhook-endpoints",
        endpointId,
        "test",
        { confirmed: true },
        testKey,
        environment,
      ),
    );
    expect(tested.result.status).toBe("queued");
    await result(
      await command(
        "administrator",
        "webhook-endpoints",
        endpointId,
        "test",
        { confirmed: true },
        testKey,
        environment,
      ),
    );
    expect(queued).toHaveLength(1);

    const rotated = await result(
      await command(
        "administrator",
        "webhook-endpoints",
        endpointId,
        "rotate-secret",
        { confirmed: true },
        `webhook-rotate-${suffix}`,
        environment,
      ),
    );
    const rotatedSecret = String(rotated.result.secret);
    expect(rotatedSecret).not.toBe(secret);
    const originalAfterRotation = await command(
      "administrator",
      "webhook-endpoints",
      "new",
      "save",
      webhookBody,
      webhookKey,
      environment,
    );
    expect(originalAfterRotation.status).toBe(409);
    await expect(originalAfterRotation.json()).resolves.toMatchObject({
      error: { code: "WEBHOOK_SECRET_SUPERSEDED" },
    });
    const secondRotationKey = `webhook-rotate-second-${suffix}`;
    const secondRotation = await result(
      await command(
        "administrator",
        "webhook-endpoints",
        endpointId,
        "rotate-secret",
        { confirmed: true },
        secondRotationKey,
        environment,
      ),
    );
    expect(secondRotation.result.secret).not.toBe(rotatedSecret);
    const firstRotationReplay = await command(
      "administrator",
      "webhook-endpoints",
      endpointId,
      "rotate-secret",
      { confirmed: true },
      `webhook-rotate-${suffix}`,
      environment,
    );
    expect(firstRotationReplay.status).toBe(409);
    await expect(firstRotationReplay.json()).resolves.toMatchObject({
      error: { code: "WEBHOOK_SECRET_SUPERSEDED" },
    });
    await result(
      await command(
        "administrator",
        "webhook-endpoints",
        endpointId,
        "status",
        { status: "disabled" },
        `webhook-status-${suffix}`,
        environment,
      ),
    );
    await result(
      await command(
        "administrator",
        "integration-connections",
        connectionId,
        "disconnect",
        { confirmed: true },
        `integration-disconnect-${suffix}`,
      ),
    );
  });

  it("rejects enabling a webhook whose signing secret was erased", async () => {
    const suffix = crypto.randomUUID();
    const created = await result(
      await command(
        "administrator",
        "webhook-endpoints",
        "new",
        "save",
        {
          name: `Erased webhook ${suffix}`,
          url: "https://hooks.example.com/erased",
          eventTypes: ["task.updated"],
        },
        `webhook-erased-save-${suffix}`,
      ),
    );
    const endpointId = String(created.result.endpointId);
    await testEnv.DB.prepare(
      `UPDATE webhook_endpoints
          SET status = 'disabled', secret_ciphertext = 'retained-' || id
        WHERE id = ? AND event_id = ?`,
    )
      .bind(endpointId, eventId)
      .run();

    const enabled = await command(
      "administrator",
      "webhook-endpoints",
      endpointId,
      "status",
      { status: "active" },
      `webhook-erased-enable-${suffix}`,
    );
    expect(enabled.status).toBe(409);
    await expect(enabled.json()).resolves.toMatchObject({
      error: {
        code: "WEBHOOK_ENDPOINT_CREDENTIALS_ERASED",
        message:
          "This webhook endpoint's signing secret was erased during participant retention. Rotate the secret or create a new endpoint before enabling it.",
      },
    });
    await expect(
      testEnv.DB.prepare(
        "SELECT status FROM webhook_endpoints WHERE id = ? AND event_id = ?",
      )
        .bind(endpointId, eventId)
        .first(),
    ).resolves.toEqual({ status: "disabled" });
  });
});
