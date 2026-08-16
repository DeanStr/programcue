import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  OrganisationCommunicationSettingsConflictError,
  OrganisationCommunicationSettingsService,
} from "./organisation-communication-settings.server";

const owner: Viewer = {
  personId: "person-demo-owner",
  name: "Morgan Chen",
  email: "morgan.owner@example.com",
  role: "owner",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

beforeEach(async () => {
  await ensureDemoData(env as unknown as CloudflareEnvironment);
  await env.DB.prepare(
    "UPDATE organisations SET communication_physical_address = NULL WHERE id = ?",
  )
    .bind(owner.organisationId)
    .run();
});

describe("organisation communication settings", () => {
  it("persists a real organisation postal address for template defaults", async () => {
    const service = new OrganisationCommunicationSettingsService(
      env as unknown as CloudflareEnvironment,
    );
    const initial = await service.get(owner);
    expect(initial).toEqual({
      physicalAddress: "",
      revision: expect.any(Number),
      canManage: true,
    });
    await expect(
      service.save(
        owner,
        "100 Programme Way, Toronto, ON M5V 2W6",
        initial.revision,
      ),
    ).resolves.toEqual({
      physicalAddress: "100 Programme Way, Toronto, ON M5V 2W6",
      revision: initial.revision + 1,
    });
    await expect(service.get(owner)).resolves.toEqual({
      physicalAddress: "100 Programme Way, Toronto, ON M5V 2W6",
      revision: initial.revision + 1,
      canManage: true,
    });
    await expect(
      env.DB.prepare(
        `SELECT action, event_id AS eventId, metadata_json AS metadataJson
           FROM audit_events
          WHERE organisation_id = ?
            AND action = 'organisation.communication_settings.updated'
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
      )
        .bind(owner.organisationId)
        .first(),
    ).resolves.toMatchObject({
      action: "organisation.communication_settings.updated",
      eventId: null,
      metadataJson: JSON.stringify({
        physicalAddressConfigured: true,
        revision: initial.revision + 1,
      }),
    });
  });

  it("rejects a stale owner form without overwriting the newer address", async () => {
    const service = new OrganisationCommunicationSettingsService(
      env as unknown as CloudflareEnvironment,
    );
    const initial = await service.get(owner);
    await service.save(owner, "First owner address", initial.revision);

    await expect(
      service.save(owner, "Stale owner address", initial.revision),
    ).rejects.toBeInstanceOf(OrganisationCommunicationSettingsConflictError);
    await expect(service.get(owner)).resolves.toMatchObject({
      physicalAddress: "First owner address",
      revision: initial.revision + 1,
    });
  });

  it("rolls back when owner access is revoked at the write boundary", async () => {
    const database = env.DB;
    let revoked = false;
    const racingDatabase = new Proxy(database, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            if (!revoked) {
              revoked = true;
              await target
                .prepare(
                  `UPDATE memberships SET revoked_at = unixepoch()
                    WHERE organisation_id = ? AND event_id IS NULL
                      AND person_id = ? AND role = 'owner'`,
                )
                .bind(owner.organisationId, owner.personId)
                .run();
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const service = new OrganisationCommunicationSettingsService({
      DB: racingDatabase,
    } as CloudflareEnvironment);
    const initial = await service.get(owner);
    const auditsBefore = await database
      .prepare(
        `SELECT COUNT(*) AS count FROM audit_events
          WHERE organisation_id = ?
            AND action = 'organisation.communication_settings.updated'`,
      )
      .bind(owner.organisationId)
      .first<{ count: number }>();

    try {
      await expect(
        service.save(owner, "Revoked owner address", initial.revision),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        database
          .prepare(
            `SELECT communication_physical_address AS physicalAddress
               FROM organisations WHERE id = ?`,
          )
          .bind(owner.organisationId)
          .first(),
      ).resolves.toEqual({ physicalAddress: null });
      await expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM audit_events
              WHERE organisation_id = ?
                AND action = 'organisation.communication_settings.updated'`,
          )
          .bind(owner.organisationId)
          .first(),
      ).resolves.toEqual(auditsBefore);
    } finally {
      await database
        .prepare(
          `UPDATE memberships SET revoked_at = NULL
            WHERE organisation_id = ? AND event_id IS NULL
              AND person_id = ? AND role = 'owner'`,
        )
        .bind(owner.organisationId, owner.personId)
        .run();
    }
  });

  it("rejects event administrators changing organisation defaults", async () => {
    const eventAdministrator = {
      ...owner,
      personId: "person-demo-admin",
      name: "Jordan Alvarez",
      email: "sbek-organizer@example.com",
      role: "administrator" as const,
    };
    await expect(
      new OrganisationCommunicationSettingsService(
        env as unknown as CloudflareEnvironment,
      ).save(eventAdministrator, "100 Programme Way", 1),
    ).rejects.toMatchObject({ status: 403 });
  });
});
