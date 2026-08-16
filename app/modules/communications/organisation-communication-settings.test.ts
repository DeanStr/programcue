import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { OrganisationCommunicationSettingsService } from "./organisation-communication-settings.server";

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
    await expect(service.get(owner)).resolves.toEqual({
      physicalAddress: "",
      canManage: true,
    });
    await expect(
      service.save(owner, "100 Programme Way, Toronto, ON M5V 2W6"),
    ).resolves.toEqual({
      physicalAddress: "100 Programme Way, Toronto, ON M5V 2W6",
    });
    await expect(service.get(owner)).resolves.toEqual({
      physicalAddress: "100 Programme Way, Toronto, ON M5V 2W6",
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
      metadataJson: JSON.stringify({ physicalAddressConfigured: true }),
    });
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
      ).save(eventAdministrator, "100 Programme Way"),
    ).rejects.toMatchObject({ status: 403 });
  });
});
