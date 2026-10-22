import fs from "node:fs";
import path from "node:path";
import { sha256 } from "./ux-contract.mjs";
import { benchmarks, references } from "./saas-references.mjs";

const benchmark = benchmarks.find((item) => item.id === process.argv[2]);
if (!benchmark) throw new Error("Unknown SaaS reference benchmark");
const reference = references.find((item) => item.id === benchmark.reference);
const context = JSON.parse(fs.readFileSync(process.env.AEK_COLLECT_CONTEXT, "utf8"));
const capture = JSON.parse(fs.readFileSync(context.sources.provenance.path, "utf8"));
const candidate = fs.readFileSync(context.sources.candidate.path);
const view = capture.views?.find((item) => item.id === benchmark.view);
if (
  capture.version !== 1 ||
  capture.variant !== "normal" ||
  view?.sha256 !== sha256(candidate) ||
  view?.viewport?.width !== 1440 ||
  view.viewport.height !== 1000 ||
  capture.views.some((item) => !Array.isArray(item.failures) || item.failures.length)
)
  throw new Error("SaaS benchmark requires a healthy matching browser capture");
if (sha256(fs.readFileSync(context.sources.reference.path)) !== reference.sha256)
  throw new Error("SaaS reference differs from the pinned official asset");
fs.mkdirSync(context.outputDir, { recursive: true });
fs.writeFileSync(path.join(context.outputDir, "candidate.png"), candidate);
console.log(
  JSON.stringify({
    version: 1,
    outcome: "completed",
    summary: `Verified ${benchmark.view} against its capture manifest.`,
    observations: [
      reference.page,
      reference.note,
      "Visual evidence only; external provider behavior is not established.",
    ],
    images: [
      {
        label: "candidate",
        path: "candidate.png",
        source: "candidate",
        extraction:
          "Lossless original PNG copied byte-for-byte; SHA-256 matches the sealed capture provenance.",
      },
    ],
  }),
);
