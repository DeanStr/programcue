import { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";

const physicalAddressSchema = z
  .string()
  .trim()
  .min(5, "Enter the organisation's complete postal address.")
  .max(500);

const communicationAddressRevisionSchema = z.coerce.number().int().positive();

export class OrganisationCommunicationSettingsConflictError extends Error {
  constructor() {
    super(
      "The organisation postal address changed after this page loaded. Refresh before saving again.",
    );
    this.name = "OrganisationCommunicationSettingsConflictError";
  }
}

export class OrganisationCommunicationSettingsService {
  constructor(private readonly env: CloudflareEnvironment) {}

  async get(viewer: Viewer) {
    const row = await this.env.DB.prepare(
      `SELECT organisation.communication_physical_address AS physicalAddress,
              organisation.communication_physical_address_revision AS revision,
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
      .first<{
        physicalAddress: string | null;
        revision: number;
        canManage: number;
      }>();
    if (!row) throw new Response("Organisation not found.", { status: 404 });
    return {
      physicalAddress: row.physicalAddress ?? "",
      revision: row.revision,
      canManage: Boolean(row.canManage),
    };
  }

  async save(
    viewer: Viewer,
    rawPhysicalAddress: unknown,
    rawExpectedRevision: unknown,
  ) {
    const current = await this.get(viewer);
    const { canManage } = current;
    if (!canManage)
      throw new Response(
        "Only an organisation owner can change the default postal address.",
        { status: 403 },
      );
    const expectedRevision =
      communicationAddressRevisionSchema.parse(rawExpectedRevision);
    if (current.revision !== expectedRevision) {
      throw new OrganisationCommunicationSettingsConflictError();
    }
    const physicalAddress = physicalAddressSchema.parse(rawPhysicalAddress);
    const auditId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const nextRevision = expectedRevision + 1;
    let results: D1Result<unknown>[];
    try {
      results = await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE organisations
              SET communication_physical_address = ?,
                  communication_physical_address_revision = ?,
                  communication_physical_address_last_operation_id = ?,
                  updated_at = unixepoch()
            WHERE id = ? AND communication_physical_address_revision = ?
              AND EXISTS (
                SELECT 1 FROM memberships membership
                 WHERE membership.organisation_id = organisations.id
                   AND membership.person_id = ?
                   AND membership.event_id IS NULL
                   AND membership.role = 'owner'
                   AND membership.accepted_at IS NOT NULL
                   AND membership.revoked_at IS NULL
              )`,
        ).bind(
          physicalAddress,
          nextRevision,
          operationId,
          viewer.organisationId,
          expectedRevision,
          viewer.personId,
        ),
        this.env.DB.prepare(
          `INSERT INTO audit_events (
             id, actor_kind, origin, metadata_version, organisation_id, event_id,
             actor_person_id, action, entity_type, entity_id, correlation_id,
             metadata_json, created_at
           )
           SELECT ?, 'person', 'admin_ui', 1, organisation.id, NULL, ?,
                  'organisation.communication_settings.updated', 'organisation',
                  organisation.id, ?, ?, unixepoch()
             FROM organisations organisation
            WHERE organisation.id = ?
              AND organisation.communication_physical_address_revision = ?
              AND organisation.communication_physical_address_last_operation_id = ?
              AND organisation.communication_physical_address IS ?
              AND EXISTS (
                SELECT 1 FROM memberships membership
                 WHERE membership.organisation_id = organisation.id
                   AND membership.person_id = ?
                   AND membership.event_id IS NULL
                   AND membership.role = 'owner'
                   AND membership.accepted_at IS NOT NULL
                   AND membership.revoked_at IS NULL
              )`,
        ).bind(
          auditId,
          viewer.personId,
          operationId,
          JSON.stringify({
            physicalAddressConfigured: true,
            revision: nextRevision,
          }),
          viewer.organisationId,
          nextRevision,
          operationId,
          physicalAddress,
          viewer.personId,
        ),
        // D1 commits a batch unless a statement fails. This sentinel forces a
        // rollback unless the authorized update and its audit both completed.
        this.env.DB.prepare(
          `INSERT INTO organisations (id, name, slug)
           SELECT ?, NULL, ?
            WHERE NOT EXISTS (
              SELECT 1
                FROM organisations organisation
                JOIN audit_events audit
                  ON audit.organisation_id = organisation.id
                 AND audit.event_id IS NULL
                 AND audit.actor_person_id = ?
                 AND audit.action = 'organisation.communication_settings.updated'
                 AND audit.entity_type = 'organisation'
                 AND audit.entity_id = organisation.id
                 AND audit.correlation_id = ?
               WHERE organisation.id = ?
                 AND organisation.communication_physical_address_revision = ?
                 AND organisation.communication_physical_address_last_operation_id = ?
                 AND organisation.communication_physical_address IS ?
                 AND EXISTS (
                   SELECT 1 FROM memberships membership
                    WHERE membership.organisation_id = organisation.id
                      AND membership.person_id = ?
                      AND membership.event_id IS NULL
                      AND membership.role = 'owner'
                      AND membership.accepted_at IS NOT NULL
                      AND membership.revoked_at IS NULL
                 )
            )`,
        ).bind(
          `communication-address-guard:${operationId}`,
          `communication-address-guard:${operationId}`,
          viewer.personId,
          operationId,
          viewer.organisationId,
          nextRevision,
          operationId,
          physicalAddress,
          viewer.personId,
        ),
      ]);
    } catch (error) {
      const latest = await this.get(viewer);
      if (!latest.canManage) {
        throw new Response(
          "Only an organisation owner can change the default postal address.",
          { status: 403 },
        );
      }
      if (latest.revision !== expectedRevision) {
        throw new OrganisationCommunicationSettingsConflictError();
      }
      throw error;
    }
    const [updated, audited] = results;
    if (updated.meta.changes !== 1 || audited.meta.changes !== 1)
      throw new Error(
        "The organisation address update did not satisfy its atomic completion guard.",
      );
    return { physicalAddress, revision: nextRevision };
  }
}
