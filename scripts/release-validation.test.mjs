import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { validateReleaseStateEvidence } from "./validate-release-state.mjs";
import {
  lastImmutableMigrationName,
  publicSiteMigrationName,
  publicSiteProgrammeMembershipGuardMigrationName,
  publicSiteRelationshipGuardMigrationName,
  publicSpeakerConfirmationGuardMigrationName,
  requiredBrandAssetColumns,
  requiredBrandSchemaObjects,
  requiredFeaturedSpeakerRelationshipObjects,
  requiredPublicSiteColumns,
  requiredPublicSiteForeignKeys,
  requiredPublicSiteSchemaObjects,
  requiredReviewerAiReviewColumns,
  requiredReviewerAiSchemaObjects,
  requiredReviewerAiSuggestionColumns,
  requiredSpeakerRelationshipIdentityObjects,
  reviewerAiMigrationName,
  speakerRelationshipIdentityGuardMigrationName,
  validateRemoteSchemaEvidence,
} from "./validate-remote-schema.mjs";
import { validateProductionHealth } from "./verify-production-health.mjs";

const migrations = [
  "0032_decision_draft_preview_contract.sql",
  "0032_event_brand_asset_normalization.sql",
  "0033_decision_draft_session_format.sql",
  "0034_reviewer_ai_suggestions.sql",
  reviewerAiMigrationName,
  publicSiteMigrationName,
];
const relationshipGuardMigrations = [
  ...migrations,
  publicSiteRelationshipGuardMigrationName,
];
const programmeMembershipGuardMigrations = [
  ...relationshipGuardMigrations,
  publicSiteProgrammeMembershipGuardMigrationName,
];
const publicSpeakerConfirmationGuardMigrations = [
  ...programmeMembershipGuardMigrations,
  publicSpeakerConfirmationGuardMigrationName,
];
const speakerRelationshipIdentityGuardMigrations = [
  ...publicSpeakerConfirmationGuardMigrations,
  speakerRelationshipIdentityGuardMigrationName,
];
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function columnEvidence(requiredColumns, tableName) {
  return [...requiredColumns].map(
    ([name, { type, notnull, defaultValue, pk }], cid) => ({
      cid,
      name,
      type,
      notnull,
      dflt_value: defaultValue,
      pk: pk ?? 0,
      ...(tableName ? { tableName } : {}),
    }),
  );
}

function foreignKeyEvidence() {
  const nextId = new Map();
  return requiredPublicSiteForeignKeys.flatMap(
    ({ tableName, targetTable, columns, onDelete }) => {
      const id = nextId.get(tableName) ?? 0;
      nextId.set(tableName, id + 1);
      return columns.map(([from, to], seq) => ({
        tableName,
        id,
        seq,
        table: targetTable,
        from,
        to,
        on_delete: onDelete,
      }));
    },
  );
}

