import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { aek, root } from "./runtime.mjs";
import { paintDifference } from "./ux-paint.mjs";
import { retainedTableVerdict } from "./table-verdict.mjs";
import { parseArgs } from "node:util";
import YAML from "yaml";
import {
  tableCases,
  tableMethod,
  attio,
  tablePanel,
  tableComparisonCriterion,
  tableQualityCriterion,
} from "./table-prepare.mjs";
import {
  sha256,
  readCapture,
  visualCriterion,
  absoluteCriterion,
  viewports,
} from "./ux-contract.mjs";

const { values } = parseArgs({
  options: {
    iteration: { type: "string", multiple: true },
    current: { type: "string" },
    review: { type: "string", multiple: true },
    consistency: { type: "string" },
    output: { type: "string" },
  },
});
if (!values.iteration?.length || !values.output)
  throw new Error(
    "Usage: table-report --iteration DIRECTORY [--iteration DIRECTORY] --output DIRECTORY [--current PREPARED_DIRECTORY]",
  );
const output = path.resolve(values.output);
const readInput = (directory) => {
  directory = path.resolve(directory);
  const input = JSON.parse(fs.readFileSync(path.join(directory, "table-input.json")));
  if (
    input.method !== tableMethod ||
    input.reference.sha256 !== attio.sha256 ||
    JSON.stringify(input.cases.map((item) => item.id)) !==
      JSON.stringify(tableCases.map((item) => item.id))
  )
    throw new Error("Cannot combine different table methods or reference assets");
  for (const item of input.cases)
    for (const frame of Object.values(item.inputs))
      if (sha256(fs.readFileSync(path.join(directory, frame.file))) !== frame.sha256)
        throw new Error("Table report input changed");
  return { directory, input };
};
const stages = values.iteration.map((directory) => {
  const stage = readInput(directory);
  const parent = path.join(stage.directory, "runs");
  const runs = fs.existsSync(parent)
    ? fs.readdirSync(parent).filter((name) => fs.statSync(path.join(parent, name)).isDirectory())
    : [];
  if (runs.length > 1)
    throw new Error("Expected one native run per experiment; resume execution errors");
  const run = runs[0] && path.join(parent, runs[0]);
  if (run) execFileSync(process.execPath, [aek, "verify", "--run", run], { stdio: "inherit" });
  const batch = path.join(stage.directory, "comparison");
  let comparisons = [],
    batchInputs;
  if (fs.existsSync(path.join(batch, "report.json"))) {
    execFileSync(process.execPath, [aek, "verify", "--run", batch], { stdio: "inherit" });
    comparisons = JSON.parse(fs.readFileSync(path.join(batch, "report.json"))).comparisons;
    batchInputs = JSON.parse(fs.readFileSync(path.join(batch, "batch-inputs.json")));
    if (batchInputs.kitVersion !== "0.7.0")
      throw new Error("Table batch uses a different evaluator version");
    for (const row of batchInputs.cases) {
      const item = stage.input.cases.find((item) => item.id === row.id);
      if (
        !item ||
        row.plan.candidate.sha256 !== item.inputs.candidate.sha256 ||
        row.plan.reference.sha256 !== item.inputs.reference.sha256
      )
        throw new Error("Native batch images differ from the prepared table inputs");
      if (
        row.plan.criterion !== tableComparisonCriterion(item, stage.input.mode === "improvement") ||
        row.plan.panel.width !== tablePanel.width ||
        row.plan.panel.height !== tablePanel.height
      )
        throw new Error("Native table criterion or panel changed");
      if (
        row.plan.judge.provider !== "codex" ||
        row.plan.judge.model !== "gpt-6.1-sol" ||
        row.plan.judge.effort !== "high" ||
        row.plan.voting.minimumVotes !== 5 ||
        row.plan.voting.maximumVotes !== 5 ||
        row.plan.voting.agreement !== 1 ||
        row.plan.policy !== (stage.input.mode === "improvement" ? "preference" : "non_regression")
      )
        throw new Error("Native batch changed the table judging contract");
    }
  }
  const qualityReport = run && JSON.parse(fs.readFileSync(path.join(run, "report.json")));
  if (qualityReport && qualityReport.kitVersion !== "0.7.0")
    throw new Error("Table quality uses a different evaluator version");
  if (run) {
    const sources = qualityReport.receipt.inputs.collectorSources;
    for (const id of stage.input.selectedCases) {
      const item = stage.input.cases.find((item) => item.id === id);
      if (
        sources[`${id}/manifest`]?.sha256 !==
          sha256(fs.readFileSync(path.join(stage.directory, "table-input.json"))) ||
        ["candidate", "fullview", "mobile"].some(
          (label) => sources[`${id}/${label}`]?.sha256 !== item.inputs[label].sha256,
        )
      )
        throw new Error("Native table quality inputs changed from their sealed originals");
    }
    const config = YAML.parse(
      fs.readFileSync(path.join(run, "inputs/config.resolved.yaml"), "utf8"),
    );
    const spec = YAML.parse(fs.readFileSync(path.join(run, "inputs/specs/tables.yaml"), "utf8"));
    if (
      config.judge.provider !== "codex" ||
      config.judge.model !== "gpt-6.1-sol" ||
      config.judge.effort !== "high" ||
      config.judge.voting.minimumVotes !== 5 ||
      config.judge.voting.maximumVotes !== 5 ||
      config.judge.voting.agreement !== 1 ||
      spec.rubric.some((item) => item.criterion !== tableQualityCriterion)
    )
      throw new Error("Native table quality changed the frozen judging contract");
  }
  return { ...stage, run, batch, comparisons, qualityReport };
});
const current = readInput(values.current ?? values.iteration.at(-1));
const baseline = stages[0];
let consistency;
if (values.consistency) {
  const directory = path.resolve(values.consistency),
    data = JSON.parse(fs.readFileSync(path.join(directory, "consistency.json")));
  if (
    !data.consistent ||
    data.captureSha256 !== sha256(JSON.stringify(readCapture(current.input.captureDir)))
  )
    throw new Error("Title audit does not match the current capture");
  // Report the measured signature rather than restating the intended sizes.
  const signature = (device) => {
    const { fontSize, fontWeight } = data.groups[device].views[0].heading;
    return `${fontSize} weight ${fontWeight}`;
  };
  consistency = { directory, data, desktop: signature("desktop"), mobile: signature("mobile") };
}

