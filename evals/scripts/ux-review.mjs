import fs from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { aek } from "./runtime.mjs";
import { paintDifference, paintNoiseBound } from "./ux-paint.mjs";
import { readCapture, visualCriterion, visualMethod, absoluteCriterion } from "./ux-contract.mjs";

const { values } = parseArgs({
  options: {
    reference: { type: "string" },
    candidate: { type: "string" },
    output: { type: "string" },
    views: { type: "string" },
    policy: { type: "string", default: "preference" },
    judge: { type: "string", default: "codex" },
    model: { type: "string", default: "gpt-6.1-sol" },
    effort: { type: "string", default: "high" },
    aspect: { type: "string", default: "overall" },
    concurrency: { type: "string", default: "2" },
    resume: { type: "boolean", default: false },
    reuse: { type: "string" },
    "ignore-paint-noise": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
  },
});
if (
  !values.reference ||
  !values.candidate ||
  !values.output ||
  !["preference", "non_regression"].includes(values.policy)
)
  throw new Error(
    "Usage: ux:review --reference CAPTURE --candidate CAPTURE --output DIRECTORY [--views IDS] [--resume] [--reuse REVIEW] [--ignore-paint-noise] [--dry-run]",
  );
if (values.resume && (values["dry-run"] || values.reuse))
  throw new Error("Resume uses the original invocation; cannot combine with reuse or dry-run");
const concurrency = Number(values.concurrency);
if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 2)
  throw new Error("Visual review concurrency must be 1 or 2");
const referenceDir = path.resolve(values.reference),
  candidateDir = path.resolve(values.candidate),
  output = path.resolve(values.output);
const reference = readCapture(referenceDir),
  candidate = readCapture(candidateDir);
if (reference.variant !== "normal" || candidate.variant !== "normal")
  throw new Error("Visual reviews require normal application captures");
if (reference.chromium !== candidate.chromium || reference.methodSha256 !== candidate.methodSha256)
  throw new Error("Capture browser/method differs; recapture both with the same toolchain");
if ([reference, candidate].some((capture) => capture.views.some((view) => view.failures.length)))
  throw new Error("Every reference and candidate browser guard must pass before judging");
const selected = values.views?.split(",") ?? candidate.views.map((view) => view.id);
if (
  !selected.length ||
  new Set(selected).size !== selected.length ||
  selected.some((id) => !candidate.views.some((view) => view.id === id))
)
  throw new Error("Unknown or duplicate UX view");
const voting = { minimumVotes: 5, maximumVotes: 5, agreement: 1 };
const inputs = {
  protocol: "native-aek-image-batch-v1",
  evaluator: JSON.parse(
    fs.readFileSync(new URL("../node_modules/agent-eval-kit/package.json", import.meta.url)),
  ).version,
  reference,
  candidate,
  selected,
  policy: values.policy,
  judge: values.judge,
  model: values.model,
  effort: values.effort,
  relativeCriterion: visualCriterion(values.aspect),
  absoluteCriterion,
  voting,
  reuse: values.reuse ? path.resolve(values.reuse) : null,
  paintNoise: values["ignore-paint-noise"] ? paintNoiseBound : null,
};
if (values.resume) {
  const original = JSON.parse(fs.readFileSync(path.join(output, "review-input.json")));
  inputs.reuse = original.reuse;
  if (JSON.stringify(original) !== JSON.stringify(inputs))
    throw new Error("Resume requires the original captures, selection, model and judging contract");
} else if (fs.existsSync(output)) throw new Error("Review output must be a new directory");
const guards = [],
  comparisons = [];
for (const id of selected) {
  const before = reference.views.find((view) => view.id === id),
    after = candidate.views.find((view) => view.id === id);
  const noise =
    before.sha256 !== after.sha256 && inputs.paintNoise
      ? await paintDifference(
          fs.readFileSync(path.join(referenceDir, before.file)),
          fs.readFileSync(path.join(candidateDir, after.file)),
        )
      : null;
  if (before.sha256 === after.sha256 || noise) {
    guards.push({
      id,
      status: "unchanged",
      exitCode: 0,
      ...(noise ? { paintEquivalence: noise } : {}),
    });
  } else
    comparisons.push({
      id,
      candidate: path.join(candidateDir, after.file),
      reference: path.join(referenceDir, before.file),
      panel: { ...after.viewport },
    });
}
const manifest = {
  version: 1,
  defaults: {
    criterion: inputs.relativeCriterion,
    absoluteCriterion,
    policy: values.policy,
    judge: values.judge,
    judgeModel: values.model,
    judgeEffort: values.effort,
    capacityRetries: 2,
    voting,
  },
  comparisons,
};
if (values["dry-run"]) {
  console.log(JSON.stringify({ ...inputs, guards, manifest, concurrency }, null, 2));
  process.exit(0);
}
fs.mkdirSync(output, { recursive: true });
if (!values.resume) {
  fs.writeFileSync(path.join(output, "review-input.json"), `${JSON.stringify(inputs, null, 2)}\n`);
  fs.writeFileSync(path.join(output, "comparisons.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}
const batch = path.join(output, "batch");
let exitCode = 0;
if (comparisons.length) {
  const args = [
    aek,
    "image",
    "batch",
    ...(values.resume
      ? ["--resume", batch]
      : [
          "--manifest",
          path.join(output, "comparisons.json"),
          "--output",
          batch,
          "--concurrency",
          String(concurrency),
          ...(values.reuse ? ["--reuse", path.join(path.resolve(values.reuse), "batch")] : []),
        ]),
  ];
  const child = spawn(process.execPath, args, { stdio: "inherit" });
  const stop = (signal) => child.kill(signal);
  const interrupt = () => stop("SIGINT"),
    terminate = () => stop("SIGTERM");
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", terminate);
  try {
    exitCode = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) =>
        resolve(signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : (code ?? 1)),
      );
    });
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}
let native;
if (fs.existsSync(path.join(batch, "report.json"))) {
  execFileSync(process.execPath, [aek, "verify", "--run", batch], { stdio: "inherit" });
  native = JSON.parse(fs.readFileSync(path.join(batch, "report.json")));
}
const results = [
  ...guards,
  ...(native?.comparisons ?? []).map((row) => ({
    id: row.id,
    status: row.reusedFrom ? "reused" : row.status,
    exitCode: row.status === "complete" ? (row.failures.length ? 2 : 0) : 1,
    ...(row.run ? { run: path.join(batch, row.run) } : {}),
    ...(row.reusedFrom ? { reusedFrom: row.reusedFrom } : {}),
    ...(row.error ? { error: row.error } : {}),
  })),
].sort((a, b) => selected.indexOf(a.id) - selected.indexOf(b.id));
fs.writeFileSync(
  path.join(output, "review.json"),
  `${JSON.stringify(
    {
      version: 2,
      method: visualMethod,
      protocol: inputs.protocol,
      evaluator: inputs.evaluator,
      referenceDir,
      candidateDir,
      selected,
      policy: values.policy,
      aspect: values.aspect,
      voting,
      browserPassed: true,
      results,
      nativeBatch: comparisons.length ? batch : null,
      complete:
        results.length === candidate.views.length && !results.some((row) => row.exitCode === 1),
      ...(exitCode === 1
        ? { executionError: "Native batch contains an execution error; resume the same batch" }
        : {}),
      boundary:
        "Initial local viewport evidence. Unchanged views are guards; a selected subset is not full design acceptance.",
    },
    null,
    2,
  )}\n`,
);
process.exitCode = exitCode;
