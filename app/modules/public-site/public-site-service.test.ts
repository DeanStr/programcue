import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { ScheduleService } from "~/modules/schedule/schedule-service.server";
import {
  approveScheduledTestContent,
  prepareScheduleServiceTest,
  scheduleTestEnv,
  scheduleTestViewer as viewer,
} from "~/modules/schedule/schedule-service-test-fixture";
import { eventLocalTimeEpoch } from "~/modules/schedule/schedule-time";
import { ensureDemoSubmissionForm } from "~/modules/submissions/demo-submissions.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { loader as publicProgrammePageLoader } from "~/routes/public-programme";
import { PublicRecordingService } from "./public-recording-service.server";
import { defaultPublicSiteDraft } from "./public-site";
import { publicSiteCommandIdForIntent } from "./public-site-command.server";
import {
  PublicSiteCommandConflictError,
  PublicSiteRevisionConflictError,
  PublicSiteService,
  PublicSiteValidationError,
} from "./public-site-service.server";

const publicSiteEnv = scheduleTestEnv as CloudflareEnvironment;

async function publishProgramme(sessionId = "schedule-test-one") {
  const schedule = new ScheduleService(publicSiteEnv);
  const versionId = await schedule.createDraft(viewer);
  let workspace = await schedule.getWorkspace(viewer);
  const startsAt = eventLocalTimeEpoch(
    workspace.event.startsAt,
    workspace.event.timezone,
    9,
  );
  await schedule.place(viewer, {
    scheduleVersionId: versionId,
    scheduleRevision: workspace.version!.revision,
    sessionId,
    roomId: "main",
    startsAt,
    endsAt: startsAt + 3_600,
  });
  await approveScheduledTestContent(versionId);
  workspace = await schedule.getWorkspace(viewer);
  await schedule.publish(viewer, {
    scheduleVersionId: versionId,
    scheduleRevision: workspace.version!.revision,
  });
  return { schedule, versionId, startsAt };
}

function publishableSite() {
  const configuration = defaultPublicSiteDraft();
  configuration.sectionVisibility.introduction = false;
  configuration.sectionVisibility.venue = false;
  return configuration;
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM event_session_recordings WHERE event_id = ?",
    ).bind(viewer.eventId),
    env.DB.prepare("DELETE FROM event_site_sponsors WHERE event_id = ?").bind(
      viewer.eventId,
    ),
    env.DB.prepare("DELETE FROM event_public_sites WHERE event_id = ?").bind(
      viewer.eventId,
    ),
  ]);
  await prepareScheduleServiceTest();
  await env.DB.prepare(
    "UPDATE sessions SET visibility = 'public' WHERE event_id = ?",
  )
    .bind(viewer.eventId)
    .run();
  await env.DB.prepare(
    "UPDATE people SET profile_status = 'published' WHERE id = ?",
  )
    .bind("person-demo-speaker")
    .run();
});

