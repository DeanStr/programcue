type AssignmentTarget = {
  value: string;
  label: string;
  kind: string;
};

type ReviewTarget =
  | { type: "submission"; id: string }
  | { type: "session"; id: string };

export function availableEvaluationAssignmentTargets(input: {
  assignmentTargets: AssignmentTarget[];
  assignments: Array<{
    roundId: string;
    submissionId: string | null;
    sessionId: string | null;
    evaluatorPersonId: string;
    status: string;
    cancellationReason: string | null;
  }>;
  teams: Array<{
    id: string;
    name: string;
    members: Array<{
      personId: string;
      authorised: boolean;
    }>;
  }>;
  activeRound:
    | {
        id: string;
        reviewers: Array<{ personId: string }>;
      }
    | null
    | undefined;
  target: ReviewTarget;
}): AssignmentTarget[] {
  const activeRound = input.activeRound;
  if (!activeRound) return [];

  const assignmentMatchesTarget = (assignment: {
    submissionId: string | null;
    sessionId: string | null;
  }) =>
    input.target.type === "submission"
      ? assignment.submissionId === input.target.id
      : assignment.sessionId === input.target.id;
  const matchingAssignments = input.assignments.filter((assignment) =>
    assignmentMatchesTarget(assignment),
  );
  const blockedEvaluatorIds = new Set(
    matchingAssignments
      .filter(
        (assignment) =>
          assignment.status === "recused" ||
          (assignment.roundId === activeRound.id &&
            assignment.status === "cancelled" &&
            assignment.cancellationReason !== "reviewer_removed"),
      )
      .map((assignment) => assignment.evaluatorPersonId),
  );
  const assignedEvaluatorIds = new Set(
    matchingAssignments
      .filter(
        (assignment) =>
          assignment.roundId === activeRound.id &&
          assignment.status !== "recused" &&
          assignment.status !== "cancelled",
      )
      .map((assignment) => assignment.evaluatorPersonId),
  );
  const activeRoundReviewerIds = new Set(
    activeRound.reviewers.map((reviewer) => reviewer.personId),
  );

  return input.assignmentTargets.flatMap((target) => {
    const [targetType, targetId] = target.value.split(":", 2);
    if (!targetId) {
      throw new Error(
        `Evaluation assignment target ${target.value} is invalid.`,
      );
    }
    if (targetType === "person") {
      return blockedEvaluatorIds.has(targetId) ||
        assignedEvaluatorIds.has(targetId)
        ? []
        : [target];
    }
    if (targetType !== "team") {
      throw new Error(
        `Evaluation assignment target ${target.value} is invalid.`,
      );
    }
    const team = input.teams.find((candidate) => candidate.id === targetId);
    if (!team) {
      throw new Error(`Evaluation team ${targetId} is unavailable.`);
    }
    const eligibleMemberIds = team.members
      .filter(
        (member) =>
          member.authorised && activeRoundReviewerIds.has(member.personId),
      )
      .map((member) => member.personId);
    if (
      eligibleMemberIds.some((personId) => blockedEvaluatorIds.has(personId))
    ) {
      return [];
    }
    const availableMemberCount = eligibleMemberIds.filter(
      (personId) => !assignedEvaluatorIds.has(personId),
    ).length;
    return availableMemberCount > 0
      ? [
          {
            ...target,
            label: `${team.name} (${availableMemberCount})`,
          },
        ]
      : [];
  });
}
