import assert from "node:assert/strict";
import { existsSync } from "node:fs";
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

// Compare maintained sources with the actual compiler programs, including
// imports, so new config/test directories cannot silently escape typechecking.
test("every maintained TypeScript file belongs to a typecheck program", async () => {
  const [{ default: ts }, { execFileSync }, { resolve }] = await Promise.all([
    import("typescript"),
    import("node:child_process"),
    import("node:path"),
  ]);
  const checked = new Set();
  for (const file of [
    "tsconfig.node.json",
    "tsconfig.cloudflare.json",
    "tsconfig.video.json",
  ]) {
    const config = ts.readConfigFile(file, ts.sys.readFile);
    assert.equal(config.error, undefined);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, ".");
    assert.deepEqual(parsed.errors, []);
    const program = ts.createProgram(parsed.fileNames, parsed.options);
    for (const source of program.getSourceFiles()) {
      checked.add(resolve(source.fileName));
    }
  }
  const maintained = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { encoding: "utf8" },
  )
    .split("\0")
    .filter((file) => /\.(?:ts|tsx|mts|cts)$/.test(file) && existsSync(file));
  assert.deepEqual(
    maintained.filter((file) => !checked.has(resolve(file))),
    [],
    "Maintained TypeScript files must be included in a compiler program",
  );
});
