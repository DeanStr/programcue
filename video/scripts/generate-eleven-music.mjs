#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "../..");
const planPath = path.join(repoRoot, "video", "eleven-music-plan.json");
const timelinePath = path.join(repoRoot, "video", "timeline.json");
const outputDirectory = path.join(repoRoot, ".artifacts", "video-music");
const metadataPath = path.join(
  outputDirectory,
  "program-cue-eleven-music-candidate.json",
);
const endpoint = new URL("https://api.elevenlabs.io/v1/music");
endpoint.searchParams.set("output_format", "mp3_48000_192");
const ffmpegBinary = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
const ffprobeBinary = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";

const sceneSections = {
  opening: "[Act I — Signal: Opening]",
  reveal: "[Act I — Signal: Reveal]",
  command: "[Act II — Orientation: Command]",
  setup: "[Act II — Orientation: Setup]",
  collect: "[Act III — Momentum: Collect]",
  decide: "[Act III — Momentum: Decide]",
  prepare: "[Act IV — Human Intelligence: Prepare]",
  assist: "[Act IV — Human Intelligence: Assist]",
  communicate: "[Act V — Connection: Communicate]",
  place: "[Act V — Connection: Place]",
  publish: "[Act VI — Release: Publish]",
  operate: "[Act VII — Control: Operate]",
  closing: "[Act VII — Control: Closing]",
};
const chunkKeys = new Set([
  "text",
  "duration_ms",
  "positive_styles",
  "negative_styles",
  "context_adherence",
]);
const maxResponseBytes = 64 * 1024 * 1024;
const minimumPlausibleMp3Bytes = 100_000;
const requiredDurationSeconds = 360;
const requiredSampleRate = 48_000;
// MPEG audio frames contain 1152 samples. Eleven may return one complete
// frame beyond the picture lock; raw candidates may preserve that overhang,
// but metadata must expose it. Sample count alone cannot prove whether the
// correction belongs at the head or tail, so the mastering recipe must make
// and record that alignment decision before mounting a derivative.
const maximumEncodedOverhangSamples = 1_152;

