import { describe, expect, it } from "vitest";

import { taskEvidenceVersionStatus } from "./speaker-tasks-panel";

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