function remoteEvidence(appliedMigrations = migrations) {
  return [
    {
      success: true,
      results: appliedMigrations.map((name) => ({ name })),
    },
    {
      success: true,
      results: columnEvidence(requiredBrandAssetColumns),
    },
    {
      success: true,
      results: [
        ...[...requiredBrandSchemaObjects].map(([name, type]) => ({
          name,
          type,
          sql: null,
        })),
        ...[...requiredReviewerAiSchemaObjects].map(([name, type]) => ({
          name,
          type,
          sql:
            name === "idx_reviewer_ai_operations_assignment_usage"
              ? "CREATE INDEX idx_reviewer_ai_operations_assignment_usage ON operation_jobs(event_id, json_extract(payload_json, '$.assignmentId'), created_at DESC)"
              : `CREATE ${type} ${name}`,
        })),
        ...[...requiredPublicSiteSchemaObjects].map(([name, type]) => ({
          name,
          type,
          sql:
            name === "idx_event_site_sponsors_order"
              ? "CREATE INDEX idx_event_site_sponsors_order ON event_site_sponsors(event_id, tier, position, name, id)"
              : name === "idx_event_session_recordings_public"
                ? "CREATE INDEX idx_event_session_recordings_public ON event_session_recordings(event_id, published_at, session_id) WHERE published_at IS NOT NULL"
                : name ===
                    "prevent_referenced_public_session_eligibility_change"
                  ? appliedMigrations.includes(
                      publicSpeakerConfirmationGuardMigrationName,
                    )
                    ? "CREATE TRIGGER prevent_referenced_public_session_eligibility_change BEFORE UPDATE OF status, visibility ON sessions WHEN NEW.status <> 'published' OR NEW.visibility <> 'public' AND EXISTS (SELECT 1 FROM event_public_site_references reference WHERE reference.kind = 'session' OR reference.kind = 'speaker' AND relation.visibility = 'public' AND profile_status = 'published' AND participation_status = 'confirmed' AND session_id <> OLD.id) OR EXISTS (SELECT 1 FROM event_session_recordings recording WHERE recording.published_at IS NOT NULL) BEGIN SELECT 1; END"
                    : appliedMigrations.includes(
                          publicSiteProgrammeMembershipGuardMigrationName,
                        )
                      ? "CREATE TRIGGER prevent_referenced_public_session_eligibility_change BEFORE UPDATE OF status, visibility ON sessions WHEN NEW.status <> 'published' OR NEW.visibility <> 'public' AND EXISTS (SELECT 1 FROM event_public_site_references reference WHERE reference.kind = 'session' OR reference.kind = 'speaker' AND relation.visibility = 'public' AND profile_status = 'published' AND session_id <> OLD.id) OR EXISTS (SELECT 1 FROM event_session_recordings recording WHERE recording.published_at IS NOT NULL) BEGIN SELECT 1; END"
                      : "CREATE TRIGGER prevent_referenced_public_session_eligibility_change BEFORE UPDATE OF status, visibility ON sessions WHEN NEW.status <> 'published' OR NEW.visibility <> 'public' AND EXISTS (SELECT 1 FROM event_public_site_references reference WHERE reference.kind = 'session' OR reference.kind = 'speaker' AND participation_status = 'confirmed' AND content_status = 'approved') OR EXISTS (SELECT 1 FROM event_session_recordings recording WHERE recording.published_at IS NOT NULL) BEGIN SELECT 1; END"
                  : "CREATE TRIGGER prevent_referenced_public_speaker_profile_demotion BEFORE UPDATE OF profile_status ON people WHEN OLD.profile_status = 'published' AND NEW.profile_status <> 'published' AND reference.kind = 'speaker' AND EXISTS (SELECT 1 FROM event_public_site_references) BEGIN SELECT 1; END",
        })),
        ...[...requiredFeaturedSpeakerRelationshipObjects].map(
          ([name, type]) => ({
            name,
            type,
            sql:
              name ===
              "prevent_referenced_public_speaker_relationship_visibility_change"
                ? appliedMigrations.includes(
                    publicSpeakerConfirmationGuardMigrationName,
                  )
                  ? "CREATE TRIGGER prevent_referenced_public_speaker_relationship_visibility_change BEFORE UPDATE OF visibility, participation_status ON session_speakers WHEN OLD.visibility = 'public' AND OLD.participation_status = 'confirmed' AND (NEW.visibility <> 'public' OR NEW.participation_status <> 'confirmed') AND EXISTS (SELECT 1 FROM event_public_site_references reference WHERE reference.kind = 'speaker') AND alternative_relation.participation_status = 'confirmed' AND session_id <> OLD.session_id BEGIN SELECT RAISE(ABORT, 'Remove this featured speaker from published event sites before hiding, unconfirming, or removing their final public confirmed session relationship'); END"
                  : "CREATE TRIGGER prevent_referenced_public_speaker_relationship_visibility_change BEFORE UPDATE OF visibility ON session_speakers WHEN OLD.visibility = 'public' AND NEW.visibility <> 'public' AND EXISTS (SELECT 1 FROM event_public_site_references reference WHERE reference.kind = 'speaker') AND session_id <> OLD.session_id BEGIN SELECT RAISE(ABORT, 'Remove this featured speaker from published event sites before hiding or removing their final public session relationship'); END"
                : appliedMigrations.includes(
                      publicSpeakerConfirmationGuardMigrationName,
                    )
                  ? "CREATE TRIGGER prevent_referenced_public_speaker_relationship_delete BEFORE DELETE ON session_speakers WHEN OLD.visibility = 'public' AND OLD.participation_status = 'confirmed' AND EXISTS (SELECT 1 FROM event_public_site_references reference WHERE reference.kind = 'speaker') AND alternative_relation.participation_status = 'confirmed' AND session_id <> OLD.session_id BEGIN SELECT RAISE(ABORT, 'Remove this featured speaker from published event sites before hiding, unconfirming, or removing their final public confirmed session relationship'); END"
                  : "CREATE TRIGGER prevent_referenced_public_speaker_relationship_delete BEFORE DELETE ON session_speakers WHEN OLD.visibility = 'public' AND EXISTS (SELECT 1 FROM event_public_site_references reference WHERE reference.kind = 'speaker') AND session_id <> OLD.session_id BEGIN SELECT RAISE(ABORT, 'Remove this featured speaker from published event sites before hiding or removing their final public session relationship'); END",
          }),
        ),
        ...(appliedMigrations.includes(
          speakerRelationshipIdentityGuardMigrationName,
        )
          ? [...requiredSpeakerRelationshipIdentityObjects].map(
              ([name, type]) => ({
                name,
                type,
                sql: "CREATE TRIGGER session_speakers_identity_immutable BEFORE UPDATE OF event_id, session_id, person_id ON session_speakers WHEN NEW.event_id <> OLD.event_id OR NEW.session_id <> OLD.session_id OR (NEW.person_id <> OLD.person_id AND NOT (NEW.person_id LIKE 'retained-participant-%' AND retained.id = NEW.person_id AND profile_status = 'archived' AND retained.last_operation_id = event.last_operation_id AND event.id = OLD.event_id AND participant_retention_completed_at IS NULL AND NOT EXISTS (SELECT 1 FROM event_public_site_references reference WHERE reference.event_id = OLD.event_id AND reference.kind = 'speaker' AND reference.record_id = OLD.person_id))) BEGIN SELECT RAISE(ABORT, 'Session speaker relationship identity is immutable'); END",
              }),
            )
          : []),
      ],
    },
    { success: true, results: columnEvidence(requiredReviewerAiReviewColumns) },
    { success: true, results: columnEvidence(requiredReviewerAiReviewColumns) },
    {
      success: true,
      results: columnEvidence(requiredReviewerAiSuggestionColumns),
    },
    { success: true, results: [{ quick_check: "ok" }] },
    { success: true, results: [] },
    {
      success: true,
      results: [...requiredPublicSiteColumns].flatMap(([tableName, columns]) =>
        columnEvidence(columns, tableName),
      ),
    },
    {
      success: true,
      results: foreignKeyEvidence(),
    },
    { success: true, results: [{ invalidCount: 0 }] },
  ];
}