const fail = (message) => {
  throw new Error(message);
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

const run = (binary, args, label) => {
  const childEnvironment = { ...process.env };
  delete childEnvironment.ELEVENLABS_API_KEY;
  const result = spawnSync(binary, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: childEnvironment,
    maxBuffer: 4 * 1024 * 1024,
  });
  if (result.error) {
    fail(`${label} failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.trim().slice(-2_000);
    fail(`${label} failed: ${detail || `exit ${result.status}`}`);
  }
  return result.stdout;
};

const requireMediaTools = () => {
  run(ffmpegBinary, ["-version"], `${ffmpegBinary} probe`);
  run(ffprobeBinary, ["-version"], `${ffprobeBinary} probe`);
};

const readPictureLock = () => {
  let source;
  let value;
  try {
    source = fs.readFileSync(timelinePath);
    value = JSON.parse(source.toString("utf8"));
  } catch (error) {
    fail(
      `Could not read ${path.relative(repoRoot, timelinePath)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== 4 ||
    value.fps !== 30 ||
    value.width !== 1920 ||
    value.height !== 1080 ||
    !Array.isArray(value.scenes) ||
    value.scenes.length !== Object.keys(sceneSections).length
  ) {
    fail(
      "video/timeline.json must describe the 1920x1080, 30 fps, 13-scene picture lock.",
    );
  }
  const allowedRootKeys = new Set(["fps", "width", "height", "scenes"]);
  const unknownRootKeys = Object.keys(value).filter(
    (key) => !allowedRootKeys.has(key),
  );
  if (unknownRootKeys.length > 0) {
    fail(
      `video/timeline.json has unknown fields: ${unknownRootKeys.join(", ")}.`,
    );
  }

  const seen = new Set();
  const scenes = value.scenes.map((scene, index) => {
    if (
      !scene ||
      typeof scene !== "object" ||
      Array.isArray(scene) ||
      Object.keys(scene).length !== 2 ||
      typeof scene.key !== "string" ||
      !Object.hasOwn(sceneSections, scene.key) ||
      seen.has(scene.key) ||
      !Number.isInteger(scene.durationInFrames) ||
      scene.durationInFrames < 1
    ) {
      fail(`video/timeline.json scene ${index + 1} is invalid.`);
    }
    seen.add(scene.key);
    return { key: scene.key, frames: scene.durationInFrames };
  });
  const totalFrames = scenes.reduce((total, scene) => total + scene.frames, 0);
  if (totalFrames !== requiredDurationSeconds * value.fps) {
    fail(
      `video/timeline.json contains ${totalFrames} frames; picture lock requires ${requiredDurationSeconds * value.fps}.`,
    );
  }
  return {
    fps: value.fps,
    width: value.width,
    height: value.height,
    scenes,
    totalFrames,
    sha256: createHash("sha256").update(source).digest("hex"),
  };
};

const validateStyles = (value, field, label) => {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    fail(`${label}.${field} must contain 1-50 style strings.`);
  }
  for (const style of value) {
    if (typeof style !== "string" || style.trim().length < 2) {
      fail(`${label}.${field} contains an invalid style.`);
    }
  }
};

const validatePlan = (plan, pictureLock) => {
  if (
    !plan ||
    typeof plan !== "object" ||
    Array.isArray(plan) ||
    Object.keys(plan).length !== 1 ||
    !Array.isArray(plan.chunks)
  ) {
    fail("The Eleven Music plan must contain only a chunks array.");
  }
  if (
    plan.chunks.length !== pictureLock.scenes.length ||
    plan.chunks.length !== Object.keys(sceneSections).length
  ) {
    fail(
      `The music plan needs exactly ${pictureLock.scenes.length} picture-locked chunks.`,
    );
  }

  let totalDurationMs = 0;
  for (const [index, chunk] of plan.chunks.entries()) {
    const label = `chunks[${index}]`;
    const scene = pictureLock.scenes[index];
    const expectedSection = sceneSections[scene.key];
    if (!chunk || typeof chunk !== "object" || Array.isArray(chunk)) {
      fail(`${label} must be an object.`);
    }
    const unknownKeys = Object.keys(chunk).filter((key) => !chunkKeys.has(key));
    if (unknownKeys.length > 0) {
      fail(`${label} has unsupported fields: ${unknownKeys.join(", ")}.`);
    }
    if (chunk.text !== `${expectedSection}\n{instrumental}`) {
      fail(`${label}.text must identify its exact act and picture-lock scene.`);
    }
    if (
      !Number.isInteger(chunk.duration_ms) ||
      chunk.duration_ms < 3_000 ||
      chunk.duration_ms > 120_000
    ) {
      fail(`${label}.duration_ms must be an integer from 3000 to 120000.`);
    }
    const expectedDurationMs = (scene.frames / pictureLock.fps) * 1_000;
    if (!Number.isInteger(expectedDurationMs)) {
      fail(`Picture-lock scene ${scene.key} does not end on a millisecond.`);
    }
    if (chunk.duration_ms !== expectedDurationMs) {
      fail(
        `${label} is ${chunk.duration_ms}ms; scene ${scene.key} requires ${expectedDurationMs}ms.`,
      );
    }
    validateStyles(chunk.positive_styles, "positive_styles", label);
    validateStyles(chunk.negative_styles, "negative_styles", label);
    if (
      !chunk.negative_styles.some((style) =>
        style.toLocaleLowerCase("en").includes("vocals"),
      )
    ) {
      fail(`${label} must explicitly exclude vocals.`);
    }
    if (chunk.context_adherence !== "high") {
      fail(`${label}.context_adherence must be high for score continuity.`);
    }
    totalDurationMs += chunk.duration_ms;
  }

  const pictureDurationMs = pictureLock.scenes.reduce(
    (total, scene) => total + (scene.frames / pictureLock.fps) * 1_000,
    0,
  );
  if (totalDurationMs !== pictureDurationMs || totalDurationMs !== 360_000) {
    fail(
      `The plan is ${totalDurationMs}ms; the six-minute picture lock is ${pictureDurationMs}ms.`,
    );
  }
  return totalDurationMs;
};

const isMp3 = (audio) =>
  (audio[0] === 0x49 && audio[1] === 0x44 && audio[2] === 0x33) ||
  (audio[0] === 0xff && (audio[1] & 0xe0) === 0xe0);

const makeTemporaryPath = (filePath) =>
  `${filePath}.${process.pid}.${randomUUID()}.tmp`;

const fsyncDirectory = (directoryPath) => {
  let directory;
  try {
    directory = fs.openSync(directoryPath, "r");
    fs.fsyncSync(directory);
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !["EINVAL", "ENOTSUP", "EPERM"].includes(error.code)
    ) {
      throw error;
    }
  } finally {
    if (directory !== undefined) fs.closeSync(directory);
  }
};

