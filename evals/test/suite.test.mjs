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
    .sort()
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
  assert.equal(imported.flatMap((s) => s.scenarios).length, 22);
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
      assert.deepEqual(
        item.scenarios,
        ["CFP-01", "CFP-02", "CFP-03"].includes(r.id)
          ? ["CFP-S1", "CFP-S1-PUBLIC", "CFP-S2"]
          : r.id === "ABS-14"
            ? ["ABS-S2-AI"]
            : (r.scenarios ?? []),
      );
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

test("CFP execution split preserves every original step and success signal exactly once", () => {
  const original = loadConfig(path.join(root, "upstream/specs/01-call-for-papers.yaml"));
  const spec = loadConfig(path.join(root, "specs/upstream/01-call-for-papers.yaml"));
  const publication = spec.scenarios.find((s) => s.id === "CFP-S1");
  const anonymous = spec.scenarios.find((s) => s.id === "CFP-S1-PUBLIC");
  const source = original.scenarios.find((s) => s.id === "CFP-S1");
  const steps = source.steps.split(/(?=^\d+\. )/m);
  for (const [index, step] of steps.entries()) {
    const expected = index >= 8 && index <= 10 ? anonymous : publication;
    const other = expected === anonymous ? publication : anonymous;
    assert.ok(expected.instructions.includes(step.trimEnd()), `Missing original step ${index + 1}`);
    assert.ok(
      !other.instructions.includes(step.trimEnd()),
      `Duplicated original step ${index + 1}`,
    );
  }
  assert.deepEqual(
    [...publication.successSignals, ...anonymous.successSignals].sort(),
    [...source.success_signals].sort(),
  );
  assert.equal(anonymous.persona, "anonymous");
  assert.equal(anonymous.requiresAuth, false);
  const applicant = spec.scenarios.find((s) => s.id === "CFP-S2");
  assert.deepEqual(applicant.dependsOn, [publication.id]);
  assert.deepEqual(anonymous.inputs.portalUrl, applicant.inputs.portalUrl);
  assert.match(applicant.instructions, /Always exercise original step 5/);
  for (const scenario of spec.scenarios) {
    assert.ok(!scenario.dependsOn.includes(anonymous.id));
  }
});

test("AI split retains original steps and grading without gating core review", () => {
  const source = loadConfig(path.join(root, "upstream/specs/02-abstract-management.yaml"));
  const spec = loadConfig(path.join(root, "specs/upstream/00-abstract-management.yaml"));
  const ai = spec.scenarios.find((s) => s.id === "ABS-S2-AI");
  for (const id of ["ABS-S2", "ABS-S3"]) {
    const original = source.scenarios.find((s) => s.id === id);
    const core = spec.scenarios.find((s) => s.id === id);
    const steps = original.steps.split(/(?=^\d+\. )/m);
    for (const [index, step] of steps.entries()) {
      const isAi = index === steps.length - 1;
      assert.ok((isAi ? ai : core).instructions.includes(step.trimEnd()));
      assert.ok(!(isAi ? core : ai).instructions.includes(step.trimEnd()));
    }
    assert.deepEqual(core.successSignals, original.success_signals);
  }
  assert.deepEqual(spec.rubric.find((r) => r.id === "ABS-14").scenarios, [ai.id]);
  for (const area of loadSpecs(path.join(root, "specs/upstream"))) {
    for (const scenario of area.scenarios) assert.ok(!scenario.dependsOn.includes(ai.id));
  }
});

