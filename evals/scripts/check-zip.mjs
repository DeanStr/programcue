import fs from "node:fs";
import path from "node:path";
import { inspectEvidenceFile } from "agent-eval-kit/evidence/files";
import { zipVerdict } from "./checks.mjs";
const directory = path.join(process.env.AEK_RUN_DIR, "PC-FILES");
const evidence = JSON.parse(fs.readFileSync(path.join(directory, "evidence.json"), "utf8"));
let result;
if (["blocked", "not_run"].includes(evidence.outcome))
  result = {
    verdict: "cannot_judge",
    reasoning: "File upload, scanner release or export was not reachable",
    evidenceRefs: [],
  };
else {
  const file = evidence.files?.find((entry) => entry.label === "latest-export");
  if (!file) {
    if (evidence.outcome !== "feature_not_found")
      throw new Error("Completed export scenario has no retained ZIP");
    result = {
      verdict: "not_found",
      reasoning: "The agent searched for the export capability and recorded its absence",
      evidenceRefs: ["PC-FILES/evidence.json"],
    };
  } else {
    const entries = inspectEvidenceFile(directory, file, "zip");
    const expected = JSON.parse(
      fs.readFileSync(new URL("../fixtures/files-expected.json", import.meta.url), "utf8"),
    );
    result = {
      verdict: zipVerdict(entries, expected),
      reasoning:
        "Compared actual ZIP entries against independent v2 bytes; exactly one selected latest file is required",
      evidenceRefs: [`PC-FILES/${file.path}`],
    };
  }
}
console.log(JSON.stringify({ ...result, confidence: "high" }));
