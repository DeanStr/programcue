import { describe, expect, it } from "vitest";

import { speakerFileDownloadHref } from "./speaker-files-profile-panels";

describe("speaker Files download routes", () => {
  it("uses version-authorized task downloads and asset downloads elsewhere", () => {
    expect(speakerFileDownloadHref("task asset/1", "task", "version/2")).toBe(
      "/participant/tasks/files/task%20asset%2F1/version%2F2",
    );
    expect(
      speakerFileDownloadHref("profile asset/1", "person", "version/1"),
    ).toBe("/participant/files/profile%20asset%2F1");
  });
});
