import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

export const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

export function formatDuration(milliseconds) {
  const seconds = Math.round(milliseconds / 100) / 10;
  return `${seconds.toFixed(1)}s`;
}

export function runProcess(command, args, options = {}) {
  const startedAt = performance.now();
  const label = options.label || [command, ...args].join(" ");
  console.log(`\n[start] ${label}`);

  return new Promise((resolveRun) => {
    let settled = false;
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: "inherit",
    });

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      const duration = performance.now() - startedAt;
      console.error(`[failed] ${label} (${formatDuration(duration)}): ${error.message}`);
      resolveRun({ code: 1, duration, label });
    });
    child.once("exit", (code, signal) => {
      if (settled) return;
      settled = true;
      const duration = performance.now() - startedAt;
      const exitCode = code ?? 1;
      const outcome = exitCode === 0 ? "passed" : "failed";
      const signalNote = signal ? `, signal ${signal}` : "";
      console.log(`[${outcome}] ${label} (${formatDuration(duration)}${signalNote})`);
      resolveRun({ code: exitCode, duration, label });
    });
  });
}

export async function runSequence(label, commands, options = {}) {
  const startedAt = performance.now();
  console.log(`\n[start] ${label}`);
  for (const command of commands) {
    const result = await runProcess(command.command, command.args, {
      ...options,
      label: command.label,
    });
    if (result.code !== 0) {
      return {
        code: result.code,
        duration: performance.now() - startedAt,
        label,
      };
    }
  }
  const duration = performance.now() - startedAt;
  console.log(`[passed] ${label} (${formatDuration(duration)})`);
  return { code: 0, duration, label };
}
