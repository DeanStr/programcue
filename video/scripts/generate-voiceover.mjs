#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "../..");
const artifactDirectory = path.join(repoRoot, ".artifacts", "video-voiceover");
const runsDirectory = path.join(artifactDirectory, "runs");
const liveManifestPath = path.join(artifactDirectory, "manifest.json");
const dryRunManifestPath = path.join(
  artifactDirectory,
  "dry-run-manifest.json",
);
const timelinePath = path.join(repoRoot, "video", "timeline.json");
const scriptPath = path.join(repoRoot, "video", "voiceover-script.json");
const scorePath = path.join(
  repoRoot,
  "video",
  "public",
  "video",
  "program-cue-score.wav",
);
const ffmpegBinary = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
const ffprobeBinary = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
const requiredTotalDurationSeconds = 6 * 60;
const outputSampleRate = 48_000;
const requiredOutputSamples = requiredTotalDurationSeconds * outputSampleRate;
const providerTimeoutMs = 2 * 60 * 1_000;
const maximumProviderResponseBytes = 16 * 1024 * 1024;
const maximumProviderErrorBytes = 64 * 1024;
const minimumSegmentBytes = 10_000;
const maximumSegmentBytes = 12 * 1024 * 1024;
const loudnessToleranceLu = 1;
const peakToleranceDb = 0.1;

const fail = (message) => {
  throw new Error(message);
};

const isPlainObject = (value) =>
  Boolean(value) &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

const assertExactKeys = (value, expectedKeys, label) => {
  if (!isPlainObject(value)) fail(`${label} must be an object.`);
  const expected = new Set(expectedKeys);
  const unknown = Object.keys(value).filter((key) => !expected.has(key));
  const missing = expectedKeys.filter((key) => !(key in value));
  if (unknown.length > 0 || missing.length > 0) {
    const detail = [
      unknown.length > 0 ? `unsupported: ${unknown.join(", ")}` : "",
      missing.length > 0 ? `missing: ${missing.join(", ")}` : "",
    ]
      .filter(Boolean)
      .join("; ");
    fail(`${label} has an invalid shape (${detail}).`);
  }
};