test("remote schema validation requires the exact migration ledger and deployed schema contracts", () => {
  assert.deepEqual(validateRemoteSchemaEvidence(remoteEvidence(), migrations), {
    migrationCount: 6,
    pendingMigrationCount: 0,
    brandingColumnCount: 7,
    brandingObjectCount: 11,
    reviewerAiColumnCount: 12,
    reviewerAiObjectCount: 14,
    publicSiteColumnCount: 28,
    publicSiteObjectCount: 4,
    publicSiteForeignKeyCount: 9,
  });

  const pendingEvidence = remoteEvidence(migrations.slice(0, 2));
  assert.deepEqual(
    validateRemoteSchemaEvidence(pendingEvidence, migrations, {
      allowPendingMigrations: true,
    }),
    {
      migrationCount: 2,
      pendingMigrationCount: 4,
      brandingColumnCount: 7,
      brandingObjectCount: 11,
      reviewerAiColumnCount: 0,
      reviewerAiObjectCount: 0,
      publicSiteColumnCount: 0,
      publicSiteObjectCount: 0,
      publicSiteForeignKeyCount: 0,
    },
  );
  const sharedReviewerAiBaseline = remoteEvidence(migrations.slice(0, 4));
  assert.deepEqual(
    validateRemoteSchemaEvidence(sharedReviewerAiBaseline, migrations, {
      allowPendingMigrations: true,
    }),
    {
      migrationCount: 4,
      pendingMigrationCount: 2,
      brandingColumnCount: 7,
      brandingObjectCount: 11,
      reviewerAiColumnCount: 0,
      reviewerAiObjectCount: 0,
      publicSiteColumnCount: 0,
      publicSiteObjectCount: 0,
      publicSiteForeignKeyCount: 0,
    },
  );
  const reorderedLedger = remoteEvidence();
  reorderedLedger[0].results.reverse();
  assert.throws(
    () =>
      validateRemoteSchemaEvidence(reorderedLedger, migrations, {
        allowPendingMigrations: true,
      }),
    /ledger does not match this release/u,
  );

  const missingMigration = remoteEvidence(migrations.slice(0, 2));
  missingMigration[0].results.pop();
  assert.throws(
    () =>
      validateRemoteSchemaEvidence(missingMigration, migrations, {
        allowPendingMigrations: true,
      }),
    /missing: 0032_event_brand_asset_normalization\.sql/u,
  );

  assert.equal(lastImmutableMigrationName, migrations[1]);

  const missingTrigger = remoteEvidence();
  missingTrigger[2].results = missingTrigger[2].results.filter(
    ({ name }) => name !== "events_retire_unreferenced_brand_assets",
  );
  assert.throws(
    () => validateRemoteSchemaEvidence(missingTrigger, migrations),
    /missing required trigger events_retire_unreferenced_brand_assets/u,
  );

  const missingReviewerTrigger = remoteEvidence();
  missingReviewerTrigger[2].results = missingReviewerTrigger[2].results.filter(
    ({ name }) => name !== "reviewer_ai_suggestions_import_requires_review",
  );
  assert.throws(
    () => validateRemoteSchemaEvidence(missingReviewerTrigger, migrations),
    /missing required trigger reviewer_ai_suggestions_import_requires_review/u,
  );

  const missingPublicSiteTrigger = remoteEvidence();
  missingPublicSiteTrigger[2].results =
    missingPublicSiteTrigger[2].results.filter(
      ({ name }) =>
        name !== "prevent_referenced_public_session_eligibility_change",
    );
  assert.throws(
    () => validateRemoteSchemaEvidence(missingPublicSiteTrigger, migrations),
    /missing required trigger prevent_referenced_public_session_eligibility_change/u,
  );

  const stalePublicSiteTrigger = remoteEvidence();
  stalePublicSiteTrigger[2].results.find(
    ({ name }) =>
      name === "prevent_referenced_public_session_eligibility_change",
  ).sql =
    "CREATE TRIGGER prevent_referenced_public_session_eligibility_change BEFORE UPDATE ON sessions BEGIN SELECT 1; END";
  assert.throws(
    () => validateRemoteSchemaEvidence(stalePublicSiteTrigger, migrations),
    /public-session eligibility trigger has the wrong protection contract/u,
  );

  assert.deepEqual(
    validateRemoteSchemaEvidence(
      remoteEvidence(relationshipGuardMigrations),
      relationshipGuardMigrations,
    ),
    {
      migrationCount: 7,
      pendingMigrationCount: 0,
      brandingColumnCount: 7,
      brandingObjectCount: 11,
      reviewerAiColumnCount: 12,
      reviewerAiObjectCount: 14,
      publicSiteColumnCount: 28,
      publicSiteObjectCount: 6,
      publicSiteForeignKeyCount: 9,
    },
  );

  const missingRelationshipTrigger = remoteEvidence(
    relationshipGuardMigrations,
  );
  missingRelationshipTrigger[2].results =
    missingRelationshipTrigger[2].results.filter(
      ({ name }) =>
        name !== "prevent_referenced_public_speaker_relationship_delete",
    );
  assert.throws(
    () =>
      validateRemoteSchemaEvidence(
        missingRelationshipTrigger,
        relationshipGuardMigrations,
      ),
    /missing required trigger prevent_referenced_public_speaker_relationship_delete/u,
  );

  const staleRelationshipTrigger = remoteEvidence(relationshipGuardMigrations);
  staleRelationshipTrigger[2].results.find(
    ({ name }) =>
      name ===
      "prevent_referenced_public_speaker_relationship_visibility_change",
  ).sql =
    "CREATE TRIGGER prevent_referenced_public_speaker_relationship_visibility_change BEFORE UPDATE ON session_speakers BEGIN SELECT 1; END";
  assert.throws(
    () =>
      validateRemoteSchemaEvidence(
        staleRelationshipTrigger,
        relationshipGuardMigrations,
      ),
    /featured-speaker relationship visibility trigger has the wrong protection contract/u,
  );

  assert.deepEqual(
    validateRemoteSchemaEvidence(
      remoteEvidence(programmeMembershipGuardMigrations),
      programmeMembershipGuardMigrations,
    ),
    {
      migrationCount: 8,
      pendingMigrationCount: 0,
      brandingColumnCount: 7,
      brandingObjectCount: 11,
      reviewerAiColumnCount: 12,
      reviewerAiObjectCount: 14,
      publicSiteColumnCount: 28,
      publicSiteObjectCount: 6,
      publicSiteForeignKeyCount: 9,
    },
  );

  const staleAlignedSessionTrigger = remoteEvidence(
    programmeMembershipGuardMigrations,
  );
  staleAlignedSessionTrigger[2].results.find(
    ({ name }) =>
      name === "prevent_referenced_public_session_eligibility_change",
  ).sql =
    "CREATE TRIGGER prevent_referenced_public_session_eligibility_change BEFORE UPDATE OF status, visibility ON sessions WHEN NEW.status <> 'published' OR NEW.visibility <> 'public' AND EXISTS (SELECT 1 FROM event_public_site_references reference WHERE reference.kind = 'session' OR reference.kind = 'speaker' AND participation_status = 'confirmed' AND content_status = 'approved') OR EXISTS (SELECT 1 FROM event_session_recordings recording WHERE recording.published_at IS NOT NULL) BEGIN SELECT 1; END";
  assert.throws(
    () =>
      validateRemoteSchemaEvidence(
        staleAlignedSessionTrigger,
        programmeMembershipGuardMigrations,
      ),
    /public-session eligibility trigger has the wrong protection contract/u,
  );

  assert.deepEqual(
    validateRemoteSchemaEvidence(
      remoteEvidence(publicSpeakerConfirmationGuardMigrations),
      publicSpeakerConfirmationGuardMigrations,
    ),
    {
      migrationCount: 9,
      pendingMigrationCount: 0,
      brandingColumnCount: 7,
      brandingObjectCount: 11,
      reviewerAiColumnCount: 12,
      reviewerAiObjectCount: 14,
      publicSiteColumnCount: 28,
      publicSiteObjectCount: 6,
      publicSiteForeignKeyCount: 9,
    },
  );

  const staleConfirmedSpeakerTrigger = remoteEvidence(
    publicSpeakerConfirmationGuardMigrations,
  );
  staleConfirmedSpeakerTrigger[2].results.find(
    ({ name }) =>
      name ===
      "prevent_referenced_public_speaker_relationship_visibility_change",
  ).sql =
    "CREATE TRIGGER prevent_referenced_public_speaker_relationship_visibility_change BEFORE UPDATE OF visibility ON session_speakers WHEN OLD.visibility = 'public' AND NEW.visibility <> 'public' AND EXISTS (SELECT 1 FROM event_public_site_references reference WHERE reference.kind = 'speaker') AND session_id <> OLD.session_id BEGIN SELECT RAISE(ABORT, 'Remove this featured speaker from published event sites before hiding or removing their final public session relationship'); END";
  assert.throws(
    () =>
      validateRemoteSchemaEvidence(
        staleConfirmedSpeakerTrigger,
        publicSpeakerConfirmationGuardMigrations,
      ),
    /featured-speaker relationship visibility trigger has the wrong protection contract/u,
  );

  assert.deepEqual(
    validateRemoteSchemaEvidence(
      remoteEvidence(speakerRelationshipIdentityGuardMigrations),
      speakerRelationshipIdentityGuardMigrations,
    ),
    {
      migrationCount: 10,
      pendingMigrationCount: 0,
      brandingColumnCount: 7,
      brandingObjectCount: 11,
      reviewerAiColumnCount: 12,
      reviewerAiObjectCount: 14,
      publicSiteColumnCount: 28,
      publicSiteObjectCount: 6,
      publicSiteForeignKeyCount: 9,
    },
  );

  const missingIdentityTrigger = remoteEvidence(
    speakerRelationshipIdentityGuardMigrations,
  );
  missingIdentityTrigger[2].results = missingIdentityTrigger[2].results.filter(
    ({ name }) => name !== "session_speakers_identity_immutable",
  );
  assert.throws(
    () =>
      validateRemoteSchemaEvidence(
        missingIdentityTrigger,
        speakerRelationshipIdentityGuardMigrations,
      ),
    /missing required trigger session_speakers_identity_immutable/u,
  );

  const staleIdentityTrigger = remoteEvidence(
    speakerRelationshipIdentityGuardMigrations,
  );
  staleIdentityTrigger[2].results.find(
    ({ name }) => name === "session_speakers_identity_immutable",
  ).sql =
    "CREATE TRIGGER session_speakers_identity_immutable BEFORE UPDATE OF visibility ON session_speakers BEGIN SELECT 1; END";
  assert.throws(
    () =>
      validateRemoteSchemaEvidence(
        staleIdentityTrigger,
        speakerRelationshipIdentityGuardMigrations,
      ),
    /session-speaker identity trigger has the wrong protection contract/u,
  );

  const invertedFeaturedIdentityTrigger = remoteEvidence(
    speakerRelationshipIdentityGuardMigrations,
  );
  invertedFeaturedIdentityTrigger[2].results.find(
    ({ name }) => name === "session_speakers_identity_immutable",
  ).sql =
    "CREATE TRIGGER session_speakers_identity_immutable BEFORE UPDATE OF event_id, session_id, person_id ON session_speakers WHEN NEW.event_id <> OLD.event_id OR NEW.session_id <> OLD.session_id OR NOT (NEW.person_id LIKE 'retained-participant-%' AND profile_status = 'archived' AND participant_retention_completed_at IS NULL AND EXISTS (SELECT 1 FROM event_public_site_references reference WHERE reference.kind = 'speaker')) BEGIN SELECT RAISE(ABORT, 'Session speaker relationship identity is immutable'); END";
  assert.throws(
    () =>
      validateRemoteSchemaEvidence(
        invertedFeaturedIdentityTrigger,
        speakerRelationshipIdentityGuardMigrations,
      ),
    /session-speaker identity trigger has the wrong protection contract/u,
  );

  const unscopedIdentityTrigger = remoteEvidence(
    speakerRelationshipIdentityGuardMigrations,
  );
  unscopedIdentityTrigger[2].results.find(
    ({ name }) => name === "session_speakers_identity_immutable",
  ).sql =
    "CREATE TRIGGER session_speakers_identity_immutable BEFORE UPDATE OF event_id, session_id, person_id ON session_speakers WHEN NEW.event_id <> OLD.event_id OR NEW.session_id <> OLD.session_id OR (NEW.person_id <> OLD.person_id AND NOT (NEW.person_id LIKE 'retained-participant-%' AND profile_status = 'archived' AND retained.last_operation_id = event.last_operation_id AND participant_retention_completed_at IS NULL AND NOT EXISTS (SELECT 1 FROM event_public_site_references reference WHERE reference.kind = 'speaker' AND reference.record_id = OLD.person_id))) BEGIN SELECT RAISE(ABORT, 'Session speaker relationship identity is immutable'); END";
  assert.throws(
    () =>
      validateRemoteSchemaEvidence(
        unscopedIdentityTrigger,
        speakerRelationshipIdentityGuardMigrations,
      ),
    /session-speaker identity trigger has the wrong protection contract/u,
  );

  const invalidPublicSiteColumn = remoteEvidence();
  invalidPublicSiteColumn[8].results.find(
    ({ tableName, name }) =>
      tableName === "event_session_recordings" && name === "published_at",
  ).type = "TEXT";
  assert.throws(
    () => validateRemoteSchemaEvidence(invalidPublicSiteColumn, migrations),
    /event_session_recordings\.published_at is missing or has the wrong contract/u,
  );

  const missingPublicSiteForeignKey = remoteEvidence();
  missingPublicSiteForeignKey[9].results =
    missingPublicSiteForeignKey[9].results.filter(
      ({ tableName, table }) =>
        !(tableName === "event_session_recordings" && table === "sessions"),
    );
  assert.throws(
    () => validateRemoteSchemaEvidence(missingPublicSiteForeignKey, migrations),
    /event_session_recordings is missing its required foreign key \(session_id, event_id\)/u,
  );

  const splitCompositePublicSiteForeignKey = remoteEvidence();
  const splitComponent = splitCompositePublicSiteForeignKey[9].results.find(
    ({ tableName, table, from }) =>
      tableName === "event_session_recordings" &&
      table === "sessions" &&
      from === "event_id",
  );
  splitComponent.id += 100;
  splitComponent.seq = 0;
  assert.throws(
    () =>
      validateRemoteSchemaEvidence(
        splitCompositePublicSiteForeignKey,
        migrations,
      ),
    /event_session_recordings is missing its required foreign key \(session_id, event_id\)/u,
  );

  const invalidManagedEmbedTheme = remoteEvidence();
  invalidManagedEmbedTheme[10].results[0].invalidCount = 1;
  assert.throws(
    () => validateRemoteSchemaEvidence(invalidManagedEmbedTheme, migrations),
    /managed programme embeds retain a missing or invalid theme/u,
  );

  const legacyReviewerRelation = remoteEvidence();
  legacyReviewerRelation[5].results.push({
    cid: 99,
    name: "imported_review_id",
    type: "TEXT",
    notnull: 0,
    dflt_value: null,
    pk: 0,
  });
  assert.throws(
    () => validateRemoteSchemaEvidence(legacyReviewerRelation, migrations),
    /retains redundant imported_review_id/u,
  );

  const staleUsageIndex = remoteEvidence();
  staleUsageIndex[2].results.find(
    ({ name }) => name === "idx_reviewer_ai_operations_assignment_usage",
  ).sql =
    "CREATE INDEX idx_reviewer_ai_operations_assignment_usage ON operation_jobs(event_id, json_extract(payload_json, '$.assignmentId'))";
  assert.throws(
    () => validateRemoteSchemaEvidence(staleUsageIndex, migrations),
    /assignment usage index does not cover the rolling window/u,
  );

  const invalidCleanupColumn = remoteEvidence();
  invalidCleanupColumn[1].results.find(
    ({ name }) => name === "cleanup_attempts",
  ).notnull = 0;
  assert.throws(
    () => validateRemoteSchemaEvidence(invalidCleanupColumn, migrations),
    /cleanup_attempts is missing or has the wrong contract/u,
  );

  const foreignKeyFailure = remoteEvidence();
  foreignKeyFailure[7].results.push({ table: "events", rowid: 1 });
  assert.throws(
    () => validateRemoteSchemaEvidence(foreignKeyFailure, migrations),
    /foreign_key_check returned violations/u,
  );
});

