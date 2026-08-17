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

function milestones(
  overrides: Partial<Parameters<typeof speakerMilestones>[0]> = {},
) {
  return speakerMilestones({
    portal: portal(),
    completedCount: 0,
    requirementCount: 0,
    requiredResourceCount: 0,
    acknowledgedResourceCount: 0,
    ...overrides,
  });
}

describe("speaker preparation milestones", () => {
  it("treats an empty requirement list as satisfied, not unstarted", () => {
    const requirements = milestones().find(
      (milestone) => milestone.key === "requirements",
    );

    expect(requirements).toMatchObject({
      detail: "Nothing requested",
      state: "complete",
    });
  });

  it("does not claim programme visibility from profile status alone", () => {
    const profile = milestones({
      portal: portal({
        profile: {
          profileStatus: "published",
        } as SpeakerPortal["profile"],
      }),
    }).find((milestone) => milestone.key === "profile");

    expect(profile).toMatchObject({
      detail: "Profile marked published",
      state: "complete",
    });
  });

  it("treats an empty required-resource list as satisfied, not unstarted", () => {
    const resources = milestones().find(
      (milestone) => milestone.key === "resources",
    );

    expect(resources).toMatchObject({
      detail: "Nothing requested",
      state: "complete",
    });
  });

  it("keeps preparation incomplete while a required resource is outstanding", () => {
    const stages = milestones({
      portal: portal({
        profile: {
          profileStatus: "published",
        } as SpeakerPortal["profile"],
        sessions: [
          {
            status: "scheduled",
            participationStatus: "confirmed",
          },
        ] as SpeakerPortal["sessions"],
      }),
      completedCount: 1,
      requirementCount: 1,
      requiredResourceCount: 2,
      acknowledgedResourceCount: 1,
    });

    expect(stages.map((milestone) => [milestone.key, milestone.state])).toEqual(
      [
        ["profile", "complete"],
        ["sessions", "complete"],
        ["requirements", "complete"],
        ["resources", "in_progress"],
      ],
    );
    expect(
      stages.find((milestone) => milestone.key === "resources"),
    ).toMatchObject({
      detail: "1 of 2 acknowledged",
    });
  });
});
