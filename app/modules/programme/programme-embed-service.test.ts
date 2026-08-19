import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoProgramme } from "~/platform/demo/seed.server";
import {
  defaultProgrammeEmbedConfiguration,
  ProgrammeEmbedConfigurationError,
} from "./programme-embed-configuration";
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
  it("rejects retired agenda authoring while reading historical rows as Schedule", async () => {
    const testEnvironment = env as unknown as CloudflareEnvironment;
    await ensureDemoProgramme(testEnvironment);
    const service = new ProgrammeEmbedService(testEnvironment);
    const configuration = defaultProgrammeEmbedConfiguration();
    const retiredConfiguration = JSON.stringify({
      ...configuration,
      surface: "agenda",
    });

    await expect(
      service.create(admin, {
        name: "Retired create surface",
        slug: `retired-create-${crypto.randomUUID().slice(0, 8)}`,
        installationNote: "",
        configurationJson: retiredConfiguration,
      }),
    ).rejects.toBeInstanceOf(ProgrammeEmbedConfigurationError);

    const authoredId = await service.create(admin, {
      name: "Current surface",
      slug: `current-${crypto.randomUUID().slice(0, 8)}`,
      installationNote: "",
      configurationJson: JSON.stringify(configuration),
    });
    await expect(
      service.update(admin, {
        id: authoredId,
        revision: 1,
        name: "Retired update surface",
        installationNote: "",
        configurationJson: retiredConfiguration,
        confirmed: "yes",
      }),
    ).rejects.toBeInstanceOf(ProgrammeEmbedConfigurationError);

    const historicalId = crypto.randomUUID();
    const historicalSlug = `historical-${historicalId.slice(0, 8)}`;
    await testEnvironment.DB.prepare(
      `INSERT INTO programme_embeds (
         id, event_id, organisation_id, name, slug, status,
         configuration_json, installation_note, revision,
         created_by_person_id, updated_by_person_id
       ) VALUES (?, ?, ?, ?, ?, 'draft', ?, NULL, 1, ?, ?)`,
    )
      .bind(
        historicalId,
        admin.eventId,
        admin.organisationId,
        "Historical agenda",
        historicalSlug,
        retiredConfiguration,
        admin.personId,
        admin.personId,
      )
      .run();

    expect(
      (await service.list(admin)).find((embed) => embed.id === historicalId),
    ).toMatchObject({
      slug: historicalSlug,
      configuration: { surface: "schedule" },
    });
  });

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

    let embed = (await service.list(admin)).find(
      (candidate) => candidate.id === id,
    )!;
    expect(embed).toMatchObject({ slug, status: "draft", revision: 1 });
    expect(
      await service.getPublic("future-of-events-2027", slug),
    ).toMatchObject({
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
      configurationJson: JSON.stringify({
        ...configuration,
        density: "compact",
      }),
      confirmed: "yes",
    });
    embed = (await service.list(admin)).find(
      (candidate) => candidate.id === id,
    )!;
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
    await expect(
      testEnvironment.DB.prepare(
        `SELECT COUNT(*) AS count
           FROM audit_events
          WHERE entity_type = 'programme_embed'
            AND action = 'programme_embed.created'
            AND json_extract(metadata_json, '$.after.slug') = ?`,
      )
        .bind(slug)
        .first(),
    ).resolves.toEqual({ count: 1 });
  });

  it("does not create an embed when its required audit insert is suppressed", async () => {
    const testEnvironment = env as unknown as CloudflareEnvironment;
    await ensureDemoProgramme(testEnvironment);
    const service = new ProgrammeEmbedService(testEnvironment);
    const slug = `suppressed-create-${crypto.randomUUID().slice(0, 8)}`;
    await testEnvironment.DB.prepare(
      `CREATE TRIGGER suppress_programme_embed_created_audit
       BEFORE INSERT ON audit_events
       WHEN NEW.action = 'programme_embed.created'
       BEGIN
         SELECT RAISE(IGNORE);
       END`,
    ).run();
    try {
      await expect(
        service.create(admin, {
          name: "Suppressed create audit",
          slug,
          installationNote: "",
          configurationJson: JSON.stringify(
            defaultProgrammeEmbedConfiguration(),
          ),
        }),
      ).rejects.toMatchObject({
        status: 500,
        message: expect.stringMatching(/required audit history/i),
      });
      await expect(
        testEnvironment.DB.prepare(
          `SELECT COUNT(*) AS count
             FROM programme_embeds
            WHERE event_id = ? AND slug = ?`,
        )
          .bind(admin.eventId, slug)
          .first(),
      ).resolves.toEqual({ count: 0 });
    } finally {
      await testEnvironment.DB.prepare(
        "DROP TRIGGER IF EXISTS suppress_programme_embed_created_audit",
      ).run();
    }
  });

  it("does not update or transition an embed when its audit insert is suppressed", async () => {
    const testEnvironment = env as unknown as CloudflareEnvironment;
    await ensureDemoProgramme(testEnvironment);
    const service = new ProgrammeEmbedService(testEnvironment);
    const configuration = defaultProgrammeEmbedConfiguration();
    const updateId = await service.create(admin, {
      name: "Suppressed update audit",
      slug: `suppressed-update-${crypto.randomUUID().slice(0, 8)}`,
      installationNote: "Before",
      configurationJson: JSON.stringify(configuration),
    });
    const transitionId = await service.create(admin, {
      name: "Suppressed transition audit",
      slug: `suppressed-transition-${crypto.randomUUID().slice(0, 8)}`,
      installationNote: "",
      configurationJson: JSON.stringify(configuration),
    });
    await testEnvironment.DB.prepare(
      `CREATE TRIGGER suppress_programme_embed_change_audit
       BEFORE INSERT ON audit_events
       WHEN NEW.action IN ('programme_embed.updated', 'programme_embed.activated')
       BEGIN
         SELECT RAISE(IGNORE);
       END`,
    ).run();
    try {
      await expect(
        service.update(admin, {
          id: updateId,
          revision: 1,
          name: "Unaudited update",
          installationNote: "After",
          configurationJson: JSON.stringify({
            ...configuration,
            density: "compact",
          }),
          confirmed: "yes",
        }),
      ).rejects.toMatchObject({
        status: 500,
        message: expect.stringMatching(/required audit history/i),
      });
      await expect(
        service.transition(admin, {
          id: transitionId,
          revision: 1,
          nextStatus: "active",
          confirmed: "yes",
        }),
      ).rejects.toMatchObject({
        status: 500,
        message: expect.stringMatching(/required audit history/i),
      });

      const embeds = await service.list(admin);
      expect(embeds.find(({ id }) => id === updateId)).toMatchObject({
        name: "Suppressed update audit",
        installationNote: "Before",
        revision: 1,
        configuration: { density: "comfortable" },
      });
      expect(embeds.find(({ id }) => id === transitionId)).toMatchObject({
        status: "draft",
        revision: 1,
      });
      await expect(
        testEnvironment.DB.prepare(
          `SELECT COUNT(*) AS count
             FROM audit_events
            WHERE entity_type = 'programme_embed'
              AND entity_id IN (?, ?)
              AND action <> 'programme_embed.created'`,
        )
          .bind(updateId, transitionId)
          .first(),
      ).resolves.toEqual({ count: 0 });
    } finally {
      await testEnvironment.DB.prepare(
        "DROP TRIGGER IF EXISTS suppress_programme_embed_change_audit",
      ).run();
    }
  });

  it("preserves the revision-conflict contract for a race before the audit batch", async () => {
    const testEnvironment = env as unknown as CloudflareEnvironment;
    await ensureDemoProgramme(testEnvironment);
    const configuration = defaultProgrammeEmbedConfiguration();
    const id = await new ProgrammeEmbedService(testEnvironment).create(admin, {
      name: "Concurrent embed",
      slug: `concurrent-embed-${crypto.randomUUID().slice(0, 8)}`,
      installationNote: "",
      configurationJson: JSON.stringify(configuration),
    });
    let injectRace = true;
    const racingDatabase = new Proxy(testEnvironment.DB, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (injectRace) {
              injectRace = false;
              await target
                .prepare(
                  `UPDATE programme_embeds
                      SET name = 'Concurrent winner', revision = revision + 1,
                          updated_at = unixepoch()
                    WHERE id = ? AND event_id = ? AND organisation_id = ?`,
                )
                .bind(id, admin.eventId, admin.organisationId)
                .run();
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const racingEnvironment = new Proxy(testEnvironment, {
      get(target, property) {
        return property === "DB"
          ? racingDatabase
          : Reflect.get(target, property);
      },
    });

    await expect(
      new ProgrammeEmbedService(racingEnvironment).update(admin, {
        id,
        revision: 1,
        name: "Stale contender",
        installationNote: "",
        configurationJson: JSON.stringify(configuration),
        confirmed: "yes",
      }),
    ).rejects.toBeInstanceOf(ProgrammeEmbedRevisionConflictError);
    await expect(
      testEnvironment.DB.prepare(
        `SELECT name, revision,
                (SELECT COUNT(*) FROM audit_events audit
                  WHERE audit.entity_type = 'programme_embed'
                    AND audit.entity_id = embed.id
                    AND audit.action = 'programme_embed.updated') AS updateAuditCount
           FROM programme_embeds embed
          WHERE embed.id = ?`,
      )
        .bind(id)
        .first(),
    ).resolves.toEqual({
      name: "Concurrent winner",
      revision: 2,
      updateAuditCount: 0,
    });
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
