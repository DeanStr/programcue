#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "../..");
const artifactsDirectory = path.join(repoRoot, ".artifacts");
const entryPoint = path.join(repoRoot, "video", "index.ts");
const timelinePath = path.join(repoRoot, "video", "timeline.json");
const reviewDirectory = path.join(artifactsDirectory, "video-review");
const remotionBinary = path.join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "remotion.cmd" : "remotion",
);
const ffmpegBinary = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";

const sceneFocus = {
  opening: "the problem / cold open",
  reveal: "the Program Cue reveal",
  command: "the command centre",
  setup: "event setup and form building",
  collect: "collecting applications",
  decide: "review and decision workbench",
  prepare: "speaker readiness and production prep",
  assist: "evidence-backed assistant and approval",
  communicate: "communications and follow-up",
  place: "schedule placement and conflict handling",
  publish: "publishing the public program",
  operate: "durable operations and provider boundaries",
  closing: "the final promise / close",
};

const fail = (message, details = "") => {
  const suffix = details ? `\n${details.trimEnd()}` : "";
  throw new Error(`[video:frames] ${message}${suffix}`);
};

const isContained = (parent, candidate) => {
  const relative = path.relative(parent, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
};

const assertContained = (parent, candidate, label) => {
  if (!isContained(parent, candidate)) {
    fail(`${label} escapes ${path.relative(repoRoot, parent) || "."}.`);
  }
};

const run = (command, args, options = {}) =>
  spawnSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  });

const readTimeline = () => {
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
      "Canonical timeline is not valid JSON.",
      error instanceof Error ? error.message : String(error),
    );
  }

  for (const field of ["fps", "width", "height"]) {
    if (!Number.isInteger(timeline?.[field]) || timeline[field] <= 0) {
      fail(`Canonical timeline ${field} must be a positive integer.`);
    }
  }
  if (!Array.isArray(timeline.scenes) || timeline.scenes.length === 0) {
    fail("Canonical timeline must contain at least one scene.");
  }
  const keys = new Set();
  const scenes = timeline.scenes.map((scene, index) => {
    if (
      typeof scene?.key !== "string" ||
      !/^[a-z][a-z0-9-]*$/.test(scene.key)
    ) {
      fail(`Timeline scene ${index + 1} has an invalid key.`);
    }
    if (keys.has(scene.key))
      fail(`Timeline scene key is duplicated: ${scene.key}`);
    keys.add(scene.key);
    if (
      !Number.isInteger(scene.durationInFrames) ||
      scene.durationInFrames <= 0
    ) {
      fail(`Timeline scene ${scene.key} has an invalid durationInFrames.`);
    }
    return {
      key: scene.key,
      durationInFrames: scene.durationInFrames,
      focus: sceneFocus[scene.key] ?? scene.key,
    };
  });
  const totalFrames = scenes.reduce(
    (total, scene) => total + scene.durationInFrames,
    0,
  );
  return {
    fps: timeline.fps,
    width: timeline.width,
    height: timeline.height,
    scenes,
    totalFrames,
  };
};