const writeAtomically = (filePath, contents) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = makeTemporaryPath(filePath);
  let file;
  try {
    file = fs.openSync(temporaryPath, "wx", 0o600);
    fs.writeFileSync(file, contents);
    fs.fsyncSync(file);
    fs.closeSync(file);
    file = undefined;
    fs.renameSync(temporaryPath, filePath);
    fsyncDirectory(path.dirname(filePath));
  } finally {
    if (file !== undefined) fs.closeSync(file);
    fs.rmSync(temporaryPath, { force: true });
  }
};

const writeExclusiveDurably = (filePath, contents) => {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let file;
  try {
    file = fs.openSync(filePath, "wx", 0o600);
    fs.writeFileSync(file, contents);
    fs.fsyncSync(file);
    fs.closeSync(file);
    file = undefined;
    fsyncDirectory(path.dirname(filePath));
  } finally {
    if (file !== undefined) fs.closeSync(file);
  }
};

const streamResponseToTemporaryFile = async (response, temporaryPath) => {
  if (!response.body) {
    fail("Eleven Music returned an empty response body.");
  }
  const reader = response.body.getReader();
  const file = fs.openSync(temporaryPath, "wx", 0o600);
  let byteCount = 0;
  const signature = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      byteCount += chunk.length;
      if (byteCount > maxResponseBytes) {
        await reader.cancel();
        fail(
          `Eleven Music exceeded the ${maxResponseBytes}-byte response cap.`,
        );
      }
      for (const byte of chunk.subarray(0, Math.max(0, 3 - signature.length))) {
        signature.push(byte);
      }
      let offset = 0;
      while (offset < chunk.length) {
        offset += fs.writeSync(file, chunk, offset, chunk.length - offset);
      }
    }
    fs.fsyncSync(file);
  } finally {
    fs.closeSync(file);
  }
  if (byteCount < minimumPlausibleMp3Bytes || !isMp3(signature)) {
    fail(
      `Eleven Music returned an invalid or implausible MP3 (${byteCount} bytes).`,
    );
  }
  return byteCount;
};

const validateDownloadedAudio = (filePath) => {
  const probe = JSON.parse(
    run(
      ffprobeBinary,
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-show_entries",
        "stream=codec_type,codec_name,sample_rate,channels,bit_rate",
        "-of",
        "json",
        filePath,
      ],
      "Eleven Music candidate probe",
    ),
  );
  const audioStreams = (probe.streams ?? []).filter(
    (stream) => stream.codec_type === "audio",
  );
  const stream = audioStreams[0];
  const durationSeconds = Number(probe.format?.duration);
  if (
    audioStreams.length !== 1 ||
    stream?.codec_name !== "mp3" ||
    Number(stream.sample_rate) !== requiredSampleRate ||
    stream.channels !== 2 ||
    Number(stream.bit_rate) !== 192_000 ||
    !Number.isFinite(durationSeconds)
  ) {
    fail(
      "Eleven Music candidate must be one finite-duration 48 kHz stereo 192 kbps MP3 stream.",
    );
  }
  run(
    ffmpegBinary,
    [
      "-v",
      "error",
      "-xerror",
      "-i",
      filePath,
      "-map",
      "0:a:0",
      "-f",
      "null",
      "-",
    ],
    "Eleven Music candidate full decode",
  );
  const decodedFrameSamples = run(
    ffprobeBinary,
    [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_entries",
      "frame=nb_samples",
      "-of",
      "csv=p=0",
      filePath,
    ],
    "Eleven Music decoded-sample probe",
  )
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((value) => Number(value));
  if (
    decodedFrameSamples.length < 1 ||
    decodedFrameSamples.some(
      (sampleCount) => !Number.isInteger(sampleCount) || sampleCount < 1,
    )
  ) {
    fail("Could not determine the exact decoded sample count.");
  }
  const decodedSamples = decodedFrameSamples.reduce(
    (total, sampleCount) => total + sampleCount,
    0,
  );
  const pictureLockSamples = requiredDurationSeconds * requiredSampleRate;
  const excessDecodedSamples = decodedSamples - pictureLockSamples;
  if (
    excessDecodedSamples < 0 ||
    excessDecodedSamples > maximumEncodedOverhangSamples
  ) {
    fail(
      `Eleven Music candidate decodes to ${decodedSamples} samples; picture lock is ${pictureLockSamples}, with at most one ${maximumEncodedOverhangSamples}-sample encoded frame of explicit trim overhang allowed.`,
    );
  }
  const decodedDurationSeconds = decodedSamples / requiredSampleRate;
  if (
    Math.abs(durationSeconds - decodedDurationSeconds) >
    maximumEncodedOverhangSamples / requiredSampleRate
  ) {
    fail(
      `Container duration ${durationSeconds}s disagrees with the ${decodedSamples}-sample decode (${decodedDurationSeconds}s).`,
    );
  }
  return {
    codec: stream.codec_name,
    sampleRate: requiredSampleRate,
    channels: stream.channels,
    bitRate: Number(stream.bit_rate),
    durationSeconds,
    decodedSamples,
    decodedDurationSeconds,
    pictureLockSamples,
    pictureLockDurationSeconds: requiredDurationSeconds,
    excessDecodedSamples,
    requiredTrimSamples: excessDecodedSamples,
    trimPlacement: excessDecodedSamples === 0 ? "none" : "mastering-decision",
    pictureLockStatus:
      excessDecodedSamples === 0 ? "exact" : "requires-explicit-trim",
  };
};