const readJson = (filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(
      `Could not read ${path.relative(repoRoot, filePath)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

const sha256 = (contents) =>
  createHash("sha256").update(contents).digest("hex");

const hashFile = (filePath) => sha256(fs.readFileSync(filePath));

const makeMediaEnvironment = () => {
  const environment = {};
  for (const key of [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "LD_LIBRARY_PATH",
    "DYLD_LIBRARY_PATH",
  ]) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return environment;
};

const run = (binary, commandArgs, label, options = {}) => {
  const result = spawnSync(binary, commandArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    env: makeMediaEnvironment(),
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  if (result.error) {
    fail(`${label} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`
      .trim()
      .slice(-4_000);
    fail(`${label} failed: ${output || `exit ${result.status}`}`);
  }
  return result.stdout;
};

const requireTool = (binary) => {
  run(binary, ["-version"], `${binary} probe`);
};

const parseArguments = () => {
  const rawArguments = process.argv.slice(2);
  const allowed = new Set(["--dry-run", "--live", "--reuse-segments"]);
  const seen = new Set();
  for (const argument of rawArguments) {
    if (!allowed.has(argument)) {
      fail(
        `Unknown argument "${argument}". Usage: npm run video:voice -- [--dry-run | --live [--reuse-segments]]`,
      );
    }
    if (seen.has(argument)) fail(`Duplicate argument "${argument}".`);
    seen.add(argument);
  }
  if (seen.has("--dry-run") && seen.has("--live")) {
    fail("--dry-run and --live cannot be combined.");
  }
  if (seen.has("--reuse-segments") && !seen.has("--live")) {
    fail("--reuse-segments is allowed only with explicit --live mode.");
  }
  return {
    live: seen.has("--live"),
    reuseSegments: seen.has("--reuse-segments"),
  };
};

const readPictureLock = () => {
  const timeline = readJson(timelinePath);
  assertExactKeys(timeline, ["fps", "width", "height", "scenes"], "timeline");
  if (
    !Number.isInteger(timeline.fps) ||
    timeline.fps < 1 ||
    !Number.isInteger(timeline.width) ||
    timeline.width < 1 ||
    !Number.isInteger(timeline.height) ||
    timeline.height < 1 ||
    !Array.isArray(timeline.scenes) ||
    timeline.scenes.length < 1
  ) {
    fail("video/timeline.json contains an invalid picture lock.");
  }
  const seenKeys = new Set();
  const scenes = timeline.scenes.map((scene, index) => {
    assertExactKeys(
      scene,
      ["key", "durationInFrames"],
      `timeline.scenes[${index}]`,
    );
    if (
      typeof scene.key !== "string" ||
      !/^[a-z][a-z0-9]*$/u.test(scene.key) ||
      seenKeys.has(scene.key) ||
      !Number.isInteger(scene.durationInFrames) ||
      scene.durationInFrames < 1
    ) {
      fail(`timeline.scenes[${index}] is invalid.`);
    }
    seenKeys.add(scene.key);
    return { key: scene.key, frames: scene.durationInFrames };
  });
  return { fps: timeline.fps, scenes };
};

const wordCount = (text) => text.trim().split(/\s+/u).filter(Boolean).length;

const hasForbiddenControlCharacter = (text) => {
  for (const character of text) {
    const codePoint = character.codePointAt(0);
    if (
      codePoint < 32 &&
      codePoint !== 9 &&
      codePoint !== 10 &&
      codePoint !== 13
    ) {
      return true;
    }
  }
  return false;
};

const validateVoiceConfig = (voice) => {
  assertExactKeys(
    voice,
    ["provider", "voiceId", "voiceName", "modelId", "outputFormat", "settings"],
    "voice",
  );
  if (voice.provider !== "elevenlabs") {
    fail('voice.provider must be "elevenlabs".');
  }
  if (
    typeof voice.voiceId !== "string" ||
    !/^[A-Za-z0-9_-]{8,128}$/u.test(voice.voiceId)
  ) {
    fail("voice.voiceId is invalid.");
  }
  if (
    typeof voice.voiceName !== "string" ||
    voice.voiceName.trim().length < 1 ||
    voice.voiceName.length > 100
  ) {
    fail("voice.voiceName is invalid.");
  }
  if (voice.modelId !== "eleven_multilingual_v2") {
    fail('voice.modelId must be "eleven_multilingual_v2" for this audition.');
  }
  if (voice.outputFormat !== "mp3_44100_128") {
    fail('voice.outputFormat must be "mp3_44100_128".');
  }
  assertExactKeys(
    voice.settings,
    ["stability", "similarity_boost", "style", "use_speaker_boost", "speed"],
    "voice.settings",
  );
  for (const field of ["stability", "similarity_boost", "style"]) {
    if (
      !Number.isFinite(voice.settings[field]) ||
      voice.settings[field] < 0 ||
      voice.settings[field] > 1
    ) {
      fail(`voice.settings.${field} must be from 0 to 1.`);
    }
  }
  if (typeof voice.settings.use_speaker_boost !== "boolean") {
    fail("voice.settings.use_speaker_boost must be boolean.");
  }
  if (
    !Number.isFinite(voice.settings.speed) ||
    voice.settings.speed < 0.7 ||
    voice.settings.speed > 1.2
  ) {
    fail("voice.settings.speed must be from 0.7 to 1.2.");
  }
  return voice;
};

const validateMixConfig = (mix, totalDurationSeconds) => {
  assertExactKeys(
    mix,
    [
      "voiceTargetLufs",
      "finalTargetLufs",
      "finalTruePeakDb",
      "sidechainDuckDb",
      "preservedBreathingSpaceSeconds",
    ],
    "mix",
  );
  for (const field of ["voiceTargetLufs", "finalTargetLufs"]) {
    if (!Number.isFinite(mix[field]) || mix[field] < -24 || mix[field] > -10) {
      fail(`mix.${field} must be from -24 to -10 LUFS.`);
    }
  }
  if (
    !Number.isFinite(mix.finalTruePeakDb) ||
    mix.finalTruePeakDb < -6 ||
    mix.finalTruePeakDb > -0.5
  ) {
    fail("mix.finalTruePeakDb must be from -6 to -0.5 dBFS.");
  }
  if (typeof mix.sidechainDuckDb !== "string") {
    fail('mix.sidechainDuckDb must be a range such as "6-10".');
  }
  const duckMatch = mix.sidechainDuckDb.match(
    /^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/u,
  );
  if (!duckMatch) fail("mix.sidechainDuckDb is invalid.");
  const duckMinimumDb = Number(duckMatch[1]);
  const duckMaximumDb = Number(duckMatch[2]);
  if (
    duckMinimumDb < 1 ||
    duckMaximumDb > 18 ||
    duckMinimumDb > duckMaximumDb
  ) {
    fail("mix.sidechainDuckDb must be an ascending 1-18 dB range.");
  }
  const breathingSpace = mix.preservedBreathingSpaceSeconds;
  assertExactKeys(breathingSpace, ["start", "end"], "mix breathing space");
  if (
    !Number.isFinite(breathingSpace.start) ||
    !Number.isFinite(breathingSpace.end) ||
    breathingSpace.start < 0 ||
    breathingSpace.start >= breathingSpace.end ||
    breathingSpace.end > totalDurationSeconds
  ) {
    fail("Voice-over script must declare a valid preserved breathing space.");
  }
  return {
    ...mix,
    sidechainTargetDb: (duckMinimumDb + duckMaximumDb) / 2,
  };
};

const validateScript = (script, pictureLock) => {
  assertExactKeys(
    script,
    [
      "title",
      "version",
      "language",
      "totalDurationSeconds",
      "sceneCount",
      "voice",
      "mix",
      "segments",
    ],
    "voice-over script",
  );
  if (
    typeof script.title !== "string" ||
    script.title.trim().length < 1 ||
    script.title.length > 200 ||
    !Number.isInteger(script.version) ||
    script.version < 1 ||
    typeof script.language !== "string" ||
    !/^[a-z]{2,3}(?:-[A-Z]{2})?$/u.test(script.language)
  ) {
    fail("Voice-over title, version or language metadata is invalid.");
  }
  const pictureFrames = pictureLock.scenes.reduce(
    (total, scene) => total + scene.frames,
    0,
  );
  const pictureDurationSeconds = pictureFrames / pictureLock.fps;
  if (pictureDurationSeconds !== requiredTotalDurationSeconds) {
    fail(
      `The current picture lock is ${pictureDurationSeconds}s, not the required 360s.`,
    );
  }
  if (script.totalDurationSeconds !== pictureDurationSeconds) {
    fail(
      `Voice-over metadata targets ${script.totalDurationSeconds}s, but the current picture lock is ${pictureDurationSeconds}s.`,
    );
  }
  if (
    !Number.isInteger(script.sceneCount) ||
    script.sceneCount !== pictureLock.scenes.length ||
    !Array.isArray(script.segments) ||
    script.segments.length !== script.sceneCount
  ) {
    fail(
      `Voice-over script must contain exactly ${pictureLock.scenes.length} scene-aligned segments.`,
    );
  }
  const voice = validateVoiceConfig(script.voice);
  const mix = validateMixConfig(script.mix, script.totalDurationSeconds);
  const breathingSpace = mix.preservedBreathingSpaceSeconds;
  const seen = new Set();
  let expectedSceneFrame = 0;
  let previousVoiceEnd = 0;
  for (const [index, segment] of script.segments.entries()) {
    const label = `segments[${index}]`;
    assertExactKeys(
      segment,
      [
        "id",
        "sceneKey",
        "scene",
        "sceneStartSeconds",
        "sceneDurationSeconds",
        "voiceStartSeconds",
        "voiceEndSeconds",
        "text",
      ],
      label,
    );
    if (
      typeof segment.id !== "string" ||
      !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(segment.id) ||
      seen.has(segment.id)
    ) {
      fail(`${label}.id is invalid or duplicated.`);
    }
    seen.add(segment.id);
    if (
      typeof segment.scene !== "string" ||
      segment.scene.trim().length < 1 ||
      segment.scene.length > 100 ||
      typeof segment.text !== "string" ||
      segment.text.trim() !== segment.text ||
      segment.text.length > 1_000 ||
      hasForbiddenControlCharacter(segment.text)
    ) {
      fail(`${segment.id} has invalid scene or narration text.`);
    }
    const lockedScene = pictureLock.scenes[index];
    const lockedStartSeconds = expectedSceneFrame / pictureLock.fps;
    const lockedDurationSeconds = lockedScene.frames / pictureLock.fps;
    if (segment.sceneKey !== lockedScene.key) {
      fail(
        `${segment.id} targets scene "${segment.sceneKey}", but picture-lock position ${index + 1} is "${lockedScene.key}".`,
      );
    }
    if (
      !Number.isFinite(segment.sceneStartSeconds) ||
      !Number.isFinite(segment.sceneDurationSeconds) ||
      Math.abs(segment.sceneStartSeconds - lockedStartSeconds) > 0.001 ||
      Math.abs(segment.sceneDurationSeconds - lockedDurationSeconds) > 0.001
    ) {
      fail(
        `${segment.id} must match picture-lock scene "${lockedScene.key}" at ${lockedStartSeconds}s for ${lockedDurationSeconds}s.`,
      );
    }
    expectedSceneFrame += lockedScene.frames;
    if (
      !Number.isFinite(segment.voiceStartSeconds) ||
      !Number.isFinite(segment.voiceEndSeconds) ||
      !Number.isInteger(segment.voiceStartSeconds * outputSampleRate) ||
      !Number.isInteger(segment.voiceEndSeconds * outputSampleRate) ||
      segment.voiceStartSeconds < segment.sceneStartSeconds + 0.75 ||
      segment.voiceStartSeconds < previousVoiceEnd ||
      segment.voiceStartSeconds >= segment.voiceEndSeconds
    ) {
      fail(
        `${segment.id} has invalid or overlapping sample-aligned voice timing.`,
      );
    }
    const sceneEnd = lockedStartSeconds + lockedDurationSeconds;
    if (segment.voiceEndSeconds > sceneEnd - 2) {
      fail(
        `${segment.id} must leave at least two seconds of scene breathing room.`,
      );
    }
    if (
      segment.voiceStartSeconds < breathingSpace.end &&
      segment.voiceEndSeconds > breathingSpace.start
    ) {
      fail(
        `${segment.id} overlaps the preserved ${breathingSpace.start}-${breathingSpace.end}s breathing space.`,
      );
    }
    const words = wordCount(segment.text);
    if (words < 29 || words > 38) {
      fail(
        `${segment.id} should be a sparse 29-38 word segment; found ${words}.`,
      );
    }
    previousVoiceEnd = segment.voiceEndSeconds;
  }
  if (expectedSceneFrame !== pictureFrames) {
    fail(
      `Voice-over scene coverage ends at frame ${expectedSceneFrame}, not picture-lock frame ${pictureFrames}.`,
    );
  }
  const totalOutputSamples = script.totalDurationSeconds * outputSampleRate;
  if (totalOutputSamples !== requiredOutputSamples) {
    fail(
      `Voice-over output must contain exactly ${requiredOutputSamples} samples.`,
    );
  }
  return {
    mix,
    totalDurationSeconds: script.totalDurationSeconds,
    totalOutputSamples,
    voice,
  };
};

const probeAudio = (filePath) =>
  JSON.parse(
    run(
      ffprobeBinary,
      ["-v", "error", "-show_streams", "-show_format", "-of", "json", filePath],
      `ffprobe ${path.relative(repoRoot, filePath)}`,
    ),
  );

const countDecodedSamples = (filePath) => {
  const output = run(
    ffprobeBinary,
    [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_frames",
      "-show_entries",
      "frame=nb_samples",
      "-of",
      "csv=p=0",
      filePath,
    ],
    `decoded sample count for ${path.relative(repoRoot, filePath)}`,
  );
  const values = output.trim().split(/\s+/u).filter(Boolean).map(Number);
  if (
    values.length < 1 ||
    values.some((value) => !Number.isInteger(value) || value < 1)
  ) {
    fail(
      `Could not count decoded samples in ${path.relative(repoRoot, filePath)}.`,
    );
  }
  return values.reduce((total, value) => total + value, 0);
};

const fullDecode = (filePath) => {
  run(
    ffmpegBinary,
    [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-xerror",
      "-err_detect",
      "explode",
      "-i",
      filePath,
      "-map",
      "0:a:0",
      "-f",
      "null",
      "-",
    ],
    `full decode of ${path.relative(repoRoot, filePath)}`,
  );
};

const measureLoudness = (filePath) => {
  const result = spawnSync(
    ffmpegBinary,
    [
      "-hide_banner",
      "-nostdin",
      "-i",
      filePath,
      "-filter_complex",
      "ebur128=peak=true",
      "-f",
      "null",
      "-",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: makeMediaEnvironment(),
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.error || result.status !== 0) {
    fail(
      `Loudness analysis failed for ${path.relative(repoRoot, filePath)}: ${
        result.error?.message ??
        result.stderr?.trim().slice(-2_000) ??
        `exit ${result.status}`
      }`,
    );
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const loudnessValues = [...output.matchAll(/I:\s*(-?[0-9.]+)\s*LUFS/g)].map(
    (match) => Number(match[1]),
  );
  const peakValues = [...output.matchAll(/Peak:\s*(-?[0-9.]+)\s*dBFS/g)].map(
    (match) => Number(match[1]),
  );
  const integratedLoudness = loudnessValues.at(-1);
  const truePeak = peakValues.at(-1);
  if (!Number.isFinite(integratedLoudness) || !Number.isFinite(truePeak)) {
    fail(`Could not parse loudness for ${path.relative(repoRoot, filePath)}.`);
  }
  return { integratedLoudness, truePeak };
};

const validateScore = () => {
  if (!fs.existsSync(scorePath)) {
    fail(
      "Missing video/public/video/program-cue-score.wav. Run npm run video:score first.",
    );
  }
  const probe = probeAudio(scorePath);
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const audioStreams = streams.filter(
    (stream) => stream.codec_type === "audio",
  );
  const audio = audioStreams[0];
  if (
    audioStreams.length !== 1 ||
    streams.length !== 1 ||
    audio?.codec_name !== "pcm_s16le" ||
    Number(audio.sample_rate) !== outputSampleRate ||
    audio.channels !== 2
  ) {
    fail("Score must contain exactly one 48 kHz stereo PCM16 audio stream.");
  }
  const decodedSamples = countDecodedSamples(scorePath);
  if (decodedSamples !== requiredOutputSamples) {
    fail(
      `Score contains ${decodedSamples} decoded samples, not ${requiredOutputSamples}.`,
    );
  }
  fullDecode(scorePath);
  return {
    path: path.relative(repoRoot, scorePath),
    sha256: hashFile(scorePath),
    codec: audio.codec_name,
    sampleRate: Number(audio.sample_rate),
    channels: audio.channels,
    decodedSamples,
  };
};

const writeBufferAtomically = (filePath, contents) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    try {
      fs.writeFileSync(descriptor, contents);
      fs.fsyncSync(descriptor);
    } finally {
      const descriptorToClose = descriptor;
      descriptor = undefined;
      fs.closeSync(descriptorToClose);
    }
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporaryPath, { force: true });
  }
};

const writeJsonAtomically = (filePath, value) => {
  writeBufferAtomically(filePath, `${JSON.stringify(value, null, 2)}\n`);
};

const writeBufferExclusive = (filePath, contents) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, { flag: "wx", mode: 0o600 });
};

const redactSecrets = (text, apiKey) =>
  text
    .replaceAll(apiKey, "[redacted]")
    .replace(/sk_[A-Za-z0-9_-]{16,}/gu, "[redacted]");

const readBoundedResponse = async (response, maximumBytes) => {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const bytes = Number(declaredLength);
    if (!Number.isInteger(bytes) || bytes < 0 || bytes > maximumBytes) {
      await response.body?.cancel();
      fail(`Provider response exceeded the ${maximumBytes}-byte limit.`);
    }
  }
  if (!response.body) fail("Provider returned an empty response body.");
  const reader = response.body.getReader();
  const chunks = [];
  let byteCount = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = Buffer.from(value);
    byteCount += chunk.length;
    if (byteCount > maximumBytes) {
      await reader.cancel();
      fail(`Provider response exceeded the ${maximumBytes}-byte limit.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, byteCount);
};

