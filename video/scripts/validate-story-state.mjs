import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { validateDescriptions } from "./validate-descriptions.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const manifestPath = resolve(repoRoot, "video/story-state.json");

function fail(message) {
  throw new Error(`Video story-state check failed: ${message}`);
}

function requireRecord(value, context, requiredKeys, optionalKeys = []) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${context} must be an object`);
  }
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);
  const unexpectedKeys = Object.keys(value).filter(
    (key) => !allowedKeys.has(key),
  );
  if (unexpectedKeys.length > 0) {
    fail(`${context} has unexpected field ${unexpectedKeys[0]}`);
  }
  const missingKeys = requiredKeys.filter((key) => !Object.hasOwn(value, key));
  if (missingKeys.length > 0) {
    fail(`${context} is missing field ${missingKeys[0]}`);
  }
}

function repoPath(path) {
  if (typeof path !== "string" || path.length === 0) {
    fail("every file entry must have a non-empty path");
  }
  const absolutePath = resolve(repoRoot, path);
  const relativePath = relative(repoRoot, absolutePath);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    fail(`path escapes the repository: ${path}`);
  }
  return absolutePath;
}

async function read(path) {
  try {
    return await readFile(repoPath(path));
  } catch (error) {
    fail(`cannot read ${path}: ${error.message}`);
  }
}

function requireStringList(value, field, context) {
  if (value === undefined) return [];
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    fail(`${context}.${field} must be a non-empty string array`);
  }
  return value;
}

function assertTextCheck(contents, check, anchorId) {
  const context = `${anchorId} (${check.path})`;
  const normalizedContents = contents.replace(/\s+/gu, " ");
  const includes = (value) =>
    contents.includes(value) ||
    normalizedContents.includes(value.replace(/\s+/gu, " "));
  for (const expected of requireStringList(
    check.contains,
    "contains",
    context,
  )) {
    if (!includes(expected)) {
      fail(`${context} is missing ${JSON.stringify(expected)}`);
    }
  }

  let cursor = 0;
  for (const expected of requireStringList(
    check.containsInOrder,
    "containsInOrder",
    context,
  )) {
    const normalizedExpected = expected.replace(/\s+/gu, " ");
    const index = normalizedContents.indexOf(normalizedExpected, cursor);
    if (index === -1) {
      fail(`${context} is missing ordered anchor ${JSON.stringify(expected)}`);
    }
    cursor = index + normalizedExpected.length;
  }

  for (const forbidden of requireStringList(
    check.excludes,
    "excludes",
    context,
  )) {
    if (includes(forbidden)) {
      fail(`${context} still contains ${JSON.stringify(forbidden)}`);
    }
  }
}

let manifest;
try {
  manifest = JSON.parse((await read(manifestPath)).toString("utf8"));
} catch (error) {
  fail(`cannot parse video/story-state.json: ${error.message}`);
}

requireRecord(manifest, "manifest", [
  "schemaVersion",
  "synchronizedFiles",
  "binaryAnchors",
  "anchors",
]);
if (manifest.schemaVersion !== 1) {
  fail(`unsupported schemaVersion ${JSON.stringify(manifest.schemaVersion)}`);
}
if (!Array.isArray(manifest.anchors) || manifest.anchors.length === 0) {
  fail("anchors must be a non-empty array");
}
if (!Array.isArray(manifest.synchronizedFiles)) {
  fail("synchronizedFiles must be an array");
}
if (
  !Array.isArray(manifest.binaryAnchors) ||
  manifest.binaryAnchors.length === 0
) {
  fail("binaryAnchors must be a non-empty array");
}

for (const [index, pair] of manifest.synchronizedFiles.entries()) {
  requireRecord(pair, `synchronizedFiles[${index}]`, ["canonical", "copy"]);
  const canonical = await read(pair.canonical);
  const copy = await read(pair.copy);
  if (!canonical.equals(copy)) {
    fail(
      `${pair.copy} is not byte-for-byte synchronized with ${pair.canonical}`,
    );
  }
}

const binaryAnchorPaths = new Set();
for (const [index, anchor] of manifest.binaryAnchors.entries()) {
  requireRecord(anchor, `binaryAnchors[${index}]`, ["path", "sha256"]);
  if (binaryAnchorPaths.has(anchor.path)) {
    fail(`duplicate binary anchor ${anchor.path}`);
  }
  binaryAnchorPaths.add(anchor.path);
  if (!/^[a-f0-9]{64}$/u.test(anchor.sha256 ?? "")) {
    fail(`${anchor.path} has an invalid sha256 manifest value`);
  }
  const actual = createHash("sha256")
    .update(await read(anchor.path))
    .digest("hex");
  if (actual !== anchor.sha256) {
    fail(
      `${anchor.path} changed (expected ${anchor.sha256}, received ${actual}); review the film story and update the manifest deliberately`,
    );
  }
}

const assetsModulePath = resolve(repoRoot, "video/assets.ts");
const assetsModule = (await read("video/assets.ts")).toString("utf8");
const importedProductCaptures = [
  ...assetsModule.matchAll(/from\s+"([^"]+\.png)"/gu),
].map(([, importedPath]) =>
  relative(repoRoot, resolve(dirname(assetsModulePath), importedPath))
    .split(sep)
    .join("/"),
);
if (importedProductCaptures.length === 0) {
  fail("video/assets.ts does not import any product captures");
}
for (const capturePath of importedProductCaptures) {
  if (!binaryAnchorPaths.has(capturePath)) {
    fail(`video/assets.ts imports unpinned product capture ${capturePath}`);
  }
}
for (const anchorPath of binaryAnchorPaths) {
  if (!importedProductCaptures.includes(anchorPath)) {
    fail(`binary anchor is not imported by video/assets.ts: ${anchorPath}`);
  }
}

const seenIds = new Set();
const checkedFiles = new Set();
for (const [anchorIndex, anchor] of manifest.anchors.entries()) {
  requireRecord(anchor, `anchors[${anchorIndex}]`, ["id", "checks"]);
  if (typeof anchor.id !== "string" || anchor.id.length === 0) {
    fail("every anchor must have a non-empty id");
  }
  if (seenIds.has(anchor.id)) fail(`duplicate anchor id ${anchor.id}`);
  seenIds.add(anchor.id);
  if (!Array.isArray(anchor.checks) || anchor.checks.length === 0) {
    fail(`${anchor.id}.checks must be a non-empty array`);
  }
  for (const [checkIndex, check] of anchor.checks.entries()) {
    const context = `${anchor.id}.checks[${checkIndex}]`;
    requireRecord(
      check,
      context,
      ["path"],
      ["contains", "containsInOrder", "excludes"],
    );
    if (
      !Object.hasOwn(check, "contains") &&
      !Object.hasOwn(check, "containsInOrder") &&
      !Object.hasOwn(check, "excludes")
    ) {
      fail(`${context} must define at least one text assertion`);
    }
    const contents = (await read(check.path)).toString("utf8");
    assertTextCheck(contents, check, anchor.id);
    checkedFiles.add(check.path);
  }
}

console.log(
  `Video story state is current: ${manifest.anchors.length} anchors across ${checkedFiles.size} text sources; ${manifest.synchronizedFiles.length} synchronized file pair${manifest.synchronizedFiles.length === 1 ? "" : "s"}; ${manifest.binaryAnchors.length} pinned product snapshots.`,
);

// The cheap story gate must catch malformed, unreadable or mistimed captions
// before Studio, audio preparation or an expensive master render starts.
const timeline = JSON.parse(
  (await read("video/timeline.json")).toString("utf8"),
);
if (
  !Number.isInteger(timeline?.fps) ||
  timeline.fps <= 0 ||
  !Array.isArray(timeline.scenes) ||
  timeline.scenes.length === 0 ||
  timeline.scenes.some(
    (scene) =>
      !Number.isInteger(scene?.durationInFrames) || scene.durationInFrames <= 0,
  )
) {
  fail("video/timeline.json must define a positive fps and scene durations");
}
const durationSeconds =
  timeline.scenes.reduce((total, scene) => total + scene.durationInFrames, 0) /
  timeline.fps;
const descriptions = validateDescriptions(
  repoPath("video/delivery/program-cue-launch-descriptions.vtt"),
  durationSeconds,
);
console.log(
  `Video captions are current: ${descriptions.cueCount} contiguous cues over ${durationSeconds}s; maximum ${descriptions.maximumCps.toFixed(1)} characters/s.`,
);
