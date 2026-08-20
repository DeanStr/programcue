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

  it("rejects upload names that can spoof a different extension", () => {
    expect(() =>
      validateDirectFileDeclaration(
        "slides",
        {
          name: "malware.exe\u0000.pdf",
          type: "application/pdf",
          size: FILE_SIZE_MIB,
        },
        CANONICAL_EVENT_FILE_POLICY,
      ),
    ).toThrow(/unsupported characters/);
    expect(() =>
      validateDirectFileDeclaration(
        "slides",
        {
          name: "innocent\u202epdf.exe",
          type: "application/pdf",
          size: FILE_SIZE_MIB,
        },
        CANONICAL_EVENT_FILE_POLICY,
      ),
    ).toThrow(/unsupported characters/);
    expect(() =>
      validateDirectFileDeclaration(
        "slides",
        {
          name: "nested/path.pdf",
          type: "application/pdf",
          size: FILE_SIZE_MIB,
        },
        CANONICAL_EVENT_FILE_POLICY,
      ),
    ).toThrow(/unsupported characters/);
    expect(() =>
      validateDirectFileDeclaration(
        "slides",
        {
          name: "Talk: Q&A.pdf",
          type: "application/pdf",
          size: FILE_SIZE_MIB,
        },
        CANONICAL_EVENT_FILE_POLICY,
      ),
    ).not.toThrow();
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

  it("uses the video limit only for video task evidence", () => {
    const policy = {
      ...CANONICAL_EVENT_FILE_POLICY,
      supportingDocumentMaximumBytes: FILE_SIZE_MIB,
      videoMaximumBytes: 2 * FILE_SIZE_MIB,
    };
    expect(() =>
      validateDirectFileDeclaration(
        "task_evidence",
        {
          name: "recording.mp4",
          type: "video/mp4",
          size: FILE_SIZE_MIB + 1,
        },
        policy,
      ),
    ).not.toThrow();
    expect(() =>
      validateDirectFileDeclaration(
        "task_evidence",
        {
          name: "handout.pdf",
          type: "application/pdf",
          size: FILE_SIZE_MIB + 1,
        },
        policy,
      ),
    ).toThrow(/1 MB event limit/);
  });
});
