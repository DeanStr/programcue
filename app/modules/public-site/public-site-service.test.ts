import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ScheduleService } from "~/modules/schedule/schedule-service.server";
import {
  approveScheduledTestContent,
  prepareScheduleServiceTest,
  scheduleTestEnv,
  scheduleTestViewer as viewer,
} from "~/modules/schedule/schedule-service-test-fixture";
import { eventLocalTimeEpoch } from "~/modules/schedule/schedule-time";
import { PublicRecordingService } from "./public-recording-service.server";
import { defaultPublicSiteDraft } from "./public-site";
import {
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
  await prepareScheduleServiceTest();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE sessions SET visibility = 'public' WHERE event_id = ?",
    ).bind(viewer.eventId),
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
});

describe("public event site publication", () => {
  it("keeps the published snapshot immutable while a newer site draft is edited", async () => {
    await publishProgramme();
    const service = new PublicSiteService(publicSiteEnv);
    const first = publishableSite();
    first.tagline = "Published destination";
    const saved = await service.saveDraft(viewer, {
      revision: 0,
      configurationJson: JSON.stringify(first),
    });
    await service.publish(viewer, {
      revision: saved.revision,
      confirmed: "true",
    });

    const second = structuredClone(first);
    second.tagline = "Unpublished replacement";
    await service.saveDraft(viewer, {
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
      revision: 0,
      configurationJson: JSON.stringify(configuration),
    });
    const sponsor = await service.saveSponsor(viewer, {
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
      revision: withSponsor.draft.revision,
      confirmed: "true",
    });

    await expect(
      service.deleteSponsor(viewer, {
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
      revision: 0,
      configurationJson: JSON.stringify(publishableSite()),
    });
    const sponsor = await service.saveSponsor(viewer, {
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
      revision: beforePublish.draft.revision,
      confirmed: "true",
    });

    await service.saveSponsor(viewer, {
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
      revision: 0,
      configurationJson: JSON.stringify(configuration),
    });
    await site.publish(viewer, {
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
      revision: 0,
      configurationJson: JSON.stringify(configuration),
    });
    await expect(
      service.publish(viewer, {
        revision: emptyStatistics.revision,
        confirmed: "true",
      }),
    ).rejects.toThrow(/select at least one statistic/i);

    configuration.statisticVisibility.sessions = true;
    configuration.postEvent.enabled = true;
    configuration.postEvent.heading = "";
    const emptyPostEvent = await service.saveDraft(viewer, {
      revision: emptyStatistics.revision,
      configurationJson: JSON.stringify(configuration),
    });
    await expect(
      service.publish(viewer, {
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
      revision: 0,
      configurationJson: JSON.stringify(configuration),
    });
    await service.publish(viewer, {
      revision: savedSite.revision,
      confirmed: "true",
    });
    const recording = await recordings.saveDraft(viewer, {
      id: "",
      sessionId: "schedule-test-one",
      revision: 0,
      title: "Session recording",
      recordingUrl: "https://video.example.test/watch",
      captionsUrl: "https://video.example.test/captions.vtt",
      transcriptUrl: "",
    });
    await recordings.publish(viewer, {
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
      revision: savedSite.revision,
      configurationJson: JSON.stringify(configuration),
    });
    await service.publish(viewer, {
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
      id: "",
      sessionId: "schedule-test-one",
      revision: 0,
      title: "Published recording",
      recordingUrl: "https://video.example.test/watch",
      captionsUrl: "",
      transcriptUrl: "",
    });
    await recordings.publish(viewer, {
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
});
