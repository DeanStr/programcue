import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { aek } from "./runtime.mjs";
import { paintDifference } from "./ux-paint.mjs";
import { readCapture } from "./ux-contract.mjs";

if (!process.argv[2]) throw new Error("Usage: npm run ux:report -- REVIEW_DIRECTORY");
const directory = path.resolve(process.argv[2]);
const review = JSON.parse(fs.readFileSync(path.join(directory, "review.json")));
const contract = JSON.parse(fs.readFileSync(path.join(directory, "review-input.json")));
if (
  contract.policy !== "preference" ||
  contract.voting.minimumVotes !== 5 ||
  contract.voting.maximumVotes !== 5 ||
  contract.voting.agreement !== 1
)
  throw new Error(
    "The unanimous report requires preference policy and five unanimous votes per gate",
  );
if (review.protocol !== "native-aek-image-batch-v1")
  throw new Error("Regenerate reviews with the native AEK batch workflow");
let nativeInputs;
if (review.nativeBatch) {
  execFileSync(process.execPath, [aek, "verify", "--run", review.nativeBatch], {
    stdio: "inherit",
  });
  nativeInputs = JSON.parse(fs.readFileSync(path.join(review.nativeBatch, "batch-inputs.json")));
  const native = JSON.parse(fs.readFileSync(path.join(review.nativeBatch, "report.json")));
  review.results = review.results.filter((result) => result.status === "unchanged");
  for (const row of native.comparisons) {
    review.results.push({
      id: row.id,
      status: row.reusedFrom ? "reused" : row.status,
      exitCode: row.status === "complete" ? (row.failures.length ? 2 : 0) : 1,
      run: row.run ? path.join(review.nativeBatch, row.run) : null,
    });
  }
}
const before = readCapture(review.referenceDir);
const after = readCapture(review.candidateDir);
for (const row of nativeInputs?.cases ?? []) {
  const original = before.views.find((view) => view.id === row.id),
    current = after.views.find((view) => view.id === row.id);
  if (
    !original ||
    !current ||
    row.plan.reference.sha256 !== original.sha256 ||
    row.plan.candidate.sha256 !== current.sha256
  )
    throw new Error("Native batch images differ from the displayed captures");
  if (
    row.plan.panel.width !== current.viewport.width ||
    row.plan.panel.height !== current.viewport.height ||
    row.plan.policy !== contract.policy ||
    row.plan.criterion !== contract.relativeCriterion ||
    row.plan.absoluteCriterion !== contract.absoluteCriterion ||
    row.plan.judge.provider !== contract.judge ||
    row.plan.judge.model !== contract.model ||
    row.plan.judge.effort !== contract.effort ||
    row.plan.voting.minimumVotes !== 5 ||
    row.plan.voting.maximumVotes !== 5 ||
    row.plan.voting.agreement !== 1
  )
    throw new Error("Native batch changed the displayed judging contract");
}
const unchanged = new Set();
for (const view of after.views) {
  const original = before.views.find((item) => item.id === view.id);
  if (
    original.sha256 === view.sha256 ||
    (contract.paintNoise &&
      (await paintDifference(
        fs.readFileSync(path.join(review.referenceDir, original.file)),
        fs.readFileSync(path.join(review.candidateDir, view.file)),
      )))
  )
    unchanged.add(view.id);
}

const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
const href = (target) => escapeHtml(encodeURI(path.relative(directory, target)));
const results = new Map(review.results.map((result) => [result.id, result]));
const counts = { improved: 0, unchanged: 0, review: 0, pending: 0 };
const cards = after.views
  .map((view) => {
    const original = before.views.find((item) => item.id === view.id);
    const result = results.get(view.id);
    const state = view.failures.length
      ? "review"
      : unchanged.has(view.id)
        ? "unchanged"
        : !result
          ? "pending"
          : result.exitCode === 0
            ? "improved"
            : "review";
    counts[state]++;
    const label = {
      improved: "5/5 improvement + 5/5 quality",
      unchanged: "Unchanged",
      review: "Needs further revision",
      pending: "Judging pending",
    }[state];
    const run = result?.run;
    const report =
      run && fs.existsSync(path.join(run, "report.html"))
        ? `<a href="${href(path.join(run, "report.html"))}">Open AEK votes and findings</a>`
        : "";
    const failures = view.failures.length
      ? `<pre>${escapeHtml(view.failures.join("\n"))}</pre>`
      : "";
    return `<details class="case" data-state="${state}"><summary><span>${escapeHtml(view.id)}</span><span class="pill ${state}">${label}</span></summary><div class="content"><p>${escapeHtml(view.viewport.width)} × ${escapeHtml(view.viewport.height)} · ${escapeHtml(view.route)} ${result?.status === "reused" ? "· Retained verdict" : ""}</p><p>${report}</p><div class="pair"><figure><figcaption>Accepted phase baseline</figcaption><a href="${href(path.join(review.referenceDir, original.file))}"><img loading="lazy" src="${href(path.join(review.referenceDir, original.file))}" alt="${escapeHtml(view.id)} reference"></a></figure><figure><figcaption>Candidate</figcaption><a href="${href(path.join(review.candidateDir, view.file))}"><img loading="lazy" src="${href(path.join(review.candidateDir, view.file))}" alt="${escapeHtml(view.id)} candidate"></a></figure></div>${failures}</div></details>`;
  })
  .join("\n");
