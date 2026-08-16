import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { CommandPaletteService } from "~/platform/operations/command-palette-service.server";
import {
  SavedViewNameConflictError,
  SavedViewService,
} from "~/platform/operations/saved-view-service.server";

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

describe("saved views", () => {
  beforeEach(async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    await env.DB.prepare("DELETE FROM saved_views WHERE event_id = ?")
      .bind(viewer.eventId)
      .run();
  });

  it("fails closed before searching an unreadable Airtable projection", async () => {
    const unavailable = new Error("Airtable projection is unavailable.");
    const assertReadable = vi.fn(async () => {
      throw unavailable;
    });
    const service = new CommandPaletteService(
      env as unknown as CloudflareEnvironment,
      {
        airtable: { assertReadable } as unknown as AirtableProviderBoundary,
      },
    );

    await expect(
      service.search(viewer, { query: "speaker", scope: "event" }),
    ).rejects.toBe(unavailable);
    expect(assertReadable).toHaveBeenCalledWith(viewer);
  });

  it("stores a safe URL view and makes it available to the command palette", async () => {
    const service = new SavedViewService(
      env as unknown as CloudflareEnvironment,
    );
    const id = await service.create(viewer, {
      area: "operations",
      name: "Failed deliveries",
      href: "/admin/operations?status=failed&type=webhook.deliver",
      visibility: "event",
    });

    expect(await service.list(viewer)).toEqual([
      expect.objectContaining({
        id,
        name: "Failed deliveries",
        href: "/admin/operations?status=failed&type=webhook.deliver",
        area: "operations",
        visibility: "event",
        canDelete: true,
      }),
    ]);
    expect(
      await env.DB.prepare(
        "SELECT action FROM audit_events WHERE entity_id = ? ORDER BY created_at DESC LIMIT 1",
      )
        .bind(id)
        .first(),
    ).toEqual({ action: "saved_view.created" });
  });

  it("finds a submission by any selected track in the command palette", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO submissions (
           id, event_id, public_reference, title, category, status,
           submitted_snapshot_json, submitted_at
         ) VALUES (
           'command-multi-track-submission', ?, 'PC-MULTI-TRACK',
           'A multi-track proposal', 'Leadership', 'submitted', '{}', unixepoch()
         )`,
      ).bind(viewer.eventId),
      env.DB.prepare(
        `INSERT INTO submission_track_selections (
           submission_id, event_id, track_id, track_name_snapshot, position
         ) VALUES
           ('command-multi-track-submission', ?, 'demo-track-leadership', 'Leadership', 0),
           ('command-multi-track-submission', ?, 'demo-track-experience', 'Experience Design', 1)`,
      ).bind(viewer.eventId, viewer.eventId),
    ]);

    const records = await new CommandPaletteService(
      env as unknown as CloudflareEnvironment,
    ).search(viewer, { query: "Experience Design", scope: "event" });

    expect(records).toContainEqual(
      expect.objectContaining({
        id: "command-multi-track-submission",
        kind: "submission",
      }),
    );
  });

  it("searches a committee chair's exact evaluator assignments", async () => {
    await ensureDemoEvaluationData(env as unknown as CloudflareEnvironment);
    const records = await new CommandPaletteService(
      env as unknown as CloudflareEnvironment,
    ).search(
      {
        ...viewer,
        personId: "person-demo-evaluator",
        name: "Jordan Lee",
        email: "jordan.evaluator@example.com",
        role: "committee_chair",
      },
      { query: "calm", scope: "event" },
    );

    expect(records).toContainEqual(
      expect.objectContaining({
        id: "demo-evaluation-submission-calm",
        kind: "submission",
        label: "Operational calm under pressure",
        href: "/review/workbench?assignment=demo-evaluation-assignment-1",
      }),
    );
  });

  it("limits a committee chair's recent activity to their review assignments", async () => {
    await ensureDemoEvaluationData(env as unknown as CloudflareEnvironment);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version,organisation_id,event_id,actor_person_id,action,entity_type,
           entity_id,metadata_json,created_at
         ) VALUES ('chair-visible-audit', 'person', 'internal', 1,?,?,?,'review.conflict.declared',
                   'evaluator_assignment','demo-evaluation-assignment-1',
                   '{"roundId":"demo-evaluation-round-1","targetType":"submission","targetId":"demo-evaluation-submission-calm"}',
                   2000000001)`,
      ).bind(viewer.organisationId, viewer.eventId, viewer.personId),
      env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version,organisation_id,event_id,actor_person_id,action,entity_type,
           entity_id,created_at
         ) VALUES ('chair-hidden-audit', 'person', 'internal', 1,?,?,?,'task.completed',
                   'task_instance','task-private-to-admins',2000000002)`,
      ).bind(viewer.organisationId, viewer.eventId, viewer.personId),
    ]);

    const records = await new CommandPaletteService(
      env as unknown as CloudflareEnvironment,
    ).recent({
      ...viewer,
      personId: "person-demo-evaluator",
      name: "Jordan Lee",
      email: "jordan.evaluator@example.com",
      role: "committee_chair",
    });

    expect(records).toContainEqual(
      expect.objectContaining({
        id: "chair-visible-audit",
        href: "/review/workbench?assignment=demo-evaluation-assignment-1",
      }),
    );
    expect(records.map((record) => record.id)).not.toContain(
      "chair-hidden-audit",
    );
    expect(records.every((record) => record.href.startsWith("/review/"))).toBe(
      true,
    );
  });

  it("rejects unsafe locations and duplicate names, then lets only the owner delete", async () => {
    const service = new SavedViewService(
      env as unknown as CloudflareEnvironment,
    );
    await expect(
      service.create(viewer, {
        area: "tasks",
        name: "Overdue",
        href: "https://malicious.example/admin/tasks",
        visibility: "private",
      }),
    ).rejects.toThrow("administrator page");
    await expect(
      service.create(viewer, {
        area: "evaluations",
        name: "Disguised settings link",
        href: "/admin/settings",
        visibility: "event",
      }),
    ).rejects.toThrow("does not belong to the evaluations area");

    const id = await service.create(viewer, {
      area: "tasks",
      name: "Overdue",
      href: "/admin/tasks?state=overdue",
      visibility: "private",
    });
    await expect(
      service.create(viewer, {
        area: "tasks",
        name: "Overdue",
        href: "/admin/tasks?state=blocked",
        visibility: "private",
      }),
    ).rejects.toBeInstanceOf(SavedViewNameConflictError);

    await expect(
      service.remove({ ...viewer, personId: "person-demo-speaker" }, id),
    ).rejects.toMatchObject({ status: 404 });
    await service.remove(viewer, id);
    expect(await service.list(viewer)).toEqual([]);
  });
});
