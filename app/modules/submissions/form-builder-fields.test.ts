import { describe, expect, it } from "vitest";

import {
  conditionalFieldOrderIssue,
  createFormField,
  formConditionSourceLabel,
  formFieldCreationIssue,
  formFieldTypeLabel,
  insertFormFieldAtTarget,
  moveFormFieldToTarget,
} from "./form-builder-fields";
import { synchronizeSubmissionFormEventChoices } from "./submission-form-choice-synchronization";
import {
  DEFAULT_FORM_SCHEMA,
  type FormField,
  MAX_FORM_FIELDS,
  saveFormSchema,
} from "./submission-schema";

describe("restored form event choices", () => {
  function savedDraft() {
    const schema = structuredClone(DEFAULT_FORM_SCHEMA);
    schema.fields.find((field) => field.id === "category")!.options = [
      "Leadership",
    ];
    schema.fields.find((field) => field.id === "format")!.options = [
      "Workshop",
    ];
    schema.fields.push({
      ...createFormField(schema.fields, "long_text", "proposal"),
      id: "leadership_outcomes",
      label: "Leadership outcomes",
      condition: { fieldId: "category", equals: "Leadership" },
    });
    return saveFormSchema.parse({
      id: "form-recovery",
      revision: 3,
      draftRevision: 7,
      name: "Recovery form",
      kind: "submission",
      publicSlug: "recovery-form",
      closeDate: null,
      submissionLimit: null,
      minSpeakers: 1,
      maxSpeakers: null,
      accessMode: "email_verified",
      accessPassword: "",
      schema,
      routing: {
        categories: { Leadership: "team-leadership" },
        trackIds: { Leadership: "track-leadership" },
        trackNames: { "track-leadership": "Leadership" },
        formatKeys: { Workshop: "workshop" },
        teamNames: { "team-leadership": "Leadership reviewers" },
        directSessionDurationMinutes: 30,
        passwordHash: null,
      },
    });
  }

  it("preserves local edits and revisions while mapping renamed choices, routes and conditions by stable identity", () => {
    const draft = savedDraft();
    const original = structuredClone(draft);
    const restored = synchronizeSubmissionFormEventChoices(
      draft,
      [{ id: "track-leadership", name: "Strategy" }],
      [{ key: "workshop", label: "Hands-on lab" }],
    );
    expect(saveFormSchema.safeParse(restored).success).toBe(true);
    expect(restored).toMatchObject({
      id: draft.id,
      revision: 3,
      draftRevision: 7,
    });
    expect(
      restored.schema.fields.find((field) => field.id === "category")?.options,
    ).toEqual(["Strategy"]);
    expect(
      restored.schema.fields.find((field) => field.id === "format")?.options,
    ).toEqual(["Hands-on lab"]);
    expect(
      restored.schema.fields.find((field) => field.id === "materials")
        ?.condition,
    ).toEqual({ fieldId: "format", equals: "Hands-on lab" });
    expect(restored.schema.fields.at(-1)).toEqual({
      ...draft.schema.fields.at(-1),
      condition: { fieldId: "category", equals: "Strategy" },
    });
    expect(restored.routing.categories).toEqual({
      Strategy: "team-leadership",
    });
    expect(restored.routing.trackIds).toEqual({ Strategy: "track-leadership" });
    expect(restored.routing.formatKeys).toEqual({ "Hands-on lab": "workshop" });
    expect(draft).toEqual(original);
  });

  it("retains conditions for removed choices so the organiser must repair them before saving", () => {
    const restored = synchronizeSubmissionFormEventChoices(
      savedDraft(),
      [{ id: "track-new", name: "Strategy" }],
      [{ key: "talk", label: "Talk" }],
    );
    expect(restored.schema.fields.at(-1)?.condition).toEqual({
      fieldId: "category",
      equals: "Leadership",
    });
    expect(
      restored.schema.fields.find((field) => field.id === "materials")
        ?.condition,
    ).toEqual({ fieldId: "format", equals: "Workshop" });
    expect(restored.routing.categories).toEqual({});
    expect(saveFormSchema.safeParse(restored).success).toBe(false);
  });
});

