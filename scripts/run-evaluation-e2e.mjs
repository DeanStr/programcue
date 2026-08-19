import { repositoryRoot } from "./e2e-runtime.mjs";
import { resolvePackageExecutable } from "./package-executable.mjs";
import { npmCommand, runProcess } from "./process-runner.mjs";

const rawArguments = process.argv.slice(2);
if (rawArguments.some((argument) => argument.startsWith("--config"))) {
  throw new Error(
    "The evaluation E2E runner owns its Playwright configuration.",
  );
}

const environment = {
  ...process.env,
  PROGRAM_CUE_E2E_PORT: process.env.PROGRAM_CUE_E2E_PORT ?? "5273",
  PROGRAM_CUE_E2E_INSPECTOR_PORT:
    process.env.PROGRAM_CUE_E2E_INSPECTOR_PORT ?? "15273",
  PROGRAM_CUE_E2E_STATE:
    process.env.PROGRAM_CUE_E2E_STATE ?? ".wrangler/e2e-state-evaluation",
  PROGRAM_CUE_EVALUATION_E2E_ACCESS_CODE:
    process.env.PROGRAM_CUE_EVALUATION_E2E_ACCESS_CODE ??
    "program-cue-evaluation-e2e-access",
};

if (process.env.PROGRAM_CUE_E2E_SKIP_BUILD !== "1") {
  const build = await runProcess(npmCommand, ["run", "build"], {
    cwd: repositoryRoot,
    env: environment,
    label: "evaluation E2E production build",
  });
  if (build.code !== 0) process.exit(build.code);
}

const result = await runProcess(
  resolvePackageExecutable("@playwright/test", "playwright"),
  ["test", "--config=playwright.evaluation.config.ts", ...rawArguments],
  {
    cwd: repositoryRoot,
    env: environment,
    label: "evaluation public-application Playwright",
  },
);
process.exitCode = result.code;
