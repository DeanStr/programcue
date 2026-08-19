import { repositoryRoot } from "./e2e-runtime.mjs";
import { npmCommand, runProcess } from "./process-runner.mjs";

const application = await runProcess(
  "node",
  ["scripts/run-e2e.mjs", "--config=playwright.pr.config.ts"],
  {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PROGRAM_CUE_E2E_SHARDS: process.env.PROGRAM_CUE_E2E_SHARDS ?? "2",
    },
    label: "pull-request Chromium behavior gate",
  },
);
if (application.code !== 0) process.exit(application.code);

const evaluation = await runProcess(
  "node",
  ["scripts/run-evaluation-e2e.mjs"],
  {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      PROGRAM_CUE_E2E_SKIP_BUILD: "1",
    },
    label: "pull-request production-shaped evaluation browser gate",
  },
);
if (evaluation.code !== 0) process.exit(evaluation.code);

const publicSite = await runProcess(npmCommand, ["run", "test:site:e2e"], {
  cwd: repositoryRoot,
  label: "pull-request public website gate",
});
if (publicSite.code !== 0) process.exit(publicSite.code);