const validateAlignment = (alignment, label, maximumSeconds) => {
  if (!isPlainObject(alignment)) fail(`${label} is missing.`);
  const characters = alignment.characters;
  const starts = alignment.character_start_times_seconds;
  const ends = alignment.character_end_times_seconds;
  if (
    !Array.isArray(characters) ||
    !Array.isArray(starts) ||
    !Array.isArray(ends) ||
    characters.length < 1 ||
    characters.length > 10_000 ||
    starts.length !== characters.length ||
    ends.length !== characters.length
  ) {
    fail(`${label} arrays are invalid.`);
  }
  let previousStart = -1;
  for (let index = 0; index < characters.length; index += 1) {
    if (
      typeof characters[index] !== "string" ||
      characters[index].length > 32 ||
      !Number.isFinite(starts[index]) ||
      !Number.isFinite(ends[index]) ||
      starts[index] < previousStart ||
      starts[index] < 0 ||
      ends[index] < starts[index] ||
      ends[index] > maximumSeconds + 0.25
    ) {
      fail(`${label} contains invalid timing at index ${index}.`);
    }
    previousStart = starts[index];
  }
  return alignment;
};

const parseProviderResponse = async (response, segment, apiKey) => {
  if (!response.ok) {
    const body = await readBoundedResponse(response, maximumProviderErrorBytes);
    const detail = redactSecrets(body.toString("utf8").trim(), apiKey);
    fail(
      `ElevenLabs generation failed for ${segment.id}: HTTP ${response.status}${
        detail ? ` ${detail}` : ""
      }`,
    );
  }
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.startsWith("application/json")) {
    await response.body?.cancel();
    fail(
      `ElevenLabs returned unexpected content-type "${contentType || "missing"}" for ${segment.id}.`,
    );
  }
  const body = await readBoundedResponse(
    response,
    maximumProviderResponseBytes,
  );
  let parsed;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch (error) {
    fail(
      `ElevenLabs returned invalid JSON for ${segment.id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!isPlainObject(parsed) || typeof parsed.audio_base64 !== "string") {
    fail(`ElevenLabs response for ${segment.id} is missing audio_base64.`);
  }
  const encodedAudio = parsed.audio_base64;
  if (
    encodedAudio.length < 1_000 ||
    encodedAudio.length > maximumSegmentBytes * 2 ||
    encodedAudio.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(encodedAudio)
  ) {
    fail(
      `ElevenLabs response for ${segment.id} contains invalid base64 audio.`,
    );
  }
  const audio = Buffer.from(encodedAudio, "base64");
  if (
    audio.length < minimumSegmentBytes ||
    audio.length > maximumSegmentBytes
  ) {
    fail(
      `ElevenLabs audio for ${segment.id} is outside the ${minimumSegmentBytes}-${maximumSegmentBytes} byte range.`,
    );
  }
  return {
    alignment: parsed.alignment,
    audio,
    normalizedAlignment: parsed.normalized_alignment,
    requestId:
      response.headers.get("request-id") ??
      response.headers.get("x-request-id") ??
      null,
  };
};

const postElevenLabsSegment = async (script, segment, apiKey) => {
  const endpoint = new URL(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(
      script.voice.voiceId,
    )}/with-timestamps`,
  );
  endpoint.searchParams.set("output_format", script.voice.outputFormat);
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "xi-api-key": apiKey,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        text: segment.text,
        model_id: script.voice.modelId,
        voice_settings: script.voice.settings,
      }),
      signal: AbortSignal.timeout(providerTimeoutMs),
    });
  } catch (error) {
    const detail = redactSecrets(
      error instanceof Error ? error.message : String(error),
      apiKey,
    );
    fail(`ElevenLabs request failed for ${segment.id}: ${detail}`);
  }
  return parseProviderResponse(response, segment, apiKey);
};

