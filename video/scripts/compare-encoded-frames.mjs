#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "../..");
const artifactsDirectory = path.join(repoRoot, ".artifacts");
const sourceDirectory = path.join(artifactsDirectory, "video-review");
const outputDirectory = path.join(artifactsDirectory, "encoded-review");
const masterPath = path.join(artifactsDirectory, "program-cue-launch.mp4");
const ffmpegBinary = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
const minimumSsim = 0.95;

const fail = (message, detail = "") => {
  throw new Error(
    `[video:compare] ${message}${detail ? `\n${detail.trimEnd()}` : ""}`,
  );
};

const isContained = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

const assertContained = (parent, candidate, label) => {
  if (!isContained(parent, candidate)) {
    fail(`${label} escapes ${path.relative(repoRoot, parent) || "."}.`);
  }
};

const run = (args) =>
  spawnSync(ffmpegBinary, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

const readSourceEvidence = () => {
  const manifestPath = path.join(sourceDirectory, "manifest.json");
  if (!fs.existsSync(masterPath) || fs.statSync(masterPath).size === 0) {
    fail("Encoded master is missing or empty.");
  }
  if (!fs.existsSync(manifestPath)) {
    fail("Source review manifest is missing. Run npm run video:frames first.");
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail(
      "Source review manifest is not valid JSON.",
      error instanceof Error ? error.message : String(error),
    );
  }
  if (
    !Number.isInteger(manifest?.fps) ||
    manifest.fps <= 0 ||
    !Number.isInteger(manifest?.totalFrames) ||
    manifest.totalFrames <= 0
  ) {
    fail("Source review manifest has invalid fps or totalFrames metadata.");
  }
  if (!Array.isArray(manifest.frames) || manifest.frames.length === 0) {
    fail("Source review manifest contains no curated frames.");
  }
  if (!Array.isArray(manifest.boundaries) || manifest.boundaries.length === 0) {
    fail(
      "Source review manifest contains no boundary frames. Regenerate it with npm run video:frames.",
    );
  }

  const sourceRoot = fs.realpathSync(sourceDirectory);
  const readItems = (items, category) => {
    const seenFrames = new Set();
    return items.map((item, index) => {
      if (
        !Number.isInteger(item?.frame) ||
        item.frame < 0 ||
        item.frame >= manifest.totalFrames
      ) {
        fail(`${category} item ${index + 1} has an invalid frame number.`);
      }
      if (seenFrames.has(item.frame)) {
        fail(`${category} frame ${item.frame} is duplicated in the manifest.`);
      }
      seenFrames.add(item.frame);
      if (typeof item.file !== "string" || item.file.length === 0) {
        fail(`${category} frame ${item.frame} has no source path.`);
      }
      const source = path.resolve(repoRoot, item.file);
      assertContained(sourceDirectory, source, `${category} source path`);
      if (!fs.existsSync(source)) {
        fail(
          `Source ${category} is missing: ${path.relative(repoRoot, source)}`,
        );
      }
      const realSource = fs.realpathSync(source);
      assertContained(sourceRoot, realSource, `${category} real source path`);
      const stat = fs.statSync(realSource);
      if (!stat.isFile() || stat.size === 0) {
        fail(`Source ${category} is not a non-empty file: ${item.file}`);
      }
      if (Number.isInteger(item.bytes) && item.bytes !== stat.size) {
        fail(
          `Source ${category} size changed for frame ${item.frame}: manifest ${item.bytes}, current ${stat.size}.`,
        );
      }
      return {
        ...item,
        category,
        source: realSource,
      };
    });
  };

  const curated = readItems(manifest.frames, "curated");
  const boundaries = readItems(manifest.boundaries, "boundary");
  const uniqueFrames = [
    ...new Set([...curated, ...boundaries].map((item) => item.frame)),
  ]
    .sort((left, right) => left - right)
    .map((frame) => ({ frame }));
  return {
    manifestPath,
    manifest,
    curated,
    boundaries,
    uniqueFrames,
  };
};

const frameFile = (frame, padding) =>
  `encoded-${String(frame).padStart(padding, "0")}.png`;

const extractFrames = (items, stagingOutput, padding) => {
  const expression = items.map(({ frame }) => `eq(n\\,${frame})`).join("+");
  const sequencePattern = path.join(stagingOutput, "decoded-%05d.png");
  const result = run([
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-y",
    "-i",
    masterPath,
    "-vf",
    `select='${expression}'`,
    "-fps_mode",
    "vfr",
    "-start_number",
    "0",
    sequencePattern,
  ]);
  if (result.error || result.status !== 0) {
    fail(
      "Could not decode the evidence frames.",
      result.error?.message ?? result.stderr ?? `exit ${result.status}`,
    );
  }
  for (const [index, item] of items.entries()) {
    const decoded = path.join(
      stagingOutput,
      `decoded-${String(index).padStart(5, "0")}.png`,
    );
    if (!fs.existsSync(decoded) || fs.statSync(decoded).size === 0) {
      fail(`Decoded canary ${index} for frame ${item.frame} is missing.`);
    }
    const encoded = path.join(stagingOutput, frameFile(item.frame, padding));
    assertContained(stagingOutput, encoded, "Decoded evidence output");
    fs.renameSync(decoded, encoded);
    item.encoded = encoded;
  }
};

const compareFrames = (items, encodedByFrame, fps, padding) =>
  items.map((item) => {
    const encoded = encodedByFrame.get(item.frame);
    if (!encoded)
      fail(`No decoded frame exists for source frame ${item.frame}.`);
    const result = run([
      "-hide_banner",
      "-nostdin",
      "-i",
      item.source,
      "-i",
      encoded,
      "-lavfi",
      "ssim",
      "-f",
      "null",
      "-",
    ]);
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    const match = output.match(/All:([0-9.]+)/);
    const ssim = match ? Number(match[1]) : null;
    if (result.error || result.status !== 0 || ssim === null) {
      fail(
        `SSIM comparison failed for ${item.category} frame ${item.frame}.`,
        result.error?.message ?? result.stderr ?? `exit ${result.status}`,
      );
    }
    return {
      category: item.category,
      frame: item.frame,
      timeSeconds: Number((item.frame / fps).toFixed(3)),
      scene: item.scene,
      beat: item.beat,
      boundaryFrame: item.boundaryFrame,
      offset: item.offset,
      fromScene: item.fromScene,
      toScene: item.toScene,
      source: path.relative(repoRoot, item.source),
      encoded: path.relative(
        repoRoot,
        path.join(outputDirectory, frameFile(item.frame, padding)),
      ),
      ssim,
      passed: ssim >= minimumSsim,
    };
  });

const copyCategoryFrames = (items, directory, encodedByFrame, padding) => {
  fs.mkdirSync(directory, { recursive: true });
  for (const item of items) {
    const source = encodedByFrame.get(item.frame);
    if (!source)
      fail(`No decoded frame exists for category frame ${item.frame}.`);
    const destination = path.join(directory, frameFile(item.frame, padding));
    assertContained(directory, destination, "Category frame output");
    fs.copyFileSync(source, destination);
  }
};

const makeContactSheet = (sourceGlob, output, columns, itemCount) => {
  if (itemCount === 0) fail(`Cannot build empty ${path.basename(output)}.`);
  const rows = Math.ceil(itemCount / columns);
  const result = run([
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-y",
    "-pattern_type",
    "glob",
    "-framerate",
    "1",
    "-i",
    sourceGlob,
    "-vf",
    `scale=480:270:flags=lanczos,tile=${columns}x${rows}:padding=12:margin=12:color=#0b1413`,
    "-frames:v",
    "1",
    "-q:v",
    "2",
    output,
  ]);
  if (
    result.error ||
    result.status !== 0 ||
    !fs.existsSync(output) ||
    fs.statSync(output).size === 0
  ) {
    fail(
      `Could not build ${path.basename(output)}.`,
      result.error?.message ?? result.stderr ?? `exit ${result.status}`,
    );
  }
};

const publishOutput = (stagingOutput) => {
  fs.rmSync(outputDirectory, { force: true, recursive: true });
  fs.renameSync(stagingOutput, outputDirectory);
};

const main = () => {
  const evidence = readSourceEvidence();
  fs.mkdirSync(artifactsDirectory, { recursive: true });
  const stagingDirectory = fs.mkdtempSync(
    path.join(artifactsDirectory, ".encoded-review-stage-"),
  );
  const stagingOutput = path.join(stagingDirectory, "publication");
  fs.mkdirSync(stagingOutput, { recursive: true });
  try {
    const padding = String(evidence.manifest.totalFrames - 1).length;
    extractFrames(evidence.uniqueFrames, stagingOutput, padding);
    const encodedByFrame = new Map(
      evidence.uniqueFrames.map((item) => [item.frame, item.encoded]),
    );
    const allEvidence = [...evidence.curated, ...evidence.boundaries];
    const comparisons = compareFrames(
      allEvidence,
      encodedByFrame,
      evidence.manifest.fps,
      padding,
    );

    const curatedDirectory = path.join(stagingOutput, "curated");
    const boundaryDirectory = path.join(stagingOutput, "boundaries");
    copyCategoryFrames(
      evidence.curated,
      curatedDirectory,
      encodedByFrame,
      padding,
    );
    copyCategoryFrames(
      evidence.boundaries,
      boundaryDirectory,
      encodedByFrame,
      padding,
    );
    makeContactSheet(
      path.join(curatedDirectory, "encoded-*.png"),
      path.join(stagingOutput, "contact-sheet.jpg"),
      7,
      evidence.curated.length,
    );
    makeContactSheet(
      path.join(boundaryDirectory, "encoded-*.png"),
      path.join(stagingOutput, "boundary-contact-sheet.jpg"),
      5,
      evidence.boundaries.length,
    );

    const failed = comparisons.filter((item) => !item.passed);
    const minimumObservedSsim = Math.min(
      ...comparisons.map((item) => item.ssim),
    );
    const manifest = {
      master: path.relative(repoRoot, masterPath),
      sourceManifest: path.relative(repoRoot, evidence.manifestPath),
      generatedAt: new Date().toISOString(),
      minimumSsim,
      comparedFrames: comparisons.length,
      comparedCuratedFrames: evidence.curated.length,
      comparedBoundaryFrames: evidence.boundaries.length,
      minimumObservedSsim,
      failedFrames: failed.map((item) => ({
        category: item.category,
        frame: item.frame,
      })),
      frames: comparisons,
    };
    fs.writeFileSync(
      path.join(stagingOutput, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    publishOutput(stagingOutput);

    console.log(
      `[video:compare] Compared ${evidence.curated.length} curated and ${evidence.boundaries.length} boundary frames; minimum SSIM ${minimumObservedSsim.toFixed(6)} (gate ${minimumSsim}).`,
    );
    console.log(
      `[video:compare] Evidence: ${path.relative(repoRoot, outputDirectory)}/`,
    );
    if (failed.length > 0) {
      fail(
        `Encoded mismatch at ${failed.map((item) => `${item.category} frame ${item.frame}`).join(", ")}`,
      );
    }
    console.log(
      "[video:compare] PASS: encoded canaries and boundaries match current source evidence.",
    );
  } finally {
    fs.rmSync(stagingDirectory, { force: true, recursive: true });
  }
};

try {
  main();
} catch (error) {
  console.error(
    error instanceof Error ? error.message : `[video:compare] ${String(error)}`,
  );
  process.exitCode = 1;
}
