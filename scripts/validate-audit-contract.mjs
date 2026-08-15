import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const files = execFileSync(
  "rg",
  [
    "-l",
    "INSERT(?: OR IGNORE)? INTO audit_events",
    "app",
    "workers",
    "scripts/bootstrap-production.mjs",
    "scripts/verify-recovery.mjs",
  ],
  { encoding: "utf8" },
)
  .trim()
  .split("\n")
  .filter(Boolean);

const insertPattern =
  /INSERT(?: OR IGNORE)? INTO audit_events\s*\(([^)]+)\)\s*(?:VALUES\s*\(|SELECT)/gu;
const requiredColumns = [
  "organisation_id",
  "actor_kind",
  "origin",
  "metadata_version",
];
const failures = [];
let insertCount = 0;

for (const file of files) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(insertPattern)) {
    insertCount += 1;
    const columns = new Set(
      match[1]
        .split(",")
        .map((column) => column.trim())
        .filter(Boolean),
    );
    const missing = requiredColumns.filter((column) => !columns.has(column));
    if (missing.length === 0) continue;
    const line = source.slice(0, match.index).split("\n").length;
    failures.push(`${file}:${line} is missing ${missing.join(", ")}`);
  }
}

if (failures.length > 0) {
  throw new Error(`Audit provenance contract failed:\n${failures.join("\n")}`);
}
if (insertCount === 0) {
  throw new Error("Audit provenance validation found no runtime writers.");
}

console.log(
  `audit provenance validated: ${insertCount} writers across ${files.length} files`,
);
