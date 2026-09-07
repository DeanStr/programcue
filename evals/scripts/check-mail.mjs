import fs from "node:fs";
import path from "node:path";
import { inspectEvidenceFile } from "agent-eval-kit/evidence/files";
import { mailVerdict } from "./checks.mjs";
const directory = path.join(process.env.AEK_RUN_DIR, "PC-MAIL-INSPECT");
const evidence = JSON.parse(fs.readFileSync(path.join(directory, "evidence.json"), "utf8"));
let result;
if (["blocked", "not_run"].includes(evidence.outcome))
  result = {
    verdict: "cannot_judge",
    reasoning: "The send or local observation was not exercised",
    evidenceRefs: [],
  };
else {
  const file = evidence.files?.find((entry) => entry.label === "receipt");
  if (!file) throw new Error("Completed mail inspection has no retained receipt");
  const receipt = inspectEvidenceFile(directory, file, "json");
  const expected = JSON.parse(
    fs.readFileSync(new URL("../fixtures/mail-expected.json", import.meta.url), "utf8"),
  );
  result = {
    verdict: mailVerdict(receipt, expected),
    reasoning:
      "Checked the correlated local receipt and required passages; this is not external delivery acceptance",
    evidenceRefs: [`PC-MAIL-INSPECT/${file.path}`],
  };
}
console.log(JSON.stringify({ ...result, confidence: "high" }));
