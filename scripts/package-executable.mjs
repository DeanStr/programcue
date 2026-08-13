import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);

/* Resolve through Node's package lookup instead of assuming every Git
   worktree has its own node_modules/.bin directory. */
export function resolvePackageExecutable(packageName, executableName) {
  const packageFile = require.resolve(`${packageName}/package.json`);
  const packageJson = JSON.parse(readFileSync(packageFile, "utf8"));
  const executable =
    typeof packageJson.bin === "string" && executableName === packageJson.name
      ? packageJson.bin
      : packageJson.bin?.[executableName];
  if (typeof executable !== "string")
    throw new Error(
      `${packageName} does not publish the ${executableName} executable.`,
    );
  return resolve(dirname(packageFile), executable);
}
