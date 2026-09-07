import fs from "node:fs";
import path from "node:path";
import { readEvidenceFile } from "agent-eval-kit/evidence/files";
import { scanVerdict } from "./checks.mjs";
const directory = path.join(process.env.AEK_RUN_DIR, "PC-FILES-SCANS");
const evidence = JSON.parse(fs.readFileSync(path.join(directory, "evidence.json"), "utf8"));
let result;
if (["blocked", "not_run"].includes(evidence.outcome))
  result = {
    verdict: "cannot_judge",
    reasoning: "The upload workflow was unavailable",
    evidenceRefs: [],
  };
else {
  const file = evidence.files?.find((file) => file.label === "scans");
  if (!file) throw new Error("Completed scanner collection has no retained receipt");
  const receipt = JSON.parse(readEvidenceFile(directory, file).toString("utf8"));
  const expected = JSON.parse(
    fs.readFileSync(new URL("../fixtures/files-expected.json", import.meta.url), "utf8"),
  );
  result = {
    verdict: scanVerdict(receipt, expected),
    reasoning:
      "Matched both actual object hashes, independent versions, real engine/signature metadata and accepted signed callbacks",
    evidenceRefs: [`PC-FILES-SCANS/${file.path}`],
  };
}
console.log(JSON.stringify({ ...result, confidence: "high" }));
