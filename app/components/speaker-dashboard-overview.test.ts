import { describe, expect, it } from "vitest";
import {
  speakerHeroActions,
  speakerMilestones,
} from "./speaker-dashboard-overview";
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

describe("speaker next-action hero", () => {
  const handbook = {
    id: "resource-speaker-handbook",
    title: "Speaker handbook",
    href: "/participant/resources?resource=speaker-handbook",
  };

  it("opens the resource when the next task is linked to that page", () => {
    const actions = speakerHeroActions(
      {
        id: "task-handbook",
        title: "Something else entirely",
        description: "Acknowledge the current handbook.",
        status: "not_started",
        configurationJson: JSON.stringify({
          resourcePageId: "resource-speaker-handbook",
        }),
      } as never,
      handbook,
    );
    expect(actions.resourceAction?.href).toContain("speaker-handbook");
    expect(actions.taskAction).toBeNull();
  });

  it("keeps a non-resource task ahead of an outstanding resource", () => {
    const actions = speakerHeroActions(
      {
        id: "task-slides",
        title: "Read the speaker handbook slides",
        description: "Attach the deck.",
        status: "not_started",
        configurationJson: "{}",
      } as never,
      handbook,
    );
    expect(actions.taskAction?.id).toBe("task-slides");
    expect(actions.resourceAction).toBeNull();
  });

  it("does not treat a title overlap as the same resource", () => {
    const actions = speakerHeroActions(
      {
        id: "task-other-handbook",
        title: "Read the speaker handbook",
        description: "Acknowledge a different page.",
        status: "not_started",
        configurationJson: JSON.stringify({
          resourcePageId: "resource-other-handbook",
        }),
      } as never,
      handbook,
    );
    expect(actions.taskAction?.id).toBe("task-other-handbook");
    expect(actions.resourceAction).toBeNull();
  });
});

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
