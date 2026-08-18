import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePackageExecutable } from "./package-executable.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REMOTE_SCHEMA_TIMEOUT_MS = 60_000;
export const lastImmutableMigrationName =
  "0032_event_brand_asset_normalization.sql";
export const reviewerAiMigrationName = "0036_reviewer_ai_hardening.sql";
export const publicSiteMigrationName = "0037_public_event_site.sql";
export const publicSiteRelationshipGuardMigrationName =
  "0039_featured_speaker_relationship_guards.sql";
export const publicSiteProgrammeMembershipGuardMigrationName =
  "0040_align_featured_speaker_session_guard.sql";
export const publicSpeakerConfirmationGuardMigrationName =
  "0042_confirmed_public_speaker_eligibility.sql";
export const speakerRelationshipIdentityGuardMigrationName =
  "0043_session_speaker_identity_immutable.sql";

export const requiredBrandAssetColumns = new Map([
  ["width_px", { type: "INTEGER", notnull: 0, defaultValue: null }],
  ["height_px", { type: "INTEGER", notnull: 0, defaultValue: null }],
  ["normalizer_version", { type: "TEXT", notnull: 0, defaultValue: null }],
  ["normalized_at", { type: "INTEGER", notnull: 0, defaultValue: null }],
  ["cleanup_attempts", { type: "INTEGER", notnull: 1, defaultValue: "0" }],
  [
    "cleanup_last_attempt_at",
    { type: "INTEGER", notnull: 0, defaultValue: null },
  ],
  ["cleanup_last_error", { type: "TEXT", notnull: 0, defaultValue: null }],
]);

export const requiredBrandSchemaObjects = new Map([
  ["idx_event_brand_assets_cleanup", "index"],
  ["event_brand_assets_ready_insert", "trigger"],
  ["event_brand_assets_ready_update", "trigger"],
  ["event_brand_assets_identity_immutable", "trigger"],
  ["event_brand_assets_no_restore", "trigger"],
  ["event_brand_assets_no_retire_while_referenced", "trigger"],
  ["event_brand_assets_no_delete_while_referenced", "trigger"],
  ["events_no_delete_with_brand_assets", "trigger"],
  ["events_brand_assets_ready_insert", "trigger"],
  ["events_brand_assets_ready_update", "trigger"],
  ["events_retire_unreferenced_brand_assets", "trigger"],
]);

export const requiredReviewerAiReviewColumns = new Map([
  ["ai_suggestion_id", { type: "TEXT", notnull: 0, defaultValue: null }],
  [
    "imported_criterion_ids_json",
    { type: "TEXT", notnull: 1, defaultValue: "'[]'" },
  ],
  [
    "confirmed_ai_criterion_ids_json",
    { type: "TEXT", notnull: 1, defaultValue: "'[]'" },
  ],
]);

export const requiredReviewerAiSuggestionColumns = new Map([
  ["event_id", { type: "TEXT", notnull: 1, defaultValue: null }],
  ["assignment_id", { type: "TEXT", notnull: 1, defaultValue: null }],
  ["evaluator_person_id", { type: "TEXT", notnull: 1, defaultValue: null }],
  ["status", { type: "TEXT", notnull: 1, defaultValue: "'offered'" }],
  ["lifecycle_operation_id", { type: "TEXT", notnull: 0, defaultValue: null }],
  ["last_operation_id", { type: "TEXT", notnull: 1, defaultValue: null }],
]);

export const requiredReviewerAiSchemaObjects = new Map([
  ["idx_reviewer_ai_suggestions_assignment", "index"],
  ["ux_reviewer_ai_suggestions_active", "index"],
  ["idx_reviewer_ai_operations_organisation_usage", "index"],
  ["idx_reviewer_ai_operations_assignment_usage", "index"],
  ["reviewer_ai_suggestions_assignment_provenance_insert", "trigger"],
  ["reviewer_ai_suggestions_generated_fields_immutable", "trigger"],
  ["reviewer_ai_suggestions_lifecycle", "trigger"],
  ["reviewer_ai_suggestions_participant_retention_no_pii_insert", "trigger"],
  ["reviews_ai_suggestion_provenance_insert", "trigger"],
  ["reviews_ai_suggestion_provenance_update", "trigger"],
  ["reviewer_ai_suggestions_import_requires_review", "trigger"],
  ["reviewer_ai_suggestions_dismiss_requires_unreferenced", "trigger"],
  ["review_revisions_ai_suggestion_provenance_insert", "trigger"],
  ["review_revisions_ai_suggestion_provenance_update", "trigger"],
]);