const viewReviews = (values.review ?? []).map((directory) => {
  directory = path.resolve(directory);
  const review = JSON.parse(fs.readFileSync(path.join(directory, "review.json")));
  readCapture(review.candidateDir);
  readCapture(review.referenceDir);
  if (!review.nativeBatch) return { directory, rows: [], inputs: [] };
  execFileSync(process.execPath, [aek, "verify", "--run", review.nativeBatch], {
    stdio: "inherit",
  });
  const inputs = JSON.parse(fs.readFileSync(path.join(review.nativeBatch, "batch-inputs.json")));
  if (inputs.kitVersion !== "0.7.0") throw new Error("Viewport review uses a different evaluator");
  return {
    directory,
    rows: JSON.parse(fs.readFileSync(path.join(review.nativeBatch, "report.json"))).comparisons,
    inputs: inputs.cases,
  };
});
function viewportGate(item, selected, original) {
  const checks = ["desktop", "mobile"].map((device) => {
    const id = item.view.replace("-desktop", `-${device}`),
      label = device === "desktop" ? "fullview" : "mobile";
    for (const review of [...viewReviews].reverse()) {
      const source = review.inputs.find((row) => row.id === id),
        row = review.rows.find((row) => row.id === id);
      if (
        !source ||
        source.plan.candidate.sha256 !== selected.inputs[label].sha256 ||
        source.plan.reference.sha256 !== original.inputs[label].sha256
      )
        continue;
      const plan = source.plan;
      if (
        plan.panel.width !== viewports[device].width ||
        plan.panel.height !== viewports[device].height ||
        plan.policy !== "preference" ||
        plan.criterion !== visualCriterion("overall") ||
        plan.absoluteCriterion !== absoluteCriterion ||
        plan.judge.provider !== "codex" ||
        plan.judge.model !== "gpt-6.1-sol" ||
        plan.judge.effort !== "high" ||
        plan.voting.minimumVotes !== 5 ||
        plan.voting.maximumVotes !== 5 ||
        plan.voting.agreement !== 1
      )
        throw new Error("Viewport review changed the frozen judging contract");
      const items = row?.report?.areas.flatMap((area) => area.items) ?? [];
      const preference = items.find((item) => item.id === "COMPARISON")?.votes?.counts ?? {};
      const quality = items.find((item) => item.id === "ACCEPTABLE")?.votes?.counts ?? {};
      return {
        device,
        review: review.directory,
        preference,
        quality,
        passed: row.status === "complete" && preference.win === 5 && quality.pass === 5,
      };
    }
    return { device, passed: false, pending: true };
  });
  return { passed: checks.every((check) => check.passed), checks };
}

