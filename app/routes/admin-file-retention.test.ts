import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { action, loader } from "./admin-file-retention";

function context() {
  const value = new RouterContextProvider();
  value.set(cloudflareContext, {
    env: env as unknown as CloudflareEnvironment,
    ctx: {} as ExecutionContext,
  });
  return value;
}

function request(role: "owner" | "administrator", init?: RequestInit) {
  return new Request("http://localhost/admin/files/retention", {
    ...init,
    headers: {
      cookie: `program_cue_demo_identity=${role}; program_cue_event=evt-foe-2025`,
      origin: "http://localhost",
      ...(init?.headers ?? {}),
    },
  });
}

beforeEach(async () => {
  await ensureDemoData(env as unknown as CloudflareEnvironment);
  await env.DB.prepare(
    "UPDATE events SET file_retention_hold_at = NULL WHERE id = ?",
  )
    .bind("evt-foe-2025")
    .run();
});

describe("owner file-retention route", () => {
  it("renders current retention impact for an owner and rejects an administrator", async () => {
    const result = await loader({
      request: request("owner"),
      params: {},
      context: context(),
    } as never);
    expect(result.state).toMatchObject({
      name: "Future of Events 2027",
      retentionMonths: 24,
      holdAt: null,
    });

    await expect(
      loader({
        request: request("administrator"),
        params: {},
        context: context(),
      } as never),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("requires explicit owner confirmation and records a retention hold", async () => {
    const unconfirmed = await action({
      request: request("owner", {
        method: "POST",
        body: new URLSearchParams({
          intent: "place-hold",
          reason: "Pending legal review",
        }),
      }),
      params: {},
      context: context(),
    } as never);
    if (unconfirmed instanceof Response)
      throw new Error("Retention confirmation returned a raw response.");
    expect(unconfirmed.init?.status).toBe(409);

    const confirmed = await action({
      request: request("owner", {
        method: "POST",
        body: new URLSearchParams({
          intent: "place-hold",
          reason: "Pending legal review",
          confirm: "yes",
        }),
      }),
      params: {},
      context: context(),
    } as never);
    if (confirmed instanceof Response)
      throw new Error("Confirmed retention hold returned a raw response.");
    expect(confirmed.init?.status ?? 200).toBe(200);
    expect(confirmed.data).toMatchObject({ ok: true });
    const row = await env.DB.prepare(
      "SELECT file_retention_hold_at AS holdAt FROM events WHERE id = ?",
    )
      .bind("evt-foe-2025")
      .first<{ holdAt: number | null }>();
    expect(row?.holdAt).not.toBeNull();
  });
});
