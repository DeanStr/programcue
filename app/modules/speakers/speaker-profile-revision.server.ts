type ProfileRevisionContext = {
  organisationId: string;
  eventId: string;
  personId: string;
  recordedByPersonId: string;
  correlationId: string;
};

type HeadshotProfileRevisionContext = {
  organisationId: string;
  eventId: string;
  assetId: string;
  headshotFileVersionId: string | null;
  recordedByPersonId: string | null;
  correlationId: string;
  enabled?: boolean;
};

export type SpeakerProfileRevision = {
  id: string;
  source: "canonical_person" | "organisation_profile";
  profileRevision: number;
  displayName: string;
  biography: string | null;
  pronunciation: string | null;
  organisationName: string | null;
  jobTitle: string | null;
  publicationStatus: "draft" | "published" | "archived";
  headshotFileVersionId: string | null;
  recordedByName: string | null;
  createdAt: number;
};

const releasedHeadshotVersionSql = `(SELECT version.id
  FROM file_assets asset
  JOIN file_versions version
    ON version.id = asset.current_version_id
   AND version.event_id = asset.event_id
   AND version.asset_id = asset.id
 WHERE asset.event_id = ? AND asset.target_type = 'person'
   AND asset.target_id = person.id AND asset.asset_kind = 'headshot'
   AND asset.status = 'active' AND version.upload_status = 'uploaded'
   AND version.signature_status = 'valid' AND version.scan_status = 'clean'
   AND version.released_at IS NOT NULL AND version.deleted_at IS NULL
 ORDER BY asset.updated_at DESC, asset.id DESC
 LIMIT 1)`;

export function canonicalProfileRevisionStatement(
  env: CloudflareEnvironment,
  context: ProfileRevisionContext,
) {
  return env.DB.prepare(
    `INSERT INTO speaker_profile_revisions (
       id, organisation_id, event_id, person_id, source, profile_revision,
       display_name, biography, pronunciation, organisation_name, job_title,
       publication_status, headshot_file_version_id, recorded_by_person_id,
       correlation_id, created_at
     )
     SELECT ?, ?, ?, person.id, 'canonical_person', person.profile_revision,
            person.display_name, person.biography, person.pronunciation,
            person.organisation_name, person.job_title, person.profile_status,
            ${releasedHeadshotVersionSql}, ?, ?, unixepoch()
       FROM people person
      WHERE person.id = ? AND person.last_operation_id = ?`,
  ).bind(
    crypto.randomUUID(),
    context.organisationId,
    context.eventId,
    context.eventId,
    context.recordedByPersonId,
    context.correlationId,
    context.personId,
    context.correlationId,
  );
}

export function organisationProfileRevisionStatement(
  env: CloudflareEnvironment,
  context: ProfileRevisionContext,
) {
  return env.DB.prepare(
    `INSERT INTO speaker_profile_revisions (
       id, organisation_id, event_id, person_id, source, profile_revision,
       display_name, biography, pronunciation, organisation_name, job_title,
       publication_status, headshot_file_version_id, recorded_by_person_id,
       correlation_id, created_at
     )
     SELECT ?, ?, ?, person.id, 'organisation_profile', person.profile_revision,
            profile.display_name, profile.biography, person.pronunciation,
            profile.organisation_name, profile.job_title, person.profile_status,
            ${releasedHeadshotVersionSql}, ?, ?, unixepoch()
       FROM people person
       JOIN organisation_contact_profiles profile
         ON profile.organisation_id = ? AND profile.person_id = person.id
      WHERE person.id = ? AND profile.last_operation_id = ?`,
  ).bind(
    crypto.randomUUID(),
    context.organisationId,
    context.eventId,
    context.eventId,
    context.recordedByPersonId,
    context.correlationId,
    context.organisationId,
    context.personId,
    context.correlationId,
  );
}

