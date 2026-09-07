import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { root } from "./runtime.mjs";

const source = process.argv[2];
if (!source || process.argv.length !== 3)
  throw new Error("Usage: npm run setup -- /absolute/path/to/agent-eval-kit");
const checkout = path.resolve(source);
const manifest = JSON.parse(fs.readFileSync(path.join(checkout, "package.json"), "utf8"));
if (manifest.name !== "agent-eval-kit")
  throw new Error("The supplied directory is not agent-eval-kit");
const destination = path.join(root, ".agent-eval/vendor");
fs.mkdirSync(destination, { recursive: true });
// Build explicitly, then pack without lifecycle output mixed into the JSON result.
execFileSync("npm", ["run", "build"], { cwd: checkout, stdio: "inherit" });
const [packed] = JSON.parse(
  execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", destination], {
    cwd: checkout,
    encoding: "utf8",
  }),
);
fs.renameSync(
  path.join(destination, packed.filename),
  path.join(destination, "agent-eval-kit.tgz"),
);
// Reinstall the local archive even when its version is unchanged during pre-release work.
fs.rmSync(path.join(root, "node_modules/agent-eval-kit"), { recursive: true, force: true });
execFileSync("npm", ["install", "--ignore-scripts", "file:.agent-eval/vendor/agent-eval-kit.tgz"], {
  cwd: root,
  stdio: "inherit",
});
