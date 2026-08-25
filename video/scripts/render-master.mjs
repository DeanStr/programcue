#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "../..");
const artifactsDirectory = path.join(repoRoot, ".artifacts");
const finalOutput = path.join(artifactsDirectory, "program-cue-launch.mp4");
const sidecarOutput = path.join(artifactsDirectory, "program-cue-launch.vtt");
const scoreOutput = path.join(
  repoRoot,
  "video",
  "public",
  "video",
  "program-cue-score.wav",
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
const maximumDescriptionCharactersPerSecond = 17;
const timingToleranceSeconds = 0.001;

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

const parseTimestamp = (value) => {
  const match = value.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/);
  if (!match) return null;
  const [, hours, minutes, seconds, milliseconds] = match;
  if (Number(minutes) > 59 || Number(seconds) > 59) return null;
  return (
    Number(hours) * 3_600 +
    Number(minutes) * 60 +
    Number(seconds) +
    Number(milliseconds) / 1_000
  );
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

const validateDescriptions = (vttPath, expectedDurationSeconds) => {
  if (!fs.existsSync(vttPath)) {
    fail(`Description track is missing: ${path.relative(repoRoot, vttPath)}`);
  }
  const source = fs
    .readFileSync(vttPath, "utf8")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .trimEnd();
  if (!source.startsWith("WEBVTT\n")) {
    fail("Description track must begin with a WEBVTT header.");
  }

  const blocks = source.split(/\n{2,}/).slice(1);
  const cues = [];
  for (const [blockIndex, block] of blocks.entries()) {
    const lines = block.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0 || lines[0].startsWith("NOTE")) continue;
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0 || timingIndex > 1) {
      fail(`Description cue ${blockIndex + 1} has no valid timing line.`);
    }
    const timing = lines[timingIndex].match(
      /^(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})$/,
    );
    const start = timing ? parseTimestamp(timing[1]) : null;
    const end = timing ? parseTimestamp(timing[2]) : null;
    const text = lines
      .slice(timingIndex + 1)
      .join(" ")
      .replace(/<[^>]*>/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (start === null || end === null || end <= start || text.length === 0) {
      fail(`Description cue ${blockIndex + 1} is malformed or empty.`);
    }
    const characters = [...text].length;
    cues.push({
      start,
      end,
      charactersPerSecond: characters / (end - start),
    });
  }

  if (cues.length === 0) fail("Description track contains no cues.");
  if (Math.abs(cues[0].start) > timingToleranceSeconds) {
    fail(`Description track begins at ${cues[0].start}s instead of 0s.`);
  }
  for (let index = 1; index < cues.length; index += 1) {
    const gap = cues[index].start - cues[index - 1].end;
    if (Math.abs(gap) > timingToleranceSeconds) {
      fail(
        `Description cues ${index} and ${index + 1} are not contiguous (${gap.toFixed(3)}s gap/overlap).`,
      );
    }
  }
  const finalEnd = cues.at(-1).end;
  if (Math.abs(finalEnd - expectedDurationSeconds) > timingToleranceSeconds) {
    fail(
      `Description track ends at ${finalEnd}s instead of ${expectedDurationSeconds}s.`,
    );
  }
  const fastestCue = cues.reduce(
    (fastest, cue, index) =>
      cue.charactersPerSecond > fastest.charactersPerSecond
        ? { ...cue, index }
        : fastest,
    { charactersPerSecond: Number.NEGATIVE_INFINITY, index: -1 },
  );
  if (
    fastestCue.charactersPerSecond >
    maximumDescriptionCharactersPerSecond + Number.EPSILON
  ) {
    fail(
      `Description cue ${fastestCue.index + 1} reads at ${fastestCue.charactersPerSecond.toFixed(1)} characters/s (maximum ${maximumDescriptionCharactersPerSecond}).`,
    );
  }
  return { cueCount: cues.length, maximumCps: fastestCue.charactersPerSecond };
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

  run("Generating the deterministic score", nodeBinary, [
    path.join(repoRoot, "video", "scripts", "generate-score.mjs"),
  ]);

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
    scoreOutput,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "copy",
    "-bsf:v",
    "h264_metadata=video_full_range_flag=0:colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1",
    "-c:a",
    "aac",
    "-b:a",
    "320k",
    "-ar",
    "48000",
    "-ac",
    "2",
    // Encoding directly from the exact picture-lock WAV lets ffmpeg write AAC
    // priming/discard metadata instead of inheriting Remotion's audio delay.
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
    `[video:render] Master ready: ${path.relative(repoRoot, finalOutput)}`,
  );
  console.log(
    `[video:render] Description sidecar: ${path.relative(repoRoot, sidecarOutput)} (${descriptions.cueCount} cues, max ${descriptions.maximumCps.toFixed(1)} characters/s)`,
  );
} finally {
  fs.rmSync(stagingDirectory, { force: true, recursive: true });
}
