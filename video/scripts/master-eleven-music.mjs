#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "../..");
const ffmpegBinary = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
const ffprobeBinary = process.platform === "win32" ? "ffprobe.exe" : "ffprobe";

const recipeVersion = "program-cue-eleven-master-v1";
const sampleRate = 48_000;
const durationSeconds = 360;
const targetSamples = sampleRate * durationSeconds;
const expectedMp3ExcessSamples = 1_152;
const maximumDescriptionCharactersPerSecond = 17;
const descriptionTimingToleranceSeconds = 0.001;
const descriptionSource = path.join(
  repoRoot,
  "video",
  "delivery",
  "program-cue-launch-descriptions.vtt",
);
const expectedCandidate = {
  manifestSha256:
    "4d4aaf16a13dcfbfa715353f007517f28708908de56ba1dab883850532d63cde",
  audioSha256:
    "8bee1117aa8e23154283d6fd5da8abd9e2efbe43953fe0ec106d1819c8eb1ef0",
  modelId: "music_v2",
  songId: "b56vWdcmAcpFjndNZSlJ",
  outputFormat: "mp3_48000_192",
  planPath: "video/eleven-music-plan.json",
  planSha256:
    "07aaa6db15ca41e6fdd87b501b0ddfce86af0c229360e9f8797774314e28cc7b",
};

const defaults = {
  candidateManifest: path.join(
    repoRoot,
    ".artifacts",
    "video-music",
    "program-cue-eleven-music-candidate.json",
  ),
  picture: path.join(repoRoot, ".artifacts", "program-cue-launch.mp4"),
  referenceWav: path.join(
    repoRoot,
    ".artifacts",
    "video-music",
    "program-cue-eleven-music-mastered.wav",
  ),
  outputVideo: path.join(
    repoRoot,
    ".artifacts",
    "program-cue-launch-elevenlabs.mp4",
  ),
  outputVtt: path.join(
    repoRoot,
    ".artifacts",
    "program-cue-launch-elevenlabs.vtt",
  ),
  outputManifest: path.join(
    repoRoot,
    ".artifacts",
    "video-music",
    "program-cue-eleven-music-mastered.json",
  ),
};

const baseContourAnchors = [
  [0, 0],
  [31, -1],
  [42, 0.4],
  [49, -0.4],
  [54, 0.8],
  [61, -0.3],
  [70, 0.7],
  [77, -0.8],
  [88, 0.6],
  [95, -0.2],
  [103, 1],
  [110, -0.5],
  [117, 0.7],
  [125, 1.6],
  [132, 0.4],
  [140, 1.5],
  [146, 2.2],
  [151, 0],
  [179, 0],
  [214, -0.8],
  [222, 0.5],
  [231, 1.2],
  [240, -0.7],
  [248, 0.5],
  [254, -0.4],
  [263, 0.8],
  [270, -0.2],
  [279, 1.5],
  [280, 0.4],
  [290, 1],
  [298, 1.7],
  [304, 0.8],
  [311, 1.6],
  [316, 2.2],
  [322, 0.2],
  [330, -0.7],
  [342, 0],
  [360, 0],
];

// Half-strength scene contours retain the two authored multi-wave builds.
// Publish is held 0.4 dB lower so the complete master stays within 6-8 LU LRA.
const contourAnchors = baseContourAnchors.map(([time, gain]) => [
  time,
  gain * 0.5 - (time >= 280 && time <= 316 ? 0.4 : 0),
]);

const toolEnvironment = Object.fromEntries(
  [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "WINDIR",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
  ]
    .filter((name) => process.env[name] !== undefined)
    .map((name) => [name, process.env[name]]),
);
toolEnvironment.LC_ALL = "C";

const fail = (message) => {
  throw new Error(message);
};

