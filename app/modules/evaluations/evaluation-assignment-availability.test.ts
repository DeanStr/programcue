import { describe, expect, it } from "vitest";

import { availableEvaluationAssignmentTargets } from "./evaluation-assignment-availability";

const activeRound = {
  id: "round-active",
  reviewers: [
    { personId: "person-assigned" },
    { personId: "person-available" },
  ],
};
const assignmentTargets = [
  { value: "team:team-one", label: "Review team (2)", kind: "Teams" },
  {
    value: "person:person-assigned",
    label: "Assigned Reviewer",
    kind: "Individuals",
  },
  {
    value: "person:person-available",
    label: "Available Reviewer",
    kind: "Individuals",
  },
];
const teams = [
  {
    id: "team-one",
    name: "Review team",
    members: [
      { personId: "person-assigned", authorised: true },
      { personId: "person-available", authorised: true },
      { personId: "person-outside-pool", authorised: true },
    ],
  },
];

describe("evaluation assignment availability", () => {
  it("removes an active-round assignee and reports the team's remaining members", () => {
    const targets = availableEvaluationAssignmentTargets({
      assignmentTargets,
      assignments: [
        {
          roundId: activeRound.id,
          submissionId: null,
          sessionId: "session-one",
          evaluatorPersonId: "person-assigned",
          status: "assigned",
          cancellationReason: null,
        },
      ],
      teams,
      activeRound,
      target: { type: "session", id: "session-one" },
    });

    expect(targets).toEqual([
      { value: "team:team-one", label: "Review team (1)", kind: "Teams" },
      {
        value: "person:person-available",
        label: "Available Reviewer",
        kind: "Individuals",
      },
    ]);
  });

  it("suppresses a team blocked by a recusal while keeping a removed reviewer available", () => {
    const targets = availableEvaluationAssignmentTargets({
      assignmentTargets,
      assignments: [
        {
          roundId: activeRound.id,
          submissionId: null,
          sessionId: "session-one",
          evaluatorPersonId: "person-assigned",
          status: "cancelled",
          cancellationReason: "reviewer_removed",
        },
        {
          roundId: "round-prior",
          submissionId: null,
          sessionId: "session-one",
          evaluatorPersonId: "person-available",
          status: "recused",
          cancellationReason: null,
        },
      ],
      teams,
      activeRound,
      target: { type: "session", id: "session-one" },
    });

    expect(targets).toEqual([
      {
        value: "person:person-assigned",
        label: "Assigned Reviewer",
        kind: "Individuals",
      },
    ]);
  });

  it("suppresses targets blocked by a non-reassignable cancellation", () => {
    const targets = availableEvaluationAssignmentTargets({
      assignmentTargets,
      assignments: [
        {
          roundId: activeRound.id,
          submissionId: null,
          sessionId: "session-one",
          evaluatorPersonId: "person-assigned",
          status: "cancelled",
          cancellationReason: "decision_published",
        },
      ],
      teams,
      activeRound,
      target: { type: "session", id: "session-one" },
    });

    expect(targets).toEqual([
      {
        value: "person:person-available",
        label: "Available Reviewer",
        kind: "Individuals",
      },
    ]);
  });

  it("applies the same target isolation to proposal assignments", () => {
    const targets = availableEvaluationAssignmentTargets({
      assignmentTargets,
      assignments: [
        {
          roundId: activeRound.id,
          submissionId: "submission-one",
          sessionId: null,
          evaluatorPersonId: "person-assigned",
          status: "in_progress",
          cancellationReason: null,
        },
        {
          roundId: activeRound.id,
          submissionId: "submission-other",
          sessionId: null,
          evaluatorPersonId: "person-available",
          status: "assigned",
          cancellationReason: null,
        },
      ],
      teams,
      activeRound,
      target: { type: "submission", id: "submission-one" },
    });

    expect(targets.map((target) => target.value)).toEqual([
      "team:team-one",
      "person:person-available",
    ]);
  });
});
