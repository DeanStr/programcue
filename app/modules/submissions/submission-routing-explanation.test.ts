import { describe, expect, it } from "vitest";
import {
  classifySubmissionRouting,
  explainSubmissionRouting,
  type SubmissionRoutingExplanation,
} from "./submission-routing-explanation";
import {
  ADMIN_MANUAL_ENTRY_FORM_VERSION_ID,
  type FormRouting,
} from "./submission-schema";

const routing: FormRouting = {
  categories: {
    "AI & Innovation": "team-workshops",
    Leadership: "team-workshops",
  },
  trackIds: {
    "AI & Innovation": "track-ai",
    Leadership: "track-leadership",
    Community: "track-community",
  },
  trackNames: {
    "track-ai": "AI & Innovation",
    "track-leadership": "Leadership",
    "track-community": "Community",
  },
  teamNames: {
    "team-workshops": "Workshop review team",
    "team-general": "General review team",
  },
  directSessionDurationMinutes: null,
  passwordHash: null,
};

function explain(
  overrides: Partial<Parameters<typeof explainSubmissionRouting>[0]> = {},
): SubmissionRoutingExplanation {
  return explainSubmissionRouting({
    submissionId: "submission-1",
    status: "submitted",
    formVersionId: "form-version-3",
    snapshotFormVersionId: "form-version-3",
    snapshotVersionNumber: 3,
    formName: "Call for Speakers",
    versionNumber: 3,
    routing,
    selectedTracks: [{ trackId: "track-ai", trackName: "AI & Innovation" }],
    routedTeamIds: ["team-workshops"],
    ...overrides,
  });
}

