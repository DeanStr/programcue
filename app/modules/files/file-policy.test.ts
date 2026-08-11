import { describe, expect, it } from "vitest";

import {
  CANONICAL_EVENT_FILE_POLICY,
  FILE_SIZE_MIB,
  FilePolicyError,
  maximumBytesForAssetKind,
  parseEventFilePolicy,
  validateDirectFileDeclaration,
} from "./file-policy";

describe("event file policy", () => {
  it("requires the complete strict policy instead of filling missing limits", () => {
    expect(() =>
      parseEventFilePolicy(
        JSON.stringify({
          ...CANONICAL_EVENT_FILE_POLICY,
          unexpectedLimit: FILE_SIZE_MIB,
        }),
      ),
    ).toThrow(FilePolicyError);
    expect(() =>
      parseEventFilePolicy(
        JSON.stringify({
          headshotMaximumBytes: FILE_SIZE_MIB,
          slidesMaximumBytes: FILE_SIZE_MIB,
          videoMaximumBytes: FILE_SIZE_MIB,
        }),
      ),
    ).toThrow(FilePolicyError);
  });

  it("accepts lower event limits but rejects values outside canonical bounds", () => {
    const policy = parseEventFilePolicy(
      JSON.stringify({
        headshotMaximumBytes: FILE_SIZE_MIB,
        slidesMaximumBytes: 2 * FILE_SIZE_MIB,
        supportingDocumentMaximumBytes: 3 * FILE_SIZE_MIB,
        videoMaximumBytes: 4 * FILE_SIZE_MIB,
      }),
    );
    expect(maximumBytesForAssetKind("task_evidence", policy)).toBe(
      3 * FILE_SIZE_MIB,
    );
    expect(() =>
      parseEventFilePolicy(
        JSON.stringify({
          ...CANONICAL_EVENT_FILE_POLICY,
          videoMaximumBytes: CANONICAL_EVENT_FILE_POLICY.videoMaximumBytes + 1,
        }),
      ),
    ).toThrow(FilePolicyError);
  });

  it("enforces the resolved event limit for a declared upload", () => {
    const policy = {
      ...CANONICAL_EVENT_FILE_POLICY,
      slidesMaximumBytes: FILE_SIZE_MIB,
    };
    expect(() =>
      validateDirectFileDeclaration(
        "slides",
        {
          name: "presentation.pdf",
          type: "application/pdf",
          size: FILE_SIZE_MIB + 1,
        },
        policy,
      ),
    ).toThrow(/1 MB event limit/);
  });
});
