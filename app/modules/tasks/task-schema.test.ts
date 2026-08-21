import { describe, expect, it } from "vitest";

import {
  assignedTaskConfigurationSchema,
  normalizeTaskTemplateDraft,
  taskDestinationUrlSchema,
  taskTemplateInputSchema,
} from "./task-schema";

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
      destinationUrl: "",
      fileScope: "",
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

  it("accepts only credential-free HTTPS task destinations", () => {
    expect(taskDestinationUrlSchema.parse("https://example.test/brief")).toBe(
      "https://example.test/brief",
    );
    expect(() =>
      taskDestinationUrlSchema.parse("http://intranet.test/brief"),
    ).toThrow(/HTTPS/);
    expect(() =>
      taskDestinationUrlSchema.parse("https://user:secret@example.test/brief"),
    ).toThrow(/credentials/);
  });

  it("requires destinations only for link-visit templates", () => {
    const base = {
      name: "Read the participant brief",
      description: "Review the event requirements.",
      targetType: "speaker" as const,
      taskType: "link_visit" as const,
      impact: "medium" as const,
      evidenceMode: "link" as const,
      dueAnchor: "none" as const,
      dueOffsetDays: null,
      fixedDueDate: null,
      autoAssignOnAcceptance: false,
      dependencyIds: [],
    };
    expect(() => taskTemplateInputSchema.parse(base)).toThrow(
      /require an HTTPS destination URL/,
    );
    expect(
      taskTemplateInputSchema.parse({
        ...base,
        configuration: { destinationUrl: "https://example.test/brief" },
      }).configuration.destinationUrl,
    ).toBe("https://example.test/brief");
    expect(() =>
      taskTemplateInputSchema.parse({
        ...base,
        taskType: "checklist",
        evidenceMode: "checkbox",
        configuration: { destinationUrl: "https://example.test/brief" },
      }),
    ).toThrow(/only supported by link-visit tasks/);
  });

  it("requires file tasks to declare a purpose that matches their target", () => {
    const base = {
      name: "Upload presentation slides",
      description: "Upload the final presentation deck.",
      targetType: "session" as const,
      taskType: "file_upload" as const,
      impact: "high" as const,
      evidenceMode: "file" as const,
      dueAnchor: "none" as const,
      dueOffsetDays: null,
      fixedDueDate: null,
      autoAssignOnAcceptance: false,
      dependencyIds: [],
    };
    expect(() => taskTemplateInputSchema.parse(base)).toThrow(
      /must identify a participant document or session deliverable/,
    );
    expect(
      taskTemplateInputSchema.parse({
        ...base,
        configuration: { fileScope: "session_deliverable" },
      }).configuration.fileScope,
    ).toBe("session_deliverable");
    expect(() =>
      taskTemplateInputSchema.parse({
        ...base,
        targetType: "speaker",
        configuration: { fileScope: "session_deliverable" },
      }),
    ).toThrow(/must use session scope/);
  });

  it("keeps internal resource bindings outside organizer configuration", () => {
    expect(
      assignedTaskConfigurationSchema.parse({
        resourcePageId: "resource-speaker-handbook",
      }),
    ).toEqual({ resourcePageId: "resource-speaker-handbook" });
    expect(() =>
      taskTemplateInputSchema.parse({
        name: "Read the speaker handbook",
        description: "Read and acknowledge the current handbook.",
        targetType: "speaker",
        taskType: "acknowledgement",
        impact: "medium",
        evidenceMode: "checkbox",
        dueAnchor: "none",
        dueOffsetDays: null,
        fixedDueDate: null,
        autoAssignOnAcceptance: false,
        dependencyIds: [],
        configuration: { resourcePageId: "resource-speaker-handbook" },
      }),
    ).toThrow(/Unrecognized key/);
  });

  it("reserves the session-details preset for its complete built-in shape", () => {
    const preset = {
      name: "Review session details",
      description: "Review the shared session details.",
      targetType: "session" as const,
      taskType: "acknowledgement" as const,
      impact: "high" as const,
      evidenceMode: "checkbox" as const,
      dueAnchor: "none" as const,
      dueOffsetDays: null,
      fixedDueDate: null,
      autoAssignOnAcceptance: true,
      dependencyIds: [],
      configuration: { preset: "session_details_review_v1" as const },
    };
    expect(taskTemplateInputSchema.parse(preset)).toMatchObject(preset);
    for (const drifted of [
      { ...preset, impact: "low" },
      { ...preset, dueOffsetDays: 1 },
      { ...preset, dependencyIds: ["another-template"] },
    ]) {
      expect(() => taskTemplateInputSchema.parse(drifted)).toThrow(
        /must use the fixed high-impact/i,
      );
    }
  });
});
