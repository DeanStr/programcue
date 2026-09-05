#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateDescriptions } from "./validate-descriptions.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "../..");
const artifactsDirectory = path.join(repoRoot, ".artifacts");
const finalOutput = path.join(artifactsDirectory, "program-cue-launch.mp4");
const sidecarOutput = path.join(artifactsDirectory, "program-cue-launch.vtt");
const releaseManifestPath = path.join(
  repoRoot,
  "site",
  "public",
  "product-film-release.json",
);
const descriptionsSource = path.join(
  repoRoot,
  "video",
  "delivery",
  "program-cue-launch-descriptions.vtt",
);
const timelinePath = path.join(repoRoot, "video", "timeline.json");
const remotionBinary = path.join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "remotion.cmd" : "remotion",
);
const nodeBinary = process.execPath;
const ffmpegBinary = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

const fail = (message) => {
  throw new Error(`[video:render] ${message}`);
};

const run = (label, binary, args) => {
  console.log(`[video:render] ${label}`);
  const result = spawnSync(binary, args, {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.error) {
    fail(`${label} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      `${label} failed (exit ${result.status ?? "unknown"}${result.signal ? `, signal ${result.signal}` : ""}).`,
    );
  }
};

const readExpectedDuration = () => {
  if (!fs.existsSync(timelinePath)) {
    fail(
      `Canonical timeline is missing: ${path.relative(repoRoot, timelinePath)}`,
    );
  }
  let timeline;
  try {
    timeline = JSON.parse(fs.readFileSync(timelinePath, "utf8"));
  } catch (error) {
    fail(
      `Canonical timeline is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    !Number.isInteger(timeline?.fps) ||
    timeline.fps <= 0 ||
    !Array.isArray(timeline.scenes) ||
    timeline.scenes.length === 0 ||
    timeline.scenes.some(
      (scene) =>
        !Number.isInteger(scene?.durationInFrames) ||
        scene.durationInFrames <= 0,
    )
  ) {
    fail(
      "Canonical timeline must define a positive integer fps and scene durations.",
    );
  }
  return (
    timeline.scenes.reduce(
      (total, scene) => total + scene.durationInFrames,
      0,
    ) / timeline.fps
  );
};

const releasedAudioSource = () => {
  let release;
  try {
    release = JSON.parse(fs.readFileSync(releaseManifestPath, "utf8"));
  } catch (error) {
    fail(
      `Could not read the product-film release manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    release?.audioSource !== "eleven_music_v2" ||
    typeof release.videoUrl !== "string" ||
    typeof release.masterSha256 !== "string" ||
    !release.masterSha256.startsWith(release.masterSha256Prefix ?? "")
  ) {
    fail("The product-film release manifest does not pin an Eleven master.");
  }
  const fileName = path.basename(new URL(release.videoUrl).pathname);
  const source = path.join(artifactsDirectory, "video-releases", fileName);
  if (!fs.existsSync(source)) {
    fail(
      `Released Eleven master is missing: ${path.relative(repoRoot, source)}`,
    );
  }
  return source;
};

fs.mkdirSync(artifactsDirectory, { recursive: true });
const stagingDirectory = fs.mkdtempSync(
  path.join(artifactsDirectory, ".program-cue-render-"),
);
const rawOutput = path.join(stagingDirectory, "program-cue-launch.raw.mp4");
const stagedFinal = path.join(stagingDirectory, "program-cue-launch.mp4");
const stagedSidecar = path.join(stagingDirectory, "program-cue-launch.vtt");

try {
  const expectedDurationSeconds = readExpectedDuration();
  const descriptions = validateDescriptions(
    descriptionsSource,
    expectedDurationSeconds,
  );

  run("Preparing the released Eleven Music soundtrack", nodeBinary, [
    path.join(
      repoRoot,
      "video",
      "scripts",
      "prepare-released-eleven-audio.mjs",
    ),
  ]);
  const selectedAudioSource = releasedAudioSource();

  run("Rendering the 1080p30 Remotion master", remotionBinary, [
    "render",
    path.join(repoRoot, "video", "index.ts"),
    "ProgramCueLaunch",
    rawOutput,
    "--codec=h264",
    "--crf=16",
    "--pixel-format=yuv420p",
    "--color-space=bt709",
    "--audio-codec=aac",
    "--audio-bitrate=320k",
    "--overwrite",
  ]);

  run("Muxing the picture-locked AAC master", ffmpegBinary, [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "error",
    "-y",
    "-i",
    rawOutput,
    "-i",
    selectedAudioSource,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "copy",
    "-bsf:v",
    "h264_metadata=video_full_range_flag=0:colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1",
    "-c:a",
    "copy",
    // Preserve the exact released Eleven AAC packet stream while replacing
    // only the picture with the current cut.
    "-t",
    String(expectedDurationSeconds),
    "-movflags",
    "+faststart",
    stagedFinal,
  ]);

  if (!fs.existsSync(stagedFinal) || fs.statSync(stagedFinal).size === 0) {
    fail("Muxing did not produce a non-empty staged master.");
  }
  fs.copyFileSync(descriptionsSource, stagedSidecar);
  validateDescriptions(stagedSidecar, expectedDurationSeconds);

  // Both staged files live beside their destinations, so rename publishes a
  // complete file atomically and cannot cross filesystem boundaries.
  fs.renameSync(stagedFinal, finalOutput);
  fs.renameSync(stagedSidecar, sidecarOutput);
  console.log(
    `[video:render] Eleven Music master ready: ${path.relative(repoRoot, finalOutput)}`,
  );
  console.log(
    `[video:render] Description sidecar: ${path.relative(repoRoot, sidecarOutput)} (${descriptions.cueCount} cues, max ${descriptions.maximumCps.toFixed(1)} characters/s)`,
  );
} finally {
  fs.rmSync(stagingDirectory, { force: true, recursive: true });
}
