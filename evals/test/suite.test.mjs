import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import test from "node:test";
import YAML from "yaml";
import { aek, root, project } from "../scripts/runtime.mjs";
import { mailVerdict, zipVerdict } from "../scripts/checks.mjs";

function loadConfig(file) {
  return YAML.parse(fs.readFileSync(file, "utf8"));
}
function loadSpecs(directory) {
  return fs
    .readdirSync(directory)
    .filter((name) => name.endsWith(".yaml"))
    .map((name) => loadConfig(path.join(directory, name)));
}

test("the promoted regression baseline loads with the installed evaluator", () => {
  const result = spawnSync(
    process.execPath,
    [aek, "baseline", "list", "--config", "evalkit.regression.yaml"],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 15_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^local-astra-medium\t/m);
});

test("all upstream criteria retain their identity, requirements, weights and explicit grading policy", () => {
  const imported = loadSpecs(path.join(root, "specs/upstream"));
  assert.equal(imported.length, 7);
  assert.equal(imported.flatMap((s) => s.scenarios).length, 20);
  assert.equal(imported.flatMap((s) => s.rubric).length, 98);
  for (const name of fs.readdirSync(path.join(root, "upstream/specs"))) {
    const original = YAML.parse(fs.readFileSync(path.join(root, "upstream/specs", name), "utf8"));
    const spec = imported.find((s) => s.id === original.area);
    assert.equal(spec.weight, original.area_weight);
    for (const r of original.rubric) {
      const item = spec.rubric.find((item) => item.id === r.id);
      assert.equal(item.criterion, r.criterion);
      assert.equal(item.passCriteria, r.pass_criteria);
      assert.equal(item.weight, r.weight);
      assert.equal(item.evidence, r.evidence);
      assert.equal(item.manualInstructions, r.manual_instructions);
      assert.deepEqual(item.tags, [r.type]);
      assert.deepEqual(
        item.grader,
        r.testability === "auto-partial"
          ? { type: "hybrid", autoShare: 0.5 }
          : { type: r.testability === "auto" ? "llm" : "manual" },
      );
    }
  }
});

test("profiles share fresh local personas but keep regression results separate and secrets out of fixture prompts", () => {
  const local = loadConfig(path.join(root, "evalkit.local.yaml"));
  const regression = loadConfig(path.join(root, "evalkit.regression.yaml"));
  const production = loadConfig(path.join(root, "evalkit.production.yaml"));
  assert.equal(local.project.root, "..");
  assert.equal(local.paths.auth, regression.paths.auth);
  assert.notEqual(local.paths.baselines, regression.paths.baselines);
  assert.notEqual(local.paths.auth, production.paths.auth);
  for (const name of ["local", "production", "regression"]) {
    const data = YAML.parse(fs.readFileSync(path.join(root, `fixtures/${name}.yaml`), "utf8"));
    assert.ok(Object.values(data.data.identities).every((identity) => !("password" in identity)));
  }
  const specs = loadSpecs(path.resolve(project, local.paths.specs));
  assert.equal(
    specs.flatMap((s) => s.scenarios).find((s) => s.id === "EMB-S1").persona,
    "anonymous",
  );
  assert.ok(specs.flatMap((s) => s.rubric).every((r) => !r.applicability));
});

test("version fixtures differ and deterministic checks reject stale/extra files and malformed mail receipts", () => {
  const expected = JSON.parse(
    fs.readFileSync(path.join(root, "fixtures/files-expected.json"), "utf8"),
  );
  assert.notEqual(expected.previousSha256, expected.latestSha256);
  assert.equal(
    createHash("sha256")
      .update(fs.readFileSync(path.join(root, "fixtures/deck-v2.pdf")))
      .digest("hex"),
    expected.latestSha256,
  );
  assert.equal(zipVerdict([{ name: "deck.pdf", sha256: expected.latestSha256 }], expected), "pass");
  assert.equal(
    zipVerdict([{ name: "deck.pdf", sha256: expected.previousSha256 }], expected),
    "fail",
  );
  assert.equal(
    zipVerdict(
      [
        { name: "deck.pdf", sha256: expected.latestSha256 },
        { name: "unselected.pdf", sha256: expected.latestSha256 },
      ],
      expected,
    ),
    "fail",
  );
  const mail = { bodyIncludes: ["Hello Priya"] };
  assert.equal(
    mailVerdict(
      { version: 1, received: true, checks: [{ expected: "Hello Priya", present: true }] },
      mail,
    ),
    "pass",
  );
  assert.equal(
    mailVerdict(
      { version: 1, received: false, checks: [{ expected: "Hello Priya", present: false }] },
      mail,
    ),
    "fail",
  );
  assert.throws(() => mailVerdict({ version: 1, received: true, checks: [] }, mail));
});

test("blocked observation reduces coverage while a missing completed receipt is an execution error", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "programcue-grader-"));
  try {
    const scenario = path.join(dir, "PC-MAIL-INSPECT");
    fs.mkdirSync(scenario);
    for (const outcome of ["blocked", "completed"]) {
      fs.writeFileSync(
        path.join(scenario, "evidence.json"),
        JSON.stringify({ outcome, files: [] }),
      );
      const result = spawnSync(process.execPath, [path.join(root, "scripts/check-mail.mjs")], {
        encoding: "utf8",
        env: { ...process.env, AEK_RUN_DIR: dir },
      });
      if (outcome === "blocked") {
        assert.equal(result.status, 0);
        assert.equal(JSON.parse(result.stdout).verdict, "cannot_judge");
      } else {
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /no retained receipt/);
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
