#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDirectory, "..");
const buildSecretsPath = path.join(repoRoot, "build", "server", ".dev.vars");

if (fs.existsSync(buildSecretsPath)) {
  fs.chmodSync(buildSecretsPath, 0o600);

  if (process.platform !== "win32") {
    const mode = fs.statSync(buildSecretsPath).mode & 0o777;
    if (mode !== 0o600) {
      throw new Error(
        `Expected ${path.relative(repoRoot, buildSecretsPath)} to have mode 600; received ${mode.toString(8)}.`,
      );
    }
  }

  console.log(
    `[build] Restricted ${path.relative(repoRoot, buildSecretsPath)} to its owner.`,
  );
}