describe("public event site publication", () => {
  it("keeps consequential command identities stable for one entity generation", async () => {
    const first = await publicSiteCommandIdForIntent(
      viewer,
      "publish-recording:recording-1:2:none:operation-1",
    );
    const replay = await publicSiteCommandIdForIntent(
      viewer,
      "publish-recording:recording-1:2:none:operation-1",
    );
    const nextGeneration = await publicSiteCommandIdForIntent(
      viewer,
      "publish-recording:recording-1:2:2:operation-2",
    );

    expect(first).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(replay).toBe(first);
    expect(nextGeneration).not.toBe(first);
  });

  it("converges exact command replays and rejects changed payload reuse", async () => {
    const service = new PublicSiteService(publicSiteEnv);
    const configuration = publishableSite();
    const commandId = crypto.randomUUID();
    const input = {
      commandId,
      revision: 0,
      configurationJson: JSON.stringify(configuration),
    };

    const first = await service.saveDraft(viewer, input);
    const replay = await service.saveDraft(viewer, input);
    expect(replay).toEqual(first);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
          WHERE event_id = ? AND action = 'public_site.draft_saved'`,
      )
        .bind(viewer.eventId)
        .first(),
    ).toEqual({ count: 1 });

    configuration.tagline = "Different details";
    await expect(
      service.saveDraft(viewer, {
        ...input,
        configurationJson: JSON.stringify(configuration),
      }),
    ).rejects.toBeInstanceOf(PublicSiteCommandConflictError);
  });

  it("deduplicates sponsor and recording creation commands", async () => {
    const service = new PublicSiteService(publicSiteEnv);
    await service.saveDraft(viewer, {
      commandId: crypto.randomUUID(),
      revision: 0,
      configurationJson: JSON.stringify(publishableSite()),
    });
    const sponsorInput = {
      commandId: crypto.randomUUID(),
      id: "",
      revision: 0,
      name: "Replay-safe partner",
      tier: "Community",
      websiteUrl: "",
      logoUrl: "",
      description: "",
      position: 0,
    };
    const firstSponsor = await service.saveSponsor(viewer, sponsorInput);
    expect(await service.saveSponsor(viewer, sponsorInput)).toEqual(
      firstSponsor,
    );

    const recordings = new PublicRecordingService(publicSiteEnv);
    const recordingInput = {
      commandId: crypto.randomUUID(),
      id: "",
      sessionId: "schedule-test-one",
      revision: 0,
      title: "Replay-safe recording",
      recordingUrl: "https://video.example.test/replay",
      captionsUrl: "",
      transcriptUrl: "",
    };
    const firstRecording = await recordings.saveDraft(viewer, recordingInput);
    expect(await recordings.saveDraft(viewer, recordingInput)).toEqual(
      firstRecording,
    );

    const counts = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM event_site_sponsors WHERE event_id = ?) AS sponsors,
         (SELECT COUNT(*) FROM event_session_recordings WHERE event_id = ?) AS recordings`,
    )
      .bind(viewer.eventId, viewer.eventId)
      .first();
    expect(counts).toEqual({ sponsors: 1, recordings: 1 });
  });

  it("publishes an event site before its programme when programme sections are hidden", async () => {
    const preProgrammeEnv = new Proxy(publicSiteEnv, {
      get(target, property, receiver) {
        if (property === "DEMO_MODE") return "false";
        return Reflect.get(target, property, receiver);
      },
    });
    const service = new PublicSiteService(preProgrammeEnv);
    const configuration = publishableSite();
    configuration.sectionVisibility.statistics = false;
    configuration.tagline = "Applications are open";
    const saved = await service.saveDraft(viewer, {
      commandId: crypto.randomUUID(),
      revision: 0,
      configurationJson: JSON.stringify(configuration),
    });
    await service.publish(viewer, {
      commandId: crypto.randomUUID(),
      revision: saved.revision,
      confirmed: "true",
    });

    const workspace = await service.getWorkspace(viewer);
    expect(workspace.programme).toBeNull();
    const published = await service.getPublished("future-of-events-2027");
    expect(published).toMatchObject({
      configuration: { tagline: "Applications are open" },
      event: { slug: "future-of-events-2027" },
    });

    const context = new RouterContextProvider();
    context.set(cloudflareContext, {
      env: preProgrammeEnv,
      ctx: {} as ExecutionContext,
    });
    const routeResult = await publicProgrammePageLoader({
      request: new Request(
        "https://programcue.test/public/programme/future-of-events-2027",
      ),
      params: { slug: "future-of-events-2027" },
      context,
    } as never);
    if (routeResult instanceof Response)
      throw new Error("Pre-programme event site returned a raw response.");
    expect(routeResult.data).toMatchObject({
      eventSiteOnly: true,
      site: { configuration: { tagline: "Applications are open" } },
    });
    expect(routeResult.init?.headers).toMatchObject({
      "cache-control": "public, max-age=0, s-maxage=0, must-revalidate",
    });
  });

  it("projects a published CFP as closed after its closing time", async () => {
    await ensureDemoSubmissionForm(publicSiteEnv);
    const service = new PublicSiteService(publicSiteEnv);
    const configuration = publishableSite();
    configuration.sectionVisibility.statistics = false;
    const saved = await service.saveDraft(viewer, {
      commandId: crypto.randomUUID(),
      revision: 0,
      configurationJson: JSON.stringify(configuration),
    });
    await service.publish(viewer, {
      commandId: crypto.randomUUID(),
      revision: saved.revision,
      confirmed: "true",
    });
    const form = await env.DB.prepare(
      `SELECT id, closes_at AS closesAt
         FROM form_definitions
        WHERE event_id = ? AND kind = 'submission' AND status = 'published'
        ORDER BY updated_at DESC, id
        LIMIT 1`,
    )
      .bind(viewer.eventId)
      .first<{ id: string; closesAt: number | null }>();
    expect(form).not.toBeNull();
    await env.DB.prepare(
      "UPDATE form_definitions SET closes_at = ? WHERE id = ? AND event_id = ?",
    )
      .bind(100, form!.id, viewer.eventId)
      .run();
    try {
      expect(
        (await service.getPublished("future-of-events-2027", 101))?.event
          .application,
      ).toEqual({
        url: expect.stringMatching(/^\/apply\//u),
        state: "closed",
      });
    } finally {
      await env.DB.prepare(
        "UPDATE form_definitions SET closes_at = ? WHERE id = ? AND event_id = ?",
      )
        .bind(form!.closesAt, form!.id, viewer.eventId)
        .run();
    }
  });

  it("converges an exact site-publication replay without advancing event state", async () => {
    await publishProgramme();
    const service = new PublicSiteService(publicSiteEnv);
    const saved = await service.saveDraft(viewer, {
      commandId: crypto.randomUUID(),
      revision: 0,
      configurationJson: JSON.stringify(publishableSite()),
    });
    const commandId = crypto.randomUUID();
    const input = {
      commandId,
      revision: saved.revision,
      confirmed: "true" as const,
    };
    const first = await service.publish(viewer, input);
    const eventAfterFirst = await env.DB.prepare(
      "SELECT revision FROM events WHERE id = ?",
    )
      .bind(viewer.eventId)
      .first();
    expect(await service.publish(viewer, input)).toEqual(first);
    expect(
      await env.DB.prepare("SELECT revision FROM events WHERE id = ?")
        .bind(viewer.eventId)
        .first(),
    ).toEqual(eventAfterFirst);
  });

  it("keeps the published snapshot immutable while a newer site draft is edited", async () => {
    await publishProgramme();
    const service = new PublicSiteService(publicSiteEnv);
    const first = publishableSite();
    first.tagline = "Published destination";
    const saved = await service.saveDraft(viewer, {
      commandId: crypto.randomUUID(),
      revision: 0,
      configurationJson: JSON.stringify(first),
    });
    await service.publish(viewer, {
      commandId: crypto.randomUUID(),
      revision: saved.revision,
      confirmed: "true",
    });

    const second = structuredClone(first);
    second.tagline = "Unpublished replacement";
    await service.saveDraft(viewer, {
      commandId: crypto.randomUUID(),
      revision: saved.revision,
      configurationJson: JSON.stringify(second),
    });

    const [workspace, published] = await Promise.all([
      service.getWorkspace(viewer),
      service.getPublished("future-of-events-2027"),
    ]);
    expect(workspace.draft.configuration.tagline).toBe(
      "Unpublished replacement",
    );
    expect(workspace.hasUnpublishedChanges).toBe(true);
    expect(published?.configuration.tagline).toBe("Published destination");
  });

  it("snapshots sponsors and does not advance the site revision on a stale delete", async () => {
    await publishProgramme();
    const service = new PublicSiteService(publicSiteEnv);
    const configuration = publishableSite();
    configuration.pages.sponsors.enabled = true;
    const saved = await service.saveDraft(viewer, {
      commandId: crypto.randomUUID(),
      revision: 0,
      configurationJson: JSON.stringify(configuration),
    });
    const sponsor = await service.saveSponsor(viewer, {
      commandId: crypto.randomUUID(),
      id: "",
      revision: 0,
      name: "Example partner",
      tier: "Gold",
      websiteUrl: "https://example.com",
      logoUrl: "https://example.com/logo.png",
      description: "Supports the event.",
      position: 0,
    });
    const withSponsor = await service.getWorkspace(viewer);
    expect(withSponsor.draft.revision).toBe(saved.revision + 1);
    await service.publish(viewer, {
      commandId: crypto.randomUUID(),
      revision: withSponsor.draft.revision,
      confirmed: "true",
    });

    await expect(
      service.deleteSponsor(viewer, {
        commandId: crypto.randomUUID(),
        id: sponsor.id,
        revision: 99,
        confirmed: "true",
      }),
    ).rejects.toBeInstanceOf(PublicSiteRevisionConflictError);
    const afterConflict = await service.getWorkspace(viewer);
    expect(afterConflict.draft.revision).toBe(withSponsor.draft.revision);
    expect(afterConflict.sponsors).toHaveLength(1);
    expect(
      (await service.getPublished("future-of-events-2027"))?.configuration
        .sponsors,
    ).toEqual([
      expect.objectContaining({ id: sponsor.id, name: "Example partner" }),
    ]);
  });

  it("updates every sponsor field without changing the published snapshot", async () => {
    await publishProgramme();
    const service = new PublicSiteService(publicSiteEnv);
    const saved = await service.saveDraft(viewer, {
      commandId: crypto.randomUUID(),
      revision: 0,
      configurationJson: JSON.stringify(publishableSite()),
    });
    const sponsor = await service.saveSponsor(viewer, {
      commandId: crypto.randomUUID(),
      id: "",
      revision: 0,
      name: "Original partner",
      tier: "Community",
      websiteUrl: "https://old.example.test",
      logoUrl: "",
      description: "Original description",
      position: 0,
    });
    const beforePublish = await service.getWorkspace(viewer);
    await service.publish(viewer, {
      commandId: crypto.randomUUID(),
      revision: beforePublish.draft.revision,
      confirmed: "true",
    });

    await service.saveSponsor(viewer, {
      commandId: crypto.randomUUID(),
      id: sponsor.id,
      revision: 1,
      name: "Updated partner",
      tier: "Gold",
      websiteUrl: "https://new.example.test",
      logoUrl: "https://new.example.test/logo.svg",
      description: "Updated description",
      position: 3,
    });

    const workspace = await service.getWorkspace(viewer);
    expect(workspace.draft.revision).toBe(saved.revision + 2);
    expect(workspace.sponsors).toEqual([
      expect.objectContaining({
        id: sponsor.id,
        name: "Updated partner",
        tier: "Gold",
        websiteUrl: "https://new.example.test",
        logoUrl: "https://new.example.test/logo.svg",
        description: "Updated description",
        position: 3,
        revision: 2,
      }),
    ]);
    expect(
      (await service.getPublished("future-of-events-2027"))?.configuration
        .sponsors,
    ).toEqual([
      expect.objectContaining({
        id: sponsor.id,
        name: "Original partner",
        tier: "Community",
      }),
    ]);
  });

  it("blocks a schedule that removes a session featured by the published site", async () => {
    const { schedule } = await publishProgramme();
    const site = new PublicSiteService(publicSiteEnv);
    const configuration = publishableSite();
    configuration.sectionVisibility.featured_sessions = true;
    configuration.featuredSessionIds = ["schedule-test-one"];
    const saved = await site.saveDraft(viewer, {
      commandId: crypto.randomUUID(),
      revision: 0,
      configurationJson: JSON.stringify(configuration),
    });
    await site.publish(viewer, {
      commandId: crypto.randomUUID(),
      revision: saved.revision,
      confirmed: "true",
    });

    const replacementId = await schedule.createDraft(viewer);
    let workspace = await schedule.getWorkspace(viewer);
    const featuredEntry = workspace.entries.find(
      (entry) => entry.sessionId === "schedule-test-one",
    )!;
    await schedule.unassign(viewer, {
      scheduleVersionId: replacementId,
      scheduleRevision: workspace.version!.revision,
      entryId: featuredEntry.id,
    });
    workspace = await schedule.getWorkspace(viewer);
    await schedule.place(viewer, {
      scheduleVersionId: replacementId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-two",
      roomId: "main",
      startsAt: featuredEntry.startsAt,
      endsAt: featuredEntry.endsAt,
    });
    await approveScheduledTestContent(replacementId);
    workspace = await schedule.getWorkspace(viewer);

    await expect(
      schedule.publish(viewer, {
        scheduleVersionId: replacementId,
        scheduleRevision: workspace.version!.revision,
      }),
    ).rejects.toThrow(/public event home features session/i);
  });

  it("blocks a referenced published session from being cancelled directly", async () => {
    await publishProgramme();
    const site = new PublicSiteService(publicSiteEnv);
    const configuration = publishableSite();
    configuration.sectionVisibility.featured_sessions = true;
    configuration.featuredSessionIds = ["schedule-test-one"];
    const saved = await site.saveDraft(viewer, {
      commandId: crypto.randomUUID(),
      revision: 0,
      configurationJson: JSON.stringify(configuration),
    });
    await site.publish(viewer, {
      commandId: crypto.randomUUID(),
      revision: saved.revision,
      confirmed: "true",
    });

    await expect(
      env.DB.prepare(
        "UPDATE sessions SET status = 'cancelled' WHERE id = ? AND event_id = ?",
      )
        .bind("schedule-test-one", viewer.eventId)
        .run(),
    ).rejects.toThrow(/withdraw public-site references/i);
    expect(
      await env.DB.prepare(
        "SELECT status FROM sessions WHERE id = ? AND event_id = ?",
      )
        .bind("schedule-test-one", viewer.eventId)
        .first(),
    ).toEqual({ status: "published" });
  });

  it("blocks a featured published session from being hidden directly", async () => {
    await publishProgramme();
    const site = new PublicSiteService(publicSiteEnv);
    const configuration = publishableSite();
    configuration.sectionVisibility.featured_sessions = true;
    configuration.featuredSessionIds = ["schedule-test-one"];
    const saved = await site.saveDraft(viewer, {
      commandId: crypto.randomUUID(),
      revision: 0,
      configurationJson: JSON.stringify(configuration),
    });
    await site.publish(viewer, {
      commandId: crypto.randomUUID(),
      revision: saved.revision,
      confirmed: "true",
    });

    await expect(
      env.DB.prepare(
        "UPDATE sessions SET visibility = 'hidden' WHERE id = ? AND event_id = ?",
      )
        .bind("schedule-test-one", viewer.eventId)
        .run(),
    ).rejects.toThrow(/withdraw public-site references/i);
  });

  it("blocks a featured speaker profile from being unpublished", async () => {
    await publishProgramme();
    const site = new PublicSiteService(publicSiteEnv);
    const configuration = publishableSite();
    configuration.sectionVisibility.featured_speakers = true;
    configuration.featuredSpeakerIds = ["person-demo-speaker"];
    const saved = await site.saveDraft(viewer, {
      commandId: crypto.randomUUID(),
      revision: 0,
      configurationJson: JSON.stringify(configuration),
    });
    await site.publish(viewer, {
      commandId: crypto.randomUUID(),
      revision: saved.revision,
      confirmed: "true",
    });

    await expect(
      env.DB.prepare("UPDATE people SET profile_status = 'draft' WHERE id = ?")
        .bind("person-demo-speaker")
        .run(),
    ).rejects.toThrow(/featured speaker/i);
  });

  it("blocks hiding the last eligible session for a featured speaker", async () => {
    await publishProgramme();
    const site = new PublicSiteService(publicSiteEnv);
    const configuration = publishableSite();
    configuration.sectionVisibility.featured_speakers = true;
    configuration.featuredSpeakerIds = ["person-demo-speaker"];
    const saved = await site.saveDraft(viewer, {
      commandId: crypto.randomUUID(),
      revision: 0,
      configurationJson: JSON.stringify(configuration),
    });
    await site.publish(viewer, {
      commandId: crypto.randomUUID(),
      revision: saved.revision,
      confirmed: "true",
    });

    await expect(
      env.DB.prepare(
        "UPDATE sessions SET visibility = 'private' WHERE id = ? AND event_id = ?",
      )
        .bind("schedule-test-one", viewer.eventId)
        .run(),
    ).rejects.toThrow(/withdraw public-site references/i);
  });

  it("rejects enabled sections that would publish empty content", async () => {
    await publishProgramme();
    const service = new PublicSiteService(publicSiteEnv);
    const configuration = publishableSite();
    configuration.statisticVisibility = {
      sessions: false,
      speakers: false,
      tracks: false,
      days: false,
    };
    const emptyStatistics = await service.saveDraft(viewer, {
      commandId: crypto.randomUUID(),
      revision: 0,
      configurationJson: JSON.stringify(configuration),
    });
    await expect(
      service.publish(viewer, {
        commandId: crypto.randomUUID(),
        revision: emptyStatistics.revision,
        confirmed: "true",
      }),
    ).rejects.toThrow(/select at least one statistic/i);

    configuration.statisticVisibility.sessions = true;
    configuration.postEvent.enabled = true;
    configuration.postEvent.heading = "";
    const emptyPostEvent = await service.saveDraft(viewer, {
      commandId: crypto.randomUUID(),
      revision: emptyStatistics.revision,
      configurationJson: JSON.stringify(configuration),
    });
    await expect(
      service.publish(viewer, {
        commandId: crypto.randomUUID(),
        revision: emptyPostEvent.revision,
        confirmed: "true",
      }),
    ).rejects.toThrow(/post-event mode requires a heading/i);
  });

  it("exposes recordings only in published post-event mode and supports withdrawal", async () => {
    const { startsAt } = await publishProgramme();
    const service = new PublicSiteService(publicSiteEnv);
    const recordings = new PublicRecordingService(publicSiteEnv);
    const configuration = publishableSite();
    const savedSite = await service.saveDraft(viewer, {
      commandId: crypto.randomUUID(),
      revision: 0,
      configurationJson: JSON.stringify(configuration),
    });
    await service.publish(viewer, {
      commandId: crypto.randomUUID(),
      revision: savedSite.revision,
      confirmed: "true",
    });
    const recording = await recordings.saveDraft(viewer, {
      commandId: crypto.randomUUID(),
      id: "",
      sessionId: "schedule-test-one",
      revision: 0,
      title: "Session recording",
      recordingUrl: "https://video.example.test/watch",
      captionsUrl: "https://video.example.test/captions.vtt",
      transcriptUrl: "",
    });
    await recordings.publish(viewer, {
      commandId: crypto.randomUUID(),
      id: recording.id,
      revision: 1,
      confirmed: "true",
    });
    const event = await env.DB.prepare(
      "SELECT ends_at AS endsAt FROM events WHERE id = ?",
    )
      .bind(viewer.eventId)
      .first<{ endsAt: number }>();

    expect(
      (await service.getPublished("future-of-events-2027", startsAt))
        ?.recordings,
    ).toEqual([]);
    const afterEvent = Math.max(event!.endsAt, startsAt + 3_600) + 1;
    expect(
      (await service.getPublished("future-of-events-2027", afterEvent))
        ?.recordings,
    ).toEqual([]);

    configuration.postEvent.enabled = true;
    const postEventDraft = await service.saveDraft(viewer, {
      commandId: crypto.randomUUID(),
      revision: savedSite.revision,
      configurationJson: JSON.stringify(configuration),
    });
    await service.publish(viewer, {
      commandId: crypto.randomUUID(),
      revision: postEventDraft.revision,
      confirmed: "true",
    });
    expect(
      (await service.getPublished("future-of-events-2027", afterEvent))
        ?.recordings,
    ).toEqual([
      expect.objectContaining({
        id: recording.id,
        sessionId: "schedule-test-one",
        recordingUrl: "https://video.example.test/watch",
      }),
    ]);

    await recordings.unpublish(viewer, {
      commandId: crypto.randomUUID(),
      id: recording.id,
      revision: 1,
      confirmed: "true",
    });
    expect(
      (await service.getPublished("future-of-events-2027", afterEvent))
        ?.recordings,
    ).toEqual([]);
  });

  it("rejects recording publication when the session is no longer public", async () => {
    await publishProgramme();
    const recordings = new PublicRecordingService(publicSiteEnv);
    const recording = await recordings.saveDraft(viewer, {
      commandId: crypto.randomUUID(),
      id: "",
      sessionId: "schedule-test-one",
      revision: 0,
      title: "Private session recording",
      recordingUrl: "https://video.example.test/private",
      captionsUrl: "",
      transcriptUrl: "",
    });
    await env.DB.prepare(
      "UPDATE sessions SET visibility = 'hidden' WHERE id = ? AND event_id = ?",
    )
      .bind("schedule-test-one", viewer.eventId)
      .run();

    await expect(
      recordings.publish(viewer, {
        commandId: crypto.randomUUID(),
        id: recording.id,
        revision: 1,
        confirmed: "true",
      }),
    ).rejects.toBeInstanceOf(PublicSiteValidationError);
  });

  it("rejects recording publication when the session is no longer published", async () => {
    await publishProgramme();
    const recordings = new PublicRecordingService(publicSiteEnv);
    const recording = await recordings.saveDraft(viewer, {
      commandId: crypto.randomUUID(),
      id: "",
      sessionId: "schedule-test-one",
      revision: 0,
      title: "Cancelled session recording",
      recordingUrl: "https://video.example.test/cancelled",
      captionsUrl: "",
      transcriptUrl: "",
    });
    await env.DB.prepare(
      "UPDATE sessions SET status = 'cancelled' WHERE id = ? AND event_id = ?",
    )
      .bind("schedule-test-one", viewer.eventId)
      .run();

    await expect(
      recordings.publish(viewer, {
        commandId: crypto.randomUUID(),
        id: recording.id,
        revision: 1,
        confirmed: "true",
      }),
    ).rejects.toBeInstanceOf(PublicSiteValidationError);
  });

  it("blocks a schedule that would silently remove a published recording", async () => {
    const { schedule } = await publishProgramme();
    const recordings = new PublicRecordingService(publicSiteEnv);
    const recording = await recordings.saveDraft(viewer, {
      commandId: crypto.randomUUID(),
      id: "",
      sessionId: "schedule-test-one",
      revision: 0,
      title: "Published recording",
      recordingUrl: "https://video.example.test/watch",
      captionsUrl: "",
      transcriptUrl: "",
    });
    await recordings.publish(viewer, {
      commandId: crypto.randomUUID(),
      id: recording.id,
      revision: 1,
      confirmed: "true",
    });

    const replacementId = await schedule.createDraft(viewer);
    let workspace = await schedule.getWorkspace(viewer);
    const recordedEntry = workspace.entries.find(
      (entry) => entry.sessionId === "schedule-test-one",
    )!;
    await schedule.unassign(viewer, {
      scheduleVersionId: replacementId,
      scheduleRevision: workspace.version!.revision,
      entryId: recordedEntry.id,
    });
    workspace = await schedule.getWorkspace(viewer);
    await schedule.place(viewer, {
      scheduleVersionId: replacementId,
      scheduleRevision: workspace.version!.revision,
      sessionId: "schedule-test-two",
      roomId: "main",
      startsAt: recordedEntry.startsAt,
      endsAt: recordedEntry.endsAt,
    });
    await approveScheduledTestContent(replacementId);
    workspace = await schedule.getWorkspace(viewer);

    await expect(
      schedule.publish(viewer, {
        scheduleVersionId: replacementId,
        scheduleRevision: workspace.version!.revision,
      }),
    ).rejects.toThrow(/published recording/i);
  });

  it("blocks hiding a session that owns a published recording", async () => {
    await publishProgramme();
    const recordings = new PublicRecordingService(publicSiteEnv);
    const recording = await recordings.saveDraft(viewer, {
      commandId: crypto.randomUUID(),
      id: "",
      sessionId: "schedule-test-one",
      revision: 0,
      title: "Published recording",
      recordingUrl: "https://video.example.test/watch",
      captionsUrl: "",
      transcriptUrl: "",
    });
    await recordings.publish(viewer, {
      commandId: crypto.randomUUID(),
      id: recording.id,
      revision: 1,
      confirmed: "true",
    });

    await expect(
      env.DB.prepare(
        "UPDATE sessions SET visibility = 'private' WHERE id = ? AND event_id = ?",
      )
        .bind("schedule-test-one", viewer.eventId)
        .run(),
    ).rejects.toThrow(/withdraw public-site references and recordings/i);
  });
});
