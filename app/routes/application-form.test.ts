import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { ensureDemoSubmissionForm } from "~/modules/submissions/demo-submissions.server";
import { verifyApplicationNotice } from "~/modules/submissions/application-notice.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  action,
  claimApplicantVideoUploadOperation,
  loader,
} from "./application-form";

function context(
  environment: CloudflareEnvironment = env as unknown as CloudflareEnvironment,
) {
  const provider = new RouterContextProvider();
  provider.set(cloudflareContext, {
    env: environment,
    ctx: {} as ExecutionContext,
  });
  return provider;
}

beforeEach(async () => {
  const testEnv = env as unknown as CloudflareEnvironment;
  await ensureDemoData(testEnv);
  await ensureDemoSubmissionForm(testEnv);
  await env.DB.prepare(
    `UPDATE events SET allow_anonymous_drafts = 1
      WHERE id = 'evt-foe-2025'`,
  ).run();
});

describe("public application mutations", () => {
  it("keeps published programme navigation independent of the speaker showcase", async () => {
    const publishedVersion = await env.DB.prepare(
      `SELECT id, schema_json AS schemaJson
         FROM form_versions
        WHERE event_id = 'evt-foe-2025' AND status = 'published'
        ORDER BY version_number DESC
        LIMIT 1`,
    ).first<{ id: string; schemaJson: string }>();
    if (!publishedVersion) throw new Error("Published demo form is missing.");

    const schema = JSON.parse(publishedVersion.schemaJson) as {
      presentation: { showFeaturedSpeakers: boolean };
    };
    schema.presentation.showFeaturedSpeakers = false;
    await env.DB.prepare(
      `UPDATE form_versions SET schema_json = ? WHERE id = ?`,
    )
      .bind(JSON.stringify(schema), publishedVersion.id)
      .run();

    const result = await loader({
      request: new Request("http://localhost/apply/form"),
      params: { slug: "form" },
      context: context(),
    } as never);
    if (result instanceof Response || "data" in result) {
      throw new Error("Expected the public application landing payload.");
    }

    expect(result.programmeUrl).toBe("/public/programme/future-of-events-2025");
    expect(result.featuredSpeakers).toEqual([]);
  });

  it("admits one applicant video upload operation and blocks sessions awaiting cleanup", () => {
    const uploadOperation: { current: symbol | null } = { current: null };
    const cancellationOperation: { current: symbol | null } = {
      current: null,
    };

    const first = claimApplicantVideoUploadOperation(
      uploadOperation,
      cancellationOperation,
      false,
    );
    expect(first).toBeTypeOf("symbol");
    expect(
      claimApplicantVideoUploadOperation(
        uploadOperation,
        cancellationOperation,
        false,
      ),
    ).toBeNull();

    uploadOperation.current = null;
    expect(
      claimApplicantVideoUploadOperation(
        uploadOperation,
        cancellationOperation,
        true,
      ),
    ).toBeNull();

    cancellationOperation.current = Symbol("cancelling");
    expect(
      claimApplicantVideoUploadOperation(
        uploadOperation,
        cancellationOperation,
        false,
      ),
    ).toBeNull();
  });

  it("emits created, submitted and withdrawn webhooks after each committed lifecycle change", async () => {
    const queuedMessages: unknown[] = [];
    const testEnv = {
      ...(env as unknown as CloudflareEnvironment),
      OPERATIONS_QUEUE: {
        send: async (message: unknown) => {
          queuedMessages.push(message);
        },
      },
    } as unknown as CloudflareEnvironment;
    const endpointId = `application-webhook-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO webhook_endpoints (
         id, organisation_id, event_id, name, url, secret_ciphertext,
         event_types_json, status, created_at, updated_at
       ) VALUES (?, 'org-future-events', 'evt-foe-2025',
                 'Application events', 'https://hooks.example.com/program-cue',
                 'unused-test-ciphertext',
                 '["submission.created","submission.submitted","submission.withdrawn"]',
                 'active',
                 unixepoch(), unixepoch())`,
    )
      .bind(endpointId)
      .run();

    const response = await action({
      request: new Request("http://localhost/apply/form", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: "http://localhost",
        },
        body: new URLSearchParams({
          _intent: "start_anonymous",
          intentId: crypto.randomUUID(),
        }),
      }),
      params: { slug: "form" },
      context: context(testEnv),
    } as never);
    expect(response).toBeInstanceOf(Response);
    const redirectResponse = response as Response;
    expect(redirectResponse.status).toBe(302);
    expect(redirectResponse.headers.get("set-cookie")).toContain(
      "pc_applicant_",
    );
    const destination = new URL(
      redirectResponse.headers.get("location")!,
      "http://localhost",
    );
    const submissionId = destination.searchParams.get("draft");
    expect(submissionId).toBeTruthy();
    if (!submissionId) throw new Error("The draft redirect omitted its ID.");
    await expect(
      verifyApplicationNotice(
        testEnv,
        destination.searchParams.get("notice"),
        "form",
      ),
    ).resolves.toMatchObject({
      kind: "created",
      submissionId,
      webhookWarning: false,
    });
    const anonymousCookie = redirectResponse.headers
      .get("set-cookie")!
      .split(";")[0]!;
    const email = `lifecycle-${crypto.randomUUID()}@example.com`;
    const applicationPayload = {
      submissionId,
      revision: "1",
      answers: JSON.stringify({
        title: "Lifecycle webhook contract",
        description: "Exercise every public application lifecycle event.",
        category: ["AI & Innovation"],
        format: "Presentation",
        video: "https://example.com/lifecycle-video",
      }),
      speakers: JSON.stringify([
        {
          name: "Lifecycle Applicant",
          email,
          biography: "Tests the durable public lifecycle contract.",
        },
      ]),
      uploads: "{}",
    };

    const saved = await action({
      request: new Request("http://localhost/apply/form", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: anonymousCookie,
          origin: "http://localhost",
        },
        body: new URLSearchParams({
          _intent: "save_draft",
          ...applicationPayload,
        }),
      }),
      params: { slug: "form" },
      context: context(testEnv),
    } as never);
    expect(saved).toBeInstanceOf(Response);

    const codeRequested = await action({
      request: new Request("http://localhost/apply/form", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: anonymousCookie,
          origin: "http://localhost",
        },
        body: new URLSearchParams({ _intent: "request_code", email }),
      }),
      params: { slug: "form" },
      context: context(testEnv),
    } as never);
    if (codeRequested instanceof Response) {
      throw new Error("Verification-code request unexpectedly redirected.");
    }
    expect(codeRequested.data).toMatchObject({ ok: true, demoCode: "424242" });

    const verified = await action({
      request: new Request("http://localhost/apply/form", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: anonymousCookie,
          origin: "http://localhost",
        },
        body: new URLSearchParams({
          _intent: "verify_code",
          email,
          code: "424242",
        }),
      }),
      params: { slug: "form" },
      context: context(testEnv),
    } as never);
    expect(verified).toBeInstanceOf(Response);
    const verifiedCookie = (verified as Response).headers
      .get("set-cookie")!
      .split(";")[0]!;
    const savedRow = await env.DB.prepare(
      `SELECT revision FROM submissions WHERE id = ? AND event_id = 'evt-foe-2025'`,
    )
      .bind(submissionId)
      .first<{ revision: number }>();

    const submitted = await action({
      request: new Request("http://localhost/apply/form", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: verifiedCookie,
          origin: "http://localhost",
        },
        body: new URLSearchParams({
          _intent: "submit",
          confirm: "yes",
          ...applicationPayload,
          revision: String(savedRow!.revision),
        }),
      }),
      params: { slug: "form" },
      context: context(testEnv),
    } as never);
    if (submitted instanceof Response) {
      throw new Error("Queue-failed submission unexpectedly redirected.");
    }
    expect(submitted.init?.status).toBe(207);
    expect(submitted.data).toMatchObject({
      ok: false,
      committed: true,
      submissionId,
    });
    const submittedRow = await env.DB.prepare(
      `SELECT revision, status FROM submissions
        WHERE id = ? AND event_id = 'evt-foe-2025'`,
    )
      .bind(submissionId)
      .first<{ revision: number; status: string }>();
    expect(submittedRow?.status).toBe("submitted");

    const withdrawn = await action({
      request: new Request("http://localhost/apply/form", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: verifiedCookie,
          origin: "http://localhost",
        },
        body: new URLSearchParams({
          _intent: "withdraw",
          submissionId,
          revision: String(submittedRow!.revision),
          confirmWithdrawal: "yes",
        }),
      }),
      params: { slug: "form" },
      context: context(testEnv),
    } as never);
    if (withdrawn instanceof Response) {
      throw new Error("Queue-failed withdrawal unexpectedly redirected.");
    }
    expect(withdrawn.init?.status).toBe(207);
    expect(withdrawn.data).toMatchObject({
      ok: false,
      committed: true,
      submissionId,
    });
    const withdrawalReplay = await action({
      request: new Request("http://localhost/apply/form", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: verifiedCookie,
          origin: "http://localhost",
        },
        body: new URLSearchParams({
          _intent: "withdraw",
          submissionId,
          revision: String(submittedRow!.revision),
          confirmWithdrawal: "yes",
        }),
      }),
      params: { slug: "form" },
      context: context(testEnv),
    } as never);
    if (withdrawalReplay instanceof Response) {
      throw new Error(
        "Queue-failed withdrawal replay unexpectedly redirected.",
      );
    }
    expect(withdrawalReplay.data).toMatchObject({
      committed: true,
      submissionId,
    });

    const deliveries = await env.DB.prepare(
      `SELECT event_type AS eventType, entity_type AS entityType,
              entity_id AS entityId, idempotency_key AS idempotencyKey,
              payload_json AS payloadJson
         FROM webhook_deliveries
        WHERE endpoint_id = ? ORDER BY event_type`,
    )
      .bind(endpointId)
      .all<{
        eventType: string;
        entityType: string;
        entityId: string;
        idempotencyKey: string;
        payloadJson: string;
      }>();
    expect(
      deliveries.results.map(({ eventType, entityType, entityId }) => ({
        eventType,
        entityType,
        entityId,
      })),
    ).toEqual([
      {
        eventType: "submission.created",
        entityType: "submission",
        entityId: submissionId,
      },
      {
        eventType: "submission.submitted",
        entityType: "submission",
        entityId: submissionId,
      },
      {
        eventType: "submission.withdrawn",
        entityType: "submission",
        entityId: submissionId,
      },
    ]);
    expect(
      deliveries.results.map((delivery) => delivery.idempotencyKey),
    ).toEqual([
      `webhook:${endpointId}:submission.created:${submissionId}`,
      `webhook:${endpointId}:submission.submitted:${submissionId}`,
      `webhook:${endpointId}:submission.withdrawn:${submissionId}`,
    ]);
    expect(
      queuedMessages.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "webhook.deliver",
      ),
    ).toHaveLength(3);
    expect(
      queuedMessages.filter(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "submission.notification",
      ),
    ).toHaveLength(1);
    expect(JSON.parse(deliveries.results[0]!.payloadJson).data).toMatchObject({
      entityId: submissionId,
      status: "draft",
      anonymous: true,
    });
    await expect(
      env.DB.prepare(
        `SELECT status FROM submissions WHERE id = ? AND event_id = 'evt-foe-2025'`,
      )
        .bind(submissionId)
        .first(),
    ).resolves.toEqual({ status: "withdrawn" });
  });
});