const canariesForScene = (scene) => {
  const duration = scene.durationInFrames;
  if (scene.key === "opening") {
    return [
      [90, "human cold open"],
      [150, "human-to-product transition"],
      [300, "product promise"],
      [420, "current readiness picture"],
    ];
  }
  if (scene.key === "command") {
    return [
      [110, "command centre establish"],
      [230, "readiness and critical condition"],
      [430, "ranked action click"],
      [480, "action response"],
      [644, "ranked next-action payoff"],
      [660, "payoff exit keeps the previous screen covered"],
    ];
  }
  if (scene.key === "assist") {
    return [
      [75, "current readiness and navigation"],
      [356, "speaker-scoped handbook evidence"],
      [526, "exact reminder preview"],
      [638, "human approval"],
      [713, "durable queue and provider boundary"],
      [798, "operation audit"],
      [870, "AI feedback prompt"],
      [939, "AI feedback selection"],
      [1000, "AI feedback recorded"],
    ];
  }
  if (scene.key === "decide") {
    return [
      [150, "review context"],
      [360, "weighted rubric"],
      [570, "explicit AI opt-in boundary"],
      [750, "cannot-review workflow"],
      [792, "returned without review outcome"],
      [900, "main review path resumes"],
      [950, "decision preview"],
    ];
  }
  if (scene.key === "place") {
    return [
      [100, "published schedule baseline"],
      [210, "blocking conflict"],
      [400, "Scenario Lab proposal"],
      [442, "Scenario Lab save selection"],
      [468, "saved private scenario"],
      [497, "explicit draft application"],
      [527, "draft changed and public unchanged"],
      [700, "exact revision in review"],
      [750, "exact revision approved"],
      [900, "full two-change publication diff"],
      [1035, "publication confirmation"],
      [1180, "latest-publication digest"],
    ];
  }
  if (scene.key === "publish") {
    return [
      [70, "selected connected examples"],
      [420, "published program"],
      [530, "speaker gallery route"],
      [780, "itinerary and managed embed"],
      [930, "published event site"],
    ];
  }
  if (scene.key === "operate") {
    return [
      [150, "API contract"],
      [456, "settled operation audit"],
      [590, "operation recovery"],
      [710, "provider boundary"],
    ];
  }
  return [
    [Math.max(1, Math.round(duration * 0.24)), "establish"],
    [
      Math.max(
        1,
        Math.round(duration * (scene.key === "closing" ? 0.93 : 0.72)),
      ),
      "payoff",
    ],
    ...(scene.key === "prepare"
      ? [[Math.max(1, Math.round(duration * 0.94)), "human context"]]
      : []),
  ];
};

const buildEvidencePlan = (timeline) => {
  const frames = [];
  const sceneStarts = [];
  let sceneStart = 0;
  for (const scene of timeline.scenes) {
    sceneStarts.push(sceneStart);
    for (const [offset, beat] of canariesForScene(scene)) {
      const frame = Math.min(
        sceneStart + scene.durationInFrames - 1,
        sceneStart + offset,
      );
      frames.push({
        index: frames.length,
        scene: scene.key,
        focus: scene.focus,
        beat,
        frame,
        timeSeconds: Number((frame / timeline.fps).toFixed(3)),
      });
    }
    sceneStart += scene.durationInFrames;
  }

  const boundaries = [];
  const boundaryPoints = [...sceneStarts, timeline.totalFrames];
  boundaryPoints.forEach((boundaryFrame, boundaryIndex) => {
    const offsets =
      boundaryFrame === 0
        ? [0, 1]
        : boundaryFrame === timeline.totalFrames
          ? [-2, -1]
          : [-18, -9, -2, -1, 0, 1, 2, 18, 36, 45, 54];
    const fromScene =
      boundaryIndex > 0
        ? (timeline.scenes[boundaryIndex - 1]?.key ?? null)
        : null;
    const toScene = timeline.scenes[boundaryIndex]?.key ?? null;
    for (const offset of offsets) {
      const frame = boundaryFrame + offset;
      if (
        !Number.isInteger(frame) ||
        frame < 0 ||
        frame >= timeline.totalFrames
      ) {
        fail(`Derived boundary frame ${frame} is outside the composition.`);
      }
      boundaries.push({
        index: boundaries.length,
        frame,
        timeSeconds: Number((frame / timeline.fps).toFixed(3)),
        boundaryFrame,
        offset,
        fromScene,
        toScene,
        phase: offset < 0 ? "before" : offset > 0 ? "after" : "at",
      });
    }
  });

  for (const item of [...frames, ...boundaries]) {
    if (
      !Number.isInteger(item.frame) ||
      item.frame < 0 ||
      item.frame >= timeline.totalFrames
    ) {
      fail(`Evidence frame ${item.frame} is not a valid composition frame.`);
    }
  }
  return { frames, boundaries };
};