export const requiredPublicSiteColumns = new Map([
  [
    "event_public_sites",
    new Map([
      ["event_id", { type: "TEXT", notnull: 0, defaultValue: null, pk: 1 }],
      ["organisation_id", { type: "TEXT", notnull: 1, defaultValue: null }],
      ["draft_json", { type: "TEXT", notnull: 1, defaultValue: null }],
      ["draft_revision", { type: "INTEGER", notnull: 1, defaultValue: "1" }],
      ["published_json", { type: "TEXT", notnull: 0, defaultValue: null }],
      [
        "published_revision",
        { type: "INTEGER", notnull: 0, defaultValue: null },
      ],
      ["published_at", { type: "INTEGER", notnull: 0, defaultValue: null }],
      ["last_operation_id", { type: "TEXT", notnull: 1, defaultValue: null }],
    ]),
  ],
  [
    "event_public_site_references",
    new Map([
      ["event_id", { type: "TEXT", notnull: 1, defaultValue: null, pk: 1 }],
      ["organisation_id", { type: "TEXT", notnull: 1, defaultValue: null }],
      ["kind", { type: "TEXT", notnull: 1, defaultValue: null, pk: 2 }],
      ["record_id", { type: "TEXT", notnull: 1, defaultValue: null, pk: 3 }],
      ["site_revision", { type: "INTEGER", notnull: 1, defaultValue: null }],
    ]),
  ],
  [
    "event_site_sponsors",
    new Map([
      ["id", { type: "TEXT", notnull: 0, defaultValue: null, pk: 1 }],
      ["organisation_id", { type: "TEXT", notnull: 1, defaultValue: null }],
      ["event_id", { type: "TEXT", notnull: 1, defaultValue: null }],
      ["revision", { type: "INTEGER", notnull: 1, defaultValue: "1" }],
      ["last_operation_id", { type: "TEXT", notnull: 1, defaultValue: null }],
    ]),
  ],
  [
    "event_session_recordings",
    new Map([
      ["id", { type: "TEXT", notnull: 0, defaultValue: null, pk: 1 }],
      ["organisation_id", { type: "TEXT", notnull: 1, defaultValue: null }],
      ["event_id", { type: "TEXT", notnull: 1, defaultValue: null }],
      ["session_id", { type: "TEXT", notnull: 1, defaultValue: null }],
      ["draft_revision", { type: "INTEGER", notnull: 1, defaultValue: "1" }],
      ["published_title", { type: "TEXT", notnull: 0, defaultValue: null }],
      [
        "published_recording_url",
        { type: "TEXT", notnull: 0, defaultValue: null },
      ],
      [
        "published_revision",
        { type: "INTEGER", notnull: 0, defaultValue: null },
      ],
      ["published_at", { type: "INTEGER", notnull: 0, defaultValue: null }],
      ["last_operation_id", { type: "TEXT", notnull: 1, defaultValue: null }],
    ]),
  ],
]);

export const requiredPublicSiteSchemaObjects = new Map([
  ["idx_event_site_sponsors_order", "index"],
  ["idx_event_session_recordings_public", "index"],
  ["prevent_referenced_public_session_eligibility_change", "trigger"],
  ["prevent_referenced_public_speaker_profile_demotion", "trigger"],
]);

export const requiredFeaturedSpeakerRelationshipObjects = new Map([
  [
    "prevent_referenced_public_speaker_relationship_visibility_change",
    "trigger",
  ],
  ["prevent_referenced_public_speaker_relationship_delete", "trigger"],
]);

export const requiredSpeakerRelationshipIdentityObjects = new Map([
  ["session_speakers_identity_immutable", "trigger"],
]);

