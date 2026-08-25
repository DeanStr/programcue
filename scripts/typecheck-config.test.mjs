import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../", import.meta.url);

async function readJson(path) {
  return JSON.parse(await readFile(new URL(path, root), "utf8"));
}

test("no-emit typechecking avoids declaration-producing composite builds", async () => {
  const [packageJson, rootConfig, nodeConfig, cloudflareConfig, videoConfig] =
    await Promise.all([
      readJson("package.json"),
      readJson("tsconfig.json"),
      readJson("tsconfig.node.json"),
      readJson("tsconfig.cloudflare.json"),
      readJson("tsconfig.video.json"),
    ]);

  assert.equal(
    packageJson.scripts["typecheck:generated"],
    "tsc -p tsconfig.node.json && tsc -p tsconfig.cloudflare.json && tsc -p tsconfig.video.json",
  );
  assert.equal(rootConfig.references, undefined);
  assert.notEqual(nodeConfig.compilerOptions.composite, true);
  assert.notEqual(cloudflareConfig.compilerOptions.composite, true);
  assert.notEqual(videoConfig.compilerOptions.composite, true);
});
