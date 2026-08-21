import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { cloudflareContext } from "~/platform/cloudflare-context";
import { action, loader } from "~/routes/programme-preview";
import {
  ScheduleReviewLinkExpiredError,
  ScheduleReviewLinkIntentReusedError,
  ScheduleReviewLinkLimitError,
  ScheduleReviewLinkRetentionError,
  ScheduleRevisionConflictError,
} from "./schedule-errors";
import {
  SCHEDULE_REVIEW_LINK_INACTIVE_LIST_LIMIT,
  ScheduleReviewLinkService,
} from "./schedule-review-link-service.server";
import {
  createScheduleReviewToken,
  hashScheduleReviewToken,
} from "./schedule-review-token.server";
import { SCHEDULE_REVIEW_LINK_ACKNOWLEDGEMENT } from "./schedule-schema";
import { ScheduleService } from "./schedule-service.server";
import {
  approveScheduledTestContent,
  prepareScheduleServiceTest,
  scheduleTestEnv,
  scheduleTestViewer as viewer,
} from "./schedule-service-test-fixture";
import { eventLocalTimeEpoch } from "./schedule-time";

beforeEach(prepareScheduleServiceTest);

function previewContext() {
  const value = new RouterContextProvider();
  value.set(cloudflareContext, {
    env: env as unknown as CloudflareEnvironment,
    ctx: {} as ExecutionContext,
  });
  return value;
}

const PLACEHOLDER_PROJECTION_HASH = "a".repeat(64);

async function reviewLinkCreateInput(
  schedule: ScheduleService,
  purpose = "Programme committee",
  extras: { createIntentId?: string; ttlDays?: number } = {},
) {
  const workspace = await schedule.getWorkspace(viewer);
  const summary = await schedule.summarizeReviewLinks(viewer, workspace);
  if (!summary.projectionHash) {
    throw new Error(summary.blockedReason ?? "missing projection hash");
  }
  return {
    scheduleVersionId: workspace.version!.id,
    scheduleRevision: workspace.version!.revision,
    acknowledgement: SCHEDULE_REVIEW_LINK_ACKNOWLEDGEMENT,
    projectionHash: summary.projectionHash,
    purpose,
    createIntentId: extras.createIntentId ?? crypto.randomUUID(),
    ttlDays: extras.ttlDays ?? 7,
  };
}

async function placedDraft() {
  const schedule = new ScheduleService(scheduleTestEnv);
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
    sessionId: "schedule-test-one",
    roomId: "main",
    startsAt,
    endsAt: startsAt + 3_600,
  });
  workspace = await schedule.getWorkspace(viewer);
  return { schedule, versionId, workspace, startsAt };
}