const browserFailures = after.views.filter((view) => view.failures.length).length;
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Program Cue visual review</title>
<style>body{font:15px/1.5 system-ui,sans-serif;color:#172824;background:#f5f5f2;margin:0}main{max-width:1500px;margin:auto;padding:32px}h1{font-size:30px;margin:0 0 8px}p{margin:8px 0;color:#4f625a}a{color:#80412c}nav{display:flex;gap:8px;flex-wrap:wrap;margin:24px 0}button{font:inherit;border:1px solid #bfc9c2;border-radius:6px;background:white;padding:8px 14px;cursor:pointer}button[aria-pressed=true]{background:#172824;color:white}.case{background:white;border:1px solid #d9dfda;border-radius:8px;margin:10px 0;overflow:hidden}.case[hidden]{display:none}summary{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px;cursor:pointer;font-weight:600}.pill{font-size:13px;padding:4px 9px;border-radius:4px;font-weight:500}.improved{background:#e7f1e8;color:#225a33}.review{background:#fff0e9;color:#813b23}.unchanged{background:#eef0ee;color:#4f625a}.pending{background:#edf0f7;color:#455874}.content{padding:0 16px 20px}.pair{display:grid;grid-template-columns:1fr 1fr;gap:16px}figure{margin:0;background:#f5f5f2;border:1px solid #d9dfda;border-radius:6px;overflow:hidden;text-align:center}figcaption{text-align:left;padding:10px 12px;font-weight:600;border-bottom:1px solid #d9dfda}img{display:block;max-width:100%;max-height:650px;object-fit:contain;margin:auto}pre{white-space:pre-wrap}.boundary{max-width:90ch;font-size:13px}.metrics{display:flex;gap:24px;flex-wrap:wrap;margin:24px 0}.metrics strong{display:block;font-size:28px}.metrics span{font-size:13px;color:#4f625a}@media(max-width:700px){main{padding:16px}.pair{grid-template-columns:1fr}summary{align-items:flex-start;flex-direction:column;gap:8px}}</style>
<main><h1>Program Cue visual review</h1><p>Reference capture revision: ${escapeHtml(before.source.revision.slice(0, 8))} · ${escapeHtml(contract.model)} / ${escapeHtml(contract.effort)} · ${after.views.length} views</p><p>${browserFailures ? `${browserFailures} views have blocking browser failures.` : "All candidate browser and accessibility checks passed."} Generated ${escapeHtml(new Date().toISOString())}.</p><div class="metrics">${Object.entries(
  counts,
)
  .map(([key, count]) => `<div><strong>${count}</strong><span>${escapeHtml(key)}</span></div>`)
  .join(
    "",
  )}</div><p class="boundary">A unanimous result requires five candidate preferences and five absolute visual-quality passes. Unchanged views are guards. Judgments cover these initial viewports and remain advisory pending independent calibration; workflow checks remain separate. Click an image to inspect its original pixels.</p><p>${review.nativeBatch ? `<a href="${href(path.join(review.nativeBatch, "report.html"))}">Native AEK batch report</a> · ` : ""}<a href="review.json">Matrix evidence</a> · <a href="${href(path.join(review.referenceDir, "capture.json"))}">Reference capture</a> · <a href="${href(path.join(review.candidateDir, "capture.json"))}">Candidate capture</a></p><nav aria-label="Filter views">${["all", "improved", "review", "unchanged", "pending"].map((key) => `<button type="button" data-filter="${key}" aria-pressed="${key === "all"}">${escapeHtml(key)}</button>`).join("")}</nav>${cards}</main><script>for(const button of document.querySelectorAll('[data-filter]'))button.addEventListener('click',()=>{for(const control of document.querySelectorAll('[data-filter]'))control.setAttribute('aria-pressed',String(control===button));for(const card of document.querySelectorAll('.case'))card.hidden=button.dataset.filter!=='all'&&card.dataset.state!==button.dataset.filter;});</script></html>`;
fs.writeFileSync(path.join(directory, "report.html"), html);
console.log(
  JSON.stringify({ report: path.join(directory, "report.html"), counts, browserFailures }),
);
