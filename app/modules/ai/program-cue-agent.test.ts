import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { getProgramCueEventAgent } from "./program-cue-agent-client.server";
import { programCueAgentInstanceName } from "./program-cue-agent.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";

const admin: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

describe("Program Cue Cloudflare Agent", () => {
  it("uses a deterministic private scoped instance over RPC", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const instanceName = await programCueAgentInstanceName(admin);
    expect(instanceName).toMatch(/^event-[a-f0-9]{64}$/);

    const agent = await getProgramCueEventAgent(
      env as unknown as CloudflareEnvironment,
      admin,
    );
    await expect(agent.getWorkspace(admin)).resolves.toMatchObject({
      eventName: "Future of Events 2027",
    });
    const state = await runInDurableObject(
      agent,
      async (instance) => instance.state,
    );
    expect(state).toMatchObject({
      version: 1,
      scopeFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      pendingProposalIds: [],
    });
    const stream = await agent.streamAsk(
      admin,
      "What is blocking event readiness?",
    );
    const streamed = await new Response(stream).text();
    expect(streamed).toContain("event: status");
    expect(streamed).toContain("event: error");
    expect(streamed).toContain("OPENAI_API_KEY");

    const differentViewer: Viewer = {
      ...admin,
      personId: "person-demo-owner",
      email: "owner@example.com",
    };
    await expect(
      programCueAgentInstanceName(differentViewer),
    ).resolves.not.toBe(instanceName);
  });
});
