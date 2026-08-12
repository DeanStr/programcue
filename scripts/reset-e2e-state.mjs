import { rm } from "node:fs/promises";

import { resolveE2eRuntime } from "./e2e-runtime.mjs";

const { statePath } = resolveE2eRuntime();

await rm(statePath, { recursive: true, force: true });
