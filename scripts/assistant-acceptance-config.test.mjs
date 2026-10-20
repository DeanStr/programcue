import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { resolvePackageExecutable } from "./package-executable.mjs";

function loadAcceptanceConfig(source) {
  const childEnv = {
    ...process.env,
    PROGRAM_CUE_ACCEPTANCE_PROVIDER: "openai",
    PROGRAM_CUE_ACCEPTANCE_MODEL: "explicit-config-test-model",
  };
  delete childEnv.PROGRAM_CUE_ACCEPTANCE_SOURCE;
  if (source !== undefined) childEnv.PROGRAM_CUE_ACCEPTANCE_SOURCE = source;
  return spawnSync(
    resolvePackageExecutable("tsx", "tsx"),
    [
      "--eval",
      "import('./vitest.assistant-acceptance.config.ts').then(({ default: config }) => process.stdout.write(config.test.name)).catch(error => { process.stderr.write(error.message); process.exitCode = 1; });",
    ],
    { env: childEnv, encoding: "utf8", timeout: 30_000 },
  );
}

test("assistant acceptance stops without recorded source provenance", () => {
  for (const source of [undefined, "", "   "]) {
    const result = loadAcceptanceConfig(source);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /requires a recorded source revision/);
    assert.equal(result.stdout, "");
  }
});

test("assistant acceptance accepts the source fingerprint recorded by its launcher", () => {
  const result = loadAcceptanceConfig(`${"a".repeat(40)}+${"b".repeat(12)}`);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "assistant-live-acceptance");
});
