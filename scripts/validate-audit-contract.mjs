import { readdirSync, readFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sourceExtensions = new Set([
  ".cjs",
  ".js",
  ".jsx",
  ".mjs",
  ".ts",
  ".tsx",
]);
const auditInsertPattern = /INSERT(?: OR IGNORE)? INTO audit_events/u;

function listSourceFiles(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    if (entry.isFile() && sourceExtensions.has(extname(entry.name)))
      return [path];
    return [];
  });
}

const files = [
  ...listSourceFiles(join(repositoryRoot, "app")),
  ...listSourceFiles(join(repositoryRoot, "workers")),
  join(repositoryRoot, "scripts/bootstrap-production.mjs"),
  join(repositoryRoot, "scripts/verify-recovery.mjs"),
]
  .filter((file) => auditInsertPattern.test(readFileSync(file, "utf8")))
  .sort();

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
    const displayFile = relative(repositoryRoot, file).replaceAll("\\", "/");
    failures.push(`${displayFile}:${line} is missing ${missing.join(", ")}`);
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