const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const href = (file) => escapeHtml(encodeURI(path.relative(output, file)));
const quality = (stage, id) =>
  stage.qualityReport?.areas
    .flatMap((area) => area.items)
    .find((item) => item.id === `QUALITY-${id}`)?.votes?.counts ?? {};
const cases = await Promise.all(
  tableCases.map(async (item) => {
    const selected = current.input.cases.find((entry) => entry.id === item.id);
    const original = baseline.input.cases.find((entry) => entry.id === item.id);
    const history = stages
      .map((stage) => {
        if (stage.input.selectedCases && !stage.input.selectedCases.includes(item.id)) return null;
        const input = stage.input.cases.find((entry) => entry.id === item.id);
        const row = stage.comparisons.find((row) => row.id === item.id);
        const nativeRun = row?.run && path.join(stage.batch, row.run);
        const folder = nativeRun && path.join(nativeRun, "areas/image/pairwise/COMPARISON/IMAGE/1");
        const file = folder && path.join(folder, "comparison.json");
        const data =
          row?.status === "complete" && file && fs.existsSync(file)
            ? JSON.parse(fs.readFileSync(file))
            : null;
        return {
          name: path.basename(stage.directory),
          directory: stage.directory,
          run: nativeRun,
          qualityRun: stage.run,
          batch: stage.batch,
          reusedFrom: row?.reusedFrom,
          mode: stage.input.mode,
          referenceCaptureDir: stage.input.referenceCaptureDir,
          input,
          comparison: folder,
          matchesCurrent: input.inputs.candidate.sha256 === selected.inputs.candidate.sha256,
          restoredReference:
            stage.input.mode === "improvement" &&
            input.inputs.candidate.sha256 !== selected.inputs.candidate.sha256 &&
            input.inputs.reference.sha256 === selected.inputs.candidate.sha256,
          qualityMatchesCurrent: ["candidate", "fullview", "mobile"].every(
            (label) => input.inputs[label].sha256 === selected.inputs[label].sha256,
          ),
          quality: quality(stage, item.id),
          data,
        };
      })
      .filter(Boolean);
    const unchangedPaint =
      selected.inputs.candidate.sha256 !== original.inputs.candidate.sha256
        ? await paintDifference(
            fs.readFileSync(path.join(current.directory, selected.inputs.candidate.file)),
            fs.readFileSync(path.join(baseline.directory, original.inputs.candidate.file)),
          )
        : null;
    const viewport = viewportGate(item, selected, original);
    return {
      ...item,
      selected,
      original,
      history,
      unchangedPaint,
      viewport,
      ...retainedTableVerdict(selected, original, history, {
        unchangedPaint,
        viewportPassed: viewport.passed,
      }),
    };
  }),
);
fs.mkdirSync(output, { recursive: true });
const panel = (file, label) =>
  `<figure><figcaption>${escapeHtml(label)}</figcaption><a href="${href(file)}"><img src="${href(file)}" loading="lazy" alt="${escapeHtml(label)}"></a></figure>`;