test("AEK binds the organiser proposal handoff after blocked anonymous checks and blocks missing prerequisites", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "programcue-dependencies-"));
  try {
    const source = loadConfig(path.join(root, "specs/upstream/01-call-for-papers.yaml"));
    const abstract = loadConfig(path.join(root, "specs/upstream/00-abstract-management.yaml"));
    const ids = ["CFP-S1", "CFP-S1-PUBLIC", "CFP-S2", "ABS-S1", "CFP-S3"];
    // Exercise the installed public CLI with explicit synthetic command evidence.
    // This tests orchestration only; it never opens a browser or claims acceptance.
    fs.writeFileSync(
      path.join(dir, "collect.mjs"),
      `
      import fs from 'node:fs';
      const id = process.argv[2];
      const context = JSON.parse(fs.readFileSync(process.env.AEK_COLLECT_CONTEXT, 'utf8'));
      const publicationBlocked = process.env.DEPENDENCY_TEST_BLOCK_PUBLICATION === '1';
      const blocked = id === 'CFP-S1-PUBLIC' || (id === 'CFP-S1' && publicationBlocked);
      const portalUrl = 'https://example.com/apply';
      const proposalUrl = 'https://example.com/admin/submissions/draft-synthetic-proposal?queue=1';
      if (id === 'CFP-S3') {
        if (context.inputs.proposalUrl.value !== proposalUrl) throw new Error('Lost organiser proposal binding');
      } else if (['CFP-S1-PUBLIC', 'CFP-S2'].includes(id) && context.inputs.portalUrl.value !== portalUrl) throw new Error('Lost portal binding');
      const url = id === 'CFP-S1' ? portalUrl : proposalUrl;
      const name = id === 'CFP-S1' ? 'portalUrl' : 'proposalUrl';
      console.log(JSON.stringify({version: 1, outcome: blocked ? 'blocked' : 'completed',
        summary: 'Synthetic dependency test, not product evidence', observations: [],
        ...(blocked || !['CFP-S1', 'CFP-S2'].includes(id) ? {} : {outputs: {[name]: {value: url, evidenceRefs: ['step:1']}}})}));
    `,
    );
    fs.writeFileSync(
      path.join(dir, "spec.yaml"),
      YAML.stringify({
        ...source,
        weight: 100,
        scenarios: [...source.scenarios, ...abstract.scenarios]
          .filter((s) => ids.includes(s.id))
          .map((s) => ({
            id: s.id,
            name: s.name,
            instructions: s.instructions,
            dependsOn: s.dependsOn,
            inputs: s.inputs,
            outputs: s.outputs,
            kind: "command",
            requiresAuth: false,
            collect: { command: `node collect.mjs ${s.id}`, methodFiles: ["collect.mjs"] },
          })),
        rubric: source.rubric.filter((r) => ["CFP-01", "CFP-02", "CFP-03"].includes(r.id)),
      }),
    );
    for (const publicationBlocked of [false, true]) {
      const runRoot = publicationBlocked ? "blocked-runs" : "published-runs";
      fs.writeFileSync(
        path.join(dir, "config.yaml"),
        YAML.stringify({
          version: 1,
          project: { name: "Synthetic dependency contract", root: "." },
          target: { kind: "repository" },
          agent: { provider: "mock" },
          judge: { provider: "mock" },
          paths: { specs: "spec.yaml", runs: runRoot },
        }),
      );
      const result = spawnSync(process.execPath, [aek, "collect", "--config", "config.yaml"], {
        cwd: dir,
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, DEPENDENCY_TEST_BLOCK_PUBLICATION: publicationBlocked ? "1" : "0" },
      });
      assert.equal(result.status, 0, result.stderr + result.stdout);
      const runs = fs.readdirSync(path.join(dir, runRoot));
      assert.equal(runs.length, 1);
      const runDir = path.join(dir, runRoot, runs[0]);
      const evidence = (id) =>
        JSON.parse(fs.readFileSync(path.join(runDir, id, "evidence.json"), "utf8"));
      assert.equal(evidence("CFP-S1-PUBLIC").outcome, "blocked");
      assert.equal(evidence("CFP-S2").outcome, publicationBlocked ? "blocked" : "completed");
      assert.equal(evidence("CFP-S3").outcome, publicationBlocked ? "blocked" : "completed");
      if (!publicationBlocked) {
        assert.equal(evidence("CFP-S2").inputs.portalUrl.value, "https://example.com/apply");
        assert.equal(
          evidence("CFP-S3").inputs.proposalUrl.value,
          "https://example.com/admin/submissions/draft-synthetic-proposal?queue=1",
        );
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("profiles share fresh local personas but keep regression results separate and secrets out of fixture prompts", () => {
  const local = loadConfig(path.join(root, "evalkit.local.yaml"));
  const regression = loadConfig(path.join(root, "evalkit.regression.yaml"));
  const production = loadConfig(path.join(root, "evalkit.production.yaml"));
  for (const config of [local, production]) {
    assert.equal(config.variables.canonicalEvent, "DevFlow Conf 2027");
    assert.equal(config.variables.canonicalPublicPath, "/public/programme/devflow-conf-2027");
  }
  assert.equal(local.project.root, "..");
  assert.equal(local.paths.auth, regression.paths.auth);
  assert.notEqual(local.paths.baselines, regression.paths.baselines);
  assert.notEqual(local.paths.auth, production.paths.auth);
  assert.deepEqual(production.target.allowedOrigins, ["https://challenges.cloudflare.com"]);
  assert.match(
    production.instructions,
    /synthetic CI proposal's submitted content and Initial Review rubric/,
  );
  assert.match(
    production.instructions,
    /explicitly authorizes that fixture payload and destination/,
  );
  assert.match(production.instructions, /does not authorize real customer data/);
  for (const config of [local, production, regression]) {
    assert.deepEqual(config.browser.readOnlyFrames, [
      {
        pathPrefix: "/admin/communications/",
        selector: 'iframe.email-preview-frame[title^="Representative merged email"]',
      },
    ]);
  }
  for (const name of ["local", "production", "regression"]) {
    const data = YAML.parse(fs.readFileSync(path.join(root, `fixtures/${name}.yaml`), "utf8"));
    assert.ok(Object.values(data.data.identities).every((identity) => !("password" in identity)));
    assert.equal(
      data.data.identities.organizer.name,
      name === "local" ? "Morgan Chen" : "Jordan Alvarez",
    );
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

test("AEK preserves review prerequisites while upload blockers leave content setup, scheduling and CRM reachable", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "programcue-review-sequence-"));
  try {
    const specs = loadSpecs(path.join(root, "specs/upstream"));
    const selected = specs;
    const declarations = Object.fromEntries(
      selected.flatMap((s) => s.scenarios.map((scenario) => [scenario.id, scenario])),
    );
    fs.writeFileSync(path.join(directory, "declarations.json"), JSON.stringify(declarations));
    fs.writeFileSync(
      path.join(directory, "collect.mjs"),
      `
      import fs from 'node:fs';
      const id = process.argv[2];
      const declarations = JSON.parse(fs.readFileSync('declarations.json', 'utf8'));
      const prior = fs.existsSync('order.json') ? JSON.parse(fs.readFileSync('order.json', 'utf8')) : [];
      if (id === 'CFP-S3' && !prior.includes('ABS-S1')) throw new Error('Review locked revisions before co-author setup');
      if (id === 'ABS-S2' && !prior.includes('CFP-S3')) throw new Error('Round progression preceded source review');
      if (id === 'CFP-S4' && !prior.includes('ABS-S3')) throw new Error('Abstract scoring did not precede decisions');
      prior.push(id); fs.writeFileSync('order.json', JSON.stringify(prior));
      const blocked = id === 'CFP-S1-PUBLIC' || id === 'ABS-S2-AI' || (id === 'ABS-S2' && process.env.SEQUENCE_BLOCK === 'reviews') || (['SPK-S2', 'CNT-S2'].includes(id) && process.env.SEQUENCE_BLOCK === 'uploads');
      const outputs = Object.fromEntries(Object.keys(declarations[id].outputs ?? {}).map(name => [name, {value: 'https://example.com/' + name, evidenceRefs: ['step:1']}]));
      console.log(JSON.stringify({version: 1, outcome: blocked ? 'blocked' : 'completed',
        summary: 'Synthetic ordering evidence; not product acceptance', observations: [], ...(blocked ? {} : {outputs})}));
    `,
    );
    fs.mkdirSync(path.join(directory, "specs"));
    for (const [index, spec] of selected.entries()) {
      fs.writeFileSync(
        path.join(directory, "specs", `${index}.yaml`),
        YAML.stringify({
          id: spec.id,
          title: spec.title,
          weight: spec.weight,
          optional: spec.optional,
          description: "Synthetic dependency contract",
          scenarios: spec.scenarios.map((s) => ({
            id: s.id,
            name: s.name,
            instructions: s.instructions,
            dependsOn: s.dependsOn,
            inputs: s.inputs,
            outputs: s.outputs,
            kind: "command",
            requiresAuth: false,
            collect: {
              command: `node collect.mjs ${s.id}`,
              methodFiles: ["collect.mjs", "declarations.json"],
            },
          })),
          rubric: [
            {
              id: `SYNTHETIC-${index}`,
              criterion: "Synthetic order only",
              passCriteria: "Required collection order is preserved",
              weight: 1,
              scenarios: spec.scenarios.map((s) => s.id),
              grader: { type: "llm" },
            },
          ],
        }),
      );
    }
    for (const mode of ["none", "reviews", "uploads"]) {
      const blocked = mode === "reviews";
      const runs = `${mode}-runs`;
      fs.rmSync(path.join(directory, "order.json"), { force: true });
      fs.writeFileSync(
        path.join(directory, "config.yaml"),
        YAML.stringify({
          version: 1,
          project: { name: "Synthetic review sequencing", root: "." },
          target: { kind: "repository" },
          agent: { provider: "mock" },
          judge: { provider: "mock" },
          paths: { specs: "specs", runs },
        }),
      );
      const result = spawnSync(
        process.execPath,
        [aek, "collect", "--config", "config.yaml", "--include-optional"],
        {
          cwd: directory,
          encoding: "utf8",
          timeout: 30_000,
          env: { ...process.env, SEQUENCE_BLOCK: mode },
        },
      );
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const run = path.join(directory, runs, fs.readdirSync(path.join(directory, runs))[0]);
      const evidence = (id) =>
        JSON.parse(fs.readFileSync(path.join(run, id, "evidence.json"), "utf8"));
      const order = JSON.parse(fs.readFileSync(path.join(directory, "order.json"), "utf8"));
      assert.ok(order.indexOf("CFP-S2") < order.indexOf("ABS-S1"));
      assert.ok(order.indexOf("ABS-S1") < order.indexOf("CFP-S3"));
      assert.ok(order.indexOf("CFP-S3") < order.indexOf("ABS-S2"));
      assert.equal(evidence("CFP-S4").outcome, blocked ? "blocked" : "completed");
      assert.equal(evidence("SPK-S1").outcome, blocked ? "blocked" : "completed");
      assert.equal(evidence("CNT-S1").outcome, blocked ? "blocked" : "completed");
      assert.equal(evidence("AIA-S1").outcome, blocked ? "blocked" : "completed");
      assert.equal(evidence("AIA-S2").outcome, blocked ? "blocked" : "completed");
      assert.equal(evidence("EMB-S1").outcome, blocked ? "blocked" : "completed");
      assert.equal(evidence("CRM-S1").outcome, "completed");
      assert.equal(evidence("CRM-S2").outcome, "completed");
      if (mode === "uploads") {
        assert.equal(evidence("SPK-S2").outcome, "blocked");
        assert.equal(evidence("SPK-S3").outcome, "blocked");
        assert.equal(evidence("CNT-S2").outcome, "blocked");
        assert.equal(evidence("CNT-S3").outcome, "blocked");
        assert.ok(!order.includes("SPK-S3"));
        assert.ok(!order.includes("CNT-S3"));
      }
      if (!blocked) {
        for (const id of ["CNT-S1", "AIA-S1"])
          assert.equal(evidence(id).inputs.sessionUrl.value, "https://example.com/sessionUrl");
        assert.equal(evidence("ABS-S2-AI").outcome, "blocked");
        assert.ok(order.indexOf("ABS-S3") < order.indexOf("ABS-S2-AI"));
        assert.ok(order.indexOf("ABS-S2-AI") < order.indexOf("CFP-S4"));
        assert.ok(order.indexOf("ABS-S3") < order.indexOf("CFP-S4"));
        assert.equal(evidence("SPK-S1").inputs.sessionUrl.value, "https://example.com/sessionUrl");
      }
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("acceptance setup includes published templates and an authenticated co-speaker claim", () => {
  const specs = loadSpecs(path.join(root, "specs/upstream"));
  const scenarios = specs.flatMap((spec) => spec.scenarios);
  const setup = scenarios.find((scenario) => scenario.id === "CFP-S1");
  assert.match(setup.instructions, /Submission confirmation and Decision/);
  const coSpeaker = scenarios.find((scenario) => scenario.id === "ABS-S1");
  assert.ok(coSpeaker.allowedPersonas.includes("co_speaker"));
  assert.deepEqual(coSpeaker.inputs.portalUrl, { from: "CFP-S1", output: "portalUrl" });
  assert.match(coSpeaker.instructions, /Claim speaker profile/);
  assert.match(coSpeaker.instructions, /fixture login alone does not claim the invitation/);
});
