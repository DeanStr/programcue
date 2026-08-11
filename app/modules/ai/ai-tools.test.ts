import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import type { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { IntegrationService } from "~/modules/integrations/integration-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { AiAssistantService } from "./ai-assistant-service.server";
import { AiToolExecutor } from "./ai-tools.server";

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

describe("AI tool authority boundary", () => {
  it("fails closed before querying an unreadable Airtable projection", async () => {
    const unavailable = new Error("Airtable projection is unavailable.");
    const assertReadable = vi.fn(async () => {
      throw unavailable;
    });
    const executor = new AiToolExecutor(
      env as unknown as CloudflareEnvironment,
      viewer,
      "assistant-run",
      "test-model",
      {
        airtable: { assertReadable } as unknown as AirtableProviderBoundary,
      },
    );

    await expect(
      executor.execute("find_incomplete_speakers", '{"limit":10}'),
    ).rejects.toBe(unavailable);
    expect(assertReadable).toHaveBeenCalledWith(viewer);
  });

  it("finds a submission by any selected track", async () => {
    const workerEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(workerEnv);
    await workerEnv.DB.batch([
      workerEnv.DB.prepare(
        `INSERT INTO submissions (
           id, event_id, public_reference, title, category, status,
           submitted_snapshot_json, submitted_at
         ) VALUES (
           'ai-multi-track-submission', ?, 'AI-MULTI-TRACK',
           'A searchable multi-track proposal', 'Leadership', 'submitted',
           '{}', unixepoch()
         )`,
      ).bind(viewer.eventId),
      workerEnv.DB.prepare(
        `INSERT INTO submission_track_selections (
           submission_id, event_id, track_id, track_name_snapshot, position
         ) VALUES
           ('ai-multi-track-submission', ?, 'demo-track-leadership', 'Leadership', 0),
           ('ai-multi-track-submission', ?, 'demo-track-experience', 'Experience Design', 1)`,
      ).bind(viewer.eventId, viewer.eventId),
    ]);

    const execution = await new AiToolExecutor(
      workerEnv,
      viewer,
      crypto.randomUUID(),
      "test-model",
    ).execute(
      "search_submissions",
      JSON.stringify({ query: "Experience Design", limit: 10 }),
    );

    expect(execution.evidence).toContainEqual(
      expect.objectContaining({ id: "submission:ai-multi-track-submission" }),
    );
  });

  it("persists the exact Accelevents provider target and rejects approval after it changes", async () => {
    const workerEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(workerEnv);
    const integrations = new IntegrationService(workerEnv, {
      createAccelevents: () => ({
        validateConnection: async () => undefined,
      }),
    });
    const connection = await integrations.configureAccelevents(viewer, {
      provider: "accelevents",
      apiKey: "provider-key",
      eventUrl: "future-of-events",
      externalEventId: 441,
      sessionTypeFormat: "IN_PERSON",
    });
    const execution = await new AiToolExecutor(
      workerEnv,
      viewer,
      crypto.randomUUID(),
      "test-model",
    ).execute(
      "propose_accelevents_run",
      JSON.stringify({ connectionId: connection.connectionId, dryRun: false }),
    );
    const proposal = execution.proposals[0];
    expect(proposal).toBeDefined();

    await workerEnv.DB.prepare(
      `UPDATE integration_connections
          SET revision = revision + 1
        WHERE id = ? AND event_id = ? AND organisation_id = ?`,
    )
      .bind(connection.connectionId, viewer.eventId, viewer.organisationId)
      .run();

    await expect(
      new AiAssistantService(workerEnv).approveProposal(
        viewer,
        proposal!.id,
        true,
      ),
    ).rejects.toThrow(/export plan changed after preview/iu);
    await expect(
      workerEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM integration_runs
          WHERE connection_id = ? AND dry_run = 0`,
      )
        .bind(connection.connectionId)
        .first(),
    ).resolves.toEqual({ count: 0 });
  });
});
