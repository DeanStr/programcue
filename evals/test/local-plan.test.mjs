import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import YAML from "yaml";

const execute = promisify(execFile);
test("coordinator validates before provisioning, rebuilds current source and selects required services", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "programcue-local-plan-"));
  const evaluator = path.join(directory, "evals");
  for (const child of ["evals/scripts", "evals/specs", "scripts", "bin"])
    fs.mkdirSync(path.join(directory, child), { recursive: true });
  for (const name of ["local.mjs", "runtime.mjs", "prepare-local.mjs"])
    fs.copyFileSync(
      new URL(`../scripts/${name}`, import.meta.url),
      path.join(evaluator, "scripts", name),
    );
  fs.symlinkSync(
    fs.realpathSync(new URL("../node_modules", import.meta.url)),
    path.join(evaluator, "node_modules"),
  );
  fs.writeFileSync(
    path.join(evaluator, "evalkit.regression.yaml"),
    YAML.stringify({
      version: 1,
      project: { name: "Planning test", root: ".." },
      target: { kind: "web", url: "http://127.0.0.1:5188" },
      agent: { provider: "mock" },
      judge: { provider: "mock" },
      paths: { specs: "evals/specs" },
    }),
  );
  for (const id of ["publication", "local-mail", "file-integrity"])
    fs.writeFileSync(
      path.join(evaluator, "specs", `${id}.yaml`),
      YAML.stringify({
        id,
        title: id,
        weight: id === "publication" ? 40 : 30,
        description: "Planning fixture",
        scenarios: [
          { id: `${id}-scenario`, name: id, kind: "browser", instructions: "Must not execute" },
        ],
        rubric: [
          {
            id: `${id}-criterion`,
            criterion: "Must not execute",
            weight: 1,
            scenarios: [`${id}-scenario`],
            grader: { type: "llm" },
            passCriteria: "Must not execute",
          },
        ],
      }),
    );
  const marker = path.join(directory, "calls");
  const preload = path.join(directory, "preload.mjs");
  fs.writeFileSync(
    preload,
    String.raw`import fs from 'node:fs'; globalThis.fetch=async(url)=>{if(url!=='http://127.0.0.1:8025/api/v1/messages?limit=1')throw new TypeError('fetch failed',{cause:{code:'ECONNREFUSED'}});fs.appendFileSync(process.env.PLAN_TEST_MARKER,'mail\n');return Response.json({total:0});};`,
  );
  fs.writeFileSync(
    path.join(directory, "bin/docker"),
    '#!/bin/sh\necho docker >> "$PLAN_TEST_MARKER"\nexit 9\n',
    { mode: 0o700 },
  );
  fs.writeFileSync(
    path.join(directory, "scripts/prepare-e2e.mjs"),
    "import fs from 'node:fs';fs.appendFileSync(process.env.PLAN_TEST_MARKER,process.env.PROGRAM_CUE_E2E_SKIP_BUILD==='1'?'stale-build\\n':'prepare\\n');process.exit(9);",
  );
  fs.writeFileSync(
    path.join(directory, "bin/npm"),
    '#!/bin/sh\nif [ "$PROGRAM_CUE_E2E_SKIP_BUILD" = "1" ]; then\necho stale-build >> "$PLAN_TEST_MARKER"\nelse\necho worker-build >> "$PLAN_TEST_MARKER"\nfi\nexit 9\n',
    { mode: 0o700 },
  );
  try {
    for (const [args, expected] of [
      [["--regression", "--unknown-option"], []],
      [["--regression", "--scenarios", "missing"], []],
      [
        ["--regression", "--areas", "publication"],
        ["mail", "prepare"],
      ],
      [
        ["--regression", "--areas", "local-mail"],
        ["mail", "prepare"],
      ],
      [
        ["--regression", "--areas", "file-integrity"],
        ["mail", "docker", "docker"],
      ],
      [["--regression"], ["mail", "docker", "docker"]],
      [
        [
          "--regression",
          "--areas",
          "file-integrity,publication",
          "--scenarios",
          "publication-scenario",
        ],
        ["mail", "prepare"],
      ],
      [["--smoke"], ["mail", "worker-build"]],
    ]) {
      fs.rmSync(marker, { force: true });
      await assert.rejects(
        execute(process.execPath, ["--import", preload, "scripts/local.mjs", ...args], {
          cwd: evaluator,
          env: {
            ...process.env,
            PATH: path.join(directory, "bin"),
            PLAN_TEST_MARKER: marker,
            PROGRAM_CUE_E2E_SKIP_BUILD: "1",
          },
          timeout: 10_000,
        }),
        (error) => {
          if (expected.length) assert.match(error.stderr, /failed \(9\)|Local Worker exited \(9\)/);
          return true;
        },
      );
      assert.deepEqual(
        fs.existsSync(marker) ? fs.readFileSync(marker, "utf8").trim().split("\n") : [],
        expected,
        args.join(" "),
      );
      assert.equal(fs.existsSync(path.join(evaluator, ".agent-eval/local.lock")), false);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
