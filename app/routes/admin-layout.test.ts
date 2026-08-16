import { describe, expect, it } from "vitest";

import { adminLayoutAllowedRoles } from "./admin-layout";

describe("admin layout role routing", () => {
  it.each([
    "/admin/review",
    "/admin/review/",
    "/admin/review.data",
    "/admin/review/results.csv",
  ])("keeps committee-chair access for %s", (pathname) => {
    expect(adminLayoutAllowedRoles(pathname)).toContain("committee_chair");
  });

  it.each([
    "/admin/reviewer",
    "/admin/reviewing",
    "/admin/review.data-extra",
    "/admin/schedule",
  ])("does not broaden committee-chair access to %s", (pathname) => {
    expect(adminLayoutAllowedRoles(pathname)).not.toContain("committee_chair");
  });
});
