import { describe, expect, it } from "vitest";
import {
  adminSubmissionSearchParams,
  adminSubmissionViewControls,
  parseAdminSubmissionView,
  withAdminSubmissionColumn,
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

  it("keeps earlier column changes when toggles build on each other", () => {
    const start = new URLSearchParams("status=assigned&density=compact");
    const first = withAdminSubmissionColumn(start, "submitter", false);
    const second = withAdminSubmissionColumn(first, "route", false);

    expect(second.toString()).toBe(
      "status=assigned&density=compact&columns=speakers%2Cstatus",
    );
    expect(
      withAdminSubmissionColumn(
        withAdminSubmissionColumn(second, "route", true),
        "submitter",
        true,
      ).toString(),
    ).toBe("status=assigned&density=compact");
  });

  it("reads the grid's view controls from requested parameters", () => {
    expect(
      adminSubmissionViewControls(
        new URLSearchParams("columns=status&density=compact&query=trust"),
      ),
    ).toEqual({ columns: ["status"], density: "compact" });
    expect(adminSubmissionViewControls(new URLSearchParams())).toEqual({
      columns: ["submitter", "route", "speakers", "status"],
      density: "comfortable",
    });
    expect(() =>
      adminSubmissionViewControls(new URLSearchParams("density=unknown")),
    ).toThrow(Response);
  });

  it("restores a shown column in canonical order", () => {
    expect(
      withAdminSubmissionColumn(
        new URLSearchParams("columns=status"),
        "submitter",
        true,
      ).get("columns"),
    ).toBe("submitter,status");
  });
});