const cards = cases
  .map((item) => {
    const status = item.unchanged
      ? item.unchangedPaint
        ? `Previous accepted component retained · bounded paint guard (${item.unchangedPaint.changedPixels} pixels, maximum delta ${item.unchangedPaint.maximumChannelDelta})`
        : "Previous accepted component retained"
      : item.accepted
        ? "Retained: 5/5 improvement preferences and 5/5 quality passes"
        : item.componentAccepted
          ? "Component gates passed; full desktop/mobile preference gate not satisfied"
          : "Candidate: strict improvement gate not satisfied";
    const rows = item.history
      .map((stage) => {
        const counts = stage.data?.decision.counts;
        const verdict = counts
          ? `${counts.win ?? 0} candidate · ${counts.equivalent ?? 0} equivalent · ${counts.loss ?? 0} reference · ${counts.abstain ?? 0} abstain`
          : "Pending";
        const label = stage.data
          ? `<a href="${href(path.join(stage.comparison, "comparison.html"))}">${escapeHtml(stage.name)}</a>`
          : escapeHtml(stage.name);
        return `<tr><td>${label}<br>${escapeHtml(stage.mode)}${stage.reusedFrom ? " · reused sealed verdict; no new pairwise calls" : ""}${stage.matchesCurrent ? " · matches current desktop crop" : stage.restoredReference ? " · withdrawn; previous component restored" : " · historical candidate"}${stage.referenceCaptureDir ? `<br>Compared with ${escapeHtml(path.basename(stage.referenceCaptureDir))}` : ""}</td><td>${verdict}</td><td>${stage.quality.pass ?? 0}/5 pass${Object.entries(
          stage.quality,
        )
          .filter(([name]) => name !== "pass")
          .map(([name, count]) => ` · ${count} ${escapeHtml(name)}`)
          .join(
            "",
          )}<br>${stage.qualityMatchesCurrent ? "Current desktop/mobile views" : "Historical desktop/mobile views"}</td></tr>`;
      })
      .join("");
    const viewportRows = viewReviews
      .flatMap((review) =>
        review.rows
          .filter((row) => row.id.startsWith(item.view.replace("-desktop", "-")))
          .map((row) => {
            const source = review.inputs.find((input) => input.id === row.id),
              device = row.id.endsWith("-mobile") ? "mobile" : "desktop";
            const currentPixels =
              source.plan.candidate.sha256 ===
              item.selected.inputs[device === "mobile" ? "mobile" : "fullview"].sha256;
            const judgments = row.report?.areas.flatMap((area) => area.items) ?? [];
            const preferences =
              judgments.find((item) => item.id === "COMPARISON")?.votes?.counts ?? {};
            const quality = judgments.find((item) => item.id === "ACCEPTABLE")?.votes?.counts ?? {};
            return `<tr><td><a href="${href(path.join(review.directory, "report.html"))}">${escapeHtml(path.basename(review.directory))} · ${device}</a><br>${row.reusedFrom ? "Reused sealed votes; no new calls" : "New votes"}${currentPixels ? " · current pixels" : " · historical candidate"}</td><td>${preferences.win ?? 0} candidate · ${preferences.equivalent ?? 0} equivalent · ${preferences.loss ?? 0} reference · ${preferences.abstain ?? 0} abstain</td><td>${quality.pass ?? 0}/5 pass</td></tr>`;
          }),
      )
      .join("");
    const reasoning = item.history
      .filter((stage) => stage.data)
      .map(
        (stage) =>
          `<details><summary>${escapeHtml(stage.name)} — all retained votes</summary><ol>${stage.data.votes.map((vote) => `<li>${escapeHtml(vote.raw.reasoning)}</li>`).join("")}</ol></details>`,
      )
      .join("");
    return `<section><h2>${escapeHtml(item.title)}</h2><p class="status">${status}</p><p>${item.unchanged ? "Unchanged visual guard; no new improvement claim." : item.viewport.checks.map((check) => `${check.device}: ${check.pending ? "pending" : `${check.preference.win ?? 0}/5 improvement · ${check.quality.pass ?? 0}/5 quality`}`).join(" · ")}</p><div class="pair">${panel(path.join(baseline.directory, item.original.inputs.candidate.file), "Accepted phase baseline")}${panel(path.join(current.directory, item.selected.inputs.candidate.file), "Current candidate")}</div><details><summary>Mobile before/after — quality and browser guards</summary><div class="pair">${panel(path.join(baseline.directory, item.original.inputs.mobile.file), "Baseline mobile view")}${panel(path.join(current.directory, item.selected.inputs.mobile.file), "Current mobile view")}</div></details><details><summary>Published Attio reference at the assumed 2x export scale</summary>${panel(path.join(baseline.directory, item.original.inputs.reference.file), "Official published Attio reference")}</details><div class="scroll"><table><thead><tr><th>Experiment</th><th>Blind preferences</th><th>Desktop/mobile quality</th></tr></thead><tbody>${rows}</tbody></table></div>${viewportRows ? `<h3>Full-page viewport history</h3><div class="scroll"><table><thead><tr><th>Viewport experiment</th><th>Strict preferences</th><th>Absolute quality</th></tr></thead><tbody>${viewportRows}</tbody></table></div>` : ""}${reasoning}</section>`;
  })
  .join("");
