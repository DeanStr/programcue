import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { REQUIRED_PRODUCTION_SECRET_NAMES } from "./deploy-contract.mjs";
import { resolvePackageExecutable } from "./package-executable.mjs";

const SECRET_INVENTORY_TIMEOUT_MS = 60_000;

export function missingRequiredSecretNames(records) {
  if (!Array.isArray(records)) {
    throw new TypeError(
      "Production secret validation expected a secret inventory array.",
    );
  }
  const configured = new Set(
    records
      .map((record) => (typeof record?.name === "string" ? record.name : null))
      .filter(Boolean),
  );
  return REQUIRED_PRODUCTION_SECRET_NAMES.filter(
    (name) => !configured.has(name),
  );
}

function run() {
  const result = spawnSync(
    resolvePackageExecutable("wrangler", "wrangler"),
    [
      "secret",
      "list",
      "--config",
      resolve("wrangler.jsonc"),
      "--format",
      "json",
    ],
    {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: SECRET_INVENTORY_TIMEOUT_MS,
    },
  );
  if (result.error?.code === "ETIMEDOUT") {
    console.error(
      "Production secret validation timed out while querying Cloudflare.",
    );
    process.exitCode = 1;
    return;
  }
  if (result.error) {
    console.error(
      "Production secret validation could not start the Wrangler CLI.",
    );
    process.exitCode = 1;
    return;
  }
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    console.error(
      "Production secret validation could not query the configured Worker.",
    );
    process.exitCode = 1;
    return;
  }

  let records;
  try {
    records = JSON.parse(result.stdout);
  } catch {
    console.error(
      "Production secret validation received an invalid Wrangler response.",
    );
    process.exitCode = 1;
    return;
  }

  let missing;
  try {
    missing = missingRequiredSecretNames(records);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  if (missing.length) {
    console.error(
      `Production deployment is missing required Cloudflare secrets:\n- ${missing.join("\n- ")}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `Production secret validation passed (${REQUIRED_PRODUCTION_SECRET_NAMES.length} required names present).`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  run();
