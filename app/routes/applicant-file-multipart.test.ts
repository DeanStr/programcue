import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDemoSubmissionForm } from "~/modules/submissions/demo-submissions.server";
import { SubmissionService } from "~/modules/submissions/submission-service.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { action } from "./applicant-file-multipart";

function context(environment: CloudflareEnvironment) {
  const value = new RouterContextProvider();
  value.set(cloudflareContext, {
    env: environment,
    ctx: {} as ExecutionContext,
  });
  return value;
}

function configuredUploadEnvironment(options: { production?: boolean } = {}) {
  const productionOverrides = options.production
    ? {
        APP_ENV: "production",
        DEMO_MODE: "false",
        EVALUATION_MODE: "false",
        BETTER_AUTH_URL: "https://programcue.test",
        BETTER_AUTH_SECRET:
          "applicant-multipart-test-secret-with-at-least-thirty-two-characters",
        TURNSTILE_SITE_KEY: "applicant-upload-site-key",
        TURNSTILE_SECRET_KEY: "applicant-upload-secret-key",
      }
    : {};
  return {
    ...(env as unknown as CloudflareEnvironment),
    DB: env.DB,
    FILES: env.FILES,
    OPERATIONS_QUEUE: { send: async () => undefined },
    ...productionOverrides,
  } as unknown as CloudflareEnvironment;
}

function request(
  operation: string,
  cookie: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return new Request(
    `https://programcue.test/apply/form/files/multipart/${operation}`,
    {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        origin: "https://programcue.test",
        ...headers,
      },
      body: JSON.stringify(body),
    },
  );
}

async function invoke(
  environment: CloudflareEnvironment,
  operation: string,
  cookie: string,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  return action({
    request: request(operation, cookie, body, headers),
    params: { slug: "form", operation },
    context: context(environment),
  } as never);
}

beforeEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await ensureDemoSubmissionForm(env as unknown as CloudflareEnvironment);
});

