import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import type { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { IntegrationService } from "~/modules/integrations/integration-service.server";
import { ResourceService } from "~/modules/resources/resource-service.server";
import { SpeakerService } from "~/modules/speakers/speaker-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { AiAssistantService } from "./ai-assistant-service.server";
import { validateTaskReferences } from "./ai-proposal-executor-foundation.server";
import { AiReadToolExecutor } from "./ai-read-tool-executor.server";
import { loadReminderCohort } from "./ai-read-tool-shared.server";
import { AiToolExecutor, AiToolPermissionError } from "./ai-tools.server";

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
  it("keeps the extracted read executor behind the administrator boundary", () => {
    const speaker = { ...viewer, role: "speaker" } satisfies Viewer;

    expect(() =>
      new AiReadToolExecutor(
        env as unknown as CloudflareEnvironment,
        speaker,
      ).execute("get_event_readiness", "{}"),
    ).toThrow(AiToolPermissionError);
  });

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

  it("rejects an AI task preview for a declined-only speaker", async () => {
    const workerEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(workerEnv);
    const suffix = crypto.randomUUID();
    const personId = `ai-declined-person-${suffix}`;
    const sessionId = `ai-declined-session-${suffix}`;
    await workerEnv.DB.batch([
      workerEnv.DB.prepare(
        `INSERT INTO people (id, email, display_name)
         VALUES (?, ?, 'Declined AI participant')`,
      ).bind(personId, `declined-ai-${suffix}@example.com`),
      workerEnv.DB.prepare(
        `INSERT INTO sessions (
           id, event_id, title, slug, format, duration_minutes, status, visibility
         ) VALUES (?, ?, 'Declined AI session', ?, 'Talk', 30,
                   'unscheduled', 'private')`,
      ).bind(sessionId, viewer.eventId, `declined-ai-${suffix}`),
      workerEnv.DB.prepare(
        `INSERT INTO session_speakers (
           session_id, event_id, person_id, position, participation_status,
           participation_revision, participation_declined_at, visibility
         ) VALUES (?, ?, ?, 0, 'declined', 2, unixepoch(), 'private')`,
      ).bind(sessionId, viewer.eventId, personId),
    ]);

    await expect(
      validateTaskReferences(workerEnv, viewer, {
        title: "Follow up declined participation",
        description: null,
        targetType: "speaker",
        targetId: personId,
        ownerPersonId: null,
        taskType: "checklist",
        impact: "medium",
        dueAt: null,
        dependencyIds: [],
      }),
    ).rejects.toThrow(
      "The proposed speaker task target is not available in this event.",
    );
  });

  it("excludes an inaccessible resource acknowledgement from AI task cohorts", async () => {
    const workerEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(workerEnv);
    const suffix = crypto.randomUUID();
    const personId = `ai-cohort-person-${suffix}`;
    const sessionId = `ai-cohort-session-${suffix}`;
    const speaker: Viewer = {
      personId,
      name: "AI Cohort Participant",
      email: `ai-cohort-${suffix}@example.com`,
      role: "speaker",
      organisationId: viewer.organisationId,
      eventId: viewer.eventId,
      demo: true,
    };
    await workerEnv.DB.batch([
      workerEnv.DB.prepare(
        `INSERT INTO people (id, email, display_name) VALUES (?, ?, ?)`,
      ).bind(personId, speaker.email, speaker.name),
      workerEnv.DB.prepare(
        `INSERT INTO sessions (
           id, event_id, title, slug, format, duration_minutes, status, visibility
         ) VALUES (?, ?, 'AI cohort session', ?, 'Talk', 30,
                   'unscheduled', 'private')`,
      ).bind(sessionId, viewer.eventId, `ai-cohort-session-${suffix}`),
      workerEnv.DB.prepare(
        `INSERT INTO session_speakers (
           session_id, event_id, person_id, position, participation_status,
           participation_revision, visibility
         ) VALUES (?, ?, ?, 0, 'pending', 1, 'private')`,
      ).bind(sessionId, viewer.eventId, personId),
    ]);
    const resources = new ResourceService(workerEnv);
    const pageId = await resources.save(viewer, {
      title: "AI cohort resource",
      slug: `ai-cohort-resource-${crypto.randomUUID().slice(0, 8)}`,
      category: "Preparation",
      audienceScope: "accepted_speakers",
      acknowledgementRequired: true,
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Review this briefing." }],
          },
        ],
      },
    });
    const draft = (await resources.getAdminWorkspace(viewer, pageId)).selected;
    if (!draft) throw new Error("The AI cohort resource draft is unavailable.");
    await resources.publish(viewer, pageId, draft.revision);

    const before = await new AiReadToolExecutor(workerEnv, viewer).execute(
      "find_incomplete_speakers",
      '{"limit":50}',
    );
    expect(before.output).toMatchObject({
      speakers: expect.arrayContaining([
        expect.objectContaining({ id: speaker.personId }),
      ]),
    });
    expect(
      (await loadReminderCohort(workerEnv, viewer, "incomplete_speakers"))
        .sample,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: speaker.personId }),
      ]),
    );

    await new SpeakerService(workerEnv).respondOwnRole(speaker, {
      sessionId,
      role: "speaker",
      roleRevision: 1,
      response: "declined",
      reason: "",
    });

    const after = await new AiReadToolExecutor(workerEnv, viewer).execute(
      "find_incomplete_speakers",
      '{"limit":50}',
    );
    expect(after.output).not.toMatchObject({
      speakers: expect.arrayContaining([
        expect.objectContaining({ id: speaker.personId }),
      ]),
    });
    expect(
      (await loadReminderCohort(workerEnv, viewer, "incomplete_speakers"))
        .sample,
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: speaker.personId }),
      ]),
    );
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
