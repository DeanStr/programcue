#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "../..");
const artifactsDirectory = path.join(repoRoot, ".artifacts", "video-releases");
const releaseManifestPath = path.join(
  repoRoot,
  "site",
  "public",
  "product-film-release.json",
);
const selectedScorePath = path.join(
  repoRoot,
  "video",
  "public",
  "video",
  "program-cue-score.wav",
);
const provenancePath = path.join(
  artifactsDirectory,
  "released-eleven-audio.json",
);
const ffmpegBinary = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
const ffprobeBinary = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";
const sampleRate = 48_000;
const durationSeconds = 360;
const expectedSamples = sampleRate * durationSeconds;

const fail = (message) => {
  throw new Error(`[video:score] ${message}`);
};

const readJson = (filePath, label) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(
      `${label} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const sha256File = (filePath) => {
  const hash = createHash("sha256");
  const handle = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead = fs.readSync(handle, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(handle);
  }
  return hash.digest("hex");
};

const run = (binary, args, label, maxBuffer = 32 * 1024 * 1024) => {
  const result = spawnSync(binary, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer,
  });
  if (result.error) fail(`${label} could not start: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`
      .trim()
      .slice(-4_000);
    fail(`${label} failed: ${detail || `exit ${result.status}`}`);
  }
  return result.stdout ?? "";
};

const probe = (filePath, label) => {
  const output = run(
    ffprobeBinary,
    ["-v", "error", "-show_streams", "-show_format", "-of", "json", filePath],
    label,
  );
  try {
    return JSON.parse(output);
  } catch (error) {
    fail(
      `${label} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const streamHash = (filePath, mode) => {
  const args = [
    "-v",
    "error",
    "-i",
    filePath,
    "-map",
    "0:a:0",
    ...(mode === "encoded"
      ? ["-c:a", "copy"]
      : ["-ac", "2", "-ar", String(sampleRate)]),
    "-f",
    "hash",
    "-hash",
    "sha256",
    "-",
  ];
  const match = run(ffmpegBinary, args, `${mode} audio hash`)
    .trim()
    .match(/^SHA256=([a-f0-9]{64})$/u);
  if (!match) fail(`${mode} audio hash returned an invalid digest.`);
  return match[1];
};

const decodedSampleCount = (filePath, label) => {
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
    label,
  );
  const samples = output.trim().split(/\s+/u).filter(Boolean).map(Number);
  if (
    samples.length === 0 ||
    samples.some((value) => !Number.isInteger(value) || value <= 0)
  ) {
    fail(`${label} returned invalid audio sample counts.`);
  }
  return samples.reduce((total, value) => total + value, 0);
};

const readRelease = () => {
  const release = readJson(
    releaseManifestPath,
    "Product-film release manifest",
  );
  for (const field of [
    "videoUrl",
    "masterSha256Prefix",
    "masterSha256",
    "audioStreamSha256",
    "decodedAudioSha256",
  ]) {
    if (typeof release[field] !== "string" || release[field].length === 0) {
      fail(`Product-film release manifest requires ${field}.`);
    }
  }
  if (
    release.schemaVersion !== 1 ||
    release.audioSource !== "eleven_music_v2" ||
    !/^https:\/\/media\.programcue\.com\/films\/[a-z0-9-]+\.mp4$/u.test(
      release.videoUrl,
    ) ||
    !/^[a-f0-9]{64}$/u.test(release.masterSha256) ||
    !release.masterSha256.startsWith(release.masterSha256Prefix) ||
    !/^[a-f0-9]{64}$/u.test(release.audioStreamSha256) ||
    !/^[a-f0-9]{64}$/u.test(release.decodedAudioSha256)
  ) {
    fail(
      "Product-film release manifest does not select a pinned Eleven master.",
    );
  }
  return release;
};

const cachePathFor = (release) => {
  const fileName = path.basename(new URL(release.videoUrl).pathname);
  if (!fileName.endsWith(`-${release.masterSha256Prefix}.mp4`)) {
    fail("Released master filename does not contain its hash prefix.");
  }
  return path.join(artifactsDirectory, fileName);
};

export const downloadReleasedMaster = async (
  release,
  cachePath,
  offline,
  timeoutMs = 5 * 60 * 1_000,
) => {
  if (fs.existsSync(cachePath)) return;
  if (offline) {
    fail(
      `Released master is not cached at ${path.relative(repoRoot, cachePath)}; rerun without --offline.`,
    );
  }

  const temporaryPath = `${cachePath}.${process.pid}.${randomUUID()}.tmp`;
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const response = await fetch(release.videoUrl, {
      redirect: "follow",
      signal,
    });
    if (!response.ok || !response.body) {
      fail(`Released master download returned HTTP ${response.status}.`);
    }
    await pipeline(
      Readable.fromWeb(response.body),
      fs.createWriteStream(temporaryPath, { flags: "wx", mode: 0o600 }),
      { signal },
    );
    const actualSha256 = sha256File(temporaryPath);
    if (actualSha256 !== release.masterSha256) {
      fail(
        `Released master hash mismatch: expected ${release.masterSha256}, received ${actualSha256}.`,
      );
    }
    fs.renameSync(temporaryPath, cachePath);
  } catch (error) {
    const detail = signal.aborted
      ? `timed out after ${timeoutMs / 1_000} seconds`
      : error instanceof Error
        ? `${error.message}${error.cause instanceof Error ? ` (${error.cause.message})` : ""}`
        : String(error);
    fail(
      `Could not download released master from ${release.videoUrl}: ${detail}. No cache was installed. Check access to the release URL and retry.`,
    );
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
};

