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
  it("reports a successful handoff without changing the current event", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const handoff = vi
      .spyOn(CrmService.prototype, "addContactToEvent")
      .mockResolvedValue({
        eventId: "evt-handoff-target",
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
            eventId: "evt-handoff-target",
            idempotencyKey: "crm-delivery-test",
          }),
        },
      ),
      params: { personId: "person-demo-speaker" },
      context: context(),
    } as never);

    expect(result).toEqual({
      ok: true,
      message:
        "Added this contact to the target event as a prospect. The current event was not changed.",
      handoff: {
        eventId: "evt-handoff-target",
        personId: "person-demo-speaker",
      },
    });
    expect(handoff).toHaveBeenCalledWith(
      expect.objectContaining({
        organisationId: "org-future-events",
        personId: "person-demo-admin",
      }),
      "person-demo-speaker",
      "evt-handoff-target",
      "crm-delivery-test",
    );
  });

  it("reports an existing event connection as a no-op", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    vi.spyOn(CrmService.prototype, "addContactToEvent").mockResolvedValue({
      eventId: "evt-handoff-target",
      personId: "person-demo-speaker",
      workflowStatus: "prospect",
      created: false,
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
            eventId: "evt-handoff-target",
            idempotencyKey: "crm-no-op-test",
          }),
        },
      ),
      params: { personId: "person-demo-speaker" },
      context: context(),
    } as never);

    expect(result).toEqual({
      ok: true,
      message:
        "This contact is already in the target event. No duplicate was created and the current event was not changed.",
      handoff: {
        eventId: "evt-handoff-target",
        personId: "person-demo-speaker",
      },
    });
  });
});
