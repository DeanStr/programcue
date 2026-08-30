import {
  D1SubmissionRepository,
  type FormWorkspace,
  SubmissionStateError,
} from "./submission-repository.server";
import type { SaveFormInput } from "./submission-schema";

export function submissionFormWorkspaceToInput(
  workspace: FormWorkspace,
): SaveFormInput {
  return {
    id: workspace.id,
    revision: workspace.revision,
    draftRevision: workspace.draftVersion.revision,
    name: workspace.name,
    kind: workspace.kind,
    publicSlug: workspace.publicSlug,
    openDate: D1SubmissionRepository.closeDateFromEpoch(
      workspace.opensAt,
      workspace.eventTimezone,
    ),
    closeDate: D1SubmissionRepository.closeDateFromEpoch(
      workspace.closesAt,
      workspace.eventTimezone,
    ),
    submissionLimit: workspace.submissionLimit,
    perPersonSubmissionLimit: workspace.perPersonSubmissionLimit,
    minSpeakers: workspace.minSpeakers,
    maxSpeakers: workspace.maxSpeakers,
    accessMode: workspace.accessMode,
    accessPassword: "",
    schema: workspace.draftVersion.schema,
    routing: { ...workspace.draftVersion.routing, passwordHash: null },
  };
}

export function synchronizeSubmissionFormEventChoices(
  input: SaveFormInput,
  currentTracks: Array<{ id: string; name: string }>,
  currentFormats: Array<{ key: string; label: string }>,
): SaveFormInput {
  const trackField = input.schema.fields.find(
    (field) => field.id === "category",
  );
  if (!trackField) {
    throw new SubmissionStateError(
      "This form draft is missing its protected tracks field.",
    );
  }
  if (
    new Set(currentTracks.map((track) => track.id)).size !==
      currentTracks.length ||
    new Set(currentTracks.map((track) => track.name)).size !==
      currentTracks.length
  ) {
    throw new SubmissionStateError(
      "Event track IDs and names must be unique before editing submission forms.",
    );
  }
  const trackIdForSavedName = (trackName: string) => {
    const trackId = input.routing.trackIds[trackName];
    if (!trackId || input.routing.trackNames[trackId] !== trackName) {
      throw new SubmissionStateError(
        "This form draft has inconsistent saved event-track identity. Repair the draft before editing it.",
      );
    }
    return trackId;
  };
  const savedTrackIds = new Set(trackField.options.map(trackIdForSavedName));
  if (savedTrackIds.size !== trackField.options.length) {
    throw new SubmissionStateError(
      "This form draft maps multiple track choices to the same event track.",
    );
  }
  const routedTeamByTrackId = new Map<string, string>();
  for (const [trackName, teamId] of Object.entries(input.routing.categories)) {
    if (!trackField.options.includes(trackName)) {
      throw new SubmissionStateError(
        "This form draft contains a review route for an unavailable track choice.",
      );
    }
    routedTeamByTrackId.set(trackIdForSavedName(trackName), teamId);
  }
  const currentTrackNameById = new Map(
    currentTracks.map((track) => [track.id, track.name]),
  );
  const currentTrackNameForSavedName = new Map<string, string>();
  for (const savedName of trackField.options) {
    const currentName = currentTrackNameById.get(
      trackIdForSavedName(savedName),
    );
    if (currentName) currentTrackNameForSavedName.set(savedName, currentName);
  }
  const formatField = input.schema.fields.find(
    (field) => field.id === "format",
  );
  if (!formatField) {
    throw new SubmissionStateError(
      "This form draft is missing its protected session-format field.",
    );
  }
  if (
    new Set(currentFormats.map((format) => format.key)).size !==
      currentFormats.length ||
    new Set(currentFormats.map((format) => format.label.toLowerCase())).size !==
      currentFormats.length
  ) {
    throw new SubmissionStateError(
      "Event session-format keys and labels must be unique before editing submission forms.",
    );
  }
  const currentFormatLabelByKey = new Map(
    currentFormats.map((format) => [format.key, format.label]),
  );
  const currentFormatLabelForSavedLabel = new Map<string, string>();
  const savedFormatKeys = new Set<string>();
  for (const savedLabel of formatField.options) {
    let savedKey = input.routing.formatKeys?.[savedLabel];
    if (!savedKey) {
      const normalizedLabel = savedLabel.trim().toLowerCase();
      const normalizedKey = normalizedLabel
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      const matches = currentFormats.filter(
        (format) =>
          format.key === normalizedKey ||
          format.label.trim().toLowerCase() === normalizedLabel,
      );
      if (matches.length > 1) {
        throw new SubmissionStateError(
          `The saved session format “${savedLabel}” is ambiguous in Event Setup.`,
        );
      }
      savedKey = matches[0]?.key;
    }
    if (!savedKey) continue;
    if (savedFormatKeys.has(savedKey)) {
      throw new SubmissionStateError(
        "This form draft maps multiple choices to the same event session format.",
      );
    }
    savedFormatKeys.add(savedKey);
    const currentLabel = currentFormatLabelByKey.get(savedKey);
    if (currentLabel) {
      currentFormatLabelForSavedLabel.set(savedLabel, currentLabel);
    }
  }
  const reconcileCondition = (
    field: SaveFormInput["schema"]["fields"][number],
  ) => {
    if (!field.condition) return field.condition;
    const replacements =
      field.condition.fieldId === "category"
        ? currentTrackNameForSavedName
        : field.condition.fieldId === "format"
          ? currentFormatLabelForSavedLabel
          : null;
    if (!replacements) return field.condition;
    const replacement = replacements.get(field.condition.equals);
    if (!replacement) {
      // Keep the stale value visible in the editor so the organiser can
      // repair it. The normalized save schema still rejects the condition
      // until it targets one of the current protected choices.
      return field.condition;
    }
    return { ...field.condition, equals: replacement };
  };
  return {
    ...input,
    schema: {
      ...input.schema,
      fields: input.schema.fields.map((field) => ({
        ...field,
        ...(field.id === "category"
          ? { options: currentTracks.map((track) => track.name) }
          : field.id === "format"
            ? { options: currentFormats.map((format) => format.label) }
            : {}),
        condition: reconcileCondition(field),
      })),
    },
    routing: {
      ...input.routing,
      categories: Object.fromEntries(
        currentTracks.flatMap((track) => {
          const teamId = routedTeamByTrackId.get(track.id);
          return teamId ? [[track.name, teamId]] : [];
        }),
      ),
      trackIds: Object.fromEntries(
        currentTracks.map((track) => [track.name, track.id]),
      ),
      trackNames: Object.fromEntries(
        currentTracks.map((track) => [track.id, track.name]),
      ),
      formatKeys: Object.fromEntries(
        currentFormats.map((format) => [format.label, format.key]),
      ),
    },
  };
}
