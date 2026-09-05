import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const maximumDescriptionCharactersPerSecond = 17;
const timingToleranceSeconds = 0.001;
const fail = (message) => {
  throw new Error(`[video:captions] ${message}`);
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

export const validateDescriptions = (vttPath, expectedDurationSeconds) => {
  if (
    !Number.isFinite(expectedDurationSeconds) ||
    expectedDurationSeconds <= 0
  ) {
    fail("Expected picture duration must be a positive finite number.");
  }
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
    if (lines.slice(timingIndex + 1).some((line) => line.includes("-->"))) {
      fail(
        `Description cue ${blockIndex + 1} contains an extra timing delimiter.`,
      );
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
