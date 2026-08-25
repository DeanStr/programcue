import rawTimeline from "./timeline.json";

type TimelineScene = Readonly<{
  key: string;
  durationInFrames: number;
}>;

type Timeline = Readonly<{
  fps: number;
  width: number;
  height: number;
  scenes: readonly TimelineScene[];
}>;

const failTimeline = (message: string): never => {
  throw new Error(`Invalid video/timeline.json: ${message}`);
};

const readTimeline = (value: unknown): Timeline => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return failTimeline("the root must be an object.");
  }

  const record = value as Record<string, unknown>;
  const allowedKeys = new Set(["fps", "width", "height", "scenes"]);
  const unknownKeys = Object.keys(record).filter(
    (key) => !allowedKeys.has(key),
  );
  if (
    unknownKeys.length > 0 ||
    Object.keys(record).length !== allowedKeys.size
  ) {
    return failTimeline(
      `expected only fps, width, height and scenes${
        unknownKeys.length > 0 ? `; found ${unknownKeys.join(", ")}` : ""
      }.`,
    );
  }

  for (const field of ["fps", "width", "height"] as const) {
    if (!Number.isInteger(record[field]) || Number(record[field]) < 1) {
      return failTimeline(`${field} must be a positive integer.`);
    }
  }
  if (!Array.isArray(record.scenes)) {
    return failTimeline("scenes must be an array.");
  }

  const sceneKeys = new Set<string>();
  const scenes = record.scenes.map((value, index): TimelineScene => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return failTimeline(`scenes[${index}] must be an object.`);
    }
    const scene = value as Record<string, unknown>;
    const keys = Object.keys(scene);
    if (
      keys.length !== 2 ||
      !Object.hasOwn(scene, "key") ||
      !Object.hasOwn(scene, "durationInFrames")
    ) {
      return failTimeline(
        `scenes[${index}] must contain only key and durationInFrames.`,
      );
    }
    if (typeof scene.key !== "string" || !/^[a-z][a-z0-9]*$/u.test(scene.key)) {
      return failTimeline(`scenes[${index}].key is invalid.`);
    }
    if (sceneKeys.has(scene.key)) {
      return failTimeline(`scene key ${scene.key} is duplicated.`);
    }
    if (
      !Number.isInteger(scene.durationInFrames) ||
      Number(scene.durationInFrames) < 1
    ) {
      return failTimeline(
        `scenes[${index}].durationInFrames must be a positive integer.`,
      );
    }
    sceneKeys.add(scene.key);
    return Object.freeze({
      key: scene.key,
      durationInFrames: Number(scene.durationInFrames),
    });
  });

  const timeline = Object.freeze({
    fps: Number(record.fps),
    width: Number(record.width),
    height: Number(record.height),
    scenes: Object.freeze(scenes),
  });
  const totalFrames = timeline.scenes.reduce(
    (total, scene) => total + scene.durationInFrames,
    0,
  );
  if (
    timeline.fps !== 30 ||
    timeline.width !== 1920 ||
    timeline.height !== 1080 ||
    timeline.scenes.length !== 13 ||
    totalFrames !== 10_800
  ) {
    return failTimeline(
      "the launch-film picture lock must remain 1920x1080, 30 fps, 13 scenes and 10800 frames.",
    );
  }

  return timeline;
};

const TIMELINE = readTimeline(rawTimeline);

export const VIDEO = Object.freeze({
  fps: TIMELINE.fps,
  width: TIMELINE.width,
  height: TIMELINE.height,
});

export const SCENE_KEYS = Object.freeze(
  TIMELINE.scenes.map((scene) => scene.key),
);

export const SCENE_DURATIONS: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(
    TIMELINE.scenes.map((scene) => [scene.key, scene.durationInFrames]),
  ),
);

export const TOTAL_FRAMES = TIMELINE.scenes.reduce(
  (total, scene) => total + scene.durationInFrames,
  0,
);

export const PALETTE = {
  ink: "#182522",
  inkDeep: "#0b1413",
  nav: "#13201f",
  navRaised: "#1b2e2b",
  paper: "#fffdf8",
  canvas: "#f4f4ef",
  editorial: "#f7f5f1",
  copper: "#be6242",
  copperDeep: "#783220",
  copperSoft: "#f6c5a9",
  sage: "#8fbf9a",
  sageDeep: "#3a5f42",
  gold: "#d4a72c",
  line: "#e0e1d8",
  muted: "#61716c",
  white: "#ffffff",
  bad: "#dc2626",
} as const;

export const FILM_TITLE =
  "Program Cue — From first proposal to published programme";
