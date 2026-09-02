import { describe, expect, it } from "vitest";

import { primaryParticipantDestinationIds } from "./speaker-shell";

describe("participant mobile navigation priorities", () => {
  it("prioritises application work for an applicant", () => {
    expect(
      primaryParticipantDestinationIds({
        role: "submitter",
        hasParticipantApplications: false,
        hasParticipantSessions: false,
      }),
    ).toEqual(["overview", "applications", "tasks", "files"]);
  });

  it("keeps both applications and sessions primary for a mixed participant", () => {
    expect(
      primaryParticipantDestinationIds({
        role: "submitter",
        hasParticipantApplications: true,
        hasParticipantSessions: true,
      }),
    ).toEqual(["overview", "applications", "sessions", "tasks"]);
  });

  it("prioritises session preparation for an accepted speaker", () => {
    expect(
      primaryParticipantDestinationIds({
        role: "speaker",
        hasParticipantApplications: false,
        hasParticipantSessions: true,
      }),
    ).toEqual(["overview", "sessions", "tasks", "files"]);
  });

  it("keeps applications primary when a mixed participant resolves as a speaker", () => {
    expect(
      primaryParticipantDestinationIds({
        role: "speaker",
        hasParticipantApplications: true,
        hasParticipantSessions: true,
      }),
    ).toEqual(["overview", "applications", "sessions", "tasks"]);
  });
});
