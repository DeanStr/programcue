import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolvePackageExecutable } from "./package-executable.mjs";
import { readValidatedReleaseRevision } from "./validate-release-state.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run() {
  const releaseRevision = readValidatedReleaseRevision();
  const result = spawnSync(
    resolvePackageExecutable("wrangler", "wrangler"),
    [
      "deploy",
      "--config",
      resolve(repositoryRoot, "build/server/wrangler.json"),
      "--var",
      `SOURCE_REVISION:${releaseRevision}`,
    ],
    { cwd: repositoryRoot, stdio: "inherit" },
  );
  if (result.error) {
    throw new Error(
      `Production deployment could not start: ${result.error.message}`,
    );
  }
  if (result.status !== 0) {
    throw new Error("Production deployment failed.");
  }
  console.log(`Production deployment used source revision ${releaseRevision}.`);
}

try {
  run();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