const run = (binary, args, label, maxBuffer = 64 * 1024 * 1024) => {
  const result = spawnSync(binary, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: toolEnvironment,
    maxBuffer,
  });
  if (result.error) {
    fail(`${label} could not start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = `${result.stderr ?? ""}\n${result.stdout ?? ""}`
      .trim()
      .slice(-4_000);
    fail(`${label} failed: ${detail || `exit ${result.status}`}`);
  }
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
};

const runJson = (binary, args, label) => {
  const result = run(binary, args, label);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    fail(
      `${label} returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

const readJson = (filePath, label) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail(
      `${label} could not be read: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
};

const sha256File = (filePath) => {
  const hash = createHash("sha256");
  const file = fs.openSync(filePath, "r");
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    while (true) {
      const bytesRead = fs.readSync(file, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(file);
  }
  return hash.digest("hex");
};

const portablePath = (filePath) => {
  const relative = path.relative(repoRoot, filePath);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative)
    ? relative
    : filePath;
};

const resolveCliPath = (value) => path.resolve(repoRoot, value);

const usage = `Usage: node video/scripts/master-eleven-music.mjs [options]

Options:
  --candidate-manifest <path>  Candidate metadata JSON
  --picture <path>             Existing 360-second picture master
  --wav-output <path>          Mastered PCM reference output
  --video-output <path>        ElevenLabs-scored MP4 output
  --vtt-output <path>          Sibling description-track output
  --manifest-output <path>     Derived provenance manifest output`;

const parseArguments = (args) => {
  const paths = { ...defaults };
  const options = new Map([
    ["--candidate-manifest", "candidateManifest"],
    ["--picture", "picture"],
    ["--wav-output", "referenceWav"],
    ["--video-output", "outputVideo"],
    ["--vtt-output", "outputVtt"],
    ["--manifest-output", "outputManifest"],
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help") {
      console.log(usage);
      return null;
    }
    const [name, inlineValue] = argument.split("=", 2);
    const destination = options.get(name);
    if (!destination) fail(`Unknown option "${argument}".\n${usage}`);
    const value = inlineValue ?? args[index + 1];
    if (!value || (!inlineValue && value.startsWith("--"))) {
      fail(`${name} requires a path.`);
    }
    if (inlineValue === undefined) index += 1;
    paths[destination] = resolveCliPath(value);
  }
  return paths;
};

const validatePaths = (paths) => {
  const outputs = [
    [paths.referenceWav, ".wav", "WAV output"],
    [paths.outputVideo, ".mp4", "video output"],
    [paths.outputVtt, ".vtt", "description-track output"],
    [paths.outputManifest, ".json", "derived manifest output"],
  ];
  const uniqueOutputs = new Set(outputs.map(([filePath]) => filePath));
  if (uniqueOutputs.size !== outputs.length) {
    fail("Output paths must be distinct.");
  }
  for (const [filePath, extension, label] of outputs) {
    if (path.extname(filePath).toLowerCase() !== extension) {
      fail(`${label} must use a ${extension} extension.`);
    }
    if (filePath === path.parse(filePath).root || filePath === repoRoot) {
      fail(`${label} cannot target a filesystem or repository root.`);
    }
  }
  if (path.extname(paths.candidateManifest).toLowerCase() !== ".json") {
    fail("Candidate manifest must be JSON.");
  }
  if (path.extname(paths.picture).toLowerCase() !== ".mp4") {
    fail("Picture input must be an MP4.");
  }
  if (!fs.existsSync(paths.candidateManifest)) {
    fail(`Candidate manifest does not exist: ${paths.candidateManifest}`);
  }
  if (!fs.existsSync(paths.picture)) {
    fail(`Picture master does not exist: ${paths.picture}`);
  }
  if (!fs.existsSync(descriptionSource)) {
    fail(`Tracked description source does not exist: ${descriptionSource}`);
  }
  for (const [filePath, , label] of outputs) {
    if (filePath === paths.candidateManifest || filePath === paths.picture) {
      fail(`${label} cannot overwrite an input.`);
    }
  }
};

const canonicalPath = (filePath) => {
  const resolved = fs.existsSync(filePath)
    ? fs.realpathSync.native(filePath)
    : path.join(
        fs.realpathSync.native(path.dirname(filePath)),
        path.basename(filePath),
      );
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

const validateCanonicalIdentities = (paths, candidateAudioPath) => {
  for (const outputPath of [
    paths.referenceWav,
    paths.outputVideo,
    paths.outputVtt,
    paths.outputManifest,
  ]) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  }
  const inputs = new Map(
    [
      [paths.candidateManifest, "candidate manifest"],
      [candidateAudioPath, "candidate MP3"],
      [paths.picture, "picture master"],
      [descriptionSource, "tracked description source"],
    ].map(([filePath, label]) => [canonicalPath(filePath), label]),
  );
  const outputIdentities = new Map();
  for (const [filePath, label] of [
    [paths.referenceWav, "WAV output"],
    [paths.outputVideo, "video output"],
    [paths.outputVtt, "description-track output"],
    [paths.outputManifest, "derived manifest output"],
  ]) {
    const identity = canonicalPath(filePath);
    const inputLabel = inputs.get(identity);
    if (inputLabel) {
      fail(
        `${label} resolves to the ${inputLabel}; inputs cannot be replaced.`,
      );
    }
    const otherOutput = outputIdentities.get(identity);
    if (otherOutput) {
      fail(`${label} resolves to the same file as ${otherOutput}.`);
    }
    outputIdentities.set(identity, label);
  }
};

const probe = (filePath, label) =>
  runJson(
    ffprobeBinary,
    ["-v", "error", "-show_streams", "-show_format", "-of", "json", filePath],
    label,
  );

const parseRate = (value) => {
  if (typeof value !== "string") return null;
  const [numerator, denominator] = value.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) return null;
  return denominator === 0 ? null : numerator / denominator;
};

const countDecodedSamples = (filePath, label) => {
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
  ).stdout;
  const samples = output
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map((line) => Number.parseInt(line, 10));
  if (
    samples.length < 1 ||
    samples.some((value) => !Number.isInteger(value) || value < 1)
  ) {
    fail(`${label} returned invalid frame sample counts.`);
  }
  return samples.reduce((total, value) => total + value, 0);
};

const firstPacket = (filePath, label) => {
  const result = runJson(
    ffprobeBinary,
    [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_packets",
      "-read_intervals",
      "%+#2",
      "-show_entries",
      "packet=pts,pts_time,duration,duration_time,side_data_list",
      "-of",
      "json",
      filePath,
    ],
    label,
  );
  return result.packets ?? [];
};

const fullDecode = (filePath, maps, label) => {
  const args = [
    "-hide_banner",
    "-nostdin",
    "-v",
    "error",
    "-xerror",
    "-err_detect",
    "explode",
    "-i",
    filePath,
  ];
  for (const stream of maps) args.push("-map", stream);
  args.push("-f", "null", "-");
  run(ffmpegBinary, args, label);
};

const parseDescriptionTimestamp = (value) => {
  const match = value.match(/^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/u);
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

const validateDescriptionTrack = (filePath, label) => {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    fail(`${label} is missing or is not a regular file.`);
  }
  const buffer = fs.readFileSync(filePath);
  if (buffer.length === 0) fail(`${label} is empty.`);
  const source = buffer
    .toString("utf8")
    .replace(/^\uFEFF/u, "")
    .replace(/\r\n?/gu, "\n")
    .trimEnd();
  if (!source.startsWith("WEBVTT\n")) {
    fail(`${label} must begin with a WEBVTT header.`);
  }

  const cues = [];
  for (const [blockIndex, block] of source
    .split(/\n{2,}/u)
    .slice(1)
    .entries()) {
    const lines = block.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0 || lines[0].startsWith("NOTE")) continue;
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    const timing =
      timingIndex >= 0 && timingIndex <= 1
        ? lines[timingIndex].match(
            /^(\d{2}:\d{2}:\d{2}\.\d{3}) --> (\d{2}:\d{2}:\d{2}\.\d{3})$/u,
          )
        : null;
    const start = timing ? parseDescriptionTimestamp(timing[1]) : null;
    const end = timing ? parseDescriptionTimestamp(timing[2]) : null;
    const text =
      timingIndex >= 0
        ? lines
            .slice(timingIndex + 1)
            .join(" ")
            .replace(/<[^>]*>/gu, "")
            .replace(/\s+/gu, " ")
            .trim()
        : "";
    if (start === null || end === null || end <= start || text.length === 0) {
      fail(`${label} cue ${blockIndex + 1} is malformed or empty.`);
    }
    cues.push({
      start,
      end,
      charactersPerSecond: [...text].length / (end - start),
    });
  }
  if (cues.length === 0) fail(`${label} contains no cues.`);
  if (Math.abs(cues[0].start) > descriptionTimingToleranceSeconds) {
    fail(`${label} starts at ${cues[0].start}s instead of zero.`);
  }
  for (let index = 1; index < cues.length; index += 1) {
    const gap = cues[index].start - cues[index - 1].end;
    if (Math.abs(gap) > descriptionTimingToleranceSeconds) {
      fail(
        `${label} cues ${index} and ${index + 1} have a ${gap.toFixed(3)}s gap or overlap.`,
      );
    }
  }
  const finalEnd = cues.at(-1).end;
  if (
    Math.abs(finalEnd - durationSeconds) > descriptionTimingToleranceSeconds
  ) {
    fail(`${label} ends at ${finalEnd}s instead of ${durationSeconds}s.`);
  }
  const maximumCps = Math.max(...cues.map((cue) => cue.charactersPerSecond));
  if (maximumCps > maximumDescriptionCharactersPerSecond + Number.EPSILON) {
    fail(
      `${label} reaches ${maximumCps.toFixed(1)} characters/s; maximum is ${maximumDescriptionCharactersPerSecond}.`,
    );
  }
  return {
    byteCount: buffer.length,
    cueCount: cues.length,
    durationSeconds: finalEnd,
    maximumCharactersPerSecond: maximumCps,
    sha256: createHash("sha256").update(buffer).digest("hex"),
  };
};

const validateCandidate = (manifestPath) => {
  const manifestSha256 = sha256File(manifestPath);
  if (manifestSha256 !== expectedCandidate.manifestSha256) {
    fail(
      `Candidate manifest hash mismatch: expected ${expectedCandidate.manifestSha256}, actual ${manifestSha256}.`,
    );
  }
  const metadata = readJson(manifestPath, "Candidate manifest");
  for (const field of ["audioPath", "audioSha256", "modelId", "songId"]) {
    if (typeof metadata[field] !== "string" || metadata[field].length < 1) {
      fail(`Candidate manifest requires a non-empty ${field}.`);
    }
  }
  if (!/^[a-f0-9]{64}$/u.test(metadata.audioSha256)) {
    fail("Candidate manifest audioSha256 is invalid.");
  }
  if (
    metadata.audioSha256 !== expectedCandidate.audioSha256 ||
    metadata.modelId !== expectedCandidate.modelId ||
    metadata.songId !== expectedCandidate.songId ||
    metadata.outputFormat !== expectedCandidate.outputFormat ||
    metadata.planPath !== expectedCandidate.planPath ||
    metadata.planSha256 !== expectedCandidate.planSha256 ||
    metadata.mountedInLaunchFilm !== false ||
    metadata.c2paRequested !== true ||
    metadata.storedForInpainting !== false ||
    metadata.codec !== "mp3" ||
    metadata.sampleRate !== sampleRate ||
    metadata.channels !== 2 ||
    metadata.durationSeconds !== 360.024 ||
    metadata.decodedDurationSeconds !== durationSeconds
  ) {
    fail("Candidate manifest does not match the pinned ElevenLabs provenance.");
  }
  const planPath = path.resolve(repoRoot, metadata.planPath);
  if (!fs.existsSync(planPath)) {
    fail(`Pinned composition plan does not exist: ${planPath}`);
  }
  const plan = readJson(planPath, "Pinned composition plan");
  const planSha256 = createHash("sha256")
    .update(JSON.stringify(plan))
    .digest("hex");
  if (
    planSha256 !== metadata.planSha256 ||
    planSha256 !== expectedCandidate.planSha256
  ) {
    fail(
      `Composition-plan hash mismatch: expected ${expectedCandidate.planSha256}, actual ${planSha256}.`,
    );
  }
  const audioPath = path.isAbsolute(metadata.audioPath)
    ? metadata.audioPath
    : path.resolve(repoRoot, metadata.audioPath);
  if (!fs.existsSync(audioPath)) {
    fail(`Candidate MP3 does not exist: ${audioPath}`);
  }
  if (path.extname(audioPath).toLowerCase() !== ".mp3") {
    fail("Candidate audio must be an MP3.");
  }
  if (!path.basename(audioPath).includes(metadata.audioSha256)) {
    fail("Candidate MP3 filename is not content-addressed by audioSha256.");
  }
  const audioSha256 = sha256File(audioPath);
  if (audioSha256 !== metadata.audioSha256) {
    fail(
      `Candidate hash mismatch: manifest=${metadata.audioSha256}, actual=${audioSha256}.`,
    );
  }
  if (
    Number.isInteger(metadata.byteCount) &&
    fs.statSync(audioPath).size !== metadata.byteCount
  ) {
    fail("Candidate byte count does not match its manifest.");
  }

  const media = probe(audioPath, "Candidate media probe");
  const audioStreams = (media.streams ?? []).filter(
    (stream) => stream.codec_type === "audio",
  );
  if (
    audioStreams.length !== 1 ||
    audioStreams[0].codec_name !== "mp3" ||
    Number(audioStreams[0].sample_rate) !== sampleRate ||
    audioStreams[0].channels !== 2
  ) {
    fail("Candidate must be one 48kHz stereo MP3 stream.");
  }
  fullDecode(audioPath, ["0:a:0"], "Candidate full decode");

  const packets = firstPacket(audioPath, "Candidate first-packet probe");
  const declaredHeadSkip = (packets[0]?.side_data_list ?? []).reduce(
    (total, sideData) => total + Number(sideData.skip_samples ?? 0),
    0,
  );
  if (declaredHeadSkip !== 0) {
    fail(
      `Candidate declares ${declaredHeadSkip} head skip samples; this recipe requires an unlabelled excess frame.`,
    );
  }

  const decodedSamples = countDecodedSamples(
    audioPath,
    "Candidate decoded-sample count",
  );
  const measuredExcessSamples = decodedSamples - targetSamples;
  if (measuredExcessSamples !== expectedMp3ExcessSamples) {
    fail(
      `Candidate decodes to ${decodedSamples} samples; measured excess is ${measuredExcessSamples}, expected exactly one ${expectedMp3ExcessSamples}-sample MP3 frame.`,
    );
  }
  return {
    audioPath,
    audioSha256,
    decodedSamples,
    manifestSha256,
    measuredExcessSamples,
    metadata,
    planPath,
    planSha256,
  };
};

const validatePicture = (picturePath) => {
  const media = probe(picturePath, "Picture-master probe");
  const videoStreams = (media.streams ?? []).filter(
    (stream) => stream.codec_type === "video",
  );
  const video = videoStreams[0];
  if (
    videoStreams.length !== 1 ||
    video?.codec_name !== "h264" ||
    video.width !== 1920 ||
    video.height !== 1080 ||
    video.pix_fmt !== "yuv420p" ||
    video.color_range !== "tv" ||
    video.color_space !== "bt709" ||
    video.color_transfer !== "bt709" ||
    video.color_primaries !== "bt709" ||
    parseRate(video.avg_frame_rate) !== 30 ||
    parseRate(video.r_frame_rate) !== 30 ||
    Number(video.nb_frames) !== 10_800 ||
    Math.abs(Number(video.start_time)) > 1 / sampleRate ||
    Math.abs(Number(video.duration) - durationSeconds) > 0.001
  ) {
    fail("Picture master is not the exact 1080p30, 360-second BT.709 lock.");
  }
  return {
    fileSha256: sha256File(picturePath),
    streamSha256: videoStreamSha256(picturePath, "Picture stream hash"),
  };
};

const videoStreamSha256 = (filePath, label) => {
  const output = run(
    ffmpegBinary,
    [
      "-v",
      "error",
      "-i",
      filePath,
      "-map",
      "0:v:0",
      "-c",
      "copy",
      "-f",
      "hash",
      "-hash",
      "sha256",
      "-",
    ],
    label,
  ).stdout.trim();
  const match = output.match(/^SHA256=([a-f0-9]{64})$/u);
  if (!match) fail(`${label} returned an invalid hash.`);
  return match[1];
};

const buildContourExpression = () => {
  let expression = String(contourAnchors.at(-1)[1]);
  for (let index = contourAnchors.length - 2; index >= 0; index -= 1) {
    const [startTime, startGain] = contourAnchors[index];
    const [endTime, endGain] = contourAnchors[index + 1];
    expression = `if(lt(t,${endTime}),${startGain}+((${endGain - startGain})/${endTime - startTime})*(t-${startTime}),${expression})`;
  }
  return `pow(10,(${expression})/20)`;
};

const buildMasteringFilter = (candidate) => {
  const sideGain =
    "if(lt(t,183.5),1,if(lt(t,183.75),1-(2.735088)*(t-183.5),if(lt(t,185.25),0.316228,if(lt(t,185.5),0.316228+(2.735088)*(t-185.25),1))))";
  const left = `0.5*(val(0)+val(1))+0.5*(${sideGain})*(val(0)-val(1))`;
  const right = `0.5*(val(0)+val(1))-0.5*(${sideGain})*(val(0)-val(1))`;
  return [
    `[0:a]atrim=start_sample=${candidate.measuredExcessSamples}:end_sample=${candidate.decodedSamples},`,
    "asetpts=N/SR/TB,",
    `volume='${buildContourExpression()}':eval=frame:precision=double,`,
    `aeval=exprs='${left}|${right}':c=stereo,`,
    "asplit=4[base][closing][logo][arrival]",
    ";[base]atrim=start=0:end=360,asetpts=PTS-STARTPTS[base360]",
    ";[closing]atrim=start=330:end=342,asetpts=PTS-STARTPTS,volume=-3dB,afade=t=in:st=0:d=1.5,afade=t=out:st=9.5:d=2.5,adelay=348000:all=1[tail]",
    ";[logo]atrim=start=323:end=325.7,asetpts=PTS-STARTPTS,volume=-10dB,afade=t=in:st=0:d=0.08,afade=t=out:st=2.5:d=0.2,adelay=357000:all=1[sting]",
    ";[arrival]atrim=start=316:end=322.1,asetpts=PTS-STARTPTS,volume=-6.7dB,afade=t=in:st=0:d=0.22,afade=t=out:st=5.75:d=0.35,adelay=342000:all=1[bed]",
    ";[base360][tail][sting][bed]amix=inputs=4:duration=longest:dropout_transition=0:normalize=0",
    ",atrim=start=0:end=360,asetpts=N/SR/TB,volume=-0.8dB",
    ",aresample=192000,alimiter=limit=0.7943282347:attack=5:release=100:level=false:latency=true",
    `,aresample=${sampleRate},atrim=end_sample=${targetSamples},asetpts=N/SR/TB[out]`,
  ].join("");
};

const temporaryPath = (filePath) => {
  const extension = path.extname(filePath);
  const stem = path.basename(filePath, extension);
  return path.join(
    path.dirname(filePath),
    `.${stem}.${process.pid}.${Date.now()}.tmp${extension}`,
  );
};

const fsyncFile = (filePath) => {
  const file = fs.openSync(filePath, "r");
  try {
    fs.fsyncSync(file);
  } finally {
    fs.closeSync(file);
  }
};

const measureEbur128 = (filePath, start, duration, label) => {
  const args = ["-hide_banner", "-nostdin"];
  if (start !== 0) args.push("-ss", String(start));
  if (duration !== durationSeconds) args.push("-t", String(duration));
  args.push(
    "-i",
    filePath,
    "-map",
    "0:a:0",
    "-af",
    "ebur128=peak=true",
    "-f",
    "null",
    "-",
  );
  const result = run(ffmpegBinary, args, label);
  const output = `${result.stdout}\n${result.stderr}`;
  const readLast = (expression) => {
    const matches = [...output.matchAll(expression)].map((match) =>
      Number(match[1]),
    );
    return matches.at(-1);
  };
  const metrics = {
    integratedLufs: readLast(/I:\s*(-?[0-9.]+)\s*LUFS/gu),
    loudnessRangeLu: readLast(/LRA:\s*([0-9.]+)\s*LU/gu),
    truePeakDbfs: readLast(/Peak:\s*(-?[0-9.]+)\s*dBFS/gu),
  };
  if (Object.values(metrics).some((value) => !Number.isFinite(value))) {
    fail(`${label} did not report complete EBU R128 metrics.`);
  }
  return metrics;
};

const measureVolume = (filePath, start, duration, label) => {
  const result = run(
    ffmpegBinary,
    [
      "-hide_banner",
      "-nostdin",
      "-ss",
      String(start),
      "-t",
      String(duration),
      "-i",
      filePath,
      "-map",
      "0:a:0",
      "-af",
      "volumedetect",
      "-f",
      "null",
      "-",
    ],
    label,
  );
  const output = `${result.stdout}\n${result.stderr}`;
  const mean = output.match(/mean_volume:\s*(-?[0-9.]+)\s*dB/u);
  const peak = output.match(/max_volume:\s*(-?[0-9.]+)\s*dB/u);
  if (!mean || !peak) fail(`${label} did not report volume metrics.`);
  return { meanDbfs: Number(mean[1]), peakDbfs: Number(peak[1]) };
};

const closingSilences = (filePath, label) => {
  const result = run(
    ffmpegBinary,
    [
      "-hide_banner",
      "-nostdin",
      "-ss",
      "342",
      "-t",
      "18",
      "-i",
      filePath,
      "-map",
      "0:a:0",
      "-af",
      "silencedetect=noise=-40dB:d=1",
      "-f",
      "null",
      "-",
    ],
    label,
  );
  const output = `${result.stdout}\n${result.stderr}`;
  return [...output.matchAll(/silence_duration:\s*([0-9.]+)/gu)].map((match) =>
    Number(match[1]),
  );
};

const validateMasteringMetrics = (metrics, label, truePeakLimit) => {
  if (
    metrics.integratedLufs < -16.5 ||
    metrics.integratedLufs > -15.5 ||
    metrics.loudnessRangeLu < 6 ||
    metrics.loudnessRangeLu > 8 ||
    metrics.truePeakDbfs > truePeakLimit
  ) {
    fail(
      `${label} missed mastering gates: ${metrics.integratedLufs} LUFS, ${metrics.loudnessRangeLu} LU LRA, ${metrics.truePeakDbfs} dBTP.`,
    );
  }
};

const validateReference = (filePath) => {
  const media = probe(filePath, "Reference WAV probe");
  const streams = (media.streams ?? []).filter(
    (stream) => stream.codec_type === "audio",
  );
  const audio = streams[0];
  if (
    streams.length !== 1 ||
    audio?.codec_name !== "pcm_s24le" ||
    Number(audio.sample_rate) !== sampleRate ||
    audio.channels !== 2 ||
    Math.abs(Number(audio.duration) - durationSeconds) > 0.000_001
  ) {
    fail("Reference WAV is not exact 360-second PCM24 48kHz stereo.");
  }
  const decodedSamples = countDecodedSamples(
    filePath,
    "Reference decoded-sample count",
  );
  if (decodedSamples !== targetSamples) {
    fail(`Reference WAV decoded to ${decodedSamples}, not ${targetSamples}.`);
  }
  fullDecode(filePath, ["0:a:0"], "Reference WAV full decode");
  const mastering = measureEbur128(
    filePath,
    0,
    durationSeconds,
    "Reference mastering analysis",
  );
  validateMasteringMetrics(mastering, "Reference WAV", -2);
  return { decodedSamples, mastering };
};

const validateOutputVideo = (filePath, pictureStreamSha256) => {
  const media = probe(filePath, "Output MP4 probe");
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
    video.pix_fmt !== "yuv420p" ||
    video.color_range !== "tv" ||
    video.color_space !== "bt709" ||
    video.color_transfer !== "bt709" ||
    video.color_primaries !== "bt709" ||
    parseRate(video.avg_frame_rate) !== 30 ||
    parseRate(video.r_frame_rate) !== 30 ||
    Number(video.nb_frames) !== 10_800 ||
    audio?.codec_name !== "aac" ||
    Number(audio.sample_rate) !== sampleRate ||
    audio.channels !== 2 ||
    Number(audio.bit_rate) < 256_000 ||
    Math.abs(Number(video.start_time)) > 1 / sampleRate ||
    Math.abs(Number(audio.start_time)) > 1 / sampleRate ||
    Math.abs(Number(video.duration) - durationSeconds) > 0.001 ||
    Math.abs(Number(audio.duration) - durationSeconds) > 0.001 ||
    Math.abs(Number(media.format?.duration) - durationSeconds) > 0.001
  ) {
    fail("Output MP4 missed its exact structural media gates.");
  }

  const decodedSamples = countDecodedSamples(
    filePath,
    "Output decoded-audio sample count",
  );
  if (decodedSamples !== targetSamples) {
    fail(`Output AAC decoded to ${decodedSamples}, not ${targetSamples}.`);
  }
  const packets = firstPacket(filePath, "Output AAC priming probe");
  const skipSamples = Number(
    packets[0]?.side_data_list?.find(
      (sideData) => sideData.side_data_type === "Skip Samples",
    )?.skip_samples ?? 0,
  );
  if (
    Number(packets[0]?.pts) !== -1024 ||
    skipSamples !== 1024 ||
    Number(packets[1]?.pts) !== 0
  ) {
    fail("Output AAC does not carry correct priming/discard metadata.");
  }
  fullDecode(filePath, ["0:v:0", "0:a:0"], "Output full A/V decode");
  const outputStreamSha256 = videoStreamSha256(
    filePath,
    "Output picture-stream hash",
  );
  if (outputStreamSha256 !== pictureStreamSha256) {
    fail("Output picture stream differs from the picture master.");
  }

  const mastering = measureEbur128(
    filePath,
    0,
    durationSeconds,
    "Encoded mastering analysis",
  );
  validateMasteringMetrics(mastering, "Encoded MP4", -1.5);
  const flatBlockOne = measureEbur128(
    filePath,
    31,
    115,
    "First contour-block analysis",
  );
  const flatBlockTwo = measureEbur128(
    filePath,
    214,
    102,
    "Second contour-block analysis",
  );
  if (
    flatBlockOne.loudnessRangeLu < 1.5 ||
    flatBlockTwo.loudnessRangeLu < 1.5
  ) {
    fail(
      `Contour blocks are too flat: ${flatBlockOne.loudnessRangeLu} and ${flatBlockTwo.loudnessRangeLu} LU LRA.`,
    );
  }

  const arrival = measureVolume(filePath, 342, 6.1, "Closing-arrival level");
  const logo = measureVolume(filePath, 357, 2.7, "Logo-sting level");
  for (const [label, metrics] of [
    ["Closing arrival", arrival],
    ["Logo sting", logo],
  ]) {
    if (metrics.meanDbfs < -30 || metrics.meanDbfs > -21.5) {
      fail(`${label} RMS is ${metrics.meanDbfs} dBFS, outside its target.`);
    }
  }
  const silences = closingSilences(filePath, "Closing-silence analysis");
  if (silences.some((seconds) => seconds > 1)) {
    fail(`Closing contains a ${Math.max(...silences)}s sub-40dBFS gap.`);
  }
  return {
    audioBitrate: Number(audio.bit_rate),
    decodedSamples,
    mastering,
    flatBlocks: {
      seconds31To146Lra: flatBlockOne.loudnessRangeLu,
      seconds214To316Lra: flatBlockTwo.loudnessRangeLu,
    },
    closing: {
      arrival,
      logo,
      silenceEventsOverOneSecond: silences.length,
    },
    pictureStreamSha256: outputStreamSha256,
    priming: { firstPacketPts: -1024, skipSamples, firstAudiblePts: 0 },
  };
};

const writeTemporaryManifest = (filePath, manifest) => {
  const file = fs.openSync(filePath, "wx", 0o600);
  try {
    fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
    fs.fsyncSync(file);
  } finally {
    fs.closeSync(file);
  }
};

const main = () => {
  const paths = parseArguments(process.argv.slice(2));
  if (!paths) return;
  validatePaths(paths);
  run(ffmpegBinary, ["-version"], "ffmpeg availability probe");
  run(ffprobeBinary, ["-version"], "ffprobe availability probe");

  const candidate = validateCandidate(paths.candidateManifest);
  validateCanonicalIdentities(paths, candidate.audioPath);
  const descriptions = validateDescriptionTrack(
    descriptionSource,
    "Tracked description source",
  );
  const picture = validatePicture(paths.picture);
  const filter = buildMasteringFilter(candidate);
  const temporaryWav = temporaryPath(paths.referenceWav);
  const temporaryVideo = temporaryPath(paths.outputVideo);
  const temporaryVtt = temporaryPath(paths.outputVtt);
  const temporaryManifest = temporaryPath(paths.outputManifest);

  try {
    run(
      ffmpegBinary,
      [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-i",
        candidate.audioPath,
        "-filter_complex",
        filter,
        "-map",
        "[out]",
        "-c:a",
        "pcm_s24le",
        temporaryWav,
      ],
      "Mastered PCM render",
    );
    fsyncFile(temporaryWav);
    const referenceValidation = validateReference(temporaryWav);

    run(
      ffmpegBinary,
      [
        "-hide_banner",
        "-nostdin",
        "-loglevel",
        "error",
        "-y",
        "-i",
        paths.picture,
        "-i",
        temporaryWav,
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
        String(sampleRate),
        "-ac",
        "2",
        "-t",
        String(durationSeconds),
        "-movflags",
        "+faststart",
        temporaryVideo,
      ],
      "Picture-lock mux",
    );
    fsyncFile(temporaryVideo);
    const outputValidation = validateOutputVideo(
      temporaryVideo,
      picture.streamSha256,
    );
    fs.copyFileSync(
      descriptionSource,
      temporaryVtt,
      fs.constants.COPYFILE_EXCL,
    );
    fsyncFile(temporaryVtt);
    const stagedDescriptions = validateDescriptionTrack(
      temporaryVtt,
      "Staged description track",
    );
    if (stagedDescriptions.sha256 !== descriptions.sha256) {
      fail("Staged description track differs from its validated source.");
    }

    const manifest = {
      schemaVersion: 1,
      recipeVersion,
      mounted: true,
      mountedInLaunchFilm: true,
      provider: {
        name: "ElevenLabs",
        modelId: candidate.metadata.modelId,
        songId: candidate.metadata.songId,
      },
      source: {
        candidateManifestPath: portablePath(paths.candidateManifest),
        candidateManifestSha256: candidate.manifestSha256,
        audioPath: portablePath(candidate.audioPath),
        audioSha256: candidate.audioSha256,
        decodedSamples: candidate.decodedSamples,
        expectedSamples: targetSamples,
        measuredHeadExcessSamples: candidate.measuredExcessSamples,
        trimmedFromHeadSamples: candidate.measuredExcessSamples,
        declaredHeadSkipSamples: 0,
        modelId: candidate.metadata.modelId,
        songId: candidate.metadata.songId,
        outputFormat: candidate.metadata.outputFormat,
        candidateGeneratedAt: candidate.metadata.generatedAt,
        planPath: portablePath(candidate.planPath),
        planSha256: candidate.planSha256,
      },
      pictureMaster: {
        path: portablePath(paths.picture),
        fileSha256: picture.fileSha256,
        videoStreamSha256: picture.streamSha256,
      },
      descriptionSource: {
        path: portablePath(descriptionSource),
        sha256: descriptions.sha256,
        byteCount: descriptions.byteCount,
        cueCount: descriptions.cueCount,
        durationSeconds: descriptions.durationSeconds,
        maximumCharactersPerSecond: descriptions.maximumCharactersPerSecond,
      },
      recipe: {
        sampleRate,
        durationSeconds,
        targetSamples,
        contourAnchorsSecondsAndDb: contourAnchors,
        monoRepair: {
          windowSeconds: [183.5, 185.5],
          sideGain: 0.316228,
          fadeInSeconds: [183.5, 183.75],
          holdSeconds: [183.75, 185.25],
          fadeOutSeconds: [185.25, 185.5],
        },
        closingArrival: {
          sourceSeconds: [316, 322.1],
          destinationSeconds: [342, 348.1],
          gainDb: -6.7,
          fadeInSeconds: 0.22,
          fadeOutSeconds: 0.35,
        },
        closingReprise: {
          sourceSeconds: [330, 342],
          destinationSeconds: [348, 360],
          gainDb: -3,
          fadeInSeconds: 1.5,
          fadeOutSeconds: 2.5,
        },
        logoSting: {
          sourceSeconds: [323, 325.7],
          destinationSeconds: [357, 359.7],
          gainDb: -10,
          fadeInSeconds: 0.08,
          fadeOutSeconds: 0.2,
        },
        masterGainDb: -0.8,
        limiter: {
          oversampleRate: 192_000,
          limitLinear: 0.7943282347,
          limitDbfs: -2,
          attackMs: 5,
          releaseMs: 100,
          latencyCompensated: true,
        },
      },
      outputs: {
        referenceWav: {
          path: portablePath(paths.referenceWav),
          sha256: sha256File(temporaryWav),
          byteCount: fs.statSync(temporaryWav).size,
          codec: "pcm_s24le",
          sampleRate,
          channels: 2,
          durationSeconds,
          decodedSamples: referenceValidation.decodedSamples,
          ...referenceValidation.mastering,
        },
        video: {
          path: portablePath(paths.outputVideo),
          sha256: sha256File(temporaryVideo),
          byteCount: fs.statSync(temporaryVideo).size,
          videoCodec: "h264",
          audioCodec: "aac",
          audioSampleRate: sampleRate,
          audioChannels: 2,
          audioBitrate: outputValidation.audioBitrate,
          durationSeconds,
          decodedSamples: outputValidation.decodedSamples,
          ...outputValidation.mastering,
        },
        descriptionsVtt: {
          path: portablePath(paths.outputVtt),
          sha256: stagedDescriptions.sha256,
          byteCount: stagedDescriptions.byteCount,
          cueCount: stagedDescriptions.cueCount,
          durationSeconds: stagedDescriptions.durationSeconds,
          maximumCharactersPerSecond:
            stagedDescriptions.maximumCharactersPerSecond,
        },
      },
      validation: {
        fullDecode: true,
        exactSampleCount: true,
        zeroBased: true,
        primingCorrect: true,
        pictureStreamCopied: true,
        flatBlocks: outputValidation.flatBlocks,
        closing: outputValidation.closing,
        priming: outputValidation.priming,
        descriptionTrack: {
          sourceMatchesOutput:
            descriptions.sha256 === stagedDescriptions.sha256,
          fullTimelineCoverage: true,
          contiguousCues: true,
          readingSpeedPassed: true,
        },
      },
    };
    writeTemporaryManifest(temporaryManifest, manifest);

    // Every temporary artifact has passed before any installed artifact moves.
    // Each rename is atomic because its temporary file is in the target folder.
    fs.renameSync(temporaryWav, paths.referenceWav);
    fs.renameSync(temporaryVideo, paths.outputVideo);
    fs.renameSync(temporaryVtt, paths.outputVtt);
    fs.renameSync(temporaryManifest, paths.outputManifest);

    console.log(
      `Mounted offline ElevenLabs master: ${portablePath(paths.outputVideo)}`,
    );
    console.log(
      `${outputValidation.mastering.integratedLufs} LUFS, ${outputValidation.mastering.loudnessRangeLu} LU LRA, ${outputValidation.mastering.truePeakDbfs} dBTP, ${outputValidation.decodedSamples} samples.`,
    );
  } finally {
    fs.rmSync(temporaryWav, { force: true });
    fs.rmSync(temporaryVideo, { force: true });
    fs.rmSync(temporaryVtt, { force: true });
    fs.rmSync(temporaryManifest, { force: true });
  }
};

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
