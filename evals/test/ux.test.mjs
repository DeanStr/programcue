import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { chromium } from "playwright";
import { readCapture, sha256, surfaces, viewports } from "../scripts/ux-contract.mjs";
import { paintDifference } from "../scripts/ux-paint.mjs";

function fixture(directory) {
  fs.mkdirSync(directory);
  // A synthetic image exercises the harness only, not application quality.
  const image = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC",
    "base64",
  );
  const manifest = {
    version: 1,
    source: { revision: "a".repeat(40) },
    variant: "normal",
    methodSha256: "b".repeat(64),
    chromium: "test-fixture",
    views: surfaces.flatMap((surface) =>
      Object.entries(viewports).map(([device, viewport]) => {
        const id = `${surface.id}-${device}`;
        fs.writeFileSync(path.join(directory, `${id}.png`), image);
        return {
          id,
          surface: surface.id,
          route: surface.route,
          device,
          viewport,
          file: `${id}.png`,
          sha256: sha256(image),
          failures: [],
        };
      }),
    ),
  };
  return manifest;
}

test("UX review rejects changed images, incomplete cohorts and substituted geometry", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "programcue-ux-"));
  const capture = path.join(directory, "capture");
  const manifest = fixture(capture);
  const save = () => fs.writeFileSync(path.join(capture, "capture.json"), JSON.stringify(manifest));
  try {
    save();
    assert.equal(readCapture(capture).views.length, 40);
    manifest.views[0].viewport = { width: 800, height: 600 };
    save();
    assert.throws(() => readCapture(capture), /Invalid or duplicate/);
    manifest.views[0].viewport = viewports.desktop;
    const last = manifest.views.pop();
    save();
    assert.throws(() => readCapture(capture), /Incomplete/);
    manifest.views.push(last);
    save();
    fs.appendFileSync(path.join(capture, manifest.views[0].file), "changed");
    assert.throws(() => readCapture(capture), /integrity/);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("UX dry run previews the native Sol 6.1/high contract without creating review output", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "programcue-ux-plan-"));
  const capture = path.join(directory, "capture");
  const manifest = fixture(capture);
  fs.writeFileSync(path.join(capture, "capture.json"), JSON.stringify(manifest));
  const output = path.join(directory, "review");
  try {
    const result = spawnSync(
      process.execPath,
      [
        "scripts/ux-review.mjs",
        "--reference",
        capture,
        "--candidate",
        capture,
        "--output",
        output,
        "--views",
        "command-desktop",
        "--dry-run",
      ],
      { cwd: new URL("..", import.meta.url), encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.policy, "preference");
    assert.equal(plan.voting.minimumVotes, 5);
    assert.equal(plan.voting.maximumVotes, 5);
    assert.equal(plan.voting.agreement, 1);
    assert.match(JSON.stringify(plan), /gpt-6\.1-sol/);
    assert.match(JSON.stringify(plan), /high/);
    assert.match(JSON.stringify(plan), /visual\/UI design craft/);
    assert.doesNotMatch(JSON.stringify(plan), /better supports a conference organiser/);
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("the UI benchmark refuses substituted references and screenshot provenance", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "programcue-ui-pins-"));
  const capture = path.join(directory, "capture");
  const manifest = fixture(capture);
  const provenance = path.join(capture, "capture.json");
  const outputDir = path.join(directory, "output");
  const contextFile = path.join(directory, "context.json");
  const candidate = path.join(capture, "command-desktop.png");
  fs.writeFileSync(
    contextFile,
    JSON.stringify({
      version: 1,
      outputDir,
      sources: {
        candidate: { path: candidate },
        provenance: { path: provenance },
        reference: { path: candidate },
      },
    }),
  );
  const invoke = () =>
    spawnSync(process.execPath, ["scripts/ui-collect.mjs"], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: { ...process.env, AEK_COLLECT_CONTEXT: contextFile },
    });
  try {
    fs.writeFileSync(provenance, JSON.stringify(manifest));
    const wrongReference = invoke();
    assert.equal(wrongReference.status, 1);
    assert.match(wrongReference.stderr, /reference differs from the pinned Linear/);
    manifest.views[0].sha256 = "0".repeat(64);
    fs.writeFileSync(provenance, JSON.stringify(manifest));
    const wrongProvenance = invoke();
    assert.equal(wrongProvenance.status, 1);
    assert.match(wrongProvenance.stderr, /matching 1440×1000 command-desktop capture/);
    assert.equal(fs.existsSync(outputDir), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a matrix resumes unchanged captures but rejects changed judging inputs", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "programcue-ux-resume-"));
  const capture = path.join(directory, "capture");
  const manifest = fixture(capture);
  const provenance = path.join(capture, "capture.json");
  fs.writeFileSync(provenance, JSON.stringify(manifest));
  const output = path.join(directory, "review");
  const invoke = (...args) =>
    spawnSync(
      process.execPath,
      [
        "scripts/ux-review.mjs",
        "--reference",
        capture,
        "--candidate",
        capture,
        "--output",
        output,
        "--views",
        "command-desktop",
        ...args,
      ],
      { cwd: new URL("..", import.meta.url), encoding: "utf8" },
    );
  try {
    const first = invoke();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(output, "review.json"))).results[0].status,
      "unchanged",
    );
    assert.equal(invoke("--resume").status, 0);
    const changedJudge = invoke("--resume", "--effort", "medium");
    assert.equal(changedJudge.status, 1);
    assert.match(changedJudge.stderr, /original captures, selection, model and judging contract/);
    manifest.source.revision = "c".repeat(40);
    fs.writeFileSync(provenance, JSON.stringify(manifest));
    assert.equal(invoke("--resume").status, 1);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("native batches retain failed exact pairs, reject tampered evidence and judge changed contracts afresh", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "programcue-ux-native-"));
  const reference = path.join(directory, "reference"),
    candidate = path.join(directory, "candidate");
  const before = fixture(reference),
    after = fixture(candidate);
  const black = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64",
  );
  fs.writeFileSync(path.join(reference, before.views[0].file), black);
  before.views[0].sha256 = sha256(black);
  fs.writeFileSync(path.join(reference, "capture.json"), JSON.stringify(before));
  fs.writeFileSync(path.join(candidate, "capture.json"), JSON.stringify(after));
  const invoke = (output, ...args) =>
    spawnSync(
      process.execPath,
      [
        "scripts/ux-review.mjs",
        "--reference",
        reference,
        "--candidate",
        candidate,
        "--output",
        output,
        "--views",
        "command-desktop",
        "--judge",
        "mock",
        ...args,
      ],
      { cwd: new URL("..", import.meta.url), encoding: "utf8" },
    );
  const summary = (output) => JSON.parse(fs.readFileSync(path.join(output, "review.json")));
  try {
    const first = path.join(directory, "first"),
      second = path.join(directory, "second");
    assert.equal(invoke(first).status, 2);
    const reused = invoke(second, "--reuse", first);
    assert.equal(reused.status, 2, reused.stderr);
    assert.equal(summary(second).results[0].status, "reused");
    assert.equal(summary(second).results[0].exitCode, 2);
    const originalRun = summary(first).results[0].run,
      copiedRun = summary(second).results[0].run;
    const vote = "areas/image/pairwise/COMPARISON/IMAGE/1/vote-01/vote.json";
    assert.deepEqual(
      fs.readFileSync(path.join(originalRun, vote)),
      fs.readFileSync(path.join(copiedRun, vote)),
    );
    const render = () =>
      spawnSync(process.execPath, ["scripts/ux-report.mjs", second], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });
    const displayed = render();
    assert.equal(displayed.status, 0, displayed.stderr);
    const displayFile = path.join(second, "review.json"),
      display = JSON.parse(fs.readFileSync(displayFile));
    display.candidateDir = reference;
    fs.writeFileSync(displayFile, JSON.stringify(display));
    assert.match(render().stderr, /Native batch images differ/);
    display.candidateDir = candidate;
    fs.writeFileSync(displayFile, JSON.stringify(display));
    // Unsealed project metadata cannot replace the native batch identity.
    fs.writeFileSync(path.join(first, "review-input.json"), "changed coordinator metadata");
    assert.equal(invoke(path.join(directory, "metadata"), "--reuse", first).status, 2);
    const changed = path.join(directory, "changed-contract");
    assert.equal(invoke(changed, "--reuse", first, "--effort", "medium").status, 2);
    assert.equal(summary(changed).results[0].status, "complete");
    fs.appendFileSync(path.join(first, "batch/report.json"), "tampered");
    const corrupt = invoke(path.join(directory, "corrupt"), "--reuse", first);
    assert.equal(corrupt.status, 1);
    assert.match(corrupt.stderr, /integrity/i);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("paint reuse permits only tightly bounded raster differences", async () => {
  const browser = await chromium.launch();
  let images;
  try {
    const page = await browser.newPage();
    images = await page.evaluate(() =>
      [
        [10, 0, 0],
        [10, 64, 1],
        [10, 65, 1],
        [10, 1, 5],
        [11, 0, 0],
      ].map(([width, changed, delta]) => {
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = 10;
        const context = canvas.getContext("2d");
        const pixels = context.createImageData(width, 10);
        pixels.data.fill(255);
        for (let index = 0; index < changed; index++)
          for (let channel = 0; channel < 3; channel++) pixels.data[index * 4 + channel] -= delta;
        context.putImageData(pixels, 0, 0);
        return canvas.toDataURL("image/png").split(",")[1];
      }),
    );
  } finally {
    await browser.close();
  }
  const [before, edge, tooMany, tooLarge, wrongSize] = images.map((data) =>
    Buffer.from(data, "base64"),
  );
  assert.deepEqual(await paintDifference(before, edge), {
    changedPixels: 64,
    maximumChannelDelta: 1,
    pixelLimit: 64,
    channelDeltaLimit: 4,
  });
  for (const rejected of [tooMany, tooLarge, wrongSize])
    assert.equal(await paintDifference(before, rejected), null);
});
