import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repositoryRoot, resolveE2eRuntime } from "./e2e-runtime.mjs";
import { resolvePackageExecutable } from "./package-executable.mjs";
import { runProcess } from "./process-runner.mjs";

const { inspectorPort, port, statePath } = resolveE2eRuntime();
const wranglerExecutable = resolvePackageExecutable("wrangler", "wrangler");
const accessCode =
  process.env.PROGRAM_CUE_EVALUATION_E2E_ACCESS_CODE ??
  "0123456789abcdef0123456789abcdef";
const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).trim();
const privateDirectory = await mkdtemp(
  join(tmpdir(), "program-cue-evaluation-e2e-"),
);
const variableFile = join(privateDirectory, "worker.env");
const signingSecret = randomBytes(48).toString("base64url");
const credential = () => randomBytes(48).toString("base64url");
const turnstileServer = createServer((request, response) => {
  request.resume();
  response.writeHead(200, { "content-type": "application/json" });
  response.end(
    JSON.stringify({
      success: true,
      hostname: "127.0.0.1",
      action: "application_start_anonymous",
    }),
  );
});
await new Promise((resolve, reject) => {
  turnstileServer.once("error", reject);
  turnstileServer.listen(0, "127.0.0.1", resolve);
});
const turnstileAddress = turnstileServer.address();
if (!turnstileAddress || typeof turnstileAddress === "string") {
  throw new Error("The evaluation E2E Siteverify fixture did not bind a port.");
}
const closeTurnstileServer = () =>
  new Promise((resolve, reject) =>
    turnstileServer.close((error) => (error ? reject(error) : resolve())),
  );

