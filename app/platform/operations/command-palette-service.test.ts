import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";

import { CommandPaletteService } from "./command-palette-service.server";

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

describe("command palette record search", () => {
  beforeEach(async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM integration_runs WHERE id = 'command-search-run'",
      ),
      env.DB.prepare(
        "DELETE FROM integration_connections WHERE id = 'command-search-connection'",
      ),
      env.DB.prepare(
        "DELETE FROM operation_jobs WHERE id = 'command-search-operation'",
      ),
      env.DB.prepare(
        "DELETE FROM resource_pages WHERE id = 'command-search-resource'",
      ),
      env.DB.prepare("DELETE FROM tracks WHERE id = 'command-search-track'"),
      env.DB.prepare(
        `INSERT INTO tracks (
           id,event_id,name,slug,colour_token,position,exclusive,is_public
         ) VALUES ('command-search-track',?,'Command Search Stream',
                   'command-search-stream','#0f766e',99,0,1)`,
      ).bind(viewer.eventId),
      env.DB.prepare(
        `INSERT INTO resource_pages (
           id,event_id,title,slug,category,status,audience_scope,
           acknowledgement_required,revision,created_by_person_id
         ) VALUES ('command-search-resource',?,'Speaker briefing guide',
                   'speaker-briefing-guide','Preparation','draft',
                   'all_speakers',0,1,?)`,
      ).bind(viewer.eventId, viewer.personId),
      env.DB.prepare(
        `INSERT INTO integration_connections (
           id,organisation_id,event_id,provider,status,direction,configuration_json
         ) VALUES ('command-search-connection',?,?,'accelevents','connected',
                   'outbound','{}')`,
      ).bind(viewer.organisationId, viewer.eventId),
      env.DB.prepare(
        `INSERT INTO operation_jobs (
           id,organisation_id,event_id,requested_by_person_id,type,
           idempotency_key,correlation_id,status,payload_json
         ) VALUES ('command-search-operation',?,?,?,
                   'integration.accelevents.export','command-search-operation',
                   'command-search-correlation','failed','{}')`,
      ).bind(viewer.organisationId, viewer.eventId, viewer.personId),
      env.DB.prepare(
        `INSERT INTO integration_runs (
           id,connection_id,operation_id,idempotency_key,status,direction,
           dry_run,summary_json
         ) VALUES ('command-search-run','command-search-connection',
                   'command-search-operation','command-search-run','failed',
                   'outbound',0,'{}')`,
      ),
    ]);
  });

  it("uses domain aliases to find rooms, tracks, resources and operations", async () => {
    const service = new CommandPaletteService(
      env as unknown as CloudflareEnvironment,
    );

    await expect(
      service.search(viewer, { query: "venue main stage", scope: "event" }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        id: "main",
        kind: "room",
        href: "/admin/event?room=main",
      }),
    );
    await expect(
      service.search(viewer, {
        query: "stream command search",
        scope: "event",
      }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        id: "command-search-track",
        kind: "track",
        href: "/admin/event?track=command-search-track",
      }),
    );
    await expect(
      service.search(viewer, {
        query: "wiki speaker briefing",
        scope: "event",
      }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        id: "command-search-resource",
        kind: "resource",
        href: "/admin/resources?resource=command-search-resource",
      }),
    );
    await expect(
      service.search(viewer, { query: "job accelevents", scope: "event" }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        id: "command-search-operation",
        kind: "operation",
        href: "/admin/operations?operation=command-search-operation",
      }),
    );
    await expect(
      service.search(viewer, {
        query: "integration command-search-run",
        scope: "event",
      }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        id: "command-search-operation",
        kind: "operation",
      }),
    );
  });

  it("returns one operation when several communications share it", async () => {
    const token = crypto.randomUUID();
    const operationId = `command-communication-operation-${token}`;
    const firstCommunicationId = `command-communication-first-${token}`;
    const secondCommunicationId = `command-communication-second-${token}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO operation_jobs (
           id,organisation_id,event_id,requested_by_person_id,type,
           idempotency_key,correlation_id,status,payload_json
         ) VALUES (?,?,?,?,'communication.send',?,?,'queued','{}')`,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        operationId,
        operationId,
      ),
      env.DB.prepare(
        `INSERT INTO communications (
           id,event_id,operation_id,idempotency_key,status,audience_json,
           content_snapshot_json
         ) VALUES (?,?,?,?,'queued','{}',?)`,
      ).bind(
        firstCommunicationId,
        viewer.eventId,
        operationId,
        firstCommunicationId,
        JSON.stringify({ subjectTemplate: `Shared briefing ${token} A` }),
      ),
      env.DB.prepare(
        `INSERT INTO communications (
           id,event_id,operation_id,idempotency_key,status,audience_json,
           content_snapshot_json
         ) VALUES (?,?,?,?,'queued','{}',?)`,
      ).bind(
        secondCommunicationId,
        viewer.eventId,
        operationId,
        secondCommunicationId,
        JSON.stringify({ subjectTemplate: `Shared briefing ${token} B` }),
      ),
    ]);

    const records = await new CommandPaletteService(
      env as unknown as CloudflareEnvironment,
    ).search(viewer, {
      query: `communication Shared briefing ${token}`,
      scope: "event",
    });

    expect(records.filter((record) => record.id === operationId)).toHaveLength(1);
    await expect(
      new CommandPaletteService(
        env as unknown as CloudflareEnvironment,
      ).search(viewer, {
        query: `communication ${secondCommunicationId}`,
        scope: "event",
      }),
    ).resolves.toContainEqual(expect.objectContaining({ id: operationId }));
  });

  it("excludes retired rooms whose Event Setup links cannot be opened", async () => {
    const token = crypto.randomUUID();
    const roomId = `command-retired-room-${token}`;
    const roomName = `Retired command room ${token}`;
    await env.DB.prepare(
      `INSERT INTO rooms (
         id,event_id,name,capacity,resources_json,position,status
       ) VALUES (?,?,?,20,'[]',99,'retired')`,
    )
      .bind(roomId, viewer.eventId, roomName)
      .run();

    const records = await new CommandPaletteService(
      env as unknown as CloudflareEnvironment,
    ).search(viewer, {
      query: `room ${token}`,
      scope: "event",
    });

    expect(records).not.toContainEqual(expect.objectContaining({ id: roomId }));
  });

  it("does not let a record alias broaden a committee chair's assignment scope", async () => {
    const records = await new CommandPaletteService(
      env as unknown as CloudflareEnvironment,
    ).search(
      {
        ...viewer,
        personId: "person-demo-evaluator",
        role: "committee_chair",
      },
      { query: "room main", scope: "event" },
    );

    expect(records).toEqual([]);
  });
});
