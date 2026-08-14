import { fileURLToPath } from "node:url";

import { unstable_readConfig } from "wrangler";

const SCANNER_CONFIG_FILE = "./scanner/wrangler.jsonc";
const expectedVariables = Object.freeze({
  APP_ENV: "production",
  EXPECTED_CALLBACK_URL: "https://app.programcue.com/api/webhooks/file-scanner",
  R2_BUCKET_NAME: "program-cue-files",
  R2_OBJECT_HOST: "327c60945460c16be8ecdbbc7fa35447.r2.cloudflarestorage.com",
});

function sameMembers(actual = [], expected = []) {
  return (
    actual.length === expected.length &&
    [...actual]
      .sort()
      .every((value, index) => value === [...expected].sort()[index])
  );
}

export function readScannerConfig() {
  return unstable_readConfig(
    { config: SCANNER_CONFIG_FILE },
    { hideWarnings: true },
  );
}

export function validateScannerConfig(config) {
  const issues = [];
  const add = (message) => issues.push(message);
  if (config.name !== "program-cue-file-scanner")
    add("Scanner Worker name must be program-cue-file-scanner.");
  if (!config.main?.endsWith("/scanner/src/index.ts"))
    add("Scanner Worker main must be scanner/src/index.ts.");
  if (config.compatibility_date !== "2026-08-08")
    add("Scanner compatibility date must be 2026-08-08.");
  if (!sameMembers(config.compatibility_flags, ["nodejs_compat"]))
    add("Scanner compatibility flags must contain only nodejs_compat.");
  if (config.workers_dev !== false)
    add("Scanner workers.dev access must be disabled.");
  if (
    config.routes?.length !== 1 ||
    config.routes[0]?.pattern !== "scanner.programcue.com" ||
    config.routes[0]?.custom_domain !== true
  ) {
    add("Scanner must use only the scanner.programcue.com Custom Domain.");
  }

  const variables = config.vars ?? {};
  if (!/^[0-9a-f]{7,64}$/iu.test(String(variables.SOURCE_REVISION ?? "")))
    add("Scanner SOURCE_REVISION must be a Git revision.");
  for (const [name, expected] of Object.entries(expectedVariables)) {
    if (variables[name] !== expected)
      add(`Scanner ${name} must match the production file boundary.`);
  }
  if (
    Object.keys(variables).some((name) =>
      ["PROGRAM_CUE_DISPATCH_SECRET", "PROGRAM_CUE_CALLBACK_SECRET"].includes(
        name,
      ),
    )
  ) {
    add("Scanner credentials must be Cloudflare secrets, not variables.");
  }

  const workflow = config.workflows?.[0];
  if (
    config.workflows?.length !== 1 ||
    workflow?.name !== "program-cue-file-scans" ||
    workflow?.binding !== "FILE_SCAN_WORKFLOW" ||
    workflow?.class_name !== "FileScanWorkflow"
  ) {
    add("Scanner must bind the canonical file-scan Workflow.");
  }
  const container = config.containers?.[0];
  if (
    config.containers?.length !== 1 ||
    container?.name !== "program-cue-clamav" ||
    container?.class_name !== "FileScannerContainer" ||
    !container?.image?.endsWith("/scanner/container/Dockerfile") ||
    container?.max_instances !== 4 ||
    container?.instance_type !== "standard-2" ||
    container?.constraints?.jurisdiction !== "eu" ||
    !sameMembers(container?.constraints?.regions, ["EEUR", "WEUR"])
  ) {
    add("Scanner must use a four-instance EU-pinned standard-2 ClamAV pool.");
  }
  const durableObject = config.durable_objects?.bindings?.[0];
  if (
    config.durable_objects?.bindings?.length !== 1 ||
    durableObject?.name !== "CLAMAV" ||
    durableObject?.class_name !== "FileScannerContainer"
  ) {
    add("Scanner CLAMAV binding must reference FileScannerContainer.");
  }
  const migration = config.migrations?.[0];
  if (
    config.migrations?.length !== 1 ||
    migration?.tag !== "v1" ||
    !sameMembers(migration?.new_sqlite_classes, ["FileScannerContainer"])
  ) {
    add(
      "Scanner Durable Object migration v1 must create FileScannerContainer.",
    );
  }
  if (
    config.observability?.enabled !== true ||
    config.observability?.logs?.enabled !== true ||
    config.observability?.logs?.invocation_logs !== true ||
    config.observability?.traces?.enabled !== true ||
    config.observability?.traces?.head_sampling_rate !== 0.1
  ) {
    add("Scanner must enable invocation logs and 10% trace sampling.");
  }
  if (config.upload_source_maps !== true)
    add("Scanner source-map upload must be enabled.");
  return issues;
}

function run() {
  const issues = validateScannerConfig(readScannerConfig());
  if (issues.length) {
    console.error(
      `File-scanner deployment configuration is not release-ready:\n- ${issues.join("\n- ")}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    "File-scanner deployment configuration passed fail-fast validation.",
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  run();
