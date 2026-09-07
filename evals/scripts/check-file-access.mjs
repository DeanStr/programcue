import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readEvidenceFile } from "agent-eval-kit/evidence/files";
import { quarantineVerdict, anonymousVerdict } from "./file-access-checks.mjs";
const kind = process.argv[2];
if (!["quarantine", "anonymous"].includes(kind))
  throw new Error("Expected quarantine or anonymous grading mode");
const directory = path.join(process.env.AEK_RUN_DIR, "PC-FILES-ACCESS");
const evidence = JSON.parse(fs.readFileSync(path.join(directory, "evidence.json"), "utf8"));
let result;
if (["blocked", "not_run"].includes(evidence.outcome))
  result = {
    verdict: "cannot_judge",
    reasoning: "The required file workflow was unavailable",
    evidenceRefs: [],
  };
else {
  function retained(label) {
    const file = evidence.files?.find((file) => file.label === label);
    if (!file) throw new Error(`Missing retained ${label} response evidence`);
    return { file, bytes: readEvidenceFile(directory, file) };
  }
  const access = retained("access");
  const receipt = JSON.parse(access.bytes.toString("utf8"));
  const refs = [`PC-FILES-ACCESS/${access.file.path}`];
  for (const label of ["clean", "infected", "anonymous"]) {
    const body = retained(label);
    if (
      body.bytes.length !== receipt.responses[label].bytes ||
      createHash("sha256").update(body.bytes).digest("hex") !== receipt.responses[label].sha256
    )
      throw new Error(`Retained ${label} body disagrees with HTTP receipt`);
    refs.push(`PC-FILES-ACCESS/${body.file.path}`);
  }
  const expected = JSON.parse(
    fs.readFileSync(new URL("../fixtures/file-access-expected.json", import.meta.url), "utf8"),
  );
  result = {
    verdict: (kind === "quarantine" ? quarantineVerdict : anonymousVerdict)(receipt, expected),
    reasoning:
      kind === "quarantine"
        ? "Compared real EICAR scan, accepted callback, current v2 server state and exact clean control bytes with the infected-version HTTP denial"
        : "Compared a successful authenticated download with the same URL requested using an empty anonymous cookie jar; only explicit denial or the local login redirect qualifies",
    evidenceRefs: refs,
  };
}
console.log(JSON.stringify({ ...result, confidence: "high" }));