describe("form builder field rules", () => {
  it("uses exhaustive labels for every supported field type", () => {
    expect(
      DEFAULT_FORM_SCHEMA.fields.map((field) => formFieldTypeLabel(field.type)),
    ).toEqual([
      "Short text",
      "Long text",
      "Multiple choice",
      "Dropdown",
      "Long text",
      "Video upload or URL",
    ]);
  });

  it("uses human-readable labels for conditional dependencies", () => {
    expect(formConditionSourceLabel(DEFAULT_FORM_SCHEMA.fields, "format")).toBe(
      "Format",
    );
    expect(
      formConditionSourceLabel(DEFAULT_FORM_SCHEMA.fields, "missing_field"),
    ).toBe("Missing field “missing_field”");
  });

  it("generates meaningful stable IDs once and resolves collisions", () => {
    const first = createFormField([], "short_text", "proposal");
    const second = createFormField([first], "short_text", "proposal");
    expect(first).toMatchObject({ id: "short_text", label: "Short text" });
    expect(second).toMatchObject({ id: "short_text_2", label: "Short text" });
    for (const type of [
      "short_text",
      "long_text",
      "select",
      "multi_select",
      "url",
      "video",
    ] as const) {
      expect(createFormField([], type, "proposal").id).toMatch(
        /^[a-z][a-z0-9_]*$/u,
      );
    }
  });

  it("rejects field creation as soon as a form limit would be exceeded", () => {
    expect(formFieldCreationIssue(DEFAULT_FORM_SCHEMA.fields, "video")).toBe(
      "A form can contain at most one native video upload field.",
    );
    const fullForm = Array.from({ length: MAX_FORM_FIELDS }, (_, index) => ({
      ...DEFAULT_FORM_SCHEMA.fields[0]!,
      id: `field_${index + 1}`,
    })) satisfies FormField[];
    expect(formFieldCreationIssue(fullForm, "short_text")).toBe(
      `A form can contain at most ${MAX_FORM_FIELDS} fields.`,
    );
  });

  it("rejects moving a conditional field before its dependency", () => {
    expect(conditionalFieldOrderIssue(DEFAULT_FORM_SCHEMA.fields)).toBeNull();

    const fields = structuredClone(DEFAULT_FORM_SCHEMA.fields);
    const formatIndex = fields.findIndex((field) => field.id === "format");
    const [format] = fields.splice(formatIndex, 1);
    fields.splice(formatIndex + 1, 0, format!);

    expect(conditionalFieldOrderIssue(fields)).toBe(
      "Cannot reorder fields: “Materials and room setup” must remain after “Format” because its condition depends on that field.",
    );
  });

  it("inserts a field into an explicitly selected empty section", () => {
    const fields = [
      { ...DEFAULT_FORM_SCHEMA.fields[0]!, id: "a1", sectionId: "a" },
      { ...DEFAULT_FORM_SCHEMA.fields[0]!, id: "a2", sectionId: "a" },
    ];
    const inserted = {
      ...DEFAULT_FORM_SCHEMA.fields[0]!,
      id: "b1",
      sectionId: "b",
    };

    expect(
      insertFormFieldAtTarget(fields, inserted, { sectionId: "b", index: 0 }, [
        "a",
        "b",
      ]),
    ).toEqual([...fields, inserted]);
  });

  it("moves fields using an explicit section and section-local position", () => {
    const fields = [
      { ...DEFAULT_FORM_SCHEMA.fields[0]!, id: "a1", sectionId: "a" },
      { ...DEFAULT_FORM_SCHEMA.fields[0]!, id: "a2", sectionId: "a" },
      { ...DEFAULT_FORM_SCHEMA.fields[0]!, id: "b1", sectionId: "b" },
    ];

    expect(
      moveFormFieldToTarget(fields, "a2", { sectionId: "b", index: 0 }, [
        "a",
        "b",
      ]),
    ).toEqual([fields[0], { ...fields[1], sectionId: "b" }, fields[2]]);
    expect(
      moveFormFieldToTarget(fields, "a1", { sectionId: "a", index: 1 }, [
        "a",
        "b",
      ]),
    ).toBeNull();
  });

  it("fails fast for unknown sections and invalid section-local positions", () => {
    const fields = [
      { ...DEFAULT_FORM_SCHEMA.fields[0]!, id: "a1", sectionId: "a" },
    ];
    const inserted = {
      ...DEFAULT_FORM_SCHEMA.fields[0]!,
      id: "new",
      sectionId: "a",
    };

    expect(() =>
      insertFormFieldAtTarget(
        fields,
        inserted,
        { sectionId: "missing", index: 0 },
        ["a"],
      ),
    ).toThrow("Cannot insert into unknown form section “missing”.");
    expect(() =>
      moveFormFieldToTarget(fields, "a1", { sectionId: "a", index: 2 }, ["a"]),
    ).toThrow("The form field insertion position is invalid.");
  });
});
