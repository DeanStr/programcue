import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { FileService } from "~/modules/files/file-service.server";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import { TaskService } from "~/modules/tasks/task-service.server";
import {
  ResourceContentError,
  parseResourceDocument,
  renderResourceDocument,
} from "./resource-content";
import {
  ResourceInvariantError,
  ResourceRevisionConflictError,
  ResourceService,
  ResourceSlugConflictError,
  ResourceTaskDependencyError,
} from "./resource-service.server";

const admin: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};
const speaker: Viewer = {
  personId: "person-demo-speaker",
  name: "Priya Shah",
  email: "priya.speaker@example.com",
  role: "speaker",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

function withBatchRace(
  testEnv: CloudflareEnvironment,
  race: () => Promise<void>,
) {
  let injectRace = true;
  const racingDb = new Proxy(testEnv.DB, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (injectRace) {
            injectRace = false;
            await race();
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(testEnv, {
    get(target, property) {
      return property === "DB" ? racingDb : Reflect.get(target, property);
    },
  });
}

describe("speaker resource service", () => {
  it("rejects explicit unknown resource selectors instead of opening the first page", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new ResourceService(testEnv);

    await expect(
      service.getAdminWorkspace(admin, `missing-${crypto.randomUUID()}`),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.getParticipantWorkspace(
        speaker,
        `missing-${crypto.randomUUID()}`,
      ),
    ).rejects.toMatchObject({ status: 404 });

    await expect(service.getAdminWorkspace(admin)).resolves.toHaveProperty(
      "selected",
    );
    await expect(
      service.getParticipantWorkspace(speaker),
    ).resolves.toHaveProperty("selected");
  });

  it("keeps a cleared draft category instead of restoring published metadata", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new ResourceService(testEnv);
    const token = crypto.randomUUID().slice(0, 8);
    const pageId = await service.save(admin, {
      title: "Category clearing guide",
      slug: `category-clearing-${token}`,
      category: "Preparation",
      audienceScope: "all_speakers",
      acknowledgementRequired: false,
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Version one." }],
          },
        ],
      },
      embedUrls: [],
    });
    const firstDraft = (await service.getAdminWorkspace(admin, pageId))
      .selected!;
    await service.publish(admin, pageId, firstDraft.revision);
    const published = (await service.getAdminWorkspace(admin, pageId))
      .selected!;

    await service.save(admin, {
      id: pageId,
      revision: published.revision,
      title: published.title,
      slug: published.slug,
      category: "",
      audienceScope: published.audienceScope,
      acknowledgementRequired: false,
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Version two." }],
          },
        ],
      },
      embedUrls: [],
    });

    await expect(
      service.getAdminWorkspace(admin, pageId),
    ).resolves.toMatchObject({
      selected: { category: null, versionStatus: "draft" },
    });
  });

  it("rejects an existing resource page without a current version", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const pageId = `resource-without-version-${crypto.randomUUID()}`;
    await testEnv.DB.prepare(
      `INSERT INTO resource_pages (
         id, event_id, title, slug, status, audience_scope,
         acknowledgement_required, revision, created_at, updated_at
       ) VALUES (?, ?, 'Invalid resource', ?, 'draft', 'all_speakers', 0, 1,
                 unixepoch(), unixepoch())`,
    )
      .bind(pageId, admin.eventId, pageId)
      .run();
    try {
      await expect(
        new ResourceService(testEnv).getAdminWorkspace(admin, pageId),
      ).rejects.toBeInstanceOf(ResourceInvariantError);
    } finally {
      await testEnv.DB.prepare("DELETE FROM resource_pages WHERE id = ?")
        .bind(pageId)
        .run();
    }
  });

  it("publishes an immutable safe version, scopes it to speakers and records exact-version acknowledgement", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new ResourceService(testEnv);
    const pageId = await service.save(admin, {
      title: "Accessibility guide",
      slug: "accessibility-guide-test",
      category: "Preparation",
      audienceScope: "all_speakers",
      acknowledgementRequired: true,
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "Use large, readable text on every presentation slide.",
              },
            ],
          },
        ],
      },
      embedUrls: ["https://example.com/reference"],
    });
    const draft = (await service.getAdminWorkspace(admin, pageId)).selected!;
    await service.publish(admin, pageId, draft.revision);
    const participant = await service.getParticipantWorkspace(
      speaker,
      "accessibility-guide-test",
    );
    expect(participant.selected?.renderedHtml).toContain("readable text");
    expect(participant.selected?.renderedHtml).toContain("sandbox=");
    expect(participant.selected?.acknowledged).toBe(false);

    await service.acknowledge(
      speaker,
      pageId,
      participant.selected!.versionId,
      "vitest",
    );
    const acknowledged = await service.getParticipantWorkspace(
      speaker,
      "accessibility-guide-test",
    );
    expect(acknowledged.selected?.acknowledged).toBe(true);
    const task = await env.DB.prepare(
      "SELECT status FROM task_instances WHERE template_id = ? AND target_id = ?",
    )
      .bind(`resource-ack:${pageId}`, speaker.personId)
      .first<{ status: string }>();
    expect(task?.status).toBe("completed");

    const published = (await service.getAdminWorkspace(admin, pageId))
      .selected!;
    await service.save(admin, {
      id: pageId,
      revision: published.revision,
      title: published.title,
      slug: published.slug,
      category: published.category ?? "",
      audienceScope: published.audienceScope,
      acknowledgementRequired: true,
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "This is a materially revised guide." },
            ],
          },
        ],
      },
      embedUrls: [],
    });
    const nextDraft = (await service.getAdminWorkspace(admin, pageId))
      .selected!;
    await service.publish(admin, pageId, nextDraft.revision);
    const revised = await service.getParticipantWorkspace(
      speaker,
      "accessibility-guide-test",
    );
    expect(revised.selected?.versionNumber).toBe(2);
    expect(revised.selected?.acknowledged).toBe(false);
    const resetTask = await env.DB.prepare(
      "SELECT status FROM task_instances WHERE template_id = ? AND target_id = ?",
    )
      .bind(`resource-ack:${pageId}`, speaker.personId)
      .first<{ status: string }>();
    expect(resetTask?.status).toBe("not_started");
  });

  it("cannot complete a new-version task with an acknowledgement read from the retired version", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new ResourceService(testEnv);
    const token = crypto.randomUUID().slice(0, 8);
    const pageId = await service.save(admin, {
      title: "Acknowledgement race guide",
      slug: `acknowledgement-race-${token}`,
      category: "Preparation",
      audienceScope: "all_speakers",
      acknowledgementRequired: true,
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Version one." }],
          },
        ],
      },
      embedUrls: [],
    });
    const firstDraft = (await service.getAdminWorkspace(admin, pageId))
      .selected!;
    await service.publish(admin, pageId, firstDraft.revision);
    const staleParticipant = await service.getParticipantWorkspace(
      speaker,
      `acknowledgement-race-${token}`,
    );

    const published = (await service.getAdminWorkspace(admin, pageId))
      .selected!;
    await service.save(admin, {
      id: pageId,
      revision: published.revision,
      title: published.title,
      slug: published.slug,
      category: published.category ?? "",
      audienceScope: published.audienceScope,
      acknowledgementRequired: true,
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Version two." }],
          },
        ],
      },
      embedUrls: [],
    });
    const secondDraft = (await service.getAdminWorkspace(admin, pageId))
      .selected!;
    const racingEnv = withBatchRace(testEnv, async () => {
      await service.publish(admin, pageId, secondDraft.revision);
    });

    await expect(
      new ResourceService(racingEnv).acknowledge(
        speaker,
        pageId,
        staleParticipant.selected!.versionId,
        "vitest-race",
      ),
    ).rejects.toBeInstanceOf(ResourceRevisionConflictError);

    const current = await service.getParticipantWorkspace(
      speaker,
      `acknowledgement-race-${token}`,
    );
    expect(current.selected).toMatchObject({
      versionId: secondDraft.versionId,
      acknowledged: false,
    });
    const state = await env.DB.prepare(
      `
      SELECT
        (SELECT COUNT(*) FROM resource_acknowledgements
          WHERE resource_page_version_id = ? AND person_id = ?) AS staleAcknowledgements,
        (SELECT status FROM task_instances
          WHERE template_id = ? AND target_id = ?) AS taskStatus
    `,
    )
      .bind(
        staleParticipant.selected!.versionId,
        speaker.personId,
        `resource-ack:${pageId}`,
        speaker.personId,
      )
      .first<{ staleAcknowledgements: number; taskStatus: string }>();
    expect(state).toEqual({
      staleAcknowledgements: 0,
      taskStatus: "not_started",
    });
  });

  it("rejects an acknowledgement reset that would invalidate a terminal dependent task", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new ResourceService(testEnv);
    const token = crypto.randomUUID().slice(0, 8);
    const slug = `dependent-acknowledgement-${token}`;
    const pageId = await service.save(admin, {
      title: "Dependent acknowledgement guide",
      slug,
      category: "Preparation",
      audienceScope: "all_speakers",
      acknowledgementRequired: true,
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Version one." }],
          },
        ],
      },
      embedUrls: [],
    });
    const firstDraft = (await service.getAdminWorkspace(admin, pageId))
      .selected!;
    await service.publish(admin, pageId, firstDraft.revision);
    const participant = await service.getParticipantWorkspace(speaker, slug);
    await service.acknowledge(
      speaker,
      pageId,
      participant.selected!.versionId,
      "vitest",
    );

    const acknowledgementTaskId = `resource-ack:${pageId}:${speaker.personId}`;
    const dependentTemplateId = `dependent-template-${token}`;
    const dependentTaskId = `dependent-task-${token}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO task_templates (
           id, event_id, name, target_type, task_type, impact, evidence_mode,
           due_anchor, status, created_at, updated_at
         ) VALUES (?, ?, 'Dependent task', 'speaker', 'checklist', 'medium',
                   'checkbox', 'none', 'active', unixepoch(), unixepoch())`,
      ).bind(dependentTemplateId, admin.eventId),
      testEnv.DB.prepare(
        `INSERT INTO task_template_dependencies (
           template_id, depends_on_template_id, created_at
         ) VALUES (?, ?, unixepoch())`,
      ).bind(dependentTemplateId, `resource-ack:${pageId}`),
      testEnv.DB.prepare(
        `INSERT INTO task_instances (
           id, event_id, template_id, target_type, target_id, owner_person_id,
           title, task_type, impact, status, readiness_state, readiness_percent,
           revision, completed_at, completed_by_person_id, created_at, updated_at
         ) VALUES (?, ?, ?, 'speaker', ?, ?, 'Dependent task', 'checklist',
                   'medium', 'completed', 'on_track', 100, 1, unixepoch(), ?,
                   unixepoch(), unixepoch())`,
      ).bind(
        dependentTaskId,
        admin.eventId,
        dependentTemplateId,
        speaker.personId,
        speaker.personId,
        admin.personId,
      ),
      testEnv.DB.prepare(
        `INSERT INTO task_instance_dependencies (
           task_id, depends_on_task_id, created_at
         ) VALUES (?, ?, unixepoch())`,
      ).bind(dependentTaskId, acknowledgementTaskId),
    ]);

    const published = (await service.getAdminWorkspace(admin, pageId))
      .selected!;
    await service.save(admin, {
      id: pageId,
      revision: published.revision,
      title: published.title,
      slug: published.slug,
      category: published.category ?? "",
      audienceScope: published.audienceScope,
      acknowledgementRequired: true,
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Version two." }],
          },
        ],
      },
      embedUrls: [],
    });
    const blockedDraft = (await service.getAdminWorkspace(admin, pageId))
      .selected!;
    expect(blockedDraft.publicationImpact).toMatchObject({
      blockingDependentTasks: 1,
    });
    await expect(
      service.publish(admin, pageId, blockedDraft.revision),
    ).rejects.toBeInstanceOf(ResourceTaskDependencyError);

    expect(
      await testEnv.DB.prepare(
        `SELECT
           SUM(status = 'published') AS published,
           SUM(status = 'draft') AS draft
         FROM resource_page_versions WHERE resource_page_id = ?`,
      )
        .bind(pageId)
        .first(),
    ).toEqual({ published: 1, draft: 1 });
    expect(
      await testEnv.DB.prepare("SELECT status FROM task_instances WHERE id = ?")
        .bind(acknowledgementTaskId)
        .first(),
    ).toEqual({ status: "completed" });
  });

  it("removes obsolete template dependencies when acknowledgement is disabled", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new ResourceService(testEnv);
    const token = crypto.randomUUID().slice(0, 8);
    const pageId = await service.save(admin, {
      title: "Retired acknowledgement guide",
      slug: `retired-acknowledgement-${token}`,
      category: "Preparation",
      audienceScope: "all_speakers",
      acknowledgementRequired: true,
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Read this." }],
          },
        ],
      },
      embedUrls: [],
    });
    const firstDraft = (await service.getAdminWorkspace(admin, pageId))
      .selected!;
    await service.publish(admin, pageId, firstDraft.revision);

    const tasks = new TaskService(testEnv);
    const dependentTemplateId = await tasks.createTemplate(admin, {
      name: `Dependent template ${token}`,
      description: "Depends on the resource acknowledgement.",
      targetType: "speaker",
      taskType: "checklist",
      impact: "medium",
      evidenceMode: "checkbox",
      dueAnchor: "none",
      dueOffsetDays: null,
      fixedDueDate: null,
      dependencyIds: [`resource-ack:${pageId}`],
    });
    const newSpeakerId = `post-ack-speaker-${token}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, email_verified, created_at, updated_at
         ) VALUES (?, ?, 'Later Speaker', 1, unixepoch(), unixepoch())`,
      ).bind(newSpeakerId, `${newSpeakerId}@example.com`),
      testEnv.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role,
           invited_at, accepted_at, created_at
         ) VALUES (?, ?, ?, ?, 'speaker', unixepoch(), unixepoch(), unixepoch())`,
      ).bind(
        `post-ack-membership-${token}`,
        admin.organisationId,
        admin.eventId,
        newSpeakerId,
      ),
    ]);

    const published = (await service.getAdminWorkspace(admin, pageId))
      .selected!;
    await service.save(admin, {
      id: pageId,
      revision: published.revision,
      title: published.title,
      slug: published.slug,
      category: published.category ?? "",
      audienceScope: published.audienceScope,
      acknowledgementRequired: false,
      document: published.document,
      embedUrls: [],
    });
    const draft = (await service.getAdminWorkspace(admin, pageId)).selected!;
    expect(draft.publicationImpact).toMatchObject({
      templateDependenciesRemoved: 1,
    });
    await service.publish(admin, pageId, draft.revision);

    expect(
      await testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM task_template_dependencies
          WHERE template_id = ? AND depends_on_template_id = ?`,
      )
        .bind(dependentTemplateId, `resource-ack:${pageId}`)
        .first(),
    ).toEqual({ count: 0 });
    const assignedTaskId = await tasks.assignTemplate(
      admin,
      dependentTemplateId,
      newSpeakerId,
    );
    expect(assignedTaskId).toEqual(expect.any(String));
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        "DELETE FROM task_instances WHERE id = ? AND event_id = ?",
      ).bind(assignedTaskId, admin.eventId),
      testEnv.DB.prepare(
        "DELETE FROM memberships WHERE event_id = ? AND person_id = ?",
      ).bind(admin.eventId, newSpeakerId),
      testEnv.DB.prepare("DELETE FROM people WHERE id = ?").bind(newSpeakerId),
    ]);
  });

  it("materialises acknowledgement tasks only for speakers who can view the published resource", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const hiddenSpeaker: Viewer = {
      personId: "person-resource-hidden",
      name: "Hidden Speaker",
      email: "hidden-resource-speaker@example.com",
      role: "speaker",
      organisationId: admin.organisationId,
      eventId: admin.eventId,
      demo: true,
    };
    await env.DB.batch([
      env.DB.prepare(
        `
        INSERT INTO people (id, email, display_name, email_verified, created_at, updated_at)
        VALUES (?, ?, ?, 1, unixepoch(), unixepoch())
      `,
      ).bind(hiddenSpeaker.personId, hiddenSpeaker.email, hiddenSpeaker.name),
      env.DB.prepare(
        `
        INSERT INTO memberships (
          id, organisation_id, event_id, person_id, role, invited_at, accepted_at, created_at
        ) VALUES (?, ?, ?, ?, 'speaker', unixepoch(), unixepoch(), unixepoch())
      `,
      ).bind(
        "membership-resource-hidden",
        admin.organisationId,
        admin.eventId,
        hiddenSpeaker.personId,
      ),
    ]);

    const service = new ResourceService(testEnv);
    const pageId = await service.save(admin, {
      title: "Private stage briefing",
      slug: "private-stage-briefing-test",
      category: "Preparation",
      audienceScope: "all_speakers",
      acknowledgementRequired: true,
      document: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Briefing" }] },
        ],
      },
      embedUrls: [],
    });
    const firstDraft = (await service.getAdminWorkspace(admin, pageId))
      .selected!;
    expect(firstDraft.publicationImpact).toMatchObject({
      eligibleSpeakerCount: 2,
      tasksCreatedOrReset: 2,
      tasksWaived: 0,
    });
    await service.publish(admin, pageId, firstDraft.revision);
    expect(
      await env.DB.prepare(
        `
      SELECT status FROM task_instances WHERE template_id = ? AND target_id = ?
    `,
      )
        .bind(`resource-ack:${pageId}`, hiddenSpeaker.personId)
        .first<{ status: string }>(),
    ).toEqual({ status: "not_started" });

    const published = (await service.getAdminWorkspace(admin, pageId))
      .selected!;
    await service.save(admin, {
      id: pageId,
      revision: published.revision,
      title: published.title,
      slug: published.slug,
      category: published.category ?? "",
      audienceScope: "custom",
      acknowledgementRequired: true,
      document: published.document,
      embedUrls: [],
    });
    const customDraft = (await service.getAdminWorkspace(admin, pageId))
      .selected!;
    const liveBeforePublish = await service.getParticipantWorkspace(
      hiddenSpeaker,
      published.slug,
    );
    expect(liveBeforePublish.pages.some((page) => page.id === pageId)).toBe(
      true,
    );
    expect(
      await env.DB.prepare(
        `
      SELECT status FROM task_instances WHERE template_id = ? AND target_id = ?
    `,
      )
        .bind(`resource-ack:${pageId}`, hiddenSpeaker.personId)
        .first<{ status: string }>(),
    ).toEqual({ status: "not_started" });
    await env.DB.prepare(
      `
      INSERT INTO resource_audiences (resource_page_version_id, event_id, target_type, target_id)
      VALUES (?, ?, 'person', ?)
    `,
    )
      .bind(customDraft.versionId, admin.eventId, speaker.personId)
      .run();
    const customImpact = (await service.getAdminWorkspace(admin, pageId))
      .selected!;
    expect(customImpact.publicationImpact).toEqual({
      eligibleSpeakerCount: 1,
      tasksCreatedOrReset: 1,
      tasksWaived: 1,
      blockingDependentTasks: 0,
      templateDependenciesRemoved: 0,
    });
    await service.publish(admin, pageId, customImpact.revision);

    const tasks = await env.DB.prepare(
      `
      SELECT target_id AS targetId, status FROM task_instances
       WHERE template_id = ? AND target_id IN (?, ?) ORDER BY target_id
    `,
    )
      .bind(`resource-ack:${pageId}`, hiddenSpeaker.personId, speaker.personId)
      .all<{ targetId: string; status: string }>();
    expect(tasks.results).toEqual([
      { targetId: speaker.personId, status: "not_started" },
      { targetId: hiddenSpeaker.personId, status: "waived" },
    ]);
    const visible = await service.getParticipantWorkspace(
      speaker,
      published.slug,
    );
    expect(visible.pages.some((page) => page.id === pageId)).toBe(true);
    await expect(
      service.getParticipantWorkspace(hiddenSpeaker, published.slug),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("publishes acknowledgement work for audiences larger than D1's bind limit", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const prefix = `bulk-resource-${crypto.randomUUID()}`;
    const people = Array.from({ length: 105 }, (_, index) => ({
      id: `${prefix}-person-${index}`,
      email: `${prefix}-${index}@example.com`,
      name: `Bulk resource speaker ${index}`,
      membershipId: `${prefix}-membership-${index}`,
    }));
    const peopleJson = JSON.stringify(people);
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `
        INSERT INTO people (
          id, email, display_name, email_verified, created_at, updated_at
        )
        SELECT json_extract(value, '$.id'), json_extract(value, '$.email'),
               json_extract(value, '$.name'), 1, unixepoch(), unixepoch()
          FROM json_each(?)
      `,
      ).bind(peopleJson),
      testEnv.DB.prepare(
        `
        INSERT INTO memberships (
          id, organisation_id, event_id, person_id, role,
          invited_at, accepted_at, created_at
        )
        SELECT json_extract(value, '$.membershipId'), ?, ?,
               json_extract(value, '$.id'), 'speaker',
               unixepoch(), unixepoch(), unixepoch()
          FROM json_each(?)
      `,
      ).bind(admin.organisationId, admin.eventId, peopleJson),
    ]);

    const service = new ResourceService(testEnv);
    const pageId = await service.save(admin, {
      title: "Large audience briefing",
      slug: `${prefix}-briefing`,
      category: "Preparation",
      audienceScope: "all_speakers",
      acknowledgementRequired: true,
      document: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Read me" }] },
        ],
      },
      embedUrls: [],
    });
    const draft = (await service.getAdminWorkspace(admin, pageId)).selected!;
    const impact = draft.publicationImpact!;
    expect(impact.eligibleSpeakerCount).toBeGreaterThan(100);

    await service.publish(admin, pageId, draft.revision);

    const created = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS count FROM task_instances WHERE template_id = ?`,
    )
      .bind(`resource-ack:${pageId}`)
      .first<{ count: number }>();
    expect(created?.count).toBe(impact.eligibleSpeakerCount);
  });

  it("keeps one live version when two callers publish the same draft concurrently", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new ResourceService(testEnv);
    const token = crypto.randomUUID().slice(0, 8);
    const pageId = await service.save(admin, {
      title: "Concurrent publication guide",
      slug: `concurrent-publication-${token}`,
      category: "Preparation",
      audienceScope: "all_speakers",
      acknowledgementRequired: false,
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Publish once." }],
          },
        ],
      },
      embedUrls: [],
    });
    const draft = (await service.getAdminWorkspace(admin, pageId)).selected!;

    const internalService = service as unknown as {
      getDraftForPublish: (
        currentViewer: Viewer,
        currentPageId: string,
      ) => Promise<unknown>;
    };
    const readDraft = internalService.getDraftForPublish.bind(service);
    let releaseBothReads!: () => void;
    const bothReadsComplete = new Promise<void>((resolve) => {
      releaseBothReads = resolve;
    });
    let readCount = 0;
    internalService.getDraftForPublish = async (
      currentViewer,
      currentPageId,
    ) => {
      const page = await readDraft(currentViewer, currentPageId);
      readCount += 1;
      if (readCount === 2) releaseBothReads();
      await bothReadsComplete;
      return page;
    };

    const attempts = await Promise.allSettled([
      service.publish(admin, pageId, draft.revision),
      service.publish(admin, pageId, draft.revision),
    ]);
    expect(
      attempts.filter((attempt) => attempt.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      attempts.filter((attempt) => attempt.status === "rejected"),
    ).toHaveLength(1);
    expect(
      attempts.find((attempt) => attempt.status === "rejected"),
    ).toMatchObject({
      reason: expect.any(ResourceRevisionConflictError),
    });

    const versions = await env.DB.prepare(
      `
      SELECT id, status FROM resource_page_versions
       WHERE resource_page_id = ? ORDER BY version_number
    `,
    )
      .bind(pageId)
      .all<{ id: string; status: string }>();
    expect(
      versions.results.filter((version) => version.status === "published"),
    ).toEqual([{ id: draft.versionId, status: "published" }]);
    const audit = await env.DB.prepare(
      `
      SELECT COUNT(*) AS count FROM audit_events
       WHERE action = 'resource.published' AND entity_id = ?
    `,
    )
      .bind(pageId)
      .first<{ count: number }>();
    expect(audit?.count).toBe(1);
  });

  it("reserves the live slug until a draft wins publication and rejects a conflicting draft slug", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new ResourceService(testEnv);
    const token = crypto.randomUUID().slice(0, 8);
    const liveSlug = `live-slug-${token}`;
    const proposedSlug = `proposed-slug-${token}`;
    const firstPageId = await service.save(admin, {
      title: "Published slug owner",
      slug: liveSlug,
      category: "Preparation",
      audienceScope: "all_speakers",
      acknowledgementRequired: false,
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Live content." }],
          },
        ],
      },
      embedUrls: [],
    });
    const firstDraft = (await service.getAdminWorkspace(admin, firstPageId))
      .selected!;
    await service.publish(admin, firstPageId, firstDraft.revision);
    const published = (await service.getAdminWorkspace(admin, firstPageId))
      .selected!;
    await service.save(admin, {
      id: firstPageId,
      revision: published.revision,
      title: "Unpublished replacement",
      slug: proposedSlug,
      category: published.category ?? "",
      audienceScope: published.audienceScope,
      acknowledgementRequired: false,
      document: published.document,
      embedUrls: [],
    });
    const replacement = (await service.getAdminWorkspace(admin, firstPageId))
      .selected!;
    expect(
      await env.DB.prepare(
        "SELECT title, slug FROM resource_pages WHERE id = ?",
      )
        .bind(firstPageId)
        .first(),
    ).toEqual({ title: "Published slug owner", slug: liveSlug });

    await expect(
      service.save(admin, {
        title: "Conflicting live slug",
        slug: liveSlug,
        category: "Preparation",
        audienceScope: "all_speakers",
        acknowledgementRequired: false,
        document: { type: "doc", content: [{ type: "paragraph" }] },
        embedUrls: [],
      }),
    ).rejects.toBeInstanceOf(ResourceSlugConflictError);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS pageCount,
                (SELECT COUNT(*) FROM audit_events audit
                  JOIN resource_pages page ON page.id = audit.entity_id
                 WHERE audit.action = 'resource.created'
                   AND page.event_id = ? AND page.slug = ?) AS auditCount
           FROM resource_pages
          WHERE event_id = ? AND slug = ?`,
      )
        .bind(admin.eventId, liveSlug, admin.eventId, liveSlug)
        .first(),
    ).toEqual({ pageCount: 1, auditCount: 1 });

    const secondPageId = await service.save(admin, {
      title: "Proposed slug owner",
      slug: proposedSlug,
      category: "Preparation",
      audienceScope: "all_speakers",
      acknowledgementRequired: false,
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Second page." }],
          },
        ],
      },
      embedUrls: [],
    });
    const secondDraft = (await service.getAdminWorkspace(admin, secondPageId))
      .selected!;
    await service.publish(admin, secondPageId, secondDraft.revision);
    await expect(
      service.publish(admin, firstPageId, replacement.revision),
    ).rejects.toBeInstanceOf(ResourceSlugConflictError);

    const firstVersions = await env.DB.prepare(
      `
      SELECT slug, status FROM resource_page_versions
       WHERE resource_page_id = ? ORDER BY version_number
    `,
    )
      .bind(firstPageId)
      .all<{ slug: string; status: string }>();
    expect(firstVersions.results).toEqual([
      { slug: liveSlug, status: "published" },
      { slug: proposedSlug, status: "draft" },
    ]);
    const livePages = await service.getParticipantWorkspace(speaker);
    expect(
      livePages.pages
        .filter((page) => [liveSlug, proposedSlug].includes(page.slug))
        .map((page) => page.slug)
        .sort(),
    ).toEqual([liveSlug, proposedSlug].sort());
  });

  it("cannot attach a file after the target draft crosses the publication boundary", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const resources = new ResourceService(testEnv);
    const files = new FileService(testEnv);
    const token = crypto.randomUUID().slice(0, 8);
    const pageId = await resources.save(admin, {
      title: "Attachment publication race",
      slug: `attachment-publication-race-${token}`,
      category: "Preparation",
      audienceScope: "all_speakers",
      acknowledgementRequired: false,
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [
              { type: "text", text: "Publish without the racing file." },
            ],
          },
        ],
      },
      embedUrls: [],
    });
    const upload = await files.uploadAdminFile(
      admin,
      {
        targetType: "resource",
        targetId: pageId,
        assetKind: "resource_attachment",
      },
      new File(["%PDF-1.7 racing attachment"], "racing.pdf", {
        type: "application/pdf",
      }),
    );
    const draft = (await resources.getAdminWorkspace(admin, pageId)).selected!;
    const internal = resources as unknown as {
      insertDraftAttachment: (
        currentViewer: Viewer,
        currentPageId: string,
        currentVersionId: string,
        currentRevision: number,
        assetId: string,
      ) => Promise<D1Result<unknown>>;
    };
    const insert = internal.insertDraftAttachment.bind(resources);
    let raced = false;
    internal.insertDraftAttachment = async (...args) => {
      if (!raced) {
        raced = true;
        await new ResourceService(testEnv).publish(
          admin,
          pageId,
          draft.revision,
        );
      }
      return insert(...args);
    };

    await expect(
      resources.attachToDraft(
        admin,
        pageId,
        draft.versionId!,
        draft.revision,
        upload.assetId,
      ),
    ).rejects.toBeInstanceOf(ResourceRevisionConflictError);
    expect(
      await env.DB.prepare(
        `
      SELECT COUNT(*) AS count FROM resource_attachments
       WHERE resource_page_version_id = ? AND file_asset_id = ?
    `,
      )
        .bind(draft.versionId, upload.assetId)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
    const stored = await env.DB.prepare(
      "SELECT object_key AS objectKey FROM file_versions WHERE id = ?",
    )
      .bind(upload.versionId)
      .first<{ objectKey: string }>();
    await files.discardUnattachedResourceUpload(admin, upload);
    expect(await env.FILES.head(stored!.objectKey)).toBeNull();
    expect(
      await env.DB.prepare(
        `SELECT fa.status, fv.upload_status AS uploadStatus,
                fv.scan_status AS scanStatus, fv.deleted_at AS deletedAt
           FROM file_assets fa JOIN file_versions fv ON fv.asset_id = fa.id
          WHERE fa.id = ? AND fv.id = ?`,
      )
        .bind(upload.assetId, upload.versionId)
        .first(),
    ).toMatchObject({
      status: "deleted",
      uploadStatus: "failed",
      scanStatus: "failed",
      deletedAt: expect.any(Number),
    });
  });

  it("keeps published attachment bytes immutable while a new draft carries distinct attachments", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const resources = new ResourceService(testEnv);
    const files = new FileService(testEnv);
    const token = crypto.randomUUID().slice(0, 8);
    const pageId = await resources.save(admin, {
      title: "Attachment snapshot guide",
      slug: `attachment-snapshot-${token}`,
      category: "Preparation",
      audienceScope: "all_speakers",
      acknowledgementRequired: false,
      document: {
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "Attachment guide." }],
          },
        ],
      },
      embedUrls: [],
    });
    const upload = (name: string, marker: string) =>
      files.uploadAdminFile(
        admin,
        {
          targetType: "resource",
          targetId: pageId,
          assetKind: "resource_attachment",
        },
        new File([`%PDF-1.7 ${marker}`], name, { type: "application/pdf" }),
      );
    const first = await upload("published.pdf", "published attachment bytes");
    const firstDraft = (await resources.getAdminWorkspace(admin, pageId))
      .selected!;
    await files.recordScanResult({
      eventId: admin.eventId,
      versionId: first.versionId,
      provider: "test-scanner",
      clean: true,
      result: { verdict: "clean" },
    });
    await resources.attachToDraft(
      admin,
      pageId,
      firstDraft.versionId!,
      firstDraft.revision,
      first.assetId,
    );
    await resources.publish(admin, pageId, firstDraft.revision);

    const published = (await resources.getAdminWorkspace(admin, pageId))
      .selected!;
    await resources.save(admin, {
      id: pageId,
      revision: published.revision,
      title: published.title,
      slug: published.slug,
      category: published.category ?? "",
      audienceScope: published.audienceScope,
      acknowledgementRequired: false,
      document: published.document,
      embedUrls: [],
    });
    const draft = (await resources.getAdminWorkspace(admin, pageId)).selected!;
    const second = await upload("draft.pdf", "new draft attachment bytes");
    await files.recordScanResult({
      eventId: admin.eventId,
      versionId: second.versionId,
      provider: "test-scanner",
      clean: true,
      result: { verdict: "clean" },
    });
    await resources.attachToDraft(
      admin,
      pageId,
      draft.versionId!,
      draft.revision,
      second.assetId,
    );

    expect(second.assetId).not.toBe(first.assetId);
    const updatedDraft = (await resources.getAdminWorkspace(admin, pageId))
      .selected!;
    expect(
      updatedDraft.attachments.map((attachment) => attachment.id).sort(),
    ).toEqual([first.assetId, second.assetId].sort());
    const live = await resources.getParticipantWorkspace(
      speaker,
      published.slug,
    );
    expect(
      live.selected?.attachments.map((attachment) => attachment.id),
    ).toEqual([first.assetId]);
    const liveDownload = await files.participantResourceDownload(
      speaker,
      first.assetId,
    );
    expect(
      new TextDecoder().decode(await liveDownload.arrayBuffer()),
    ).toContain("published attachment bytes");
    await expect(
      files.participantResourceDownload(speaker, second.assetId),
    ).rejects.toThrow("unavailable");
  });

  it("escapes text and rejects executable embed schemes", () => {
    const safe = renderResourceDocument(
      parseResourceDocument({
        type: "doc",
        content: [
          {
            type: "paragraph",
            content: [{ type: "text", text: "<script>alert(1)</script>" }],
          },
        ],
      }),
    );
    expect(safe).toContain("&lt;script&gt;");
    expect(() =>
      renderResourceDocument(
        parseResourceDocument({
          type: "doc",
          content: [{ type: "embed", attrs: { src: "javascript:alert(1)" } }],
        }),
      ),
    ).toThrow(ResourceContentError);
  });
});
