import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { readEvidenceFile } from "agent-eval-kit/evidence/files";

const directory = path.join(process.env.AEK_RUN_DIR, "PC-FILES");
const evidence = JSON.parse(fs.readFileSync(path.join(directory, "evidence.json"), "utf8"));
let result;
if (["blocked", "not_run"].includes(evidence.outcome)) {
  result = {
    verdict: "cannot_judge",
    reasoning: "Version downloads were unavailable",
    evidenceRefs: [],
  };
} else {
  const expected = JSON.parse(
    fs.readFileSync(new URL("../fixtures/files-expected.json", import.meta.url), "utf8"),
  );
  if (
    !/^[a-f0-9]{64}$/.test(expected.previousSha256) ||
    !/^[a-f0-9]{64}$/.test(expected.latestSha256) ||
    expected.previousSha256 === expected.latestSha256
  )
    throw new Error("Version grading requires two distinct fixture hashes");
  const checks = [
    ["previous-version", expected.previousSha256],
    ["current-version", expected.latestSha256],
  ].map(([label, expectedHash]) => {
    const files = evidence.files?.filter((file) => file.label === label) ?? [];
    if (files.length !== 1) {
      if (files.length === 0 && evidence.outcome === "feature_not_found") return { label };
      throw new Error(`Version grading requires exactly one retained ${label} download`);
    }
    const file = files[0];
    // Verify retained artifact integrity, then hash its actual bytes against the
    // independent fixture. A recorded filename or reported digest cannot pass.
    const actual = createHash("sha256").update(readEvidenceFile(directory, file)).digest("hex");
    return { label, actual, expectedHash, ref: `PC-FILES/${file.path}` };
  });
  result = {
    verdict: checks.some((check) => !check.ref)
      ? "not_found"
      : checks.every((check) => check.actual === check.expectedHash)
        ? "pass"
        : "fail",
    reasoning: checks
      .map((check) =>
        check.ref
          ? `${check.label}: SHA-256 ${check.actual}; expected ${check.expectedHash}`
          : `${check.label}: capability not found in the recorded workflow`,
      )
      .join("; "),
    evidenceRefs: checks.map((check) => check.ref ?? "PC-FILES/evidence.json"),
  };
}
console.log(JSON.stringify({ ...result, confidence: "high" }));