describe("applicant direct multipart boundary", () => {
  it("allows an anonymous applicant without an event membership to initiate and abort only their own draft video", async () => {
    const environment = configuredUploadEnvironment();
    const started = await new SubmissionService(
      environment,
    ).startAnonymousDraft("form", "");
    const cookie = started.cookie.split(";")[0];
    const idempotencyKey = crypto.randomUUID();
    const initiated = await invoke(
      environment,
      "initiate",
      cookie,
      {
        submissionId: started.draftId,
        fieldId: "video",
        filename: "pitch.mp4",
        contentType: "video/mp4",
        sizeBytes: 1_024,
        turnstileToken: "",
      },
      { "idempotency-key": idempotencyKey },
    );
    expect(initiated.status).toBe(201);
    const payload = (await initiated.json()) as {
      upload: { versionId: string; partCount: number };
    };
    expect(payload.upload.partCount).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT 1 FROM memberships WHERE person_id IS NULL",
      ).first(),
    ).toBeNull();

    const resumed = await invoke(
      environment,
      "resume",
      cookie,
      {
        submissionId: started.draftId,
        fieldId: "video",
        filename: "pitch.mp4",
        contentType: "video/mp4",
        sizeBytes: 1_024,
      },
      { "idempotency-key": idempotencyKey },
    );
    expect(resumed.status).toBe(200);
    expect(await resumed.json()).toMatchObject({
      upload: { versionId: payload.upload.versionId, state: "initiated" },
    });

    const aborted = await invoke(environment, "abort", cookie, {
      submissionId: started.draftId,
      fieldId: "video",
      versionId: payload.upload.versionId,
    });
    expect(aborted.status).toBe(200);
  });

  it("rejects cross-draft access and non-video fields before issuing R2 state", async () => {
    const environment = env as unknown as CloudflareEnvironment;
    const service = new SubmissionService(environment);
    const owner = await service.startAnonymousDraft("form", "");
    const other = await service.startAnonymousDraft("form", "");
    const ownerCookie = owner.cookie.split(";")[0];

    const crossDraft = await invoke(environment, "part-url", ownerCookie, {
      submissionId: other.draftId,
      fieldId: "video",
      versionId: crypto.randomUUID(),
      partNumber: 1,
    });
    expect(crossDraft.status).toBe(404);

    const wrongField = await invoke(
      environment,
      "initiate",
      ownerCookie,
      {
        submissionId: owner.draftId,
        fieldId: "title",
        filename: "pitch.mp4",
        contentType: "video/mp4",
        sizeBytes: 1_024,
        turnstileToken: "",
      },
      { "idempotency-key": crypto.randomUUID() },
    );
    expect(wrongField.status).toBe(422);
    expect(await wrongField.text()).toContain("does not accept video");
  });

  it.each([
    "initiate",
    "resume",
    "list-parts",
    "part-url",
    "complete",
    "abort",
  ])("repeats applicant draft ownership for %s", async (operation) => {
    const environment = env as unknown as CloudflareEnvironment;
    const service = new SubmissionService(environment);
    const owner = await service.startAnonymousDraft("form", "");
    const attacker = await service.startAnonymousDraft("form", "");
    const common = {
      submissionId: owner.draftId,
      fieldId: "video",
      versionId: crypto.randomUUID(),
    };
    const body =
      operation === "initiate" || operation === "resume"
        ? {
            submissionId: owner.draftId,
            fieldId: "video",
            filename: "pitch.mp4",
            contentType: "video/mp4",
            sizeBytes: 1,
            ...(operation === "initiate" ? { turnstileToken: "" } : {}),
          }
        : operation === "list-parts"
          ? common
          : operation === "part-url"
            ? { ...common, partNumber: 1 }
            : operation === "complete"
              ? { ...common, parts: [] }
              : common;
    const result = await invoke(
      environment,
      operation,
      attacker.cookie.split(";")[0],
      body,
      { "idempotency-key": crypto.randomUUID() },
    );
    expect(result.status).toBe(404);
  });

  it("accepts the declared applicant video range through 1 GB without a proxy fallback", async () => {
    const environment = configuredUploadEnvironment();
    const started = await new SubmissionService(
      environment,
    ).startAnonymousDraft("form", "");
    const cookie = started.cookie.split(";")[0];
    for (const [filename, contentType, sizeBytes] of [
      ["tiny.mp4", "video/mp4", 1],
      ["maximum.webm", "video/webm", 1_073_741_824],
    ] as const) {
      const initiated = await invoke(
        environment,
        "initiate",
        cookie,
        {
          submissionId: started.draftId,
          fieldId: "video",
          filename,
          contentType,
          sizeBytes,
          turnstileToken: "",
        },
        { "idempotency-key": crypto.randomUUID() },
      );
      expect(initiated.status).toBe(201);
      const payload = (await initiated.json()) as {
        upload: { versionId: string; partCount: number };
      };
      expect(payload.upload.partCount).toBe(
        Math.ceil(sizeBytes / (10 * 1_048_576)),
      );
      expect(
        (
          await invoke(environment, "abort", cookie, {
            submissionId: started.draftId,
            fieldId: "video",
            versionId: payload.upload.versionId,
          })
        ).status,
      ).toBe(200);
    }
  });

  it("keeps provider configuration details out of public errors and logs", async () => {
    const base = configuredUploadEnvironment();
    const started = await new SubmissionService(base).startAnonymousDraft(
      "form",
      "",
    );
    const misconfigured = {
      ...base,
      DB: base.DB,
      FILES: base.FILES,
      R2_ACCESS_KEY_ID: undefined,
    } as unknown as CloudflareEnvironment;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await invoke(
      misconfigured,
      "initiate",
      started.cookie.split(";")[0],
      {
        submissionId: started.draftId,
        fieldId: "video",
        filename: "pitch.mp4",
        contentType: "video/mp4",
        sizeBytes: 1_024,
        turnstileToken: "",
      },
      { "idempotency-key": crypto.randomUUID() },
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "Applicant direct upload is temporarily unavailable.",
    });
    expect(logged).toHaveBeenCalledTimes(1);
    const entry = String(logged.mock.calls[0]?.[0]);
    expect(JSON.parse(entry)).toMatchObject({
      subsystem: "applicant-file-multipart",
      event: "upload-configuration-unavailable",
      operation: "initiate",
      errorName: "R2S3ConfigurationError",
    });
    expect(entry).not.toContain("R2_ACCESS_KEY_ID");
  });

  it("rate-limits production initiation by tenant, IP and applicant identity", async () => {
    const base = env as unknown as CloudflareEnvironment;
    const started = await new SubmissionService(base).startAnonymousDraft(
      "form",
      "",
    );
    const production = configuredUploadEnvironment({ production: true });
    const siteverify = vi.fn(async () =>
      Response.json({
        success: true,
        hostname: "programcue.test",
        action: "application_file_upload",
      }),
    );
    vi.stubGlobal("fetch", siteverify);
    const cookie = started.cookie.split(";")[0];
    const idempotencyKey = crypto.randomUUID();
    const call = () =>
      invoke(
        production,
        "initiate",
        cookie,
        {
          submissionId: started.draftId,
          fieldId: "video",
          filename: "pitch.webm",
          contentType: "video/webm",
          sizeBytes: 1_024,
          turnstileToken: "turnstile-upload-token",
        },
        {
          "idempotency-key": idempotencyKey,
          "cf-connecting-ip": "203.0.113.220",
        },
      );

    for (let attempt = 0; attempt < 5; attempt += 1)
      expect((await call()).status).toBe(201);
    const limited = await call();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
    expect(siteverify).toHaveBeenCalledTimes(6);
  });
});
