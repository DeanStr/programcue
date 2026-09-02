import { describe, expect, it } from "vitest";

import { suggestedSavedViewName } from "./admin-shell-dialogs";

describe("saved view name suggestion", () => {
  it("describes the current URL filters while ignoring pagination", () => {
    expect(
      suggestedSavedViewName(
        "speakers",
        "/admin/speakers?workflowStatus=confirmed&readiness=needs_attention&page=3",
      ),
    ).toBe("Workflow status: confirmed · Readiness: needs attention");
  });

  it("uses the area name when no URL filters are active", () => {
    expect(suggestedSavedViewName("tasks", "/admin/tasks")).toBe(
      "Tasks & readiness view",
    );
  });
});
