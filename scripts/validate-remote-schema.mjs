import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePackageExecutable } from "./package-executable.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REMOTE_SCHEMA_TIMEOUT_MS = 60_000;
export const lastImmutableMigrationName =
  "0032_event_brand_asset_normalization.sql";

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

function successfulResults(result, label) {
  if (!result || result.success !== true || !Array.isArray(result.results)) {
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
  if (!Array.isArray(response) || response.length !== 5) {
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

  const quickCheck = successfulResults(response[3], "integrity");
  if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== "ok") {
    throw new Error("Remote D1 quick_check did not return ok.");
  }
  const foreignKeyFailures = successfulResults(
    response[4],
    "foreign-key integrity",
  );
  if (foreignKeyFailures.length > 0) {
    throw new Error("Remote D1 foreign_key_check returned violations.");
  }

  const columns = new Map(
    successfulResults(response[1], "brand asset columns").map((row) => [
      row.name,
      row,
    ]),
  );
  for (const [name, expected] of requiredBrandAssetColumns) {
    const column = columns.get(name);
    if (
      !column ||
      column.type !== expected.type ||
      column.notnull !== expected.notnull ||
      column.dflt_value !== expected.defaultValue
    ) {
      throw new Error(
        `Remote D1 event_brand_assets.${name} is missing or has the wrong contract.`,
      );
    }
  }

  const objects = new Map(
    successfulResults(response[2], "branding schema objects").map((row) => [
      row.name,
      row.type,
    ]),
  );
  for (const [name, type] of requiredBrandSchemaObjects) {
    if (objects.get(name) !== type) {
      throw new Error(`Remote D1 is missing required ${type} ${name}.`);
    }
  }

  return {
    migrationCount: appliedMigrationNames.length,
    pendingMigrationCount:
      localMigrationNames.length - appliedMigrationNames.length,
    brandingColumnCount: requiredBrandAssetColumns.size,
    brandingObjectCount: requiredBrandSchemaObjects.size,
  };
}

function run() {
  const allowPendingMigrations = process.argv.includes("--before-migrate");
  const localMigrationNames = readdirSync(resolve(repositoryRoot, "migrations"))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
    .sort();
  const objectNames = [...requiredBrandSchemaObjects.keys()]
    .map((name) => `'${name.replaceAll("'", "''")}'`)
    .join(", ");
  const command = [
    "SELECT name FROM d1_migrations ORDER BY id",
    "PRAGMA table_info(event_brand_assets)",
    `SELECT type, name FROM sqlite_master WHERE name IN (${objectNames}) ORDER BY type, name`,
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
      `Remote D1 schema validation passed (${evidence.migrationCount} migrations, ${evidence.brandingColumnCount} branding columns and ${evidence.brandingObjectCount} branding indexes/triggers).`,
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