const links = stages
  .map((stage) =>
    [
      [stage.batch, "native pairwise batch", "report.html"],
      [stage.run, "desktop/mobile quality", "report.html"],
    ]
      .filter(([directory, , file]) => directory && fs.existsSync(path.join(directory, file)))
      .map(
        ([directory, label, file]) =>
          `<li><a href="${href(path.join(directory, file))}">${escapeHtml(path.basename(stage.directory))} — ${label}</a></li>`,
      )
      .join(""),
  )
  .join("");
fs.writeFileSync(
  path.join(output, "index.html"),
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Program Cue — table visual improvement loop</title><style>body{margin:0;background:#f4f4ef;color:#182522;font:15px/1.55 system-ui}main{max-width:1450px;margin:auto;padding:28px}h1{font-size:30px;line-height:1.2}h2{font-size:22px;margin:0}section{background:white;border:1px solid #e0e1d8;border-radius:10px;padding:24px;margin:24px 0}.pair{display:grid;grid-template-columns:1fr 1fr;gap:20px}figure{margin:0}figcaption{font-weight:600;margin:8px 0}img{width:100%;height:auto;display:block}a{color:#93472f}p{max-width:110ch}.status{font-weight:600}table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:12px 8px;border-bottom:1px solid #e0e1d8;vertical-align:top}.scroll{overflow:auto}details{margin:18px 0}summary{cursor:pointer;font-weight:600}li{margin:10px 0}code{overflow-wrap:anywhere}@media(max-width:760px){main{padding:16px}section{padding:16px}.pair{grid-template-columns:1fr}}</style><main><h1>Program Cue — table visual improvement loop</h1><p>AEK 0.7.0 · Codex gpt-6.1-sol / high · five blind votes · unanimous improvement and independent quality requirements. Browser and accessibility checks remain separate constraints.</p><p><strong>Method: ${tableMethod}.</strong> ${escapeHtml(current.input.scaleNote)} AEK 0.6.4 results remain historical and are not reused as 0.7.0 votes. Native pixels and judging criteria are preserved; the evaluator identity is new. No claim of latest-live-product or whole-product parity is made.</p><p><a href="${escapeHtml(attio.page)}">Official Attio source</a> · <a href="${escapeHtml(attio.asset)}">Original image</a><br>${escapeHtml(attio.note)}<br>Asset SHA-256: <code>${attio.sha256}</code></p><p>Current capture: ${escapeHtml(current.input.captureDir)}. A retained comparison applies only to an identical normalized source frame. Equivalence is not an improvement. Model judgments remain advisory pending independent calibration.</p>${consistency ? `<section><h2>Shared page titles</h2><p>The twelve ordinary administration pages retain one typography signature per viewport: ${escapeHtml(consistency.desktop)} on desktop and ${escapeHtml(consistency.mobile)} on mobile. ${escapeHtml(consistency.data.scope)}</p>${panel(path.join(consistency.directory, "responsive.png"), "All twelve ordinary titles at desktop and mobile sizes")}<p><a href="${href(path.join(consistency.directory, "consistency.json"))}">Title metrics and provenance</a></p></section>` : ""}${cards}<section><h2>Evidence</h2><ul>${links}${viewReviews.map((review) => `<li><a href="${href(path.join(review.directory, "report.html"))}">${escapeHtml(path.basename(review.directory))} — whole-page viewport review</a></li>`).join("")}</ul><p><a href="table-summary.json">Machine-readable history</a> · <a href="${href(path.join(root, ".agent-eval/ui-table-polish/report/index.html"))}">Historical AEK 0.6.4 table report</a></p></section></main></html>`,
);
fs.writeFileSync(
  path.join(output, "table-summary.json"),
  `${JSON.stringify({ method: tableMethod, current: current.directory, baseline: baseline.directory, cases }, null, 2)}\n`,
);
console.log(path.join(output, "index.html"));
