import assert from "node:assert/strict";
import test from "node:test";
import {
  anonymousVerdict,
  deniesPrivateDownload,
  quarantineVerdict,
  privateDownloadUrl,
} from "../scripts/file-access-checks.mjs";

const asset = "11111111-1111-1111-1111-111111111111";
const v2 = "22222222-2222-2222-2222-222222222222";
const v3 = "33333333-3333-3333-3333-333333333333";
const path = `/admin/content/files/${asset}/versions/${v2}`;
const expected = { cleanSha256: "a".repeat(64), eicarSha256: "b".repeat(64), eicarBytes: 724 };
function fixture() {
  const response = (status, sha256, urlPath = path) => ({
    status,
    sha256,
    path: urlPath,
    bytes: 604,
    location: null,
  });
  return {
    version: 1,
    source: "isolated-local-file-access",
    cleanUrl: `http://127.0.0.1:5188${path}`,
    anonymousCookiesBefore: 0,
    history: {
      ok: true,
      versions: [
        { id: v2, versionNumber: 2, scanStatus: "clean", current: true },
        { id: v3, versionNumber: 3, scanStatus: "infected", current: false },
      ],
    },
    scans: [
      {
        sha256: expected.eicarSha256,
        versionId: v3,
        verdict: "infected",
        engine: "clamav",
        engineVersion: "unit-test-contract",
        signatureVersion: "unit-test-contract",
        scannedBytes: 724,
        object: { key: `private/${asset}/${v3}`, etag: '"unit-test"', sizeBytes: 724 },
        threats: ["Eicar-Signature"],
        callbackStatus: 200,
      },
    ],
    responses: {
      clean: response(200, expected.cleanSha256),
      infected: response(404, "c".repeat(64), path.replace(v2, v3)),
      anonymous: {
        ...response(302, "d".repeat(64)),
        location: `/demo?returnTo=${encodeURIComponent(path)}`,
      },
    },
  };
}

test("quarantine requires real infected evidence, rejected download and preserved clean current version", () => {
  assert.equal(quarantineVerdict(fixture(), expected), "pass");
  for (const mutate of [
    (r) => {
      r.scans[0].verdict = "clean";
    },
    (r) => {
      r.scans[0].callbackStatus = 409;
    },
    (r) => {
      r.scans[0].threats = [];
    },
    (r) => {
      r.scans[0].engine = "simulated";
    },
    (r) => {
      r.scans[0].scannedBytes = 10;
    },
    (r) => {
      r.scans[0].versionId = v2;
    },
    (r) => {
      r.history.versions[0].current = false;
      r.history.versions[1].current = true;
    },
    (r) => {
      r.responses.infected.status = 200;
    },
    (r) => {
      r.responses.infected.sha256 = expected.eicarSha256;
    },
    (r) => {
      r.responses.clean.sha256 = expected.eicarSha256;
    },
  ]) {
    const receipt = fixture();
    mutate(receipt);
    assert.equal(quarantineVerdict(receipt, expected), "fail");
  }
  const pending = fixture();
  pending.scans = [];
  assert.equal(quarantineVerdict(pending, expected), "cannot_judge");
});

test("anonymous denial requires a healthy authenticated control and an explicit access response", () => {
  assert.equal(anonymousVerdict(fixture(), expected), "pass");
  for (const status of [401, 403, 404]) {
    const receipt = fixture();
    receipt.responses.anonymous.status = status;
    assert.equal(anonymousVerdict(receipt, expected), "pass");
  }
  for (const mutate of [
    (r) => {
      r.responses.anonymous.status = 200;
    },
    (r) => {
      r.responses.anonymous.status = 400;
    },
    (r) => {
      r.responses.anonymous.location = "https://remote.example/demo";
    },
    (r) => {
      r.responses.anonymous.location = "/unavailable";
    },
    (r) => {
      r.responses.anonymous.sha256 = expected.cleanSha256;
    },
  ]) {
    const receipt = fixture();
    mutate(receipt);
    assert.equal(anonymousVerdict(receipt, expected), "fail");
  }
  const noControl = fixture();
  noControl.responses.clean.status = 404;
  assert.equal(anonymousVerdict(noControl, expected), "cannot_judge");
  const unhealthy = fixture();
  unhealthy.responses.anonymous.status = 503;
  assert.throws(() => anonymousVerdict(unhealthy, expected), /server error/);
  const wrongFile = fixture();
  wrongFile.responses.anonymous.path = path.replace(v2, v3);
  assert.throws(() => anonymousVerdict(wrongFile, expected), /same private file/);
  const authenticated = fixture();
  authenticated.anonymousCookiesBefore = 1;
  assert.throws(() => anonymousVerdict(authenticated, expected), /Invalid/);
  assert.throws(() => quarantineVerdict({}, expected), /Invalid/);
});

test("private probes reject remote origins and capability-bearing URLs", () => {
  const url = fixture().cleanUrl;
  assert.equal(privateDownloadUrl(url).href, url);
  for (const value of [
    url.replace("127.0.0.1", "remote.example"),
    `${url}?token=private`,
    url.replace("http://", "http://user:secret@"),
    `${url}#fragment`,
    "http://127.0.0.1:5188/admin",
  ]) {
    assert.throws(() => privateDownloadUrl(value), /isolated-local/);
  }
});

test("the smoke and grader denial policy rejects server errors and redirects to accessible files", () => {
  const url = fixture().cleanUrl;
  for (const status of [500, 502, 503])
    assert.throws(() => deniesPrivateDownload({ status, location: null }, url), /server error/);
  for (const location of [
    "/public/file.pdf",
    "https://remote.example/file.pdf",
    "/demo",
    "/demo?returnTo=/different",
  ])
    assert.equal(deniesPrivateDownload({ status: 302, location }, url), false);
  for (const status of [401, 403, 404])
    assert.equal(deniesPrivateDownload({ status, location: null }, url), true);
  assert.equal(deniesPrivateDownload(fixture().responses.anonymous, url), true);
});
