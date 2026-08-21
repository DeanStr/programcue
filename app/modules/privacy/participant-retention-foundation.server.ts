import { z } from "zod";
import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import type { Viewer } from "~/platform/auth/authorize.server";

export const MAX_PARTICIPANTS_PER_BATCH = 20;

export const RETAINED_PERSON_PREFIX = "retained-participant-";

export const RETENTION_COMPLETION_PREFIX = "participant-retention-complete:";

export const REDACTED_JSON = JSON.stringify({
  redacted: true,
  reason: "event_retention_period_elapsed",
});

export class ParticipantRetentionAccessError extends Error {
  constructor() {
    super(
      "Organisation owner access is required for participant-retention controls.",
    );
    this.name = "ParticipantRetentionAccessError";
  }
}

export class ParticipantRetentionConfirmationError extends Error {
  constructor() {
    super("Type the event name to confirm participant anonymisation.");
    this.name = "ParticipantRetentionConfirmationError";
  }
}

export class ParticipantRetentionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParticipantRetentionStateError";
  }
}

export type ParticipantCandidate = {
  id: string;
  email: string;
};

export type ParticipantMapping = ParticipantCandidate & {
  pseudonymId: string;
  pseudonymEmail: string;
  retiredEmail: string;
  subjectAuditId: string;
  shared: boolean;
  immutableAuditRows: number;
};

export type CompletionMetadata = {
  version: 1;
  scope: "local_event_data";
  repositoryProvider: string;
  externalProviderErasureRequired: boolean;
  immutableAuditRecords: number;
  sharedIdentityAuditLinks: number;
  retainedProgrammeRecords: number;
  unscopedStoresNotAutomaticallyRedacted: string[];
};

export function participantRetentionTaskPredicateSql(alias: string) {
  return `(
    ${alias}.target_type = 'speaker'
    OR (
      ${alias}.target_type = 'session'
      AND json_extract(${alias}.configuration_json, '$.preset') = 'session_details_review_v1'
    )
  )`;
}

export const participantPredicateSql = `(
  EXISTS (SELECT 1 FROM memberships candidate_membership
    WHERE candidate_membership.event_id = ?
      AND candidate_membership.person_id = person.id
      AND candidate_membership.role IN ('submitter','speaker'))
  OR EXISTS (SELECT 1 FROM submissions candidate_submission
    WHERE candidate_submission.event_id = ?
      AND candidate_submission.submitter_person_id = person.id)
  OR EXISTS (SELECT 1 FROM submission_speakers candidate_speaker
    WHERE candidate_speaker.event_id = ? AND candidate_speaker.person_id = person.id)
  OR EXISTS (SELECT 1 FROM session_speakers candidate_session_speaker
    WHERE candidate_session_speaker.event_id = ? AND candidate_session_speaker.person_id = person.id)
  OR EXISTS (SELECT 1 FROM event_speaker_workflows candidate_workflow
    WHERE candidate_workflow.event_id = ? AND candidate_workflow.person_id = person.id)
  OR EXISTS (SELECT 1 FROM event_participant_profiles candidate_profile
    WHERE candidate_profile.event_id = ? AND candidate_profile.person_id = person.id)
  OR EXISTS (SELECT 1 FROM speaker_profile_revisions candidate_profile_revision
    WHERE candidate_profile_revision.event_id = ?
      AND candidate_profile_revision.person_id = person.id)
  OR EXISTS (SELECT 1 FROM task_instances candidate_task
    WHERE candidate_task.event_id = ?
      AND (candidate_task.owner_person_id = person.id
        OR candidate_task.completed_by_person_id = person.id)
      AND ${participantRetentionTaskPredicateSql("candidate_task")})
  OR EXISTS (SELECT 1 FROM task_evidence candidate_evidence
    JOIN task_instances candidate_evidence_task
      ON candidate_evidence_task.id = candidate_evidence.task_id
     AND candidate_evidence_task.event_id = candidate_evidence.event_id
    WHERE candidate_evidence.event_id = ?
      AND ${participantRetentionTaskPredicateSql("candidate_evidence_task")}
      AND candidate_evidence.submitted_by_person_id = person.id)
  OR EXISTS (SELECT 1 FROM task_comments candidate_comment
    JOIN task_instances candidate_comment_task
      ON candidate_comment_task.id = candidate_comment.task_id
     AND candidate_comment_task.event_id = candidate_comment.event_id
    WHERE candidate_comment.event_id = ?
      AND ${participantRetentionTaskPredicateSql("candidate_comment_task")}
      AND candidate_comment.author_person_id = person.id)
  OR EXISTS (SELECT 1 FROM resource_acknowledgements candidate_acknowledgement
    WHERE candidate_acknowledgement.event_id = ? AND candidate_acknowledgement.person_id = person.id)
  OR EXISTS (SELECT 1 FROM resource_audiences candidate_audience
    WHERE candidate_audience.event_id = ?
      AND candidate_audience.target_type = 'person'
      AND candidate_audience.target_id = person.id)
  OR EXISTS (SELECT 1 FROM public_itineraries candidate_itinerary
    WHERE candidate_itinerary.event_id = ? AND candidate_itinerary.person_id = person.id)
  OR EXISTS (SELECT 1 FROM calendar_connections candidate_connection
    WHERE candidate_connection.event_id = ? AND candidate_connection.person_id = person.id)
  OR EXISTS (SELECT 1 FROM calendar_invitations candidate_invitation
    WHERE candidate_invitation.event_id = ? AND candidate_invitation.person_id = person.id)
  OR EXISTS (SELECT 1 FROM communication_deliveries candidate_delivery
    WHERE candidate_delivery.event_id = ? AND candidate_delivery.person_id = person.id)
  OR EXISTS (SELECT 1 FROM communication_unsubscribes candidate_unsubscribe
    WHERE candidate_unsubscribe.event_id = ? AND candidate_unsubscribe.person_id = person.id)
  OR EXISTS (SELECT 1 FROM file_assets candidate_file
    WHERE candidate_file.event_id = ? AND candidate_file.owner_person_id = person.id
      AND candidate_file.target_type IN ('person','submission','session','task'))
)`;