const validateSegmentAudio = (filePath, segment) => {
  const bytes = fs.statSync(filePath).size;
  if (bytes < minimumSegmentBytes || bytes > maximumSegmentBytes) {
    fail(`${segment.id} has an implausible ${bytes}-byte audio file.`);
  }
  const probe = probeAudio(filePath);
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const audioStreams = streams.filter(
    (stream) => stream.codec_type === "audio",
  );
  const audio = audioStreams[0];
  if (
    streams.length !== 1 ||
    audioStreams.length !== 1 ||
    audio?.codec_name !== "mp3" ||
    Number(audio.sample_rate) !== 44_100 ||
    ![1, 2].includes(audio.channels)
  ) {
    fail(`${segment.id} must contain exactly one 44.1 kHz MP3 audio stream.`);
  }
  fullDecode(filePath);
  const decodedSamples = countDecodedSamples(filePath);
  const decodedDurationSeconds = decodedSamples / Number(audio.sample_rate);
  const availableSeconds = segment.voiceEndSeconds - segment.voiceStartSeconds;
  if (
    decodedDurationSeconds < 0.5 ||
    decodedDurationSeconds > availableSeconds + 0.001
  ) {
    fail(
      `${segment.id} decoded for ${decodedDurationSeconds.toFixed(3)}s, outside its 0.5-${availableSeconds.toFixed(3)}s slot.`,
    );
  }
  return {
    audioSha256: hashFile(filePath),
    bytes,
    channels: audio.channels,
    codec: audio.codec_name,
    decodedDurationSeconds,
    decodedSamples,
    sampleRate: Number(audio.sample_rate),
  };
};