const renderFrames = (timeline, evidence, stagingDirectory) => {
  if (!fs.existsSync(entryPoint)) {
    fail(`Remotion entrypoint is missing: ${entryPoint}`);
  }
  if (!fs.existsSync(remotionBinary)) {
    fail(
      `Local Remotion CLI is missing: ${remotionBinary}`,
      "Run npm install before rendering review frames.",
    );
  }

  const renderDirectory = path.join(stagingDirectory, "rendered");
  fs.mkdirSync(renderDirectory, { recursive: true });
  assertContained(
    stagingDirectory,
    renderDirectory,
    "Render staging directory",
  );
  const frameNumbers = [
    ...new Set(
      [...evidence.frames, ...evidence.boundaries].map((item) => item.frame),
    ),
  ].sort((left, right) => left - right);
  const result = run(
    remotionBinary,
    [
      "render",
      entryPoint,
      "ProgramCueLaunch",
      path.relative(artifactsDirectory, renderDirectory),
      "--sequence",
      "--frames",
      frameNumbers.join(","),
      "--image-format",
      "png",
      "--image-sequence-pattern",
      "source-[frame].[ext]",
      "--concurrency",
      "4",
      "--overwrite",
    ],
    { cwd: artifactsDirectory },
  );
  if (result.error) {
    fail(`Could not start the local Remotion CLI: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      `Remotion review render failed (exit ${result.status ?? "unknown"}${
        result.signal ? `, signal ${result.signal}` : ""
      }).`,
      [result.stderr, result.stdout].filter(Boolean).join("\n").slice(-8_000),
    );
  }

  const padding = String(timeline.totalFrames - 1).length;
  const renderedByFrame = new Map();
  for (const frame of frameNumbers) {
    const renderedPath = path.join(
      renderDirectory,
      `source-${String(frame).padStart(padding, "0")}.png`,
    );
    assertContained(renderDirectory, renderedPath, "Rendered frame path");
    if (!fs.existsSync(renderedPath) || fs.statSync(renderedPath).size === 0) {
      fail(`Remotion did not produce frame ${frame}.`);
    }
    renderedByFrame.set(frame, renderedPath);
  }
  return renderedByFrame;
};

const materializeEvidence = (
  timeline,
  evidence,
  renderedByFrame,
  publicationDirectory,
) => {
  fs.mkdirSync(publicationDirectory, { recursive: true });
  const padding = String(timeline.totalFrames - 1).length;
  const materialize = (item, prefix) => {
    const fileName = `${prefix}-${String(item.frame).padStart(padding, "0")}.png`;
    const stagedPath = path.join(publicationDirectory, fileName);
    const finalPath = path.join(reviewDirectory, fileName);
    assertContained(publicationDirectory, stagedPath, "Staged evidence path");
    assertContained(reviewDirectory, finalPath, "Published evidence path");
    fs.copyFileSync(renderedByFrame.get(item.frame), stagedPath);
    const bytes = fs.statSync(stagedPath).size;
    if (bytes === 0) fail(`Evidence frame ${item.frame} is empty.`);
    return {
      ...item,
      file: path.relative(repoRoot, finalPath),
      bytes,
      stagedPath,
    };
  };
  return {
    frames: evidence.frames.map((item) => materialize(item, "review")),
    boundaries: evidence.boundaries.map((item) =>
      materialize(item, "boundary"),
    ),
  };
};

const makeContactSheet = (
  items,
  fileName,
  columns,
  publicationDirectory,
  stagingDirectory,
) => {
  if (items.length === 0) fail(`Cannot build empty contact sheet ${fileName}.`);
  const sequenceDirectory = fs.mkdtempSync(
    path.join(stagingDirectory, ".contact-sheet-"),
  );
  try {
    items.forEach((item, index) => {
      fs.copyFileSync(
        item.stagedPath,
        path.join(
          sequenceDirectory,
          `contact-${String(index).padStart(3, "0")}.png`,
        ),
      );
    });
    const rows = Math.ceil(items.length / columns);
    const output = path.join(publicationDirectory, fileName);
    assertContained(publicationDirectory, output, "Contact sheet output");
    const result = run(ffmpegBinary, [
      "-hide_banner",
      "-nostdin",
      "-loglevel",
      "error",
      "-y",
      "-reinit_filter",
      "0",
      "-framerate",
      "1",
      "-i",
      path.join(sequenceDirectory, "contact-%03d.png"),
      "-vf",
      `format=rgb24,scale=400:225:flags=lanczos,tile=${columns}x${rows}:padding=12:margin=12:color=#0b1413`,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      output,
    ]);
    if (
      result.error ||
      result.status !== 0 ||
      !fs.existsSync(output) ||
      fs.statSync(output).size === 0
    ) {
      fail(
        `Could not build ${fileName}.`,
        result.error?.message ?? result.stderr ?? `exit ${result.status}`,
      );
    }
  } finally {
    fs.rmSync(sequenceDirectory, { force: true, recursive: true });
  }
};

