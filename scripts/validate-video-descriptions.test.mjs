import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { validateDescriptions } from "../video/scripts/validate-descriptions.mjs";

const valid = `WEBVTT

00:00:00.000 --> 00:00:05.000
Review the selected session.

00:00:05.000 --> 00:00:10.000
Confirm publication.
`;

function check(source, duration = 10) {
  const directory = mkdtempSync(join(tmpdir(), "program-cue-captions-"));
  const file = join(directory, "descriptions.vtt");
  try {
    writeFileSync(file, source);
    return validateDescriptions(file, duration);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("accepts readable, contiguous captions matching the picture duration", () => {
  assert.equal(check(valid).cueCount, 2);
  assert.equal(check(`\uFEFF${valid.replaceAll("\n", "\r\n")}`).cueCount, 2);
});

test("rejects a duplicated timing delimiter before rendering", () => {
  assert.throws(
    () =>
      check(valid.replace("00:00:05.000\n", "00:00:05.000 --> 00:00:06.000\n")),
    /malformed or empty/,
  );
});

test("rejects timing delimiters inside cue text, including missing separators", () => {
  for (const text of [
    "Text\n00:00:02.000 --> 00:00:03.000",
    "Text --> more text",
    "Text\n00:00:02.000 --> 00:00:03.000\nSecond cue",
  ]) {
    assert.throws(
      () => check(`WEBVTT\n\n00:00:00.000 --> 00:00:10.000\n${text}\n`),
      /extra timing delimiter/,
    );
  }
});

test("rejects missing, empty and invalid-time cues", () => {
  for (const source of [
    "WEBVTT\n\nNOTE No cues\n",
    valid.replace("Review the selected session.", ""),
    valid.replace("00:00:05.000", "00:00:65.000"),
    valid.replace("WEBVTT", "CAPTIONS"),
  ]) {
    assert.throws(() => check(source), /\[video:captions\]/);
  }
});

test("rejects gaps, overlaps and a shortened picture lock", () => {
  assert.throws(
    () => check(valid.replace("00:00:05.000 -->", "00:00:06.000 -->")),
    /not contiguous/,
  );
  assert.throws(
    () => check(valid.replace("00:00:05.000 -->", "00:00:04.000 -->")),
    /not contiguous/,
  );
  assert.throws(() => check(valid, 11), /ends at 10s instead of 11s/);
  assert.throws(
    () => check(valid.replace("00:00:00.000", "00:00:01.000")),
    /begins at 1s/,
  );
});

test("rejects captions that exceed the reading-speed limit", () => {
  assert.throws(
    () => check(valid.replace("Confirm publication.", "x".repeat(86))),
    /characters\/s/,
  );
  assert.ok(
    check(valid.replace("Confirm publication.", "x".repeat(85))).maximumCps ===
      17,
  );
});

test("rejects a missing file and an invalid expected duration", () => {
  assert.throws(
    () =>
      validateDescriptions(
        join(tmpdir(), "missing-program-cue-captions.vtt"),
        10,
      ),
    /missing/,
  );
  for (const duration of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.throws(() => check(valid, duration), /positive finite/);
  }
});
