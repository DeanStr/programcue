import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import YAML from "yaml";
import { project, root } from "./runtime.mjs";
import { benchmarks, references, benchmarkCriterion } from "./saas-references.mjs";
import { absoluteCriterion, readCapture, sha256 } from "./ux-contract.mjs";

export const tableMethod = "saas-tables-v3-native-batch";
export const tableCases = benchmarks.filter((item) =>
  ["APPLICATIONS", "DIRECTORY"].includes(item.id),
);
export const tablePanel = { width: 1229, height: 430 };
export const attio = references.find((item) => item.id === "attio");
export const tableQualityCriterion = `${absoluteCriterion} Assess this scenario's original desktop and mobile views, as well as the native-pixel table crop. Intentional component-crop edges and letterboxing are not clipping defects.`;
export function tableComparisonCriterion(item, before) {
  return `${before ? `Which version has stronger visual/UI design craft for ${item.focus} These are two versions of the same product. Judge visible styling only; equivalence is valid when no material improvement is visible. Do not reward feature count, content quantity, inferred workflow efficiency or indiscriminately smaller, larger, bolder or denser text.` : benchmarkCriterion(item)} Both frames use a fixed canvas. Program Cue is rendered at its captured CSS-pixel size; Attio, when present, is a published export at its documented assumed 2x scale. Ignore letterboxing and do not reward the different amount of table content.`;
}

// Keep the application's captured CSS pixels. Never enlarge either input.
export async function tableFrame(page, bytes, crop, scale) {
  if (!(scale > 0 && scale <= 1)) throw new Error("Table frames cannot enlarge source pixels");
  const result = await page.evaluate(
    async ({ data, crop, scale, panel }) => {
      const image = await createImageBitmap(await (await fetch(data)).blob());
      if (
        crop.x < 0 ||
        crop.y < 0 ||
        crop.x + crop.width > image.width ||
        crop.y + crop.height > image.height
      )
        throw new Error("Table crop exceeds its source image");
      const width = crop.width * scale;
      const height = crop.height * scale;
      if (width > panel.width || height > panel.height)
        throw new Error("Table crop exceeds its fixed panel");
      const x = Math.floor((panel.width - width) / 2);
      const y = Math.floor((panel.height - height) / 2);
      const canvas = document.createElement("canvas");
      canvas.width = panel.width;
      canvas.height = panel.height;
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, panel.width, panel.height);
      context.imageSmoothingEnabled = scale !== 1;
      context.drawImage(image, crop.x, crop.y, crop.width, crop.height, x, y, width, height);
      return {
        png: canvas.toDataURL("image/png"),
        placement: { x, y, width, height, scale },
        source: { width: image.width, height: image.height },
      };
    },
    { data: `data:image/png;base64,${bytes.toString("base64")}`, crop, scale, panel: tablePanel },
  );
  return {
    bytes: Buffer.from(result.png.split(",")[1], "base64"),
    placement: result.placement,
    source: result.source,
  };
}

function healthy(directory) {
  const capture = readCapture(directory);
  if (capture.variant !== "normal" || capture.views.some((view) => view.failures.length))
    throw new Error("Table evaluation requires all forty browser views to pass");
  return capture;
}

