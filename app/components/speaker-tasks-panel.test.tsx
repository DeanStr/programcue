import { describe, expect, it } from "vitest";

import { directUploadMaximumBytes } from "./direct-multipart-upload";
import {
  taskEvidenceUploadKind,
  taskEvidenceVersionStatus,
} from "./speaker-tasks-panel";

describe("speaker task upload limits", () => {
  it("uses the video limit only for declared supported video MIME types", () => {
    const kind = {
      value: "task_evidence",
      label: "Task evidence",
      maximumBytes: 25,
      maximumBytesByContentType: {
        "video/mp4": 100,
        "video/webm": 100,
      },
    };

    expect(directUploadMaximumBytes(kind, "video/mp4")).toBe(100);
    expect(directUploadMaximumBytes(kind, " VIDEO/WEBM ")).toBe(100);
    expect(directUploadMaximumBytes(kind, "application/pdf")).toBe(25);
    expect(directUploadMaximumBytes(kind, "")).toBe(25);
  });

  it("presents the exact configured presentation policy", () => {
    const kind = taskEvidenceUploadKind("slides", "session_deliverable", {
      headshotMaximumBytes: 10 * 1_048_576,
      slidesMaximumBytes: 100 * 1_048_576,
      supportingDocumentMaximumBytes: 100 * 1_048_576,
      videoMaximumBytes: 1_024 * 1_048_576,
    });
    expect(kind).toMatchObject({
      label: "Presentation slides · PDF, PPT or PPTX · 100 MB maximum",
      accept: ".pdf,.ppt,.pptx",
      maximumBytes: 100 * 1_048_576,
    });
  });

  it("does not advertise the larger video limit for legacy participant documents", () => {
    const policy = {
      headshotMaximumBytes: 10 * 1_048_576,
      slidesMaximumBytes: 100 * 1_048_576,
      supportingDocumentMaximumBytes: 100 * 1_048_576,
      videoMaximumBytes: 1_024 * 1_048_576,
    };

    expect(
      taskEvidenceUploadKind(null, "participant_document", policy),
    ).not.toHaveProperty("maximumBytesByContentType");
    expect(
      taskEvidenceUploadKind(null, "session_deliverable", policy),
    ).toMatchObject({
      maximumBytesByContentType: {
        "video/mp4": policy.videoMaximumBytes,
        "video/webm": policy.videoMaximumBytes,
      },
    });
  });
});

describe("speaker task evidence version status", () => {
  const status = (
    overrides: Partial<Parameters<typeof taskEvidenceVersionStatus>[0]>,
  ) =>
    taskEvidenceVersionStatus({
      uploadStatus: "uploaded",
      signatureStatus: "valid",
      scanStatus: "pending",
      releasedAt: null,
      ...overrides,
    }).label;

  it("distinguishes pending, terminal and release states honestly", () => {
    const labels = [
      status({ uploadStatus: "uploading", signatureStatus: "pending" }),
      status({ signatureStatus: "pending" }),
      status({ scanStatus: "pending" }),
      status({ scanStatus: "infected" }),
      status({ scanStatus: "failed" }),
      status({ signatureStatus: "invalid" }),
      status({ signatureStatus: "failed" }),
      status({ uploadStatus: "failed" }),
      status({ uploadStatus: "aborted" }),
      status({ scanStatus: "clean", releasedAt: null }),
      status({ scanStatus: "clean", releasedAt: 1_700_000_000 }),
    ];

    expect(labels).toEqual([
      "Uploading",
      "Signature validation pending",
      "Malware scan pending",
      "Malware detected",
      "Malware scan failed",
      "Invalid file signature",
      "Signature validation failed",
      "Upload failed",
      "Upload aborted",
      "Release pending",
      "Released",
    ]);
    expect(labels).not.toContain("Scanning");
  });
});
