import assert from "node:assert/strict";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { test } from "node:test";

import { resolvePackageExecutable } from "./package-executable.mjs";

test("package executables resolve when dependencies are installed above a worktree", async () => {
  for (const [packageName, executableName] of [
    ["wrangler", "wrangler"],
    ["tsx", "tsx"],
    ["@playwright/test", "playwright"],
  ]) {
    await access(
      resolvePackageExecutable(packageName, executableName),
      constants.X_OK,
    );
  }
});

test("a package without the requested executable is rejected", () => {
  assert.throws(
    () => resolvePackageExecutable("yaml", "missing"),
    /does not publish the missing executable/,
  );
});
