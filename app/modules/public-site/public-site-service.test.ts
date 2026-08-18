import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { PublicProgrammeService } from "~/modules/programme/public-programme-service.server";
import { ScheduleService } from "~/modules/schedule/schedule-service.server";
import {
  approveScheduledTestContent,
  prepareScheduleServiceTest,
  scheduleTestEnv,
  scheduleTestViewer as viewer,
} from "~/modules/schedule/schedule-service-test-fixture";
import {
  eventLocalExclusiveEndEpoch,
  eventLocalTimeEpoch,
} from "~/modules/schedule/schedule-time";
import { ensureDemoSubmissionForm } from "~/modules/submissions/demo-submissions.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { loader as publicProgrammePageLoader } from "~/routes/public-programme";
import { loader as publicSitePageLoader } from "~/routes/public-site-page";
import { PublicRecordingService } from "./public-recording-service.server";
import { defaultPublicSiteDraft } from "./public-site";
import { publicSiteCommandIdForIntent } from "./public-site-command.server";
import {
  PUBLIC_SITE_SPEAKER_RELATIONSHIP_CONSTRAINT,
  PublishedPublicSiteInvariantError,
} from "./public-site-errors";
import {
  PublicSiteCommandConflictError,
  PublicSiteIntegrityError,
  PublicSiteRevisionConflictError,
  PublicSiteService,
  PublicSiteValidationError,
} from "./public-site-service.server";

const publicSiteEnv = scheduleTestEnv as CloudflareEnvironment;

function withSuppressedStatement(
  testEnv: CloudflareEnvironment,
  pattern: RegExp,
) {
  let suppressed = 0;
  const faultingDb = new Proxy(testEnv.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          if (suppressed > 0 || !pattern.test(query)) return statement;
          suppressed += 1;
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty === "bind") {
                return () =>
                  target.prepare(
                    "UPDATE people SET display_name = display_name WHERE 0",
                  );
              }
              const value = Reflect.get(statementTarget, statementProperty);
              return typeof value === "function"
                ? value.bind(statementTarget)
                : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    env: new Proxy(testEnv, {
      get(target, property) {
        return property === "DB" ? faultingDb : Reflect.get(target, property);
      },
    }),
    suppressed: () => suppressed,
  };
}

async function publishProgramme(
  sessionId: string | ReadonlyArray<string> = "schedule-test-one",
) {
  const sessionIds = typeof sessionId === "string" ? [sessionId] : sessionId;
  const schedule = new ScheduleService(publicSiteEnv);
  const versionId = await schedule.createDraft(viewer);
  let workspace = await schedule.getWorkspace(viewer);
  const startsAt = eventLocalTimeEpoch(
    workspace.event.startsAt,
    workspace.event.timezone,
    9,
  );
  for (const [index, id] of sessionIds.entries()) {
    await schedule.place(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: workspace.version!.revision,
      sessionId: id,
      roomId: index === 0 ? "main" : "301a",
      startsAt: startsAt + index * 3_600,
      endsAt: startsAt + (index + 1) * 3_600,
    });
    workspace = await schedule.getWorkspace(viewer);
  }
  await approveScheduledTestContent(versionId);
  workspace = await schedule.getWorkspace(viewer);
  await schedule.publish(viewer, {
    scheduleVersionId: versionId,
    scheduleRevision: workspace.version!.revision,
  });
  return { schedule, versionId, startsAt };
}

