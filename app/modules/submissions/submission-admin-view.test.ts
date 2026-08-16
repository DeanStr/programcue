import { describe, expect, it } from "vitest";
import {
  adminSubmissionSearchParams,
  parseAdminSubmissionView,
} from "./submission-admin-view";

describe("submission administrator URL state", () => {
  it("uses the documented default view when optional parameters are absent", () => {
    expect(
      parseAdminSubmissionView(
        new URL("https://example.test/admin/submissions"),
      ),
    ).toEqual({
      page: 1,
      density: "comfortable",
      columns: ["submitter", "route", "speakers", "status"],
      filters: {
        status: "",
        category: "",
        query: "",
        routing: "",
        sort: "submittedAt-desc",
      },
    });
  });

  it("round-trips every configurable view value", () => {
    const view = parseAdminSubmissionView(
      new URL(
        "https://example.test/admin/submissions?page=3&status=assigned&category=Engineering&query=trust&routing=manual_override&sort=title-asc&columns=submitter,status&density=compact",
      ),
    );

    expect(adminSubmissionSearchParams(view).toString()).toBe(
      "page=3&status=assigned&category=Engineering&query=trust&routing=manual_override&sort=title-asc&columns=submitter%2Cstatus&density=compact",
    );
  });

  it.each([
    "page=0",
    "page=1.5",
    "page=9007199254740991",
    "status=unknown",
    "routing=unknown",
    "sort=unknown",
    "density=unknown",
    "columns=submitter,unknown",
    "columns=status,status",
    "status=submitted&status=draft",
  ])("rejects malformed state: %s", (search) => {
    expect(() =>
      parseAdminSubmissionView(
        new URL(`https://example.test/admin/submissions?${search}`),
      ),
    ).toThrow(Response);
  });

  it("allows an explicit view with no optional columns", () => {
    expect(
      parseAdminSubmissionView(
        new URL("https://example.test/admin/submissions?columns="),
      ).columns,
    ).toEqual([]);
  });
});