const validateReleasedMaster = (release, cachePath) => {
  const actualSha256 = sha256File(cachePath);
  if (actualSha256 !== release.masterSha256) {
    fail(
      `Cached released master hash mismatch: expected ${release.masterSha256}, received ${actualSha256}.`,
    );
  }
  const media = probe(cachePath, "Released master probe");
  const videoStreams = (media.streams ?? []).filter(
    (stream) => stream.codec_type === "video",
  );
  const audioStreams = (media.streams ?? []).filter(
    (stream) => stream.codec_type === "audio",
  );
  const video = videoStreams[0];
  const audio = audioStreams[0];
  if (
    videoStreams.length !== 1 ||
    audioStreams.length !== 1 ||
    video?.codec_name !== "h264" ||
    video.width !== 1920 ||
    video.height !== 1080 ||
    video.nb_frames !== "10800" ||
    audio?.codec_name !== "aac" ||
    Number(audio.sample_rate) !== sampleRate ||
    audio.channels !== 2 ||
    Number(audio.duration) !== durationSeconds ||
    Number(media.format?.duration) !== durationSeconds
  ) {
    fail("Released master is not the exact 1080p30, 360-second A/V source.");
  }
  const audioStreamSha256 = streamHash(cachePath, "encoded");
  const decodedAudioSha256 = streamHash(cachePath, "decoded");
  const samples = decodedSampleCount(cachePath, "Released audio sample count");
  if (
    audioStreamSha256 !== release.audioStreamSha256 ||
    decodedAudioSha256 !== release.decodedAudioSha256 ||
    samples !== expectedSamples
  ) {
    fail(
      "Released Eleven soundtrack does not match its pinned audio contract.",
    );
  }
  run(
    ffmpegBinary,
    [
      "-hide_banner",
      "-nostdin",
      "-v",
      "error",
      "-xerror",
      "-i",
      cachePath,
      "-map",
      "0:a:0",
      "-f",
      "null",
      "-",
    ],
    "Released audio full decode",
  );
  return { audioStreamSha256, decodedAudioSha256, samples };
};

const writeSelectedScore = (cachePath, release) => {
  fs.mkdirSync(path.dirname(selectedScorePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(selectedScorePath),
    `.${path.basename(selectedScorePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  try {
    run(
      ffmpegBinary,
      [
        "-hide_banner",
        "-nostdin",
        "-v",
        "error",
        "-y",
        "-i",
        cachePath,
        "-map",
        "0:a:0",
        "-c:a",
        "pcm_s16le",
        "-ar",
        String(sampleRate),
        "-ac",
        "2",
        "-t",
        String(durationSeconds),
        "-f",
        "wav",
        temporaryPath,
      ],
      "Released soundtrack PCM preparation",
    );
    const decodedAudioSha256 = streamHash(temporaryPath, "decoded");
    const samples = decodedSampleCount(
      temporaryPath,
      "Prepared score sample count",
    );
    if (
      decodedAudioSha256 !== release.decodedAudioSha256 ||
      samples !== expectedSamples
    ) {
      fail("Prepared score differs from the released Eleven soundtrack.");
    }
    fs.renameSync(temporaryPath, selectedScorePath);
  } finally {
    fs.rmSync(temporaryPath, { force: true });
  }
};

const main = async () => {
  const arguments_ = process.argv.slice(2);
  if (arguments_.some((argument) => argument !== "--offline")) {
    fail(
      "Usage: node video/scripts/prepare-released-eleven-audio.mjs [--offline]",
    );
  }
  const release = readRelease();
  const cachePath = cachePathFor(release);
  fs.mkdirSync(artifactsDirectory, { recursive: true });
  await downloadReleasedMaster(
    release,
    cachePath,
    arguments_.includes("--offline"),
  );
  const source = validateReleasedMaster(release, cachePath);
  writeSelectedScore(cachePath, release);

  const provenance = {
    schemaVersion: 1,
    selection: "released_eleven_music_v2",
    providerRequestMade: false,
    releasedMaster: {
      url: release.videoUrl,
      path: path.relative(repoRoot, cachePath),
      sha256: release.masterSha256,
    },
    audio: {
      encodedStreamSha256: source.audioStreamSha256,
      decodedSha256: source.decodedAudioSha256,
      sampleRate,
      channels: 2,
      durationSeconds,
      decodedSamples: source.samples,
    },
    selectedScore: {
      path: path.relative(repoRoot, selectedScorePath),
      sha256: sha256File(selectedScorePath),
    },
  };
  fs.writeFileSync(provenancePath, `${JSON.stringify(provenance, null, 2)}\n`, {
    mode: 0o600,
  });
  console.log(
    `Prepared released Eleven Music soundtrack: ${path.relative(repoRoot, selectedScorePath)}`,
  );
  console.log(
    `Verified ${source.samples} decoded samples from ${path.relative(repoRoot, cachePath)}. No ElevenLabs provider request was sent.`,
  );
};

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
