import { performance } from "node:perf_hooks";

import { repositoryRoot } from "./e2e-runtime.mjs";
import {
  formatDuration,
  npmCommand,
  runProcess,
  runSequence,
} from "./process-runner.mjs";

const mode = process.argv[2];
if (!["--core", "--full", "--quick"].includes(mode)) {
  throw new Error("Usage: node scripts/run-checks.mjs --core|--full|--quick");
}

const startedAt = performance.now();
const generatedTypes = await runProcess(
  npmCommand,
  ["run", "types:generate"],
  { cwd: repositoryRoot, label: "generated Worker and route types" },
);
if (generatedTypes.code !== 0) process.exit(generatedTypes.code);

const coreRuns = await Promise.all([
  runProcess(npmCommand, ["run", "typecheck:generated"], {
    cwd: repositoryRoot,
    label: "TypeScript",
  }),
  runProcess(npmCommand, ["test"], {
    cwd: repositoryRoot,
    label: "unit and Worker tests",
  }),
  runProcess(npmCommand, ["run", "build"], {
    cwd: repositoryRoot,
    label: "production build",
  }),
  runSequence(
    "configuration and repository contracts",
    [
      {
        command: npmCommand,
        args: ["run", "test:config"],
        label: "configuration tests",
      },
      {
        command: "node",
        args: ["scripts/check-css-hygiene.mjs"],
        label: "CSS hygiene",
      },
      {
        command: npmCommand,
        args: ["run", "test:scanner"],
        label: "scanner tests",
      },
      {
        command: "python3",
        args: ["scripts/validate-migration.py"],
        label: "migration validation",
      },
      {
        command: npmCommand,
        args: ["run", "recovery:drill"],
        label: "recovery drill",
      },
      {
        command: npmCommand,
        args: ["run", "openapi:check"],
        label: "OpenAPI validation",
      },
    ],
    { cwd: repositoryRoot },
  ),
]);

const coreFailures = coreRuns.filter((result) => result.code !== 0);
if (coreFailures.length > 0) {
  console.error(`\n${coreFailures.length} core validation lane(s) failed.`);
  process.exit(1);
}

console.log(`\nCore validation: ${formatDuration(performance.now() - startedAt)}`);
for (const result of coreRuns) {
  console.log(`- ${result.label}: ${formatDuration(result.duration)}`);
}

if (mode !== "--core") {
  const quick = mode === "--quick";
  const e2eArguments = ["scripts/run-e2e.mjs"];
  if (quick) e2eArguments.push("--config=playwright.quick.config.ts");
  const e2eEnvironment = {
    ...process.env,
    PROGRAM_CUE_E2E_SKIP_BUILD: "1",
  };
  if (quick && !process.env.PROGRAM_CUE_E2E_SHARDS) {
    e2eEnvironment.PROGRAM_CUE_E2E_SHARDS = "2";
  }
  const e2e = await runProcess("node", e2eArguments, {
    cwd: repositoryRoot,
    env: e2eEnvironment,
    label: quick ? "quick Chromium behavior gate" : "full browser gate",
  });
  if (e2e.code !== 0) process.exit(e2e.code);
}

console.log(`\nCheck total: ${formatDuration(performance.now() - startedAt)}`);
