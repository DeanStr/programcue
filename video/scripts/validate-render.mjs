#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { validateDescriptions } from "./validate-descriptions.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "../..");
const artifactsDirectory = path.join(repoRoot, ".artifacts");
const defaultOutput = path.join(
  repoRoot,
  ".artifacts",
  "program-cue-launch.mp4",
);
const releaseManifestPath = path.join(
  repoRoot,
  "site",
  "public",
  "product-film-release.json",
);
const outputPath = path.resolve(
  repoRoot,
  process.argv[2] ?? path.relative(repoRoot, defaultOutput),
);
let audioReferencePath;
let expectedAudioStreamSha256;
const outputParts = path.parse(outputPath);
const descriptionSidecarPath = path.join(
  outputParts.dir,
  `${outputParts.name}.vtt`,
);
const descriptionSourcePath = path.join(
  repoRoot,
  "video",
  "delivery",
  "program-cue-launch-descriptions.vtt",
);
const ffprobeBinary = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
const ffmpegBinary = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
const target = {
  width: 1920,
  height: 1080,
  fps: 30,
  frames: 10_800,
  durationSeconds: 360,
  durationToleranceSeconds: 0.001,
  streamParityToleranceSeconds: 0.001,
  startToleranceSeconds: 1 / 48_000,
  videoCodec: "h264",
  pixelFormat: "yuv420p",
  colorRange: "tv",
  colorSpace: "bt709",
  colorTransfer: "bt709",
  colorPrimaries: "bt709",
  audioCodec: "aac",
  audioSampleRate: 48_000,
  audioChannels: 2,
  minimumAudioBitrate: 256_000,
  integratedLoudnessMin: -16.5,
  integratedLoudnessMax: -13.5,
  maximumTruePeak: -1.5,
  maximumBlackSeconds: 3,
  maximumFreezeSeconds: 5,
  maximumSilenceSeconds: 5,
  audioSyncWindowStartSeconds: 12,
  audioSyncWindowDurationSeconds: 7,
  audioSyncSearchSamples: 4_096,
  maximumAudioSyncOffsetSamples: 1,
  minimumAudioSyncCorrelation: 0.99,
  minimumFullFileSiSdr: 30,
  maximumFrameIntervalErrorSeconds: 0.000002,
};

const checks = [];
const diagnostics = [];

const record = (label, passed, evidence) => {
  checks.push({ label, passed, evidence });
};

const command = (binary, args) =>
  spawnSync(binary, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });

const commandBuffer = (binary, args) =>
  spawnSync(binary, args, {
    cwd: repoRoot,
    maxBuffer: 4 * 1024 * 1024,
  });

const parseNumber = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const parseRate = (value) => {
  if (typeof value !== "string" && typeof value !== "number") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const [numerator, denominator] = value.split("/").map(Number);
  if (!Number.isFinite(numerator)) return null;
  if (denominator === undefined) return numerator;
  if (!Number.isFinite(denominator) || denominator === 0) return null;
  return numerator / denominator;
};

const formatNumber = (value, digits = 3) =>
  typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(digits)
    : "unknown";

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