export function participantIdBindings(eventId: string) {
  return Array.from({ length: 18 }, () => eventId);
}

export function candidateSql(suffix: string) {
  return `
    SELECT person.id, person.email
      FROM people person
     WHERE ${participantPredicateSql}
       AND person.id NOT LIKE '${RETAINED_PERSON_PREFIX}%'
     ORDER BY person.id
     ${suffix}
  `;
}

export function candidateBindings(viewer: Viewer) {
  return participantIdBindings(viewer.eventId);
}

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function completionId(eventId: string) {
  return `${RETENTION_COMPLETION_PREFIX}${eventId}`;
}

export function requireOwner(viewer: Viewer) {
  if (viewer.role !== "owner") throw new ParticipantRetentionAccessError();
}

export function count(value: number | string | null | undefined) {
  return Number(value ?? 0);
}

export function parseCompletionMetadata(
  value: string | null,
): CompletionMetadata | null {
  if (value === null) return null;
  const parsed: unknown = JSON.parse(value);
  return z
    .object({
      version: z.literal(1),
      scope: z.literal("local_event_data"),
      repositoryProvider: z.string(),
      externalProviderErasureRequired: z.boolean(),
      immutableAuditRecords: z.number().int().nonnegative(),
      sharedIdentityAuditLinks: z.number().int().nonnegative(),
      retainedProgrammeRecords: z.number().int().nonnegative(),
      unscopedStoresNotAutomaticallyRedacted: z.array(z.string()),
    })
    .parse(parsed);
}

export function eventClaimGuard() {
  return `EXISTS (
    SELECT 1 FROM events retention_event
     WHERE retention_event.id = ?
       AND retention_event.organisation_id = ?
       AND retention_event.last_operation_id = ?
  )`;
}

export type InternalMapping = ParticipantMapping & {
  eventId: string;
  organisationId: string;
  operationId: string;
};

export function mapStatement(
  env: CloudflareEnvironment,
  mappings: InternalMapping[],
  table: string,
  column: string,
  eventWhere = "event_id = ?",
  extraWhere = "1 = 1",
) {
  const cases = mappings.map(() => "WHEN ? THEN ?").join(" ");
  const originals = mappings.map(() => "?").join(", ");
  return env.DB.prepare(
    `UPDATE ${table}
        SET ${column} = CASE ${column} ${cases} ELSE ${column} END
      WHERE ${eventWhere}
        AND ${extraWhere}
        AND ${column} IN (${originals})
        AND ${eventClaimGuard()}`,
  ).bind(
    ...mappings.flatMap((mapping) => [mapping.id, mapping.pseudonymId]),
    mappings[0].eventId,
    ...mappings.map((mapping) => mapping.id),
    mappings[0].eventId,
    mappings[0].organisationId,
    mappings[0].operationId,
  );
}

export abstract class ParticipantRetentionFoundation {
  protected readonly airtable: AirtableProviderBoundary;
  protected projectionDepth = 0;
  constructor(
    protected readonly env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
  }
}
