import { rm } from "node:fs/promises";

import { repositoryRoot, resolveE2eRuntime } from "./e2e-runtime.mjs";
import { resolvePackageExecutable } from "./package-executable.mjs";
import { npmCommand, runProcess } from "./process-runner.mjs";

const argumentsSet = new Set(process.argv.slice(2));
if ([...argumentsSet].some((argument) => argument !== "--skip-build")) {
  throw new Error("Usage: node scripts/prepare-e2e.mjs [--skip-build]");
}
const skipBuild =
  argumentsSet.has("--skip-build") ||
  process.env.PROGRAM_CUE_E2E_SKIP_BUILD === "1";
const { statePath } = resolveE2eRuntime();
await rm(statePath, { recursive: true, force: true });

const migration = await runProcess(
  resolvePackageExecutable("wrangler", "wrangler"),
  [
    "d1",
    "migrations",
    "apply",
    "program-cue-db",
    "--local",
    "--persist-to",
    statePath,
    "-c",
    "wrangler.demo.jsonc",
  ],
  { cwd: repositoryRoot, label: "E2E D1 migration" },
);
if (migration.code !== 0) process.exit(migration.code);

if (!skipBuild) {
  const build = await runProcess(npmCommand, ["run", "build"], {
    cwd: repositoryRoot,
    label: "E2E production build",
  });
  if (build.code !== 0) process.exit(build.code);
}
