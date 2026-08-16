import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  lastImmutableMigrationName,
  requiredBrandAssetColumns,
  requiredBrandSchemaObjects,
  validateRemoteSchemaEvidence,
} from "./validate-remote-schema.mjs";
import { validateReleaseStateEvidence } from "./validate-release-state.mjs";
import { validateProductionHealth } from "./verify-production-health.mjs";

const migrations = [
  "0032_decision_draft_preview_contract.sql",
  "0032_event_brand_asset_normalization.sql",
];
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function remoteEvidence() {
  return [
    {
      success: true,
      results: migrations.map((name) => ({ name })),
    },
    {
      success: true,
      results: [...requiredBrandAssetColumns].map(
        ([name, { type, notnull, defaultValue }], cid) => ({
          cid,
          name,
          type,
          notnull,
          dflt_value: defaultValue,
          pk: 0,
        }),
      ),
    },
    {
      success: true,
      results: [...requiredBrandSchemaObjects].map(([name, type]) => ({
        name,
        type,
      })),
    },
    { success: true, results: [{ quick_check: "ok" }] },
    { success: true, results: [] },
  ];
}

test("remote schema validation requires the exact migration ledger and branding contract", () => {
  assert.deepEqual(validateRemoteSchemaEvidence(remoteEvidence(), migrations), {
    migrationCount: 2,
    pendingMigrationCount: 0,
    brandingColumnCount: 7,
    brandingObjectCount: 11,
  });

  const nextReleaseMigrations = [...migrations, "0033_next_release.sql"];
  assert.deepEqual(
    validateRemoteSchemaEvidence(remoteEvidence(), nextReleaseMigrations, {
      allowPendingMigrations: true,
    }),
    {
      migrationCount: 2,
      pendingMigrationCount: 1,
      brandingColumnCount: 7,
      brandingObjectCount: 11,
    },
  );
  const reorderedLedger = remoteEvidence();
  reorderedLedger[0].results.reverse();
  assert.throws(
    () =>
      validateRemoteSchemaEvidence(reorderedLedger, nextReleaseMigrations, {
        allowPendingMigrations: true,
      }),
    /ledger does not match this release/u,
  );

  const missingMigration = remoteEvidence();
  missingMigration[0].results.pop();
  assert.throws(
    () =>
      validateRemoteSchemaEvidence(missingMigration, migrations, {
        allowPendingMigrations: true,
      }),
    /missing: 0032_event_brand_asset_normalization\.sql/u,
  );

  assert.equal(lastImmutableMigrationName, migrations.at(-1));

  const missingTrigger = remoteEvidence();
  missingTrigger[2].results = missingTrigger[2].results.filter(
    ({ name }) => name !== "events_retire_unreferenced_brand_assets",
  );
  assert.throws(
    () => validateRemoteSchemaEvidence(missingTrigger, migrations),
    /missing required trigger events_retire_unreferenced_brand_assets/u,
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
  foreignKeyFailure[4].results.push({ table: "events", rowid: 1 });
  assert.throws(
    () => validateRemoteSchemaEvidence(foreignKeyFailure, migrations),
    /foreign_key_check returned violations/u,
  );
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

  const coreWorkflow = await readFile(
    resolve(repositoryRoot, ".github/workflows/ci.yml"),
    "utf8",
  );
  assert.match(coreWorkflow, /pull_request:/u);
  assert.match(coreWorkflow, /npm run check:core/u);

  const releaseWorkflow = await readFile(
    resolve(repositoryRoot, ".github/workflows/release.yml"),
    "utf8",
  );
  assert.match(releaseWorkflow, /run: npm run deploy/u);
  assert.doesNotMatch(releaseWorkflow, /npm run deploy:cutover/u);

  const deployProduction = await readFile(
    resolve(repositoryRoot, "scripts/deploy-production.mjs"),
    "utf8",
  );
  assert.match(deployProduction, /SOURCE_REVISION:/u);
  assert.match(deployProduction, /readValidatedReleaseRevision/u);
});
