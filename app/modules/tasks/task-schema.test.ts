import { describe, expect, it } from "vitest";

import { normalizeTaskTemplateDraft } from "./task-schema";

describe("task template form values", () => {
  it("normalizes absent draft fields to controlled form values", () => {
    expect(normalizeTaskTemplateDraft()).toEqual({
      name: "",
      description: "",
      targetType: "speaker",
      taskType: "checklist",
      impact: "medium",
      evidenceMode: "checkbox",
      dueAnchor: "none",
      dueOffsetDays: "",
      fixedDueDate: "",
      autoAssignOnAcceptance: false,
      dependencyIds: [],
    });
  });

  it("preserves blank values when a failed submission is redisplayed", () => {
    expect(
      normalizeTaskTemplateDraft({
        name: "",
        description: "",
        dueOffsetDays: "",
        fixedDueDate: "",
      }),
    ).toMatchObject({
      name: "",
      description: "",
      dueOffsetDays: "",
      fixedDueDate: "",
    });
  });

  it("replaces omitted select values with their typed defaults", () => {
    expect(
      normalizeTaskTemplateDraft({
        targetType: "" as never,
        taskType: "" as never,
        impact: "" as never,
        evidenceMode: "" as never,
        dueAnchor: "" as never,
      }),
    ).toMatchObject({
      targetType: "speaker",
      taskType: "checklist",
      impact: "medium",
      evidenceMode: "checkbox",
      dueAnchor: "none",
    });
  });

  it("replaces malformed select values before controlled redisplay", () => {
    expect(
      normalizeTaskTemplateDraft({
        targetType: "not-a-target",
        taskType: "not-a-task",
        impact: "not-an-impact",
        evidenceMode: "not-an-evidence-mode",
        dueAnchor: "not-a-due-anchor",
      }),
    ).toMatchObject({
      targetType: "speaker",
      taskType: "checklist",
      impact: "medium",
      evidenceMode: "checkbox",
      dueAnchor: "none",
    });
  });
});
