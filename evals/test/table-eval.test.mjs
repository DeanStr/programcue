import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { chromium } from "playwright";
import YAML from "yaml";
import { prepareTables, tableFrame } from "../scripts/table-prepare.mjs";
import { retainedTableVerdict } from "../scripts/table-verdict.mjs";
import { sha256, surfaces, viewports } from "../scripts/ux-contract.mjs";

const cwd = new URL("..", import.meta.url);
async function syntheticImage(page, width, height) {
  return Buffer.from(
    await page.evaluate(
      ({ width, height }) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const context = canvas.getContext("2d");
        context.fillStyle = "white";
        context.fillRect(0, 0, width, height);
        context.fillStyle = "#123456";
        context.fillRect(254, 247, 1, 1);
        context.fillStyle = "#abcdef";
        context.fillRect(255, 247, 1, 1);
        return canvas.toDataURL("image/png").split(",")[1];
      },
      { width, height },
    ),
    "base64",
  );
}
function captureFixture(directory, images) {
  fs.mkdirSync(directory);
  const capture = {
    version: 1,
    source: { revision: "a".repeat(40) },
    variant: "normal",
    chromium: "synthetic-harness-only",
    methodSha256: "b".repeat(64),
    views: surfaces.flatMap((surface) =>
      Object.entries(viewports).map(([device, viewport]) => {
        const id = `${surface.id}-${device}`;
        const file = `${id}.png`;
        fs.writeFileSync(path.join(directory, file), images[device]);
        return {
          id,
          surface: surface.id,
          route: surface.route,
          device,
          viewport,
          file,
          sha256: sha256(images[device]),
          failures: [],
        };
      }),
    ),
  };
  fs.writeFileSync(path.join(directory, "capture.json"), JSON.stringify(capture));
  return capture;
}

test("table frames preserve adjacent native pixels and reject enlargement or out-of-bounds crops", async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const source = await syntheticImage(page, 1440, 1000);
    const frame = await tableFrame(page, source, { x: 254, y: 247, width: 1162, height: 400 }, 1);
    assert.deepEqual(frame.placement, { x: 33, y: 15, width: 1162, height: 400, scale: 1 });
    const samples = await page.evaluate(
      async (data) => {
        const image = await createImageBitmap(await (await fetch(data)).blob());
        const canvas = new OffscreenCanvas(image.width, image.height);
        const context = canvas.getContext("2d");
        context.drawImage(image, 0, 0);
        return [...context.getImageData(33, 15, 2, 1).data];
      },
      `data:image/png;base64,${frame.bytes.toString("base64")}`,
    );
    assert.deepEqual(samples, [0x12, 0x34, 0x56, 255, 0xab, 0xcd, 0xef, 255]);
    await assert.rejects(
      tableFrame(page, source, { x: 0, y: 0, width: 10, height: 10 }, 1.06),
      /cannot enlarge/,
    );
    await assert.rejects(
      tableFrame(page, source, { x: 1439, y: 0, width: 2, height: 2 }, 1),
      /exceeds its source/,
    );
  } finally {
    await browser.close();
  }
});

