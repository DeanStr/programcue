import { describe, expect, it } from "vitest";
import { speakerMilestones } from "./speaker-dashboard-overview";
import type { SpeakerPortal } from "./speaker-dashboard-panel-shared";

function portal(overrides: Partial<SpeakerPortal> = {}) {
  return {
    profile: { profileStatus: "draft" },
    sessions: [],
    ...overrides,
  } as SpeakerPortal;
}

describe("speaker preparation milestones", () => {
  it("treats an empty requirement list as satisfied, not unstarted", () => {
    const requirements = speakerMilestones({
      portal: portal(),
      completedCount: 0,
      requirementCount: 0,
    }).find((milestone) => milestone.key === "requirements");

    expect(requirements).toMatchObject({
      detail: "Nothing requested",
      state: "complete",
    });
  });

  it("does not claim programme visibility from profile status alone", () => {
    const profile = speakerMilestones({
      portal: portal({
        profile: {
          profileStatus: "published",
        } as SpeakerPortal["profile"],
      }),
      completedCount: 0,
      requirementCount: 0,
    }).find((milestone) => milestone.key === "profile");

    expect(profile).toMatchObject({
      detail: "Profile marked published",
      state: "complete",
    });
  });
});
