import { describe, expect, it } from "vitest";

import {
  DEFAULT_FORM_SCHEMA,
  formSchemaSchema,
  reviewerVisibleAnswers,
  saveFormSchema,
  visibleFields,
} from "./submission-schema";

const chainedSchema = formSchemaSchema.parse({
  introduction: "Conditional test",
  fields: [
    {
      id: "title",
      label: "Title",
      type: "short_text",
      required: true,
    },
    {
      id: "category",
      label: "Category",
      type: "select",
      required: true,
      options: ["Technical", "Community"],
    },
    {
      id: "format",
      label: "Format",
      type: "select",
      required: true,
      options: ["Workshop", "Talk"],
      reviewVisibility: "reviewers",
      condition: { fieldId: "category", equals: "Technical" },
    },
    {
      id: "setup",
      label: "Workshop setup",
      type: "long_text",
      reviewVisibility: "reviewers",
      condition: { fieldId: "format", equals: "Workshop" },
    },
  ],
});

describe("submission form rules", () => {
  it("keeps chained fields hidden when their controlling field is hidden", () => {
    const answers = {
      title: "A title",
      category: "Community",
      format: "Workshop",
      setup: "Stale hidden setup",
    };

    expect(
      visibleFields(chainedSchema, answers).map((field) => field.id),
    ).toEqual(["title", "category"]);
    expect(reviewerVisibleAnswers(chainedSchema, answers)).toEqual({});
  });

  it("rejects ambiguous options and invalid conditional values", () => {
    const duplicateOptions = structuredClone(chainedSchema);
    duplicateOptions.fields[1].options = ["Technical", "Technical"];
    expect(formSchemaSchema.safeParse(duplicateOptions).success).toBe(false);

    const invalidCondition = structuredClone(chainedSchema);
    invalidCondition.fields[3].condition = {
      fieldId: "format",
      equals: "Panel",
    };
    expect(formSchemaSchema.safeParse(invalidCondition).success).toBe(false);
  });

  it("keeps canonical session fields usable at final submission", () => {
    const input = {
      name: "Call for speakers",
      kind: "submission" as const,
      publicSlug: "call-for-speakers",
      closeDate: null,
      submissionLimit: null,
      minSpeakers: 1,
      maxSpeakers: null,
      accessMode: "email_verified" as const,
      accessPassword: "",
      schema: structuredClone(DEFAULT_FORM_SCHEMA),
      routing: {
        categories: {},
        trackIds: {
          "AI & Innovation": "track-ai",
          "Event Operations": "track-operations",
          "Experience Design": "track-experience",
        },
        trackNames: {
          "track-ai": "AI & Innovation",
          "track-operations": "Event Operations",
          "track-experience": "Experience Design",
        },
        teamNames: {},
        directSessionDurationMinutes: 30,
        passwordHash: null,
      },
    };
    const optionalTitle = structuredClone(input);
    optionalTitle.schema.fields.find(
      (field) => field.id === "title",
    )!.required = false;
    expect(saveFormSchema.safeParse(optionalTitle).success).toBe(false);

    const optionalTracks = structuredClone(input);
    optionalTracks.schema.fields.find(
      (field) => field.id === "category",
    )!.required = false;
    expect(saveFormSchema.safeParse(optionalTracks).success).toBe(false);

    const emptyTracks = structuredClone(input);
    emptyTracks.schema.fields.find(
      (field) => field.id === "category",
    )!.options = [];
    expect(saveFormSchema.safeParse(emptyTracks).success).toBe(false);

    const conditionalDirectFormat = {
      ...structuredClone(input),
      kind: "direct_session" as const,
    };
    conditionalDirectFormat.schema.fields.find(
      (field) => field.id === "format",
    )!.condition = { fieldId: "category", equals: "AI & Innovation" };
    expect(saveFormSchema.safeParse(conditionalDirectFormat).success).toBe(
      false,
    );
  });
});