try {
  await rm(statePath, { recursive: true, force: true });
  const migration = await runProcess(
    wranglerExecutable,
    [
      "d1",
      "migrations",
      "apply",
      "program-cue-db",
      "--local",
      "--persist-to",
      statePath,
      "-c",
      "wrangler.demo.jsonc",
    ],
    { cwd: repositoryRoot, label: "evaluation E2E D1 migration" },
  );
  if (migration.code !== 0) {
    await closeTurnstileServer();
    await rm(privateDirectory, { recursive: true, force: true });
    process.exit(migration.code);
  }

  await writeFile(
    variableFile,
    [
      `BETTER_AUTH_SECRET=${signingSecret}`,
      `EVALUATION_ACCESS_CODE=${accessCode}`,
      `EVALUATION_SESSION_SECRET=${randomBytes(48).toString("base64url")}`,
      `ANONYMOUS_ITINERARY_SECRET=${randomBytes(48).toString("base64url")}`,
      "TURNSTILE_SECRET_KEY=1x0000000000000000000000000000000AA",
      `TURNSTILE_SITEVERIFY_URL=http://127.0.0.1:${turnstileAddress.port}/siteverify`,
      `RESEND_API_KEY=${credential()}`,
      `RESEND_WEBHOOK_SECRET=${credential()}`,
      `CALENDAR_CREDENTIALS_KEY=${credential()}`,
      `GOOGLE_CALENDAR_CLIENT_ID=${credential()}`,
      `GOOGLE_CALENDAR_CLIENT_SECRET=${credential()}`,
      `MICROSOFT_CALENDAR_CLIENT_ID=${credential()}`,
      `MICROSOFT_CALENDAR_CLIENT_SECRET=${credential()}`,
      `GOOGLE_AUTH_CLIENT_ID=${credential()}`,
      `GOOGLE_AUTH_CLIENT_SECRET=${credential()}`,
      `MICROSOFT_AUTH_CLIENT_ID=${credential()}`,
      `MICROSOFT_AUTH_CLIENT_SECRET=${credential()}`,
      `INTEGRATION_CREDENTIALS_KEY=${credential()}`,
      `WEBHOOK_CREDENTIALS_KEY=${credential()}`,
      `FILE_SCANNER_DISPATCH_SECRET=${credential()}`,
      `FILE_SCANNER_WEBHOOK_SECRET=${credential()}`,
      `R2_ACCESS_KEY_ID=${credential()}`,
      `R2_SECRET_ACCESS_KEY=${credential()}`,
      `D1_REST_API_TOKEN=${credential()}`,
      "",
    ].join("\n"),
    { encoding: "utf8", mode: 0o600 },
  );

  function workerArguments(mode) {
    const e2eOrigin = `http://127.0.0.1:${port}`;
    const argumentsList = [
      "dev",
      "build/server/index.js",
      "--config",
      mode === "evaluation"
        ? "wrangler.evaluation-e2e.jsonc"
        : "wrangler.demo.jsonc",
      "--assets",
      "build/client",
      "--persist-to",
      statePath,
      "--port",
      String(port),
      "--inspector-port",
      String(inspectorPort),
      "--var",
      `BETTER_AUTH_URL:${e2eOrigin}`,
      "--var",
      `CORS_ALLOWED_ORIGINS:${e2eOrigin}`,
      "--log-level",
      "warn",
      "--env-file",
      variableFile,
    ];
    if (mode === "evaluation") {
      argumentsList.push(
        "--var",
        "APP_ENV:production",
        "--var",
        "DEMO_MODE:false",
        "--var",
        "EVALUATION_MODE:true",
        "--var",
        `SOURCE_REVISION:${sourceRevision}`,
      );
    }
    return argumentsList;
  }

  function spawnWorker(mode) {
    return spawn(wranglerExecutable, workerArguments(mode), {
      cwd: repositoryRoot,
      stdio: "inherit",
    });
  }

  async function waitForDemoSeed(worker) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (worker.exitCode !== null) {
        throw new Error(
          `The demo seed Worker exited with code ${worker.exitCode}.`,
        );
      }
      try {
        const response = await fetch(`http://127.0.0.1:${port}/apply/form`);
        await response.arrayBuffer();
        if (response.ok) return;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(
      "The demo seed Worker did not become ready within 60 seconds.",
    );
  }

  async function stopWorker(worker) {
    if (worker.exitCode !== null) return;
    const exited = new Promise((resolve) => worker.once("exit", resolve));
    worker.kill("SIGTERM");
    await exited;
  }

  let evaluationWorker;
  const seedWorker = spawnWorker("demo");
  try {
    await waitForDemoSeed(seedWorker);
  } finally {
    await stopWorker(seedWorker);
  }

  const resetSql = `INSERT INTO audit_events (
  id, actor_kind, origin, metadata_version, organisation_id, event_id,
  actor_id, action, entity_type, entity_id, metadata_json, created_at
) VALUES (
  'evaluation-e2e-generation', 'system', 'internal', 1,
  'org-future-events', 'evt-foe-2025', 'evaluation-e2e',
  'evaluation.fixture.reset', 'event', 'evt-foe-2025', '{}', unixepoch()
)`;
  const reset = await runProcess(
    wranglerExecutable,
    [
      "d1",
      "execute",
      "program-cue-db",
      "--local",
      "--persist-to",
      statePath,
      "-c",
      "wrangler.demo.jsonc",
      "--command",
      resetSql,
    ],
    { cwd: repositoryRoot, label: "evaluation E2E reset generation" },
  );
  if (reset.code !== 0) {
    await closeTurnstileServer();
    await rm(privateDirectory, { recursive: true, force: true });
    process.exit(reset.code);
  }

  evaluationWorker = spawnWorker("evaluation");
  const forwardSignal = (signal) => evaluationWorker?.kill(signal);
  const onInterrupt = () => forwardSignal("SIGINT");
  const onTerminate = () => forwardSignal("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);

  try {
    const exit = await new Promise((resolve, reject) => {
      evaluationWorker.once("error", reject);
      evaluationWorker.once("exit", (code, signal) =>
        resolve({ code, signal }),
      );
    });
    if (exit.signal) process.kill(process.pid, exit.signal);
    else process.exitCode = exit.code ?? 1;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    await closeTurnstileServer();
    await rm(privateDirectory, { recursive: true, force: true });
  }
} catch (error) {
  if (turnstileServer.listening) await closeTurnstileServer();
  await rm(privateDirectory, { recursive: true, force: true });
  throw error;
}
