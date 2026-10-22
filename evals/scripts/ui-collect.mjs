import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const context = JSON.parse(fs.readFileSync(process.env.AEK_COLLECT_CONTEXT, "utf8"));
const expectedReference = "e8455151bee6433e6add7fd3407d09319612eb900fc02bc35d8bb0960b21e782";
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const provenance = JSON.parse(fs.readFileSync(context.sources.provenance.path, "utf8"));
const candidate = fs.readFileSync(context.sources.candidate.path);
const reference = fs.readFileSync(context.sources.reference.path);
const view = provenance.views?.find((item) => item.id === "command-desktop");
if (
  provenance.version !== 1 ||
  provenance.variant !== "normal" ||
  view?.viewport?.width !== 1440 ||
  view.viewport.height !== 1000 ||
  view.sha256 !== digest(candidate) ||
  !Array.isArray(view.failures) ||
  view.failures.length !== 0 ||
  !/^[a-f0-9]{40}$/.test(provenance.source?.revision ?? "")
)
  throw new Error("UI benchmark requires a healthy, matching 1440×1000 command-desktop capture");
if (digest(reference) !== expectedReference)
  throw new Error("UI reference differs from the pinned Linear 12 March 2026 publication");
fs.mkdirSync(context.outputDir, { recursive: true });
fs.writeFileSync(path.join(context.outputDir, "candidate.png"), candidate);
console.log(
  JSON.stringify({
    version: 1,
    outcome: "completed",
    summary:
      "Retained a verified local Program Cue screenshot for component-level visual comparison.",
    observations: [
      `Source revision ${provenance.source.revision}; capture method ${provenance.methodSha256}.`,
      "This is pixel evidence only. The external reference is provisional and the comparison covers the selected navigation crops only.",
    ],
    images: [
      {
        label: "candidate",
        path: "candidate.png",
        source: "candidate",
        extraction:
          "Original lossless browser PNG copied byte-for-byte using Node.js fs; SHA-256 matches the supplied capture manifest. Pairwise crops are defined in the rubric.",
      },
    ],
  }),
);
