import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CrmService } from "~/modules/crm/crm-service.server";
import { SpeakerInvitationDeliveryError } from "~/modules/speakers/speaker-invitation.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { action } from "./admin-crm-contact";

function context() {
  const value = new RouterContextProvider();
  value.set(cloudflareContext, {
    env: env as unknown as CloudflareEnvironment,
    ctx: {} as ExecutionContext,
  });
  return value;
}

afterEach(() => vi.restoreAllMocks());

describe("Speaker Network event handoff", () => {
  it("reports committed invitation delivery failure as partial success", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    vi.spyOn(CrmService.prototype, "addContactToEvent").mockRejectedValue(
      new SpeakerInvitationDeliveryError(
        "membership-crm-delivery-test",
        new Error("provider unavailable"),
      ),
    );

    const result = await action({
      request: new Request(
        "http://localhost/admin/crm/contacts/person-demo-speaker",
        {
          method: "POST",
          headers: {
            cookie:
              "program_cue_demo_identity=administrator; program_cue_event=evt-foe-2025",
            origin: "http://localhost",
          },
          body: new URLSearchParams({
            _intent: "add_to_event",
            eventId: "evt-foe-2025",
            idempotencyKey: "crm-delivery-test",
          }),
        },
      ),
      params: { personId: "person-demo-speaker" },
      context: context(),
    } as never);

    if (result instanceof Response) {
      throw new Error("CRM partial result returned a raw response.");
    }
    expect(result.init?.status).toBe(207);
    expect(result.data).toMatchObject({
      ok: false,
      message: expect.stringMatching(/saved.*operation needs attention/i),
    });
  });
});