const generateSegments = async (
  script,
  stagingDirectory,
  finalRunDirectory,
  apiKey,
) => {
  const stagingSegmentsDirectory = path.join(stagingDirectory, "segments");
  fs.mkdirSync(stagingSegmentsDirectory, { recursive: true });
  const alignments = [];
  const generated = [];
  for (const segment of script.segments) {
    const response = await postElevenLabsSegment(script, segment, apiKey);
    const stagedAudioPath = path.join(
      stagingSegmentsDirectory,
      `${segment.id}.mp3`,
    );
    writeBufferExclusive(stagedAudioPath, response.audio);
    const media = validateSegmentAudio(stagedAudioPath, segment);
    const maximumSeconds = media.decodedDurationSeconds;
    const alignment = validateAlignment(
      response.alignment,
      `${segment.id}.alignment`,
      maximumSeconds,
    );
    const normalizedAlignment = validateAlignment(
      response.normalizedAlignment,
      `${segment.id}.normalized_alignment`,
      maximumSeconds,
    );
    alignments.push({
      id: segment.id,
      alignment,
      normalized_alignment: normalizedAlignment,
    });
    generated.push({
      manifest: {
        ...segment,
        words: wordCount(segment.text),
        audioPath: path.relative(
          repoRoot,
          path.join(finalRunDirectory, "segments", `${segment.id}.mp3`),
        ),
        providerRequestId: response.requestId,
        ...media,
      },
      stagedAudioPath,
    });
  }
  return { alignments, generated, reusedFromRunId: null };
};

