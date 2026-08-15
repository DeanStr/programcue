import type { OrganisationAdministrator } from "~/platform/auth/organisation.server";
import {
  contactScopeBindings,
  contactScopeCte,
} from "./crm-contact-scope.server";
import { CrmStateError } from "./crm-errors";
import { crmPersonIdSchema } from "./crm-schema";

export class CrmMergeService {
  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly ensureContact: (
      viewer: OrganisationAdministrator,
      personId: string,
    ) => Promise<void>,
  ) {}

  async merge(
    viewer: OrganisationAdministrator,
    rawPrimaryId: unknown,
    rawSecondaryId: unknown,
  ) {
    const primaryId = crmPersonIdSchema.parse(rawPrimaryId);
    const secondaryId = crmPersonIdSchema.parse(rawSecondaryId);
    if (primaryId === secondaryId)
      throw new CrmStateError("Choose two different contacts to merge.", 422);
    const candidates = await this.env.DB.prepare(
      `${contactScopeCte}
       SELECT person.id,
              COALESCE(profile.display_name, person.display_name) AS name
         FROM organisation_contact_ids scoped JOIN people person ON person.id = scoped.person_id
         LEFT JOIN scoped_contact_profiles profile ON profile.person_id = person.id
        WHERE person.id IN (?, ?)`,
    )
      .bind(...contactScopeBindings(viewer), primaryId, secondaryId)
      .all<{ id: string; name: string }>();
    if (
      candidates.results.length !== 2 ||
      candidates.results[0]!.name.trim().toLocaleLowerCase() !==
        candidates.results[1]!.name.trim().toLocaleLowerCase()
    ) {
      throw new CrmStateError(
        "Only two same-name contacts in this organisation can be merged.",
        422,
      );
    }
    const linked = await this.env.DB.prepare(
      `SELECT
         EXISTS(SELECT 1 FROM memberships WHERE person_id = ?) OR
         EXISTS(SELECT 1 FROM submissions WHERE submitter_person_id = ?) OR
         EXISTS(SELECT 1 FROM submission_speakers WHERE person_id = ?) OR
         EXISTS(SELECT 1 FROM session_speakers WHERE person_id = ?) OR
         EXISTS(SELECT 1 FROM event_speaker_workflows WHERE person_id = ?) OR
         EXISTS(SELECT 1 FROM auth_accounts WHERE person_id = ?) OR
         EXISTS(SELECT 1 FROM auth_sessions WHERE person_id = ?) OR
         EXISTS(SELECT 1 FROM organisation_contacts
                  WHERE person_id = ? AND organisation_id <> ?
                    AND status = 'active') AS linked`,
    )
      .bind(
        secondaryId,
        secondaryId,
        secondaryId,
        secondaryId,
        secondaryId,
        secondaryId,
        secondaryId,
        secondaryId,
        viewer.organisationId,
      )
      .first<{ linked: number }>();
    if (linked?.linked) {
      throw new CrmStateError(
        "The secondary identity is already linked to access, submissions, an event roster, sessions, or another organisation and cannot be safely merged.",
      );
    }
    await this.ensureContact(viewer, primaryId);
    await this.ensureContact(viewer, secondaryId);
    const [marked] = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE organisation_contacts
            SET status = 'merged', merged_into_person_id = ?, updated_at = unixepoch()
          WHERE organisation_id = ? AND person_id = ? AND status = 'active'
            AND NOT EXISTS (SELECT 1 FROM memberships WHERE person_id = ?)
            AND NOT EXISTS (SELECT 1 FROM submissions WHERE submitter_person_id = ?)
            AND NOT EXISTS (SELECT 1 FROM submission_speakers WHERE person_id = ?)
            AND NOT EXISTS (SELECT 1 FROM session_speakers WHERE person_id = ?)
            AND NOT EXISTS (SELECT 1 FROM event_speaker_workflows WHERE person_id = ?)
            AND NOT EXISTS (SELECT 1 FROM auth_accounts WHERE person_id = ?)
            AND NOT EXISTS (SELECT 1 FROM auth_sessions WHERE person_id = ?)
            AND NOT EXISTS (
              SELECT 1 FROM organisation_contacts shared
               WHERE shared.person_id = ? AND shared.organisation_id <> ?
                 AND shared.status = 'active'
            )`,
      ).bind(
        primaryId,
        viewer.organisationId,
        secondaryId,
        secondaryId,
        secondaryId,
        secondaryId,
        secondaryId,
        secondaryId,
        secondaryId,
        secondaryId,
        secondaryId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO organisation_contact_profiles (
           organisation_id, person_id, display_name, biography,
           organisation_name, job_title, source, created_by_person_id,
           updated_by_person_id, created_at, updated_at
         )
         SELECT ?, primary_person.id,
                COALESCE(primary_profile.display_name, primary_person.display_name),
                COALESCE(NULLIF(primary_profile.biography, ''), primary_person.biography,
                         secondary_profile.biography, secondary_person.biography),
                COALESCE(NULLIF(primary_profile.organisation_name, ''), primary_person.organisation_name,
                         secondary_profile.organisation_name, secondary_person.organisation_name),
                COALESCE(NULLIF(primary_profile.job_title, ''), primary_person.job_title,
                         secondary_profile.job_title, secondary_person.job_title),
                'manual', ?, ?, unixepoch(), unixepoch()
           FROM people primary_person
           JOIN people secondary_person ON secondary_person.id = ?
           LEFT JOIN organisation_contact_profiles primary_profile
             ON primary_profile.organisation_id = ?
            AND primary_profile.person_id = primary_person.id
           LEFT JOIN organisation_contact_profiles secondary_profile
             ON secondary_profile.organisation_id = ?
            AND secondary_profile.person_id = secondary_person.id
          WHERE primary_person.id = ?
            AND EXISTS (
              SELECT 1 FROM organisation_contacts merged
               WHERE merged.organisation_id = ? AND merged.person_id = ?
                 AND merged.status = 'merged'
                 AND merged.merged_into_person_id = primary_person.id
            )
         ON CONFLICT(organisation_id, person_id) DO UPDATE SET
           biography = CASE
             WHEN organisation_contact_profiles.biography IS NULL
               OR trim(organisation_contact_profiles.biography) = ''
             THEN excluded.biography
             ELSE organisation_contact_profiles.biography
           END,
           organisation_name = CASE
             WHEN organisation_contact_profiles.organisation_name IS NULL
               OR trim(organisation_contact_profiles.organisation_name) = ''
             THEN excluded.organisation_name
             ELSE organisation_contact_profiles.organisation_name
           END,
           job_title = CASE
             WHEN organisation_contact_profiles.job_title IS NULL
               OR trim(organisation_contact_profiles.job_title) = ''
             THEN excluded.job_title
             ELSE organisation_contact_profiles.job_title
           END,
           updated_by_person_id = excluded.updated_by_person_id,
           updated_at = unixepoch()`,
      ).bind(
        viewer.organisationId,
        viewer.personId,
        viewer.personId,
        secondaryId,
        viewer.organisationId,
        viewer.organisationId,
        primaryId,
        viewer.organisationId,
        secondaryId,
      ),
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO organisation_contact_tags (
           organisation_id, person_id, tag, created_by_person_id, created_at
         ) SELECT organisation_id, ?, tag, created_by_person_id, created_at
             FROM organisation_contact_tags
            WHERE organisation_id = ? AND person_id = ?
              AND EXISTS (SELECT 1 FROM organisation_contacts merged
                WHERE merged.organisation_id = ? AND merged.person_id = ?
                  AND merged.status = 'merged'
                  AND merged.merged_into_person_id = ?)`,
      ).bind(
        primaryId,
        viewer.organisationId,
        secondaryId,
        viewer.organisationId,
        secondaryId,
        primaryId,
      ),
      this.env.DB.prepare(
        `UPDATE organisation_contact_notes SET person_id = ?
          WHERE organisation_id = ? AND person_id = ?
            AND EXISTS (SELECT 1 FROM organisation_contacts merged
              WHERE merged.organisation_id = ? AND merged.person_id = ?
                AND merged.status = 'merged'
                AND merged.merged_into_person_id = ?)`,
      ).bind(
        primaryId,
        viewer.organisationId,
        secondaryId,
        viewer.organisationId,
        secondaryId,
        primaryId,
      ),
      this.env.DB.prepare(
        `UPDATE crm_pipeline_activity
            SET pipeline_entry_id = (
              SELECT primary_entry.id FROM crm_pipeline_entries primary_entry
               WHERE primary_entry.organisation_id = ?
                 AND primary_entry.person_id = ?
            )
          WHERE organisation_id = ?
            AND pipeline_entry_id = (
              SELECT secondary_entry.id FROM crm_pipeline_entries secondary_entry
               WHERE secondary_entry.organisation_id = ?
                 AND secondary_entry.person_id = ?
            )
            AND EXISTS (
              SELECT 1 FROM crm_pipeline_entries primary_entry
               WHERE primary_entry.organisation_id = ?
                 AND primary_entry.person_id = ?
            )
            AND EXISTS (
              SELECT 1 FROM organisation_contacts merged
               WHERE merged.organisation_id = ? AND merged.person_id = ?
                 AND merged.status = 'merged'
                 AND merged.merged_into_person_id = ?
            )`,
      ).bind(
        viewer.organisationId,
        primaryId,
        viewer.organisationId,
        viewer.organisationId,
        secondaryId,
        viewer.organisationId,
        primaryId,
        viewer.organisationId,
        secondaryId,
        primaryId,
      ),
      this.env.DB.prepare(
        `DELETE FROM crm_pipeline_entries
          WHERE organisation_id = ? AND person_id = ?
            AND EXISTS (
              SELECT 1 FROM crm_pipeline_entries primary_entry
               WHERE primary_entry.organisation_id = ?
                 AND primary_entry.person_id = ?
            )
            AND EXISTS (
              SELECT 1 FROM organisation_contacts merged
               WHERE merged.organisation_id = ? AND merged.person_id = ?
                 AND merged.status = 'merged'
                 AND merged.merged_into_person_id = ?
            )`,
      ).bind(
        viewer.organisationId,
        secondaryId,
        viewer.organisationId,
        primaryId,
        viewer.organisationId,
        secondaryId,
        primaryId,
      ),
      this.env.DB.prepare(
        `UPDATE crm_pipeline_entries SET person_id = ?, revision = revision + 1,
                updated_at = unixepoch()
          WHERE organisation_id = ? AND person_id = ?
            AND NOT EXISTS (SELECT 1 FROM crm_pipeline_entries primary_entry
              WHERE primary_entry.organisation_id = ? AND primary_entry.person_id = ?)
            AND EXISTS (
              SELECT 1 FROM organisation_contacts merged
               WHERE merged.organisation_id = ? AND merged.person_id = ?
                 AND merged.status = 'merged'
                 AND merged.merged_into_person_id = ?
            )`,
      ).bind(
        primaryId,
        viewer.organisationId,
        secondaryId,
        viewer.organisationId,
        primaryId,
        viewer.organisationId,
        secondaryId,
        primaryId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         ) SELECT ?, 'person', 'admin_ui', 1, ?, NULL, ?, 'crm.contacts.merged', 'person', ?,
                  json_object('secondaryPersonId', ?), unixepoch()
            WHERE EXISTS (SELECT 1 FROM organisation_contacts
              WHERE organisation_id = ? AND person_id = ? AND status = 'merged'
                AND merged_into_person_id = ?)`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.personId,
        primaryId,
        secondaryId,
        viewer.organisationId,
        secondaryId,
        primaryId,
      ),
    ]);
    if ((marked.meta.changes ?? 0) !== 1)
      throw new CrmStateError(
        "The contacts changed before they could be merged.",
      );
  }
}
