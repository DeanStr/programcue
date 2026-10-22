import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "playwright";
import { benchmarks, references, saasMethod } from "./saas-references.mjs";
import { readCapture, sha256 } from "./ux-contract.mjs";

const { values } = parseArgs({
  options: {
    iteration: { type: "string", multiple: true },
    output: { type: "string" },
    consistency: { type: "string" },
    improvements: { type: "string", multiple: true },
    capture: { type: "string" },
    baseline: { type: "string" },
  },
});
if (!values.iteration?.length || !values.output)
  throw new Error(
    "Usage: npm run ui:saas:report -- --iteration DIRECTORY [--iteration DIRECTORY] --output DIRECTORY [--consistency DIRECTORY] [--improvements REVIEW]",
  );
const output = path.resolve(values.output);
fs.mkdirSync(output, { recursive: true });
const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const href = (file) => escapeHtml(encodeURI(path.relative(output, path.resolve(file))));
const iterations = values.iteration.map((directory) => {
  directory = path.resolve(directory);
  const input = JSON.parse(fs.readFileSync(path.join(directory, "benchmark-input.json"), "utf8"));
  if (
    input.method !== saasMethod ||
    JSON.stringify(input.benchmarks) !== JSON.stringify(benchmarks) ||
    JSON.stringify(input.references) !== JSON.stringify(references)
  )
    throw new Error("Cannot combine different reference contracts in one report");
  const runDirs = fs.existsSync(path.join(directory, "runs"))
    ? fs
        .readdirSync(path.join(directory, "runs"))
        .filter((name) => fs.statSync(path.join(directory, "runs", name)).isDirectory())
    : [];
  if (runDirs.length > 1)
    throw new Error("Expected one AEK run per iteration; use --resume for execution errors");
  return { directory, input, run: runDirs[0] ? path.join(directory, "runs", runDirs[0]) : null };
});
// A later full-page capture can change outside a judged crop. Reuse only
// byte-identical decoded crop pixels, never a remembered favourable result.
const current = values.capture && readCapture(path.resolve(values.capture));
const baseline = values.baseline && readCapture(path.resolve(values.baseline));
if (
  baseline &&
  (!current || baseline.variant !== "normal" || baseline.views.some((view) => view.failures.length))
)
  throw new Error("A report baseline requires a healthy current capture and baseline");
if (current && (current.variant !== "normal" || current.views.some((view) => view.failures.length)))
  throw new Error("Current report capture must pass every browser check");