const resolveAudioReferencePath = () => {
  let release;
  try {
    release = JSON.parse(fs.readFileSync(releaseManifestPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Could not read the product-film release manifest: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    release?.audioSource !== "eleven_music_v2" ||
    typeof release.videoUrl !== "string" ||
    typeof release.audioStreamSha256 !== "string" ||
    !/^[a-f0-9]{64}$/u.test(release.audioStreamSha256)
  ) {
    throw new Error(
      "The product-film release manifest does not select an Eleven audio reference.",
    );
  }
  expectedAudioStreamSha256 = release.audioStreamSha256;
  if (process.argv[3]) return path.resolve(repoRoot, process.argv[3]);
  return path.join(
    artifactsDirectory,
    "video-releases",
    path.basename(new URL(release.videoUrl).pathname),
  );
};

const validatePinnedAudioStream = () => {
  const result = command(ffmpegBinary, [
    "-v",
    "error",
    "-nostdin",
    "-i",
    outputPath,
    "-map",
    "0:a:0",
    "-c:a",
    "copy",
    "-f",
    "hash",
    "-hash",
    "sha256",
    "-",
  ]);
  if (result.error || result.status !== 0) {
    throw new Error(
      `Encoded audio hash failed: ${result.error?.message ?? result.stderr?.trim() ?? `exit ${result.status}`}`,
    );
  }
  const digest = result.stdout.trim().match(/^SHA256=([a-f0-9]{64})$/u)?.[1];
  if (digest !== expectedAudioStreamSha256) {
    throw new Error(
      `Encoded AAC stream does not match the pinned release: expected ${expectedAudioStreamSha256}, received ${digest ?? "invalid hash output"}.`,
    );
  }
  record("encoded AAC stream matches pinned release", true, digest);
};

const validateDescriptionSidecar = () => {
  if (
    !fs.existsSync(descriptionSidecarPath) ||
    !fs.statSync(descriptionSidecarPath).isFile() ||
    fs.statSync(descriptionSidecarPath).size === 0
  ) {
    record(
      "description sidecar present",
      false,
      `${path.relative(repoRoot, descriptionSidecarPath)} is missing or empty`,
    );
    return;
  }
  const sidecar = fs.readFileSync(descriptionSidecarPath);
  const sidecarHash = sha256(sidecar);
  record(
    "description sidecar present",
    true,
    `${path.relative(repoRoot, descriptionSidecarPath)}, sha256 ${sidecarHash}`,
  );

  if (!fs.existsSync(descriptionSourcePath)) {
    record(
      "description sidecar matches delivery source",
      false,
      `${path.relative(repoRoot, descriptionSourcePath)} is missing`,
    );
  } else {
    const source = fs.readFileSync(descriptionSourcePath);
    const sourceHash = sha256(source);
    record(
      "description sidecar matches delivery source",
      sidecar.equals(source),
      `sidecar ${sidecarHash}, source ${sourceHash}`,
    );
  }

  try {
    const descriptions = validateDescriptions(
      descriptionSidecarPath,
      target.durationSeconds,
    );
    record(
      "valid picture-locked WEBVTT descriptions",
      true,
      `${descriptions.cueCount} contiguous cues, 0–${target.durationSeconds}s, maximum ${formatNumber(descriptions.maximumCps, 1)} characters/s`,
    );
  } catch (error) {
    record(
      "valid picture-locked WEBVTT descriptions",
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
};

const readProbe = () => {
  if (!fs.existsSync(outputPath)) {
    record(
      "file exists",
      false,
      `${path.relative(repoRoot, outputPath)} does not exist`,
    );
    return null;
  }

  const bytes = fs.statSync(outputPath).size;
  record("nonzero file", bytes > 0, `${bytes.toLocaleString()} bytes`);
  if (bytes === 0) return null;

  const result = command(ffprobeBinary, [
    "-v",
    "error",
    "-show_streams",
    "-show_format",
    "-of",
    "json",
    outputPath,
  ]);
  if (result.error) {
    record(
      "ffprobe",
      false,
      `could not start ffprobe: ${result.error.message}`,
    );
    return null;
  }
  if (result.status !== 0) {
    record(
      "ffprobe",
      false,
      (result.stderr || result.stdout || `exit ${result.status}`)
        .trim()
        .slice(-4_000),
    );
    return null;
  }

  try {
    const probe = JSON.parse(result.stdout);
    record("ffprobe", true, "metadata decoded");
    return probe;
  } catch (error) {
    record(
      "ffprobe",
      false,
      `invalid JSON metadata: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
};

const validateStreams = (probe) => {
  if (!probe) return;
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const videoStreams = streams.filter(
    (stream) => stream.codec_type === "video",
  );
  const audioStreams = streams.filter(
    (stream) => stream.codec_type === "audio",
  );
  const unexpectedStreams = streams.filter(
    (stream) => stream.codec_type !== "video" && stream.codec_type !== "audio",
  );
  const video = videoStreams[0];
  const audio = audioStreams[0];
  const formatDuration = parseNumber(probe.format?.duration);
  const videoDuration = parseNumber(video?.duration);
  const audioDuration = parseNumber(audio?.duration);
  const duration = formatDuration ?? videoDuration;

  record(
    "video stream",
    Boolean(video),
    video ? `${video.codec_name ?? "unknown codec"}` : "no video stream",
  );
  record(
    "exact stream topology",
    videoStreams.length === 1 &&
      audioStreams.length === 1 &&
      unexpectedStreams.length === 0,
    `${videoStreams.length} video, ${audioStreams.length} audio, ${unexpectedStreams.length} other`,
  );
  record(
    "1920x1080",
    video?.width === target.width && video?.height === target.height,
    video ? `${video.width}x${video.height}` : "no video stream",
  );

  const averageFps = parseRate(video?.avg_frame_rate);
  const realFps = parseRate(video?.r_frame_rate);
  const fps = averageFps ?? realFps;
  record(
    "constant 30fps",
    averageFps !== null &&
      realFps !== null &&
      Math.abs(averageFps - target.fps) < 0.0001 &&
      Math.abs(realFps - target.fps) < 0.0001,
    `avg=${video?.avg_frame_rate ?? "unknown"}, real=${video?.r_frame_rate ?? "unknown"}`,
  );
  record(
    "H.264 video",
    video?.codec_name?.toLowerCase() === target.videoCodec,
    video?.codec_name ?? "no video stream",
  );
  record(
    "4:2:0 pixel format",
    video?.pix_fmt === target.pixelFormat,
    video?.pix_fmt ?? "no video stream",
  );
  record(
    "BT.709 limited-range colour",
    video?.color_range === target.colorRange &&
      video?.color_space === target.colorSpace &&
      video?.color_transfer === target.colorTransfer &&
      video?.color_primaries === target.colorPrimaries,
    video
      ? `range=${video.color_range ?? "unknown"}, space=${video.color_space ?? "unknown"}, transfer=${video.color_transfer ?? "unknown"}, primaries=${video.color_primaries ?? "unknown"}`
      : "no video stream",
  );
  const frameCount = parseNumber(video?.nb_frames);
  const derivedFrameCount =
    frameCount ??
    (videoDuration !== null && fps !== null
      ? Math.round(videoDuration * fps)
      : null);
  record(
    "10800 frames",
    derivedFrameCount !== null && derivedFrameCount === target.frames,
    frameCount !== null
      ? `${frameCount} encoded frames`
      : `${derivedFrameCount ?? "unknown"} frames derived from duration × fps`,
  );
  record(
    "exact 360s duration",
    duration !== null &&
      Math.abs(duration - target.durationSeconds) <=
        target.durationToleranceSeconds,
    `${formatNumber(duration, 6)}s (target ${target.durationSeconds} ± ${target.durationToleranceSeconds}s)`,
  );
  record(
    "AAC audio",
    Boolean(audio) && audio.codec_name?.toLowerCase() === target.audioCodec,
    audio
      ? `${audio.codec_name ?? "unknown codec"}${audio.duration ? `, ${audio.duration}s` : ""}`
      : "no audio stream",
  );
  const audioSampleRate = parseNumber(audio?.sample_rate);
  record(
    "48kHz stereo audio",
    audioSampleRate === target.audioSampleRate &&
      audio?.channels === target.audioChannels,
    audio
      ? `${audioSampleRate ?? "unknown"}Hz, ${audio.channels ?? "unknown"} channels (${audio.channel_layout ?? "unknown layout"})`
      : "no audio stream",
  );
  const audioBitrate = parseNumber(audio?.bit_rate);
  record(
    "high-bitrate audio",
    audioBitrate !== null && audioBitrate >= target.minimumAudioBitrate,
    `${audioBitrate === null ? "unknown" : Math.round(audioBitrate / 1000)}kbps (minimum ${Math.round(target.minimumAudioBitrate / 1000)}kbps)`,
  );
  const parityDuration = videoDuration ?? formatDuration;
  record(
    "exact audio/video duration parity",
    parityDuration !== null &&
      audioDuration !== null &&
      Math.abs(parityDuration - audioDuration) <=
        target.streamParityToleranceSeconds,
    `video=${formatNumber(parityDuration, 6)}s, audio=${formatNumber(audioDuration, 6)}s`,
  );
  const videoStart = parseNumber(video?.start_time);
  const audioStart = parseNumber(audio?.start_time);
  record(
    "zero-based A/V start",
    videoStart !== null &&
      audioStart !== null &&
      Math.abs(videoStart) <= target.startToleranceSeconds &&
      Math.abs(audioStart) <= target.startToleranceSeconds,
    `video=${formatNumber(videoStart, 6)}s, audio=${formatNumber(audioStart, 6)}s`,
  );
};

const readPcmSamples = (buffer) => {
  const samples = new Int16Array(Math.floor(buffer.length / 2));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = buffer.readInt16LE(index * 2);
  }
  return samples;
};

const correlationAtLag = (reference, candidate, lag, stride) => {
  const margin = target.audioSyncSearchSamples;
  const end = Math.min(reference.length, candidate.length) - margin;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumYY = 0;
  let sumXY = 0;
  let count = 0;
  for (let index = margin; index < end; index += stride) {
    const x = reference[index];
    const y = candidate[index + lag];
    sumX += x;
    sumY += y;
    sumXX += x * x;
    sumYY += y * y;
    sumXY += x * y;
    count += 1;
  }
  if (count < 1) return Number.NEGATIVE_INFINITY;
  const covariance = sumXY - (sumX * sumY) / count;
  const varianceX = sumXX - (sumX * sumX) / count;
  const varianceY = sumYY - (sumY * sumY) / count;
  const denominator = Math.sqrt(Math.max(0, varianceX * varianceY));
  return denominator > 0 ? covariance / denominator : Number.NEGATIVE_INFINITY;
};

const findAudioSync = (reference, candidate) => {
  let bestLag = 0;
  let bestCorrelation = Number.NEGATIVE_INFINITY;
  for (
    let lag = -target.audioSyncSearchSamples;
    lag <= target.audioSyncSearchSamples;
    lag += 32
  ) {
    const correlation = correlationAtLag(reference, candidate, lag, 8);
    if (correlation > bestCorrelation) {
      bestLag = lag;
      bestCorrelation = correlation;
    }
  }
  const coarseLag = bestLag;
  for (let lag = coarseLag - 31; lag <= coarseLag + 31; lag += 1) {
    if (
      lag < -target.audioSyncSearchSamples ||
      lag > target.audioSyncSearchSamples
    ) {
      continue;
    }
    const correlation = correlationAtLag(reference, candidate, lag, 2);
    if (correlation > bestCorrelation) {
      bestLag = lag;
      bestCorrelation = correlation;
    }
  }
  return { correlation: bestCorrelation, lagSamples: bestLag };
};

const decodeSyncWindow = (inputPath) =>
  commandBuffer(ffmpegBinary, [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-i",
    inputPath,
    "-ss",
    String(target.audioSyncWindowStartSeconds),
    "-t",
    String(target.audioSyncWindowDurationSeconds),
    "-map",
    "0:a:0",
    "-ac",
    "1",
    "-ar",
    String(target.audioSampleRate),
    "-f",
    "s16le",
    "-",
  ]);

const validateAudioSync = () => {
  if (!fs.existsSync(audioReferencePath)) {
    record(
      "audio sync reference",
      false,
      `${path.relative(repoRoot, audioReferencePath)} does not exist`,
    );
    return;
  }
  const referenceResult = decodeSyncWindow(audioReferencePath);
  const candidateResult = decodeSyncWindow(outputPath);
  if (
    referenceResult.error ||
    referenceResult.status !== 0 ||
    candidateResult.error ||
    candidateResult.status !== 0
  ) {
    const detail =
      referenceResult.error?.message ??
      candidateResult.error?.message ??
      candidateResult.stderr?.toString().trim() ??
      referenceResult.stderr?.toString().trim() ??
      "audio window decode failed";
    record("audio sync reference", false, detail.slice(-1_000));
    return;
  }
  const reference = readPcmSamples(referenceResult.stdout);
  const candidate = readPcmSamples(candidateResult.stdout);
  const expectedSamples =
    target.audioSyncWindowDurationSeconds * target.audioSampleRate;
  if (
    reference.length !== expectedSamples ||
    candidate.length !== expectedSamples
  ) {
    record(
      "audio sync reference",
      false,
      `decoded ${reference.length} reference and ${candidate.length} candidate samples; expected ${expectedSamples}`,
    );
    return;
  }
  const { correlation, lagSamples } = findAudioSync(reference, candidate);
  const lagMilliseconds = (lagSamples / target.audioSampleRate) * 1_000;
  record(
    "encoded audio matches reference window",
    correlation >= target.minimumAudioSyncCorrelation,
    `peak correlation ${formatNumber(correlation, 6)} (minimum ${target.minimumAudioSyncCorrelation}; reference ${path.relative(repoRoot, audioReferencePath)})`,
  );
  record(
    "sample-aligned picture-lock audio",
    Math.abs(lagSamples) <= target.maximumAudioSyncOffsetSamples,
    `${lagSamples} sample(s), ${formatNumber(lagMilliseconds, 3)}ms (limit ±${target.maximumAudioSyncOffsetSamples} sample)`,
  );
};

const decodeFullAudio = (inputPath, rawOutputPath) =>
  command(ffmpegBinary, [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-y",
    "-i",
    inputPath,
    "-map",
    "0:a:0",
    "-ac",
    String(target.audioChannels),
    "-ar",
    String(target.audioSampleRate),
    "-f",
    "s16le",
    rawOutputPath,
  ]);

const calculateChannelSiSdr = (referencePath, candidatePath) => {
  const bytesPerFrame = target.audioChannels * 2;
  const blockBytes = 1024 * 1024 - ((1024 * 1024) % bytesPerFrame);
  const referenceSize = fs.statSync(referencePath).size;
  const candidateSize = fs.statSync(candidatePath).size;
  if (
    referenceSize !== candidateSize ||
    referenceSize === 0 ||
    referenceSize % bytesPerFrame !== 0
  ) {
    throw new Error(
      `decoded byte lengths differ or are invalid (reference ${referenceSize}, candidate ${candidateSize})`,
    );
  }

  const dot = Array(target.audioChannels).fill(0);
  const referenceEnergy = Array(target.audioChannels).fill(0);
  const referenceHandle = fs.openSync(referencePath, "r");
  const candidateHandle = fs.openSync(candidatePath, "r");
  const referenceBuffer = Buffer.allocUnsafe(blockBytes);
  const candidateBuffer = Buffer.allocUnsafe(blockBytes);
  try {
    for (let position = 0; position < referenceSize; position += blockBytes) {
      const length = Math.min(blockBytes, referenceSize - position);
      const referenceRead = fs.readSync(
        referenceHandle,
        referenceBuffer,
        0,
        length,
        position,
      );
      const candidateRead = fs.readSync(
        candidateHandle,
        candidateBuffer,
        0,
        length,
        position,
      );
      if (referenceRead !== length || candidateRead !== length) {
        throw new Error(`short PCM read at byte ${position}`);
      }
      for (let offset = 0; offset < length; offset += bytesPerFrame) {
        for (let channel = 0; channel < target.audioChannels; channel += 1) {
          const sampleOffset = offset + channel * 2;
          const reference = referenceBuffer.readInt16LE(sampleOffset);
          const candidate = candidateBuffer.readInt16LE(sampleOffset);
          dot[channel] += reference * candidate;
          referenceEnergy[channel] += reference * reference;
        }
      }
    }

    const scale = dot.map((value, channel) => {
      if (referenceEnergy[channel] <= 0) {
        throw new Error(`reference channel ${channel + 1} contains no energy`);
      }
      return value / referenceEnergy[channel];
    });
    const signalEnergy = Array(target.audioChannels).fill(0);
    const errorEnergy = Array(target.audioChannels).fill(0);
    for (let position = 0; position < referenceSize; position += blockBytes) {
      const length = Math.min(blockBytes, referenceSize - position);
      fs.readSync(referenceHandle, referenceBuffer, 0, length, position);
      fs.readSync(candidateHandle, candidateBuffer, 0, length, position);
      for (let offset = 0; offset < length; offset += bytesPerFrame) {
        for (let channel = 0; channel < target.audioChannels; channel += 1) {
          const sampleOffset = offset + channel * 2;
          const projected =
            scale[channel] * referenceBuffer.readInt16LE(sampleOffset);
          const residual =
            candidateBuffer.readInt16LE(sampleOffset) - projected;
          signalEnergy[channel] += projected * projected;
          errorEnergy[channel] += residual * residual;
        }
      }
    }
    return signalEnergy.map((signal, channel) =>
      errorEnergy[channel] === 0
        ? Number.POSITIVE_INFINITY
        : 10 * Math.log10(signal / errorEnergy[channel]),
    );
  } finally {
    fs.closeSync(referenceHandle);
    fs.closeSync(candidateHandle);
  }
};

const validateFullAudioSimilarity = () => {
  if (!fs.existsSync(audioReferencePath)) {
    record(
      "full-file decoded audio SI-SDR",
      false,
      `${path.relative(repoRoot, audioReferencePath)} does not exist`,
    );
    return;
  }
  fs.mkdirSync(artifactsDirectory, { recursive: true });
  const temporaryDirectory = fs.mkdtempSync(
    path.join(artifactsDirectory, ".video-validate-audio-"),
  );
  try {
    const referenceRaw = path.join(temporaryDirectory, "reference.s16le");
    const candidateRaw = path.join(temporaryDirectory, "candidate.s16le");
    const referenceDecode = decodeFullAudio(audioReferencePath, referenceRaw);
    const candidateDecode = decodeFullAudio(outputPath, candidateRaw);
    if (
      referenceDecode.error ||
      referenceDecode.status !== 0 ||
      candidateDecode.error ||
      candidateDecode.status !== 0
    ) {
      const detail =
        referenceDecode.error?.message ??
        candidateDecode.error?.message ??
        candidateDecode.stderr?.trim() ??
        referenceDecode.stderr?.trim() ??
        "full audio decode failed";
      record("full-file decoded audio SI-SDR", false, detail.slice(-1_000));
      return;
    }
    const expectedBytes =
      target.durationSeconds *
      target.audioSampleRate *
      target.audioChannels *
      2;
    const referenceBytes = fs.statSync(referenceRaw).size;
    const candidateBytes = fs.statSync(candidateRaw).size;
    if (referenceBytes !== expectedBytes || candidateBytes !== expectedBytes) {
      record(
        "full-file decoded audio SI-SDR",
        false,
        `decoded ${referenceBytes} reference and ${candidateBytes} candidate bytes; expected ${expectedBytes}`,
      );
      return;
    }
    const channelSiSdr = calculateChannelSiSdr(referenceRaw, candidateRaw);
    const minimumSiSdr = Math.min(...channelSiSdr);
    record(
      "full-file decoded audio SI-SDR",
      minimumSiSdr >= target.minimumFullFileSiSdr,
      `${channelSiSdr
        .map(
          (value, index) =>
            `ch${index + 1}=${Number.isFinite(value) ? value.toFixed(2) : "∞"}dB`,
        )
        .join(
          ", ",
        )} (minimum ${target.minimumFullFileSiSdr}dB; reference ${path.relative(repoRoot, audioReferencePath)})`,
    );
  } catch (error) {
    record(
      "full-file decoded audio SI-SDR",
      false,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    fs.rmSync(temporaryDirectory, { force: true, recursive: true });
  }
};

const validateDecodedMedia = () => {
  const decode = command(ffmpegBinary, [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-xerror",
    "-err_detect",
    "explode",
    "-i",
    outputPath,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
    "-f",
    "null",
    "-",
  ]);
  record(
    "full A/V decode",
    !decode.error && decode.status === 0,
    decode.error
      ? decode.error.message
      : decode.status === 0
        ? "all video and audio decoded without error"
        : (decode.stderr || decode.stdout || `exit ${decode.status}`)
            .trim()
            .slice(-1_000),
  );

  const counted = command(ffprobeBinary, [
    "-v",
    "error",
    "-count_frames",
    "-select_streams",
    "v:0",
    "-show_entries",
    "stream=nb_read_frames",
    "-of",
    "json",
    outputPath,
  ]);
  let decodedFrames = null;
  if (!counted.error && counted.status === 0) {
    try {
      const parsed = JSON.parse(counted.stdout);
      decodedFrames = parseNumber(parsed.streams?.[0]?.nb_read_frames);
    } catch {
      decodedFrames = null;
    }
  }
  record(
    "10800 decoded frames",
    decodedFrames === target.frames,
    decodedFrames === null
      ? (counted.stderr || "frame count unavailable").trim().slice(-1_000)
      : `${decodedFrames} frames read from the encoded stream`,
  );

  const countedAudio = command(ffprobeBinary, [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_frames",
    "-show_entries",
    "frame=nb_samples",
    "-of",
    "csv=p=0",
    outputPath,
  ]);
  let decodedAudioSamples = null;
  if (!countedAudio.error && countedAudio.status === 0) {
    const sampleCounts = countedAudio.stdout.trim().split(/\s+/).map(Number);
    if (
      sampleCounts.length > 0 &&
      sampleCounts.every((value) => Number.isInteger(value) && value > 0)
    ) {
      decodedAudioSamples = sampleCounts.reduce(
        (total, value) => total + value,
        0,
      );
    }
  }
  const expectedAudioSamples = target.durationSeconds * target.audioSampleRate;
  record(
    "exact decoded audio duration",
    decodedAudioSamples === expectedAudioSamples,
    decodedAudioSamples === null
      ? (countedAudio.stderr || "audio sample count unavailable")
          .trim()
          .slice(-1_000)
      : `${decodedAudioSamples} samples (expected ${expectedAudioSamples})`,
  );

  const cadenceProbe = command(ffprobeBinary, [
    "-v",
    "error",
    "-select_streams",
    "v:0",
    "-show_frames",
    "-show_entries",
    "frame=best_effort_timestamp_time,duration_time",
    "-of",
    "json",
    outputPath,
  ]);
  let cadenceEvidence = "frame timestamp probe unavailable";
  let cadencePassed = false;
  if (!cadenceProbe.error && cadenceProbe.status === 0) {
    try {
      const parsed = JSON.parse(cadenceProbe.stdout);
      const frames = Array.isArray(parsed.frames) ? parsed.frames : [];
      const timestamps = frames.map((frame) =>
        parseNumber(frame.best_effort_timestamp_time),
      );
      const durations = frames.map((frame) => parseNumber(frame.duration_time));
      const expectedInterval = 1 / target.fps;
      const intervalErrors = timestamps
        .slice(1)
        .map((timestamp, index) =>
          timestamp === null || timestamps[index] === null
            ? Number.POSITIVE_INFINITY
            : Math.abs(timestamp - timestamps[index] - expectedInterval),
        );
      const durationErrors = durations.map((duration) =>
        duration === null
          ? Number.POSITIVE_INFINITY
          : Math.abs(duration - expectedInterval),
      );
      const maximumIntervalError = Math.max(0, ...intervalErrors);
      const maximumDurationError = Math.max(0, ...durationErrors);
      cadencePassed =
        frames.length === target.frames &&
        maximumIntervalError <= target.maximumFrameIntervalErrorSeconds &&
        maximumDurationError <= target.maximumFrameIntervalErrorSeconds;
      cadenceEvidence = `${frames.length} timestamped frames, max interval error ${formatNumber(maximumIntervalError, 7)}s, max packet-duration error ${formatNumber(maximumDurationError, 7)}s`;
    } catch (error) {
      cadenceEvidence = `invalid frame timestamp JSON: ${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  } else {
    cadenceEvidence = cadenceProbe.error?.message ?? cadenceProbe.stderr.trim();
  }
  record("constant decoded frame cadence", cadencePassed, cadenceEvidence);
};

const validateAudioMastering = () => {
  const result = command(ffmpegBinary, [
    "-hide_banner",
    "-nostdin",
    "-i",
    outputPath,
    "-filter_complex",
    "ebur128=peak=true",
    "-f",
    "null",
    "-",
  ]);
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const loudnessValues = [...output.matchAll(/I:\s*(-?[0-9.]+)\s*LUFS/g)].map(
    (match) => Number(match[1]),
  );
  const peakValues = [...output.matchAll(/Peak:\s*(-?[0-9.]+)\s*dBFS/g)].map(
    (match) => Number(match[1]),
  );
  const integratedLoudness = loudnessValues.at(-1) ?? null;
  const truePeak = peakValues.at(-1) ?? null;
  record(
    "delivery music loudness",
    !result.error &&
      result.status === 0 &&
      integratedLoudness !== null &&
      integratedLoudness >= target.integratedLoudnessMin &&
      integratedLoudness <= target.integratedLoudnessMax,
    `${formatNumber(integratedLoudness, 1)} LUFS (accepted ${target.integratedLoudnessMin} to ${target.integratedLoudnessMax})`,
  );
  record(
    "safe encoded true peak",
    !result.error &&
      result.status === 0 &&
      truePeak !== null &&
      truePeak <= target.maximumTruePeak,
    `${formatNumber(truePeak, 1)} dBFS (maximum ${target.maximumTruePeak})`,
  );
};

const parseDurations = (text, expression) => {
  const durations = [];
  for (const match of text.matchAll(expression)) {
    const duration = Number(match[1]);
    if (Number.isFinite(duration)) durations.push(duration);
  }
  return durations;
};

const runDiagnostic = (name, args, patterns, maximumDuration) => {
  const result = command(ffmpegBinary, args);
  if (result.error) {
    diagnostics.push({
      name,
      status: "unavailable",
      detail: result.error.message,
    });
    record(`${name} diagnostic`, false, result.error.message);
    return;
  }
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.status !== 0) {
    diagnostics.push({
      name,
      status: "unavailable",
      detail: (result.stderr || result.stdout || `exit ${result.status}`)
        .trim()
        .slice(-1_000),
    });
    record(
      `${name} diagnostic`,
      false,
      (result.stderr || result.stdout || `exit ${result.status}`)
        .trim()
        .slice(-1_000),
    );
    return;
  }
  const durations = patterns.flatMap((pattern) =>
    parseDurations(output, pattern),
  );
  diagnostics.push({
    name,
    status: "observed",
    count: durations.length,
    maxDuration: durations.length > 0 ? Math.max(...durations) : 0,
  });
  record(
    `${name} duration threshold`,
    durations.every((duration) => duration <= maximumDuration),
    `${durations.length} event(s), max ${formatNumber(durations.length > 0 ? Math.max(...durations) : 0)}s (limit ${maximumDuration}s)`,
  );
};

const runFreezeDiagnostic = (args, maximumDuration, mediaDuration) => {
  const name = "freeze";
  const result = command(ffmpegBinary, args);
  if (result.error || result.status !== 0) {
    const detail =
      result.error?.message ??
      (result.stderr || result.stdout || `exit ${result.status}`)
        .trim()
        .slice(-1_000);
    diagnostics.push({ name, status: "unavailable", detail });
    record(`${name} diagnostic`, false, detail);
    return;
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const durations = [];
  let activeStart = null;
  let trailingFreeze = false;
  for (const match of output.matchAll(/freeze_(start|end):\s*([0-9.]+)/g)) {
    const value = Number(match[2]);
    if (!Number.isFinite(value)) continue;
    if (match[1] === "start") {
      // A new start without an end is malformed detector output. Close it at
      // the new start so it cannot disappear from the hard threshold.
      if (activeStart !== null && value >= activeStart) {
        durations.push(value - activeStart);
      }
      activeStart = value;
    } else if (activeStart !== null && value >= activeStart) {
      durations.push(value - activeStart);
      activeStart = null;
    }
  }
  if (activeStart !== null) {
    if (mediaDuration === null || mediaDuration < activeStart) {
      diagnostics.push({
        name,
        status: "unavailable",
        detail: `unmatched freeze_start at ${activeStart}s and media duration unavailable`,
      });
      record(
        `${name} diagnostic`,
        false,
        `unmatched freeze_start at ${activeStart}s and media duration unavailable`,
      );
      return;
    }
    durations.push(mediaDuration - activeStart);
    trailingFreeze = true;
  }
  // Older ffmpeg builds may omit start/end metadata while still reporting
  // durations. Preserve that diagnostic signal as a fallback.
  if (durations.length === 0) {
    durations.push(...parseDurations(output, /freeze_duration:\s*([0-9.]+)/g));
  }
  const maximumObserved = durations.length > 0 ? Math.max(...durations) : 0;
  diagnostics.push({
    name,
    status: "observed",
    count: durations.length,
    maxDuration: maximumObserved,
    trailingFreeze,
  });
  record(
    `${name} duration threshold`,
    durations.every((duration) => duration <= maximumDuration),
    `${durations.length} event(s), max ${formatNumber(maximumObserved)}s (limit ${maximumDuration}s${trailingFreeze ? "; unmatched start closed at media end" : ""})`,
  );
};

const runDiagnostics = (probe) => {
  const common = [
    "-hide_banner",
    "-nostdin",
    "-loglevel",
    "info",
    "-i",
    outputPath,
  ];
  runDiagnostic(
    "black",
    [...common, "-vf", "blackdetect=d=2:pix_th=0.08", "-an", "-f", "null", "-"],
    [/black_duration:\s*([0-9.]+)/g],
    target.maximumBlackSeconds,
  );
  const mediaDuration =
    parseNumber(probe?.format?.duration) ??
    parseNumber(
      probe?.streams?.find((stream) => stream.codec_type === "video")?.duration,
    );
  runFreezeDiagnostic(
    [...common, "-vf", "freezedetect=n=-60dB:d=2", "-an", "-f", "null", "-"],
    target.maximumFreezeSeconds,
    mediaDuration,
  );
  runDiagnostic(
    "silence",
    [...common, "-vn", "-af", "silencedetect=n=-45dB:d=2", "-f", "null", "-"],
    [/silence_duration:\s*([0-9.]+)/g],
    target.maximumSilenceSeconds,
  );
};

const printSummary = () => {
  console.log(`\n[video:validate] ${path.relative(repoRoot, outputPath)}`);
  for (const check of checks) {
    console.log(
      `  ${check.passed ? "PASS" : "FAIL"} ${check.label}: ${check.evidence}`,
    );
  }
  console.log(
    "\n[video:validate] Conservative ffmpeg diagnostics (hard duration thresholds):",
  );
  for (const diagnostic of diagnostics) {
    if (diagnostic.status === "observed") {
      const max =
        diagnostic.maxDuration > 0
          ? `, max ${formatNumber(diagnostic.maxDuration)}s`
          : "";
      console.log(
        `  INFO ${diagnostic.name}: ${diagnostic.count} event(s)${max}`,
      );
    } else {
      console.log(
        `  INFO ${diagnostic.name}: ${diagnostic.status}${diagnostic.detail ? ` (${diagnostic.detail})` : ""}`,
      );
    }
  }

  const failures = checks.filter((check) => !check.passed);
  if (failures.length > 0) {
    console.error(
      `\n[video:validate] FAILED: ${failures.length} hard invariant(s) did not pass.`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      "\n[video:validate] PASS: launch render meets the media invariants.",
    );
  }
};

const main = () => {
  audioReferencePath = resolveAudioReferencePath();
  const probe = readProbe();
  validateStreams(probe);
  const basicMediaPassed = probe && checks.every((check) => check.passed);
  if (basicMediaPassed) {
    validatePinnedAudioStream();
    validateDecodedMedia();
    validateAudioSync();
    validateFullAudioSimilarity();
    validateAudioMastering();
    runDiagnostics(probe);
  } else
    diagnostics.push({
      name: "ffmpeg diagnostics",
      status: "skipped",
      detail: "hard media invariant failed",
    });
  validateDescriptionSidecar();
  printSummary();
};

try {
  main();
} catch (error) {
  console.error(
    error instanceof Error
      ? `[video:validate] ${error.message}`
      : `[video:validate] ${String(error)}`,
  );
  process.exitCode = 1;
}