describe("schedule review links", () => {
  it("creates a frozen snapshot that ignores later room and speaker edits", async () => {
    const { schedule } = await placedDraft();
    await env.DB.prepare(
      `UPDATE session_speakers
          SET participation_status = 'pending',
              participation_confirmed_at = NULL
        WHERE session_id = 'schedule-test-one' AND event_id = ?`,
    )
      .bind(viewer.eventId)
      .run();
    const summary = await schedule.summarizeReviewLinks(viewer);
    expect(summary.disclosures).toEqual([
      expect.objectContaining({
        title: "First test session",
        room: "Main Stage",
        speakers: ["Priya Shah"],
      }),
    ]);
    const created = await schedule.createReviewLink(
      viewer,
      await reviewLinkCreateInput(schedule),
    );
    expect(created.path).toMatch(/^\/programme-preview\/[A-Za-z0-9_-]{43}$/u);
    expect(created.speakerNameCount).toBeGreaterThan(0);

    await env.DB.batch([
      env.DB.prepare(
        "UPDATE rooms SET name = 'Renamed Hall' WHERE id = 'main'",
      ),
      env.DB.prepare(
        "UPDATE people SET display_name = 'Changed Speaker' WHERE id = 'person-demo-speaker'",
      ),
    ]);

    const notice = await loader({
      request: new Request(`http://localhost${created.path}`),
      params: { token: created.token },
      context: previewContext(),
    } as never);
    expect(JSON.stringify(notice)).not.toContain("First test session");
    expect(JSON.stringify(notice)).not.toContain("Changed Speaker");
    expect(JSON.stringify(notice)).not.toContain("schemaVersion");

    const revealed = await action({
      request: new Request(`http://localhost${created.path}`, {
        method: "POST",
        headers: { origin: "http://localhost" },
      }),
      params: { token: created.token },
      context: previewContext(),
    } as never);
    if (revealed instanceof Response)
      throw new Error("Reveal returned a raw response.");
    expect(revealed.data).toMatchObject({
      kind: "snapshot",
      projection: {
        schemaVersion: 1,
        entries: [
          expect.objectContaining({
            title: "First test session",
            room: "Main Stage",
            speakers: expect.not.arrayContaining(["Changed Speaker"]),
          }),
        ],
      },
    });
    expect(JSON.stringify(revealed.data.projection)).not.toContain(
      "Renamed Hall",
    );
    expect(JSON.stringify(revealed.data)).not.toMatch(/person-demo-speaker/u);
  });

  it("excludes declined speakers and fails without a draft", async () => {
    const schedule = new ScheduleService(scheduleTestEnv);
    await expect(
      schedule.createReviewLink(viewer, {
        scheduleVersionId: "missing",
        scheduleRevision: 1,
        acknowledgement: SCHEDULE_REVIEW_LINK_ACKNOWLEDGEMENT,
        projectionHash: PLACEHOLDER_PROJECTION_HASH,
        purpose: "Programme committee",
        createIntentId: crypto.randomUUID(),
        ttlDays: 7,
      }),
    ).rejects.toThrow(/draft schedule is required/i);
    await expect(
      schedule.createReviewLink(viewer, {
        scheduleVersionId: "missing",
        scheduleRevision: 1,
        acknowledgement: SCHEDULE_REVIEW_LINK_ACKNOWLEDGEMENT,
        projectionHash: PLACEHOLDER_PROJECTION_HASH,
        purpose: "   ",
        createIntentId: crypto.randomUUID(),
        ttlDays: 7,
      }),
    ).rejects.toThrow(/short purpose/i);

    await placedDraft();
    await env.DB.prepare(
      `UPDATE session_speakers
          SET participation_status = 'declined',
              participation_confirmed_at = NULL,
              participation_declined_at = unixepoch()
        WHERE session_id = 'schedule-test-one' AND event_id = ?`,
    )
      .bind(viewer.eventId)
      .run();
    const created = await schedule.createReviewLink(
      viewer,
      await reviewLinkCreateInput(schedule),
    );
    expect(created.speakerNameCount).toBe(0);
  });

  it("omits private and hidden speaker listings from the frozen snapshot", async () => {
    const { schedule } = await placedDraft();
    await env.DB.prepare(
      `UPDATE session_speakers
          SET visibility = 'private'
        WHERE session_id = 'schedule-test-one' AND event_id = ?`,
    )
      .bind(viewer.eventId)
      .run();
    const privateLink = await schedule.createReviewLink(
      viewer,
      await reviewLinkCreateInput(schedule),
    );
    expect(privateLink.entryCount).toBe(1);
    expect(privateLink.speakerNameCount).toBe(0);

    await env.DB.prepare(
      `UPDATE session_speakers
          SET visibility = 'hidden'
        WHERE session_id = 'schedule-test-one' AND event_id = ?`,
    )
      .bind(viewer.eventId)
      .run();
    const hiddenLink = await schedule.createReviewLink(
      viewer,
      await reviewLinkCreateInput(schedule),
    );
    expect(hiddenLink.entryCount).toBe(1);
    expect(hiddenLink.speakerNameCount).toBe(0);

    await env.DB.prepare(
      `UPDATE session_speakers
          SET visibility = 'public'
        WHERE session_id = 'schedule-test-one'
          AND person_id = 'person-demo-speaker'
          AND event_id = ?`,
    )
      .bind(viewer.eventId)
      .run();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO session_speakers (
         session_id, event_id, person_id, position, role_label,
         participation_status, participation_confirmed_at, visibility
       ) VALUES (
         'schedule-test-one', ?, 'person-demo-submitter', 1, 'Speaker',
         'confirmed', unixepoch(), 'private'
       )`,
    )
      .bind(viewer.eventId)
      .run();
    await env.DB.prepare(
      `UPDATE session_speakers
          SET visibility = 'private'
        WHERE session_id = 'schedule-test-one'
          AND person_id = 'person-demo-submitter'
          AND event_id = ?`,
    )
      .bind(viewer.eventId)
      .run();
    const mixed = await schedule.summarizeReviewLinks(viewer);
    expect(mixed.disclosures[0]?.speakers).toEqual(["Priya Shah"]);
    const mixedLink = await schedule.createReviewLink(
      viewer,
      await reviewLinkCreateInput(schedule),
    );
    expect(mixedLink.speakerNameCount).toBe(1);
  });

  it("enforces the active-link cap and lists metadata without the projection", async () => {
    const { schedule, workspace } = await placedDraft();
    for (let index = 0; index < 10; index += 1) {
      await schedule.createReviewLink(
        viewer,
        await reviewLinkCreateInput(schedule, `Reviewer ${index + 1}`),
      );
    }
    await expect(
      schedule.createReviewLink(viewer, await reviewLinkCreateInput(schedule)),
    ).rejects.toBeInstanceOf(ScheduleReviewLinkLimitError);
    const summary = await schedule.summarizeReviewLinks(viewer, workspace);
    expect(summary.canCreate).toBe(false);
    expect(summary.blockedReason).toMatch(/10 active draft review links/i);
    expect(summary.projectionHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(summary.disclosures[0]?.title).toBe("First test session");

    const listed = await schedule.listReviewLinks(viewer);
    expect(listed.items).toHaveLength(10);
    expect(listed.omittedInactiveCount).toBe(0);
    expect(listed.items.every((link) => link.status === "active")).toBe(true);
    expect(new Set(listed.items.map((link) => link.purpose)).size).toBe(10);
    const creator = await env.DB.prepare(
      "SELECT display_name AS displayName FROM people WHERE id = ?",
    )
      .bind(viewer.personId)
      .first<{ displayName: string }>();
    expect(listed.items[0]?.createdByName).toBe(creator?.displayName ?? null);
    expect(listed.items[0]?.createdAt).toBeGreaterThan(0);
    const raw = await env.DB.prepare(
      `SELECT projection_json AS projectionJson
         FROM schedule_review_links
        WHERE event_id = ?`,
    )
      .bind(viewer.eventId)
      .all();
    expect(JSON.stringify(listed.items)).not.toContain(
      String(raw.results[0]?.projectionJson ?? "schemaVersion"),
    );
  });

  it("returns identical 404 responses for unknown, malformed, revoked and expired tokens", async () => {
    const { schedule } = await placedDraft();
    const created = await schedule.createReviewLink(
      viewer,
      await reviewLinkCreateInput(schedule),
    );
    await schedule.revokeReviewLink(viewer, {
      linkId: created.id,
      confirmation: "revoke-draft-review-link",
    });
    const cases = [created.token, "not-a-token", "a".repeat(43)];
    const responses = await Promise.all(
      cases.map(async (token) => {
        try {
          await loader({
            request: new Request(`http://localhost/programme-preview/${token}`),
            params: { token },
            context: previewContext(),
          } as never);
          throw new Error(`expected 404 for ${token}`);
        } catch (error) {
          expect(error).toBeInstanceOf(Response);
          return error as Response;
        }
      }),
    );
    for (const response of responses) {
      expect(response.status).toBe(404);
      expect(response.statusText).toBe("Not Found");
      expect(await response.text()).toBe(
        "That page does not exist, or the link has changed.",
      );
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    }
  });

  it("does not create a review snapshot from a published-only schedule", async () => {
    const { schedule, versionId, workspace } = await placedDraft();
    await approveScheduledTestContent(versionId);
    const current = await schedule.getWorkspace(viewer);
    await schedule.publish(viewer, {
      scheduleVersionId: versionId,
      scheduleRevision: current.version!.revision,
    });
    await expect(
      schedule.createReviewLink(viewer, {
        scheduleVersionId: versionId,
        scheduleRevision: workspace.version!.revision,
        acknowledgement: SCHEDULE_REVIEW_LINK_ACKNOWLEDGEMENT,
        projectionHash: PLACEHOLDER_PROJECTION_HASH,
        purpose: "Programme committee",
        createIntentId: crypto.randomUUID(),
        ttlDays: 7,
      }),
    ).rejects.toThrow(/draft schedule is required/i);
  });

  it("rejects a review snapshot when the draft revision changes during create", async () => {
    const { schedule, workspace } = await placedDraft();
    await env.DB.prepare(
      `UPDATE schedule_versions SET revision = revision + 1
        WHERE id = ? AND event_id = ?`,
    )
      .bind(workspace.version!.id, viewer.eventId)
      .run();
    await expect(
      schedule.createReviewLink(viewer, {
        scheduleVersionId: workspace.version!.id,
        scheduleRevision: workspace.version!.revision,
        acknowledgement: SCHEDULE_REVIEW_LINK_ACKNOWLEDGEMENT,
        projectionHash: PLACEHOLDER_PROJECTION_HASH,
        purpose: "Programme committee",
        createIntentId: crypto.randomUUID(),
        ttlDays: 7,
      }),
    ).rejects.toBeInstanceOf(ScheduleRevisionConflictError);
  });

  it("404s expired and corrupt tokens the same way as unknown tokens", async () => {
    const { workspace } = await placedDraft();
    const expiredToken = createScheduleReviewToken();
    const corruptToken = createScheduleReviewToken();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO schedule_review_links (
           id, organisation_id, event_id, schedule_version_id, schedule_revision,
           projection_json, token_hash, expires_at, created_by_person_id, created_at,
           purpose, create_intent_id
         ) VALUES (?, ?, ?, ?, 1, '{"schemaVersion":1,"event":{"name":"X","timezone":"UTC"},"entries":[]}',
                   ?, unixepoch() - 10, ?, unixepoch() - 1000, 'Expired snapshot', ?)`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        workspace.version!.id,
        await hashScheduleReviewToken(expiredToken),
        viewer.personId,
        crypto.randomUUID(),
      ),
      env.DB.prepare(
        `INSERT INTO schedule_review_links (
           id, organisation_id, event_id, schedule_version_id, schedule_revision,
           projection_json, token_hash, expires_at, created_by_person_id, created_at,
           purpose, create_intent_id
         ) VALUES (?, ?, ?, ?, 1, '{"schemaVersion":1}',
                   ?, unixepoch() + 86400, ?, unixepoch(), 'Corrupt snapshot', ?)`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        workspace.version!.id,
        await hashScheduleReviewToken(corruptToken),
        viewer.personId,
        crypto.randomUUID(),
      ),
    ]);

    const expiredGet = await loader({
      request: new Request(
        `http://localhost/programme-preview/${expiredToken}`,
      ),
      params: { token: expiredToken },
      context: previewContext(),
    } as never).catch((error: unknown) => error);
    expect(expiredGet).toBeInstanceOf(Response);
    expect((expiredGet as Response).status).toBe(404);

    const liveCorrupt = await loader({
      request: new Request(
        `http://localhost/programme-preview/${corruptToken}`,
      ),
      params: { token: corruptToken },
      context: previewContext(),
    } as never).catch((error: unknown) => error);
    expect(liveCorrupt).toBeInstanceOf(Response);
    expect((liveCorrupt as Response).status).toBe(404);
    expect(await (liveCorrupt as Response).text()).toBe(
      "That page does not exist, or the link has changed.",
    );

    const corruptPost = await action({
      request: new Request(
        `http://localhost/programme-preview/${corruptToken}`,
        {
          method: "POST",
          headers: { origin: "http://localhost" },
        },
      ),
      params: { token: corruptToken },
      context: previewContext(),
    } as never).catch((error: unknown) => error);
    expect(corruptPost).toBeInstanceOf(Response);
    expect((corruptPost as Response).status).toBe(404);
    expect(await (corruptPost as Response).text()).toBe(
      "That page does not exist, or the link has changed.",
    );
  });

  it("omits private scheduled sessions from the frozen snapshot", async () => {
    const { schedule, versionId } = await placedDraft();
    const hiddenContent = await env.DB.prepare(
      `UPDATE schedule_session_contents
          SET visibility = 'private'
        WHERE event_id = ? AND schedule_version_id = ?
          AND session_id = 'schedule-test-one'`,
    )
      .bind(viewer.eventId, versionId)
      .run();
    expect(hiddenContent.meta.changes).toBeGreaterThan(0);
    const hidden = await schedule.createReviewLink(
      viewer,
      await reviewLinkCreateInput(schedule),
    );
    expect(hidden.entryCount).toBe(0);
    expect(hidden.speakerNameCount).toBe(0);
  });

  it("fails closed when a public scheduled speaker is missing a display name", async () => {
    const { workspace } = await placedDraft();
    const previous = await env.DB.prepare(
      "SELECT display_name AS displayName FROM people WHERE id = 'person-demo-speaker'",
    ).first<{ displayName: string }>();
    await env.DB.prepare(
      `UPDATE people SET display_name = '   ' WHERE id = 'person-demo-speaker'`,
    ).run();
    const review = new ScheduleReviewLinkService(scheduleTestEnv, {
      getWorkspace: async () => workspace,
    });
    try {
      const summary = await review.summarize(viewer, workspace);
      expect(summary.canCreate).toBe(false);
      expect(summary.projectionHash).toBeNull();
      expect(summary.blockedReason).toMatch(/missing a display name/i);
      await expect(
        review.create(viewer, {
          scheduleVersionId: workspace.version!.id,
          scheduleRevision: workspace.version!.revision,
          acknowledgement: SCHEDULE_REVIEW_LINK_ACKNOWLEDGEMENT,
          projectionHash: PLACEHOLDER_PROJECTION_HASH,
          purpose: "Programme committee",
          createIntentId: crypto.randomUUID(),
          ttlDays: 7,
        }),
      ).rejects.toThrow(/missing a display name/i);
    } finally {
      await env.DB.prepare(
        "UPDATE people SET display_name = ? WHERE id = 'person-demo-speaker'",
      )
        .bind(previous?.displayName ?? "Priya Shah")
        .run();
    }
  });

  it("does not record a second audit event when manual revoke is retried", async () => {
    const { schedule } = await placedDraft();
    const created = await schedule.createReviewLink(
      viewer,
      await reviewLinkCreateInput(schedule),
    );
    await schedule.revokeReviewLink(viewer, {
      linkId: created.id,
      confirmation: "revoke-draft-review-link",
    });
    await expect(
      schedule.revokeReviewLink(viewer, {
        linkId: created.id,
        confirmation: "revoke-draft-review-link",
      }),
    ).rejects.toThrow(/already been revoked/i);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS total
           FROM audit_events
          WHERE entity_id = ?
            AND action = 'schedule.review_link.revoked'`,
      )
        .bind(created.id)
        .first(),
    ).toEqual({ total: 1 });
  });

  it("does not list or revoke another organisation's review links", async () => {
    const { schedule } = await placedDraft();
    const created = await schedule.createReviewLink(
      viewer,
      await reviewLinkCreateInput(schedule),
    );
    const outsider = {
      ...viewer,
      organisationId: "org-does-not-exist",
    };
    expect(await schedule.listReviewLinks(outsider)).toEqual({
      items: [],
      omittedInactiveCount: 0,
    });
    await expect(
      schedule.revokeReviewLink(outsider, {
        linkId: created.id,
        confirmation: "revoke-draft-review-link",
      }),
    ).rejects.toThrow(/not found/i);
  });

  it("rejects create when speaker names change after the confirmation hash", async () => {
    const { schedule } = await placedDraft();
    const previous = await env.DB.prepare(
      "SELECT display_name AS displayName FROM people WHERE id = 'person-demo-speaker'",
    ).first<{ displayName: string }>();
    const input = await reviewLinkCreateInput(schedule);
    await env.DB.prepare(
      "UPDATE people SET display_name = 'Hash Cas Speaker' WHERE id = 'person-demo-speaker'",
    ).run();
    try {
      await expect(
        schedule.createReviewLink(viewer, input),
      ).rejects.toBeInstanceOf(ScheduleRevisionConflictError);
      await expect(schedule.createReviewLink(viewer, input)).rejects.toThrow(
        /unpublished snapshot changed/i,
      );
      const created = await schedule.createReviewLink(
        viewer,
        await reviewLinkCreateInput(schedule),
      );
      expect(created.speakerNameCount).toBeGreaterThan(0);
    } finally {
      await env.DB.prepare(
        "UPDATE people SET display_name = ? WHERE id = 'person-demo-speaker'",
      )
        .bind(previous?.displayName ?? "Priya Shah")
        .run();
    }
  });

  it("force-freshs the workspace only when creating a review link", async () => {
    const { workspace } = await placedDraft();
    const loads: Array<{ bypassCache?: boolean } | undefined> = [];
    const review = new ScheduleReviewLinkService(scheduleTestEnv, {
      getWorkspace: async (_viewer, options) => {
        loads.push(options);
        return workspace;
      },
    });
    const summary = await review.summarize(viewer);
    expect(loads).toEqual([undefined]);
    if (!summary.projectionHash) {
      throw new Error(summary.blockedReason ?? "missing projection hash");
    }
    const created = await review.create(viewer, {
      scheduleVersionId: workspace.version!.id,
      scheduleRevision: workspace.version!.revision,
      acknowledgement: SCHEDULE_REVIEW_LINK_ACKNOWLEDGEMENT,
      projectionHash: summary.projectionHash,
      purpose: "Programme committee",
      createIntentId: crypto.randomUUID(),
      ttlDays: 7,
    });
    expect(created.entryCount).toBe(1);
    expect(loads).toEqual([undefined, { bypassCache: true }]);
  });

  it("does not treat unexpected summarize failures as validation copy", async () => {
    const review = new ScheduleReviewLinkService(scheduleTestEnv, {
      getWorkspace: async () => {
        throw new Error("D1 exploded");
      },
    });
    await expect(review.summarize(viewer)).rejects.toThrow("D1 exploded");
  });

  it("rejects manual revoke of an expired review link", async () => {
    const { schedule, workspace } = await placedDraft();
    const expiredId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO schedule_review_links (
         id, organisation_id, event_id, schedule_version_id, schedule_revision,
         projection_json, token_hash, expires_at, created_by_person_id, created_at,
         purpose, create_intent_id
       ) VALUES (?, ?, ?, ?, 1, '{"schemaVersion":1,"event":{"name":"X","timezone":"UTC"},"entries":[]}',
                 ?, unixepoch() - 10, ?, unixepoch() - 1000, 'Expired snapshot', ?)`,
    )
      .bind(
        expiredId,
        viewer.organisationId,
        viewer.eventId,
        workspace.version!.id,
        await hashScheduleReviewToken(createScheduleReviewToken()),
        viewer.personId,
        crypto.randomUUID(),
      )
      .run();
    await expect(
      schedule.revokeReviewLink(viewer, {
        linkId: expiredId,
        confirmation: "revoke-draft-review-link",
      }),
    ).rejects.toBeInstanceOf(ScheduleReviewLinkExpiredError);
    expect(
      await env.DB.prepare(
        `SELECT revoked_at AS revokedAt, revocation_reason AS reason
           FROM schedule_review_links WHERE id = ?`,
      )
        .bind(expiredId)
        .first(),
    ).toEqual({ revokedAt: null, reason: null });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS total
           FROM audit_events
          WHERE entity_id = ?
            AND action = 'schedule.review_link.revoked'`,
      )
        .bind(expiredId)
        .first(),
    ).toEqual({ total: 0 });
  });

  it("lists every active link and a bounded inactive history", async () => {
    const { schedule, workspace } = await placedDraft();
    const inserts = Array.from({ length: 25 }, (_, index) =>
      env.DB.prepare(
        `INSERT INTO schedule_review_links (
           id, organisation_id, event_id, schedule_version_id, schedule_revision,
           projection_json, token_hash, expires_at, created_by_person_id, created_at,
           purpose, create_intent_id
         ) VALUES (?, ?, ?, ?, 1, '{"schemaVersion":1,"event":{"name":"X","timezone":"UTC"},"entries":[]}',
                   ?, unixepoch() - 10, ?, unixepoch() - ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        workspace.version!.id,
        `${index.toString(16).padStart(2, "0")}${"b".repeat(62)}`,
        viewer.personId,
        1_000 + index,
        `History ${index + 1}`,
        crypto.randomUUID(),
      ),
    );
    await env.DB.batch(inserts);
    const active = await schedule.createReviewLink(
      viewer,
      await reviewLinkCreateInput(schedule, "Venue reviewer"),
    );
    const listed = await schedule.listReviewLinks(viewer);
    expect(listed.items.some((link) => link.id === active.id)).toBe(true);
    expect(
      listed.items.filter((link) => link.status === "active"),
    ).toHaveLength(1);
    expect(
      listed.items.filter((link) => link.status !== "active"),
    ).toHaveLength(SCHEDULE_REVIEW_LINK_INACTIVE_LIST_LIMIT);
    expect(listed.omittedInactiveCount).toBe(5);
    expect(listed.items[0]?.purpose).toBe("Venue reviewer");
  });

  it("rejects an exact create replay without minting another secret", async () => {
    const { schedule } = await placedDraft();
    const input = await reviewLinkCreateInput(schedule, "Programme committee");
    const first = await schedule.createReviewLink(viewer, input);
    await expect(
      schedule.createReviewLink(viewer, input),
    ).rejects.toBeInstanceOf(ScheduleReviewLinkIntentReusedError);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS total FROM schedule_review_links WHERE event_id = ?`,
      )
        .bind(viewer.eventId)
        .first(),
    ).toEqual({ total: 1 });
    const second = await schedule.createReviewLink(
      viewer,
      await reviewLinkCreateInput(schedule, "Venue reviewer"),
    );
    expect(second.id).not.toBe(first.id);
  });

  it("honours a 7-day expiry and rejects an unbounded TTL", async () => {
    const { schedule } = await placedDraft();
    const created = await schedule.createReviewLink(
      viewer,
      await reviewLinkCreateInput(schedule, "Programme committee", {
        ttlDays: 7,
      }),
    );
    const now = Math.floor(Date.now() / 1_000);
    expect(created.expiresAt).toBeGreaterThanOrEqual(now + 7 * 86_400 - 2);
    expect(created.expiresAt).toBeLessThanOrEqual(now + 7 * 86_400 + 2);
    await expect(
      schedule.createReviewLink(viewer, {
        ...(await reviewLinkCreateInput(schedule)),
        ttlDays: 14,
      }),
    ).rejects.toThrow(/1, 3, 7 or 30 days/i);
  });

  // Irreversible tombstone: keep last in this Worker file.
  it("blocks review-link creation after participant retention completes", async () => {
    const { schedule } = await placedDraft();
    const input = await reviewLinkCreateInput(schedule);
    await env.DB.prepare(
      `UPDATE events
          SET participant_retention_completed_at = unixepoch()
        WHERE id = ? AND organisation_id = ?`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .run();
    const summary = await schedule.summarizeReviewLinks(viewer);
    expect(summary.canCreate).toBe(false);
    expect(summary.projectionHash).toBeNull();
    expect(summary.blockedReason).toMatch(
      /participant retention has completed/i,
    );
    await expect(
      schedule.createReviewLink(viewer, input),
    ).rejects.toBeInstanceOf(ScheduleReviewLinkRetentionError);
  });
});