export function headshotProfileRevisionStatement(
  env: CloudflareEnvironment,
  context: HeadshotProfileRevisionContext,
) {
  return env.DB.prepare(
    `INSERT INTO speaker_profile_revisions (
       id, organisation_id, event_id, person_id, source, profile_revision,
       display_name, biography, pronunciation, organisation_name, job_title,
       publication_status, headshot_file_version_id, recorded_by_person_id,
       correlation_id, created_at
     )
     SELECT ?, ?, ?, person.id,
            CASE WHEN profile.person_id IS NULL
              THEN 'canonical_person' ELSE 'organisation_profile' END,
            person.profile_revision,
            COALESCE(profile.display_name, person.display_name),
            COALESCE(profile.biography, person.biography),
            person.pronunciation,
            COALESCE(profile.organisation_name, person.organisation_name),
            COALESCE(profile.job_title, person.job_title),
            person.profile_status, ?, ?, ?, unixepoch()
       FROM file_assets asset
       JOIN events event
         ON event.id = asset.event_id AND event.organisation_id = ?
       JOIN people person
         ON person.id = asset.target_id
       LEFT JOIN organisation_contact_profiles profile
         ON profile.organisation_id = event.organisation_id
        AND profile.person_id = person.id
      WHERE asset.id = ? AND asset.event_id = ?
        AND asset.target_type = 'person' AND asset.asset_kind = 'headshot'
        AND ? = 1
        AND ((? IS NULL AND asset.current_version_id IS NULL)
          OR asset.current_version_id = ?)
     ON CONFLICT(
       source, organisation_id, event_id, person_id, correlation_id
     ) DO NOTHING`,
  ).bind(
    crypto.randomUUID(),
    context.organisationId,
    context.eventId,
    context.headshotFileVersionId,
    context.recordedByPersonId,
    context.correlationId,
    context.organisationId,
    context.assetId,
    context.eventId,
    context.enabled === false ? 0 : 1,
    context.headshotFileVersionId,
    context.headshotFileVersionId,
  );
}

/**
 * D1 batches are atomic on statement failure. Place this immediately after a
 * required headshot revision so an unexpected no-op rejects the whole batch.
 */
export function headshotProfileRevisionGuardStatement(
  env: CloudflareEnvironment,
  context: HeadshotProfileRevisionContext,
) {
  return env.DB.prepare(
    `INSERT INTO speaker_profile_revisions (
       id, organisation_id, event_id, person_id, source, profile_revision,
       display_name, publication_status, correlation_id, created_at
     )
     SELECT ?, ?, ?, 'headshot-profile-revision-guard',
            'missing_required_headshot_revision', 1,
            'Headshot profile revision guard', 'draft', ?, unixepoch()
      WHERE ? = 1
        AND EXISTS (
          SELECT 1
            FROM file_assets expected
            JOIN events event
              ON event.id = expected.event_id AND event.organisation_id = ?
           WHERE expected.id = ? AND expected.event_id = ?
             AND expected.target_type = 'person'
             AND expected.asset_kind = 'headshot'
             AND ((? IS NULL AND expected.current_version_id IS NULL)
               OR expected.current_version_id = ?)
        )
        AND NOT EXISTS (
        SELECT 1
          FROM speaker_profile_revisions revision
          JOIN file_assets asset
            ON asset.id = ? AND asset.event_id = ?
           AND asset.target_type = 'person' AND asset.asset_kind = 'headshot'
           AND asset.target_id = revision.person_id
         WHERE revision.organisation_id = ? AND revision.event_id = ?
           AND revision.correlation_id = ?
           AND ((? IS NULL AND revision.headshot_file_version_id IS NULL)
             OR revision.headshot_file_version_id = ?)
      )`,
  ).bind(
    crypto.randomUUID(),
    context.organisationId,
    context.eventId,
    context.correlationId,
    context.enabled === false ? 0 : 1,
    context.organisationId,
    context.assetId,
    context.eventId,
    context.headshotFileVersionId,
    context.headshotFileVersionId,
    context.assetId,
    context.eventId,
    context.organisationId,
    context.eventId,
    context.correlationId,
    context.headshotFileVersionId,
    context.headshotFileVersionId,
  );
}

export async function readSpeakerProfileHistory(
  env: CloudflareEnvironment,
  scope: { organisationId: string; eventId: string; personId: string },
) {
  const rows = await env.DB.prepare(
    `SELECT revision.id, revision.source,
            revision.profile_revision AS profileRevision,
            revision.display_name AS displayName, revision.biography,
            revision.pronunciation,
            revision.organisation_name AS organisationName,
            revision.job_title AS jobTitle,
            revision.publication_status AS publicationStatus,
            revision.headshot_file_version_id AS headshotFileVersionId,
            recorder.display_name AS recordedByName,
            revision.created_at AS createdAt
       FROM speaker_profile_revisions revision
       LEFT JOIN people recorder ON recorder.id = revision.recorded_by_person_id
      WHERE revision.organisation_id = ? AND revision.event_id = ?
        AND revision.person_id = ?
      ORDER BY revision.created_at DESC, revision.id DESC
      LIMIT 50`,
  )
    .bind(scope.organisationId, scope.eventId, scope.personId)
    .all<SpeakerProfileRevision>();
  return rows.results;
}
