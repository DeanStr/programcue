import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { cloudflareContext } from "~/platform/cloudflare-context";
import { action, loader } from "~/routes/programme-preview";
import {
  ScheduleReviewLinkLimitError,
  ScheduleRevisionConflictError,
} from "./schedule-errors";
import { ScheduleReviewLinkService } from "./schedule-review-link-service.server";
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
    const { schedule, workspace } = await placedDraft();
    await env.DB.prepare(
      `UPDATE session_speakers
          SET participation_status = 'pending',
              participation_confirmed_at = NULL
        WHERE session_id = 'schedule-test-one' AND event_id = ?`,
    )
      .bind(viewer.eventId)
      .run();
    const created = await schedule.createReviewLink(viewer, {
      scheduleVersionId: workspace.version!.id,
      scheduleRevision: workspace.version!.revision,
      acknowledgement: SCHEDULE_REVIEW_LINK_ACKNOWLEDGEMENT,
    });
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
      }),
    ).rejects.toThrow(/draft schedule is required/i);

    const { workspace } = await placedDraft();
    await env.DB.prepare(
      `UPDATE session_speakers
          SET participation_status = 'declined',
              participation_confirmed_at = NULL,
              participation_declined_at = unixepoch()
        WHERE session_id = 'schedule-test-one' AND event_id = ?`,
    )
      .bind(viewer.eventId)
      .run();
    const created = await schedule.createReviewLink(viewer, {
      scheduleVersionId: workspace.version!.id,
      scheduleRevision: workspace.version!.revision,
      acknowledgement: SCHEDULE_REVIEW_LINK_ACKNOWLEDGEMENT,
    });
    expect(created.speakerNameCount).toBe(0);
  });

  it("enforces the active-link cap and lists metadata without the projection", async () => {
    const { schedule, workspace } = await placedDraft();
    for (let index = 0; index < 10; index += 1) {
      await schedule.createReviewLink(viewer, {
        scheduleVersionId: workspace.version!.id,
        scheduleRevision: workspace.version!.revision,
        acknowledgement: SCHEDULE_REVIEW_LINK_ACKNOWLEDGEMENT,
      });
    }
    await expect(
      schedule.createReviewLink(viewer, {
        scheduleVersionId: workspace.version!.id,
        scheduleRevision: workspace.version!.revision,
        acknowledgement: SCHEDULE_REVIEW_LINK_ACKNOWLEDGEMENT,
      }),
    ).rejects.toBeInstanceOf(ScheduleReviewLinkLimitError);

    const listed = await schedule.listReviewLinks(viewer);
    expect(listed).toHaveLength(10);
    expect(listed.every((link) => link.status === "active")).toBe(true);
    const raw = await env.DB.prepare(
      `SELECT projection_json AS projectionJson
         FROM schedule_review_links
        WHERE event_id = ?`,
    )
      .bind(viewer.eventId)
      .all();
    expect(JSON.stringify(listed)).not.toContain(
      String(raw.results[0]?.projectionJson ?? "schemaVersion"),
    );
  });

  it("returns identical 404 responses for unknown, malformed, revoked and expired tokens", async () => {
    const { schedule, workspace } = await placedDraft();
    const created = await schedule.createReviewLink(viewer, {
      scheduleVersionId: workspace.version!.id,
      scheduleRevision: workspace.version!.revision,
      acknowledgement: SCHEDULE_REVIEW_LINK_ACKNOWLEDGEMENT,
    });
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
           projection_json, token_hash, expires_at, created_by_person_id, created_at
         ) VALUES (?, ?, ?, ?, 1, '{"schemaVersion":1,"event":{"name":"X","timezone":"UTC"},"entries":[]}',
                   ?, unixepoch() - 10, ?, unixepoch() - 1000)`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        workspace.version!.id,
        await hashScheduleReviewToken(expiredToken),
        viewer.personId,
      ),
      env.DB.prepare(
        `INSERT INTO schedule_review_links (
           id, organisation_id, event_id, schedule_version_id, schedule_revision,
           projection_json, token_hash, expires_at, created_by_person_id, created_at
         ) VALUES (?, ?, ?, ?, 1, '{"schemaVersion":1}',
                   ?, unixepoch() + 86400, ?, unixepoch())`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        workspace.version!.id,
        await hashScheduleReviewToken(corruptToken),
        viewer.personId,
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
    const { schedule, workspace, versionId } = await placedDraft();
    const hiddenContent = await env.DB.prepare(
      `UPDATE schedule_session_contents
          SET visibility = 'private'
        WHERE event_id = ? AND schedule_version_id = ?
          AND session_id = 'schedule-test-one'`,
    )
      .bind(viewer.eventId, versionId)
      .run();
    expect(hiddenContent.meta.changes).toBeGreaterThan(0);
    const hidden = await schedule.createReviewLink(viewer, {
      scheduleVersionId: workspace.version!.id,
      scheduleRevision: workspace.version!.revision,
      acknowledgement: SCHEDULE_REVIEW_LINK_ACKNOWLEDGEMENT,
    });
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
      await expect(
        review.create(viewer, {
          scheduleVersionId: workspace.version!.id,
          scheduleRevision: workspace.version!.revision,
          acknowledgement: SCHEDULE_REVIEW_LINK_ACKNOWLEDGEMENT,
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
    const { schedule, workspace } = await placedDraft();
    const created = await schedule.createReviewLink(viewer, {
      scheduleVersionId: workspace.version!.id,
      scheduleRevision: workspace.version!.revision,
      acknowledgement: SCHEDULE_REVIEW_LINK_ACKNOWLEDGEMENT,
    });
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
    const { schedule, workspace } = await placedDraft();
    const created = await schedule.createReviewLink(viewer, {
      scheduleVersionId: workspace.version!.id,
      scheduleRevision: workspace.version!.revision,
      acknowledgement: SCHEDULE_REVIEW_LINK_ACKNOWLEDGEMENT,
    });
    const outsider = {
      ...viewer,
      organisationId: "org-does-not-exist",
    };
    expect(await schedule.listReviewLinks(outsider)).toEqual([]);
    await expect(
      schedule.revokeReviewLink(outsider, {
        linkId: created.id,
        confirmation: "revoke-draft-review-link",
      }),
    ).rejects.toThrow(/not found/i);
  });
});
