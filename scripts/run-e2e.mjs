import { performance } from "node:perf_hooks";

import { resolveE2eShardRuntimes, repositoryRoot } from "./e2e-runtime.mjs";
import { formatDuration, npmCommand, runProcess } from "./process-runner.mjs";
import { resolvePackageExecutable } from "./package-executable.mjs";

const startedAt = performance.now();
const rawArguments = process.argv.slice(2);
const skipBuild = process.env.PROGRAM_CUE_E2E_SKIP_BUILD === "1";
if (rawArguments.some((argument) => argument.startsWith("--shard"))) {
  throw new Error(
    "run-e2e manages Playwright shards; set PROGRAM_CUE_E2E_SHARDS instead of passing --shard.",
  );
}
if (rawArguments.some((argument) => argument.startsWith("--output"))) {
  throw new Error("run-e2e manages Playwright output directories.");
}

const runtimes = resolveE2eShardRuntimes();
const shardCount = runtimes.length;

if (!skipBuild) {
  const build = await runProcess(npmCommand, ["run", "build"], {
    cwd: repositoryRoot,
    label: "shared E2E production build",
  });
  if (build.code !== 0) process.exit(build.code);
}

console.log(
  `\nRunning Playwright in ${shardCount} isolated shard${shardCount === 1 ? "" : "s"}.`,
);
/* Resolve the CLI from the same package test files import. A worktree can
   contain an extraneous top-level `playwright` directory alongside pnpm's
   `@playwright/test` graph; launching that copy creates two test runtimes and
   makes every shard fail during discovery. */
const playwright = resolvePackageExecutable("@playwright/test", "playwright");
const shardRuns = runtimes.map((runtime) => {
  const { inspectorPort, port, shard, statePathFromRepository } = runtime;
  return runProcess(
    playwright,
    [
      "test",
      ...rawArguments,
      `--output=test-results/shard-${shard}-of-${shardCount}`,
      `--shard=${shard}/${shardCount}`,
    ],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        PROGRAM_CUE_E2E_INSPECTOR_PORT: String(inspectorPort),
        PROGRAM_CUE_E2E_PORT: String(port),
        PROGRAM_CUE_E2E_SKIP_BUILD: "1",
        PROGRAM_CUE_E2E_STATE: statePathFromRepository,
      },
      label: `Playwright shard ${shard}/${shardCount} (port ${port})`,
    },
  );
});

const results = await Promise.all(shardRuns);
const failures = results.filter((result) => result.code !== 0);
console.log(`\nE2E total: ${formatDuration(performance.now() - startedAt)}`);
for (const result of results) {
  console.log(`- ${result.label}: ${formatDuration(result.duration)}`);
}
if (failures.length > 0) {
  console.error(`${failures.length} Playwright shard(s) failed.`);
  process.exitCode = 1;
}