async function publishFeaturedSpeakerSite(personId = "person-demo-speaker") {
  const site = new PublicSiteService(publicSiteEnv);
  const configuration = publishableSite();
  configuration.sectionVisibility.featured_speakers = true;
  configuration.featuredSpeakerIds = [personId];
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
  return site;
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
    const site = await service.saveDraft(viewer, {
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
         (SELECT COUNT(*) FROM event_session_recordings WHERE event_id = ?) AS recordings,
         (SELECT draft_revision FROM event_public_sites WHERE event_id = ?) AS siteRevision`,
    )
      .bind(viewer.eventId, viewer.eventId, viewer.eventId)
      .first();
    expect(counts).toEqual({
      sponsors: 1,
      recordings: 1,
      siteRevision: site.revision + 1,
    });
  });

  it.each([
    ["audit insertion", /INSERT INTO audit_events/u],
    ["event-change insertion", /INSERT INTO event_changes/u],
    [
      "command completion",
      /UPDATE idempotency_records\s+SET status = 'completed'/u,
    ],
  ])(
    "rolls back a site draft when its %s is suppressed",
    async (_, pattern) => {
      const fault = withSuppressedStatement(publicSiteEnv, pattern);
      const commandId = crypto.randomUUID();
      const auditCount = await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
          WHERE event_id = ? AND action = 'public_site.draft_saved'`,
      )
        .bind(viewer.eventId)
        .first<{ count: number }>();

      await expect(
        new PublicSiteService(fault.env).saveDraft(viewer, {
          commandId,
          revision: 0,
          configurationJson: JSON.stringify(publishableSite()),
        }),
      ).rejects.toBeInstanceOf(PublicSiteIntegrityError);

      expect(fault.suppressed()).toBe(1);
      expect(
        await env.DB.prepare(
          `SELECT
           (SELECT COUNT(*) FROM event_public_sites WHERE event_id = ?) AS sites,
           (SELECT COUNT(*) FROM audit_events
             WHERE event_id = ? AND action = 'public_site.draft_saved') AS audits,
           (SELECT COUNT(*) FROM idempotency_records
             WHERE event_id = ? AND scope = 'public_site.draft.save'
               AND idempotency_key = ?) AS commands`,
        )
          .bind(viewer.eventId, viewer.eventId, viewer.eventId, commandId)
          .first(),
      ).toEqual({ sites: 0, audits: auditCount?.count, commands: 0 });
    },
  );

  it.each([
    [
      "featured-reference insertion",
      /INSERT INTO event_public_site_references/u,
    ],
    [
      "event projection update",
      /UPDATE events\s+SET revision = revision \+ 1/u,
    ],
  ])(
    "rolls back site publication when its %s is suppressed",
    async (_, pattern) => {
      await publishProgramme();
      const service = new PublicSiteService(publicSiteEnv);
      const configuration = publishableSite();
      configuration.sectionVisibility.featured_sessions = true;
      configuration.featuredSessionIds = ["schedule-test-one"];
      const saved = await service.saveDraft(viewer, {
        commandId: crypto.randomUUID(),
        revision: 0,
        configurationJson: JSON.stringify(configuration),
      });
      const before = await env.DB.prepare(
        `SELECT revision, public_projection_revision AS publicProjectionRevision
         FROM events WHERE id = ?`,
      )
        .bind(viewer.eventId)
        .first();
      const fault = withSuppressedStatement(publicSiteEnv, pattern);

      await expect(
        new PublicSiteService(fault.env).publish(viewer, {
          commandId: crypto.randomUUID(),
          revision: saved.revision,
          confirmed: "true",
        }),
      ).rejects.toBeInstanceOf(PublicSiteIntegrityError);

      expect(fault.suppressed()).toBe(1);
      expect(
        await env.DB.prepare(
          `SELECT published_json AS publishedJson,
                (SELECT COUNT(*) FROM event_public_site_references
                  WHERE event_id = site.event_id) AS referenceCount
           FROM event_public_sites site WHERE event_id = ?`,
        )
          .bind(viewer.eventId)
          .first(),
      ).toEqual({ publishedJson: null, referenceCount: 0 });
      expect(
        await env.DB.prepare(
          `SELECT revision, public_projection_revision AS publicProjectionRevision
           FROM events WHERE id = ?`,
        )
          .bind(viewer.eventId)
          .first(),
      ).toEqual(before);
    },
  );

  it("rolls back a sponsor when the parent site revision update is suppressed", async () => {
    const service = new PublicSiteService(publicSiteEnv);
    const saved = await service.saveDraft(viewer, {
      commandId: crypto.randomUUID(),
      revision: 0,
      configurationJson: JSON.stringify(publishableSite()),
    });
    const fault = withSuppressedStatement(
      publicSiteEnv,
      /UPDATE event_public_sites\s+SET draft_revision = draft_revision \+ 1/u,
    );

    await expect(
      new PublicSiteService(fault.env).saveSponsor(viewer, {
        commandId: crypto.randomUUID(),
        id: "",
        revision: 0,
        name: "Incomplete sponsor",
        tier: "Community",
        websiteUrl: "",
        logoUrl: "",
        description: "",
        position: 0,
      }),
    ).rejects.toBeInstanceOf(PublicSiteIntegrityError);

    expect(fault.suppressed()).toBe(1);
    expect(
      await env.DB.prepare(
        `SELECT draft_revision AS draftRevision,
                (SELECT COUNT(*) FROM event_site_sponsors
                  WHERE event_id = site.event_id) AS sponsorCount
           FROM event_public_sites site WHERE event_id = ?`,
      )
        .bind(viewer.eventId)
        .first(),
    ).toEqual({ draftRevision: saved.revision, sponsorCount: 0 });
  });

  it("rolls back recording publication when its event projection is suppressed", async () => {
    await publishProgramme();
    const recordings = new PublicRecordingService(publicSiteEnv);
    const recording = await recordings.saveDraft(viewer, {
      commandId: crypto.randomUUID(),
      id: "",
      sessionId: "schedule-test-one",
      revision: 0,
      title: "Incomplete recording",
      recordingUrl: "https://video.example.test/incomplete",
      captionsUrl: "",
      transcriptUrl: "",
    });
    const before = await env.DB.prepare(
      `SELECT revision, public_projection_revision AS publicProjectionRevision
         FROM events WHERE id = ?`,
    )
      .bind(viewer.eventId)
      .first();
    const fault = withSuppressedStatement(
      publicSiteEnv,
      /UPDATE events\s+SET revision = revision \+ 1/u,
    );

    await expect(
      new PublicRecordingService(fault.env).publish(viewer, {
        commandId: crypto.randomUUID(),
        id: recording.id,
        revision: 1,
        confirmed: "true",
      }),
    ).rejects.toBeInstanceOf(PublicSiteIntegrityError);

    expect(fault.suppressed()).toBe(1);
    expect(
      await env.DB.prepare(
        `SELECT published_at AS publishedAt, published_revision AS publishedRevision
           FROM event_session_recordings WHERE id = ?`,
      )
        .bind(recording.id)
        .first(),
    ).toEqual({ publishedAt: null, publishedRevision: null });
    expect(
      await env.DB.prepare(
        `SELECT revision, public_projection_revision AS publicProjectionRevision
           FROM events WHERE id = ?`,
      )
        .bind(viewer.eventId)
        .first(),
    ).toEqual(before);
  });

  it("rolls back recording withdrawal when its event projection is suppressed", async () => {
    await publishProgramme();
    const recordings = new PublicRecordingService(publicSiteEnv);
    const recording = await recordings.saveDraft(viewer, {
      commandId: crypto.randomUUID(),
      id: "",
      sessionId: "schedule-test-one",
      revision: 0,
      title: "Published recording",
      recordingUrl: "https://video.example.test/published",
      captionsUrl: "",
      transcriptUrl: "",
    });
    await recordings.publish(viewer, {
      commandId: crypto.randomUUID(),
      id: recording.id,
      revision: 1,
      confirmed: "true",
    });
    const before = await env.DB.prepare(
      `SELECT revision, public_projection_revision AS publicProjectionRevision
         FROM events WHERE id = ?`,
    )
      .bind(viewer.eventId)
      .first();
    const fault = withSuppressedStatement(
      publicSiteEnv,
      /UPDATE events\s+SET revision = revision \+ 1/u,
    );

    await expect(
      new PublicRecordingService(fault.env).unpublish(viewer, {
        commandId: crypto.randomUUID(),
        id: recording.id,
        revision: 1,
        confirmed: "true",
      }),
    ).rejects.toBeInstanceOf(PublicSiteIntegrityError);

    expect(fault.suppressed()).toBe(1);
    expect(
      await env.DB.prepare(
        `SELECT published_at IS NOT NULL AS published,
                published_revision AS publishedRevision
           FROM event_session_recordings WHERE id = ?`,
      )
        .bind(recording.id)
        .first(),
    ).toEqual({ published: 1, publishedRevision: 1 });
    expect(
      await env.DB.prepare(
        `SELECT revision, public_projection_revision AS publicProjectionRevision
           FROM events WHERE id = ?`,
      )
        .bind(viewer.eventId)
        .first(),
    ).toEqual(before);
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

  it("keeps programme home live and omits recordings from fixed-page cache representations", async () => {
    await publishProgramme();
    const service = new PublicSiteService(publicSiteEnv);
    const configuration = publishableSite();
    configuration.pages.about.enabled = true;
    configuration.pages.about.body = "Fixed editorial copy.";
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
    const context = new RouterContextProvider();
    context.set(cloudflareContext, {
      env: publicSiteEnv,
      ctx: {} as ExecutionContext,
    });

    const homepage = await publicProgrammePageLoader({
      request: new Request(
        "https://programcue.test/public/programme/future-of-events-2027",
        { headers: { "if-none-match": '"obsolete-recording-revision"' } },
      ),
      params: { slug: "future-of-events-2027" },
      context,
    } as never);
    if (homepage instanceof Response)
      throw new Error("Published programme homepage returned a raw response.");
    expect(homepage.init?.headers).toMatchObject({
      "cache-control": "private, no-store",
    });
    expect(homepage.init?.headers).not.toHaveProperty("etag");

    const fixedPage = await publicSitePageLoader({
      request: new Request(
        "https://programcue.test/public/programme/future-of-events-2027/pages/about",
      ),
      params: { slug: "future-of-events-2027", page: "about" },
      context,
    } as never);
    if (fixedPage instanceof Response)
      throw new Error("Published fixed page returned a raw response.");
    expect(fixedPage.data.site).not.toHaveProperty("recordings");
    expect(fixedPage.init?.headers).toHaveProperty("etag");
  });

  it("changes the fixed-page cache validator when a programme is later published", async () => {
    const preProgrammeEnv = new Proxy(publicSiteEnv, {
      get(target, property, receiver) {
        if (property === "DEMO_MODE") return "false";
        return Reflect.get(target, property, receiver);
      },
    });
    const service = new PublicSiteService(preProgrammeEnv);
    const configuration = publishableSite();
    configuration.sectionVisibility.statistics = false;
    configuration.pages.about.enabled = true;
    configuration.pages.about.body = "Pre-programme editorial copy.";
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
    const context = new RouterContextProvider();
    context.set(cloudflareContext, {
      env: preProgrammeEnv,
      ctx: {} as ExecutionContext,
    });
    const before = await publicSitePageLoader({
      request: new Request(
        "https://programcue.test/public/programme/future-of-events-2027/pages/about",
      ),
      params: { slug: "future-of-events-2027", page: "about" },
      context,
    } as never);
    if (before instanceof Response)
      throw new Error("Pre-programme fixed page returned a raw response.");
    expect(before.data.hasPublishedProgramme).toBe(false);
    const beforeEtag =
      before.init?.headers &&
      typeof before.init.headers === "object" &&
      "etag" in before.init.headers
        ? before.init.headers.etag
        : undefined;
    expect(beforeEtag).toEqual(expect.any(String));

    await publishProgramme();

    const after = await publicSitePageLoader({
      request: new Request(
        "https://programcue.test/public/programme/future-of-events-2027/pages/about",
      ),
      params: { slug: "future-of-events-2027", page: "about" },
      context,
    } as never);
    if (after instanceof Response)
      throw new Error("Post-programme fixed page returned a raw response.");
    expect(after.data.hasPublishedProgramme).toBe(true);
    const afterEtag =
      after.init?.headers &&
      typeof after.init.headers === "object" &&
      "etag" in after.init.headers
        ? after.init.headers.etag
        : undefined;
    expect(afterEtag).toEqual(expect.any(String));
    expect(afterEtag).not.toEqual(beforeEtag);
  });

  it("fails before storing D1-bound site or recording drafts for Airtable authority", async () => {
    const configuration = publishableSite();
    configuration.sectionVisibility.featured_sessions = true;
    configuration.featuredSessionIds = ["schedule-test-one"];
    const saved = await new PublicSiteService(publicSiteEnv).saveDraft(viewer, {
      commandId: crypto.randomUUID(),
      revision: 0,
      configurationJson: JSON.stringify(configuration),
    });
    await env.DB.prepare(
      "UPDATE events SET repository_provider = 'airtable' WHERE id = ? AND organisation_id = ?",
    )
      .bind(viewer.eventId, viewer.organisationId)
      .run();
    try {
      await expect(
        new PublicSiteService(publicSiteEnv).saveDraft(viewer, {
          commandId: crypto.randomUUID(),
          revision: saved.revision,
          configurationJson: JSON.stringify(configuration),
        }),
      ).rejects.toThrow(/unavailable for this event's programme source/u);
      await expect(
        new PublicSiteService(publicSiteEnv).publish(viewer, {
          commandId: crypto.randomUUID(),
          revision: saved.revision,
          confirmed: "true",
        }),
      ).rejects.toThrow(/unavailable for this event's programme source/u);
      await expect(
        new PublicRecordingService(publicSiteEnv).saveDraft(viewer, {
          commandId: crypto.randomUUID(),
          id: "",
          sessionId: "schedule-test-one",
          revision: 0,
          title: "Provider-mismatched recording",
          recordingUrl: "https://video.example.test/provider-mismatch",
          captionsUrl: "",
          transcriptUrl: "",
        }),
      ).rejects.toThrow(/unavailable for this event's programme source/u);

      expect(
        await env.DB.prepare(
          `SELECT
             (SELECT COUNT(*) FROM event_public_sites
               WHERE event_id = ? AND published_json IS NOT NULL) AS publishedSites,
             (SELECT COUNT(*) FROM event_session_recordings WHERE event_id = ?) AS recordings`,
        )
          .bind(viewer.eventId, viewer.eventId)
          .first(),
      ).toEqual({ publishedSites: 0, recordings: 0 });
    } finally {
      await env.DB.prepare(
        "UPDATE events SET repository_provider = 'd1' WHERE id = ? AND organisation_id = ?",
      )
        .bind(viewer.eventId, viewer.organisationId)
        .run();
    }
  });

  it("rejects hidden featured programme IDs for Airtable authority", async () => {
    const configuration = publishableSite();
    expect(configuration.sectionVisibility.featured_sessions).toBe(false);
    expect(configuration.sectionVisibility.featured_speakers).toBe(false);
    configuration.featuredSessionIds = ["schedule-test-one"];
    configuration.featuredSpeakerIds = ["person-demo-speaker"];
    await env.DB.prepare(
      "UPDATE events SET repository_provider = 'airtable' WHERE id = ? AND organisation_id = ?",
    )
      .bind(viewer.eventId, viewer.organisationId)
      .run();

    try {
      await expect(
        new PublicSiteService(publicSiteEnv).saveDraft(viewer, {
          commandId: crypto.randomUUID(),
          revision: 0,
          configurationJson: JSON.stringify(configuration),
        }),
      ).rejects.toThrow(/unavailable for this event's programme source/u);
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM event_public_sites WHERE event_id = ?",
        )
          .bind(viewer.eventId)
          .first(),
      ).toEqual({ count: 0 });
    } finally {
      await env.DB.prepare(
        "UPDATE events SET repository_provider = 'd1' WHERE id = ? AND organisation_id = ?",
      )
        .bind(viewer.eventId, viewer.organisationId)
        .run();
    }
  });

  it("fails public reads instead of serving D1 recordings after an Airtable authority switch", async () => {
    await publishProgramme();
    const siteService = new PublicSiteService(publicSiteEnv);
    const configuration = publishableSite();
    configuration.postEvent.enabled = true;
    const saved = await siteService.saveDraft(viewer, {
      commandId: crypto.randomUUID(),
      revision: 0,
      configurationJson: JSON.stringify(configuration),
    });
    await siteService.publish(viewer, {
      commandId: crypto.randomUUID(),
      revision: saved.revision,
      confirmed: "true",
    });
    const recordingService = new PublicRecordingService(publicSiteEnv);
    const recording = await recordingService.saveDraft(viewer, {
      commandId: crypto.randomUUID(),
      id: "",
      sessionId: "schedule-test-one",
      revision: 0,
      title: "D1 recording",
      recordingUrl: "https://video.example.test/d1-recording",
      captionsUrl: "",
      transcriptUrl: "",
    });
    await recordingService.publish(viewer, {
      commandId: crypto.randomUUID(),
      id: recording.id,
      revision: 1,
      confirmed: "true",
    });
    await env.DB.prepare(
      "UPDATE events SET repository_provider = 'airtable' WHERE id = ? AND organisation_id = ?",
    )
      .bind(viewer.eventId, viewer.organisationId)
      .run();

    try {
      await expect(
        siteService.getPublished(
          "future-of-events-2027",
          Number.MAX_SAFE_INTEGER,
        ),
      ).rejects.toBeInstanceOf(PublishedPublicSiteInvariantError);
    } finally {
      await env.DB.prepare(
        "UPDATE events SET repository_provider = 'd1' WHERE id = ? AND organisation_id = ?",
      )
        .bind(viewer.eventId, viewer.organisationId)
        .run();
    }
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

  it("blocks hiding or deleting the last public relationship for a featured speaker", async () => {
    await publishProgramme();
    await publishFeaturedSpeakerSite();

    await expect(
      env.DB.prepare(
        `UPDATE session_speakers
            SET visibility = 'private'
          WHERE session_id = ? AND event_id = ? AND person_id = ?`,
      )
        .bind("schedule-test-one", viewer.eventId, "person-demo-speaker")
        .run(),
    ).rejects.toThrow(PUBLIC_SITE_SPEAKER_RELATIONSHIP_CONSTRAINT);
    await expect(
      env.DB.prepare(
        `DELETE FROM session_speakers
          WHERE session_id = ? AND event_id = ? AND person_id = ?`,
      )
        .bind("schedule-test-one", viewer.eventId, "person-demo-speaker")
        .run(),
    ).rejects.toThrow(PUBLIC_SITE_SPEAKER_RELATIONSHIP_CONSTRAINT);
    expect(
      await env.DB.prepare(
        `SELECT visibility FROM session_speakers
          WHERE session_id = ? AND event_id = ? AND person_id = ?`,
      )
        .bind("schedule-test-one", viewer.eventId, "person-demo-speaker")
        .first(),
    ).toEqual({ visibility: "public" });
  });

  it("allows relationship changes when another public published relationship remains", async () => {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO session_speakers (
         session_id, event_id, person_id, position, role_label,
         participation_status, participation_confirmed_at, visibility
       ) VALUES (
         'schedule-test-two', ?, 'person-demo-speaker', 1, 'Speaker',
         'confirmed', unixepoch(), 'public'
       )`,
    )
      .bind(viewer.eventId)
      .run();
    await publishProgramme(["schedule-test-one", "schedule-test-two"]);
    await publishFeaturedSpeakerSite();

    await env.DB.prepare(
      `UPDATE session_speakers
          SET visibility = 'private'
        WHERE session_id = ? AND event_id = ? AND person_id = ?`,
    )
      .bind("schedule-test-one", viewer.eventId, "person-demo-speaker")
      .run();
    await env.DB.prepare(
      `DELETE FROM session_speakers
        WHERE session_id = ? AND event_id = ? AND person_id = ?`,
    )
      .bind("schedule-test-one", viewer.eventId, "person-demo-speaker")
      .run();

    expect(
      await env.DB.prepare(
        `SELECT visibility FROM session_speakers
          WHERE session_id = ? AND event_id = ? AND person_id = ?`,
      )
        .bind("schedule-test-two", viewer.eventId, "person-demo-speaker")
        .first(),
    ).toEqual({ visibility: "public" });
  });

  it("blocks hiding the last confirmed relationship when only a pending alternative remains", async () => {
    await publishProgramme(["schedule-test-one", "schedule-test-two"]);
    await env.DB.prepare(
      `INSERT INTO session_speakers (
         session_id, event_id, person_id, position, role_label,
         participation_status, participation_confirmed_at, visibility
       ) VALUES (
         'schedule-test-two', ?, 'person-demo-speaker', 20, 'Speaker',
         'pending', NULL, 'public'
       )
       ON CONFLICT(session_id, person_id) DO UPDATE SET
         participation_status = 'pending',
         participation_confirmed_at = NULL,
         visibility = 'public'`,
    )
      .bind(viewer.eventId)
      .run();
    await publishFeaturedSpeakerSite();

    await expect(
      env.DB.prepare(
        "UPDATE sessions SET visibility = 'private' WHERE id = ? AND event_id = ?",
      )
        .bind("schedule-test-one", viewer.eventId)
        .run(),
    ).rejects.toThrow(/withdraw public-site references/i);
    await expect(
      env.DB.prepare(
        `UPDATE session_speakers
            SET visibility = 'private'
          WHERE session_id = ? AND event_id = ? AND person_id = ?`,
      )
        .bind("schedule-test-one", viewer.eventId, "person-demo-speaker")
        .run(),
    ).rejects.toThrow(PUBLIC_SITE_SPEAKER_RELATIONSHIP_CONSTRAINT);

    expect(
      await env.DB.prepare(
        "SELECT visibility FROM sessions WHERE id = ? AND event_id = ?",
      )
        .bind("schedule-test-one", viewer.eventId)
        .first(),
    ).toEqual({ visibility: "public" });
    expect(
      await env.DB.prepare(
        `SELECT visibility, participation_status AS participationStatus
           FROM session_speakers
          WHERE session_id = ? AND event_id = ? AND person_id = ?`,
      )
        .bind("schedule-test-one", viewer.eventId, "person-demo-speaker")
        .first(),
    ).toEqual({ visibility: "public", participationStatus: "confirmed" });

    const programme = await new PublicProgrammeService(
      publicSiteEnv,
    ).getPublished("future-of-events-2027");
    const speaker = programme?.speakers.find(
      (candidate) => candidate.id === "person-demo-speaker",
    );
    expect(speaker?.sessionIds).toEqual(["schedule-test-one"]);
  });

  it("blocks rewriting session speaker relationship identity", async () => {
    await publishProgramme();
    await publishFeaturedSpeakerSite();

    await expect(
      env.DB.prepare(
        `UPDATE session_speakers
            SET person_id = 'person-demo-submitter'
          WHERE session_id = ? AND event_id = ? AND person_id = ?`,
      )
        .bind("schedule-test-one", viewer.eventId, "person-demo-speaker")
        .run(),
    ).rejects.toThrow(/relationship identity is immutable/i);
    await expect(
      env.DB.prepare(
        `UPDATE session_speakers
            SET session_id = 'schedule-test-two'
          WHERE session_id = ? AND event_id = ? AND person_id = ?`,
      )
        .bind("schedule-test-one", viewer.eventId, "person-demo-speaker")
        .run(),
    ).rejects.toThrow(/relationship identity is immutable/i);
    const retainedPersonId = "retained-participant-featured-bypass";
    await env.DB.prepare(
      `INSERT INTO people (
         id, email, display_name, email_verified, profile_status,
         created_at, updated_at
       ) VALUES (?, ?, 'Anonymised participant', 0, 'archived',
                 unixepoch(), unixepoch())`,
    )
      .bind(retainedPersonId, `${retainedPersonId}@example.com`)
      .run();
    await expect(
      env.DB.prepare(
        `UPDATE session_speakers
            SET person_id = ?
          WHERE session_id = ? AND event_id = ? AND person_id = ?`,
      )
        .bind(
          retainedPersonId,
          "schedule-test-one",
          viewer.eventId,
          "person-demo-speaker",
        )
        .run(),
    ).rejects.toThrow(/relationship identity is immutable/i);
    await env.DB.prepare(
      `UPDATE session_speakers
          SET person_id = person_id
        WHERE session_id = ? AND event_id = ? AND person_id = ?`,
    )
      .bind("schedule-test-one", viewer.eventId, "person-demo-speaker")
      .run();
    expect(
      await env.DB.prepare(
        `SELECT session_id AS sessionId, person_id AS personId
           FROM session_speakers
          WHERE session_id = ? AND event_id = ? AND person_id = ?`,
      )
        .bind("schedule-test-one", viewer.eventId, "person-demo-speaker")
        .first(),
    ).toEqual({
      sessionId: "schedule-test-one",
      personId: "person-demo-speaker",
    });
  });

  it("blocks changing the final featured relationship away from confirmed", async () => {
    await publishProgramme();
    await publishFeaturedSpeakerSite();

    await expect(
      env.DB.prepare(
        `UPDATE session_speakers
            SET participation_status = 'pending',
                participation_confirmed_at = NULL
          WHERE session_id = ? AND event_id = ? AND person_id = ?`,
      )
        .bind("schedule-test-one", viewer.eventId, "person-demo-speaker")
        .run(),
    ).rejects.toThrow(PUBLIC_SITE_SPEAKER_RELATIONSHIP_CONSTRAINT);
    expect(
      await env.DB.prepare(
        `SELECT visibility, participation_status AS participationStatus
           FROM session_speakers
          WHERE session_id = ? AND event_id = ? AND person_id = ?`,
      )
        .bind("schedule-test-one", viewer.eventId, "person-demo-speaker")
        .first(),
    ).toEqual({ visibility: "public", participationStatus: "confirmed" });
  });

  it("allows unconfirming a featured relationship when another confirmed public relationship remains", async () => {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO session_speakers (
         session_id, event_id, person_id, position, role_label,
         participation_status, participation_confirmed_at, visibility
       ) VALUES (
         'schedule-test-two', ?, 'person-demo-speaker', 1, 'Speaker',
         'confirmed', unixepoch(), 'public'
       )`,
    )
      .bind(viewer.eventId)
      .run();
    await publishProgramme(["schedule-test-one", "schedule-test-two"]);
    await publishFeaturedSpeakerSite();

    await env.DB.prepare(
      `UPDATE session_speakers
          SET participation_status = 'pending',
              participation_confirmed_at = NULL
        WHERE session_id = ? AND event_id = ? AND person_id = ?`,
    )
      .bind("schedule-test-one", viewer.eventId, "person-demo-speaker")
      .run();

    const programme = await new PublicProgrammeService(
      publicSiteEnv,
    ).getPublished("future-of-events-2027");
    expect(
      programme?.speakers.find(
        (candidate) => candidate.id === "person-demo-speaker",
      )?.sessionIds,
    ).toEqual(["schedule-test-two"]);
  });

  it("blocks remapping an unfeatured speaker onto an unrelated retained identity", async () => {
    await publishProgramme();
    const retainedPersonId = "retained-participant-unrelated-identity";
    await env.DB.prepare(
      `INSERT INTO people (
         id, email, display_name, email_verified, profile_status,
         created_at, updated_at
       ) VALUES (?, ?, 'Anonymised participant', 0, 'archived',
                 unixepoch(), unixepoch())`,
    )
      .bind(retainedPersonId, `${retainedPersonId}@example.com`)
      .run();
    await expect(
      env.DB.prepare(
        `UPDATE session_speakers
            SET person_id = ?
          WHERE session_id = ? AND event_id = ? AND person_id = ?`,
      )
        .bind(
          retainedPersonId,
          "schedule-test-one",
          viewer.eventId,
          "person-demo-speaker",
        )
        .run(),
    ).rejects.toThrow(/relationship identity is immutable/i);
  });

  it("lets an unfeatured speaker move between pending and confirmed", async () => {
    await publishProgramme();
    await env.DB.prepare(
      `UPDATE session_speakers
          SET participation_status = 'pending',
              participation_confirmed_at = NULL
        WHERE session_id = ? AND event_id = ? AND person_id = ?`,
    )
      .bind("schedule-test-one", viewer.eventId, "person-demo-speaker")
      .run();
    await env.DB.prepare(
      `UPDATE session_speakers
          SET participation_status = 'confirmed',
              participation_confirmed_at = unixepoch()
        WHERE session_id = ? AND event_id = ? AND person_id = ?`,
    )
      .bind("schedule-test-one", viewer.eventId, "person-demo-speaker")
      .run();

    expect(
      await env.DB.prepare(
        `SELECT participation_status AS participationStatus
           FROM session_speakers
          WHERE session_id = ? AND event_id = ? AND person_id = ?`,
      )
        .bind("schedule-test-one", viewer.eventId, "person-demo-speaker")
        .first(),
    ).toEqual({ participationStatus: "confirmed" });
  });

  it("fails closed when a published featured speaker lacks a confirmed public membership", async () => {
    await publishProgramme();
    const personId = `unconfirmed-featured-${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, email_verified, profile_status,
           created_at, updated_at
         ) VALUES (?, ?, 'Unconfirmed Featured', 1, 'published',
                   unixepoch(), unixepoch())`,
      ).bind(personId, `${personId}@example.com`),
      env.DB.prepare(
        `INSERT INTO session_speakers (
           session_id, event_id, person_id, position, role_label,
           participation_status, participation_confirmed_at, visibility
         ) VALUES ('schedule-test-one', ?, ?, 40, 'Speaker',
                   'pending', NULL, 'public')`,
      ).bind(viewer.eventId, personId),
      env.DB.prepare(
        `INSERT INTO event_public_sites (
           event_id, organisation_id, draft_json, draft_revision,
           published_json, published_revision, published_at,
           last_updated_by_person_id, last_operation_id, created_at, updated_at
         ) VALUES (
           ?, ?, '{}', 1, '{}', 1, unixepoch(), ?, ?, unixepoch(), unixepoch()
         )`,
      ).bind(
        viewer.eventId,
        viewer.organisationId,
        viewer.personId,
        `featured-guard-${personId}`,
      ),
      env.DB.prepare(
        `INSERT INTO event_public_site_references (
           event_id, organisation_id, kind, record_id, site_revision
         ) VALUES (?, ?, 'speaker', ?, 1)`,
      ).bind(viewer.eventId, viewer.organisationId, personId),
    ]);

    const guardTable = `migration_0042_featured_speaker_guard_${crypto.randomUUID().replaceAll("-", "")}`;
    try {
      await expect(
        env.DB.batch([
          env.DB.prepare(`
            CREATE TABLE ${guardTable} (
              published_featured_speakers_must_be_confirmed INTEGER NOT NULL
                CHECK (published_featured_speakers_must_be_confirmed = 1)
            )
          `),
          env.DB.prepare(
            `INSERT INTO ${guardTable} (
               published_featured_speakers_must_be_confirmed
             )
             SELECT 0
               FROM event_public_site_references reference
               JOIN event_public_sites site
                 ON site.event_id = reference.event_id
                AND site.published_at IS NOT NULL
              WHERE reference.kind = 'speaker'
                AND NOT EXISTS (
                  SELECT 1
                    FROM session_speakers relation
                    JOIN sessions session
                      ON session.id = relation.session_id
                     AND session.event_id = relation.event_id
                    JOIN people person ON person.id = relation.person_id
                    JOIN schedule_entries entry
                      ON entry.event_id = relation.event_id
                     AND entry.session_id = relation.session_id
                    JOIN schedule_versions version
                      ON version.id = entry.schedule_version_id
                     AND version.event_id = entry.event_id
                     AND version.status = 'published'
                    JOIN schedule_session_contents content
                      ON content.event_id = entry.event_id
                     AND content.schedule_version_id = entry.schedule_version_id
                     AND content.session_id = entry.session_id
                     AND content.visibility = 'public'
                   WHERE relation.event_id = reference.event_id
                     AND relation.person_id = reference.record_id
                     AND relation.visibility = 'public'
                     AND relation.participation_status = 'confirmed'
                     AND person.profile_status = 'published'
                     AND session.status = 'published'
                     AND session.visibility = 'public'
                )
              LIMIT 1`,
          ),
        ]),
      ).rejects.toThrow(/CHECK constraint failed/i);
    } finally {
      await env.DB.batch([
        env.DB.prepare(`DROP TABLE IF EXISTS ${guardTable}`),
        env.DB.prepare(
          `DELETE FROM session_speakers
            WHERE event_id = ? AND person_id = ?`,
        ).bind(viewer.eventId, personId),
        env.DB.prepare("DELETE FROM people WHERE id = ?").bind(personId),
      ]);
    }
  });

  it("records an event change for a published programme that still has a public pending speaker", async () => {
    await publishProgramme();
    const personId = `pending-public-${crypto.randomUUID()}`;
    const before = await env.DB.prepare(
      `SELECT public_projection_revision AS revision FROM events WHERE id = ?`,
    )
      .bind(viewer.eventId)
      .first<{ revision: number }>();
    await env.DB.prepare(
      `INSERT INTO people (
         id, email, display_name, email_verified, profile_status,
         created_at, updated_at
       ) VALUES (?, ?, 'Pending Public Speaker', 1, 'published',
                 unixepoch(), unixepoch())`,
    )
      .bind(personId, `${personId}@example.com`)
      .run();
    await env.DB.prepare(
      `INSERT INTO session_speakers (
         session_id, event_id, person_id, position, role_label,
         participation_status, participation_confirmed_at, visibility
       ) VALUES ('schedule-test-one', ?, ?, 41, 'Speaker',
                 'pending', NULL, 'public')`,
    )
      .bind(viewer.eventId, personId)
      .run();

    try {
      await env.DB.prepare(
        `INSERT INTO event_changes (
           event_id, entity_type, entity_id, change_type, correlation_id, created_at
         )
         SELECT DISTINCT event.id, 'event', event.id, 'updated',
                'migration-0042-public-speaker-eligibility', unixepoch()
           FROM events event
           JOIN schedule_versions version
             ON version.event_id = event.id
            AND version.status = 'published'
           JOIN schedule_entries entry
             ON entry.event_id = version.event_id
            AND entry.schedule_version_id = version.id
           JOIN sessions session
             ON session.id = entry.session_id
            AND session.event_id = entry.event_id
            AND session.status = 'published'
            AND session.visibility = 'public'
           JOIN schedule_session_contents content
             ON content.event_id = entry.event_id
            AND content.schedule_version_id = entry.schedule_version_id
            AND content.session_id = entry.session_id
            AND content.visibility = 'public'
           JOIN session_speakers relation
             ON relation.event_id = entry.event_id
            AND relation.session_id = entry.session_id
            AND relation.visibility = 'public'
            AND relation.participation_status = 'pending'
           JOIN people person
             ON person.id = relation.person_id
            AND person.profile_status = 'published'
          WHERE event.programme_published_at IS NOT NULL
            AND event.id = ?`,
      )
        .bind(viewer.eventId)
        .run();

      const after = await env.DB.prepare(
        `SELECT public_projection_revision AS revision,
                (SELECT COUNT(*) FROM event_changes change
                  WHERE change.event_id = events.id
                    AND change.correlation_id =
                        'migration-0042-public-speaker-eligibility') AS changeCount
           FROM events WHERE id = ?`,
      )
        .bind(viewer.eventId)
        .first<{ revision: number; changeCount: number }>();
      expect(after!.changeCount).toBe(1);
      expect(after!.revision).toBeGreaterThan(before!.revision);
    } finally {
      await env.DB.batch([
        env.DB.prepare(
          `DELETE FROM session_speakers WHERE event_id = ? AND person_id = ?`,
        ).bind(viewer.eventId, personId),
        env.DB.prepare("DELETE FROM people WHERE id = ?").bind(personId),
      ]);
    }
  });

  it("serves fixed editorial pages without reading an Airtable programme snapshot", async () => {
    await publishProgramme();
    const service = new PublicSiteService(publicSiteEnv);
    const configuration = publishableSite();
    configuration.pages.about.enabled = true;
    configuration.pages.about.body = "Fixed editorial copy.";
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
    await env.DB.prepare(
      "UPDATE events SET repository_provider = 'airtable' WHERE id = ? AND organisation_id = ?",
    )
      .bind(viewer.eventId, viewer.organisationId)
      .run();

    try {
      const context = new RouterContextProvider();
      context.set(cloudflareContext, {
        env: publicSiteEnv,
        ctx: {} as ExecutionContext,
      });
      const fixedPage = await publicSitePageLoader({
        request: new Request(
          "https://programcue.test/public/programme/future-of-events-2027/pages/about",
        ),
        params: { slug: "future-of-events-2027", page: "about" },
        context,
      } as never);
      if (fixedPage instanceof Response)
        throw new Error("Published fixed page returned a raw response.");
      expect(fixedPage.data.hasPublishedProgramme).toBe(true);
      expect(fixedPage.data.site.configuration.pages.about.body).toBe(
        "Fixed editorial copy.",
      );
    } finally {
      await env.DB.prepare(
        "UPDATE events SET repository_provider = 'd1' WHERE id = ? AND organisation_id = ?",
      )
        .bind(viewer.eventId, viewer.organisationId)
        .run();
    }
  });

  it("orders published recording speaker names by relationship position", async () => {
    await publishProgramme();
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO people (
          id, email, display_name, email_verified, profile_status, created_at, updated_at
        ) VALUES (
          'recording-speaker-late', 'recording-speaker-late@example.com',
          'Later Recording Speaker', 1, 'published', unixepoch(), unixepoch()
        )
      `),
      env.DB.prepare(`
        INSERT INTO people (
          id, email, display_name, email_verified, profile_status, created_at, updated_at
        ) VALUES (
          'recording-speaker-early', 'recording-speaker-early@example.com',
          'Earlier Recording Speaker', 1, 'published', unixepoch(), unixepoch()
        )
      `),
      env.DB.prepare(
        `INSERT INTO session_speakers (
           session_id, event_id, person_id, position,
           participation_status, participation_confirmed_at, visibility
         ) VALUES ('schedule-test-one', ?, 'recording-speaker-late', 20,
                   'confirmed', unixepoch(), 'public')`,
      ).bind(viewer.eventId),
      env.DB.prepare(
        `INSERT INTO session_speakers (
           session_id, event_id, person_id, position,
           participation_status, participation_confirmed_at, visibility
         ) VALUES ('schedule-test-one', ?, 'recording-speaker-early', 10,
                   'confirmed', unixepoch(), 'public')`,
      ).bind(viewer.eventId),
    ]);
    const recordings = new PublicRecordingService(publicSiteEnv);
    const recording = await recordings.saveDraft(viewer, {
      commandId: crypto.randomUUID(),
      id: "",
      sessionId: "schedule-test-one",
      revision: 0,
      title: "Ordered speakers",
      recordingUrl: "https://video.example.test/ordered",
      captionsUrl: "",
      transcriptUrl: "",
    });
    await recordings.publish(viewer, {
      commandId: crypto.randomUUID(),
      id: recording.id,
      revision: 1,
      confirmed: "true",
    });
    const published = await recordings.getPublishedForEvent(
      viewer.eventId,
      viewer.organisationId,
      Number.MAX_SAFE_INTEGER,
    );
    expect(published[0]?.speakerNames.slice(-2)).toEqual([
      "Earlier Recording Speaker",
      "Later Recording Speaker",
    ]);
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
      "SELECT ends_at AS endsAt, timezone FROM events WHERE id = ?",
    )
      .bind(viewer.eventId)
      .first<{ endsAt: number; timezone: string }>();

    expect(
      (await service.getPublished("future-of-events-2027", startsAt))
        ?.recordings,
    ).toEqual([]);
    const eventLocalExclusiveEnd = eventLocalExclusiveEndEpoch(
      event!.endsAt,
      event!.timezone,
    );
    expect(
      (
        await service.getPublished(
          "future-of-events-2027",
          eventLocalExclusiveEnd - 1,
        )
      )?.recordings,
    ).toEqual([]);
    expect(
      (
        await service.getPublished(
          "future-of-events-2027",
          eventLocalExclusiveEnd,
        )
      )?.recordings,
    ).toEqual([]);
    expect(
      await recordings.getRenderableForEvent(
        viewer.eventId,
        viewer.organisationId,
        event!.endsAt,
        event!.timezone,
        eventLocalExclusiveEnd - 1,
      ),
    ).toEqual([]);
    expect(
      await recordings.getRenderableForEvent(
        viewer.eventId,
        viewer.organisationId,
        event!.endsAt,
        event!.timezone,
        eventLocalExclusiveEnd,
      ),
    ).toEqual([
      expect.objectContaining({
        id: recording.id,
        sessionId: "schedule-test-one",
        recordingUrl: "https://video.example.test/watch",
      }),
    ]);

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
      (
        await service.getPublished(
          "future-of-events-2027",
          eventLocalExclusiveEnd,
        )
      )?.recordings,
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
      (
        await service.getPublished(
          "future-of-events-2027",
          eventLocalExclusiveEnd,
        )
      )?.recordings,
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
