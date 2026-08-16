import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EvaluationStateError } from "~/modules/evaluations/evaluation-errors";
import { SubmissionService } from "~/modules/submissions/submission-service.server";
import { currentEventCookie } from "~/platform/auth/current-event.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  action,
  directSessionCreationOrigin,
  directSessionSuccessDestination,
} from "./admin-create-session";

function context() {
  const value = new RouterContextProvider();
  value.set(cloudflareContext, {
    env: env as unknown as CloudflareEnvironment,
    ctx: {} as ExecutionContext,
  });
  return value;
}

function adminRequest(body: URLSearchParams) {
  const eventCookie = currentEventCookie(
    "evt-foe-2025",
    env as unknown as CloudflareEnvironment,
  ).split(";", 1)[0];
  return new Request("http://localhost/admin/sessions/new?from=schedule", {
    method: "POST",
    headers: {
      cookie: `program_cue_demo_identity=administrator; ${eventCookie}`,
      origin: "http://localhost",
    },
    body,
  });
}

beforeEach(async () => {
  vi.restoreAllMocks();
  await ensureDemoData(env as unknown as CloudflareEnvironment);
  await env.DB.prepare(
    "UPDATE events SET duplicate_person_warnings = 1 WHERE id = ?",
  )
    .bind("evt-foe-2025")
    .run();
});

describe("manual person creation warnings", () => {
  it("accepts only bounded creation origins and uses them only for success routing", () => {
    expect(
      directSessionCreationOrigin(
        new URL("https://example.test/admin/sessions/new?from=programme"),
      ),
    ).toBe("programme");
    expect(() =>
      directSessionCreationOrigin(
        new URL("https://example.test/admin/sessions/new?from=/admin/event"),
      ),
    ).toThrow(Response);
    expect(() =>
      directSessionCreationOrigin(
        new URL("https://example.test/admin/sessions/new"),
      ),
    ).toThrow(Response);
    expect(() =>
      directSessionCreationOrigin(
        new URL(
          "https://example.test/admin/sessions/new?from=schedule&from=programme",
        ),
      ),
    ).toThrow(Response);
    expect(
      directSessionSuccessDestination("programme", "session 1", true),
    ).toBe("/admin/programme?createdSession=session+1&attention=1");
    expect(directSessionSuccessDestination("global", "session 1", false)).toBe(
      "/admin/schedule?session=session+1&created=1",
    );
  });

  it("reports an unmet speaker-invitation prerequisite instead of a server error", async () => {
    const title = `Missing invitation prerequisite ${crypto.randomUUID()}`;
    vi.spyOn(
      SubmissionService.prototype,
      "createDirectSession",
    ).mockRejectedValueOnce(
      new EvaluationStateError(
        "Configure the event venue or mailing address before accepted-speaker invitations can be queued.",
      ),
    );

    const result = await action({
      request: adminRequest(
        new URLSearchParams({
          _intent: "create_direct_session",
          idempotencyKey: crypto.randomUUID(),
          title,
          description: "This request cannot yet queue its speaker invitation.",
          format: "presentation",
          trackId: "demo-track-ai",
          durationMinutes: "45",
          speakers: JSON.stringify([
            {
              name: "Provider Acceptance Speaker",
              email: `provider-acceptance-${crypto.randomUUID()}@example.com`,
              biography: "",
            },
          ]),
        }),
      ),
      params: {},
      context: context(),
    } as never);

    if (result instanceof Response) {
      throw new Error("Invitation prerequisite returned a raw response.");
    }
    expect(result.init?.status).toBe(409);
    expect(result.data).toEqual({
      ok: false,
      message:
        "Configure the event venue or mailing address before accepted-speaker invitations can be queued.",
    });
    await expect(
      env.DB.prepare("SELECT 1 FROM sessions WHERE event_id = ? AND title = ?")
        .bind("evt-foe-2025", title)
        .first(),
    ).resolves.toBeNull();
  });

  it("rejects a missing speaker payload at the route boundary", async () => {
    const title = `Missing speakers ${crypto.randomUUID()}`;
    const result = await action({
      request: adminRequest(
        new URLSearchParams({
          _intent: "create_direct_session",
          idempotencyKey: crypto.randomUUID(),
          title,
          description: "This request is missing its speaker payload.",
          format: "presentation",
          trackId: "demo-track-ai",
          durationMinutes: "45",
        }),
      ),
      params: {},
      context: context(),
    } as never);

    if (result instanceof Response) {
      throw new Error("Missing speaker payload returned a raw response.");
    }
    expect(result.init?.status).toBe(400);
    expect(result.data).toEqual({
      ok: false,
      message: "The speaker details are missing. Refresh and try again.",
    });
    await expect(
      env.DB.prepare("SELECT 1 FROM sessions WHERE event_id = ? AND title = ?")
        .bind("evt-foe-2025", title)
        .first(),
    ).resolves.toBeNull();
  });

  it("blocks a direct session until an administrator reviews likely duplicates", async () => {
    const title = `Duplicate warning ${crypto.randomUUID()}`;
    const idempotencyKey = crypto.randomUUID();
    const base = {
      _intent: "create_direct_session",
      idempotencyKey,
      title,
      description: "A direct session created after reviewing identity matches.",
      format: "presentation",
      trackId: "demo-track-ai",
      durationMinutes: "45",
      speakers: JSON.stringify([
        {
          name: "Priya Shah",
          email: "priya.speaker@example.com",
          biography: "Existing speaker",
        },
      ]),
    };

    const warning = await action({
      request: adminRequest(new URLSearchParams(base)),
      params: {},
      context: context(),
    } as never);
    if (warning instanceof Response)
      throw new Error("Duplicate warning returned a raw response.");
    expect(warning.init?.status).toBe(409);
    expect(warning.data).toMatchObject({
      ok: false,
      duplicateCheck: {
        intent: "create_direct_session",
        matches: [
          expect.objectContaining({
            personId: "person-demo-speaker",
            reasons: expect.arrayContaining(["same_email", "same_name"]),
          }),
        ],
      },
    });
    const beforeConfirmation = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM sessions WHERE event_id = ? AND title = ?",
    )
      .bind("evt-foe-2025", title)
      .first<{ count: number }>();
    expect(Number(beforeConfirmation?.count ?? 0)).toBe(0);

    const confirmed = await action({
      request: adminRequest(
        new URLSearchParams({ ...base, confirmDuplicatePeople: "yes" }),
      ),
      params: {},
      context: context(),
    } as never);
    expect(confirmed).toBeInstanceOf(Response);
    if (!(confirmed instanceof Response)) {
      throw new Error("Confirmed direct session did not redirect.");
    }
    expect(confirmed.status).toBe(303);
    expect(confirmed.headers.get("location")).toMatch(
      /^\/admin\/schedule\?session=.+&created=1$/u,
    );
    const afterConfirmation = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM sessions WHERE event_id = ? AND title = ?",
    )
      .bind("evt-foe-2025", title)
      .first<{ count: number }>();
    expect(Number(afterConfirmation?.count ?? 0)).toBe(1);
  });
});
