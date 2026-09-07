import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { Miniflare } from "miniflare";
import {
  createLocalFileServices,
  s3Host,
  scannerUrl,
  callbackUrl,
} from "../scripts/local-file-services.mjs";
import { presignR2S3Request } from "../../app/modules/files/r2-s3-signing.server.ts";

test("local signed transport stores actual R2 parts and rejects changed or expired authority", async () => {
  const mf = new Miniflare({
    modules: true,
    script: "export default { fetch() { return new Response('ok') } }",
    r2Buckets: ["FILES"],
  });
  try {
    const bucket = await mf.getR2Bucket("FILES");
    const env = {
      R2_ACCOUNT_ID: s3Host.split(".")[0],
      R2_BUCKET_NAME: "local-files",
      R2_ACCESS_KEY_ID: "ephemeral-test-key",
      R2_SECRET_ACCESS_KEY: "ephemeral-test-secret-0123456789",
      FILE_SCANNER_DISPATCH_SECRET: "ephemeral-dispatch-secret-0123456789",
    };
    const records = [];
    const services = createLocalFileServices({
      env,
      getBucket: async () => bucket,
      record(event) {
        records.push(event);
      },
      dispatchCallback() {
        throw new Error("Unexpected callback");
      },
    });
    const objectKey = "private/transport/test.pdf";
    const upload = await bucket.createMultipartUpload(objectKey);
    const url = await presignR2S3Request({
      env,
      method: "PUT",
      objectKey,
      query: { uploadId: upload.uploadId, partNumber: "1" },
    });
    assert.equal(
      (
        await services.s3(
          new Request(url.replace("partNumber=1", "partNumber=2"), {
            method: "PUT",
            body: "bytes",
          }),
        )
      ).status,
      403,
    );
    const expired = await presignR2S3Request({
      env,
      method: "PUT",
      objectKey,
      query: { uploadId: upload.uploadId, partNumber: "1" },
      expiresSeconds: 60,
      now: new Date(Date.now() - 120_000),
    });
    assert.equal(
      (await services.s3(new Request(expired, { method: "PUT", body: "bytes" }))).status,
      403,
    );
    const bytes = Buffer.from("%PDF-1.7\nactual multipart bytes");
    const response = await services.s3(new Request(url, { method: "PUT", body: bytes }));
    assert.equal(response.status, 200);
    const etag = response.headers.get("etag").replaceAll('"', "");
    const list = await services.s3(
      new Request(
        await presignR2S3Request({
          env,
          method: "GET",
          objectKey,
          query: { uploadId: upload.uploadId, "max-parts": "1" },
        }),
      ),
    );
    assert.match(await list.text(), new RegExp(`<ETag>${etag}</ETag>`));
    await upload.complete([{ partNumber: 1, etag }]);
    assert.deepEqual(Buffer.from(await (await bucket.get(objectKey)).arrayBuffer()), bytes);
    assert.equal(
      (await services.scanner(new Request(scannerUrl, { method: "POST", body: "{}" }))).status,
      401,
    );
    await services.drain();
    const timestamp = Math.floor(Date.now() / 1000);
    const job = {
      jobId: "scan-identity-test",
      attempt: 1,
      organisationId: "org",
      eventId: "event",
      versionId: "version",
      assetId: "asset",
      expiresAt: timestamp + 300,
      object: {
        key: objectKey,
        etag: (await bucket.head(objectKey)).httpEtag,
        sizeBytes: bytes.length + 1,
      },
      callback: { url: callbackUrl, authentication: "program-cue-hmac-sha256-v1" },
    };
    const rawBody = JSON.stringify(job);
    const signature = createHmac("sha256", env.FILE_SCANNER_DISPATCH_SECRET)
      .update(`${timestamp}.${rawBody}`)
      .digest("base64");
    const accepted = await services.scanner(
      new Request(scannerUrl, {
        method: "POST",
        body: rawBody,
        headers: {
          "x-program-cue-dispatch-timestamp": String(timestamp),
          "x-program-cue-dispatch-signature": `v1,${signature}`,
          "idempotency-key": `${job.jobId}:attempt:1`,
        },
      }),
    );
    assert.equal(accepted.status, 202);
    const failure = await services.failure;
    assert.equal(failure?.message, "Scanner object identity does not match the signed job");
    await assert.rejects(services.drain(), /Local scanning failed/);
    assert.equal(records.at(-1).type, "scan-error");
    assert.equal(records.at(-1).error, "Scanner object identity does not match the signed job");
  } finally {
    await mf.dispose();
  }
});
