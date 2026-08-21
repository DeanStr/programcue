import { describe, expect, it } from "vitest";

import {
  type ApplicantVideoUploadRecord,
  applicantVideoFieldSources,
  applicantVideoUploadDisplayState,
} from "./applicant-video-upload";

const readyUpload: ApplicantVideoUploadRecord = {
  fieldId: "video",
  assetId: "asset-1",
  versionId: "version-1",
  filename: "pitch.mp4",
  sizeBytes: 1_024,
  status: "ready",
};

describe("applicantVideoFieldSources", () => {
  it("reuses loader scan status only when it describes the attached version", () => {
    expect(
      applicantVideoFieldSources({
        fieldId: "video",
        currentUpload: readyUpload,
        attachedUpload: {
          assetId: readyUpload.assetId,
          versionId: readyUpload.versionId,
        },
      }),
    ).toEqual({ current: readyUpload, attachedReference: null });
  });

  it("does not report the previous file as ready after a replacement", () => {
    expect(
      applicantVideoFieldSources({
        fieldId: "video",
        currentUpload: readyUpload,
        attachedUpload: { assetId: "asset-1", versionId: "version-2" },
      }),
    ).toEqual({
      current: null,
      attachedReference: { assetId: "asset-1", versionId: "version-2" },
    });
  });

  it("keeps an attached reference when the loader has not caught up", () => {
    expect(
      applicantVideoFieldSources({
        fieldId: "video",
        currentUpload: null,
        attachedUpload: { assetId: "asset-2", versionId: "version-1" },
      }),
    ).toEqual({
      current: null,
      attachedReference: { assetId: "asset-2", versionId: "version-1" },
    });
  });
});

describe("applicantVideoUploadDisplayState", () => {
  it("reports ready or rejected from the loader version, not a previous scan", () => {
    expect(applicantVideoUploadDisplayState(readyUpload, null)).toMatchObject({
      status: "ready",
    });
    expect(
      applicantVideoUploadDisplayState(
        { ...readyUpload, versionId: "version-2", status: "rejected" },
        null,
      ),
    ).toMatchObject({ status: "error" });
  });
});