const resolveOwnedRunPath = (relativePath, label) => {
  if (typeof relativePath !== "string" || path.isAbsolute(relativePath)) {
    fail(`${label} must be a repository-relative artifact path.`);
  }
  const resolved = path.resolve(repoRoot, relativePath);
  const ownership = path.relative(runsDirectory, resolved);
  if (
    ownership === "" ||
    ownership.startsWith(`..${path.sep}`) ||
    ownership === ".." ||
    path.isAbsolute(ownership)
  ) {
    fail(`${label} escapes ${path.relative(repoRoot, runsDirectory)}.`);
  }
  return resolved;
};

const validateAlignmentDocument = (document, script) => {
  if (!isPlainObject(document) || !Array.isArray(document.alignments)) {
    fail("Reusable alignment document is invalid.");
  }
  return script.segments.map((segment) => {
    const entry = document.alignments.find(
      (candidate) => candidate?.id === segment.id,
    );
    if (!entry) fail(`Reusable alignment is missing ${segment.id}.`);
    const maximumSeconds = segment.voiceEndSeconds - segment.voiceStartSeconds;
    return {
      id: segment.id,
      alignment: validateAlignment(
        entry.alignment,
        `${segment.id}.alignment`,
        maximumSeconds,
      ),
      normalized_alignment: validateAlignment(
        entry.normalized_alignment,
        `${segment.id}.normalized_alignment`,
        maximumSeconds,
      ),
    };
  });
};

const readReusableSegments = (script, stagingDirectory, finalRunDirectory) => {
  if (!fs.existsSync(liveManifestPath)) {
    fail("--reuse-segments requires an existing validated live manifest.");
  }
  const manifest = readJson(liveManifestPath);
  if (
    manifest.mode !== "live" ||
    manifest.schemaVersion !== 1 ||
    typeof manifest.runId !== "string" ||
    !Array.isArray(manifest.segments) ||
    !isPlainObject(manifest.outputs)
  ) {
    fail("--reuse-segments requires a versioned live voice-over manifest.");
  }
  if (JSON.stringify(manifest.voice) !== JSON.stringify(script.voice)) {
    fail("Existing voice segments use different provider or voice settings.");
  }
  const alignmentSourcePath = resolveOwnedRunPath(
    manifest.outputs.alignment?.path,
    "manifest.outputs.alignment.path",
  );
  if (
    !fs.existsSync(alignmentSourcePath) ||
    hashFile(alignmentSourcePath) !== manifest.outputs.alignment.sha256
  ) {
    fail("Reusable alignment evidence is missing or failed its checksum.");
  }
  const alignments = validateAlignmentDocument(
    readJson(alignmentSourcePath),
    script,
  );
  const stagingSegmentsDirectory = path.join(stagingDirectory, "segments");
  fs.mkdirSync(stagingSegmentsDirectory, { recursive: true });
  const generated = script.segments.map((segment) => {
    const reusable = manifest.segments.find(
      (candidate) => candidate.id === segment.id,
    );
    if (
      !reusable ||
      reusable.text !== segment.text ||
      typeof reusable.audioSha256 !== "string"
    ) {
      fail(
        `Reusable voice segment ${segment.id} does not match the current script.`,
      );
    }
    const sourceAudioPath = resolveOwnedRunPath(
      reusable.audioPath,
      `${segment.id}.audioPath`,
    );
    if (
      !fs.existsSync(sourceAudioPath) ||
      hashFile(sourceAudioPath) !== reusable.audioSha256
    ) {
      fail(
        `Reusable voice segment ${segment.id} is missing or failed its checksum.`,
      );
    }
    const stagedAudioPath = path.join(
      stagingSegmentsDirectory,
      `${segment.id}.mp3`,
    );
    fs.copyFileSync(
      sourceAudioPath,
      stagedAudioPath,
      fs.constants.COPYFILE_EXCL,
    );
    fs.chmodSync(stagedAudioPath, 0o600);
    const media = validateSegmentAudio(stagedAudioPath, segment);
    return {
      manifest: {
        ...segment,
        words: wordCount(segment.text),
        audioPath: path.relative(
          repoRoot,
          path.join(finalRunDirectory, "segments", `${segment.id}.mp3`),
        ),
        providerRequestId: reusable.providerRequestId ?? null,
        ...media,
      },
      stagedAudioPath,
    };
  });
  return { alignments, generated, reusedFromRunId: manifest.runId };
};

const assembleVoice = (segments, outputPath, totalOutputSamples, mix) => {
  const inputs = segments.flatMap(({ stagedAudioPath }) => [
    "-i",
    stagedAudioPath,
  ]);
  const filters = segments.map(({ manifest }, index) => {
    const delaySamples = Math.round(
      manifest.voiceStartSeconds * outputSampleRate,
    );
    return `[${index}:a]aresample=${outputSampleRate}:async=0:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=N/SR/TB,adelay=${delaySamples}S:all=1[v${index}]`;
  });
  const mixedInputs = segments.map((_, index) => `[v${index}]`).join("");
  const voiceTruePeak = Math.min(-1.5, mix.finalTruePeakDb - 0.25);
  filters.push(
    `${mixedInputs}amix=inputs=${segments.length}:duration=longest:normalize=0,loudnorm=I=${mix.voiceTargetLufs}:TP=${voiceTruePeak}:LRA=11,aresample=${outputSampleRate},aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_len=${totalOutputSamples},atrim=end_sample=${totalOutputSamples},asetpts=N/SR/TB[out]`,
  );
  run(
    ffmpegBinary,
    [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-n",
      ...inputs,
      "-filter_complex",
      filters.join(";"),
      "-map",
      "[out]",
      "-c:a",
      "pcm_s16le",
      outputPath,
    ],
    "assemble voice-over stem",
  );
  return voiceTruePeak;
};