const regions = new Map();
if (current) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    for (const benchmark of benchmarks) {
      const files = [
        path.join(
          path.resolve(values.capture),
          current.views.find((view) => view.id === benchmark.view).file,
        ),
        baseline &&
          path.join(
            path.resolve(values.baseline),
            baseline.views.find((view) => view.id === benchmark.view).file,
          ),
        ...iterations.map(
          (iteration) =>
            iteration.run && path.join(iteration.run, benchmark.id, "screenshots/candidate.png"),
        ),
        ...(values.improvements ?? []).map((directory) =>
          path.join(path.resolve(directory), benchmark.id, "screenshots/candidate.png"),
        ),
      ].filter((file) => file && fs.existsSync(file));
      for (const file of new Set(files)) {
        const pixels = await page.evaluate(
          async ({ data, crop }) => {
            const image = await createImageBitmap(await (await fetch(data)).blob());
            const canvas = document.createElement("canvas");
            canvas.width = Math.round(image.width * crop.width);
            canvas.height = Math.round(image.height * crop.height);
            canvas
              .getContext("2d")
              .drawImage(
                image,
                Math.round(image.width * crop.x),
                Math.round(image.height * crop.y),
                canvas.width,
                canvas.height,
                0,
                0,
                canvas.width,
                canvas.height,
              );
            return canvas.toDataURL("image/png");
          },
          {
            data: `data:image/png;base64,${fs.readFileSync(file).toString("base64")}`,
            crop: benchmark.candidateCrop,
          },
        );
        regions.set(`${benchmark.id}:${file}`, sha256(pixels));
      }
    }
  } finally {
    await browser.close();
  }
}
const cases = benchmarks.map((benchmark) => {
  const history = iterations.flatMap((iteration) => {
    const comparison =
      iteration.run &&
      path.join(iteration.run, "areas/saas/pairwise", benchmark.id, benchmark.id, "1");
    const json = comparison && path.join(comparison, "comparison.json");
    if (!json || !fs.existsSync(json)) return [];
    const data = JSON.parse(fs.readFileSync(json, "utf8"));
    const currentFile =
      current &&
      path.join(
        path.resolve(values.capture),
        current.views.find((view) => view.id === benchmark.view).file,
      );
    const judgedFile = path.join(iteration.run, benchmark.id, "screenshots/candidate.png");
    const matchesCurrent =
      !current ||
      (regions.has(`${benchmark.id}:${judgedFile}`) &&
        regions.get(`${benchmark.id}:${judgedFile}`) ===
          regions.get(`${benchmark.id}:${currentFile}`));
    return [{ iteration: iteration.directory, comparison, matchesCurrent, ...data }];
  });
  return {
    ...benchmark,
    referenceInfo: references.find((item) => item.id === benchmark.reference),
    history,
  };
});
const panels = cases
  .map((item) => {
    const latest = item.history.filter((stage) => stage.matchesCurrent).at(-1);
    const counts = latest?.decision.counts ?? {};
    const label = latest
      ? `${counts.win ?? 0} Program Cue · ${counts.equivalent ?? 0} equivalent · ${counts.loss ?? 0} reference · ${counts.abstain ?? 0} abstain`
      : "Current component has no matching retained judgment";
    const stages = item.history
      .map(
        (stage) =>
          `<a href="${href(path.join(stage.comparison, "comparison.html"))}">${escapeHtml(path.basename(stage.iteration))}: ${escapeHtml(JSON.stringify(stage.decision.counts))}</a>`,
      )
      .join(" · ");
    const images = latest
      ? `<div class="pair"><figure><figcaption>Program Cue</figcaption><a href="${href(path.join(latest.comparison, "candidate.png"))}"><img src="${href(path.join(latest.comparison, "candidate.png"))}" loading="lazy" alt="${escapeHtml(item.title)} candidate"></a></figure><figure><figcaption>${escapeHtml(item.referenceInfo.product)}</figcaption><a href="${href(path.join(latest.comparison, "reference.png"))}"><img src="${href(path.join(latest.comparison, "reference.png"))}" loading="lazy" alt="${escapeHtml(item.title)} reference"></a></figure></div>`
      : "";
    const reasons =
      latest?.votes.map((vote) => `<li>${escapeHtml(vote.raw.reasoning)}</li>`).join("") ?? "";
    return `<section><h2>${escapeHtml(item.title)}</h2><p class="result">${label}</p><p>${stages}</p><p><a href="${escapeHtml(item.referenceInfo.page)}">Official source</a> · <a href="${escapeHtml(item.referenceInfo.asset)}">Original image</a></p><p class="note">${escapeHtml(item.referenceInfo.note)}</p>${images}<details><summary>All five retained judgments</summary><ol>${reasons}</ol></details></section>`;
  })
  .join("\n");
