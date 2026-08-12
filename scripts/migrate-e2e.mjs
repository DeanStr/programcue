import { resolve } from "node:path";

import { resolveE2eRuntime, repositoryRoot } from "./e2e-runtime.mjs";
import { runProcess } from "./process-runner.mjs";

const { statePath } = resolveE2eRuntime();
const result = await runProcess(
  resolve(repositoryRoot, "node_modules/.bin/wrangler"),
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

process.exitCode = result.code;
