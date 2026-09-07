import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { waitForWorker } from "../scripts/runtime.mjs";
import { waitForClamav } from "../scripts/local-file-services.mjs";

test("Worker readiness retries startup 503 but fails on unexpected HTTP responses", async () => {
  let statuses = [503, 200];
  const server = http.createServer((_req, res) => {
    res.writeHead(statuses.shift());
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/demo`;
  const worker = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  try {
    await waitForWorker(url, { worker, timeoutMs: 2000 });
    for (const status of [302, 401, 404, 500]) {
      statuses = [status];
      await assert.rejects(
        waitForWorker(url, { worker, timeoutMs: 2000 }),
        new RegExp(`HTTP ${status}`),
      );
      assert.equal(statuses.length, 0);
    }
    worker.exitCode = 1;
    await assert.rejects(waitForWorker(url, { worker }), /Worker exited/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("ClamAV readiness retries only an absent ready file and bounds Docker commands", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "programcue-readiness-"));
  const docker = path.join(directory, "docker");
  const previousPath = process.env.PATH;
  process.env.PATH = directory;
  const calls = path.join(directory, "calls");
  try {
    // Use shell builtins only: this test's PATH intentionally excludes real Docker.
    fs.writeFileSync(
      docker,
      `#!/bin/sh\nif [ -f '${calls}' ]; then exit 0; fi\n: > '${calls}'\nexit 1\n`,
      { mode: 0o700 },
    );
    await waitForClamav("fixture", { timeoutMs: 2000 });
    for (const code of [1, 125]) {
      fs.writeFileSync(docker, `#!/bin/sh\necho 'daemon unavailable' >&2\nexit ${code}\n`);
      await assert.rejects(waitForClamav("fixture", { timeoutMs: 2000 }), /daemon unavailable/);
    }
    fs.writeFileSync(docker, "#!/bin/sh\nwhile :; do :; done\n");
    await assert.rejects(waitForClamav("fixture", { timeoutMs: 100 }), /readiness command failed/);
    fs.unlinkSync(docker);
    await assert.rejects(waitForClamav("fixture", { timeoutMs: 2000 }), /ENOENT/);
  } finally {
    process.env.PATH = previousPath;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
