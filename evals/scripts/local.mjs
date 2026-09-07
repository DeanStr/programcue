import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { aek, origin, project, root, run, stopGroup, waitForWorker } from "./runtime.mjs";
import { prepareLocal } from "./prepare-local.mjs";

const args = process.argv.slice(2);
const special = args.filter((arg) =>
  [
    "--smoke",
    "--smoke-product",
    "--smoke-files",
    "--files-regression",
    "--prepare-only",
    "--regression",
  ].includes(arg),
);
if (special.length > 1)
  throw new Error(
    "Choose one of --smoke, --smoke-product, --smoke-files, --files-regression, --prepare-only, --regression",
  );
const mode = special[0];
const regression = ["--regression", "--files-regression"].includes(mode);
let fileServices = mode === "--smoke-files";
const forwarded = args.filter((arg) => arg !== mode);
if (
  mode === "--files-regression" &&
  forwarded.some((arg) => /^(--areas|--scenarios|--scenario)(=|$)/.test(arg))
)
  throw new Error("The file regression fixes its selection to file-integrity");
if (forwarded.some((arg) => /^(--config|--url|--resume)(=|$)/.test(arg)))
  throw new Error(
    "The fresh local coordinator fixes its target and config; resume against a still-running --prepare-only target using aek directly",
  );
if (mode?.startsWith("--smoke") && forwarded.length)
  throw new Error("Smokes accept no evaluation flags");
if (mode === "--prepare-only" && forwarded.length)
  throw new Error("--prepare-only accepts no evaluation flags");
