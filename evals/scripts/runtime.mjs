import { setTimeout as delay } from "node:timers/promises";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const project = path.resolve(root, "..");
export const aek = path.join(root, "node_modules/agent-eval-kit/dist/cli.js");
export const origin = "http://127.0.0.1:5188";
const execute = promisify(execFile);

async function groupIsRunning(pid) {
  try {
    process.kill(-pid, 0);
  } catch (error) {
    if (error.code === "ESRCH") return false;
    throw error;
  }
  // A stopped orphan may remain a zombie until its parent reaps it. It holds
  // no listeners or files and must not be mistaken for a surviving worker.
  const { stdout } = await execute("ps", ["-eo", "pgid=,stat="], { timeout: 5000 });
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .some((line) => {
      const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(line);
      if (!match) throw new Error("Cannot inspect local evaluator process groups");
      return Number(match[1]) === pid && !match[2].startsWith("Z");
    });
}
export async function run(command, args, options = {}) {
  const child = spawn(command, args, { cwd: root, stdio: "inherit", detached: true, ...options });
  let interrupted;
  let stopping;
  const stop = (signal) => {
    interrupted ??= signal;
    stopping ??= stopGroup(child, signal);
  };
  const interrupt = () => stop("SIGINT");
  const terminate = () => stop("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  let result;
  let stdout = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  try {
    result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
    await (stopping ?? stopGroup(child));
  }
  if (interrupted) throw new Error(`${command} interrupted (${interrupted})`);
  if (result.code !== 0) throw new Error(`${command} failed (${result.signal ?? result.code})`);
  return stdout;
}
export async function stopGroup(child, signal = "SIGTERM") {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  // AEK needs up to six seconds to terminate its own detached provider groups.
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (!(await groupIsRunning(child.pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
  const forcedDeadline = Date.now() + 1000;
  while (Date.now() < forcedDeadline) {
    if (!(await groupIsRunning(child.pid))) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Evaluator process group ${child.pid} survived forced termination`);
}

export async function waitForWorker(url, { worker, signal, timeoutMs = 300_000 }) {
  const deadline = Date.now() + timeoutMs;
  let launchError;
  let last = "connection not established";
  const failed = (error) => {
    launchError = error;
  };
  worker.on("error", failed);
  try {
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      if (launchError) throw launchError;
      if (worker.exitCode !== null || worker.signalCode)
        throw new Error(`Local Worker exited (${worker.signalCode ?? worker.exitCode})`);
      let response;
      try {
        const timeout = AbortSignal.timeout(Math.max(1, Math.min(3000, deadline - Date.now())));
        response = await fetch(url, {
          redirect: "manual",
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        await response.body?.cancel();
      } catch (error) {
        signal?.throwIfAborted();
        if (
          error.name !== "TimeoutError" &&
          !["ECONNREFUSED", "ECONNRESET"].includes(error.cause?.code)
        )
          throw new Error(`Worker readiness request failed: ${error.message}`, { cause: error });
        last = error.cause?.code ?? error.name;
      }
      if (response) {
        if (response.status === 200) return;
        if (response.status !== 503)
          throw new Error(`Worker readiness returned HTTP ${response.status} at ${url}`);
        last = "HTTP 503";
      }
      await delay(Math.min(500, Math.max(0, deadline - Date.now())), undefined, { signal });
    }
    throw new Error(`Worker readiness timed out at ${url}; last response: ${last}`);
  } finally {
    worker.removeListener("error", failed);
  }
}