export const requiredPublicSiteForeignKeys = [
  {
    tableName: "event_public_sites",
    targetTable: "events",
    columns: [
      ["event_id", "id"],
      ["organisation_id", "organisation_id"],
    ],
    onDelete: "CASCADE",
  },
  {
    tableName: "event_public_sites",
    targetTable: "people",
    columns: [["last_updated_by_person_id", "id"]],
    onDelete: "NO ACTION",
  },
  {
    tableName: "event_public_site_references",
    targetTable: "events",
    columns: [
      ["event_id", "id"],
      ["organisation_id", "organisation_id"],
    ],
    onDelete: "CASCADE",
  },
  {
    tableName: "event_public_site_references",
    targetTable: "event_public_sites",
    columns: [["event_id", "event_id"]],
    onDelete: "CASCADE",
  },
  {
    tableName: "event_site_sponsors",
    targetTable: "events",
    columns: [
      ["event_id", "id"],
      ["organisation_id", "organisation_id"],
    ],
    onDelete: "CASCADE",
  },
  {
    tableName: "event_site_sponsors",
    targetTable: "people",
    columns: [["last_updated_by_person_id", "id"]],
    onDelete: "NO ACTION",
  },
  {
    tableName: "event_session_recordings",
    targetTable: "events",
    columns: [
      ["event_id", "id"],
      ["organisation_id", "organisation_id"],
    ],
    onDelete: "CASCADE",
  },
  {
    tableName: "event_session_recordings",
    targetTable: "sessions",
    columns: [
      ["session_id", "id"],
      ["event_id", "event_id"],
    ],
    onDelete: "CASCADE",
  },
  {
    tableName: "event_session_recordings",
    targetTable: "people",
    columns: [["last_updated_by_person_id", "id"]],
    onDelete: "NO ACTION",
  },
];

function validateColumns(rows, requiredColumns, tableName) {
  const columns = new Map(rows.map((row) => [row.name, row]));
  for (const [name, expected] of requiredColumns) {
    const column = columns.get(name);
    if (
      !column ||
      column.type !== expected.type ||
      column.notnull !== expected.notnull ||
      column.dflt_value !== expected.defaultValue ||
      (Object.hasOwn(expected, "pk") && column.pk !== expected.pk)
    ) {
      throw new Error(
        `Remote D1 ${tableName}.${name} is missing or has the wrong contract.`,
      );
    }
  }
  return columns;
}

function successfulResults(result, label) {
  if (result?.success !== true || !Array.isArray(result.results)) {
    throw new Error(`Remote D1 ${label} query did not succeed.`);
  }
  return result.results;
}

