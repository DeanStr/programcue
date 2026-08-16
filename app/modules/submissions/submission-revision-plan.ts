import {
  SubmissionRevisionConflictError,
  SubmissionStateError,
  type Applicant,
  type FormSummary,
  type FormVersion,
  type SubmittedRevisionCommand,
} from "./submission-repository-shared";
import {
  submittedSnapshotSchema,
  type DraftPayload,
} from "./submission-schema";

export type PersistedRevisionSpeaker = {
  id: string;
  personId: string | null;
  email: string;
  displayName: string;
  position: number;
  invitationStatus: string;
  isPrimary: number;
  claimedBiography: string;
};

export function assertSubmittedRevisionRequest(input: {
  form: FormSummary & { version: FormVersion };
  applicant: Extract<Applicant, { verified: true }>;
  command: SubmittedRevisionCommand;
  preparedEventId: string;
  preparedWebhookEventId: string;
  trackSelectionCount: number;
}) {
  const { form, applicant, command } = input;
  if (
    input.preparedEventId !== form.eventId ||
    input.preparedWebhookEventId !== form.eventId ||
    command.eventId !== form.eventId
  ) {
    throw new Error(
      "The prepared revision event does not belong to the submission event.",
    );
  }
  if (
    command.scope !== "submission.submitted.revise" ||
    command.actorId !== `person:${applicant.personId}`
  ) {
    throw new Error(
      "The submitted-revision command does not belong to the verified applicant.",
    );
  }
  if (form.kind !== "submission") {
    throw new SubmissionStateError(
      "Only a submitted proposal can be revised through this workflow.",
    );
  }
  if (input.trackSelectionCount === 0) {
    throw new SubmissionStateError(
      "A submission must retain at least one submitted event track.",
    );
  }
}

export function parseCurrentSubmittedSnapshot(input: {
  submissionId: string;
  snapshotJson: string | null;
  form: FormSummary & { version: FormVersion };
  payload: DraftPayload;
  sameUploads: (
    left: DraftPayload["uploads"],
    right: DraftPayload["uploads"],
  ) => boolean;
}) {
  if (!input.snapshotJson) {
    throw new Error(
      `Submission ${input.submissionId} is missing its submitted snapshot.`,
    );
  }
  let rawSnapshot: unknown;
  try {
    rawSnapshot = JSON.parse(input.snapshotJson);
  } catch {
    throw new Error(
      `Submission ${input.submissionId} has an invalid submitted snapshot.`,
    );
  }
  const snapshot = submittedSnapshotSchema.safeParse(rawSnapshot);
  if (!snapshot.success) {
    throw new Error(
      `Submission ${input.submissionId} has an invalid submitted snapshot.`,
    );
  }
  if (
    snapshot.data.formVersionId !== input.form.version.id ||
    snapshot.data.versionNumber !== input.form.version.versionNumber
  ) {
    throw new Error(
      `Submission ${input.submissionId} has a submitted snapshot for the wrong form version.`,
    );
  }
  if (!input.sameUploads(snapshot.data.uploads, input.payload.uploads)) {
    throw new SubmissionStateError(
      "A submitted native upload cannot be added, removed or replaced while revising the application.",
    );
  }
  return snapshot.data;
}

export function planSubmittedRevisionSpeakers(input: {
  submissionId: string;
  applicant: Extract<Applicant, { verified: true }>;
  persisted: PersistedRevisionSpeaker[];
  submitted: DraftPayload["speakers"];
  requested: DraftPayload["speakers"];
  createId?: () => string;
}) {
  const primary = input.persisted.filter((speaker) =>
    Boolean(speaker.isPrimary),
  );
  if (
    primary.length !== 1 ||
    primary[0]!.personId !== input.applicant.personId ||
    primary[0]!.email.toLowerCase() !== input.applicant.email.toLowerCase()
  ) {
    throw new Error(
      `Submission ${input.submissionId} has an invalid primary-speaker relationship.`,
    );
  }
  const submittedByEmail = new Map<string, DraftPayload["speakers"][number]>();
  for (const speaker of input.submitted) {
    const email = speaker.email.toLowerCase();
    if (submittedByEmail.has(email)) {
      throw new Error(
        `Submission ${input.submissionId} has duplicate speaker identities in its submitted snapshot.`,
      );
    }
    submittedByEmail.set(email, speaker);
  }
  for (const [position, persisted] of input.persisted.entries()) {
    if (persisted.position !== position) {
      throw new Error(
        `Submission ${input.submissionId} has non-contiguous speaker positions.`,
      );
    }
    const requested = input.requested[position];
    const submittedSpeaker = submittedByEmail.get(
      persisted.email.toLowerCase(),
    );
    const usesSubmittedBiography =
      Boolean(persisted.isPrimary) || persisted.invitationStatus !== "claimed";
    if (usesSubmittedBiography && !submittedSpeaker) {
      throw new Error(
        `Submission ${input.submissionId} has a persisted speaker relationship missing from its submitted snapshot.`,
      );
    }
    const persistedBiography = usesSubmittedBiography
      ? (submittedSpeaker?.biography ?? "")
      : persisted.claimedBiography;
    if (
      !requested ||
      requested.email.toLowerCase() !== persisted.email.toLowerCase() ||
      requested.name !== persisted.displayName ||
      (requested.biography ?? "") !== persistedBiography
    ) {
      throw new SubmissionStateError(
        "Existing speaker relationships cannot be removed, reordered or edited through a submission revision. Add a new co-speaker or update the application answers instead.",
      );
    }
  }
  const createId = input.createId ?? (() => crypto.randomUUID());
  return {
    existingRelationshipsJson: JSON.stringify(input.persisted),
    newInvitees: input.requested
      .slice(input.persisted.length)
      .map((speaker, index) => ({
        ...speaker,
        id: createId(),
        position: input.persisted.length + index,
      })),
  };
}

export function assertCurrentRevisionState(input: {
  submissionId: string;
  expectedRevision: number;
  currentRevision: number;
  status: string;
  hasDownstreamWork: number;
  formStatus: string;
  closesAt: number | null;
  now?: number;
}) {
  if (input.currentRevision !== input.expectedRevision) {
    throw new SubmissionRevisionConflictError();
  }
  if (input.status !== "submitted") {
    throw new SubmissionStateError(
      "Only a submitted application with no review in progress can be revised.",
    );
  }
  if (input.hasDownstreamWork) {
    throw new SubmissionStateError(
      "This application already has review or decision work and can no longer be revised.",
    );
  }
  if (
    input.formStatus !== "published" ||
    (input.closesAt !== null &&
      input.closesAt < (input.now ?? Math.floor(Date.now() / 1_000)))
  ) {
    throw new SubmissionStateError(
      "Applications for this event are closed, so this submission cannot be revised.",
    );
  }
}
