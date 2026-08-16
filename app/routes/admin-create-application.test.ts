import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { currentEventCookie } from "~/platform/auth/current-event.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { action } from "./admin-create-application";

function context() {
  const value = new RouterContextProvider();
  value.set(cloudflareContext, {
    env: env as unknown as CloudflareEnvironment,
    ctx: {} as ExecutionContext,
  });
  return value;
}

function request(body: URLSearchParams) {
  const eventCookie = currentEventCookie(
    "evt-foe-2025",
    env as unknown as CloudflareEnvironment,
  ).split(";", 1)[0];
  return new Request("http://localhost/admin/submissions/new", {
    method: "POST",
    headers: {
      cookie: `program_cue_demo_identity=administrator; ${eventCookie}`,
      origin: "http://localhost",
    },
    body,
  });
}

beforeEach(async () => {
  await ensureDemoData(env as unknown as CloudflareEnvironment);
});

describe("administrator application-record creation", () => {
  it("redirects to the exact immutable application record after creation", async () => {
    const title = `Manual route ${crypto.randomUUID()}`;
    const body = new URLSearchParams({
      _intent: "create_manual_application",
      idempotencyKey: crypto.randomUUID(),
      title,
      description: "A bounded administrator-created application.",
      format: "presentation",
      submitterName: "Priya Shah",
      submitterEmail: "priya.speaker@example.com",
      speakers: JSON.stringify([
        {
          name: "Priya Shah",
          email: "priya.speaker@example.com",
          biography: "Existing accepted participant.",
        },
      ]),
      confirmDuplicatePeople: "yes",
    });
    body.append("trackIds", "demo-track-ai");

    const result = await action({
      request: request(body),
      params: {},
      context: context(),
    } as never);

    expect(result).toBeInstanceOf(Response);
    if (!(result instanceof Response)) {
      throw new Error("Application creation did not redirect.");
    }
    const created = await env.DB.prepare(
      "SELECT id, submitted_snapshot_json AS snapshot FROM submissions WHERE event_id = ? AND title = ?",
    )
      .bind("evt-foe-2025", title)
      .first<{ id: string; snapshot: string }>();
    expect(created).not.toBeNull();
    expect(JSON.parse(created!.snapshot)).toMatchObject({
      versionNumber: 1,
      schema: {
        schemaVersion: 2,
        sections: [{ id: "proposal" }],
      },
    });
    expect(result.status).toBe(303);
    expect(result.headers.get("location")).toBe(
      `/admin/submissions/${encodeURIComponent(created!.id)}?created=1`,
    );
  });

  it("rejects an invalid speaker payload before creating a record", async () => {
    const title = `Missing speakers ${crypto.randomUUID()}`;
    const result = await action({
      request: request(
        new URLSearchParams({
          _intent: "create_manual_application",
          idempotencyKey: crypto.randomUUID(),
          title,
          description: "Invalid route payload.",
          format: "presentation",
          trackIds: "demo-track-ai",
          submitterName: "Priya Shah",
          submitterEmail: "priya.speaker@example.com",
        }),
      ),
      params: {},
      context: context(),
    } as never);

    if (result instanceof Response) {
      throw new Error("Invalid payload returned a raw response.");
    }
    expect(result.init?.status).toBe(400);
    expect(result.data.message).toMatch(/speaker details are missing/i);
    await expect(
      env.DB.prepare(
        "SELECT id FROM submissions WHERE event_id = ? AND title = ?",
      )
        .bind("evt-foe-2025", title)
        .first(),
    ).resolves.toBeNull();
  });
});
