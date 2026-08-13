import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { resolvePackageExecutable } from "./package-executable.mjs";

const WRANGLER_EXPORT_TIMEOUT_MS = 30 * 60 * 1_000;

// Wrangler creates the SQL destination. Restrict its mode from the first byte
// instead of waiting until a credential- and PII-bearing export is complete.
process.umask(0o077);

function fail(message) {
  console.error(`Backup export failed: ${message}`);
  process.exit(1);
}

const outputFlag = process.argv.find((argument) =>
  argument.startsWith("--output="),
);
if (!outputFlag)
  fail("pass a new destination with --output=/secure/path/program-cue.sql");
const output = resolve(outputFlag.slice("--output=".length));
if (!output.endsWith(".sql"))
  fail("the backup destination must use a .sql extension");
for (const destination of [output, `${output}.manifest.json`]) {
  try {
    await stat(destination);
    fail(`${destination} already exists; backups are never overwritten`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

await mkdir(dirname(output), { recursive: true });
const wrangler = resolvePackageExecutable("wrangler", "wrangler");
const result = spawnSync(
  wrangler,
  [
    "d1",
    "export",
    "program-cue-db-wnam",
    "--remote",
    "--config",
    resolve("wrangler.jsonc"),
    "--output",
    output,
    "--skip-confirmation",
  ],
  { stdio: "inherit", timeout: WRANGLER_EXPORT_TIMEOUT_MS },
);
if (result.error?.code === "ETIMEDOUT") {
  fail("Wrangler D1 export exceeded the 30-minute safety timeout");
}
if (result.error)
  fail(`Wrangler D1 export could not start: ${result.error.message}`);
if (result.status !== 0)
  fail(`Wrangler exited with status ${result.status ?? "unknown"}`);

await chmod(output, 0o600);
const bytes = await readFile(output);
if (bytes.byteLength === 0) fail("Wrangler produced an empty D1 export");
const manifest = {
  format: "program-cue-d1-logical-backup-v1",
  database: "program-cue-db-wnam",
  createdAt: new Date().toISOString(),
  bytes: bytes.byteLength,
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
await writeFile(
  `${output}.manifest.json`,
  `${JSON.stringify(manifest, null, 2)}\n`,
  {
    flag: "wx",
    mode: 0o600,
  },
);
console.log(`Backup and checksum manifest written to ${output}.`);
