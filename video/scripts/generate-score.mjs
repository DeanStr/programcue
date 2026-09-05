import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  advancePhase,
  clamp01,
  compressBusSample,
  db,
  equalPowerPan,
  midiToFrequency,
  smoothstep,
  tableHarmonic,
  tableSine,
} from "./score-dsp.mjs";

/**
 * Program Cue launch film score
 *
 * This is a deterministic, self-contained score for the pre-release launch
 * film. It is deliberately arranged like a short film rather than a loop:
 * every chapter has its own density, register and motif, the chapter edits
 * have authored riser/impact cues, and the last chapter resolves back to Dm.
 *
 * The renderer performs a cheap analysis pass before writing the WAV. That
 * lets the deterministic mix land at a useful music-only web-video level
 * without relying on a non-reproducible external mastering step.
 */

const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const BITS_PER_SAMPLE = 16;
const BPM = 120;
const BEATS_PER_BAR = 4;
const TICKS_PER_BEAT = 4;
const TICKS_PER_BAR = BEATS_PER_BAR * TICKS_PER_BEAT;
const generatorPath = fileURLToPath(import.meta.url);
const scriptDirectory = path.dirname(generatorPath);
const dspPath = path.join(scriptDirectory, "score-dsp.mjs");
const repoRoot = path.resolve(scriptDirectory, "../..");
const timelinePath = path.join(repoRoot, "video", "timeline.json");
const sha256File = (filePath) =>
  createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
const generatorSha256 = sha256File(generatorPath);
const dspSha256 = sha256File(dspPath);
// These keys associate the authored value arrays below with named scenes.
// They never drive playback order; timeline.json remains the only editorial
// ordering, and orderAuthoredValues() remaps every array onto that lock.
const authoredValueSceneKeys = [
  "opening",
  "reveal",
  "command",
  "setup",
  "collect",
  "decide",
  "prepare",
  "assist",
  "communicate",
  "place",
  "publish",
  "operate",
  "closing",
];
const requiredScoreSceneKeys = new Set(authoredValueSceneKeys);

