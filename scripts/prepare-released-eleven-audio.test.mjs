import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { downloadReleasedMaster } from "../video/scripts/prepare-released-eleven-audio.mjs";

const media = Buffer.from("test download bytes");
const masterSha256 = createHash("sha256").update(media).digest("hex");

async function withDownload(handler, check) {
  const root = mkdtempSync(join(tmpdir(), "program-cue-download-"));
  const server = createServer(handler);
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const release = {
      videoUrl: `http://127.0.0.1:${server.address().port}/master.mp4`,
      masterSha256,
    };
    await check(release, join(root, "master.mp4"), root);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
}

test("installs only a hash-verified download and reuses the cache offline", async () => {
  let requests = 0;
  await withDownload(
    (_request, response) => {
      requests += 1;
      response.end(media);
    },
    async (release, cache, root) => {
      await downloadReleasedMaster(release, cache, false, 5_000);
      assert.deepEqual(readFileSync(cache), media);
      assert.deepEqual(readdirSync(root), ["master.mp4"]);
      await downloadReleasedMaster(release, cache, true);
      assert.equal(requests, 1);
    },
  );
});

test("bounds both stalled response headers and stalled response bodies", async () => {
  for (const bodyStarted of [false, true]) {
    await withDownload(
      (_request, response) => {
        if (bodyStarted) {
          response.writeHead(200);
          response.write("partial");
        }
      },
      async (release, cache, root) => {
        await assert.rejects(
          downloadReleasedMaster(release, cache, false, 100),
          (error) => {
            assert.ok(error.message.includes(release.videoUrl));
            assert.match(error.message, /timed out after 0.1 seconds/);
            return true;
          },
        );
        assert.deepEqual(readdirSync(root), []);
      },
    );
  }
});

test("reports transport, HTTP and hash failures without installing partial bytes", async () => {
  for (const [handler, expected] of [
    [(_request, response) => response.destroy(), /fetch failed/],
    [
      (_request, response) => {
        response.writeHead(503);
        response.end();
      },
      /HTTP 503/,
    ],
    [(_request, response) => response.end("wrong media"), /hash mismatch/],
  ]) {
    await withDownload(handler, async (release, cache, root) => {
      await assert.rejects(
        downloadReleasedMaster(release, cache, false, 5_000),
        (error) => {
          assert.ok(error.message.includes(release.videoUrl));
          assert.match(error.message, expected);
          assert.match(error.message, /No cache was installed/);
          return true;
        },
      );
      assert.deepEqual(readdirSync(root), []);
    });
  }
});

test("a missing offline cache fails without a network request", async () => {
  let requests = 0;
  await withDownload(
    (_request, response) => {
      requests += 1;
      response.end(media);
    },
    async (release, cache, root) => {
      await assert.rejects(
        downloadReleasedMaster(release, cache, true),
        /not cached/,
      );
      assert.equal(requests, 0);
      assert.deepEqual(readdirSync(root), []);
    },
  );
});