const readSafeError = async (response, apiKey) => {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let byteCount = 0;
  try {
    while (byteCount < 1_000) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value).subarray(0, 1_000 - byteCount);
      chunks.push(chunk);
      byteCount += chunk.length;
      if (chunk.length < value.length) break;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const errorText = Buffer.concat(chunks).toString("utf8").trim();
  return errorText.replaceAll(apiKey, "[redacted]");
};

const generate = async (plan, pictureLock) => {
  const apiKey = process.env.ELEVENLABS_API_KEY?.trim();
  if (!apiKey) {
    fail(
      "ELEVENLABS_API_KEY is required. Supply a newly rotated key in the process environment.",
    );
  }
  requireMediaTools();

  const requestBody = {
    composition_plan: plan,
    model_id: "music_v2",
    store_for_inpainting: false,
    sign_with_c2pa: true,
  };
  const planSha256 = createHash("sha256")
    .update(JSON.stringify(plan))
    .digest("hex");
  if (fs.existsSync(metadataPath)) {
    const existingMetadata = readJson(metadataPath);
    if (existingMetadata.planSha256 === planSha256) {
      fail(
        `A candidate for this composition plan already exists at ${path.relative(repoRoot, metadataPath)}; no provider request was sent.`,
      );
    }
  }
  const requestSha256 = createHash("sha256")
    .update(
      JSON.stringify({
        endpoint: endpoint.href,
        pictureLockSha256: pictureLock.sha256,
        requestBody,
      }),
    )
    .digest("hex");
  const requestIntentPath = path.join(
    outputDirectory,
    "requests",
    `${requestSha256}.json`,
  );
  const requestCreatedAt = new Date().toISOString();
  try {
    writeExclusiveDurably(
      requestIntentPath,
      `${JSON.stringify(
        {
          status: "pending",
          createdAt: requestCreatedAt,
          requestSha256,
          planSha256,
          pictureLockSha256: pictureLock.sha256,
          endpoint: endpoint.origin + endpoint.pathname,
          modelId: requestBody.model_id,
          outputFormat: "mp3_48000_192",
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    if (error && typeof error === "object" && error.code === "EEXIST") {
      fail(
        `Request intent ${path.relative(repoRoot, requestIntentPath)} already exists; reconcile it before retrying. No provider request was sent.`,
      );
    }
    throw error;
  }

  const response = await fetch(endpoint, {
    method: "POST",
    redirect: "error",
    headers: {
      accept: "audio/mpeg",
      "content-type": "application/json",
      "xi-api-key": apiKey,
    },
    body: JSON.stringify(requestBody),
    signal: AbortSignal.timeout(20 * 60 * 1_000),
  });

  if (!response.ok) {
    const detail = await readSafeError(response, apiKey);
    fail(
      `Eleven Music returned HTTP ${response.status}${detail ? `: ${detail}` : "."}`,
    );
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  const acceptedContentTypes = [
    "audio/mpeg",
    "audio/mp3",
    "application/octet-stream",
  ];
  if (!acceptedContentTypes.some((type) => contentType.startsWith(type))) {
    fail(
      `Eleven Music returned unexpected content-type "${contentType || "missing"}".`,
    );
  }
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredLength = Number(contentLength);
    if (
      !Number.isFinite(declaredLength) ||
      declaredLength < minimumPlausibleMp3Bytes ||
      declaredLength > maxResponseBytes
    ) {
      fail(`Eleven Music declared an implausible response length.`);
    }
  }

  fs.mkdirSync(outputDirectory, { recursive: true });
  const temporaryAudioPath = makeTemporaryPath(
    path.join(outputDirectory, "program-cue-eleven-music-download.mp3"),
  );
  try {
    const byteCount = await streamResponseToTemporaryFile(
      response,
      temporaryAudioPath,
    );
    const media = validateDownloadedAudio(temporaryAudioPath);
    const audioSha256 = createHash("sha256")
      .update(fs.readFileSync(temporaryAudioPath))
      .digest("hex");
    const candidatePath = path.join(
      outputDirectory,
      `program-cue-eleven-music-${audioSha256}.mp3`,
    );
    let installedNewCandidate = false;
    let metadataInstalled = false;
    try {
      if (fs.existsSync(candidatePath)) {
        const existingSha256 = createHash("sha256")
          .update(fs.readFileSync(candidatePath))
          .digest("hex");
        if (existingSha256 !== audioSha256) {
          fail("Existing content-addressed music candidate failed its hash.");
        }
        fs.rmSync(temporaryAudioPath);
      } else {
        fs.renameSync(temporaryAudioPath, candidatePath);
        installedNewCandidate = true;
      }
      writeAtomically(
        metadataPath,
        `${JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            mountedInLaunchFilm: false,
            modelId: "music_v2",
            outputFormat: "mp3_48000_192",
            c2paRequested: true,
            storedForInpainting: false,
            songId: response.headers.get("song-id"),
            planPath: path.relative(repoRoot, planPath),
            planSha256,
            pictureLockPath: path.relative(repoRoot, timelinePath),
            pictureLockSha256: pictureLock.sha256,
            pictureLockFps: pictureLock.fps,
            pictureLockFrames: pictureLock.totalFrames,
            pictureLockScenes: pictureLock.scenes,
            audioPath: path.relative(repoRoot, candidatePath),
            audioSha256,
            byteCount,
            ...media,
          },
          null,
          2,
        )}\n`,
      );
      metadataInstalled = true;
      writeAtomically(
        requestIntentPath,
        `${JSON.stringify(
          {
            status: "completed",
            createdAt: requestCreatedAt,
            completedAt: new Date().toISOString(),
            requestSha256,
            planSha256,
            pictureLockSha256: pictureLock.sha256,
            audioPath: path.relative(repoRoot, candidatePath),
            audioSha256,
            songId: response.headers.get("song-id"),
          },
          null,
          2,
        )}\n`,
      );
    } catch (error) {
      if (installedNewCandidate && !metadataInstalled) {
        fs.rmSync(candidatePath, { force: true });
      }
      throw error;
    }
    const alignmentSummary =
      media.requiredTrimSamples === 0
        ? "exact picture lock"
        : `${media.requiredTrimSamples} samples require an explicit mastering alignment decision`;
    console.log(
      `Wrote validated, unmounted music candidate to ${path.relative(repoRoot, candidatePath)} (${byteCount} bytes; ${media.decodedSamples} decoded samples, ${alignmentSummary}).`,
    );
  } finally {
    fs.rmSync(temporaryAudioPath, { force: true });
  }
};

const main = async () => {
  const args = process.argv.slice(2);
  const validateCandidate = args[0] === "--validate-candidate";
  const live = args[0] === "--live";
  if (
    (validateCandidate && args.length !== 2) ||
    (!validateCandidate &&
      !(
        args.length === 0 ||
        (args.length === 1 && (args[0] === "--check" || live))
      ))
  ) {
    fail(
      "Usage: npm run video:music:eleven [-- --check | --validate-candidate <mp3> | --live]",
    );
  }
  const plan = readJson(planPath);
  const pictureLock = readPictureLock();
  const durationMs = validatePlan(plan, pictureLock);
  if (validateCandidate) {
    requireMediaTools();
    const candidatePath = path.resolve(repoRoot, args[1]);
    const media = validateDownloadedAudio(candidatePath);
    const alignmentSummary =
      media.requiredTrimSamples === 0
        ? "exact picture lock"
        : `${media.requiredTrimSamples} samples require an explicit mastering alignment decision`;
    console.log(
      `Candidate passed: ${media.decodedSamples} decoded samples (${media.decodedDurationSeconds}s); ${alignmentSummary} for the ${media.pictureLockDurationSeconds}s picture lock. No request was sent.`,
    );
    return;
  }
  if (!live) {
    console.log(
      `Eleven Music plan passed: ${plan.chunks.length} chunks, ${durationMs / 1_000}s, exact picture lock. No request was sent.`,
    );
    return;
  }
  await generate(plan, pictureLock);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
