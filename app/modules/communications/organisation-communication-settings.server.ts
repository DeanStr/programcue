import { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";

const physicalAddressSchema = z
  .string()
  .trim()
  .min(5, "Enter the organisation's complete postal address.")
  .max(500);

export class OrganisationCommunicationSettingsService {
  constructor(private readonly env: CloudflareEnvironment) {}

  async get(viewer: Viewer) {
    const row = await this.env.DB.prepare(
      `SELECT organisation.communication_physical_address AS physicalAddress,
              EXISTS (
                SELECT 1 FROM memberships membership
                 WHERE membership.organisation_id = organisation.id
                   AND membership.person_id = ? AND membership.event_id IS NULL
                   AND membership.role = 'owner'
                   AND membership.accepted_at IS NOT NULL
                   AND membership.revoked_at IS NULL
              ) AS canManage
         FROM organisations organisation
        WHERE organisation.id = ?`,
    )
      .bind(viewer.personId, viewer.organisationId)
      .first<{ physicalAddress: string | null; canManage: number }>();
    if (!row) throw new Response("Organisation not found.", { status: 404 });
    return {
      physicalAddress: row.physicalAddress ?? "",
      canManage: Boolean(row.canManage),
    };
  }

  async save(viewer: Viewer, rawPhysicalAddress: unknown) {
    const { canManage } = await this.get(viewer);
    if (!canManage)
      throw new Response(
        "Only an organisation owner can change the default postal address.",
        { status: 403 },
      );
    const physicalAddress = physicalAddressSchema.parse(rawPhysicalAddress);
    const auditId = crypto.randomUUID();
    const [updated, audited] = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE organisations
            SET communication_physical_address = ?, updated_at = unixepoch()
          WHERE id = ?`,
      ).bind(physicalAddress, viewer.organisationId),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id,
           actor_person_id, action, entity_type, entity_id, metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, organisation.id, NULL, ?,
                'organisation.communication_settings.updated', 'organisation',
                organisation.id, ?, unixepoch()
           FROM organisations organisation
          WHERE organisation.id = ?`,
      ).bind(
        auditId,
        viewer.personId,
        JSON.stringify({ physicalAddressConfigured: true }),
        viewer.organisationId,
      ),
    ]);
    if (updated.meta.changes !== 1 || audited.meta.changes !== 1)
      throw new Response("Organisation not found.", { status: 404 });
    return { physicalAddress };
  }
}
