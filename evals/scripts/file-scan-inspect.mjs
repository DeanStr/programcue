import fs from "node:fs";
import path from "node:path";
import { scanVerdict } from "./checks.mjs";
const context = JSON.parse(fs.readFileSync(process.env.AEK_COLLECT_CONTEXT, "utf8"));
if (process.env.PROGRAM_CUE_LOCAL_FILES !== "1")
  throw new Error("Use npm run regression:files to observe the isolated real scanner");
const expected = JSON.parse(fs.readFileSync(context.sources.expected.path, "utf8"));
const capture = new URL("../.agent-eval/file-services.jsonl", import.meta.url);
const deadline = Date.now() + 60_000;
let events;
while (true) {
  events = fs.readFileSync(capture, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  const error = events.find((event) => event.type === "scan-error");
  if (error) throw new Error(`Local scanner execution failed: ${error.error}`);
  if (events.filter((event) => event.type === "scan").length >= 2 || Date.now() >= deadline) break;
  await new Promise((resolve) => setTimeout(resolve, 500));
}
const receipt = {
  version: 1,
  source: "isolated-local-r2-and-real-clamav",
  scans: events.filter((event) => event.type === "scan"),
};
const verdict = scanVerdict(receipt, expected);
fs.writeFileSync(path.join(context.outputDir, "scans.json"), JSON.stringify(receipt));
console.log(
  JSON.stringify({
    version: 1,
    outcome: "completed",
    summary:
      verdict === "pass"
        ? "Both distinct PDF objects received real clean scans and accepted signed callbacks"
        : "The healthy bounded capture did not establish both required clean releases",
    observations: [
      "Local R2 transport with real ClamAV; hosted S3, HTTP scanner proxy and Workflow scheduling are not exercised.",
    ],
    files: [
      { label: "scans", path: "scans.json", filename: "scans.json", mediaType: "application/json" },
    ],
  }),
);