let consistency = "";
if (values.consistency) {
  const dir = path.resolve(values.consistency);
  const data = JSON.parse(fs.readFileSync(path.join(dir, "consistency.json"), "utf8"));
  consistency = `<section><h2>Cross-page title and control review</h2><p>${escapeHtml(data.scope)}</p><p>Heading signatures: ${Object.entries(
    data.groups,
  )
    .map(([device, group]) => `${escapeHtml(device)} ${group.signatures}`)
    .join(
      " · ",
    )}.</p><p><a href="${href(path.join(dir, "consistency.json"))}">Computed styles and source provenance</a></p>${["desktop", "mobile"].map((device) => `<details><summary>${device} header collection</summary><a href="${href(path.join(dir, `${device}.png`))}"><img class="atlas" src="${href(path.join(dir, `${device}.png`))}" loading="lazy" alt="${device} header collection"></a></details>`).join("")}</section>`;
}
const improvement = (values.improvements ?? [])
  .map((directory, index) => {
    directory = path.resolve(directory);
    const rows = [...benchmarks, { id: "HEADERS", title: "Ordinary page-title system" }]
      .map((item) => {
        const folder = path.join(directory, "areas/saas/pairwise", item.id, item.id, "1");
        const file = path.join(folder, "comparison.json");
        if (!fs.existsSync(file))
          return `<tr><td>${escapeHtml(item.title)}</td><td>Pending</td></tr>`;
        const data = JSON.parse(fs.readFileSync(file, "utf8"));
        const counts = data.decision.counts;
        let status = "Judged version";
        if (current && item.id !== "HEADERS") {
          const currentFile = path.join(
            path.resolve(values.capture),
            current.views.find((view) => view.id === item.view).file,
          );
          const beforeFile =
            baseline &&
            path.join(
              path.resolve(values.baseline),
              baseline.views.find((view) => view.id === item.view).file,
            );
          const judgedFile = path.join(directory, item.id, "screenshots/candidate.png");
          const key = `${item.id}:`;
          if (beforeFile && regions.get(key + currentFile) === regions.get(key + beforeFile))
            status = "Withdrawn — previous component restored";
          else if (
            regions.has(key + judgedFile) &&
            regions.get(key + currentFile) === regions.get(key + judgedFile)
          )
            status = "Current component matches judged pixels";
          else status = "Historical experiment — current component differs";
        } else if (item.id === "HEADERS" && values.consistency) {
          const currentAtlas = fs.readFileSync(
            path.join(path.resolve(values.consistency), "responsive.png"),
          );
          const judgedAtlas = fs.readFileSync(
            path.join(directory, "HEADERS/collector-output/candidate.png"),
          );
          status =
            sha256(currentAtlas) === sha256(judgedAtlas)
              ? "Current title collection matches judged pixels"
              : "Historical experiment — current title collection differs";
        }
        return `<tr><td><a href="${href(path.join(folder, "comparison.html"))}">${escapeHtml(item.title)}</a><br>${escapeHtml(status)}</td><td>${counts.win ?? 0} candidate · ${counts.equivalent ?? 0} equivalent · ${counts.loss ?? 0} previous · ${counts.abstain ?? 0} abstain</td></tr>`;
      })
      .join("");
    return `<section><h2>Program Cue before/after — round ${index + 1}</h2><p>Strict improvement requires five candidate preferences and five absolute quality passes. Equivalence and split votes do not pass. This component-and-title review is separate from the earlier forty-view experiment.</p><table><thead><tr><th>Component</th><th>Retained preferences</th></tr></thead><tbody>${rows}</tbody></table><p><a href="${href(path.join(directory, "report.html"))}">Full AEK report, absolute quality gates and retained judgments</a></p></section>`;
  })
  .join("\n");
const sourceCards = references
  .map(
    (reference) =>
      `<li><a href="${escapeHtml(reference.page)}">${escapeHtml(reference.product)}</a>: ${escapeHtml(reference.note)}<br><code>SHA-256 ${reference.sha256}</code></li>`,
  )
  .join("");
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Program Cue — SaaS visual benchmark</title><style>body{margin:0;background:#f4f5f2;color:#1c2c26;font:15px/1.55 system-ui}main{max-width:1500px;padding:32px;margin:auto}h1{font-size:30px;line-height:1.2}h2{font-size:22px;margin:0 0 8px}section{background:white;border:1px solid #dce2dc;border-radius:10px;padding:24px;margin:24px 0}a{color:#82452f}p{max-width:110ch}.note{font-size:13px;color:#52645a}.result{font-weight:600}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:12px 8px;border-bottom:1px solid #dce2dc;vertical-align:top}td:first-child{width:48%}.pair{display:grid;grid-template-columns:1fr 1fr;gap:20px}figure{margin:0;background:#f7f8f5;border:1px solid #dce2dc;border-radius:6px;overflow:hidden}figcaption{padding:10px 14px;border-bottom:1px solid #dce2dc;font-weight:600}img{display:block;width:100%;height:auto;object-fit:contain;max-height:740px}details{margin:16px 0}summary{cursor:pointer;font-weight:600}.atlas{max-height:none}code{overflow-wrap:anywhere;font-size:12px}li{margin:10px 0}@media(max-width:760px){main{padding:16px}section{padding:16px}.pair{grid-template-columns:1fr}}</style><main><h1>Program Cue — published SaaS visual references</h1><p>Sol 6.1 / high · five blind votes per component comparison · frozen method ${saasMethod}.</p><p>This is a reference-driven visual improvement loop. Votes compare matched components, not features, brand identity, exact palette or theme. A split vote stays inconclusive; equivalence is not called improvement. Reference images have different publication dates and are not certified captures of the latest live products. Model judgments remain advisory pending independent calibration.</p>${improvement}${consistency}${panels}<section><h2>Reference provenance</h2><ul>${sourceCards}</ul></section></main></html>`;
fs.writeFileSync(path.join(output, "index.html"), html);
fs.writeFileSync(
  path.join(output, "benchmark-summary.json"),
  `${JSON.stringify({ method: saasMethod, cases }, null, 2)}\n`,
);
console.log(path.join(output, "index.html"));