describe("submission routing explanation", () => {
  it("classifies queue attention without coupling it to evaluator assignment", () => {
    const base = {
      submissionId: "submission-1",
      status: "submitted",
      formVersionId: "form-version-3" as string | null,
      snapshotFormVersionId: "form-version-3" as string | null,
      versionNumber: 3 as number | null,
      snapshotVersionNumber: 3 as number | null,
      routing,
      selectedTracks: [
        { trackId: "track-ai", trackName: "AI & Innovation" },
      ],
      routedTeamIds: ["team-workshops"],
    };
    expect(classifySubmissionRouting(base)).toBe("automatic");
    expect(
      classifySubmissionRouting({
        ...base,
        selectedTracks: [
          { trackId: "track-community", trackName: "Community" },
        ],
        routedTeamIds: [],
      }),
    ).toBe("missing_automatic");
    expect(
      classifySubmissionRouting({
        ...base,
        formVersionId: null,
        snapshotFormVersionId: ADMIN_MANUAL_ENTRY_FORM_VERSION_ID,
        versionNumber: null,
        snapshotVersionNumber: 1,
        routedTeamIds: ["team-general"],
      }),
    ).toBe("manual_override");
    expect(
      classifySubmissionRouting({
        ...base,
        formVersionId: null,
        snapshotFormVersionId: ADMIN_MANUAL_ENTRY_FORM_VERSION_ID,
        versionNumber: null,
        snapshotVersionNumber: 1,
        routedTeamIds: [],
      }),
    ).toBe("manual_unassigned");
    expect(classifySubmissionRouting({ ...base, status: "draft" })).toBe(
      "draft",
    );
    expect(() =>
      classifySubmissionRouting({
        ...base,
        snapshotFormVersionId: "another-form-version",
      }),
    ).toThrow(/conflicting immutable form-version identities/i);
    expect(() =>
      classifySubmissionRouting({
        ...base,
        snapshotVersionNumber: 2,
      }),
    ).toThrow(/conflicting immutable form-version identities/i);
    expect(() =>
      classifySubmissionRouting({
        ...base,
        routedTeamIds: ["team-general"],
      }),
    ).toThrow(/persisted routed teams that do not match/i);
    expect(
      classifySubmissionRouting({
        ...base,
        selectedTracks: [
          { trackId: "track-ai", trackName: "AI & Innovation" },
          { trackId: "track-community", trackName: "Community" },
        ],
      }),
    ).toBe("missing_automatic");
  });

  it("explains an automatic route from immutable form and routing data", () => {
    expect(explain()).toEqual({
      source: {
        kind: "published_form",
        formName: "Call for Speakers",
        versionNumber: 3,
      },
      routes: [
        {
          trackId: "track-ai",
          trackName: "AI & Innovation",
          teamId: "team-workshops",
          teamName: "Workshop review team",
        },
      ],
      routedTeams: [{ id: "team-workshops", name: "Workshop review team" }],
    });
  });

  it("keeps each selected track while deduplicating the persisted routed team", () => {
    expect(
      explain({
        selectedTracks: [
          { trackId: "track-ai", trackName: "AI & Innovation" },
          { trackId: "track-leadership", trackName: "Leadership" },
        ],
      }).routes,
    ).toEqual([
      {
        trackId: "track-ai",
        trackName: "AI & Innovation",
        teamId: "team-workshops",
        teamName: "Workshop review team",
      },
      {
        trackId: "track-leadership",
        trackName: "Leadership",
        teamId: "team-workshops",
        teamName: "Workshop review team",
      },
    ]);
  });

  it("states when a selected track has no automatic team route", () => {
    expect(
      explain({
        selectedTracks: [
          { trackId: "track-community", trackName: "Community" },
        ],
        routedTeamIds: [],
      }).routes,
    ).toEqual([
      {
        trackId: "track-community",
        trackName: "Community",
        teamId: null,
        teamName: null,
      },
    ]);
  });

  it("labels manual review teams as an override without inventing track causality", () => {
    expect(
      explain({
        formName: null,
        formVersionId: null,
        versionNumber: null,
        snapshotFormVersionId: ADMIN_MANUAL_ENTRY_FORM_VERSION_ID,
        snapshotVersionNumber: 1,
        selectedTracks: [{ trackId: "track-ai", trackName: "AI & Innovation" }],
        routedTeamIds: ["team-general"],
      }),
    ).toEqual({
      source: {
        kind: "administrator_manual_entry",
        formName: null,
        versionNumber: null,
      },
      routes: [
        {
          trackId: "track-ai",
          trackName: "AI & Innovation",
          teamId: null,
          teamName: null,
        },
      ],
      routedTeams: [{ id: "team-general", name: "General review team" }],
    });
  });

  it("labels an unsubmitted form version as unrouted", () => {
    expect(
      explain({ status: "draft", selectedTracks: [], routedTeamIds: [] }),
    ).toEqual({
      source: {
        kind: "form_draft",
        formName: "Call for Speakers",
        versionNumber: 3,
      },
      routes: [],
      routedTeams: [],
    });
  });

  it("fails when persisted track identity disagrees with the immutable snapshot", () => {
    expect(() =>
      explain({
        selectedTracks: [
          { trackId: "track-ai", trackName: "Renamed after submission" },
        ],
      }),
    ).toThrow("does not match its immutable routing snapshot");
  });

  it("also validates immutable track identity for manual entries", () => {
    expect(() =>
      explain({
        formName: null,
        formVersionId: null,
        versionNumber: null,
        snapshotFormVersionId: ADMIN_MANUAL_ENTRY_FORM_VERSION_ID,
        snapshotVersionNumber: 1,
        selectedTracks: [
          { trackId: "track-ai", trackName: "Renamed after submission" },
        ],
        routedTeamIds: ["team-general"],
      }),
    ).toThrow("does not match its immutable routing snapshot");
  });

  it("fails instead of hiding a persisted routing-team mismatch", () => {
    expect(() => explain({ routedTeamIds: [] })).toThrow(
      "persisted routed teams that do not match",
    );
  });

  it("does not mislabel a submission with a missing form-version link as manual", () => {
    expect(() =>
      explain({
        formName: null,
        formVersionId: null,
        versionNumber: null,
        snapshotFormVersionId: "form-version-3",
      }),
    ).toThrow("missing its immutable form version identity");
  });

  it("fails when the submitted and linked public form versions disagree", () => {
    expect(() => explain({ snapshotVersionNumber: 2 })).toThrow(
      "conflicting immutable form-version identities",
    );
  });

  it("requires persisted tracks for a manual entry", () => {
    expect(() =>
      explain({
        formName: null,
        formVersionId: null,
        versionNumber: null,
        snapshotFormVersionId: ADMIN_MANUAL_ENTRY_FORM_VERSION_ID,
        snapshotVersionNumber: 1,
        selectedTracks: [],
        routedTeamIds: ["team-general"],
      }),
    ).toThrow("missing its persisted track selections");
  });
});
