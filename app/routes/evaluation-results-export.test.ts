import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { action, loader } from "./evaluation-results-export";

const workerEnv = env as unknown as CloudflareEnvironment;
const eventId = "evt-foe-2025";

function context() {
  const value = new RouterContextProvider();
  value.set(cloudflareContext, {
    env: workerEnv,
    ctx: {} as ExecutionContext,
  });
  return value;
}

function request(
  identity: "administrator" | "speaker",
  options: {
    origin?: string;
    roundId?: string | null;
    idempotencyKey?: string | null;
    method?: string;
  } = {},
) {
  const search =
    options.roundId === null
      ? ""
      : `?round=${encodeURIComponent(options.roundId ?? "demo-evaluation-round")}`;
  const headers = new Headers({
    cookie: `program_cue_demo_identity=${identity}; program_cue_event=${eventId}`,
  });
  if (options.origin !== undefined) headers.set("origin", options.origin);
  const body = new URLSearchParams();
  if (options.idempotencyKey !== null) {
    body.set("idempotencyKey", options.idempotencyKey ?? crypto.randomUUID());
  }
  return new Request(`http://localhost/admin/review/results.csv${search}`, {
    method: options.method ?? "POST",
    headers,
    body: options.method === "GET" ? undefined : body,
  });
}

beforeEach(async () => {
  await ensureDemoEvaluationData(workerEnv);
});

describe("Abstract review results export route", () => {
  it("returns a private audited CSV attachment to an evaluation administrator", async () => {
    const response = await action({
      request: request("administrator", { origin: "http://localhost" }),
      params: {},
      context: context(),
    } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/csv; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="program-cue-abstract-review-results.csv"',
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-program-cue-operation")).toBeTruthy();
    expect(await response.text()).toContain(
      "roundId,roundNumber,roundName,roundStatus,submissionId",
    );
  });

  it("rejects a participant without review-administration authority", async () => {
    await expect(
      action({
        request: request("speaker", { origin: "http://localhost" }),
        params: {},
        context: context(),
      } as never),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("requires a current-plan round instead of choosing one implicitly", async () => {
    await expect(
      action({
        request: request("administrator", {
          origin: "http://localhost",
          roundId: null,
        }),
        params: {},
        context: context(),
      } as never),
    ).rejects.toMatchObject({ status: 422 });
    await expect(
      action({
        request: request("administrator", {
          origin: "http://localhost",
          roundId: "unknown-round",
        }),
        params: {},
        context: context(),
      } as never),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("requires same-origin POST and an idempotency UUID", async () => {
    const getResponse = loader();
    expect(getResponse.status).toBe(405);
    expect(getResponse.headers.get("allow")).toBe("POST");
    expect(getResponse.headers.get("cache-control")).toBe("private, no-store");

    for (const origin of [undefined, "null", "https://attacker.example"]) {
      const response = await action({
        request: request("administrator", { origin }),
        params: {},
        context: context(),
      } as never);
      expect(response.status).toBe(403);
    }
    await expect(
      action({
        request: request("administrator", {
          origin: "http://localhost",
          idempotencyKey: null,
        }),
        params: {},
        context: context(),
      } as never),
    ).rejects.toMatchObject({ status: 422 });
  });
});
