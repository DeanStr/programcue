import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  adminErrorReturn,
  adminLayoutAllowedRoles,
  loader,
} from "./admin-layout";

const workerEnv = env as unknown as CloudflareEnvironment;

function routeContext() {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, {
    env: workerEnv,
    ctx: { waitUntil: () => undefined } as unknown as ExecutionContext,
  });
  return context;
}

describe("admin layout role routing", () => {
  it.each([
    "/admin/review",
    "/admin/review/",
    "/admin/review.data",
    "/admin/review/results.csv",
  ])("keeps committee-chair access for %s", (pathname) => {
    expect(adminLayoutAllowedRoles(pathname)).toContain("committee_chair");
  });

  it.each([
    "/admin/reviewer",
    "/admin/reviewing",
    "/admin/review.data-extra",
    "/admin/schedule",
  ])("does not broaden committee-chair access to %s", (pathname) => {
    expect(adminLayoutAllowedRoles(pathname)).not.toContain("committee_chair");
  });

  it("returns access and event-context errors to event selection", () => {
    for (const status of [400, 403, 428]) {
      expect(adminErrorReturn(status, false)).toEqual({
        href: "/events/select",
        label: "Choose an event",
      });
    }
  });

  it("keeps child-route errors inside the loaded administrator context", () => {
    for (const status of [400, 403, 428]) {
      expect(adminErrorReturn(status, true)).toEqual({
        href: "/admin/command",
        label: "Go to Command Centre",
      });
    }
  });

  it("returns 401s to sign-in instead of Command Centre", () => {
    expect(adminErrorReturn(401, true, { pathname: "/admin/command" })).toEqual(
      {
        href: "/sign-in",
        label: "Sign in",
      },
    );
  });

  it("returns evaluation refusals to the persona guide", () => {
    expect(
      adminErrorReturn(403, false, {
        pathname: "/admin/command",
        evaluation: true,
      }),
    ).toEqual({
      href: "/evaluate",
      label: "Choose an evaluation persona",
    });
  });

  it("returns unexpected failures to the administrator home", () => {
    expect(adminErrorReturn(500, false)).toEqual({
      href: "/admin/command",
      label: "Go to Command Centre",
    });
    expect(adminErrorReturn(null, false)).toEqual({
      href: "/admin/command",
      label: "Go to Command Centre",
    });
  });

  it("fails the shell closed when an Airtable event is not synchronized", async () => {
    await ensureDemoData(workerEnv);
    await workerEnv.DB.prepare(
      "UPDATE events SET repository_provider = 'airtable' WHERE id = ?",
    )
      .bind("evt-foe-2025")
      .run();
    try {
      await expect(
        loader({
          request: new Request("https://programcue.test/admin/command", {
            headers: {
              cookie:
                "program_cue_demo_identity=administrator; program_cue_event=evt-foe-2025",
            },
          }),
          context: routeContext(),
          params: {},
        } as never),
      ).rejects.toThrow(
        "Configure and validate an Airtable repository connection before selecting Airtable.",
      );
    } finally {
      await workerEnv.DB.prepare(
        "UPDATE events SET repository_provider = 'd1' WHERE id = ?",
      )
        .bind("evt-foe-2025")
        .run();
    }
  });
});
