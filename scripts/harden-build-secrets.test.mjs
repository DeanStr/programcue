import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { removeCopiedBuildSecrets } from "./harden-build-secrets.mjs";

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

test("removes copied development secrets wherever the bundler places them", () => {
  const root = mkdtempSync(join(tmpdir(), "program-cue-build-secrets-"));
  temporaryRoots.push(root);
  const serverDirectory = join(root, "server");
  const nestedDirectory = join(root, "alternate", "output");
  mkdirSync(serverDirectory, { recursive: true });
  mkdirSync(nestedDirectory, { recursive: true });
  const firstCopy = join(serverDirectory, ".dev.vars");
  const secondCopy = join(nestedDirectory, ".dev.vars");
  const ordinaryAsset = join(serverDirectory, "index.js");
  writeFileSync(firstCopy, "SECRET=must-not-ship\n", { mode: 0o600 });
  writeFileSync(secondCopy, "SECRET=must-not-ship-either\n", { mode: 0o600 });
  writeFileSync(ordinaryAsset, "export {};\n");

  assert.deepEqual(
    removeCopiedBuildSecrets(root).sort(),
    [firstCopy, secondCopy].sort(),
  );
  assert.equal(existsSync(firstCopy), false);
  assert.equal(existsSync(secondCopy), false);
  assert.equal(existsSync(ordinaryAsset), true);
});

test("does nothing when a build contains no copied secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "program-cue-build-secrets-"));
  temporaryRoots.push(root);

  assert.deepEqual(removeCopiedBuildSecrets(root), []);
});
