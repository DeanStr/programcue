import { describe, expect, it } from "vitest";

import { closeDateToEpoch } from "./submission-repository-shared";
import {
  DEFAULT_FORM_PRESENTATION,
  DEFAULT_FORM_SCHEMA,
  formPresentationSchema,
  formSchemaSchema,
  formSectionsForAuthoring,
  formSectionsForDisplay,
  heroImagePathSchema,
  reviewerVisibleAnswers,
  saveFormSchema,
  storedFormSchemaSchema,
  upgradeStoredFormSchema,
  validateFinalAnswers,
  visibleFields,
} from "./submission-schema";

const chainedSchema = formSchemaSchema.parse({
  schemaVersion: 2,
  introduction: "Conditional test",
  sections: [{ id: "proposal", title: "Proposal" }],
  fields: [
    {
      id: "title",
      label: "Title",
      type: "short_text",
      required: true,
      sectionId: "proposal",
    },
    {
      id: "category",
      label: "Category",
      type: "select",
      required: true,
      options: ["Technical", "Community"],
      sectionId: "proposal",
    },
    {
      id: "format",
      label: "Format",
      type: "select",
      required: true,
      options: ["Workshop", "Talk"],
      reviewVisibility: "reviewers",
      condition: { fieldId: "category", equals: "Technical" },
      sectionId: "proposal",
    },
    {
      id: "setup",
      label: "Workshop setup",
      type: "long_text",
      reviewVisibility: "reviewers",
      condition: { fieldId: "format", equals: "Workshop" },
      sectionId: "proposal",
    },
  ],
});