const assembleSoundtrack = (
  voiceInputPath,
  outputPath,
  totalOutputSamples,
  mix,
) => {
  // Convert the requested duck range to an approximate RMS threshold around the
  // normalized voice target. Final gain is still measured independently below.
  const sidechainRatio = 4;
  const thresholdDb =
    mix.voiceTargetLufs - mix.sidechainTargetDb / (1 - 1 / sidechainRatio);
  const sidechainThreshold = Math.max(
    0.000_976_563,
    Math.min(1, 10 ** (thresholdDb / 20)),
  );
  run(
    ffmpegBinary,
    [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-n",
      "-i",
      scorePath,
      "-i",
      voiceInputPath,
      "-filter_complex",
      [
        `[0:a]aresample=${outputSampleRate}:async=0:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo[music]`,
        `[1:a]aresample=${outputSampleRate}:async=0:first_pts=0,aformat=sample_fmts=fltp:channel_layouts=stereo,asplit=2[voice_key][voice_mix]`,
        `[music][voice_key]sidechaincompress=threshold=${sidechainThreshold.toFixed(8)}:ratio=${sidechainRatio}:attack=25:release=450:makeup=1[ducked]`,
        `[ducked][voice_mix]amix=inputs=2:duration=longest:normalize=0,loudnorm=I=${mix.finalTargetLufs}:TP=${mix.finalTruePeakDb}:LRA=11,aresample=${outputSampleRate},aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_len=${totalOutputSamples},atrim=end_sample=${totalOutputSamples},asetpts=N/SR/TB[out]`,
      ].join(";"),
      "-map",
      "[out]",
      "-c:a",
      "pcm_s16le",
      outputPath,
    ],
    "assemble ducked soundtrack",
  );
};

const validateOutput = (filePath, label, targetLoudness, maximumTruePeak) => {
  const probe = probeAudio(filePath);
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const audioStreams = streams.filter(
    (stream) => stream.codec_type === "audio",
  );
  const audio = audioStreams[0];
  if (
    streams.length !== 1 ||
    audioStreams.length !== 1 ||
    audio?.codec_name !== "pcm_s16le" ||
    Number(audio.sample_rate) !== outputSampleRate ||
    audio.channels !== 2
  ) {
    fail(`${label} must contain exactly one 48 kHz stereo PCM16 stream.`);
  }
  const decodedSamples = countDecodedSamples(filePath);
  if (decodedSamples !== requiredOutputSamples) {
    fail(
      `${label} contains ${decodedSamples} decoded samples, not ${requiredOutputSamples}.`,
    );
  }
  fullDecode(filePath);
  const loudness = measureLoudness(filePath);
  if (
    Math.abs(loudness.integratedLoudness - targetLoudness) > loudnessToleranceLu
  ) {
    fail(
      `${label} measured ${loudness.integratedLoudness.toFixed(1)} LUFS; target ${targetLoudness} ± ${loudnessToleranceLu}.`,
    );
  }
  if (loudness.truePeak > maximumTruePeak + peakToleranceDb) {
    fail(
      `${label} measured ${loudness.truePeak.toFixed(1)} dBFS true peak; maximum ${maximumTruePeak} dBFS.`,
    );
  }
  const durationSeconds = decodedSamples / outputSampleRate;
  if (durationSeconds !== requiredTotalDurationSeconds) {
    fail(`${label} is not exactly ${requiredTotalDurationSeconds} seconds.`);
  }
  return {
    path: null,
    sha256: hashFile(filePath),
    bytes: fs.statSync(filePath).size,
    codec: audio.codec_name,
    sampleRate: Number(audio.sample_rate),
    channels: audio.channels,
    decodedSamples,
    durationSeconds,
    integratedLoudness: loudness.integratedLoudness,
    truePeak: loudness.truePeak,
  };
};

const makeRunId = () =>
  `${new Date().toISOString().replace(/[-:.TZ]/gu, "")}-${randomUUID()}`;

const removeOwnedStagingDirectory = (stagingDirectory) => {
  if (
    path.dirname(stagingDirectory) !== runsDirectory ||
    !path.basename(stagingDirectory).startsWith(".staging-")
  ) {
    fail("Refusing to remove an unowned voice-over staging directory.");
  }
  fs.rmSync(stagingDirectory, { force: true, recursive: true });
};

const writeDryRunManifest = (script, score, totalOutputSamples) => {
  const scriptBytes = fs.readFileSync(scriptPath);
  const manifest = {
    schemaVersion: 1,
    mode: "dry-run",
    generatedAt: new Date().toISOString(),
    billableRequestSent: false,
    script: {
      path: path.relative(repoRoot, scriptPath),
      sha256: sha256(scriptBytes),
      version: script.version,
      language: script.language,
    },
    voice: script.voice,
    mix: script.mix,
    score,
    target: {
      durationSeconds: requiredTotalDurationSeconds,
      decodedSamples: totalOutputSamples,
      sampleRate: outputSampleRate,
      channels: 2,
    },
    segments: script.segments.map((segment) => ({
      ...segment,
      words: wordCount(segment.text),
    })),
    plannedRunDirectory: path.relative(repoRoot, runsDirectory),
  };
  writeJsonAtomically(dryRunManifestPath, manifest);
  console.log(
    `Dry run passed: ${manifest.segments.length} segments, ${manifest.segments.reduce(
      (total, segment) => total + segment.words,
      0,
    )} spoken words, exact ${requiredTotalDurationSeconds}s target. No provider request was sent.`,
  );
  console.log(
    `Dry-run evidence: ${path.relative(repoRoot, dryRunManifestPath)}`,
  );
};

