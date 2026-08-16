import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePackageExecutable } from "./package-executable.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REMOTE_SCHEMA_TIMEOUT_MS = 60_000;
export const lastImmutableMigrationName =
  "0032_event_brand_asset_normalization.sql";
export const reviewerAiMigrationName = "0035_reviewer_ai_hardening.sql";

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

function validateColumns(rows, requiredColumns, tableName) {
  const columns = new Map(rows.map((row) => [row.name, row]));
  for (const [name, expected] of requiredColumns) {
    const column = columns.get(name);
    if (
      !column ||
      column.type !== expected.type ||
      column.notnull !== expected.notnull ||
      column.dflt_value !== expected.defaultValue
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
  if (!Array.isArray(response) || response.length !== 8) {
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
  ]
    .map((name) => `'${name.replaceAll("'", "''")}'`)
    .join(", ");
  const command = [
    "SELECT name FROM d1_migrations ORDER BY id",
    "PRAGMA table_info(event_brand_assets)",
    `SELECT type, name, sql FROM sqlite_master WHERE name IN (${objectNames}) ORDER BY type, name`,
    "PRAGMA table_info(reviews)",
    "PRAGMA table_info(review_revisions)",
    "PRAGMA table_info(reviewer_ai_suggestions)",
    "PRAGMA quick_check",
    "PRAGMA foreign_key_check",
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
      `Remote D1 schema validation passed (${evidence.migrationCount} migrations, ${evidence.brandingColumnCount} branding columns, ${evidence.brandingObjectCount} branding indexes/triggers, ${evidence.reviewerAiColumnCount} reviewer-AI columns and ${evidence.reviewerAiObjectCount} reviewer-AI indexes/triggers).`,
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
