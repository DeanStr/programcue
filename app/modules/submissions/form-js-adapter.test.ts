import { describe, expect, it } from "vitest";

import {
  FormJsAdapterError,
  fromFormJsSchema,
  PROGRAM_CUE_FORM_JS_TYPES,
  toFormJsSchema,
} from "./form-js-adapter";
import type { SubmissionFormSchema } from "./submission-schema";

const form: SubmissionFormSchema = {
  introduction: "Bring a useful idea.",
  fields: [
    {
      id: "title",
      label: "Session title",
      type: "short_text",
      required: true,
      help: "Keep it concise.",
      options: [],
      reviewVisibility: "reviewers",
      condition: null,
    },
    {
      id: "category",
      label: "Category",
      type: "select",
      required: true,
      help: "",
      options: ["Operations", 'People "and" culture'],
      reviewVisibility: "reviewers",
      condition: null,
    },
    {
      id: "format",
      label: "Format",
      type: "select",
      required: true,
      help: "",
      options: ["Presentation", "Workshop"],
      reviewVisibility: "reviewers",
      condition: null,
    },
    {
      id: "setup",
      label: "Room setup",
      type: "long_text",
      required: true,
      help: "Describe the room.",
      options: [],
      reviewVisibility: "administrators_only",
      condition: { fieldId: "category", equals: 'People "and" culture' },
    },
    {
      id: "materials",
      label: "Materials",
      type: "multi_select",
      required: false,
      help: "",
      options: ["Projector", "Tables"],
      reviewVisibility: "administrators_only",
      condition: null,
    },
    {
      id: "reference_url",
      label: "Reference URL",
      type: "url",
      required: false,
      help: "",
      options: [],
      reviewVisibility: "reviewers",
      condition: null,
    },
    {
      id: "talk_video",
      label: "Talk video",
      type: "video",
      required: false,
      help: "",
      options: [],
      reviewVisibility: "administrators_only",
      condition: null,
    },
  ],
};

describe("Program Cue form-js adapter", () => {
  it("round-trips the normalized conference schema without losing semantics", () => {
    const visual = toFormJsSchema(form);

    expect(visual.components.map((component) => component.type)).toEqual([
      "text",
      PROGRAM_CUE_FORM_JS_TYPES.title,
      PROGRAM_CUE_FORM_JS_TYPES.category,
      PROGRAM_CUE_FORM_JS_TYPES.format,
      "textarea",
      "checklist",
      PROGRAM_CUE_FORM_JS_TYPES.url,
      PROGRAM_CUE_FORM_JS_TYPES.video,
    ]);
    expect(visual.components[4]?.conditional?.hide).toBe(
      '=category != "People \\"and\\" culture"',
    );
    expect(fromFormJsSchema(visual)).toEqual(form);
  });

  it("accepts a supported form-js field and applies Program Cue defaults", () => {
    const visual = toFormJsSchema(form);
    visual.components.push({
      id: "Field_new",
      type: "textfield",
      key: "audience_takeaway",
      label: "Audience takeaway",
    });

    const normalized = fromFormJsSchema(visual);
    expect(normalized.fields.at(-1)).toEqual({
      id: "audience_takeaway",
      label: "Audience takeaway",
      type: "short_text",
      required: false,
      help: "",
      options: [],
      reviewVisibility: "administrators_only",
      condition: null,
    });
  });

  it("fails explicitly for fields outside the product adapter", () => {
    const visual = toFormJsSchema(form) as unknown as {
      components: Array<Record<string, unknown>>;
    };
    visual.components.push({
      id: "Field_number",
      type: "number",
      key: "attendee_count",
      label: "Attendee count",
    });

    expect(() => fromFormJsSchema(visual)).toThrowError(
      /Unsupported form-js schema.*type/i,
    );
  });

  it("fails instead of dropping unsupported visual settings", () => {
    const visual = toFormJsSchema(form) as unknown as {
      components: Array<Record<string, unknown>>;
    };
    visual.components[1]!.readonly = true;

    expect(() => fromFormJsSchema(visual)).toThrowError(FormJsAdapterError);
    expect(() => fromFormJsSchema(visual)).toThrowError(/readonly/i);

    const missingAccessMetadata = structuredClone(toFormJsSchema(form));
    delete missingAccessMetadata.components[1]!.programCue;
    expect(() => fromFormJsSchema(missingAccessMetadata)).toThrowError(
      /missing its Program Cue access metadata/i,
    );

    const conditionalIntroduction = structuredClone(toFormJsSchema(form));
    conditionalIntroduction.components[0]!.conditional = {
      hide: '=category != "Workshop"',
    };
    expect(() => fromFormJsSchema(conditionalIntroduction)).toThrowError(
      /introduction cannot define conditional/i,
    );

    const textBlockContent = structuredClone(toFormJsSchema(form));
    textBlockContent.components[1]!.text = "This must not be discarded.";
    expect(() => fromFormJsSchema(textBlockContent)).toThrowError(
      /cannot define text-block content/i,
    );
  });

  it("rejects unrestricted FEEL and non-normalized choice values", () => {
    const arbitraryCondition = structuredClone(toFormJsSchema(form));
    arbitraryCondition.components[4]!.conditional = {
      hide: "=category = null or attendee_count > 100",
    };
    expect(() => fromFormJsSchema(arbitraryCondition)).toThrowError(
      /supported equality form/i,
    );

    const splitLabel = structuredClone(toFormJsSchema(form));
    splitLabel.components[2]!.values![0] = {
      label: "Event operations",
      value: "ops",
    };
    expect(() => fromFormJsSchema(splitLabel)).toThrowError(
      /same stored value and visible label/i,
    );
  });

  it("rejects multi-column layout and protected-field identity drift", () => {
    const multiColumn = structuredClone(toFormJsSchema(form)) as unknown as {
      components: Array<Record<string, unknown>>;
    };
    multiColumn.components[1]!.layout = { columns: 8, row: "Row_1" };
    expect(() => fromFormJsSchema(multiColumn)).toThrowError(/columns/i);

    const renamedTitle = structuredClone(toFormJsSchema(form));
    renamedTitle.components[1]!.key = "renamed_title";
    expect(() => fromFormJsSchema(renamedTitle)).toThrowError(
      /reserved for the title conference field/i,
    );
  });
});
