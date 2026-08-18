import { describe, expect, it } from "vitest";

import { adminErrorReturn, adminLayoutAllowedRoles } from "./admin-layout";

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

  it("returns access and event-context errors to event selection", () => {
    for (const status of [400, 403, 428]) {
      expect(adminErrorReturn(status, false)).toEqual({
        href: "/events/select",
        label: "Choose an event",
      });
    }
  });

  it("keeps child-route errors inside the loaded administrator context", () => {
    for (const status of [400, 403, 428]) {
      expect(adminErrorReturn(status, true)).toEqual({
        href: "/admin/command",
        label: "Go to Command Centre",
      });
    }
  });

  it("returns 401s to sign-in instead of Command Centre", () => {
    expect(adminErrorReturn(401, true, { pathname: "/admin/command" })).toEqual(
      {
        href: "/sign-in",
        label: "Sign in",
      },
    );
  });

  it("returns evaluation refusals to the persona guide", () => {
    expect(
      adminErrorReturn(403, false, {
        pathname: "/admin/command",
        evaluation: true,
      }),
    ).toEqual({
      href: "/evaluate",
      label: "Choose an evaluation persona",
    });
  });

  it("returns unexpected failures to the administrator home", () => {
    expect(adminErrorReturn(500, false)).toEqual({
      href: "/admin/command",
      label: "Go to Command Centre",
    });
    expect(adminErrorReturn(null, false)).toEqual({
      href: "/admin/command",
      label: "Go to Command Centre",
    });
  });
});
