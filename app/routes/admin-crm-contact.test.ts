import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CrmService } from "~/modules/crm/crm-service.server";
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
  it("opens the roster at the handed-off prospect without sending an invitation", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const handoff = vi
      .spyOn(CrmService.prototype, "addContactToEvent")
      .mockResolvedValue({
        eventId: "evt-foe-2025",
        personId: "person-demo-speaker",
        workflowStatus: "prospect",
        created: true,
      });

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

    if (!(result instanceof Response)) {
      throw new Error("CRM event handoff did not redirect to the roster.");
    }
    expect(result.status).toBe(302);
    expect(result.headers.get("location")).toBe(
      "/admin/speakers?person=person-demo-speaker",
    );
    expect(result.headers.get("set-cookie")).toContain("program_cue_event=");
    expect(handoff).toHaveBeenCalledWith(
      expect.objectContaining({
        organisationId: "org-future-events",
        personId: "person-demo-admin",
      }),
      "person-demo-speaker",
      "evt-foe-2025",
      "crm-delivery-test",
    );
  });
});
