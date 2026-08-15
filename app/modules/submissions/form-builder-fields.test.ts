import { describe, expect, it } from "vitest";

import {
  conditionalFieldOrderIssue,
  formConditionSourceLabel,
  formFieldCreationIssue,
  formFieldTypeLabel,
} from "./form-builder-fields";
import {
  DEFAULT_FORM_SCHEMA,
  MAX_FORM_FIELDS,
  type FormField,
} from "./submission-schema";

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
});
