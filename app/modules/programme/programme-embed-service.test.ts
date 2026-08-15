import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoProgramme } from "~/platform/demo/seed.server";
import { defaultProgrammeEmbedConfiguration } from "./programme-embed-configuration";
import {
  ProgrammeEmbedRevisionConflictError,
  ProgrammeEmbedService,
  ProgrammeEmbedStateError,
} from "./programme-embed-service.server";

const admin: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

describe("managed programme embeds", () => {
  it("persists audited revisions and enforces the terminal lifecycle", async () => {
    const testEnvironment = env as unknown as CloudflareEnvironment;
    await ensureDemoProgramme(testEnvironment);
    const service = new ProgrammeEmbedService(testEnvironment);
    const slug = `managed-${crypto.randomUUID().slice(0, 8)}`;
    const configuration = defaultProgrammeEmbedConfiguration();
    const id = await service.create(admin, {
      name: "Conference homepage",
      slug,
      installationNote: "Homepage below the hero",
      configurationJson: JSON.stringify(configuration),
    });

    let embed = (await service.list(admin)).find((candidate) => candidate.id === id)!;
    expect(embed).toMatchObject({ slug, status: "draft", revision: 1 });
    expect(await service.getPublic("future-of-events-2027", slug)).toMatchObject({
      status: "draft",
    });
    await testEnvironment.DB.prepare(
      "UPDATE events SET activation_status = 'provisioning_failed' WHERE id = ?",
    )
      .bind(admin.eventId)
      .run();
    try {
      await expect(
        service.getPublic("future-of-events-2027", slug),
      ).resolves.toBeNull();
    } finally {
      await testEnvironment.DB.prepare(
        "UPDATE events SET activation_status = 'active' WHERE id = ?",
      )
        .bind(admin.eventId)
        .run();
    }

    await service.update(admin, {
      id,
      revision: 1,
      name: "Homepage schedule",
      installationNote: "Homepage below the hero",
      configurationJson: JSON.stringify({ ...configuration, density: "compact" }),
      confirmed: "yes",
    });
    embed = (await service.list(admin)).find((candidate) => candidate.id === id)!;
    expect(embed).toMatchObject({
      name: "Homepage schedule",
      slug,
      revision: 2,
      configuration: { density: "compact" },
    });
    await expect(
      service.update(admin, {
        id,
        revision: 1,
        name: "Stale update",
        installationNote: "",
        configurationJson: JSON.stringify(configuration),
        confirmed: "yes",
      }),
    ).rejects.toBeInstanceOf(ProgrammeEmbedRevisionConflictError);

    await service.transition(admin, {
      id,
      revision: 2,
      nextStatus: "active",
      confirmed: "yes",
    });
    await service.transition(admin, {
      id,
      revision: 3,
      nextStatus: "paused",
      confirmed: "yes",
    });
    await service.transition(admin, {
      id,
      revision: 4,
      nextStatus: "revoked",
      confirmed: "yes",
    });
    await expect(
      service.transition(admin, {
        id,
        revision: 5,
        nextStatus: "active",
        confirmed: "yes",
      }),
    ).rejects.toBeInstanceOf(ProgrammeEmbedStateError);

    const actions = await env.DB.prepare(
      `SELECT action FROM audit_events
        WHERE entity_type = 'programme_embed' AND entity_id = ?
        ORDER BY created_at, rowid`,
    )
      .bind(id)
      .all<{ action: string }>();
    expect(actions.results.map((row) => row.action)).toEqual([
      "programme_embed.created",
      "programme_embed.updated",
      "programme_embed.activated",
      "programme_embed.paused",
      "programme_embed.revoked",
    ]);
    const revoked = await service.getPublic("future-of-events-2027", slug);
    expect(revoked).toMatchObject({ status: "revoked", revision: 5 });
    await expect(
      service.create(admin, {
        name: "Cannot reuse",
        slug,
        installationNote: "",
        configurationJson: JSON.stringify(configuration),
      }),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("requires explicit confirmation for consequential changes", async () => {
    const testEnvironment = env as unknown as CloudflareEnvironment;
    await ensureDemoProgramme(testEnvironment);
    const service = new ProgrammeEmbedService(testEnvironment);
    const id = await service.create(admin, {
      name: "Confirmation test",
      slug: `confirm-${crypto.randomUUID().slice(0, 8)}`,
      installationNote: "",
      configurationJson: JSON.stringify(defaultProgrammeEmbedConfiguration()),
    });
    await expect(
      service.transition(admin, {
        id,
        revision: 1,
        nextStatus: "active",
        confirmed: null,
      }),
    ).rejects.toThrow(/preview and confirm/i);
    const futureDraftId = await service.create(admin, {
      name: "Future publication filter",
      slug: `future-filter-${crypto.randomUUID().slice(0, 8)}`,
      installationNote: "",
      configurationJson: JSON.stringify({
        ...defaultProgrammeEmbedConfiguration(),
        track: "Not yet a published track",
      }),
    });
    await expect(
      service.transition(admin, {
        id: futureDraftId,
        revision: 1,
        nextStatus: "active",
        confirmed: "yes",
      }),
    ).rejects.toThrow(/published track/i);
  });
});