const runLive = async (script, validated, score, reuseSegments) => {
  let apiKey = null;
  if (!reuseSegments) {
    apiKey = process.env.ELEVENLABS_API_KEY?.trim() ?? "";
    delete process.env.ELEVENLABS_API_KEY;
    if (!apiKey || apiKey.length > 512 || /\s/u.test(apiKey)) {
      fail(
        "A valid ELEVENLABS_API_KEY is required for explicit --live generation.",
      );
    }
  } else {
    delete process.env.ELEVENLABS_API_KEY;
  }

  fs.mkdirSync(runsDirectory, { recursive: true });
  const stagingDirectory = fs.mkdtempSync(
    path.join(runsDirectory, ".staging-"),
  );
  const runId = makeRunId();
  const finalRunDirectory = path.join(runsDirectory, runId);
  const generatedAt = new Date().toISOString();
  let finalized = false;
  try {
    const segmentResult = reuseSegments
      ? readReusableSegments(script, stagingDirectory, finalRunDirectory)
      : await generateSegments(
          script,
          stagingDirectory,
          finalRunDirectory,
          apiKey,
        );
    apiKey = null;
    const alignmentDocument = {
      schemaVersion: 1,
      generatedAt,
      reusedFromRunId: segmentResult.reusedFromRunId,
      alignments: segmentResult.alignments,
    };
    const stagedAlignmentPath = path.join(stagingDirectory, "alignment.json");
    writeJsonAtomically(stagedAlignmentPath, alignmentDocument);

    const stagedVoicePath = path.join(
      stagingDirectory,
      "program-cue-voiceover.wav",
    );
    const stagedSoundtrackPath = path.join(
      stagingDirectory,
      "program-cue-soundtrack.wav",
    );
    const voiceTruePeak = assembleVoice(
      segmentResult.generated,
      stagedVoicePath,
      validated.totalOutputSamples,
      validated.mix,
    );
    const voiceMedia = validateOutput(
      stagedVoicePath,
      "voice-over stem",
      validated.mix.voiceTargetLufs,
      voiceTruePeak,
    );
    assembleSoundtrack(
      stagedVoicePath,
      stagedSoundtrackPath,
      validated.totalOutputSamples,
      validated.mix,
    );
    const soundtrackMedia = validateOutput(
      stagedSoundtrackPath,
      "mixed soundtrack",
      validated.mix.finalTargetLufs,
      validated.mix.finalTruePeakDb,
    );
    fs.chmodSync(stagedVoicePath, 0o600);
    fs.chmodSync(stagedSoundtrackPath, 0o600);

    const finalAlignmentPath = path.join(finalRunDirectory, "alignment.json");
    const finalVoicePath = path.join(
      finalRunDirectory,
      "program-cue-voiceover.wav",
    );
    const finalSoundtrackPath = path.join(
      finalRunDirectory,
      "program-cue-soundtrack.wav",
    );
    voiceMedia.path = path.relative(repoRoot, finalVoicePath);
    soundtrackMedia.path = path.relative(repoRoot, finalSoundtrackPath);
    const manifest = {
      schemaVersion: 1,
      mode: "live",
      runId,
      generatedAt,
      generation: reuseSegments
        ? "reused-validated-segments"
        : "elevenlabs-live",
      reusedFromRunId: segmentResult.reusedFromRunId,
      script: {
        path: path.relative(repoRoot, scriptPath),
        sha256: hashFile(scriptPath),
        version: script.version,
        language: script.language,
      },
      voice: script.voice,
      mix: script.mix,
      score,
      segments: segmentResult.generated.map(({ manifest: segment }) => segment),
      outputs: {
        alignment: {
          path: path.relative(repoRoot, finalAlignmentPath),
          sha256: hashFile(stagedAlignmentPath),
        },
        voice: voiceMedia,
        soundtrack: soundtrackMedia,
      },
    };
    writeJsonAtomically(path.join(stagingDirectory, "manifest.json"), manifest);
    fs.renameSync(stagingDirectory, finalRunDirectory);
    finalized = true;
    // Publish the live pointer only after every versioned artifact has passed.
    writeJsonAtomically(liveManifestPath, manifest);
    console.log(
      `Validated live voice-over run: ${path.relative(repoRoot, finalRunDirectory)}`,
    );
    console.log(
      `Live manifest published last: ${path.relative(repoRoot, liveManifestPath)}`,
    );
  } finally {
    apiKey = null;
    if (!finalized && fs.existsSync(stagingDirectory)) {
      removeOwnedStagingDirectory(stagingDirectory);
    }
  }
};

const main = async () => {
  const mode = parseArguments();
  const script = readJson(scriptPath);
  const pictureLock = readPictureLock();
  const validated = validateScript(script, pictureLock);
  requireTool(ffmpegBinary);
  requireTool(ffprobeBinary);
  const score = validateScore();
  if (!mode.live) {
    writeDryRunManifest(script, score, validated.totalOutputSamples);
    return;
  }
  await runLive(script, validated, score, mode.reuseSegments);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