const readPictureLock = () => {
  let source;
  let value;
  try {
    source = fs.readFileSync(timelinePath);
    value = JSON.parse(source.toString("utf8"));
  } catch (error) {
    throw new Error(
      `Could not read video/timeline.json: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("video/timeline.json must contain an object.");
  }
  const allowedKeys = new Set(["fps", "width", "height", "scenes"]);
  const unknownKeys = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (
    unknownKeys.length > 0 ||
    Object.keys(value).length !== allowedKeys.size ||
    value.fps !== 30 ||
    value.width !== 1920 ||
    value.height !== 1080 ||
    !Array.isArray(value.scenes) ||
    value.scenes.length !== 13
  ) {
    throw new Error(
      "video/timeline.json must describe the 1920x1080, 30 fps, 13-scene picture lock.",
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
      !/^[a-z][a-z0-9]*$/u.test(scene.key) ||
      seen.has(scene.key) ||
      !Number.isInteger(scene.durationInFrames) ||
      scene.durationInFrames < 1
    ) {
      throw new Error(`video/timeline.json scene ${index + 1} is invalid.`);
    }
    seen.add(scene.key);
    return [scene.key, scene.durationInFrames];
  });
  const totalFrames = scenes.reduce(
    (total, [, duration]) => total + duration,
    0,
  );
  const missingSceneKeys = [...requiredScoreSceneKeys].filter(
    (key) => !seen.has(key),
  );
  if (missingSceneKeys.length > 0) {
    throw new Error(
      `video/timeline.json is missing authored score scenes: ${missingSceneKeys.join(", ")}.`,
    );
  }
  if (totalFrames !== 10_800) {
    throw new Error(
      `video/timeline.json contains ${totalFrames} frames; picture lock is 10800.`,
    );
  }
  return {
    fps: value.fps,
    scenes,
    sha256: createHash("sha256").update(source).digest("hex"),
  };
};

// The score consumes the same ordered picture lock as Remotion, so editorial
// impacts land on exact visual cuts rather than a duplicated approximation.
const PICTURE_LOCK = readPictureLock();
const SCENE_TIMELINE = PICTURE_LOCK.scenes;
const orderAuthoredValues = (values, label) => {
  if (values.length !== authoredValueSceneKeys.length) {
    throw new Error(
      `${label} has ${values.length} entries; expected ${authoredValueSceneKeys.length}.`,
    );
  }
  const byScene = Object.fromEntries(
    authoredValueSceneKeys.map((key, index) => [key, values[index]]),
  );
  return SCENE_TIMELINE.map(([key]) => {
    if (!Object.hasOwn(byScene, key)) {
      throw new Error(`${label} has no authored value for ${key}.`);
    }
    return byScene[key];
  });
};
const SCENE_DURATIONS_FRAMES = SCENE_TIMELINE.map(([, duration]) => duration);
const SCENE_INDEX = Object.fromEntries(
  SCENE_TIMELINE.map(([scene], index) => [scene, index]),
);
const VIDEO_FPS = PICTURE_LOCK.fps;
const TOTAL_VIDEO_FRAMES = SCENE_DURATIONS_FRAMES.reduce(
  (total, duration) => total + duration,
  0,
);
const TOTAL_SECONDS = TOTAL_VIDEO_FRAMES / VIDEO_FPS;
const TOTAL_FRAMES = Math.round(TOTAL_SECONDS * SAMPLE_RATE);
const SAMPLES_PER_BEAT = Math.round((60 / BPM) * SAMPLE_RATE);
const SAMPLES_PER_TICK = Math.round(SAMPLES_PER_BEAT / TICKS_PER_BEAT);
const BYTES_PER_FRAME = CHANNELS * (BITS_PER_SAMPLE / 8);
const DATA_BYTES = TOTAL_FRAMES * BYTES_PER_FRAME;
const OUTPUT_PATH = path.join(
  repoRoot,
  "video",
  "public",
  "video",
  "program-cue-procedural-score.wav",
);
const FRAMES_PER_CHUNK = SAMPLE_RATE;

// The old bed measured -23.7 LUFS before the Remotion volume multiplier. A
// music-only launch film needs a real, listenable web master. RMS is used as
// the deterministic pre-master target, then the gain is capped by peak.
// Leave enough reconstruction headroom for the final 320 kbps AAC encode;
// the procedural master stays full but does not rely on the codec reproducing
// PCM sample peaks exactly.
const TARGET_RMS_DBFS = -17.2;
const MAX_SAMPLE_PEAK_DBFS = -1.3;

if (TOTAL_VIDEO_FRAMES !== 10_800 || TOTAL_SECONDS !== 360) {
  throw new Error("Score timing no longer matches the 13-scene launch film.");
}

const sceneStarts = [];
const sceneStartFrames = [];
let sceneFrameCursor = 0;
for (const duration of SCENE_DURATIONS_FRAMES) {
  sceneStartFrames.push(sceneFrameCursor);
  sceneStarts.push(Math.round((sceneFrameCursor / VIDEO_FPS) * SAMPLE_RATE));
  sceneFrameCursor += duration;
}
const sceneEnds = sceneStarts.map((_, index) =>
  index + 1 < sceneStarts.length ? sceneStarts[index + 1] : TOTAL_FRAMES,
);

// An authored human-scale breath inside Prepare keeps the product story from
// feeling like one uninterrupted machine loop. Derive it from the current
// chapter boundaries so a picture recut cannot leave the cue at a stale
// absolute timestamp.
const PREPARE_START = sceneStarts[SCENE_INDEX.prepare];
const COMMUNICATE_START = sceneStarts[SCENE_INDEX.communicate];
const PREPARE_SPAN = sceneEnds[SCENE_INDEX.prepare] - PREPARE_START;
const HUMAN_REVEAL_START = Math.round(PREPARE_START + PREPARE_SPAN * 0.78);
const HUMAN_REVEAL_END = Math.round(PREPARE_START + PREPARE_SPAN * 0.965);
const HUMAN_REVEAL_NOTES = [62, 65, 69, 72, 76]; // Dm9 voicing, D4–E5
const HUMAN_REVEAL_ONSETS = [1.15, 1.65, 2.2, 2.8, 3.45];
const COMMUNICATE_NOTES = [65, 69, 72, 76]; // Fmaj9 handoff voicing

// Seven musical acts carry the thirteen picture chapters. Every parameter has
// an authored start/end value: the cue develops *inside* scenes instead of
// swapping one static loop for another at each cut.
//
// 1 Invitation       opening / reveal
// 2 Orientation      command / setup
// 3 Momentum         collect / decide
// 4 Human breath     prepare
// 5 Intelligence     assist / communicate
// 6 Orchestration    place / publish
// 7 Resolution       operate / closing
const SCENE_PROFILES = [
  {
    act: 1,
    level: [0.1, 0.3],
    drums: [0, 0.08],
    bass: [0.02, 0.18],
    motif: [0, 0.34],
    arp: [0, 0.14],
    bright: [0.22, 0.44],
    space: [0.9, 0.76],
  },
  {
    act: 1,
    level: [0.28, 0.61],
    drums: [0.1, 0.5],
    bass: [0.22, 0.56],
    motif: [0.24, 0.64],
    arp: [0.08, 0.46],
    bright: [0.38, 0.68],
    space: [0.8, 0.62],
  },
  {
    act: 2,
    level: [0.56, 0.74],
    drums: [0.52, 0.72],
    bass: [0.56, 0.74],
    motif: [0.44, 0.74],
    arp: [0.34, 0.66],
    bright: [0.58, 0.76],
    space: [0.62, 0.5],
  },
  {
    act: 2,
    level: [0.67, 0.53],
    drums: [0.62, 0.43],
    bass: [0.64, 0.48],
    motif: [0.64, 0.42],
    arp: [0.54, 0.3],
    bright: [0.72, 0.56],
    space: [0.54, 0.7],
  },
  {
    act: 3,
    level: [0.52, 0.8],
    drums: [0.46, 0.8],
    bass: [0.5, 0.82],
    motif: [0.4, 0.78],
    arp: [0.34, 0.78],
    bright: [0.54, 0.84],
    space: [0.66, 0.5],
  },
  {
    act: 3,
    level: [0.76, 0.98],
    drums: [0.76, 0.98],
    bass: [0.8, 1],
    motif: [0.72, 0.94],
    arp: [0.74, 0.96],
    bright: [0.8, 1],
    space: [0.52, 0.46],
  },
  {
    act: 4,
    level: [0.48, 0.34],
    drums: [0.24, 0.06],
    bass: [0.4, 0.18],
    motif: [0.42, 0.2],
    arp: [0.3, 0.08],
    bright: [0.48, 0.32],
    space: [0.72, 0.94],
  },
  {
    act: 5,
    level: [0.5, 0.85],
    drums: [0.42, 0.78],
    bass: [0.48, 0.78],
    motif: [0.54, 0.9],
    arp: [0.44, 0.82],
    bright: [0.62, 0.9],
    space: [0.72, 0.56],
  },
  {
    act: 5,
    level: [0.7, 0.84],
    drums: [0.64, 0.8],
    bass: [0.66, 0.8],
    motif: [0.62, 0.82],
    arp: [0.56, 0.76],
    bright: [0.72, 0.88],
    space: [0.64, 0.54],
  },
  {
    act: 6,
    level: [0.77, 0.96],
    drums: [0.78, 0.98],
    bass: [0.78, 0.94],
    motif: [0.7, 0.94],
    arp: [0.7, 0.96],
    bright: [0.8, 0.98],
    space: [0.56, 0.48],
  },
  {
    act: 6,
    level: [0.91, 1],
    drums: [0.92, 1],
    bass: [0.92, 1],
    motif: [0.86, 1],
    arp: [0.88, 1],
    bright: [0.92, 1],
    space: [0.5, 0.58],
  },
  {
    act: 7,
    level: [0.78, 0.57],
    drums: [0.72, 0.4],
    bass: [0.74, 0.48],
    motif: [0.7, 0.46],
    arp: [0.6, 0.3],
    bright: [0.78, 0.56],
    space: [0.62, 0.78],
  },
  {
    act: 7,
    level: [0.42, 0.1],
    drums: [0.16, 0],
    bass: [0.36, 0.08],
    motif: [0.5, 0.2],
    arp: [0.26, 0.04],
    bright: [0.58, 0.28],
    space: [0.82, 0.98],
  },
];
const SCENES = orderAuthoredValues(SCENE_PROFILES, "Scene profiles");

// The harmonic world stays anchored in D minor / F major, but it now moves
// every two bars. The former implementation held one chord for an entire
// 23–40 second scene, which was the largest source of musical stasis.
const CHORD = {
  dm9: { root: 50, intervals: [0, 3, 7, 10, 14] },
  bbMaj9: { root: 46, intervals: [0, 4, 7, 11, 14] },
  fMaj9: { root: 53, intervals: [0, 4, 7, 11, 14] },
  c69: { root: 48, intervals: [0, 4, 7, 9, 14] },
  gm9: { root: 55, intervals: [0, 3, 7, 10, 14] },
  a7sus: { root: 45, intervals: [0, 5, 7, 10, 14] },
};
const AUTHORED_HARMONIES = [
  [CHORD.dm9, CHORD.bbMaj9, CHORD.fMaj9, CHORD.c69],
  [CHORD.dm9, CHORD.bbMaj9, CHORD.fMaj9, CHORD.c69],
  [CHORD.dm9, CHORD.c69, CHORD.bbMaj9, CHORD.gm9],
  [CHORD.fMaj9, CHORD.c69, CHORD.dm9, CHORD.bbMaj9],
  [CHORD.dm9, CHORD.bbMaj9, CHORD.fMaj9, CHORD.c69, CHORD.gm9],
  [CHORD.gm9, CHORD.bbMaj9, CHORD.dm9, CHORD.a7sus],
  [CHORD.bbMaj9, CHORD.fMaj9, CHORD.c69, CHORD.dm9],
  [CHORD.dm9, CHORD.bbMaj9, CHORD.fMaj9, CHORD.c69, CHORD.gm9],
  [CHORD.fMaj9, CHORD.c69, CHORD.dm9, CHORD.bbMaj9],
  [CHORD.dm9, CHORD.c69, CHORD.bbMaj9, CHORD.fMaj9, CHORD.gm9, CHORD.c69],
  [CHORD.bbMaj9, CHORD.fMaj9, CHORD.c69, CHORD.dm9, CHORD.gm9, CHORD.a7sus],
  [CHORD.dm9, CHORD.bbMaj9, CHORD.gm9, CHORD.a7sus],
  [CHORD.bbMaj9, CHORD.fMaj9, CHORD.c69, CHORD.dm9],
];
const HARMONIES = orderAuthoredValues(AUTHORED_HARMONIES, "Harmony plans");

// The sonic logo is literal and recurring: D–F–A–E. Arrangement and octave
// change across the arc, while the note identity stays recognisable.
const BRAND_MOTIF = [62, 65, 69, 76];

// A phrase map replaces the old density threshold that could repeat the exact
// four-note logo every bar. Scenes now own a small number of statements with
// rests between them; note order, spacing, register and articulation change
// while the D–F–A–E identity remains legible. Publish gets only three hero
// statements at 280.25, 296.25 and 312.25 seconds.
const MOTIF_PHRASES = {
  signature: [
    { tick: 2, note: 0, velocity: 0.92, decay: 0.94 },
    { tick: 6, note: 1, velocity: 0.82, decay: 1.02 },
    { tick: 10, note: 2, velocity: 0.88, decay: 0.96 },
    { tick: 14, note: 3, velocity: 0.76, decay: 1.08 },
  ],
  fragment: [
    { tick: 2, note: 0, velocity: 0.78, decay: 1.08 },
    { tick: 7, note: 1, velocity: 0.7, decay: 1.14 },
    { tick: 12, note: 2, velocity: 0.74, decay: 1.04 },
  ],
  answer: [
    { tick: 3, note: 3, transpose: -12, velocity: 0.68, decay: 1.06 },
    { tick: 8, note: 2, transpose: -12, velocity: 0.76, decay: 0.98 },
    { tick: 13, note: 1, velocity: 0.7, decay: 1.12 },
  ],
  lift: [
    { tick: 2, note: 0, velocity: 0.78, decay: 1.04 },
    { tick: 6, note: 2, velocity: 0.9, decay: 0.92 },
    { tick: 11, note: 3, velocity: 0.8, decay: 1 },
    { tick: 14, note: 2, transpose: 12, velocity: 0.7, decay: 1.14 },
  ],
  resolve: [
    { tick: 2, note: 3, transpose: -12, velocity: 0.72, decay: 1.08 },
    { tick: 6, note: 2, velocity: 0.82, decay: 0.96 },
    { tick: 10, note: 1, velocity: 0.76, decay: 1.02 },
    { tick: 15, note: 0, velocity: 0.88, decay: 0.9 },
  ],
};

const AUTHORED_MOTIF_STATEMENTS = [
  [
    { bar: 4, phrase: "fragment" },
    { bar: 6, phrase: "lift" },
  ],
  [
    { bar: 0, phrase: "signature" },
    { bar: 4, phrase: "answer" },
    { bar: 7, phrase: "lift" },
  ],
  [
    { bar: 1, phrase: "fragment" },
    { bar: 5, phrase: "signature" },
    { bar: 9, phrase: "answer" },
  ],
  [
    { bar: 0, phrase: "answer" },
    { bar: 5, phrase: "fragment" },
    { bar: 10, phrase: "resolve" },
  ],
  [
    { bar: 1, phrase: "fragment" },
    { bar: 5, phrase: "answer" },
    { bar: 9, phrase: "signature" },
    { bar: 13, phrase: "lift" },
    { bar: 15, phrase: "resolve" },
  ],
  [
    { bar: 0, phrase: "signature" },
    { bar: 4, phrase: "answer" },
    { bar: 8, phrase: "lift" },
    { bar: 12, phrase: "fragment" },
    { bar: 16, phrase: "resolve" },
  ],
  [
    { bar: 2, phrase: "fragment" },
    { bar: 8, phrase: "answer" },
    { bar: 14, phrase: "resolve" },
  ],
  [
    { bar: 1, phrase: "fragment" },
    { bar: 6, phrase: "answer" },
    { bar: 11, phrase: "lift" },
    { bar: 16, phrase: "resolve" },
  ],
  [
    { bar: 1, phrase: "signature" },
    { bar: 5, phrase: "answer" },
    { bar: 9, phrase: "lift" },
    { bar: 12, phrase: "resolve" },
  ],
  [
    { bar: 0, phrase: "fragment" },
    { bar: 4, phrase: "signature" },
    { bar: 8, phrase: "answer" },
    { bar: 12, phrase: "lift" },
    { bar: 16, phrase: "resolve" },
    { bar: 19, phrase: "fragment" },
  ],
  [
    { bar: 0, phrase: "signature" },
    { bar: 8, phrase: "lift" },
    { bar: 16, phrase: "resolve" },
  ],
  [
    { bar: 1, phrase: "answer" },
    { bar: 5, phrase: "fragment" },
    { bar: 9, phrase: "resolve" },
    { bar: 12, phrase: "signature" },
  ],
  [
    { bar: 0, phrase: "fragment" },
    { bar: 4, phrase: "answer" },
    { bar: 7, phrase: "resolve" },
  ],
];
const MOTIF_STATEMENTS = orderAuthoredValues(
  AUTHORED_MOTIF_STATEMENTS,
  "Motif statements",
);
const MOTIF_STATEMENT_LOOKUPS = MOTIF_STATEMENTS.map(
  (statements) => new Map(statements.map(({ bar, phrase }) => [bar, phrase])),
);

// These are the handful of hero-state cuts that deserve picture-specific
// sound direction. Frames are local to the scene, so a moved chapter remains
// aligned without stale absolute seconds. The cues are tonal and quiet;
// ordinary UI clicks stay silent.
const HERO_CUE_DEFINITIONS = [
  {
    id: "command-action",
    scene: "command",
    localFrame: 470,
    midi: 74,
    interval: 7,
    intensity: 0.44,
    duration: 0.8,
  },
  {
    id: "collect-build",
    scene: "collect",
    localFrame: 149,
    midi: 69,
    interval: 3,
    intensity: 0.34,
    duration: 0.58,
  },
  {
    id: "collect-preview",
    scene: "collect",
    localFrame: 330,
    midi: 72,
    interval: 4,
    intensity: 0.36,
    duration: 0.62,
  },
  {
    id: "collect-publish",
    scene: "collect",
    localFrame: 499,
    midi: 74,
    interval: 5,
    intensity: 0.48,
    duration: 0.9,
  },
  {
    id: "collect-draft",
    scene: "collect",
    localFrame: 653,
    midi: 69,
    interval: 3,
    intensity: 0.32,
    duration: 0.56,
  },
  {
    id: "collect-submit",
    scene: "collect",
    localFrame: 812,
    midi: 74,
    interval: 7,
    intensity: 0.52,
    duration: 0.96,
  },
  {
    id: "assistant-open",
    scene: "assist",
    localFrame: 216,
    midi: 76,
    interval: 5,
    intensity: 0.36,
    duration: 0.7,
  },
  {
    id: "assistant-preview",
    scene: "assist",
    localFrame: 510,
    midi: 72,
    interval: 4,
    intensity: 0.4,
    duration: 0.76,
  },
  {
    id: "assistant-queue",
    scene: "assist",
    localFrame: 824,
    midi: 74,
    interval: 7,
    intensity: 0.54,
    duration: 1.02,
  },
  {
    id: "place-publish-confirm",
    scene: "place",
    localFrame: 1052,
    midi: 65,
    interval: 7,
    intensity: 0.46,
    duration: 1.8,
  },
  {
    id: "place-published-result",
    scene: "place",
    localFrame: 1104,
    midi: 65,
    interval: 4,
    intensity: 0.38,
    duration: 1.4,
  },
];
const HERO_CUES = HERO_CUE_DEFINITIONS.map((cue) => {
  const sceneIndex = SCENE_INDEX[cue.scene];
  const absoluteFrame = sceneStartFrames[sceneIndex] + cue.localFrame;
  return {
    ...cue,
    absoluteFrame,
    start: Math.round((absoluteFrame / VIDEO_FPS) * SAMPLE_RATE),
    end: Math.round((absoluteFrame / VIDEO_FPS + cue.duration) * SAMPLE_RATE),
  };
}).sort((left, right) => left.start - right.start);

if (
  SCENES.length !== SCENE_TIMELINE.length ||
  HARMONIES.length !== SCENE_TIMELINE.length ||
  MOTIF_STATEMENTS.length !== SCENE_TIMELINE.length
) {
  throw new Error(
    "Every launch-film scene needs one score profile, chord and motif plan.",
  );
}
for (const cue of HERO_CUE_DEFINITIONS) {
  const sceneIndex = SCENE_INDEX[cue.scene];
  if (
    !Number.isInteger(cue.localFrame) ||
    sceneIndex === undefined ||
    cue.localFrame < 0 ||
    !Number.isFinite(cue.duration) ||
    cue.duration <= 0 ||
    cue.localFrame + cue.duration * VIDEO_FPS >
      SCENE_DURATIONS_FRAMES[sceneIndex]
  ) {
    throw new Error(`Hero cue ${cue.id} is outside its picture-locked scene.`);
  }
}
for (let index = 0; index < HERO_CUES.length; index += 1) {
  const cue = HERO_CUES[index];
  const expectedSample = cue.absoluteFrame * (SAMPLE_RATE / VIDEO_FPS);
  if (
    !Number.isInteger(expectedSample) ||
    cue.start !== expectedSample ||
    (index > 0 && cue.start <= HERO_CUES[index - 1].start)
  ) {
    throw new Error(
      `Hero cue ${cue.id} is not exact-frame or chronologically sorted.`,
    );
  }
}
for (const [sceneIndex, statements] of MOTIF_STATEMENTS.entries()) {
  const seenBars = new Set();
  for (const { bar, phrase } of statements) {
    const phraseEvents = MOTIF_PHRASES[phrase];
    const availableTicks =
      (SCENE_DURATIONS_FRAMES[sceneIndex] * SAMPLE_RATE) /
      VIDEO_FPS /
      SAMPLES_PER_TICK;
    if (
      !Number.isInteger(bar) ||
      bar < 0 ||
      seenBars.has(bar) ||
      !phraseEvents ||
      phraseEvents.some(
        ({ tick }) => bar * TICKS_PER_BAR + tick >= availableTicks,
      )
    ) {
      throw new Error(
        `Motif statements for ${SCENE_TIMELINE[sceneIndex][0]} must use unique in-scene bars and known phrases.`,
      );
    }
    seenBars.add(bar);
  }
}

const outputDirectory = path.dirname(OUTPUT_PATH);

const makeTemporaryOutputPath = () =>
  path.join(
    outputDirectory,
    `.${path.basename(OUTPUT_PATH)}.${process.pid}.${randomUUID()}.tmp`,
  );

const temporaryOutputPattern =
  /^\.program-cue-procedural-score\.wav\.([1-9]\d*)\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.tmp$/u;

const processIsAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && typeof error === "object" && error.code === "ESRCH");
  }
};

const removeAbandonedTemporaryOutputs = async () => {
  const entries = await fs.promises.readdir(outputDirectory, {
    withFileTypes: true,
  });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const match = temporaryOutputPattern.exec(entry.name);
    if (!match) continue;
    const ownerPid = Number(match[1]);
    if (ownerPid === process.pid || processIsAlive(ownerPid)) continue;
    const abandonedPath = path.join(outputDirectory, entry.name);
    let file;
    try {
      file = await fs.promises.lstat(abandonedPath);
    } catch (error) {
      if (error && typeof error === "object" && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    if (!file.isFile()) continue;
    await fs.promises.rm(abandonedPath, { force: true });
    console.warn(
      `Removed abandoned score staging file ${path.relative(repoRoot, abandonedPath)}.`,
    );
  }
};

const installSignalCleanup = (temporaryOutputPath) => {
  const handlers = new Map();
  for (const [signal, exitCode] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ]) {
    const handler = () => {
      fs.rmSync(temporaryOutputPath, { force: true });
      process.exit(exitCode);
    };
    handlers.set(signal, handler);
    process.once(signal, handler);
  }
  return () => {
    for (const [signal, handler] of handlers) {
      process.off(signal, handler);
    }
  };
};

function makeWavHeader(dataSize) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataSize, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // linear PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_FRAME, 28);
  header.writeUInt16LE(BYTES_PER_FRAME, 32);
  header.writeUInt16LE(BITS_PER_SAMPLE, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataSize, 40);
  return header;
}

const AUTHORED_TRANSITIONS = [
  { style: "emerge", pre: 0, tail: 2.8, intensity: 0.62 },
  { style: "bloom", pre: 0.9, tail: 3.4, intensity: 0.72 },
  { style: "signal", pre: 1.2, tail: 2.6, intensity: 0.82 },
  { style: "soft", pre: 0.65, tail: 2.2, intensity: 0.5 },
  { style: "pickup", pre: 1, tail: 2.6, intensity: 0.76 },
  { style: "drive", pre: 1.35, tail: 3.1, intensity: 0.96 },
  { style: "vacuum", pre: 1.55, tail: 3.5, intensity: 0.72 },
  { style: "spark", pre: 1.05, tail: 2.8, intensity: 0.82 },
  { style: "signal", pre: 0.85, tail: 2.4, intensity: 0.68 },
  { style: "lift", pre: 1.45, tail: 3.1, intensity: 0.96 },
  { style: "hero", pre: 1.8, tail: 3.8, intensity: 1.16 },
  { style: "resolve", pre: 0.8, tail: 2.8, intensity: 0.7 },
  { style: "dissolve", pre: 1.3, tail: 3.2, intensity: 0.58 },
];
const TRANSITIONS = orderAuthoredValues(
  AUTHORED_TRANSITIONS,
  "Transition plans",
);

function createAccentEvents() {
  return sceneStarts.map((boundary, index) => {
    const transition = TRANSITIONS[index];
    const preRoll = Math.round(transition.pre * SAMPLE_RATE);
    const start = Math.max(0, boundary - preRoll);
    const impactOffset = index === 0 ? Math.round(0.36 * SAMPLE_RATE) : preRoll;
    return {
      start,
      impact: start + impactOffset,
      end: Math.min(
        TOTAL_FRAMES,
        boundary + Math.round(transition.tail * SAMPLE_RATE),
      ),
      index,
      style: transition.style,
      intensity: transition.intensity,
    };
  });
}

function makeNoise() {
  // Fixed LCG: deterministic, cheap and independent of host audio libraries.
  let state = 0x4f1bbcdc;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return (state / 4_294_967_295) * 2 - 1;
  };
}

function createSynth() {
  const padVoiceCount = 5;
  const padPhaseL = [0.03, 0.19, 0.37, 0.58, 0.79];
  // Keep the chord's low-mid fundamentals phase-coherent in mono. Stereo
  // movement comes from the narrow panning and the upper-register motifs.
  const padPhaseR = [0.03, 0.19, 0.37, 0.58, 0.79];
  const padIncrementL = new Float64Array(padVoiceCount);
  const padIncrementR = new Float64Array(padVoiceCount);
  const previousPadPhaseL = new Float64Array(padVoiceCount);
  const previousPadPhaseR = new Float64Array(padVoiceCount);
  const previousPadIncrementL = new Float64Array(padVoiceCount);
  const previousPadIncrementR = new Float64Array(padVoiceCount);
  const padPanL = new Float64Array(padVoiceCount);
  const padPanR = new Float64Array(padVoiceCount);
  const padCrossfadeSamples = Math.round(SAMPLE_RATE * 0.18);
  let padCrossfadeSample = padCrossfadeSamples;
  let padInitialized = false;
  // Narrow, near-centred pads preserve width without throwing the low-mid
  // chord away on phones and mono social players.
  const voicePans = [-0.38, -0.18, 0, 0.18, 0.38];
  for (let voice = 0; voice < padVoiceCount; voice += 1) {
    const [panL, panR] = equalPowerPan(voicePans[voice]);
    padPanL[voice] = panL;
    padPanR[voice] = panR;
  }

  const pluckCount = 6;
  const pluckAge = new Float64Array(pluckCount).fill(-1);
  const pluckPhaseL = new Float64Array(pluckCount);
  const pluckPhaseR = new Float64Array(pluckCount);
  const pluckIncrementL = new Float64Array(pluckCount);
  const pluckIncrementR = new Float64Array(pluckCount);
  const pluckPan = [-0.42, 0.3, -0.18, 0.18, 0.42, -0.3];
  const pluckPanL = pluckPan.map((pan) => equalPowerPan(pan)[0]);
  const pluckPanR = pluckPan.map((pan) => equalPowerPan(pan)[1]);
  let pluckSlot = -1;

  const melodyCount = 8;
  const melodyAge = new Float64Array(melodyCount).fill(-1);
  const melodyPhaseL = new Float64Array(melodyCount);
  const melodyPhaseR = new Float64Array(melodyCount);
  const melodyIncrementL = new Float64Array(melodyCount);
  const melodyIncrementR = new Float64Array(melodyCount);
  const melodyVelocity = new Float64Array(melodyCount).fill(1);
  const melodyDecay = new Float64Array(melodyCount).fill(1);
  const melodyPan = [-0.32, 0.24, -0.18, 0.36, -0.36, 0.18, -0.24, 0.3];
  const melodyPanL = melodyPan.map((pan) => equalPowerPan(pan)[0]);
  const melodyPanR = melodyPan.map((pan) => equalPowerPan(pan)[1]);
  let melodySlot = -1;

  let bassAge = -1;
  let bassPhase = 0;
  let bassIncrement = 0;
  let bassFrequency = 55;

  let kickAge = -1;
  let kickPhase = 0;
  let snareAge = -1;
  let snareNoiseState = 0;
  let clapAge = -1;
  let clapNoiseState = 0;
  let hatAge = -1;
  let hatOpen = false;
  let hatPrevNoise = 0;
  let shakerAge = -1;
  let shakerPrevNoise = 0;
  let tomAge = -1;
  let tomPhase = 0;
  let tomFrequency = 180;
  let shimmerCarrierPhase = 0;
  let shimmerUpperPhase = 0.03;
  let shimmerAirPhase = 0.08;

  let sceneIndex = 0;
  let targetLevel = SCENES[0].level[0];
  let level = SCENES[0].level[0];
  let sceneProgress = 0;
  let sceneBarIndex = 0;
  let currentChord = HARMONIES[0][0];
  const profile = {
    drums: SCENES[0].drums[0],
    bass: SCENES[0].bass[0],
    motif: SCENES[0].motif[0],
    arp: SCENES[0].arp[0],
    bright: SCENES[0].bright[0],
    space: SCENES[0].space[0],
  };
  let tickSample = 0;
  let accentIndex = 0;
  let activeAccent = null;
  let heroCueIndex = 0;
  let activeHeroCue = null;
  const noise = makeNoise();
  let peak = 0;
  let sumSquares = 0;
  let renderedSamples = 0;
  let previousOutputL = 0;
  let previousOutputR = 0;
  const finalStingStart =
    sceneEnds[SCENE_INDEX.closing] - Math.round(2.75 * SAMPLE_RATE);
  const finalStingNotes = [62, 65, 69, 76, 74]; // D–F–A–E, resolving to D

  // Two low-feedback, cross-fed ambience lines make the upper synth layers
  // feel physical rather than dry. Delays are deliberately positive-polarity
  // and the centered low end remains outside the widening path, preserving a
  // strong mono fold-down.
  const delayLength = Math.round(SAMPLE_RATE * 0.875);
  const ambienceL = new Float64Array(delayLength);
  const ambienceR = new Float64Array(delayLength);
  const delaySamplesL = Math.round(SAMPLE_RATE * 0.3125);
  const delaySamplesR = Math.round(SAMPLE_RATE * 0.4375);
  let delayWrite = 0;
  let ambienceFilterL = 0;
  let ambienceFilterR = 0;
  let ambienceInputLowL = 0;
  let ambienceInputLowR = 0;

  const interpolate = (range, progress) =>
    range[0] + (range[1] - range[0]) * progress;
  const bell = (progress, center, width) => {
    const distance = (progress - center) / width;
    return Math.exp(-(distance * distance));
  };

  const sceneMotion = (index, progress) => {
    switch (index) {
      case SCENE_INDEX.opening:
        return 0.88 + smoothstep(progress) * 0.12;
      case SCENE_INDEX.reveal:
        return 0.93 + smoothstep(progress) * 0.07;
      case SCENE_INDEX.command:
        return 1 - bell(progress, 0.56, 0.085) * 0.14;
      case SCENE_INDEX.setup:
        return 1 - smoothstep((progress - 0.82) / 0.13) * 0.17;
      case SCENE_INDEX.collect:
        return 0.91 + smoothstep(progress) * 0.09;
      case SCENE_INDEX.decide:
        return 1 - bell(progress, 0.9, 0.045) * 0.13;
      case SCENE_INDEX.prepare:
        return 1 - bell(progress, 0.7, 0.12) * 0.12;
      case SCENE_INDEX.assist:
        return 0.94 + Math.sin(progress * Math.PI * 3) ** 2 * 0.06;
      case SCENE_INDEX.communicate:
        return 1 - bell(progress, 0.48, 0.095) * 0.12;
      case SCENE_INDEX.place:
        return 1 - bell(progress, 0.52, 0.055) * 0.14;
      case SCENE_INDEX.publish: {
        const baseline = 0.95 + smoothstep(progress) * 0.05;
        const breath =
          progress <= 0.58
            ? smoothstep((progress - 0.4) / 0.18)
            : 1 - smoothstep((progress - 0.58) / 0.18);
        return baseline * (1 - breath * 0.18);
      }
      case SCENE_INDEX.operate:
        return 0.97 + Math.sin(progress * Math.PI * 2) ** 2 * 0.03;
      case SCENE_INDEX.closing:
        return 1 - smoothstep((progress - 0.62) / 0.32) * 0.08;
      default:
        return 1;
    }
  };

  const updateProfile = (sampleIndex) => {
    const start = sceneStarts[sceneIndex];
    const end = sceneEnds[sceneIndex];
    sceneProgress = clamp01((sampleIndex - start) / Math.max(1, end - start));
    const developed = smoothstep(sceneProgress);
    const motion = sceneMotion(sceneIndex, sceneProgress);
    const base = SCENES[sceneIndex];
    targetLevel = interpolate(base.level, developed) * motion;
    profile.drums = clamp01(interpolate(base.drums, developed) * motion);
    profile.bass = clamp01(interpolate(base.bass, developed) * motion);
    profile.motif = clamp01(interpolate(base.motif, developed) * motion);
    profile.arp = clamp01(interpolate(base.arp, developed) * motion);
    profile.bright = clamp01(interpolate(base.bright, developed));
    profile.space = clamp01(interpolate(base.space, developed));
  };

  const selectChord = () => {
    const harmony = HARMONIES[sceneIndex];
    return harmony[Math.floor(sceneBarIndex / 2) % harmony.length];
  };

  const updatePadChord = () => {
    const chord = currentChord;
    const variation = Math.floor(Math.max(0, sceneBarIndex) / 2) % 3;
    const targetIncrementL = new Float64Array(padVoiceCount);
    const targetIncrementR = new Float64Array(padVoiceCount);
    for (let voice = 0; voice < padVoiceCount; voice += 1) {
      const octaveLift =
        variation === 1 && (voice === 0 || voice === 4)
          ? 12
          : variation === 2 && voice >= 2
            ? 12
            : 0;
      const midi = chord.root + chord.intervals[voice] + octaveLift;
      const frequency = midiToFrequency(midi);
      targetIncrementL[voice] = frequency / SAMPLE_RATE;
      targetIncrementR[voice] = frequency / SAMPLE_RATE;
    }
    if (!padInitialized) {
      padIncrementL.set(targetIncrementL);
      padIncrementR.set(targetIncrementR);
      padInitialized = true;
      return;
    }
    const changed = targetIncrementL.some(
      (increment, voice) => Math.abs(increment - padIncrementL[voice]) > 1e-12,
    );
    if (!changed) return;
    for (let voice = 0; voice < padVoiceCount; voice += 1) {
      previousPadPhaseL[voice] = padPhaseL[voice];
      previousPadPhaseR[voice] = padPhaseR[voice];
      previousPadIncrementL[voice] = padIncrementL[voice];
      previousPadIncrementR[voice] = padIncrementR[voice];
    }
    padIncrementL.set(targetIncrementL);
    padIncrementR.set(targetIncrementR);
    padCrossfadeSample = 0;
  };

  const triggerBass = (tickInBar) => {
    const chord = currentChord;
    const bassSteps = [0, 0, 7, 0, 0, 10, 7, 0];
    const step =
      bassSteps[
        (sceneBarIndex * 2 + Math.floor(tickInBar / 4)) % bassSteps.length
      ];
    bassFrequency = midiToFrequency(chord.root - 24 + step);
    bassIncrement = bassFrequency / SAMPLE_RATE;
    bassAge = 0;
    bassPhase = 0;
  };

  const triggerPluck = (tickInBar) => {
    const chord = currentChord;
    const noteIndex =
      (sceneBarIndex + Math.floor(tickInBar / 2) + sceneIndex) %
      chord.intervals.length;
    const octave = tickInBar === 10 || tickInBar === 14 ? 12 : 0;
    const frequency = midiToFrequency(
      chord.root + chord.intervals[noteIndex] + 24 + octave,
    );
    pluckSlot = (pluckSlot + 1) % pluckCount;
    pluckAge[pluckSlot] = 0;
    pluckPhaseL[pluckSlot] = 0;
    pluckPhaseR[pluckSlot] = 0.004 + pluckSlot * 0.001;
    pluckIncrementL[pluckSlot] = (frequency * 0.999) / SAMPLE_RATE;
    pluckIncrementR[pluckSlot] = (frequency * 1.001) / SAMPLE_RATE;
  };

  const triggerMelody = ({ note, transpose = 0, velocity, decay }) => {
    const octaveLift =
      sceneIndex >= SCENE_INDEX.place && sceneBarIndex % 4 >= 2 ? 12 : 0;
    const registerDrop = sceneIndex === SCENE_INDEX.prepare ? -12 : 0;
    const frequency = midiToFrequency(
      BRAND_MOTIF[note] + transpose + octaveLift + registerDrop,
    );
    melodySlot = (melodySlot + 1) % melodyCount;
    melodyAge[melodySlot] = 0;
    melodyPhaseL[melodySlot] = 0;
    melodyPhaseR[melodySlot] = 0.002 + melodySlot * 0.001;
    melodyIncrementL[melodySlot] = (frequency * 0.9995) / SAMPLE_RATE;
    melodyIncrementR[melodySlot] = (frequency * 1.0005) / SAMPLE_RATE;
    melodyVelocity[melodySlot] = velocity;
    melodyDecay[melodySlot] = decay;
  };

  const triggerTickEvents = (sampleIndex) => {
    const tickInScene = Math.floor(
      (sampleIndex - sceneStarts[sceneIndex]) / SAMPLES_PER_TICK + 0.000001,
    );
    sceneBarIndex = Math.floor(tickInScene / TICKS_PER_BAR);
    const tickInBar = tickInScene % TICKS_PER_BAR;
    if (tickInBar === 0) {
      currentChord = selectChord();
      updatePadChord();
    }

    // Each scene owns its groove rather than inheriting a global loop phase.
    // The variations remain simple enough to read beneath product UI, but
    // pickups, half-time bars and denser act-six syncopation keep it authored.
    const openingHold =
      sceneIndex === SCENE_INDEX.opening && sceneProgress < 0.44;
    if (!openingHold && profile.drums > 0) {
      const grooveVariant = (sceneIndex + sceneBarIndex) % 4;
      const kickOn =
        tickInBar === 0 ||
        tickInBar === 8 ||
        (profile.drums > 0.72 &&
          (tickInBar === (grooveVariant % 2 === 0 ? 6 : 7) ||
            tickInBar === 14)) ||
        (profile.drums > 0.9 && grooveVariant === 3 && tickInBar === 11);
      if (kickOn) {
        kickAge = 0;
        kickPhase = 0;
      }
      if (tickInBar === 4 || tickInBar === 12) snareAge = 0;
      if (profile.drums > 0.55 && (tickInBar === 4 || tickInBar === 12)) {
        clapAge = 0;
      }
      if (tickInBar % (profile.bright > 0.9 ? 1 : 2) === 0) {
        hatAge = 0;
        hatOpen = tickInBar === 6 || tickInBar === 14;
      }
      if (profile.drums > 0.45 && tickInBar % 2 === 1) shakerAge = 0;
      if (profile.drums > 0.8 && sceneBarIndex % 8 === 7 && tickInBar >= 12) {
        tomAge = 0;
        tomPhase = 0;
        tomFrequency = tickInBar === 12 ? 190 : 260;
      }
    }

    const bassDivision = profile.bass > 0.68 ? 4 : 8;
    if (profile.bass > 0.15 && tickInBar % bassDivision === 0) {
      triggerBass(tickInBar);
    }
    const arpTicks =
      sceneIndex === SCENE_INDEX.prepare
        ? [3, 7, 11, 15]
        : [1, 3, 5, 7, 9, 11, 13, 15];
    if (profile.arp > 0.1 && arpTicks.includes(tickInBar)) {
      triggerPluck(tickInBar);
    }
    const phraseName = MOTIF_STATEMENT_LOOKUPS[sceneIndex].get(sceneBarIndex);
    const phraseEvent = phraseName
      ? MOTIF_PHRASES[phraseName].find(({ tick }) => tick === tickInBar)
      : undefined;
    if (profile.motif > 0.08 && phraseEvent) {
      triggerMelody(phraseEvent);
    }
  };

  const nextSample = (sampleIndex) => {
    while (
      sceneIndex + 1 < sceneStarts.length &&
      sampleIndex >= sceneStarts[sceneIndex + 1]
    ) {
      sceneIndex += 1;
      tickSample = 0;
    }

    updateProfile(sampleIndex);

    while (
      accentIndex < accentEvents.length &&
      sampleIndex >= accentEvents[accentIndex].start
    ) {
      activeAccent = accentEvents[accentIndex];
      accentIndex += 1;
    }
    if (activeAccent && sampleIndex >= activeAccent.end) activeAccent = null;
    while (
      heroCueIndex < HERO_CUES.length &&
      sampleIndex >= HERO_CUES[heroCueIndex].start
    ) {
      activeHeroCue = HERO_CUES[heroCueIndex];
      heroCueIndex += 1;
    }
    if (activeHeroCue && sampleIndex >= activeHeroCue.end) {
      activeHeroCue = null;
    }

    if (tickSample === 0) triggerTickEvents(sampleIndex);
    tickSample += 1;
    if (tickSample >= SAMPLES_PER_TICK) {
      tickSample = 0;
    }

    // A ~0.45 second smoothing constant joins the authored scene curves
    // without flattening their internal ramps and breaths.
    level += (targetLevel - level) * 0.000045;
    const pulse =
      0.9 +
      0.1 * tableSine(sampleIndex / (SAMPLE_RATE * 8) + sceneIndex * 0.17);
    let left = 0;
    let right = 0;

    // Pads: richer harmonics than the original sine-only bed, with narrow
    // equal-power panning and phase-coherent fundamentals for mono safety.
    const padCrossfade = smoothstep(
      padCrossfadeSample / Math.max(1, padCrossfadeSamples),
    );
    const previousPadGain = 1 - padCrossfade;
    for (let voice = 0; voice < padVoiceCount; voice += 1) {
      const phaseL = padPhaseL[voice];
      const phaseR = padPhaseR[voice];
      padPhaseL[voice] = advancePhase(phaseL, padIncrementL[voice]);
      padPhaseR[voice] = advancePhase(phaseR, padIncrementR[voice]);
      let toneL =
        tableSine(phaseL) * (0.68 - profile.bright * 0.06) +
        tableHarmonic(phaseL, 2) * 0.2 +
        tableHarmonic(phaseL, 3) * 0.1 +
        tableHarmonic(phaseL, 5) * 0.045 +
        tableHarmonic(phaseL, 7) * (0.018 + profile.bright * 0.018);
      let toneR =
        tableSine(phaseR) * (0.68 - profile.bright * 0.06) +
        tableHarmonic(phaseR, 2) * 0.2 +
        tableHarmonic(phaseR, 3) * 0.1 +
        tableHarmonic(phaseR, 5) * 0.045 +
        tableHarmonic(phaseR, 7) * (0.018 + profile.bright * 0.018);
      if (previousPadGain > 0) {
        const previousPhaseL = previousPadPhaseL[voice];
        const previousPhaseR = previousPadPhaseR[voice];
        const previousToneL =
          tableSine(previousPhaseL) * (0.68 - profile.bright * 0.06) +
          tableHarmonic(previousPhaseL, 2) * 0.2 +
          tableHarmonic(previousPhaseL, 3) * 0.1 +
          tableHarmonic(previousPhaseL, 5) * 0.045 +
          tableHarmonic(previousPhaseL, 7) * (0.018 + profile.bright * 0.018);
        const previousToneR =
          tableSine(previousPhaseR) * (0.68 - profile.bright * 0.06) +
          tableHarmonic(previousPhaseR, 2) * 0.2 +
          tableHarmonic(previousPhaseR, 3) * 0.1 +
          tableHarmonic(previousPhaseR, 5) * 0.045 +
          tableHarmonic(previousPhaseR, 7) * (0.018 + profile.bright * 0.018);
        toneL = previousToneL * previousPadGain + toneL * padCrossfade;
        toneR = previousToneR * previousPadGain + toneR * padCrossfade;
        previousPadPhaseL[voice] = advancePhase(
          previousPhaseL,
          previousPadIncrementL[voice],
        );
        previousPadPhaseR[voice] = advancePhase(
          previousPhaseR,
          previousPadIncrementR[voice],
        );
      }
      const padLevel = (0.055 + level * 0.055) * pulse;
      left += toneL * padPanL[voice] * padLevel;
      right += toneR * padPanR[voice] * padLevel;
    }
    if (padCrossfadeSample < padCrossfadeSamples) {
      padCrossfadeSample += 1;
    }

    if (bassAge >= 0) {
      const envelope =
        Math.exp(-bassAge * (5.4 + (1 - profile.bass) * 2.3)) *
        (1 - Math.exp(-bassAge * 75));
      const tone =
        tableSine(bassPhase) * 0.88 + tableHarmonic(bassPhase, 2) * 0.12;
      const bassLevel = (0.15 + level * 0.095) * profile.bass * envelope;
      // Deliberately identical center signal for mono-safe sub and bass.
      left += tone * bassLevel;
      right += tone * bassLevel;
      bassPhase = advancePhase(bassPhase, bassIncrement);
      bassAge += 1 / SAMPLE_RATE;
      if (bassAge > 0.72) bassAge = -1;
    }

    for (let voice = 0; voice < pluckCount; voice += 1) {
      if (pluckAge[voice] < 0) continue;
      const age = pluckAge[voice];
      const attack = 1 - Math.exp(-age * 260);
      const envelope =
        attack * Math.exp(-age * (5.6 + (1 - profile.arp) * 3.8));
      const phaseL = pluckPhaseL[voice];
      const phaseR = pluckPhaseR[voice];
      const toneL =
        tableSine(phaseL) * 0.48 +
        tableHarmonic(phaseL, 2) * 0.22 +
        tableHarmonic(phaseL, 3) * 0.14 +
        tableHarmonic(phaseL, 5) * 0.09 +
        tableHarmonic(phaseL, 7) * 0.07;
      const toneR =
        tableSine(phaseR) * 0.48 +
        tableHarmonic(phaseR, 2) * 0.22 +
        tableHarmonic(phaseR, 3) * 0.14 +
        tableHarmonic(phaseR, 5) * 0.09 +
        tableHarmonic(phaseR, 7) * 0.07;
      const pluckLevel =
        (0.052 + level * 0.044) *
        profile.arp *
        (0.88 + profile.bright * 0.2) *
        envelope;
      left += toneL * pluckPanL[voice] * pluckLevel;
      right += toneR * pluckPanR[voice] * pluckLevel;
      pluckPhaseL[voice] = advancePhase(phaseL, pluckIncrementL[voice]);
      pluckPhaseR[voice] = advancePhase(phaseR, pluckIncrementR[voice]);
      pluckAge[voice] += 1 / SAMPLE_RATE;
      if (pluckAge[voice] > 0.82) pluckAge[voice] = -1;
    }

    for (let voice = 0; voice < melodyCount; voice += 1) {
      if (melodyAge[voice] < 0) continue;
      const age = melodyAge[voice];
      const attack = 1 - Math.exp(-age * 300);
      const envelope =
        attack *
        Math.exp(-age * (3.2 + (1 - profile.motif) * 2.2) * melodyDecay[voice]);
      const phaseL = melodyPhaseL[voice];
      const phaseR = melodyPhaseR[voice];
      const toneL =
        tableSine(phaseL) * 0.46 +
        tableHarmonic(phaseL, 2) * 0.2 +
        tableHarmonic(phaseL, 3) * 0.14 +
        tableHarmonic(phaseL, 4) * 0.08 +
        tableHarmonic(phaseL, 6) * 0.06 +
        tableHarmonic(phaseL, 8) * 0.04;
      const toneR =
        tableSine(phaseR) * 0.46 +
        tableHarmonic(phaseR, 2) * 0.2 +
        tableHarmonic(phaseR, 3) * 0.14 +
        tableHarmonic(phaseR, 4) * 0.08 +
        tableHarmonic(phaseR, 6) * 0.06 +
        tableHarmonic(phaseR, 8) * 0.04;
      const melodyLevel =
        (0.045 + level * 0.062) *
        profile.motif *
        (0.86 + profile.bright * 0.24) *
        melodyVelocity[voice] *
        envelope;
      left += toneL * melodyPanL[voice] * melodyLevel;
      right += toneR * melodyPanR[voice] * melodyLevel;
      melodyPhaseL[voice] = advancePhase(phaseL, melodyIncrementL[voice]);
      melodyPhaseR[voice] = advancePhase(phaseR, melodyIncrementR[voice]);
      melodyAge[voice] += 1 / SAMPLE_RATE;
      if (melodyAge[voice] > 1.25) melodyAge[voice] = -1;
    }

    // Continuous high-register sheen gives the full chapters a deliberate
    // 4–12 kHz lift without turning the air bed into broadband hiss. It is
    // gated by the chapter motif value, so the opening and product pullback
    // remain spacious.
    const shimmerFrequency =
      6_200 +
      520 * tableSine(sampleIndex / (SAMPLE_RATE * 4.7) + sceneIndex * 0.21);
    const shimmerCarrier = tableSine(shimmerCarrierPhase);
    const shimmerRightCarrier = tableSine(shimmerCarrierPhase + 0.006);
    const shimmerUpper = tableSine(shimmerUpperPhase);
    const shimmerAir = tableSine(shimmerAirPhase);
    shimmerCarrierPhase = advancePhase(
      shimmerCarrierPhase,
      shimmerFrequency / SAMPLE_RATE,
    );
    shimmerUpperPhase = advancePhase(
      shimmerUpperPhase,
      (shimmerFrequency * 1.47) / SAMPLE_RATE,
    );
    shimmerAirPhase = advancePhase(
      shimmerAirPhase,
      (shimmerFrequency * 1.91) / SAMPLE_RATE,
    );
    if (profile.motif > 0.28) {
      const shimmerTone =
        shimmerCarrier * 0.68 + shimmerUpper * 0.24 + shimmerAir * 0.1;
      const shimmerLevel =
        (0.003 + level * 0.011) * profile.motif * profile.bright;
      left += shimmerTone * shimmerLevel * 0.48;
      right +=
        (shimmerRightCarrier * 0.72 + shimmerUpper * 0.2 + shimmerAir * 0.08) *
        shimmerLevel *
        0.64;
    }

    if (kickAge >= 0) {
      const envelope = Math.exp(-kickAge * 9.6);
      const frequency = 48 + 142 * Math.exp(-kickAge * 20);
      const tone = tableSine(kickPhase) * envelope;
      const click =
        kickAge < 0.018
          ? (tableSine(kickAge * 2_400) * 0.7 +
              tableSine(kickAge * 5_100) * 0.3) *
            (1 - kickAge / 0.018)
          : 0;
      const kickLevel =
        (0.22 + level * 0.1) * profile.drums * tone + click * 0.08;
      left += kickLevel;
      right += kickLevel;
      kickPhase = advancePhase(kickPhase, frequency / SAMPLE_RATE);
      kickAge += 1 / SAMPLE_RATE;
      if (kickAge > 0.6) kickAge = -1;
    }

    if (snareAge >= 0) {
      const envelope = Math.exp(-snareAge * 25);
      const rawSnareNoise = noise() * 0.72 + noise() * 0.28;
      snareNoiseState += (rawSnareNoise - snareNoiseState) * 0.34;
      const snareNoise = snareNoiseState;
      const body = tableSine(snareAge * 205) * 0.22;
      const snareLevel = (0.055 + level * 0.032) * profile.drums * envelope;
      left += (snareNoise + body) * snareLevel * 0.82;
      right += (snareNoise + body) * snareLevel * 0.88;
      snareAge += 1 / SAMPLE_RATE;
      if (snareAge > 0.24) snareAge = -1;
    }

    if (clapAge >= 0) {
      const envelope = Math.exp(-clapAge * 35);
      const rawClap = noise() * 0.76 + noise() * 0.24;
      clapNoiseState += (rawClap - clapNoiseState) * 0.28;
      const clap = clapNoiseState;
      const clapLevel = (0.035 + level * 0.018) * profile.drums * envelope;
      left += clap * clapLevel * 0.74;
      right += clap * clapLevel * 0.78;
      clapAge += 1 / SAMPLE_RATE;
      if (clapAge > 0.16) clapAge = -1;
    }

    if (hatAge >= 0) {
      const decay = hatOpen ? 14 : 25;
      const envelope = Math.exp(-hatAge * decay);
      const currentNoise = noise();
      const highPassedNoise = currentNoise - hatPrevNoise * 0.9;
      hatPrevNoise = currentNoise;
      const hatLevel = (hatOpen ? 0.024 : 0.015) * profile.drums * envelope;
      left += highPassedNoise * hatLevel * 0.6;
      right += highPassedNoise * hatLevel * 0.72;
      hatAge += 1 / SAMPLE_RATE;
      if (hatAge > (hatOpen ? 0.34 : 0.15)) hatAge = -1;
    }

    if (shakerAge >= 0) {
      const envelope = Math.exp(-shakerAge * 32);
      const currentNoise = noise();
      const highPassedNoise = currentNoise - shakerPrevNoise * 0.94;
      shakerPrevNoise = currentNoise;
      const shakerLevel = 0.008 * profile.drums * envelope;
      left += highPassedNoise * shakerLevel * 0.66;
      right += highPassedNoise * shakerLevel * 0.72;
      shakerAge += 1 / SAMPLE_RATE;
      if (shakerAge > 0.11) shakerAge = -1;
    }

    if (tomAge >= 0) {
      const envelope = Math.exp(-tomAge * 8.5) * (1 - Math.exp(-tomAge * 80));
      const tone = tableSine(tomPhase) * envelope;
      const tomLevel = (0.11 + level * 0.035) * profile.drums;
      left += tone * tomLevel;
      right += tone * tomLevel;
      tomPhase = advancePhase(tomPhase, tomFrequency / SAMPLE_RATE);
      tomAge += 1 / SAMPLE_RATE;
      if (tomAge > 0.44) tomAge = -1;
    }

    // A low, intentionally mono-safe noise floor plus a quiet high shelf keep
    // the synthesized bed from sounding digitally airless.
    const air = noise() * 0.0008 * (0.35 + level * 0.65);
    left += air * 0.66;
    right += air * 0.7;

    // Product → human reveal: pull the mechanical bed down for a breath, then
    // let a warm Dm9-family motif bloom before the next chapter's riser. The
    // release ends before the next named-scene impact so the handoff stays clear.
    const humanAge = (sampleIndex - HUMAN_REVEAL_START) / SAMPLE_RATE;
    if (humanAge >= 0 && sampleIndex < HUMAN_REVEAL_END) {
      const drop = smoothstep(humanAge / 1.1);
      const returnToBed = smoothstep((humanAge - 1.7) / 1.25);
      const duck = 1 - drop * (1 - returnToBed) * 0.66;
      left *= duck;
      right *= duck;

      const motifAttack = smoothstep((humanAge - 1.0) / 1.25);
      const motifTail = 1 - smoothstep((humanAge - 5.15) / 1.15);
      const motifEnvelope = motifAttack * motifTail;
      for (let note = 0; note < HUMAN_REVEAL_NOTES.length; note += 1) {
        const noteAge = humanAge - HUMAN_REVEAL_ONSETS[note];
        if (noteAge < 0) continue;
        const attack = 1 - Math.exp(-noteAge * 3.5);
        const release = Math.exp(-noteAge * 0.34);
        const phase = noteAge * midiToFrequency(HUMAN_REVEAL_NOTES[note]);
        const warmTone =
          tableSine(phase) * 0.68 +
          tableHarmonic(phase, 2) * 0.2 +
          tableHarmonic(phase, 3) * 0.08 +
          tableHarmonic(phase, 4) * 0.04;
        const noteLevel =
          (0.025 + level * 0.025) * motifEnvelope * attack * release;
        const pan = (note - 2) * 0.08;
        const [panL, panR] = equalPowerPan(pan);
        left += warmTone * noteLevel * panL;
        right += warmTone * noteLevel * panR;
      }

      // A slow root swell gives the drop a human warmth without a literal
      // crowd/voice effect or a new noisy transient layer.
      const swellAge = humanAge - 0.72;
      if (swellAge > 0) {
        const swellEnvelope = smoothstep(swellAge / 1.7) * motifTail;
        const swellPhase = swellAge * midiToFrequency(50);
        const swellTone =
          tableSine(swellPhase) * 0.72 +
          tableHarmonic(swellPhase, 2) * 0.18 +
          tableHarmonic(swellPhase, 3) * 0.1;
        const swellLevel = (0.028 + level * 0.018) * swellEnvelope;
        left += swellTone * swellLevel * 0.74;
        right += swellTone * swellLevel * 0.74;
      }
    }

    if (activeAccent) {
      const accentAge = sampleIndex - activeAccent.start;
      const impactAge = sampleIndex - activeAccent.impact;
      const impactAt = activeAccent.impact - activeAccent.start;
      if (accentAge < impactAt) {
        const rise = smoothstep(accentAge / Math.max(1, impactAt));
        const ageSeconds = accentAge / SAMPLE_RATE;
        const isVacuum = activeAccent.style === "vacuum";
        const isPickup = activeAccent.style === "pickup";
        const isSignal = activeAccent.style === "signal";
        const isSoft = activeAccent.style === "soft";
        const preDuck = isVacuum ? 1 - rise * 0.32 : 1 - rise * 0.08;
        left *= preDuck;
        right *= preDuck;
        const currentNoise = noise();
        const riserNoise = currentNoise - noise() * 0.86;
        const riseFreq =
          (isSignal ? 720 : 390) +
          rise * rise * (isSignal ? 6_200 : isSoft ? 2_700 : 4_800);
        const riserPhase = (accentAge / SAMPLE_RATE) * riseFreq;
        const riserTone =
          tableSine(riserPhase) * 0.58 +
          tableSine(riserPhase * 1.51) * 0.24 +
          tableSine(riserPhase * 2.03) * 0.12;
        // Hand the riser to the impact with a tiny pre-cut tail fade. Without
        // this, a high-valued noise sample on the final riser frame can make a
        // mathematically sharp step when the impact branch takes over.
        const riserTail =
          1 -
          smoothstep(
            (accentAge - (impactAt - 0.012 * SAMPLE_RATE)) /
              (0.012 * SAMPLE_RATE),
          );
        const pickupPulse = isPickup
          ? 0.68 + 0.32 * Math.max(0, tableSine(ageSeconds * 8))
          : 1;
        const riserLevel =
          rise *
          rise *
          (0.014 + level * 0.028) *
          riserTail *
          activeAccent.intensity *
          pickupPulse;
        const noiseWeight = isSoft ? 0.1 : isSignal ? 0.18 : 0.28;
        left +=
          (riserNoise * noiseWeight + riserTone) *
          riserLevel *
          (isSignal ? 0.68 : 0.82);
        right +=
          (riserNoise * noiseWeight + riserTone * (isSignal ? 1.14 : 1.04)) *
          riserLevel *
          0.84;
      } else if (impactAge >= 0) {
        const age = impactAge / SAMPLE_RATE;
        const impactAttack = 1 - Math.exp(-age * 3_000);
        const isBloom =
          activeAccent.style === "bloom" ||
          activeAccent.style === "spark" ||
          activeAccent.style === "dissolve";
        const isHero = activeAccent.style === "hero";
        const isSoft = activeAccent.style === "soft";
        const isSignal = activeAccent.style === "signal";
        const envelope = Math.exp(-age * (isBloom ? 4.1 : isSoft ? 6.8 : 5.4));
        const lowCycles = 42 * age + (104 * (1 - Math.exp(-age * 6))) / 6;
        const impactTone = tableSine(lowCycles) * envelope;
        const impactNoise = noise() * impactAttack * Math.exp(-age * 34);
        const sparkle =
          tableSine(age * 2_300 + activeAccent.index * 0.07) *
            Math.exp(-age * 5.4) +
          tableSine(age * 4_700 + activeAccent.index * 0.11) *
            Math.exp(-age * 7.2) *
            0.58 +
          tableSine(age * 7_600 + activeAccent.index * 0.15) *
            Math.exp(-age * 10.5) *
            0.3;
        const impactLevel = (0.13 + level * 0.115) * activeAccent.intensity;
        const subWeight = isBloom
          ? 0.48
          : isSoft
            ? 0.38
            : isSignal
              ? 0.58
              : isHero
                ? 1.08
                : 0.88;
        const sparkleWeight = isBloom
          ? 0.3
          : isSignal
            ? 0.24
            : isHero
              ? 0.23
              : 0.16;
        const impact =
          (impactTone * subWeight + impactNoise * (isSoft ? 0.1 : 0.2)) *
          impactLevel;
        // Centered boom + restrained stereo sparkle; do not sacrifice the cut
        // on a mono phone speaker.
        left += impact + sparkle * impactLevel * sparkleWeight;
        right += impact + sparkle * impactLevel * sparkleWeight * 1.12;
        if (age < 0.022) {
          const clickAttack = 1 - Math.exp(-age * 5_000);
          const uiClickTone =
            tableSine(age * 3_300 + activeAccent.index * 0.13) * 0.7 +
            tableSine(age * 6_900 + activeAccent.index * 0.07) * 0.3;
          const uiClick =
            uiClickTone *
            clickAttack *
            (1 - age / 0.022) *
            (0.075 + level * 0.038) *
            (isSoft ? 0.5 : activeAccent.intensity);
          left += uiClick * 0.7;
          right += uiClick * 0.74;
        }
      }
    }

    // Bespoke harmonic handoff at the Communicate cut. The generic chapter
    // impact remains underneath; this short Fmaj9 lift makes 214 s feel like
    // a deliberate emotional transition rather than another loop boundary.
    const communicateAge = (sampleIndex - COMMUNICATE_START) / SAMPLE_RATE;
    if (communicateAge >= 0 && communicateAge < 1.65) {
      for (let note = 0; note < COMMUNICATE_NOTES.length; note += 1) {
        const noteAge = communicateAge - note * 0.085;
        if (noteAge < 0) continue;
        const attack = 1 - Math.exp(-noteAge * 260);
        const release = Math.exp(-noteAge * 2.8);
        const phase = noteAge * midiToFrequency(COMMUNICATE_NOTES[note]);
        const tone =
          tableSine(phase) * 0.62 +
          tableHarmonic(phase, 2) * 0.22 +
          tableHarmonic(phase, 3) * 0.1 +
          tableHarmonic(phase, 5) * 0.06;
        const levelLift = (0.022 + level * 0.018) * attack * release;
        left += tone * levelLift * 0.74;
        right += tone * levelLift * 0.78;
      }
    }

    // Restrained, exact-frame tonal cues give the major in-scene product
    // transitions a subconscious focus/confirmation signal. Their oscillators
    // are stateless and zero-attack, so they neither disturb the deterministic
    // noise stream nor introduce a discontinuity at the edit.
    if (activeHeroCue) {
      const cueAge = (sampleIndex - activeHeroCue.start) / SAMPLE_RATE;
      const cueDecay = 4 / activeHeroCue.duration;
      const cueAttack = 1 - Math.exp(-cueAge * 320);
      const cueEnvelope = cueAttack * Math.exp(-cueAge * cueDecay);
      const cueFrequency = midiToFrequency(activeHeroCue.midi);
      const cuePhase = cueAge * cueFrequency;
      const cueTone =
        tableSine(cuePhase) * 0.72 +
        tableSine(cuePhase * 2) * 0.2 +
        tableSine(cuePhase * 3) * 0.08;

      const answerAge = cueAge - 0.065;
      let answerTone = 0;
      if (answerAge > 0) {
        const answerAttack = 1 - Math.exp(-answerAge * 280);
        const answerEnvelope =
          answerAttack * Math.exp(-answerAge * cueDecay * 1.08);
        const answerFrequency = midiToFrequency(
          activeHeroCue.midi + activeHeroCue.interval,
        );
        const answerPhase = answerAge * answerFrequency;
        answerTone =
          (tableSine(answerPhase) * 0.76 +
            tableSine(answerPhase * 2) * 0.18 +
            tableSine(answerPhase * 4) * 0.06) *
          answerEnvelope;
      }

      const transientAttack = 1 - Math.exp(-cueAge * 1_400);
      const transient =
        (tableSine(cueAge * 2_300) * 0.68 + tableSine(cueAge * 4_900) * 0.32) *
        transientAttack *
        Math.exp(-cueAge * 64);
      const cueLevel = 0.036 * activeHeroCue.intensity;
      const cueSignal =
        cueTone * cueEnvelope + answerTone * 0.82 + transient * 0.12;
      left += cueSignal * cueLevel * 0.72;
      right += cueSignal * cueLevel * 0.8;
    }

    // Final brand sting: D–F–A–E–D, resolving the recurring identity cleanly.
    if (sampleIndex >= finalStingStart) {
      const age = (sampleIndex - finalStingStart) / SAMPLE_RATE;
      for (let note = 0; note < finalStingNotes.length; note += 1) {
        const noteAge = age - note * 0.13;
        if (noteAge < 0) continue;
        const attack = 1 - Math.exp(-noteAge * 220);
        const envelope = attack * Math.exp(-noteAge * 1.8);
        const phase = noteAge * midiToFrequency(finalStingNotes[note]);
        const tone =
          tableSine(phase) * 0.58 +
          tableSine(phase * 2) * 0.2 +
          tableSine(phase * 3) * 0.12 +
          tableSine(phase * 6) * 0.06;
        const stingLevel = 0.12 * envelope;
        left += tone * stingLevel;
        right += tone * stingLevel;
      }
      const finalAir = noise() * Math.exp(-age * 1.7) * 0.004;
      left += finalAir * 0.7;
      right += finalAir * 0.74;
    }

    // Tempo-related, cross-fed ambience: 5/8 and 7/8 of a beat at 120 BPM.
    // A lightweight high-pass keeps kick and sub centered/dry; the positive
    // polarity wet path adds real width without relying on phase inversion.
    const ambienceReadL =
      (delayWrite - delaySamplesL + delayLength) % delayLength;
    const ambienceReadR =
      (delayWrite - delaySamplesR + delayLength) % delayLength;
    const delayedL = ambienceL[ambienceReadL];
    const delayedR = ambienceR[ambienceReadR];
    ambienceFilterL += (delayedL - ambienceFilterL) * 0.16;
    ambienceFilterR += (delayedR - ambienceFilterR) * 0.16;
    ambienceInputLowL += (left - ambienceInputLowL) * 0.009;
    ambienceInputLowR += (right - ambienceInputLowR) * 0.009;
    const ambienceInputL = left - ambienceInputLowL * 0.92;
    const ambienceInputR = right - ambienceInputLowR * 0.92;
    ambienceL[delayWrite] = ambienceInputL * 0.17 + ambienceFilterR * 0.3;
    ambienceR[delayWrite] = ambienceInputR * 0.17 + ambienceFilterL * 0.3;
    delayWrite += 1;
    if (delayWrite >= delayLength) delayWrite = 0;

    const ambienceLevel =
      (0.075 + profile.space * 0.105) * (0.74 + profile.bright * 0.26);
    left += (ambienceFilterL * 0.9 + ambienceFilterR * 0.14) * ambienceLevel;
    right += (ambienceFilterR * 0.9 + ambienceFilterL * 0.14) * ambienceLevel;

    // Widen only information that is already different between channels;
    // mid content (including the bass and primary impact) stays untouched.
    const mid = (left + right) * 0.5;
    const side = (left - right) * 0.5 * (1.04 + profile.bright * 0.13);
    left = mid + side;
    right = mid - side;

    // A short source-owned fade keeps the WAV safe when consumed without
    // Remotion. LaunchFilm now leaves the mastered file at unity volume.
    const fadeIn = smoothstep(sampleIndex / (SAMPLE_RATE * 2.2));
    const fadeOut = smoothstep(
      (TOTAL_FRAMES - sampleIndex) / (SAMPLE_RATE * 2.8),
    );
    const master = fadeIn * fadeOut;
    const compressedLeft = compressBusSample(left * master);
    const compressedRight = compressBusSample(right * master);
    // Procedural noise can create a one-sample spike even when its envelope
    // is musical. Keep an intentionally generous slew ceiling so those spikes
    // cannot become audible digital clicks while preserving real transients.
    const maxSampleStep = 0.06;
    left =
      previousOutputL +
      Math.max(
        -maxSampleStep,
        Math.min(maxSampleStep, compressedLeft - previousOutputL),
      );
    right =
      previousOutputR +
      Math.max(
        -maxSampleStep,
        Math.min(maxSampleStep, compressedRight - previousOutputR),
      );
    previousOutputL = left;
    previousOutputR = right;
    const absolutePeak = Math.max(Math.abs(left), Math.abs(right));
    if (absolutePeak > peak) peak = absolutePeak;
    sumSquares += left * left + right * right;
    renderedSamples += 2;

    return [left, right];
  };

  const accentEvents = createAccentEvents();
  return {
    nextSample,
    getStats: () => ({
      peak,
      rms: Math.sqrt(sumSquares / Math.max(1, renderedSamples)),
    }),
  };
}

async function writeChunk(file, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await file.write(
      chunk,
      offset,
      chunk.length - offset,
      null,
    );
    if (bytesWritten < 1) {
      throw new Error("Score staging write made no progress.");
    }
    offset += bytesWritten;
  }
}

function estimateGain() {
  const synth = createSynth();
  let sumSquares = 0;
  let peak = 0;
  for (let sampleIndex = 0; sampleIndex < TOTAL_FRAMES; sampleIndex += 1) {
    const [left, right] = synth.nextSample(sampleIndex);
    sumSquares += left * left + right * right;
    peak = Math.max(peak, Math.abs(left), Math.abs(right));
  }
  const rms = Math.sqrt(sumSquares / (TOTAL_FRAMES * CHANNELS));
  const targetRms = 10 ** (TARGET_RMS_DBFS / 20);
  const targetPeak = 10 ** (MAX_SAMPLE_PEAK_DBFS / 20);
  const rmsGain = targetRms / Math.max(rms, Number.EPSILON);
  const peakGain = targetPeak / Math.max(peak, Number.EPSILON);
  return {
    gain: Math.min(rmsGain, peakGain),
    rms,
    peak,
    rmsGain,
    peakGain,
  };
}

async function main() {
  if (process.argv.length !== 2) {
    throw new Error("Usage: npm run video:score:procedural");
  }
  await fs.promises.mkdir(outputDirectory, { recursive: true });
  await removeAbandonedTemporaryOutputs();
  const temporaryOutputPath = makeTemporaryOutputPath();
  const normalization = estimateGain();
  const synth = createSynth();
  const uninstallSignalCleanup = installSignalCleanup(temporaryOutputPath);
  let outputHandle;
  try {
    outputHandle = await fs.promises.open(temporaryOutputPath, "wx", 0o644);
    await writeChunk(outputHandle, makeWavHeader(DATA_BYTES));
    for (
      let chunkStart = 0;
      chunkStart < TOTAL_FRAMES;
      chunkStart += FRAMES_PER_CHUNK
    ) {
      const framesInChunk = Math.min(
        FRAMES_PER_CHUNK,
        TOTAL_FRAMES - chunkStart,
      );
      const pcmChunk = Buffer.allocUnsafe(framesInChunk * BYTES_PER_FRAME);
      for (let frame = 0; frame < framesInChunk; frame += 1) {
        const [left, right] = synth.nextSample(chunkStart + frame);
        const offset = frame * BYTES_PER_FRAME;
        const safeLeft = Math.max(
          -0.985,
          Math.min(0.985, left * normalization.gain),
        );
        const safeRight = Math.max(
          -0.985,
          Math.min(0.985, right * normalization.gain),
        );
        pcmChunk.writeInt16LE(Math.round(safeLeft * 32767), offset);
        pcmChunk.writeInt16LE(Math.round(safeRight * 32767), offset + 2);
      }
      await writeChunk(outputHandle, pcmChunk);
    }
    await outputHandle.sync();
    await outputHandle.close();
    outputHandle = undefined;
    if (
      sha256File(timelinePath) !== PICTURE_LOCK.sha256 ||
      sha256File(generatorPath) !== generatorSha256 ||
      sha256File(dspPath) !== dspSha256
    ) {
      throw new Error(
        "Score inputs changed during generation; the stale staging file was not installed.",
      );
    }
    await fs.promises.rename(temporaryOutputPath, OUTPUT_PATH);
  } finally {
    await outputHandle?.close().catch(() => undefined);
    try {
      await fs.promises.rm(temporaryOutputPath, { force: true });
    } finally {
      uninstallSignalCleanup();
    }
  }

  const stats = synth.getStats();
  console.log(
    `Generated ${path.relative(repoRoot, OUTPUT_PATH)} — ${TOTAL_SECONDS}s, ${SAMPLE_RATE} Hz stereo PCM16; ` +
      `pre-gain RMS ${db(normalization.rms).toFixed(1)} dBFS, ` +
      `gain ${db(normalization.gain).toFixed(1)} dB, ` +
      `estimated RMS ${db(normalization.rms * normalization.gain).toFixed(1)} dBFS, ` +
      `estimated peak ${db(normalization.peak * normalization.gain).toFixed(1)} dBFS; ` +
      `rendered peak ${db(stats.peak * normalization.gain).toFixed(1)} dBFS`,
  );
}

await main();
