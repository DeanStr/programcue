import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { chromium } from "playwright";
import { benchmarks, references, saasMethod } from "../scripts/saas-references.mjs";
import { sha256, surfaces, viewports } from "../scripts/ux-contract.mjs";

const cwd = new URL("..", import.meta.url);
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4//8/AAX+Av5Y8msOAAAAAElFTkSuQmCC",
  "base64",
);
function fixture(directory, bytes = pixel) {
  fs.mkdirSync(directory);
  const capture = {
    version: 1,
    source: { revision: "a".repeat(40) },
    variant: "normal",
    chromium: "synthetic-harness-test",
    methodSha256: "b".repeat(64),
    views: surfaces.flatMap((surface) =>
      Object.entries(viewports).map(([device, viewport]) => {
        const id = `${surface.id}-${device}`;
        fs.writeFileSync(path.join(directory, `${id}.png`), bytes);
        return {
          id,
          surface: surface.id,
          route: surface.route,
          device,
          viewport,
          file: `${id}.png`,
          sha256: sha256(bytes),
          failures: [],
          heading: {
            text: surface.id,
            fontFamily: "system-ui",
            fontSize: "30px",
            fontWeight: "700",
            lineHeight: "34.5px",
            letterSpacing: "-1px",
            bounds: { x: 0, y: 0, width: 1, height: 1 },
          },
          headerControls: [],
        };
      }),
    ),
  };
  return capture;
}
test("SaaS collection rejects substituted pixels, unhealthy siblings and changed reference assets", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "programcue-saas-input-"));
  try {
    const captureDir = path.join(dir, "capture");
    const original = fixture(captureDir);
    const candidate = path.join(captureDir, "applications-desktop.png");
    const provenance = path.join(captureDir, "capture.json");
    const reference = path.join(dir, "reference.png");
    fs.writeFileSync(reference, pixel);
    const context = path.join(dir, "context.json");
    fs.writeFileSync(
      context,
      JSON.stringify({
        outputDir: path.join(dir, "output"),
        sources: {
          candidate: { path: candidate },
          provenance: { path: provenance },
          reference: { path: reference },
        },
      }),
    );
    const invoke = () =>
      spawnSync(process.execPath, ["scripts/saas-collect.mjs", "APPLICATIONS"], {
        cwd,
        env: { ...process.env, AEK_COLLECT_CONTEXT: context },
        encoding: "utf8",
      });
    fs.writeFileSync(provenance, JSON.stringify(original));
    let result = invoke();
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /reference differs/);
    fs.appendFileSync(candidate, "changed");
    result = invoke();
    assert.match(result.stderr, /healthy matching/);
    fs.writeFileSync(candidate, pixel);
    original.views.at(-1).failures.push("injected browser failure");
    fs.writeFileSync(provenance, JSON.stringify(original));
    result = invoke();
    assert.match(result.stderr, /healthy matching/);
    assert.equal(fs.existsSync(path.join(dir, "output")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("reports retain failures for matching crop pixels and reject stale judgments after an in-crop change", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "programcue-saas-report-"));
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    const makeImage = async (point) =>
      Buffer.from(
        await page.evaluate((point) => {
          const canvas = document.createElement("canvas");
          canvas.width = 1440;
          canvas.height = 1000;
          const context = canvas.getContext("2d");
          context.fillStyle = "white";
          context.fillRect(0, 0, 1440, 1000);
          if (point) {
            context.fillStyle = "black";
            context.fillRect(point.x, point.y, 1, 1);
          }
          return canvas.toDataURL("image/png").split(",")[1];
        }, point),
        "base64",
      );
    const before = await makeImage(null);
    const outside = await makeImage({ x: 1400, y: 900 });
    const inside = await makeImage({ x: 20, y: 80 });
    await browser.close();
    const captureDir = path.join(dir, "capture");
    const capture = fixture(captureDir, outside);
    const manifest = path.join(captureDir, "capture.json");
    fs.writeFileSync(manifest, JSON.stringify(capture));
    const iteration = path.join(dir, "iteration");
    const run = path.join(iteration, "runs/harness-only");
    const comparison = path.join(run, "areas/saas/pairwise/NAVIGATION/NAVIGATION/1");
    fs.mkdirSync(comparison, { recursive: true });
    fs.mkdirSync(path.join(run, "NAVIGATION/screenshots"), { recursive: true });
    fs.writeFileSync(path.join(run, "NAVIGATION/screenshots/candidate.png"), before);
    fs.writeFileSync(
      path.join(comparison, "comparison.json"),
      JSON.stringify({
        decision: { counts: { loss: 5 } },
        votes: [],
      }),
    );
    fs.writeFileSync(
      path.join(iteration, "benchmark-input.json"),
      JSON.stringify({
        method: saasMethod,
        references,
        benchmarks,
      }),
    );
    const invoke = (name) =>
      spawnSync(
        process.execPath,
        [
          "scripts/saas-report.mjs",
          "--iteration",
          iteration,
          "--capture",
          captureDir,
          "--output",
          path.join(dir, name),
        ],
        { cwd, encoding: "utf8" },
      );
    const result = invoke("outside");
    assert.equal(result.status, 0, result.stderr);
    let summary = JSON.parse(fs.readFileSync(path.join(dir, "outside/benchmark-summary.json")));
    assert.equal(summary.cases[0].history[0].matchesCurrent, true);
    assert.deepEqual(summary.cases[0].history[0].decision.counts, { loss: 5 });
    const view = capture.views.find((view) => view.id === "command-desktop");
    fs.writeFileSync(path.join(captureDir, view.file), inside);
    view.sha256 = sha256(inside);
    fs.writeFileSync(manifest, JSON.stringify(capture));
    const changed = invoke("inside");
    assert.equal(changed.status, 0, changed.stderr);
    summary = JSON.parse(fs.readFileSync(path.join(dir, "inside/benchmark-summary.json")));
    assert.equal(summary.cases[0].history[0].matchesCurrent, false);
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("SaaS preparation rejects a failed browser cohort before creating output or downloading references", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "programcue-saas-prepare-"));
  try {
    const captureDir = path.join(dir, "capture"),
      output = path.join(dir, "review");
    const capture = fixture(captureDir);
    capture.views.at(-1).failures.push("injected browser failure");
    fs.writeFileSync(path.join(captureDir, "capture.json"), JSON.stringify(capture));
    const result = spawnSync(
      process.execPath,
      ["scripts/saas-prepare.mjs", "--capture", captureDir, "--output", output],
      { cwd, encoding: "utf8" },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /all forty browser views/);
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test("cross-page consistency detects style drift and blocks unhealthy captures", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "programcue-title-consistency-"));
  try {
    const captureDir = path.join(dir, "capture");
    const capture = fixture(captureDir);
    const save = () =>
      fs.writeFileSync(path.join(captureDir, "capture.json"), JSON.stringify(capture));
    const invoke = (name) =>
      spawnSync(
        process.execPath,
        ["scripts/ui-consistency.mjs", "--capture", captureDir, "--output", path.join(dir, name)],
        { cwd, encoding: "utf8" },
      );
    save();
    assert.equal(invoke("consistent").status, 0);
    capture.views.find((view) => view.id === "evaluation-mobile").heading.letterSpacing = "0px";
    save();
    assert.equal(invoke("drift").status, 2);
    const result = JSON.parse(fs.readFileSync(path.join(dir, "drift/consistency.json")));
    assert.equal(result.groups.mobile.signatures, 2);
    assert.equal(result.groups.desktop.signatures, 1);
    capture.views[0].failures.push("injected browser failure");
    save();
    assert.match(invoke("unhealthy").stderr, /all browser views/);
    assert.equal(fs.existsSync(path.join(dir, "unhealthy")), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