const evaluationCommand = [
  aek,
  "run",
  "--config",
  regression ? "evalkit.regression.yaml" : "evalkit.local.yaml",
  "--include-optional",
  ...(mode === "--files-regression" ? ["--areas", "file-integrity"] : []),
  ...forwarded,
];
if (!mode?.startsWith("--smoke") && mode !== "--prepare-only") {
  // Validate before locks, builds, service startup or fixture preparation.
  const output = await run(
    process.execPath,
    [
      ...evaluationCommand,
      ...(args.includes("--dry-run") ? [] : ["--dry-run"]),
      ...(args.includes("--json") ? [] : ["--json"]),
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const plan = JSON.parse(output);
  if (
    plan.version !== 1 ||
    !Array.isArray(plan.areas) ||
    plan.areas.some(
      (area) =>
        typeof area.id !== "string" ||
        !Array.isArray(area.scenarios) ||
        area.scenarios.some((scenario) => typeof scenario.id !== "string"),
    )
  )
    throw new Error("Invalid AEK planning response");
  fileServices =
    regression &&
    plan.areas.some((area) => area.id === "file-integrity" && area.scenarios.length > 0);
  if (args.includes("--dry-run")) {
    console.log(output.trim());
    process.exit(0);
  }
  if (args.includes("--json")) throw new Error("--json requires --dry-run");
}
const isolatedWorker = fileServices || regression || mode === "--smoke-product";
fs.mkdirSync(path.join(root, ".agent-eval"), { recursive: true, mode: 0o700 });
const lock = path.join(root, ".agent-eval/local.lock");
const fd = fs.openSync(lock, "wx", 0o600);
fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
fs.closeSync(fd);
let worker;
let workerExit;
let workerOutcome;
let interrupted;
const startup = new AbortController();
const stop = (signal) => {
  interrupted = signal;
  startup.abort(new Error(`Local startup interrupted (${signal})`));
  if (worker?.pid) {
    try {
      process.kill(-worker.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
};
const onInterrupt = () => stop("SIGINT");
const onTerminate = () => stop("SIGTERM");
process.on("SIGINT", onInterrupt);
process.on("SIGTERM", onTerminate);
async function available(port) {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  await new Promise((resolve) => server.close(resolve));
}
const state = `.wrangler/e2e-state-aek-${randomUUID()}`;
const fileContainer = `programcue-eval-clamav-${randomUUID()}`;
const logPath = path.join(root, ".agent-eval/local-worker.log");
try {
  await available(5188);
  await available(15188);
  const mail = await fetch("http://127.0.0.1:8025/api/v1/messages?limit=1", {
    redirect: "error",
    signal: AbortSignal.timeout(5000),
  });
  if (!mail.ok)
    throw new Error("Start Programcue's Mailpit capture service before local evaluation");
  const mailbox = await mail.json();
  if (!Number.isInteger(mailbox.total) || mailbox.total > 1000)
    throw new Error(
      "Mailpit must be healthy with at most 1000 messages; use a dedicated capture instance",
    );
  if (fileServices) {
    await run("docker", ["build", "-t", "programcue-eval-clamav:local", "scanner/container"], {
      cwd: project,
    });
  }
  if (isolatedWorker) {
    // Evaluation receipts identify current source, so always rebuild that source.
    await run(process.execPath, ["scripts/prepare-e2e.mjs"], {
      cwd: project,
      env: {
        ...process.env,
        PROGRAM_CUE_E2E_STATE: state,
        PROGRAM_CUE_E2E_SKIP_BUILD: "0",
      },
    });
  }
  const log = fs.openSync(logPath, "w", 0o600);
  worker = spawn(
    isolatedWorker ? process.execPath : "npm",
    isolatedWorker
      ? ["--import", "tsx", path.join(root, "scripts/serve-local.mjs")]
      : ["run", "serve:e2e"],
    {
      cwd: project,
      detached: true,
      stdio: isolatedWorker ? ["ignore", log, log, "ipc"] : ["ignore", log, log],
      env: {
        ...process.env,
        PROGRAM_CUE_E2E_PORT: "5188",
        PROGRAM_CUE_E2E_INSPECTOR_PORT: "15188",
        PROGRAM_CUE_E2E_STATE: state,
        PROGRAM_CUE_E2E_SKIP_BUILD: "0",
        PROGRAM_CUE_LOCAL_FILES: fileServices ? "1" : "0",
        PROGRAM_CUE_LOCAL_FILE_CONTAINER: fileContainer,
      },
    },
  );
  workerExit = new Promise((resolve) => {
    worker.once("exit", (code, signal) => resolve({ code, signal }));
    worker.once("error", (error) => resolve({ error }));
  });
  fs.closeSync(log);
  console.log(`Starting isolated Programcue at ${origin}; log: ${logPath}`);
  await waitForWorker(`${origin}/demo`, { worker, signal: startup.signal }).catch((error) => {
    throw new Error(`${error.message}; inspect ${logPath}`, { cause: error });
  });
  await prepareLocal();
  if (mode === "--prepare-only") {
    console.log(
      "Local target is ready. Run aek in another terminal; Ctrl+C stops this Worker. Do not restart/reset it to resume a run.",
    );
    await new Promise((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
      worker.once("exit", resolve);
    });
  } else {
    const command = ["--smoke-product", "--smoke-files"].includes(mode)
      ? [
          path.join(project, "node_modules/@playwright/test/cli.js"),
          "test",
          "--config",
          path.join(root, "playwright.config.mjs"),
          ...(mode === "--smoke-files" ? ["--grep", "real uploads"] : []),
        ]
      : mode === "--smoke"
        ? [path.join(root, "scripts/smoke-local.mjs")]
        : evaluationCommand;
    const evaluation = new AbortController();
    const workerExited = () =>
      evaluation.abort(new Error(`Local Worker exited; inspect ${logPath}`));
    worker.once("exit", workerExited);
    if (worker.exitCode !== null || worker.signalCode || interrupted) workerExited();
    try {
      await run(process.execPath, command, {
        cwd: root,
        stdio: "inherit",
        signal: evaluation.signal,
        env: {
          ...process.env,
          PROGRAM_CUE_LOCAL_FILES: fileServices ? "1" : "0",
        },
      });
    } finally {
      worker.removeListener("exit", workerExited);
    }
  }
} finally {
  try {
    try {
      try {
        if (isolatedWorker && worker?.connected) {
          let deadline;
          try {
            worker.send("shutdown");
            await Promise.race([
              workerExit,
              new Promise((resolve) => {
                deadline = setTimeout(resolve, 10000);
              }),
            ]);
          } finally {
            clearTimeout(deadline);
          }
        }
      } finally {
        await stopGroup(worker);
      }
      workerOutcome = await workerExit;
    } finally {
      if (fileServices) {
        const remaining = await run(
          "docker",
          ["ps", "--all", "--quiet", "--filter", `name=^/${fileContainer}$`],
          { stdio: ["ignore", "pipe", "inherit"] },
        );
        if (remaining.trim()) await run("docker", ["rm", "--force", fileContainer]);
      }
    }
  } finally {
    fs.rmSync(path.join(project, state), { recursive: true, force: true });
    fs.rmSync(lock, { force: true });
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
    if (interrupted) process.exitCode = interrupted === "SIGINT" ? 130 : 143;
  }
}
// npm/Wrangler can exit from our SIGTERM; the isolated runtime must finish
// draining its services and exit successfully, including after blocked evals.
const expectedTermination =
  !isolatedWorker && (workerOutcome?.signal === "SIGTERM" || workerOutcome?.code === 143);
if (!interrupted && workerOutcome && workerOutcome.code !== 0 && !expectedTermination) {
  throw new Error(
    `Local Worker shutdown failed (${workerOutcome.error?.message ?? workerOutcome.signal ?? workerOutcome.code}); inspect ${logPath}`,
  );
}
