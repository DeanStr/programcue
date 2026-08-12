import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { ensureDemoData } from "~/platform/demo/seed.server";
import { requireOrganisationAdministrator } from "./organisation.server";

const workerEnv = env as unknown as CloudflareEnvironment;

function adminRequest() {
  return new Request("https://programcue.test/admin/crm", {
    headers: {
      cookie:
        "program_cue_demo_role=administrator; program_cue_event=evt-foe-2025",
    },
  });
}

beforeEach(async () => {
  await ensureDemoData(workerEnv);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO memberships (
       id, organisation_id, event_id, person_id, role,
       invited_at, invitation_expires_at, accepted_at, revoked_at, created_at
     ) VALUES ('membership-organisation-admin-test', 'org-future-events', NULL,
               'person-demo-admin', 'administrator', unixepoch(), NULL,
               unixepoch(), NULL, unixepoch())`,
  ).run();
});

describe("organisation administrator boundary", () => {
  it("resolves accepted organisation-wide access through the selected event", async () => {
    await expect(
      requireOrganisationAdministrator(adminRequest(), workerEnv),
    ).resolves.toMatchObject({
      personId: "person-demo-admin",
      organisationId: "org-future-events",
      currentEventId: "evt-foe-2025",
      role: "administrator",
    });
  });

  it("rejects event-only and pending organisation memberships", async () => {
    await env.DB.prepare(
      `UPDATE memberships
          SET accepted_at = NULL, invitation_expires_at = unixepoch() + 3600
        WHERE id = 'membership-organisation-admin-test'`,
    ).run();

    await expect(
      requireOrganisationAdministrator(adminRequest(), workerEnv),
    ).rejects.toMatchObject({ status: 403 });

    await env.DB.prepare(
      "DELETE FROM memberships WHERE id = 'membership-organisation-admin-test'",
    ).run();
    await expect(
      requireOrganisationAdministrator(adminRequest(), workerEnv),
    ).rejects.toMatchObject({ status: 403 });
  });
});
