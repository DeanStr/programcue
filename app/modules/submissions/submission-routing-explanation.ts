import {
  ADMIN_MANUAL_ENTRY_FORM_VERSION_ID,
  type FormRouting,
} from "./submission-schema";

export type SubmissionRoutingExplanation = {
  source:
    | {
        kind: "published_form" | "form_draft";
        formName: string;
        versionNumber: number;
      }
    | {
        kind: "administrator_manual_entry";
        formName: null;
        versionNumber: null;
      };
  routes: Array<{
    trackId: string;
    trackName: string;
    teamId: string | null;
    teamName: string | null;
  }>;
  routedTeams: Array<{ id: string; name: string }>;
};

export type SubmissionRoutingState =
  | "draft"
  | "automatic"
  | "missing_automatic"
  | "manual_override"
  | "manual_unassigned";

export function classifySubmissionRouting(input: {
  submissionId: string;
  status: string;
  formVersionId: string | null;
  snapshotFormVersionId: string | null;
  versionNumber: number | null;
  snapshotVersionNumber: number | null;
  routing: FormRouting;
  selectedTracks: Array<{ trackId: string; trackName: string }>;
  routedTeamIds: string[];
}): SubmissionRoutingState {
  if (input.status === "draft") return "draft";
  const selectedTracks = input.selectedTracks.map((track) =>
    requireTrackIdentity(input.submissionId, track, input.routing),
  );
  if (input.formVersionId === null) {
    if (
      input.snapshotFormVersionId !== ADMIN_MANUAL_ENTRY_FORM_VERSION_ID ||
      input.snapshotVersionNumber !== 1 ||
      input.versionNumber !== null
    ) {
      throw new Error(
        `Submission ${input.submissionId} is missing its immutable form version identity.`,
      );
    }
    return input.routedTeamIds.length
      ? "manual_override"
      : "manual_unassigned";
  }
  if (
    input.versionNumber === null ||
    input.snapshotFormVersionId !== input.formVersionId ||
    input.snapshotVersionNumber !== input.versionNumber
  ) {
    throw new Error(
      `Submission ${input.submissionId} has conflicting immutable form-version identities.`,
    );
  }
  const hasMissingAutomaticRoute = selectedTracks.some(
    (track) => !input.routing.categories[track.trackName],
  );
  const expectedTeamIds = [
    ...new Set(
      selectedTracks.flatMap((track) => {
        const teamId = input.routing.categories[track.trackName];
        return teamId ? [teamId] : [];
      }),
    ),
  ];
  if (!sameIdSet(expectedTeamIds, input.routedTeamIds)) {
    throw new Error(
      `Submission ${input.submissionId} has persisted routed teams that do not match its immutable routing snapshot.`,
    );
  }
  return hasMissingAutomaticRoute ? "missing_automatic" : "automatic";
}

type RoutingExplanationInput = {
  submissionId: string;
  status: string;
  formVersionId: string | null;
  snapshotFormVersionId: string | null;
  snapshotVersionNumber: number | null;
  formName: string | null;
  versionNumber: number | null;
  routing: FormRouting;
  selectedTracks: Array<{ trackId: string; trackName: string }>;
  routedTeamIds: string[];
};

function requireTeam(
  submissionId: string,
  teamId: string,
  routing: FormRouting,
) {
  const name = routing.teamNames[teamId];
  if (!name) {
    throw new Error(
      `Submission ${submissionId} is missing an immutable routed-team name.`,
    );
  }
  return { id: teamId, name };
}

function requireTrackIdentity(
  submissionId: string,
  track: { trackId: string; trackName: string },
  routing: FormRouting,
) {
  if (
    routing.trackIds[track.trackName] !== track.trackId ||
    routing.trackNames[track.trackId] !== track.trackName
  ) {
    throw new Error(
      `Submission ${submissionId} has a track selection that does not match its immutable routing snapshot.`,
    );
  }
  return track;
}

function sameIdSet(left: string[], right: string[]) {
  if (left.length !== right.length) return false;
  const rightIds = new Set(right);
  return left.every((id) => rightIds.has(id));
}

export function explainSubmissionRouting(
  input: RoutingExplanationInput,
): SubmissionRoutingExplanation {
  const routedTeams = input.routedTeamIds.map((teamId) =>
    requireTeam(input.submissionId, teamId, input.routing),
  );

  if (input.status === "draft") {
    if (
      input.formVersionId === null ||
      input.versionNumber === null ||
      !input.formName
    ) {
      throw new Error(
        `Submission ${input.submissionId} is missing its immutable draft form identity.`,
      );
    }
    if (input.selectedTracks.length || input.routedTeamIds.length) {
      throw new Error(
        `Submission ${input.submissionId} has routing records before submission.`,
      );
    }
    return {
      source: {
        kind: "form_draft",
        formName: input.formName,
        versionNumber: input.versionNumber,
      },
      routes: [],
      routedTeams,
    };
  }

  if (input.selectedTracks.length === 0) {
    throw new Error(
      `Submission ${input.submissionId} is missing its persisted track selections.`,
    );
  }
  const selectedTracks = input.selectedTracks.map((track) =>
    requireTrackIdentity(input.submissionId, track, input.routing),
  );

  if (input.formVersionId === null) {
    if (
      input.snapshotFormVersionId !== ADMIN_MANUAL_ENTRY_FORM_VERSION_ID ||
      input.snapshotVersionNumber !== 1
    ) {
      throw new Error(
        `Submission ${input.submissionId} is missing its immutable form version identity.`,
      );
    }
    if (input.versionNumber !== null || input.formName !== null) {
      throw new Error(
        `Submission ${input.submissionId} has conflicting manual-entry form identity.`,
      );
    }
    return {
      source: {
        kind: "administrator_manual_entry",
        formName: null,
        versionNumber: null,
      },
      routes: selectedTracks.map((track) => ({
        ...track,
        teamId: null,
        teamName: null,
      })),
      routedTeams,
    };
  }

  if (input.versionNumber === null || !input.formName) {
    throw new Error(
      `Submission ${input.submissionId} is missing its immutable form-version details.`,
    );
  }

  if (
    input.snapshotFormVersionId !== input.formVersionId ||
    input.snapshotVersionNumber !== input.versionNumber
  ) {
    throw new Error(
      `Submission ${input.submissionId} has conflicting immutable form-version identities.`,
    );
  }

  const routes = selectedTracks.map((track) => {
    const teamId = input.routing.categories[track.trackName] ?? null;
    const teamName = teamId
      ? requireTeam(input.submissionId, teamId, input.routing).name
      : null;
    return { ...track, teamId, teamName };
  });
  const expectedTeamIds = [
    ...new Set(
      routes
        .map((route) => route.teamId)
        .filter((teamId): teamId is string => teamId !== null),
    ),
  ];
  if (!sameIdSet(expectedTeamIds, input.routedTeamIds)) {
    throw new Error(
      `Submission ${input.submissionId} has persisted routed teams that do not match its immutable routing snapshot.`,
    );
  }

  return {
    source: {
      kind: "published_form",
      formName: input.formName,
      versionNumber: input.versionNumber,
    },
    routes,
    routedTeams,
  };
}
