import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { retainEvidenceFile } from "agent-eval-kit/evidence/files";

test("version grader checks actual distinct downloads and separates failures from unavailable evidence", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "programcue-version-grader-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, "PC-FILES");
  fs.mkdirSync(directory);
  const retain = (label, fixture) =>
    retainEvidenceFile({
      directory,
      label,
      filename: fixture,
      mediaType: "application/pdf",
      bytes: fs.readFileSync(new URL(`../fixtures/${fixture}`, import.meta.url)),
      step: 1,
    });
  const v1 = retain("previous-version", "deck-v1.pdf");
  const v2 = retain("current-version", "deck-v2.pdf");
  const run = (outcome, files) => {
    fs.writeFileSync(path.join(directory, "evidence.json"), JSON.stringify({ outcome, files }));
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL("../scripts/check-versions.mjs", import.meta.url))],
      { env: { ...process.env, AEK_RUN_DIR: root }, encoding: "utf8" },
    );
    return {
      ...result,
      verdict: result.status === 0 ? JSON.parse(result.stdout).verdict : undefined,
    };
  };
  assert.equal(run("completed", [v1, v2]).verdict, "pass");
  // Valid retained artifacts can still be the wrong product bytes.
  assert.equal(run("completed", [v1, { ...v1, label: "current-version" }]).verdict, "fail");
  assert.equal(
    run("completed", [
      { ...v2, label: "previous-version" },
      { ...v1, label: "current-version" },
    ]).verdict,
    "fail",
  );
  assert.equal(run("blocked", []).verdict, "cannot_judge");
  assert.equal(run("not_run", []).verdict, "cannot_judge");
  assert.equal(run("feature_not_found", []).verdict, "not_found");
  assert.notEqual(run("completed", [v1]).status, 0);
  assert.notEqual(run("completed", [v1, v1, v2]).status, 0);
  const bytes = fs.readFileSync(path.join(directory, v1.path));
  bytes[0] ^= 1;
  fs.writeFileSync(path.join(directory, v1.path), bytes);
  const tampered = run("completed", [v1, v2]);
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stderr, /Evidence file hash changed/);
});
