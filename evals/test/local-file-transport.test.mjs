import assert from "node:assert/strict";
import test from "node:test";
import { localStorageRequest, localPartResponse } from "../scripts/local-file-transport.mjs";
import { scanVerdict } from "../scripts/checks.mjs";

test("local transport preserves signed object authority and actual PUT bytes", async () => {
  const signed =
    "https://00000000000000000000000000000000.r2.cloudflarestorage.com/bucket/private/file.pdf?partNumber=1&X-Amz-Signature=exact-signature";
  const request = new Request("http://127.0.0.1:5188/files/multipart/part-url");
  const response = await localPartResponse(
    request,
    Response.json({ ok: true, part: { url: signed } }),
  );
  const url = (await response.json()).part.url;
  assert.equal(new URL(url).origin, "http://127.0.0.1:5188");
  const forwarded = localStorageRequest(new Request(url, { method: "PUT", body: "actual bytes" }));
  assert.equal(forwarded.url, signed);
  assert.equal(await forwarded.text(), "actual bytes");
  assert.throws(
    () => localStorageRequest(new Request(url.replace("127.0.0.1", "remote.example"))),
    /loopback/,
  );
  await assert.rejects(
    localPartResponse(request, Response.json({ part: { url: "https://unexpected.example/file" } })),
    /Unexpected/,
  );
  const unavailable = new Response("unavailable", { status: 503 });
  assert.equal(await localPartResponse(request, unavailable), unavailable);
});

test("scan grading rejects stale, duplicate, failed and malformed evidence", () => {
  const expected = { previousSha256: "a".repeat(64), latestSha256: "b".repeat(64) };
  const scan = (sha256, versionId) => ({
    sha256,
    versionId,
    verdict: "clean",
    engine: "clamav",
    engineVersion: "1.4.6",
    signatureVersion: "test-contract",
    scannedBytes: 10,
    object: { key: `private/${versionId}`, sizeBytes: 10, etag: '"etag"' },
    callbackStatus: 200,
  });
  const receipt = {
    version: 1,
    source: "isolated-local-r2-and-real-clamav",
    scans: [scan(expected.previousSha256, "v1"), scan(expected.latestSha256, "v2")],
  };
  assert.equal(scanVerdict(receipt, expected), "pass");
  for (const change of [
    (copy) => {
      copy.scans.pop();
    },
    (copy) => {
      copy.scans[1].versionId = "v1";
    },
    (copy) => {
      copy.scans[1].sha256 = expected.previousSha256;
    },
    (copy) => {
      copy.scans[1].verdict = "infected";
    },
    (copy) => {
      copy.scans[1].callbackStatus = 409;
    },
    (copy) => {
      copy.scans[1].object.sizeBytes = 11;
    },
  ]) {
    const copy = structuredClone(receipt);
    change(copy);
    assert.equal(scanVerdict(copy, expected), "fail");
  }
  for (const field of ["engine", "callbackStatus", "object.sizeBytes"]) {
    const malformed = structuredClone(receipt);
    if (field === "object.sizeBytes") delete malformed.scans[0].object.sizeBytes;
    else delete malformed.scans[0][field];
    assert.throws(() => scanVerdict(malformed, expected), /Malformed local scan evidence/);
  }
  assert.throws(() => scanVerdict({ ...receipt, scans: [{}] }, expected), /Malformed/);
});
