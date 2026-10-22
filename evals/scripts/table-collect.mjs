import fs from "node:fs";
import path from "node:path";
import { sha256, surfaces, viewports } from "./ux-contract.mjs";
import { tableMethod, tableCases, attio } from "./table-prepare.mjs";

const context = JSON.parse(fs.readFileSync(process.env.AEK_COLLECT_CONTEXT, "utf8"));
const manifest = JSON.parse(fs.readFileSync(context.sources.manifest.path, "utf8"));
const item = manifest.cases?.find((item) => item.id === process.argv[2]);
if (
  manifest.method !== tableMethod ||
  !tableCases.some((entry) => entry.id === item?.id) ||
  manifest.reference?.sha256 !== attio.sha256
)
  throw new Error("Table collector requires its fixed native-pixel method");
if (manifest.selectedCases && !manifest.selectedCases.includes(item.id))
  throw new Error("Table collector case was not selected");
const capture = manifest.capture;
if (
  capture?.variant !== "normal" ||
  capture.views?.length !== surfaces.length * Object.keys(viewports).length ||
  capture.views.some((view) => !Array.isArray(view.failures) || view.failures.length)
)
  throw new Error("Table collector requires forty healthy browser views");
const files = Object.fromEntries(
  Object.entries(item.inputs).map(([label, input]) => {
    const bytes = fs.readFileSync(context.sources[label].path);
    if (sha256(bytes) !== input.sha256) throw new Error(`Table input changed: ${label}`);
    return [label, bytes];
  }),
);
for (const [label, id] of [
  ["fullview", item.view],
  ["mobile", item.view.replace("-desktop", "-mobile")],
]) {
  if (sha256(files[label]) !== capture.views.find((view) => view.id === id)?.sha256)
    throw new Error(`Table browser source changed: ${label}`);
}
if (item.candidatePlacement.scale !== 1 || ![0.5, 1].includes(item.referencePlacement.scale))
  throw new Error("Table inputs cannot enlarge source pixels");
fs.mkdirSync(context.outputDir, { recursive: true });
for (const [label, bytes] of Object.entries(files))
  fs.writeFileSync(path.join(context.outputDir, `${label}.png`), bytes);
console.log(
  JSON.stringify({
    version: 1,
    outcome: "completed",
    summary: `Verified ${item.id} native-pixel table and desktop/mobile captures.`,
    observations: [
      manifest.scaleNote,
      "Command collection verifies project-supplied pixels and provenance; this is not deployed or external-provider acceptance.",
    ],
    images: ["candidate", "fullview", "mobile"].map((label) => ({
      label,
      path: `${label}.png`,
      source: label,
      extraction:
        label === "candidate"
          ? "Pre-normalized fixed canvas; candidate crop is copied at scale 1 without interpolation."
          : "Original lossless browser PNG copied byte-for-byte; SHA-256 matches the forty-view manifest.",
    })),
  }),
);
