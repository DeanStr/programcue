import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { resolveE2eRuntime } from "./e2e-runtime.mjs";

const { inspectorPort, port, statePath } = resolveE2eRuntime();
const e2ePort = String(port);

const signingSecret = randomBytes(48).toString("base64url");
const privateDirectory = await mkdtemp(join(tmpdir(), "program-cue-e2e-"));
const variableFile = join(privateDirectory, "worker.env");
// Keep the signing secret ephemeral even though the checked-in demo profile is
// otherwise the real browser-test runtime. Mailpit remains its explicit local
// capture provider; an unavailable provider still fails visibly.
await writeFile(variableFile, `BETTER_AUTH_SECRET=${signingSecret}\n`, {
  encoding: "utf8",
  mode: 0o600,
});

const wrangler = spawn(
  resolve("node_modules/.bin/wrangler"),
  [
    "dev",
    "build/server/index.js",
    "--config",
    "wrangler.demo.jsonc",
    "--assets",
    "build/client",
    "--persist-to",
    statePath,
    "--port",
    e2ePort,
    "--inspector-port",
    String(inspectorPort),
    "--var",
    `BETTER_AUTH_URL:http://localhost:${e2ePort}`,
    "--var",
    `CORS_ALLOWED_ORIGINS:http://localhost:${e2ePort},http://127.0.0.1:${e2ePort}`,
    "--log-level",
    "warn",
    "--env-file",
    variableFile,
  ],
  { stdio: "inherit" },
);

const signalForwarders = new Map(
  ["SIGINT", "SIGTERM"].map((signal) => [
    signal,
    () => wrangler.kill(signal),
  ]),
);
for (const [signal, forward] of signalForwarders)
  process.on(signal, forward);

let exit;
try {
  exit = await new Promise((resolveExit, reject) => {
    wrangler.once("error", reject);
    wrangler.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
} finally {
  await rm(privateDirectory, { recursive: true, force: true });
  for (const [signal, forward] of signalForwarders)
    process.removeListener(signal, forward);
}

if (exit.signal) {
  process.kill(process.pid, exit.signal);
} else {
  process.exitCode = exit.code ?? 1;
}
