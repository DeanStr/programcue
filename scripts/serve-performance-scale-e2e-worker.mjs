import { execFile, spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { repositoryRoot, resolveE2eRuntime } from "./e2e-runtime.mjs";
import { resolvePackageExecutable } from "./package-executable.mjs";
import { runProcess } from "./process-runner.mjs";

const { origin, statePathFromRepository } = resolveE2eRuntime();
const execFileAsync = promisify(execFile);
const wrangler = resolvePackageExecutable("wrangler", "wrangler");

async function localD1(command) {
  const { stdout } = await execFileAsync(
    wrangler,
    [
      "d1",
      "execute",
      "program-cue-db",
      "--local",
      "--persist-to",
      statePathFromRepository,
      "-c",
      "wrangler.demo.jsonc",
      "--command",
      command,
      "--json",
    ],
    { cwd: repositoryRoot, maxBuffer: 16 * 1024 * 1024 },
  );
  const results = JSON.parse(String(stdout));
  if (!Array.isArray(results) || results.length === 0) {
    throw new Error(
      "The local D1 performance verification returned no command results.",
    );
  }
  const invalidResult = results.findIndex(
    (result) => result?.success !== true || !Array.isArray(result.results),
  );
  if (invalidResult !== -1) {
    throw new Error(
      `The local D1 performance verification result ${invalidResult + 1} did not contain a successful row set.`,
    );
  }
  return results.flatMap((result) => result.results);
}

function spawnServer() {
  return spawn(process.execPath, ["scripts/serve-e2e-worker.mjs"], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
  });
}

function exited(child) {
  return new Promise((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
}

async function waitForSeed(child, exitPromise) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const outcome = await Promise.race([
      fetch(`${origin}/admin/event`, {
        headers: { cookie: "program_cue_demo_identity=administrator" },
        redirect: "manual",
        signal: AbortSignal.timeout(1_000),
      })
        .then((response) => ({ response }))
        .catch(() => null),
      exitPromise.then((exit) => ({ exit })),
    ]);
    if (outcome?.exit) {
      throw new Error(
        `The scale seed Worker exited before it became ready (${JSON.stringify(outcome.exit)}).`,
      );
    }
    if (outcome?.response) {
      const responseUrl = new URL(outcome.response.url);
      if (
        outcome.response.status === 200 &&
        responseUrl.origin === origin &&
        responseUrl.pathname === "/admin/event" &&
        responseUrl.search === "" &&
        !outcome.response.headers.has("location")
      ) {
        return;
      }
      await stopServer(child, exitPromise, "SIGTERM");
      throw new Error(
        `The scale seed Worker returned an unexpected readiness response (${outcome.response.status} ${responseUrl.pathname}${responseUrl.search}).`,
      );
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  await stopServer(child, exitPromise, "SIGTERM");
  throw new Error(
    "The scale seed Worker did not become ready within 60 seconds.",
  );
}

async function stopServer(child, exitPromise, signal) {
  if (!child.kill(signal)) {
    const exit = await exitPromise;
    throw new Error(
      `The scale seed Worker exited before ${signal} could be delivered (${JSON.stringify(exit)}).`,
    );
  }

  let timeout;
  const exit = await Promise.race([
    exitPromise,
    new Promise((resolveTimeout) => {
      timeout = setTimeout(() => resolveTimeout(null), 10_000);
    }),
  ]);
  clearTimeout(timeout);
  if (!exit) {
    child.kill("SIGKILL");
    await exitPromise;
    throw new Error(
      `The scale seed Worker did not stop within 10 seconds after ${signal}.`,
    );
  }
  if (
    !(
      (exit.code === 0 && exit.signal === null) ||
      (exit.code === null && exit.signal === signal) ||
      // serve-e2e-worker forwards SIGINT to Wrangler. Wrangler then reports
      // Workerd's deliberate SIGTERM shutdown as the conventional 143 code.
      (signal === "SIGINT" && exit.code === 143 && exit.signal === null)
    )
  ) {
    throw new Error(
      `The scale seed Worker stopped unexpectedly after ${signal} (${JSON.stringify(exit)}).`,
    );
  }
}

const preparation = await runProcess(
  process.execPath,
  ["scripts/prepare-e2e.mjs", "--skip-build"],
  { cwd: repositoryRoot, label: "Performance scale D1 preparation" },
);
if (preparation.code !== 0) process.exit(preparation.code);

const seedServer = spawnServer();
const seedExit = exited(seedServer);
await waitForSeed(seedServer, seedExit);
await stopServer(seedServer, seedExit, "SIGINT");

const fixture = await runProcess(
  wrangler,
  [
    "d1",
    "execute",
    "program-cue-db",
    "--local",
    "--persist-to",
    statePathFromRepository,
    "-c",
    "wrangler.demo.jsonc",
    "--file",
    resolve(repositoryRoot, "e2e/fixtures/performance-scale.sql"),
  ],
  { cwd: repositoryRoot, label: "Performance scale fixture" },
);
if (fixture.code !== 0) process.exit(fixture.code);

const [counts] = await localD1(`
  SELECT
    (SELECT COUNT(*) FROM submissions WHERE id LIKE 'perf-scale-submission-%') AS submissions,
    (SELECT COUNT(*) FROM memberships WHERE id LIKE 'perf-scale-membership-%') AS speakers,
    (SELECT COUNT(*) FROM submission_track_selections WHERE submission_id LIKE 'perf-scale-submission-%') AS trackSelections,
    (SELECT COUNT(*) FROM sessions WHERE id LIKE 'perf-scale-session-%') AS scheduleSessions,
    (SELECT COUNT(*) FROM schedule_entries WHERE id LIKE 'perf-scale-entry-%') AS scheduleEntries
`);
const verifiedFixture = {
  submissions: Number(counts?.submissions),
  speakers: Number(counts?.speakers),
  trackSelections: Number(counts?.trackSelections),
  scheduleSessions: Number(counts?.scheduleSessions),
  scheduleEntries: Number(counts?.scheduleEntries),
};
const expectedFixture = {
  submissions: 10_000,
  speakers: 10_000,
  trackSelections: 10_000,
  scheduleSessions: 200,
  scheduleEntries: 199,
};
if (JSON.stringify(verifiedFixture) !== JSON.stringify(expectedFixture)) {
  throw new Error(
    `The performance scale fixture has unexpected cardinality: ${JSON.stringify(verifiedFixture)}.`,
  );
}

await writeFile(
  resolve(repositoryRoot, `${statePathFromRepository}-verification.json`),
  `${JSON.stringify({ fixture: verifiedFixture }, null, 2)}\n`,
  "utf8",
);

const server = spawnServer();
const signalForwarders = new Map(
  ["SIGINT", "SIGTERM"].map((signal) => [signal, () => server.kill(signal)]),
);
for (const [signal, forward] of signalForwarders) process.on(signal, forward);

const exit = await exited(server);
for (const [signal, forward] of signalForwarders)
  process.removeListener(signal, forward);
if (exit.signal) process.kill(process.pid, exit.signal);
else process.exitCode = exit.code ?? 1;