export async function prepareTables(
  captureDirectory,
  outputDirectory,
  referenceDirectory,
  selectedCases = tableCases.map((item) => item.id),
) {
  if (
    !selectedCases.length ||
    new Set(selectedCases).size !== selectedCases.length ||
    selectedCases.some((id) => !tableCases.some((item) => item.id === id))
  )
    throw new Error("Select known, distinct table cases");
  const captureDir = path.resolve(captureDirectory);
  const output = path.resolve(outputDirectory);
  const capture = healthy(captureDir);
  const beforeDir = referenceDirectory && path.resolve(referenceDirectory);
  const before = beforeDir && healthy(beforeDir);
  if (
    before &&
    (before.methodSha256 !== capture.methodSha256 || before.chromium !== capture.chromium)
  )
    throw new Error("Before/after captures must use the same capture method and browser");
  if (fs.existsSync(output)) throw new Error("Table output must be a new directory");
  const referenceAsset = path.join(root, ".agent-eval/ui-external/references/attio.png");
  if (!before && sha256(fs.readFileSync(referenceAsset)) !== attio.sha256)
    throw new Error("Attio reference differs from its pinned official asset");
  const mode = before ? "improvement" : "external";
  const manifest = {
    selectedCases,
    evaluator: "0.7.0",
    method: tableMethod,
    mode,
    createdAt: new Date().toISOString(),
    captureDir,
    referenceCaptureDir: beforeDir ?? null,
    capture,
    referenceCapture: before ?? null,
    reference: attio,
    panel: tablePanel,
    scaleNote:
      "Program Cue crops remain at 1 captured pixel per CSS pixel. The official Attio export is rendered at 0.5 source scale, assuming a 2x export; its actual browser DPR is unverified. Neither input is enlarged. Ignore surrounding letterboxing.",
    cases: [],
  };
  fs.mkdirSync(path.join(output, "inputs"), { recursive: true });
  fs.mkdirSync(path.join(output, "specs"));
  const browser = await chromium.launch();
  try {
    manifest.renderer = browser.version();
    const page = await browser.newPage();
    for (const item of tableCases) {
      const view = capture.views.find((view) => view.id === item.view);
      const mobile = capture.views.find(
        (view) => view.id === item.view.replace("-desktop", "-mobile"),
      );
      const crop = Object.fromEntries(
        Object.entries(item.candidateCrop).map(([key, value]) => [
          key,
          Math.round(value * (["x", "width"].includes(key) ? 1440 : 1000)),
        ]),
      );
      const fullBytes = fs.readFileSync(path.join(captureDir, view.file));
      const candidate = await tableFrame(page, fullBytes, crop, 1);
      if (candidate.source.width !== 1440 || candidate.source.height !== 1000)
        throw new Error("Table source must be a native 1440×1000 screenshot");
      const reference = before
        ? await tableFrame(
            page,
            fs.readFileSync(
              path.join(beforeDir, before.views.find((view) => view.id === item.view).file),
            ),
            crop,
            1,
          )
        : await tableFrame(
            page,
            fs.readFileSync(referenceAsset),
            { x: 0, y: 0, width: 2458, height: 800 },
            0.5,
          );
      const files = {
        candidate: candidate.bytes,
        reference: reference.bytes,
        fullview: fullBytes,
        mobile: fs.readFileSync(path.join(captureDir, mobile.file)),
      };
      const inputs = Object.fromEntries(
        Object.entries(files).map(([label, bytes]) => {
          const file = `inputs/${item.id}-${label}.png`;
          fs.writeFileSync(path.join(output, file), bytes);
          return [label, { file, sha256: sha256(bytes) }];
        }),
      );
      manifest.cases.push({
        ...item,
        crop,
        inputs,
        candidatePlacement: candidate.placement,
        referencePlacement: reference.placement,
      });
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(output, "table-input.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  const voting = { minimumVotes: 5, maximumVotes: 5, agreement: 1 };
  const selected = manifest.cases.filter((item) => selectedCases.includes(item.id));
  const scenarios = selected.map((item) => ({
    id: item.id,
    name: item.title,
    kind: "command",
    instructions:
      "Retain verified, already-normalized table pixels and original desktop/mobile browser views.",
    collect: {
      command: `node evals/scripts/table-collect.mjs ${item.id}`,
      methodFiles: [
        "evals/scripts/table-collect.mjs",
        "evals/scripts/table-prepare.mjs",
        "evals/scripts/saas-references.mjs",
        "evals/scripts/ux-contract.mjs",
      ],
      sources: {
        manifest: path.join(output, "table-input.json"),
        ...Object.fromEntries(
          Object.entries(item.inputs).map(([label, input]) => [
            label,
            path.join(output, input.file),
          ]),
        ),
      },
      images: ["candidate", "fullview", "mobile"],
    },
  }));
  const spec = {
    id: "tables",
    title: "Native-pixel application and directory tables",
    weight: 100,
    description: manifest.scaleNote,
    scenarios,
    rubric: selected.map((item) => ({
      id: `QUALITY-${item.id}`,
      criterion: tableQualityCriterion,
      weight: 1,
      scenarios: [item.id],
      grader: { type: "llm" },
      gate: true,
      passCriteria: "All five votes pass the supplied desktop, mobile and component views.",
    })),
  };
  fs.writeFileSync(
    path.join(output, "comparisons.json"),
    `${JSON.stringify(
      {
        version: 1,
        defaults: {
          judge: "codex",
          judgeModel: "gpt-6.1-sol",
          judgeEffort: "high",
          capacityRetries: 2,
          voting,
          panel: { ...tablePanel, fit: "contain", background: "#ffffff" },
          policy: before ? "preference" : "non_regression",
        },
        comparisons: selected.map((item) => ({
          id: item.id,
          label: item.title,
          candidate: item.inputs.candidate.file,
          reference: item.inputs.reference.file,
          criterion: tableComparisonCriterion(item, before),
        })),
      },
      null,
      2,
    )}\n`,
  );
  const config = {
    version: 1,
    project: { name: `Program Cue — ${tableMethod} — ${mode}`, root: project },
    target: { kind: "command", fingerprint: { exclude: [".wrangler", ".artifacts", "build"] } },
    agent: { provider: "mock" },
    judge: {
      provider: "codex",
      model: "gpt-6.1-sol",
      effort: "high",
      timeoutSeconds: 900,
      capacityRetries: 2,
      concurrency: 2,
      voting,
    },
    paths: { specs: path.join(output, "specs"), runs: path.join(output, "runs") },
    scoring: { minimumCoverage: 100 },
  };
  fs.writeFileSync(path.join(output, "specs/tables.yaml"), YAML.stringify(spec));
  fs.writeFileSync(path.join(output, "evalkit.yaml"), YAML.stringify(config));
  return output;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      capture: { type: "string" },
      output: { type: "string" },
      reference: { type: "string" },
      cases: { type: "string" },
    },
  });
  if (!values.capture || !values.output)
    throw new Error(
      "Usage: table-prepare --capture CAPTURE --output NEW_DIRECTORY [--reference BEFORE_CAPTURE]",
    );
  console.log(
    await prepareTables(values.capture, values.output, values.reference, values.cases?.split(",")),
  );
}
