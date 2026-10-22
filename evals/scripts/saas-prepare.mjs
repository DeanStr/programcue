import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import YAML from "yaml";
import { project, root } from "./runtime.mjs";
import { readCapture, sha256, absoluteCriterion } from "./ux-contract.mjs";
import { benchmarks, references, benchmarkCriterion, saasMethod } from "./saas-references.mjs";

const { values } = parseArgs({
  options: { capture: { type: "string" }, output: { type: "string" } },
});
if (!values.capture || !values.output)
  throw new Error("Usage: npm run ui:saas:prepare -- --capture CAPTURE --output NEW_DIRECTORY");
const captureDir = path.resolve(values.capture);
const capture = readCapture(captureDir);
if (capture.variant !== "normal" || capture.views.some((view) => view.failures.length))
  throw new Error("SaaS preparation requires all forty browser views to pass");
const output = path.resolve(values.output);
if (fs.existsSync(output)) throw new Error("SaaS output must be a new directory");
const cache = path.join(root, ".agent-eval/ui-external/references");
fs.mkdirSync(cache, { recursive: true });
for (const reference of references) {
  const file = path.join(cache, `${reference.id}.png`);
  if (!fs.existsSync(file)) {
    const response = await fetch(reference.asset, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok)
      throw new Error(`Reference download failed: ${reference.id} (${response.status})`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== reference.sha256)
      throw new Error(`Reference download hash differs: ${reference.id}`);
    fs.writeFileSync(file, bytes, { flag: "wx" });
  }
  if (sha256(fs.readFileSync(file)) !== reference.sha256)
    throw new Error(`Reference hash differs: ${reference.id}`);
}
fs.mkdirSync(path.join(output, "inputs"), { recursive: true });
fs.mkdirSync(path.join(output, "specs"));
fs.copyFileSync(path.join(captureDir, "capture.json"), path.join(output, "inputs/capture.json"));
const scenario = (benchmark) => {
  const view = capture.views.find((item) => item.id === benchmark.view);
  fs.copyFileSync(path.join(captureDir, view.file), path.join(output, "inputs", view.file));
  return {
    id: benchmark.id,
    name: benchmark.title,
    kind: "command",
    instructions:
      "Retain the verified browser PNG and reference provenance. Assess visible UI only.",
    collect: {
      command: `node evals/scripts/saas-collect.mjs ${benchmark.id}`,
      methodFiles: [
        "evals/scripts/saas-collect.mjs",
        "evals/scripts/saas-references.mjs",
        "evals/scripts/ux-contract.mjs",
      ],
      sources: {
        candidate: path.join(output, "inputs", view.file),
        provenance: path.join(output, "inputs/capture.json"),
        reference: path.join(cache, `${benchmark.reference}.png`),
      },
      images: ["candidate"],
    },
  };
};
const voting = { minimumVotes: 5, maximumVotes: 5, agreement: 1 };
const spec = {
  id: "saas",
  title: "Published SaaS visual references",
  weight: 100,
  description:
    "Matched component comparisons; these fixed official documentation images do not establish latest-live-product or whole-product parity.",
  scenarios: benchmarks.map(scenario),
  rubric: [
    {
      id: "READABLE",
      criterion: absoluteCriterion,
      weight: 1,
      scenarios: benchmarks.map((b) => b.id),
      grader: { type: "llm" },
      gate: true,
      passCriteria: "Every supplied candidate view passes its visible UI-quality requirement.",
    },
    ...benchmarks.map((benchmark) => ({
      id: benchmark.id,
      criterion: benchmarkCriterion(benchmark),
      weight: 1,
      scenarios: [benchmark.id],
      grader: {
        type: "pairwise",
        candidate: "candidate",
        policy: "non_regression",
        references: [
          {
            file: path.join(cache, `${benchmark.reference}.png`),
            crop: benchmark.referenceCrop,
            candidateCrop: benchmark.candidateCrop,
          },
        ],
        panel: { ...benchmark.panel, fit: "contain", background: "#ffffff" },
        voting,
      },
      gate: true,
      passCriteria:
        "All five votes find the candidate visually equivalent or preferred for the stated component properties.",
    })),
  ],
};
const config = {
  version: 1,
  project: { name: "Program Cue — published SaaS visual references", root: project },
  target: { kind: "command", fingerprint: { exclude: [".wrangler", ".artifacts", "build"] } },
  agent: { provider: "mock" },
  judge: {
    provider: "codex",
    model: "gpt-6.1-sol",
    effort: "high",
    timeoutSeconds: 900,
    concurrency: 2,
    voting,
  },
  paths: { specs: path.join(output, "specs"), runs: path.join(output, "runs") },
  scoring: { minimumCoverage: 100 },
};
fs.writeFileSync(path.join(output, "specs/saas.yaml"), YAML.stringify(spec));
fs.writeFileSync(path.join(output, "evalkit.yaml"), YAML.stringify(config));
fs.writeFileSync(
  path.join(output, "benchmark-input.json"),
  `${JSON.stringify({ method: saasMethod, preparedAt: new Date().toISOString(), captureDir, capture, references, benchmarks, voting }, null, 2)}\n`,
);
console.log(
  `Prepared ${benchmarks.length} external comparisons: ${path.join(output, "evalkit.yaml")}`,
);
