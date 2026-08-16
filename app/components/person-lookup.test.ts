import { describe, expect, it } from "vitest";

import { personLookupMatchIsDisabled } from "./person-lookup";

const activeSpeaker = {
  personId: "person-active",
  name: "Active Speaker",
  email: "active@example.com",
  currentEventSpeakerStatus: "confirmed" as const,
};

describe("person lookup selection policy", () => {
  it("allows an existing event speaker to be selected for a submission", () => {
    expect(
      personLookupMatchIsDisabled(activeSpeaker, "submission-speaker"),
    ).toBe(false);
  });

  it("blocks active roster duplicates but permits intentional restoration", () => {
    expect(personLookupMatchIsDisabled(activeSpeaker, "event-roster")).toBe(
      true,
    );
    expect(
      personLookupMatchIsDisabled(
        {
          ...activeSpeaker,
          currentEventSpeakerStatus: "withdrawn",
        },
        "event-roster",
      ),
    ).toBe(false);
  });
});