function sameOrder(actual, expected) {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function wranglerFailureMessage(result) {
  const stderr = result.stderr?.trim();
  if (stderr) return stderr;
  try {
    const parsed = JSON.parse(result.stdout);
    const message = parsed?.error?.text;
    if (typeof message === "string" && message.trim()) return message.trim();
  } catch {
    // The stable failure below is preferable to echoing unstructured output.
  }
  return "Wrangler returned no diagnostic.";
}

export function validateRemoteSchemaEvidence(
  response,
  localMigrationNames,
  { allowPendingMigrations = false } = {},
) {
  if (!Array.isArray(response) || response.length !== 11) {
    throw new Error(
      "Remote D1 schema validation returned an unexpected result set.",
    );
  }
  const appliedMigrationNames = successfulResults(
    response[0],
    "migration ledger",
  ).map((row) => row.name);
  const immutableMigrationCount =
    localMigrationNames.indexOf(lastImmutableMigrationName) + 1;
  if (immutableMigrationCount === 0) {
    throw new Error(
      `Local migrations are missing immutable production migration ${lastImmutableMigrationName}.`,
    );
  }
  const expectedAppliedNames = localMigrationNames.slice(
    0,
    appliedMigrationNames.length,
  );
  if (
    appliedMigrationNames.some((name) => typeof name !== "string") ||
    appliedMigrationNames.length < immutableMigrationCount ||
    !sameOrder(appliedMigrationNames, expectedAppliedNames) ||
    (!allowPendingMigrations &&
      appliedMigrationNames.length !== localMigrationNames.length)
  ) {
    const local = new Set(localMigrationNames);
    const applied = new Set(appliedMigrationNames);
    const missing = localMigrationNames.filter((name) => !applied.has(name));
    const unexpected = appliedMigrationNames.filter((name) => !local.has(name));
    const orderMismatch = !sameOrder(
      appliedMigrationNames,
      expectedAppliedNames,
    );
    throw new Error(
      `Remote D1 migration ledger does not match this release (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}; order mismatch: ${orderMismatch ? "yes" : "no"}).`,
    );
  }

  const quickCheck = successfulResults(response[6], "integrity");
  if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== "ok") {
    throw new Error("Remote D1 quick_check did not return ok.");
  }
  const foreignKeyFailures = successfulResults(
    response[7],
    "foreign-key integrity",
  );
  if (foreignKeyFailures.length > 0) {
    throw new Error("Remote D1 foreign_key_check returned violations.");
  }

  validateColumns(
    successfulResults(response[1], "brand asset columns"),
    requiredBrandAssetColumns,
    "event_brand_assets",
  );

  const objects = new Map(
    successfulResults(response[2], "required schema objects").map((row) => [
      row.name,
      row.type,
    ]),
  );
  for (const [name, type] of requiredBrandSchemaObjects) {
    if (objects.get(name) !== type) {
      throw new Error(`Remote D1 is missing required ${type} ${name}.`);
    }
  }

  const reviewerAiApplied = appliedMigrationNames.includes(
    reviewerAiMigrationName,
  );
  if (reviewerAiApplied) {
    validateColumns(
      successfulResults(response[3], "review AI columns"),
      requiredReviewerAiReviewColumns,
      "reviews",
    );
    validateColumns(
      successfulResults(response[4], "review revision AI columns"),
      requiredReviewerAiReviewColumns,
      "review_revisions",
    );
    const suggestionColumns = validateColumns(
      successfulResults(response[5], "reviewer AI suggestion columns"),
      requiredReviewerAiSuggestionColumns,
      "reviewer_ai_suggestions",
    );
    if (suggestionColumns.has("imported_review_id")) {
      throw new Error(
        "Remote D1 reviewer_ai_suggestions retains redundant imported_review_id.",
      );
    }
    for (const [name, type] of requiredReviewerAiSchemaObjects) {
      if (objects.get(name) !== type) {
        throw new Error(`Remote D1 is missing required ${type} ${name}.`);
      }
    }
    const assignmentUsageIndex = successfulResults(
      response[2],
      "schema objects",
    ).find((row) => row.name === "idx_reviewer_ai_operations_assignment_usage");
    if (
      typeof assignmentUsageIndex?.sql !== "string" ||
      !/created_at\s+DESC/iu.test(assignmentUsageIndex.sql)
    ) {
      throw new Error(
        "Remote D1 reviewer AI assignment usage index does not cover the rolling window.",
      );
    }
  }

  const publicSiteApplied = appliedMigrationNames.includes(
    publicSiteMigrationName,
  );
  const featuredSpeakerRelationshipGuardsApplied =
    appliedMigrationNames.includes(publicSiteRelationshipGuardMigrationName);
  const programmeMembershipGuardsApplied = appliedMigrationNames.includes(
    publicSiteProgrammeMembershipGuardMigrationName,
  );
  const publicSpeakerConfirmationGuardsApplied = appliedMigrationNames.includes(
    publicSpeakerConfirmationGuardMigrationName,
  );
  const speakerRelationshipIdentityGuardsApplied =
    appliedMigrationNames.includes(
      speakerRelationshipIdentityGuardMigrationName,
    );
  if (featuredSpeakerRelationshipGuardsApplied && !publicSiteApplied) {
    throw new Error(
      "Remote D1 applied featured-speaker relationship guards without the public event-site baseline.",
    );
  }
  if (programmeMembershipGuardsApplied && !publicSiteApplied) {
    throw new Error(
      "Remote D1 aligned the featured-speaker session guard without the public event-site baseline.",
    );
  }
  if (
    publicSpeakerConfirmationGuardsApplied &&
    (!featuredSpeakerRelationshipGuardsApplied ||
      !programmeMembershipGuardsApplied)
  ) {
    throw new Error(
      "Remote D1 applied confirmed public-speaker eligibility without the featured-speaker relationship guards.",
    );
  }
  if (publicSiteApplied) {
    const publicSiteColumnRows = successfulResults(
      response[8],
      "public-site columns",
    );
    for (const [tableName, requiredColumns] of requiredPublicSiteColumns) {
      validateColumns(
        publicSiteColumnRows.filter((row) => row.tableName === tableName),
        requiredColumns,
        tableName,
      );
    }
    for (const [name, type] of requiredPublicSiteSchemaObjects) {
      if (objects.get(name) !== type) {
        throw new Error(`Remote D1 is missing required ${type} ${name}.`);
      }
    }
    const objectRows = successfulResults(response[2], "schema objects");
    const sponsorIndex = objectRows.find(
      (row) => row.name === "idx_event_site_sponsors_order",
    );
    if (
      typeof sponsorIndex?.sql !== "string" ||
      !/ON\s+event_site_sponsors\s*\(\s*event_id\s*,\s*tier\s*,\s*position\s*,\s*name\s*,\s*id\s*\)/iu.test(
        sponsorIndex.sql,
      )
    ) {
      throw new Error(
        "Remote D1 public-site sponsor index has the wrong ordering contract.",
      );
    }
    const recordingIndex = objectRows.find(
      (row) => row.name === "idx_event_session_recordings_public",
    );
    if (
      typeof recordingIndex?.sql !== "string" ||
      !/ON\s+event_session_recordings\s*\(\s*event_id\s*,\s*published_at\s*,\s*session_id\s*\)/iu.test(
        recordingIndex.sql,
      ) ||
      !/WHERE\s+published_at\s+IS\s+NOT\s+NULL/iu.test(recordingIndex.sql)
    ) {
      throw new Error(
        "Remote D1 public recording index is missing its published-row predicate.",
      );
    }
    const sessionTrigger = objectRows.find(
      (row) =>
        row.name === "prevent_referenced_public_session_eligibility_change",
    );
    const sessionTriggerSql =
      typeof sessionTrigger?.sql === "string" ? sessionTrigger.sql : "";
    const sessionTriggerHasBaseline =
      /BEFORE\s+UPDATE\s+OF\s+status\s*,\s*visibility\s+ON\s+sessions/iu.test(
        sessionTriggerSql,
      ) &&
      /event_public_site_references/iu.test(sessionTriggerSql) &&
      /event_session_recordings/iu.test(sessionTriggerSql) &&
      /NEW\.status\s*<>\s*'published'/iu.test(sessionTriggerSql) &&
      /NEW\.visibility\s*<>\s*'public'/iu.test(sessionTriggerSql) &&
      /reference\.kind\s*=\s*'session'/iu.test(sessionTriggerSql) &&
      /reference\.kind\s*=\s*'speaker'/iu.test(sessionTriggerSql) &&
      /recording\.published_at\s+IS\s+NOT\s+NULL/iu.test(sessionTriggerSql);
    const sessionTriggerMatchesLiveProgramme =
      publicSpeakerConfirmationGuardsApplied
        ? /session_id\s*<>\s*OLD\.id/iu.test(sessionTriggerSql) &&
          /profile_status\s*=\s*'published'/iu.test(sessionTriggerSql) &&
          /relation\.visibility\s*=\s*'public'/iu.test(sessionTriggerSql) &&
          /participation_status\s*=\s*'confirmed'/iu.test(sessionTriggerSql)
        : programmeMembershipGuardsApplied
          ? /session_id\s*<>\s*OLD\.id/iu.test(sessionTriggerSql) &&
            /profile_status\s*=\s*'published'/iu.test(sessionTriggerSql) &&
            /relation\.visibility\s*=\s*'public'/iu.test(sessionTriggerSql) &&
            !/participation_status\s*=\s*'confirmed'/iu.test(sessionTriggerSql)
          : /participation_status\s*=\s*'confirmed'/iu.test(
              sessionTriggerSql,
            ) && /content_status\s*=\s*'approved'/iu.test(sessionTriggerSql);
    if (!sessionTriggerHasBaseline || !sessionTriggerMatchesLiveProgramme) {
      throw new Error(
        "Remote D1 public-session eligibility trigger has the wrong protection contract.",
      );
    }
    const speakerTrigger = objectRows.find(
      (row) =>
        row.name === "prevent_referenced_public_speaker_profile_demotion",
    );
    if (
      typeof speakerTrigger?.sql !== "string" ||
      !/BEFORE\s+UPDATE\s+OF\s+profile_status\s+ON\s+people/iu.test(
        speakerTrigger.sql,
      ) ||
      !/event_public_site_references/iu.test(speakerTrigger.sql) ||
      !/reference\.kind\s*=\s*'speaker'/iu.test(speakerTrigger.sql) ||
      !/OLD\.profile_status\s*=\s*'published'/iu.test(speakerTrigger.sql) ||
      !/NEW\.profile_status\s*<>\s*'published'/iu.test(speakerTrigger.sql)
    ) {
      throw new Error(
        "Remote D1 featured-speaker profile trigger has the wrong protection contract.",
      );
    }
    if (featuredSpeakerRelationshipGuardsApplied) {
      for (const [name, type] of requiredFeaturedSpeakerRelationshipObjects) {
        if (objects.get(name) !== type) {
          throw new Error(`Remote D1 is missing required ${type} ${name}.`);
        }
      }
      const relationshipVisibilityTrigger = objectRows.find(
        (row) =>
          row.name ===
          "prevent_referenced_public_speaker_relationship_visibility_change",
      );
      const visibilityTriggerSql =
        typeof relationshipVisibilityTrigger?.sql === "string"
          ? relationshipVisibilityTrigger.sql
          : "";
      const visibilityTriggerMatchesContract =
        publicSpeakerConfirmationGuardsApplied
          ? /BEFORE\s+UPDATE\s+OF\s+visibility\s*,\s*participation_status\s+ON\s+session_speakers/iu.test(
              visibilityTriggerSql,
            ) &&
            /OLD\.participation_status\s*=\s*'confirmed'/iu.test(
              visibilityTriggerSql,
            ) &&
            /NEW\.participation_status\s*<>\s*'confirmed'/iu.test(
              visibilityTriggerSql,
            ) &&
            /alternative_relation\.participation_status\s*=\s*'confirmed'/iu.test(
              visibilityTriggerSql,
            )
          : /BEFORE\s+UPDATE\s+OF\s+visibility\s+ON\s+session_speakers/iu.test(
              visibilityTriggerSql,
            );
      if (
        !visibilityTriggerMatchesContract ||
        !/event_public_site_references/iu.test(visibilityTriggerSql) ||
        !/reference\.kind\s*=\s*'speaker'/iu.test(visibilityTriggerSql) ||
        !/OLD\.visibility\s*=\s*'public'/iu.test(visibilityTriggerSql) ||
        !/NEW\.visibility\s*<>\s*'public'/iu.test(visibilityTriggerSql) ||
        !/session_id\s*<>\s*OLD\.session_id/iu.test(visibilityTriggerSql) ||
        !/RAISE\s*\(\s*ABORT\s*,/iu.test(visibilityTriggerSql)
      ) {
        throw new Error(
          "Remote D1 featured-speaker relationship visibility trigger has the wrong protection contract.",
        );
      }
      const relationshipDeleteTrigger = objectRows.find(
        (row) =>
          row.name === "prevent_referenced_public_speaker_relationship_delete",
      );
      const deleteTriggerSql =
        typeof relationshipDeleteTrigger?.sql === "string"
          ? relationshipDeleteTrigger.sql
          : "";
      const deleteTriggerMatchesConfirmation =
        !publicSpeakerConfirmationGuardsApplied ||
        (/OLD\.participation_status\s*=\s*'confirmed'/iu.test(
          deleteTriggerSql,
        ) &&
          /alternative_relation\.participation_status\s*=\s*'confirmed'/iu.test(
            deleteTriggerSql,
          ));
      if (
        !/BEFORE\s+DELETE\s+ON\s+session_speakers/iu.test(deleteTriggerSql) ||
        !/event_public_site_references/iu.test(deleteTriggerSql) ||
        !/reference\.kind\s*=\s*'speaker'/iu.test(deleteTriggerSql) ||
        !/OLD\.visibility\s*=\s*'public'/iu.test(deleteTriggerSql) ||
        !/session_id\s*<>\s*OLD\.session_id/iu.test(deleteTriggerSql) ||
        !/RAISE\s*\(\s*ABORT\s*,/iu.test(deleteTriggerSql) ||
        !deleteTriggerMatchesConfirmation
      ) {
        throw new Error(
          "Remote D1 featured-speaker relationship delete trigger has the wrong protection contract.",
        );
      }
    }
    if (speakerRelationshipIdentityGuardsApplied) {
      for (const [name, type] of requiredSpeakerRelationshipIdentityObjects) {
        if (objects.get(name) !== type) {
          throw new Error(`Remote D1 is missing required ${type} ${name}.`);
        }
      }
      const identityTrigger = objectRows.find(
        (row) => row.name === "session_speakers_identity_immutable",
      );
      const identityTriggerSql =
        typeof identityTrigger?.sql === "string" ? identityTrigger.sql : "";
      if (
        !/BEFORE\s+UPDATE\s+OF\s+event_id\s*,\s*session_id\s*,\s*person_id\s+ON\s+session_speakers/iu.test(
          identityTriggerSql,
        ) ||
        !/NEW\.event_id\s*<>\s*OLD\.event_id/iu.test(identityTriggerSql) ||
        !/NEW\.session_id\s*<>\s*OLD\.session_id/iu.test(identityTriggerSql) ||
        !/NEW\.person_id\s*<>\s*OLD\.person_id/iu.test(identityTriggerSql) ||
        !/NEW\.person_id\s+LIKE\s+'retained-participant-%'/iu.test(
          identityTriggerSql,
        ) ||
        !/profile_status\s*=\s*'archived'/iu.test(identityTriggerSql) ||
        !/retained\.last_operation_id\s*=\s*event\.last_operation_id/iu.test(
          identityTriggerSql,
        ) ||
        !/participant_retention_completed_at\s+IS\s+NULL/iu.test(
          identityTriggerSql,
        ) ||
        !/NOT\s+EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+event_public_site_references\s+reference/iu.test(
          identityTriggerSql,
        ) ||
        !/reference\.kind\s*=\s*'speaker'/iu.test(identityTriggerSql) ||
        !/reference\.record_id\s*=\s*OLD\.person_id/iu.test(
          identityTriggerSql,
        ) ||
        !/RAISE\s*\(\s*ABORT\s*,\s*'Session speaker relationship identity is immutable'\s*\)/iu.test(
          identityTriggerSql,
        )
      ) {
        throw new Error(
          "Remote D1 session-speaker identity trigger has the wrong protection contract.",
        );
      }
    }
    const publicSiteForeignKeys = successfulResults(
      response[9],
      "public-site foreign keys",
    );
    const foreignKeyGroups = new Map();
    for (const row of publicSiteForeignKeys) {
      const key = JSON.stringify([row.tableName, row.id]);
      const group = foreignKeyGroups.get(key) ?? [];
      group.push(row);
      foreignKeyGroups.set(key, group);
    }
    for (const {
      tableName,
      targetTable,
      columns,
      onDelete,
    } of requiredPublicSiteForeignKeys) {
      if (
        ![...foreignKeyGroups.values()].some((unorderedRows) => {
          const rows = [...unorderedRows].sort(
            (left, right) => Number(left.seq) - Number(right.seq),
          );
          return (
            rows.length === columns.length &&
            rows.every(
              (row, index) =>
                row.tableName === tableName &&
                row.table === targetTable &&
                row.on_delete === onDelete &&
                row.seq === index &&
                row.from === columns[index][0] &&
                row.to === columns[index][1],
            )
          );
        })
      ) {
        throw new Error(
          `Remote D1 ${tableName} is missing its required foreign key (${columns.map(([from]) => from).join(", ")}) to ${targetTable} (${columns.map(([, to]) => to).join(", ")}).`,
        );
      }
    }
    const embedRows = successfulResults(response[10], "managed embed themes");
    if (embedRows.length !== 1 || embedRows[0]?.invalidCount !== 0) {
      throw new Error(
        "Remote D1 managed programme embeds retain a missing or invalid theme.",
      );
    }
  }

  return {
    migrationCount: appliedMigrationNames.length,
    pendingMigrationCount:
      localMigrationNames.length - appliedMigrationNames.length,
    brandingColumnCount: requiredBrandAssetColumns.size,
    brandingObjectCount: requiredBrandSchemaObjects.size,
    reviewerAiColumnCount: reviewerAiApplied
      ? requiredReviewerAiReviewColumns.size * 2 +
        requiredReviewerAiSuggestionColumns.size
      : 0,
    reviewerAiObjectCount: reviewerAiApplied
      ? requiredReviewerAiSchemaObjects.size
      : 0,
    publicSiteColumnCount: publicSiteApplied
      ? [...requiredPublicSiteColumns.values()].reduce(
          (count, columns) => count + columns.size,
          0,
        )
      : 0,
    publicSiteObjectCount: publicSiteApplied
      ? requiredPublicSiteSchemaObjects.size +
        (featuredSpeakerRelationshipGuardsApplied
          ? requiredFeaturedSpeakerRelationshipObjects.size
          : 0)
      : 0,
    publicSiteForeignKeyCount: publicSiteApplied
      ? requiredPublicSiteForeignKeys.length
      : 0,
  };
}

function run() {
  const allowPendingMigrations = process.argv.includes("--before-migrate");
  const localMigrationNames = readdirSync(resolve(repositoryRoot, "migrations"))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
    .sort();
  const objectNames = [
    ...requiredBrandSchemaObjects.keys(),
    ...requiredReviewerAiSchemaObjects.keys(),
    ...requiredPublicSiteSchemaObjects.keys(),
    ...requiredFeaturedSpeakerRelationshipObjects.keys(),
    ...requiredSpeakerRelationshipIdentityObjects.keys(),
  ]
    .map((name) => `'${name.replaceAll("'", "''")}'`)
    .join(", ");
  const publicSiteColumnQuery = [...requiredPublicSiteColumns.keys()]
    .map(
      (tableName) =>
        `SELECT '${tableName}' AS tableName, name, type, "notnull", dflt_value, pk FROM pragma_table_info('${tableName}')`,
    )
    .join(" UNION ALL ");
  const publicSiteForeignKeyQuery = [...requiredPublicSiteColumns.keys()]
    .map(
      (tableName) =>
        `SELECT '${tableName}' AS tableName, id, seq, "table", "from", "to", on_delete FROM pragma_foreign_key_list('${tableName}')`,
    )
    .join(" UNION ALL ");
  const command = [
    "SELECT name FROM d1_migrations ORDER BY id",
    "PRAGMA table_info(event_brand_assets)",
    `SELECT type, name, sql FROM sqlite_master WHERE name IN (${objectNames}) ORDER BY type, name`,
    "PRAGMA table_info(reviews)",
    "PRAGMA table_info(review_revisions)",
    "PRAGMA table_info(reviewer_ai_suggestions)",
    "PRAGMA quick_check",
    "PRAGMA foreign_key_check",
    publicSiteColumnQuery,
    publicSiteForeignKeyQuery,
    `SELECT COUNT(*) AS invalidCount FROM programme_embeds
      WHERE json_extract(configuration_json, '$.theme') IS NULL
         OR json_extract(configuration_json, '$.theme') NOT IN ('light','dark','system')`,
  ].join("; ");
  const result = spawnSync(
    resolvePackageExecutable("wrangler", "wrangler"),
    [
      "d1",
      "execute",
      "program-cue-db-wnam",
      "--remote",
      "--config",
      resolve(repositoryRoot, "wrangler.jsonc"),
      "--command",
      command,
      "--json",
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: REMOTE_SCHEMA_TIMEOUT_MS,
    },
  );
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error("Remote D1 schema validation timed out.");
  }
  if (result.error) {
    throw new Error("Remote D1 schema validation could not start Wrangler.");
  }
  if (result.status !== 0) {
    throw new Error(
      `Remote D1 schema validation could not query production: ${wranglerFailureMessage(result)}`,
    );
  }
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    throw new Error("Remote D1 schema validation received invalid JSON.");
  }
  const evidence = validateRemoteSchemaEvidence(response, localMigrationNames, {
    allowPendingMigrations,
  });
  if (allowPendingMigrations) {
    console.log(
      `Remote D1 migration preflight passed (${evidence.migrationCount} applied and ${evidence.pendingMigrationCount} pending migrations).`,
    );
  } else {
    console.log(
      `Remote D1 schema validation passed (${evidence.migrationCount} migrations, ${evidence.brandingColumnCount} branding columns, ${evidence.brandingObjectCount} branding indexes/triggers, ${evidence.reviewerAiColumnCount} reviewer-AI columns, ${evidence.reviewerAiObjectCount} reviewer-AI indexes/triggers, ${evidence.publicSiteColumnCount} public-site columns, ${evidence.publicSiteObjectCount} public-site indexes/triggers and ${evidence.publicSiteForeignKeyCount} public-site foreign keys).`,
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
