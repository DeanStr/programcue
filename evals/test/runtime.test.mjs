import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { run } from "../scripts/runtime.mjs";

const execute = promisify(execFile);
function killFixture(pid) {
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
async function waitForFile(file) {
  const deadline = Date.now() + 5000;
  while (!fs.existsSync(file)) {
    if (Date.now() >= deadline) throw new Error("Process fixture did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return JSON.parse(fs.readFileSync(file, "utf8"));
}
async function assertClosed(port) {
  await new Promise((resolve, reject) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error("Descendant listener survived cleanup"));
    });
    socket.once("error", (error) => (error.code === "ECONNREFUSED" ? resolve() : reject(error)));
  });
}

for (const mode of ["exit", "abort", "signal"]) {
  test(`process groups are removed after ${mode}, including children that ignore termination`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "programcue-eval-process-"));
    const ready = path.join(directory, "ready.json");
    const grandchild = `const net=require('node:net');process.on('SIGTERM',()=>{});const server=net.createServer();server.listen(0,'127.0.0.1',()=>process.send({port:server.address().port,pid:process.pid}));`;
    const leader = `const {spawn}=require('node:child_process');const fs=require('node:fs');process.on('SIGTERM',()=>{});const child=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:['ignore','ignore','ignore','ipc']});child.once('message',data=>{fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify(data));if(${JSON.stringify(mode)}==='exit')process.exit(0);});`;
    const controller = new AbortController();
    const result = run(process.execPath, ["-e", leader], {
      cwd: directory,
      stdio: "ignore",
      signal: controller.signal,
    });
    // Observe rejection immediately while waiting for the fixture readiness file.
    const settled = result.then(
      () => ({ ok: true }),
      (error) => ({ error }),
    );
    let fixture;
    try {
      fixture = await waitForFile(ready);
      if (mode === "abort") controller.abort();
      if (mode === "signal") process.emit("SIGTERM", "SIGTERM");
      const outcome = await settled;
      if (mode === "exit") assert.equal(outcome.ok, true);
      else assert.match(outcome.error.message, mode === "abort" ? /aborted/ : /interrupted/);
      await assertClosed(fixture.port);
    } finally {
      controller.abort();
      await settled;
      if (fixture) killFixture(fixture.pid);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test("coordinator removes its lock even when Docker setup and cleanup both fail", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "programcue-eval-cleanup-"));
  const evaluator = path.join(directory, "evals");
  fs.mkdirSync(path.join(evaluator, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(directory, "bin"));
  for (const name of ["local.mjs", "runtime.mjs", "prepare-local.mjs"])
    fs.copyFileSync(
      new URL(`../scripts/${name}`, import.meta.url),
      path.join(evaluator, "scripts", name),
    );
  fs.symlinkSync(
    fs.realpathSync(new URL("../node_modules", import.meta.url)),
    path.join(evaluator, "node_modules"),
  );
  const preload = path.join(directory, "preload.mjs");
  fs.writeFileSync(
    preload,
    `globalThis.fetch = async (url) => { if (url !== 'http://127.0.0.1:8025/api/v1/messages?limit=1') throw new Error('Unexpected fixture request'); return Response.json({total:0}); };`,
  );
  fs.writeFileSync(path.join(directory, "bin/docker"), "#!/bin/sh\nexit 7\n", { mode: 0o700 });
  try {
    await assert.rejects(
      execute(process.execPath, ["--import", preload, "scripts/local.mjs", "--smoke-files"], {
        cwd: evaluator,
        env: { ...process.env, PATH: path.join(directory, "bin") },
        timeout: 15000,
      }),
      (error) => {
        assert.match(error.stderr, /docker failed/);
        return true;
      },
    );
    assert.equal(fs.existsSync(path.join(evaluator, ".agent-eval/local.lock")), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("coordinator rejects failed Worker shutdown and still removes all owned resources", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "programcue-eval-shutdown-"));
  const evaluator = path.join(directory, "evals");
  for (const child of ["evals/scripts", "evals/node_modules/agent-eval-kit/dist", "scripts", "bin"])
    fs.mkdirSync(path.join(directory, child), { recursive: true });
  fs.symlinkSync(
    fs.realpathSync(new URL("../../node_modules", import.meta.url)),
    path.join(directory, "node_modules"),
  );
  for (const name of ["local.mjs", "runtime.mjs"])
    fs.copyFileSync(
      new URL(`../scripts/${name}`, import.meta.url),
      path.join(evaluator, "scripts", name),
    );
  fs.writeFileSync(
    path.join(evaluator, "scripts/prepare-local.mjs"),
    "export async function prepareLocal() {}\n",
  );
  fs.writeFileSync(
    path.join(directory, "scripts/prepare-e2e.mjs"),
    "import fs from 'node:fs'; fs.mkdirSync(process.env.PROGRAM_CUE_E2E_STATE, {recursive:true});\n",
  );
  fs.writeFileSync(
    path.join(evaluator, "node_modules/agent-eval-kit/dist/cli.js"),
    `
    if (process.argv.includes('--dry-run')) console.log(JSON.stringify({version:1,areas:[{id:'file-integrity',scenarios:[{id:'fixture'}]}]}));
    // A fixture collection returns successfully even if its browser reports blocked.
  `,
  );
  fs.writeFileSync(
    path.join(evaluator, "scripts/serve-local.mjs"),
    `
    import fs from 'node:fs';
    const shutdown = () => {
      if (process.env.SHUTDOWN_TEST_OUTCOME === 'signal') process.kill(process.pid, 'SIGKILL');
      const code = Number(process.env.SHUTDOWN_TEST_OUTCOME);
      if (code) console.error('Local scanning failed');
      process.exit(code);
    };
    // Signals interrupt graceful cleanup; the coordinator must use its IPC channel.
    process.on('SIGTERM', () => process.exit(143));
    process.on('message', message => { if (message === 'shutdown') shutdown(); });
    fs.writeFileSync(process.env.SHUTDOWN_TEST_READY, 'ready');
    setInterval(() => {}, 1000);
  `,
  );
  const preload = path.join(directory, "preload.mjs");
  fs.writeFileSync(
    preload,
    `
    import fs from 'node:fs';
    globalThis.fetch = async (url) => {
      if (url === 'http://127.0.0.1:8025/api/v1/messages?limit=1') return Response.json({total:0});
      if (url !== 'http://127.0.0.1:5188/demo') throw new Error('Unexpected fixture request');
      return new Response(null, {status:fs.existsSync(process.env.SHUTDOWN_TEST_READY) ? 200 : 503});
    };
  `,
  );
  const dockerCalls = path.join(directory, "docker-calls");
  fs.writeFileSync(
    path.join(directory, "bin/docker"),
    '#!/bin/sh\nprintf "%s\\n" "$*" >> "$SHUTDOWN_TEST_DOCKER"\nif [ "$1" = "ps" ]; then echo owned-container; fi\n',
    { mode: 0o700 },
  );
  try {
    for (const outcome of ["0", "1", "signal"]) {
      const ready = path.join(directory, "ready");
      fs.rmSync(ready, { force: true });
      fs.rmSync(dockerCalls, { force: true });
      const result = await execute(
        process.execPath,
        ["--import", preload, "scripts/local.mjs", "--files-regression"],
        {
          cwd: evaluator,
          env: {
            ...process.env,
            PATH: `${path.join(directory, "bin")}:${process.env.PATH}`,
            SHUTDOWN_TEST_OUTCOME: outcome,
            SHUTDOWN_TEST_READY: ready,
            SHUTDOWN_TEST_DOCKER: dockerCalls,
          },
          timeout: 15000,
        },
      ).then(
        (result) => ({ ...result, code: 0 }),
        (error) => error,
      );
      assert.equal(result.code, outcome === "0" ? 0 : 1, result.stderr);
      if (outcome !== "0") assert.match(result.stderr, /Local Worker shutdown failed/);
      assert.match(fs.readFileSync(dockerCalls, "utf8"), /rm --force programcue-eval-clamav-/);
      assert.equal(fs.existsSync(path.join(evaluator, ".agent-eval/local.lock")), false);
      assert.deepEqual(fs.readdirSync(path.join(directory, ".wrangler")), []);
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