describe("submission form rules", () => {
  it("requires explicit valid sections in schema v2", () => {
    const unknownSection = structuredClone(DEFAULT_FORM_SCHEMA);
    unknownSection.fields[0]!.sectionId = "missing";
    expect(formSchemaSchema.safeParse(unknownSection).success).toBe(false);

    const duplicateSection = structuredClone(DEFAULT_FORM_SCHEMA);
    duplicateSection.sections.push(
      structuredClone(duplicateSection.sections[0]!),
    );
    expect(formSchemaSchema.safeParse(duplicateSection).success).toBe(false);

    const missingReference = structuredClone(DEFAULT_FORM_SCHEMA);
    Reflect.deleteProperty(missingReference.fields[0]!, "sectionId");
    expect(formSchemaSchema.safeParse(missingReference).success).toBe(false);
  });

  it("keeps empty sections in the authoring projection only", () => {
    const schema = structuredClone(DEFAULT_FORM_SCHEMA);
    schema.sections.push({
      id: "supporting_material",
      title: "Supporting material",
      description: "Optional links and files",
    });

    expect(
      formSectionsForAuthoring(schema).map((section) => ({
        id: section.id,
        fieldCount: section.fields.length,
      })),
    ).toEqual([
      { id: "proposal", fieldCount: DEFAULT_FORM_SCHEMA.fields.length },
      { id: "supporting_material", fieldCount: 0 },
    ]);
    expect(formSectionsForDisplay(schema).map((section) => section.id)).toEqual(
      ["proposal"],
    );
  });

  it("reads immutable schema v1 and upgrades it deterministically for editing", () => {
    const legacy = {
      introduction: DEFAULT_FORM_SCHEMA.introduction,
      presentation: DEFAULT_FORM_SCHEMA.presentation,
      fields: DEFAULT_FORM_SCHEMA.fields.map(
        ({ sectionId: _sectionId, ...field }) => field,
      ),
    };
    const stored = storedFormSchemaSchema.parse(legacy);

    expect(formSectionsForDisplay(stored)[0]).toMatchObject({
      id: "legacy_application",
      title: null,
    });
    expect(upgradeStoredFormSchema(stored)).toEqual(
      upgradeStoredFormSchema(stored),
    );
    expect(upgradeStoredFormSchema(stored)).toMatchObject({
      schemaVersion: 2,
      sections: [{ id: "proposal", title: "Application" }],
      fields: legacy.fields.map((field) => ({
        ...field,
        sectionId: "proposal",
      })),
    });
    expect(
      storedFormSchemaSchema.safeParse({ ...legacy, schemaVersion: 3 }).success,
    ).toBe(false);
  });

  it("keeps public promotion opt-in and validates presentation links", () => {
    expect(formPresentationSchema.parse({})).toMatchObject({
      invitationHeading: "",
      invitationText: "",
      showFeaturedSpeakers: false,
    });
    expect(
      formPresentationSchema.parse({ eventWebsiteUrl: "" }).eventWebsiteUrl,
    ).toBe("");
    expect(DEFAULT_FORM_PRESENTATION.showFeaturedSpeakers).toBe(false);
    expect(DEFAULT_FORM_PRESENTATION.invitationHeading).toBe("");
    expect(DEFAULT_FORM_PRESENTATION.invitationText).toBe("");
    expect(
      formPresentationSchema.safeParse({ invitationHeading: "x".repeat(161) })
        .success,
    ).toBe(false);
    expect(
      formPresentationSchema.safeParse({ invitationText: "x".repeat(2_001) })
        .success,
    ).toBe(false);
    expect(
      formPresentationSchema.safeParse({
        eventWebsiteUrl: "https://events.example.com/cfp",
      }).success,
    ).toBe(true);
    for (const eventWebsiteUrl of [
      "https://",
      "http://events.example.com",
      "https://user:secret@events.example.com",
    ]) {
      const result = formPresentationSchema.safeParse({ eventWebsiteUrl });
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0]?.message).toBe(
          "Enter a valid URL beginning with https://",
        );
      }
    }
    expect(
      formPresentationSchema.safeParse({ organizerRole: "Programme chair" })
        .success,
    ).toBe(false);
    expect(heroImagePathSchema.parse("/images/event-hero.webp")).toBe(
      "/images/event-hero.webp",
    );
    for (const heroImagePath of [
      "https://tracker.example/hero.webp",
      "/images/../private.webp",
      "/api/v1/health",
    ]) {
      expect(heroImagePathSchema.safeParse(heroImagePath).success).toBe(false);
    }
  });

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

  it("rejects credentialed applicant URLs instead of storing them", () => {
    expect(
      validateFinalAnswers(
        DEFAULT_FORM_SCHEMA,
        {
          title: "A useful session title",
          description: "A useful session description with enough detail.",
          category: ["AI & Innovation"],
          format: "Presentation",
          video: "https://user:secret@example.test/video",
        },
        [],
        0,
        null,
      ).video,
    ).toEqual(["Enter a valid URL beginning with https://"]);
  });

  it("rejects speakers with a missing or invalid email", () => {
    expect(
      validateFinalAnswers(
        DEFAULT_FORM_SCHEMA,
        {
          title: "A useful session title",
          description: "A useful session description with enough detail.",
          category: ["AI & Innovation"],
          format: "Presentation",
        },
        [{ name: "Alex Morgan", email: "" }],
        1,
        null,
      ).speakers,
    ).toEqual(["Every speaker needs a name and email address"]);
    expect(
      validateFinalAnswers(
        DEFAULT_FORM_SCHEMA,
        {
          title: "A useful session title",
          description: "A useful session description with enough detail.",
          category: ["AI & Innovation"],
          format: "Presentation",
        },
        [{ name: "Alex Morgan", email: "not-an-email" }],
        1,
        null,
      ).speakers,
    ).toEqual(["Every speaker needs a valid email address"]);
  });

  it("resolves form close times when the following local midnight is skipped", () => {
    expect(() =>
      closeDateToEpoch("2026-09-05", "America/Santiago"),
    ).not.toThrow();
    expect(closeDateToEpoch("2026-09-05", "America/Santiago")).toBe(
      Date.parse("2026-09-06T03:59:59.000Z") / 1_000,
    );
  });

  it("rejects ambiguous options and invalid conditional values", () => {
    const duplicateOptions = structuredClone(chainedSchema);
    duplicateOptions.fields[1].options = ["Technical", " technical "];
    expect(formSchemaSchema.safeParse(duplicateOptions).success).toBe(false);

    const invalidCondition = structuredClone(chainedSchema);
    invalidCondition.fields[3].condition = {
      fieldId: "format",
      equals: "Panel",
    };
    expect(formSchemaSchema.safeParse(invalidCondition).success).toBe(false);
  });

  it("validates conditional order using the applicant-visible section order", () => {
    const invalidOrder = structuredClone(chainedSchema);
    invalidOrder.sections = [
      { id: "details", title: "Details", description: "" },
      ...invalidOrder.sections,
    ];
    invalidOrder.fields.find((field) => field.id === "setup")!.sectionId =
      "details";

    expect(formSchemaSchema.safeParse(invalidOrder).success).toBe(false);
  });

  it("evaluates conditional visibility in section order rather than raw field storage order", () => {
    const sectionOrdered = structuredClone(chainedSchema);
    sectionOrdered.sections.push({
      id: "details",
      title: "Details",
      description: "",
    });
    const setup = sectionOrdered.fields.find((field) => field.id === "setup")!;
    setup.sectionId = "details";
    sectionOrdered.fields = [
      setup,
      ...sectionOrdered.fields.filter((field) => field.id !== "setup"),
    ];

    const parsed = formSchemaSchema.parse(sectionOrdered);
    expect(
      visibleFields(parsed, {
        category: "Technical",
        format: "Workshop",
      }).map((field) => field.id),
    ).toEqual(["title", "category", "format", "setup"]);
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

    expect(
      saveFormSchema.safeParse({ ...input, maxSpeakers: 21 }).success,
    ).toBe(false);

    const conditionalDirectFormat = {
      ...structuredClone(input),
      kind: "direct_session" as const,
    };
    conditionalDirectFormat.schema.fields.find(
      (field) => field.id === "category",
    )!.type = "select";
    conditionalDirectFormat.schema.fields.find(
      (field) => field.id === "format",
    )!.condition = { fieldId: "category", equals: "AI & Innovation" };
    expect(saveFormSchema.safeParse(conditionalDirectFormat).success).toBe(
      false,
    );

    const placeholderExample = structuredClone(input);
    placeholderExample.schema.fields.find(
      (field) => field.id === "video",
    )!.example = "https://…";
    const rejected = saveFormSchema.safeParse(placeholderExample);
    expect(rejected.success).toBe(false);
    if (!rejected.success) {
      expect(
        rejected.error.issues.some((issue) => issue.path.includes("example")),
      ).toBe(true);
    }
    expect(
      storedFormSchemaSchema.safeParse(placeholderExample.schema).success,
    ).toBe(true);
    expect(saveFormSchema.safeParse(input).success).toBe(true);
    expect(
      saveFormSchema.safeParse({ ...input, closeDate: "2027-02-30" }).success,
    ).toBe(false);
    expect(
      saveFormSchema.safeParse({ ...input, publicSlug: "a".repeat(161) })
        .success,
    ).toBe(false);
  });
});