test("confirmed public-speaker migration fails closed and invalidates pending public membership", async () => {
  const migration = await readFile(
    resolve(
      repositoryRoot,
      "migrations",
      publicSpeakerConfirmationGuardMigrationName,
    ),
    "utf8",
  );
  assert.match(
    migration,
    /CREATE TABLE migration_0042_featured_speaker_guard/u,
  );
  assert.match(
    migration,
    /published_featured_speakers_must_be_confirmed INTEGER NOT NULL/u,
  );
  assert.match(
    migration,
    /INSERT INTO event_changes[\s\S]*migration-0042-public-speaker-eligibility[\s\S]*participation_status = 'pending'/u,
  );
  assert.doesNotMatch(migration, /^SELECT RAISE\(/mu);
});

test("session-speaker identity migration makes relationship identity immutable", async () => {
  const migration = await readFile(
    resolve(
      repositoryRoot,
      "migrations",
      speakerRelationshipIdentityGuardMigrationName,
    ),
    "utf8",
  );
  assert.match(
    migration,
    /CREATE TRIGGER session_speakers_identity_immutable/u,
  );
  assert.match(
    migration,
    /BEFORE UPDATE OF event_id, session_id, person_id ON session_speakers/u,
  );
  assert.match(migration, /NEW\.person_id <> OLD\.person_id/u);
  assert.match(migration, /NEW\.person_id LIKE 'retained-participant-%'/u);
  assert.match(migration, /retained\.id = NEW\.person_id/u);
  assert.match(
    migration,
    /retained\.last_operation_id = event\.last_operation_id/u,
  );
  assert.match(migration, /event\.id = OLD\.event_id/u);
  assert.match(migration, /participant_retention_completed_at IS NULL/u);
  assert.match(
    migration,
    /NOT EXISTS \(\s*SELECT 1 FROM event_public_site_references reference/u,
  );
  assert.match(migration, /reference\.event_id = OLD\.event_id/u);
  assert.match(migration, /reference\.record_id = OLD\.person_id/u);
  assert.match(
    migration,
    /Session speaker relationship identity is immutable/u,
  );
  assert.doesNotMatch(migration, /^SELECT RAISE\(/mu);
});

test("release state permits only the clean tested checkout", () => {
  const valid = {
    headRevision: "3907860a49f16b7245219083efd0acb71da4ae88",
    workflowRevision: "3907860a49f16b7245219083efd0acb71da4ae88",
    worktreeStatus: "",
  };
  assert.deepEqual(validateReleaseStateEvidence(valid), []);
  assert.deepEqual(
    validateReleaseStateEvidence({
      ...valid,
      worktreeStatus: " M app/root.tsx",
    }),
    ["The release checkout contains uncommitted or untracked files."],
  );
  assert.deepEqual(
    validateReleaseStateEvidence({
      ...valid,
      workflowRevision: "2cf56fc2f0bf9fd6f7466ce2bca99a4dec7bb14f",
    }),
    ["The release checkout does not match the workflow commit."],
  );
  assert.deepEqual(
    validateReleaseStateEvidence({
      ...valid,
      headRevision: "not-a-revision",
      workflowRevision: "",
    }),
    ["The release checkout HEAD is not a full Git revision."],
  );
});

test("production smoke validation requires the exact deployed source", () => {
  const health = {
    ok: true,
    service: "program-cue",
    environment: "production",
    sourceRevision: "2cf56fc",
  };
  assert.doesNotThrow(() => validateProductionHealth(health, "2cf56fc"));
  assert.throws(
    () => validateProductionHealth(health, "d4edbe0"),
    /did not report the deployed Program Cue source revision/u,
  );
});

test("repository release commands and workflows enforce the ordered gates", async () => {
  const packageJson = JSON.parse(
    await readFile(resolve(repositoryRoot, "package.json"), "utf8"),
  );
  assert.equal(
    packageJson.scripts.deploy,
    "npm run check && npm run deploy:preflight && npm run db:migrate:remote && npm run deploy:cutover && npm run deploy:smoke",
  );
  assert.match(
    packageJson.scripts["deploy:preflight"],
    /deploy:check.*deploy:state.*deploy:secrets.*deploy:ledger/u,
  );
  assert.match(
    packageJson.scripts["deploy:cutover"],
    /deploy:schema.*deploy-production\.mjs/u,
  );
  assert.doesNotMatch(packageJson.scripts["deploy:cutover"], /npm run build/u);
  assert.equal(packageJson.engines.node, ">=24.11.0");

  const coreWorkflow = await readFile(
    resolve(repositoryRoot, ".github/workflows/ci.yml"),
    "utf8",
  );
  assert.match(coreWorkflow, /pull_request:/u);
  assert.match(coreWorkflow, /npm run check:core/u);
  assert.match(coreWorkflow, /dependency-audit:/u);
  assert.match(coreWorkflow, /run: npm run security:dependencies/u);
  const coreWorkflowConfig = parseYaml(coreWorkflow);
  for (const jobName of ["dependency-audit", "core", "browser"]) {
    const setupNode = coreWorkflowConfig.jobs[jobName].steps.find(
      (step) =>
        typeof step.uses === "string" &&
        step.uses.startsWith("actions/setup-node@"),
    );
    assert.equal(setupNode?.with?.["node-version"], "24.11.0");
  }

  const browserSteps = coreWorkflowConfig.jobs.browser.steps;
  const browserGate = browserSteps.find(
    (step) => step.run === "npm run check:browser:pr",
  );
  assert.deepEqual(browserGate?.env, { PROGRAM_CUE_E2E_SHARDS: "1" });

  const browserDiagnostics = browserSteps.find(
    (step) =>
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/upload-artifact@"),
  );
  assert.equal(
    browserDiagnostics?.uses,
    "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
  );
  assert.equal(browserDiagnostics?.if, `\${{ failure() }}`);
  assert.deepEqual(browserDiagnostics?.with?.path.trim().split(/\s+/u), [
    "test-results/",
    "playwright-report/",
    "~/.config/.wrangler/logs/",
  ]);
  assert.equal(browserDiagnostics?.with?.["if-no-files-found"], "warn");
  assert.equal(browserDiagnostics?.with?.["include-hidden-files"], true);
  assert.equal(browserDiagnostics?.with?.["retention-days"], 7);

  const checkRunner = await readFile(
    resolve(repositoryRoot, "scripts/run-checks.mjs"),
    "utf8",
  );
  assert.match(
    checkRunner,
    /if \(mode === "--full"\)[\s\S]*\["run", "security:dependencies"\]/u,
  );

  const releaseWorkflow = await readFile(
    resolve(repositoryRoot, ".github/workflows/release.yml"),
    "utf8",
  );
  const releaseWorkflowConfig = parseYaml(releaseWorkflow);
  const releaseSetupNode = releaseWorkflowConfig.jobs.release.steps.find(
    (step) =>
      typeof step.uses === "string" &&
      step.uses.startsWith("actions/setup-node@"),
  );
  assert.match(releaseWorkflow, /run: npm run deploy/u);
  assert.equal(releaseSetupNode?.with?.["node-version"], "24.11.0");
  assert.doesNotMatch(releaseWorkflow, /npm run deploy:cutover/u);

  const deployProduction = await readFile(
    resolve(repositoryRoot, "scripts/deploy-production.mjs"),
    "utf8",
  );
  assert.match(deployProduction, /SOURCE_REVISION:/u);
  assert.match(deployProduction, /readValidatedReleaseRevision/u);
});
