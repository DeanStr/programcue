import { rm } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const wranglerRoot = resolve(repositoryRoot, ".wrangler");
const e2eState = resolve(wranglerRoot, "e2e-state");

if (!e2eState.startsWith(`${wranglerRoot}${sep}`)) {
  throw new Error(`Refusing to reset an unexpected E2E state path: ${e2eState}`);
}

await rm(e2eState, { recursive: true, force: true });