const writeManifest = (timeline, generated, publicationDirectory) => {
  const withoutStagingPath = (item) => {
    const { stagedPath: _stagedPath, ...published } = item;
    return published;
  };
  const manifestPath = path.join(publicationDirectory, "manifest.json");
  fs.writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        composition: "ProgramCueLaunch",
        entryPoint: path.relative(repoRoot, entryPoint),
        timeline: path.relative(repoRoot, timelinePath),
        width: timeline.width,
        height: timeline.height,
        fps: timeline.fps,
        totalFrames: timeline.totalFrames,
        durationSeconds: timeline.totalFrames / timeline.fps,
        generatedAt: new Date().toISOString(),
        contactSheet: path.relative(
          repoRoot,
          path.join(reviewDirectory, "contact-sheet.jpg"),
        ),
        boundaryContactSheet: path.relative(
          repoRoot,
          path.join(reviewDirectory, "boundary-contact-sheet.jpg"),
        ),
        frames: generated.frames.map(withoutStagingPath),
        boundaries: generated.boundaries.map(withoutStagingPath),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
};

const publishEvidence = (publicationDirectory) => {
  fs.mkdirSync(reviewDirectory, { recursive: true });
  for (const entry of fs.readdirSync(reviewDirectory, {
    withFileTypes: true,
  })) {
    if (
      entry.isFile() &&
      (/^(?:review|boundary(?:-current)?)-\d+\.(?:png|jpg|jpeg)$/i.test(
        entry.name,
      ) ||
        [
          "contact-sheet.jpg",
          "boundary-contact-sheet.jpg",
          "boundary-current-contact-sheet.jpg",
          "manifest.json",
        ].includes(entry.name))
    ) {
      fs.unlinkSync(path.join(reviewDirectory, entry.name));
    }
  }
  for (const entry of fs.readdirSync(publicationDirectory, {
    withFileTypes: true,
  })) {
    if (!entry.isFile() || path.basename(entry.name) !== entry.name) {
      fail(`Unexpected staged evidence entry: ${entry.name}`);
    }
    const source = path.join(publicationDirectory, entry.name);
    const destination = path.join(reviewDirectory, entry.name);
    assertContained(publicationDirectory, source, "Staged publication path");
    assertContained(reviewDirectory, destination, "Evidence destination");
    fs.renameSync(source, destination);
  }
};

const main = () => {
  fs.mkdirSync(artifactsDirectory, { recursive: true });
  const stagingDirectory = fs.mkdtempSync(
    // Remotion interprets a leading dot anywhere in an image-sequence output
    // path as a file extension. Keep the unique stage on the artifacts
    // filesystem while giving its basename a normal, extensionless prefix.
    path.join(artifactsDirectory, "video-review-stage-"),
  );
  try {
    const timeline = readTimeline();
    const evidence = buildEvidencePlan(timeline);
    const renderedByFrame = renderFrames(timeline, evidence, stagingDirectory);
    const publicationDirectory = path.join(stagingDirectory, "publication");
    const generated = materializeEvidence(
      timeline,
      evidence,
      renderedByFrame,
      publicationDirectory,
    );
    makeContactSheet(
      generated.frames,
      "contact-sheet.jpg",
      6,
      publicationDirectory,
      stagingDirectory,
    );
    makeContactSheet(
      generated.boundaries,
      "boundary-contact-sheet.jpg",
      5,
      publicationDirectory,
      stagingDirectory,
    );
    writeManifest(timeline, generated, publicationDirectory);
    publishEvidence(publicationDirectory);

    console.log(
      `[video:frames] Rendered ${generated.frames.length} curated and ${generated.boundaries.length} boundary frames across ${timeline.scenes.length} scenes (${timeline.totalFrames} frames / ${timeline.totalFrames / timeline.fps}s).`,
    );
    console.log(
      `[video:frames] Evidence: ${path.relative(repoRoot, reviewDirectory)}/`,
    );
    console.log(
      `[video:frames] Manifest: ${path.relative(repoRoot, path.join(reviewDirectory, "manifest.json"))}`,
    );
  } finally {
    fs.rmSync(stagingDirectory, { force: true, recursive: true });
  }
};

try {
  main();
} catch (error) {
  console.error(
    error instanceof Error ? error.message : `[video:frames] ${String(error)}`,
  );
  process.exitCode = 1;
}
