#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..");
const buildRoot = path.join(repoRoot, "build");

function findCopiedBuildSecrets(directory) {
  if (!fs.existsSync(directory)) return [];
  const matches = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.name === ".dev.vars") matches.push(entryPath);
    else if (entry.isDirectory())
      matches.push(...findCopiedBuildSecrets(entryPath));
  }
  return matches;
}

export function removeCopiedBuildSecrets(directory) {
  const copiedSecrets = findCopiedBuildSecrets(directory);
  for (const filePath of copiedSecrets)
    fs.rmSync(filePath, { recursive: true });

  const remaining = findCopiedBuildSecrets(directory);
  if (remaining.length) {
    throw new Error(
      `Failed to remove copied build secrets: ${remaining.join(", ")}.`,
    );
  }
  return copiedSecrets;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const removed = removeCopiedBuildSecrets(buildRoot);
  if (removed.length)
    console.log(
      `[build] Removed ${removed.length} copied .dev.vars file${removed.length === 1 ? "" : "s"} from the distributable output.`,
    );
}
