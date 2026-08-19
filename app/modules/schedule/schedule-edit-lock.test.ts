import { describe, expect, it } from "vitest";

import { scheduleEditLock } from "./schedule-edit-lock";

describe("schedule edit lock", () => {
  it("unlocks only a draft version", () => {
    expect(scheduleEditLock({ versionNumber: 4, status: "draft" })).toEqual({
      editable: true,
      reason: null,
    });
  });

  it("names the version and the remedy for every frozen status", () => {
    const published = scheduleEditLock({
      versionNumber: 3,
      status: "published",
    });
    const archived = scheduleEditLock({ versionNumber: 2, status: "archived" });
    const failed = scheduleEditLock({ versionNumber: 5, status: "failed" });

    expect(published.editable).toBe(false);
    expect(published.reason?.title).toBe("Version 3 is published");
    expect(published.reason?.remedy).toBe("Create the next draft to edit");
    expect(archived.reason?.title).toBe("Version 2 is archived");
    expect(archived.reason?.remedy).toBe("Create the next draft to edit");
    expect(failed.reason?.title).toBe("Version 5 failed to publish");
    expect(failed.reason?.tone).toBe("warning");
  });

  it("points a publishing version at the running publication, not a new draft", () => {
    const lock = scheduleEditLock({ versionNumber: 1, status: "publishing" });

    expect(lock.reason?.remedy).toBe("Wait for publication to finish");
  });

  it("explains the missing schedule rather than a frozen publication", () => {
    const lock = scheduleEditLock(null);

    expect(lock.editable).toBe(false);
    expect(lock.reason?.title).toBe("No schedule version yet");
    expect(lock.reason?.detail).not.toContain("publication");
    expect(lock.reason?.remedy).toBe("Create a schedule to edit");
  });

  it("refuses to invent a caption for an unmapped status", () => {
    expect(() =>
      scheduleEditLock({ versionNumber: 1, status: "retired" }),
    ).toThrow("Unsupported schedule version status: retired.");
  });
});