test("table preparation scopes quality to the two supplied cases and collection rejects changed pixels", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "programcue-table-eval-"));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const images = {
      desktop: await syntheticImage(page, 1440, 1000),
      mobile: await syntheticImage(page, 390, 844),
    };
    const capture = path.join(directory, "capture");
    const before = path.join(directory, "before");
    captureFixture(capture, images);
    captureFixture(before, images);
    const output = await prepareTables(capture, path.join(directory, "review"), before);
    const spec = YAML.parse(fs.readFileSync(path.join(output, "specs/tables.yaml"), "utf8"));
    assert.equal(spec.scenarios.length, 2);
    assert.equal(spec.rubric.length, 2);
    for (const scenario of spec.scenarios) {
      assert.equal(spec.rubric.filter((item) => item.scenarios.includes(scenario.id)).length, 1);
    }
    const batch = JSON.parse(fs.readFileSync(path.join(output, "comparisons.json")));
    assert.equal(batch.comparisons.length, 2);
    assert.equal(batch.defaults.policy, "preference");
    assert.equal(batch.defaults.judgeModel, "gpt-6.1-sol");
    assert.equal(batch.defaults.capacityRetries, 2);
    assert.equal(batch.defaults.voting.agreement, 1);
    const config = YAML.parse(fs.readFileSync(path.join(output, "evalkit.yaml"), "utf8"));
    assert.equal(config.judge.model, "gpt-6.1-sol");
    assert.equal(config.judge.effort, "high");
    assert.deepEqual(config.judge.voting, { minimumVotes: 5, maximumVotes: 5, agreement: 1 });
    const selectedOutput = await prepareTables(
      capture,
      path.join(directory, "directory-only"),
      before,
      ["DIRECTORY"],
    );
    const selectedSpec = YAML.parse(
      fs.readFileSync(path.join(selectedOutput, "specs/tables.yaml"), "utf8"),
    );
    assert.deepEqual(
      selectedSpec.scenarios.map((item) => item.id),
      ["DIRECTORY"],
    );
    assert.deepEqual(
      selectedSpec.rubric.map((item) => item.scenarios),
      [["DIRECTORY"]],
    );
    await assert.rejects(
      prepareTables(capture, path.join(directory, "unknown-case"), before, ["UNKNOWN"]),
      /known, distinct/,
    );
    const manifest = JSON.parse(fs.readFileSync(path.join(output, "table-input.json")));
    const item = manifest.cases[0];
    const sources = {
      manifest: { path: path.join(output, "table-input.json") },
      ...Object.fromEntries(
        Object.entries(item.inputs).map(([label, input]) => [
          label,
          { path: path.join(output, input.file) },
        ]),
      ),
    };
    const context = path.join(directory, "context.json");
    fs.writeFileSync(
      context,
      JSON.stringify({ outputDir: path.join(directory, "collected"), sources }),
    );
    const invoke = () =>
      spawnSync(process.execPath, ["scripts/table-collect.mjs", item.id], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, AEK_COLLECT_CONTEXT: context },
      });
    let result = invoke();
    assert.equal(result.status, 0, result.stderr);
    fs.appendFileSync(sources.candidate.path, "changed bytes");
    result = invoke();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Table input changed: candidate/);
    await assert.rejects(
      prepareTables(capture, path.join(directory, "review"), before),
      /must be a new directory/,
    );
    manifest.capture.views.at(-1).failures.push("injected browser failure");
    fs.writeFileSync(sources.manifest.path, JSON.stringify(manifest));
    assert.match(invoke().stderr, /forty healthy/);
  } finally {
    await browser.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("retention requires five preferences and fresh desktop/mobile quality without borrowing stale votes", () => {
  // Synthetic verdicts exercise the admission rule only; these are not model/design evidence.
  const input = (candidate, mobile = "mobile") => ({
    inputs: {
      candidate: { sha256: candidate },
      fullview: { sha256: "desktop" },
      mobile: { sha256: mobile },
    },
  });
  const baseline = input("before"),
    current = input("after");
  const history = [
    {
      name: "revision-01",
      mode: "improvement",
      input: current,
      quality: { pass: 5 },
      data: { decision: { counts: { win: 5 } } },
    },
  ];
  assert.equal(
    retainedTableVerdict(current, baseline, history, { viewportPassed: true }).accepted,
    true,
  );
  const pending = retainedTableVerdict(current, baseline, history);
  assert.equal(pending.componentAccepted, true);
  assert.equal(pending.accepted, false);
  const guarded = retainedTableVerdict(current, baseline, history, {
    unchangedPaint: { changedPixels: 1, maximumChannelDelta: 1 },
    viewportPassed: true,
  });
  assert.equal(guarded.unchanged, true);
  assert.equal(guarded.accepted, false);
  const changedMobile = retainedTableVerdict(input("after", "changed-mobile"), baseline, history, {
    viewportPassed: true,
  });
  assert.equal(changedMobile.improvement, "revision-01");
  assert.equal(changedMobile.qualitySource, undefined);
  assert.equal(changedMobile.accepted, false);
  assert.equal(
    retainedTableVerdict(input("different"), baseline, history, { viewportPassed: true }).accepted,
    false,
  );
  history[0].data.decision.counts = { win: 4, loss: 1 };
  assert.equal(
    retainedTableVerdict(current, baseline, history, { viewportPassed: true }).accepted,
    false,
  );
  history.push({
    name: "revision-02",
    mode: "improvement",
    input: current,
    quality: { pass: 5 },
    data: { decision: { counts: { win: 5 } } },
  });
  assert.equal(
    retainedTableVerdict(current, baseline, history, { viewportPassed: true }).accepted,
    false,
    "a later unanimous round must not erase an earlier split for the same pixels",
  );
  history.pop();
  history[0].data.decision.counts = { win: 5 };
  history[0].quality = { pass: 4, cannot_judge: 1 };
  assert.equal(
    retainedTableVerdict(current, baseline, history, { viewportPassed: true }).accepted,
    false,
  );
  assert.equal(retainedTableVerdict(current, current, history).unchanged, true);
});
