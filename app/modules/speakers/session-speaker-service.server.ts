import { z } from "zod";
import {
  AirtableProviderBoundary,
  airtableIntentCommand,
} from "~/modules/airtable/airtable-provider-boundary.server";
import {
  acceptanceTaskPlanGuardSql,
  buildAcceptanceTaskPlanStatements,
} from "~/modules/evaluations/evaluation-acceptance-task-plan.server";
import { assertAcceptanceTaskPlan } from "~/modules/evaluations/evaluation-decision-acceptance-guard.server";
import { EvaluationStateError } from "~/modules/evaluations/evaluation-errors";
import { materializePublishedResourceAcknowledgementsForSession } from "~/modules/resources/resource-service-shared";
import { scheduleDraftConflictRebuildStatements } from "~/modules/schedule/schedule-conflict-statement.server";
import { ScheduleConfigurationError } from "~/modules/schedule/schedule-errors";
import type { ScheduleWorkspace } from "~/modules/schedule/schedule-service.server";
import {
  detectWorkspaceConflicts,
  loadScheduleWorkspaceD1,
  withAddedSessionSpeaker,
} from "~/modules/schedule/schedule-workspace.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  atomicBatchGuardStatement,
  isAtomicBatchGuardError,
} from "~/platform/database/atomic-batch-guard.server";
import {
  directSessionSpeakerRelationshipBindings,
  directSessionSpeakerRelationshipSql,
  dispatchSpeakerInvitationsForCommand,
  prepareSpeakerInvitations,
  SpeakerInvitationAddressError,
  unavailableDirectSessionSpeakerEmails,
} from "./speaker-invitation.server";

export class SessionSpeakerStateError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "SessionSpeakerStateError";
  }
}

const operationIdSchema = z.uuid("Refresh the page and try again.");
export const addSessionSpeakerSchema = z.object({
  sessionId: z.string().trim().min(1).max(200),
  name: z
    .string()
    .trim()
    .min(1, "Enter the speaker's name.")
    .max(120, "Use a speaker name of 120 characters or fewer."),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email("Enter the speaker's email address.")
    .max(254),
  operationId: operationIdSchema,
});
const removeSpeakerSchema = z.object({
  sessionId: z.string().trim().min(1).max(200),
  personId: z.string().trim().min(1).max(200),
  operationId: operationIdSchema,
  confirmed: z.literal("true", {
    error: "Confirm the speaker removal.",
  }),
});

type SessionRow = {
  id: string;
  title: string;
  status: string;
  sourceSubmissionId: string | null;
  submissionStatus: string | null;
  formKind: string | null;
  acceptanceDecisionCount: number;
  acceptanceDecisionId: string | null;
};

export type SessionSpeaker = {
  personId: string;
  name: string;
  email: string;
  roleLabel: string | null;
  participationStatus: "pending" | "confirmed" | "declined";
};

/** Speakers can change while a session is unscheduled or in a draft
 *  schedule, as for co-speaker claims. Publishing a schedule marks its
 *  sessions published, and their speakers stay locked from then on. */
function sessionSpeakersLockedReason(status: string) {
  if (status === "unscheduled" || status === "scheduled") return null;
  if (status === "published") {
    return "This session is on the published programme, so its speakers are locked.";
  }
  return `This session is ${status}, so its speakers are locked.`;
}

function withRemovedSessionSpeaker(
  workspace: ScheduleWorkspace,
  input: { sessionId: string; personId: string },
): ScheduleWorkspace {
  return {
    ...workspace,
    sessions: workspace.sessions.map((session) => {
      const index = session.speakerIds.indexOf(input.personId);
      if (session.id !== input.sessionId || index < 0) return session;
      return {
        ...session,
        speakerIds: session.speakerIds.filter((_, at) => at !== index),
        speakerNames: session.speakerNames.filter((_, at) => at !== index),
      };
    }),
  };
}

type AddSessionSpeakerInput = z.infer<typeof addSessionSpeakerSchema>;
type RemoveSessionSpeakerInput = z.infer<typeof removeSpeakerSchema>;
type AcceptedPlan = { submissionId: string; decisionId: string };

export class SessionSpeakerService {
  private readonly airtable: AirtableProviderBoundary;

  constructor(private readonly env: CloudflareEnvironment) {
    this.airtable = new AirtableProviderBoundary(env);
  }

  async list(viewer: Viewer, sessionId: string) {
    requireAdministrator(viewer);
    const session = await this.loadSession(viewer, sessionId);
    return {
      lockedReason: sessionSpeakersLockedReason(session.status),
      speakers: await this.loadSpeakers(viewer, sessionId),
      operationId: crypto.randomUUID(),
    };
  }

  /** Adds an existing or new person to a session. They start pending: they
   *  confirm participation in the speaker portal, or an organiser records
   *  their confirmation. Retrying the same operation returns its result. */
  async add(viewer: Viewer, raw: unknown) {
    requireAdministrator(viewer);
    const input = addSessionSpeakerSchema.parse(raw);
    return this.airtable.executeIdempotent(
      viewer,
      await airtableIntentCommand(
        "session.speaker.add",
        viewer,
        input.operationId,
        input,
      ),
      () => this.addD1(viewer, input),
    );
  }

  /** Removes a speaker who is not the session's last. Their onboarding tasks
   *  and portal access stay: tasks belong to the speaker across the event,
   *  so the organiser waives any that no longer apply. */
  async remove(viewer: Viewer, raw: unknown) {
    requireAdministrator(viewer);
    const input = removeSpeakerSchema.parse(raw);
    return this.airtable.executeIdempotent(
      viewer,
      await airtableIntentCommand(
        "session.speaker.remove",
        viewer,
        input.operationId,
        input,
      ),
      () => this.removeD1(viewer, input),
    );
  }

  private async addD1(viewer: Viewer, input: AddSessionSpeakerInput) {
    const previous = await this.completedOperation(
      viewer,
      "session.speaker.added",
      input.operationId,
    );
    if (previous) return this.finishAdd(viewer, input.operationId, true);
    const session = await this.loadSession(viewer, input.sessionId);
    const lockedReason = sessionSpeakersLockedReason(session.status);
    if (lockedReason) throw new SessionSpeakerStateError(lockedReason);
    const speakers = await this.loadSpeakers(viewer, session.id);
    const existingSpeaker = speakers.find(
      (speaker) => speaker.email.toLowerCase() === input.email,
    );
    if (existingSpeaker) {
      throw new SessionSpeakerStateError(
        `${existingSpeaker.name} is already a speaker on this session.`,
      );
    }
    // Speakers of an accepted proposal get the acceptance onboarding plan;
    // a speaker added later gets their own speaker tasks from it.
    const acceptedPlan: AcceptedPlan | null =
      session.submissionStatus === "accepted" &&
      session.formKind === "submission" &&
      session.sourceSubmissionId &&
      session.acceptanceDecisionCount === 1 &&
      session.acceptanceDecisionId
        ? {
            submissionId: session.sourceSubmissionId,
            decisionId: session.acceptanceDecisionId,
          }
        : null;
    await this.assertSpeakerAddable(viewer, input.email, acceptedPlan);
    const existingPerson = await this.env.DB.prepare(
      `SELECT id, display_name AS name FROM people
        WHERE email = ? COLLATE NOCASE`,
    )
      .bind(input.email)
      .first<{ id: string; name: string }>();
    // As when creating a session, only an identity this batch creates skips
    // the organisation relationship check, which the batch repeats.
    const proposedPersonId = crypto.randomUUID();
    const personId = existingPerson?.id ?? proposedPersonId;
    const draft = await this.draftConflictRebuild(
      viewer,
      session.id,
      input.operationId,
      (workspace) =>
        withAddedSessionSpeaker(workspace, {
          sessionId: session.id,
          personId,
          name: existingPerson?.name ?? input.name,
        }),
    );
    let invitationPlans: Awaited<ReturnType<typeof prepareSpeakerInvitations>>;
    try {
      invitationPlans = await prepareSpeakerInvitations({
        env: this.env,
        actor: {
          organisationId: viewer.organisationId,
          eventId: viewer.eventId,
          personId: viewer.personId,
        },
        commandId: input.operationId,
        source: "session_speaker",
        emails: [input.email],
      });
    } catch (error) {
      if (error instanceof SpeakerInvitationAddressError) {
        throw new SessionSpeakerStateError(error.message, 422);
      }
      throw error;
    }
    const lockedEvent = `EXISTS (
      SELECT 1 FROM events WHERE id = ? AND last_operation_id = ?
    )`;
    const lockBindings = [viewer.eventId, input.operationId];
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `UPDATE events
            SET revision = revision + 1, last_operation_id = ?,
                updated_at = unixepoch()
          WHERE id = ? AND organisation_id = ?
            AND EXISTS (
              SELECT 1 FROM sessions session
               WHERE session.id = ? AND session.event_id = events.id
                 AND session.status IN ('unscheduled', 'scheduled')
            )
            AND NOT EXISTS (
              SELECT 1 FROM session_speakers relationship
              JOIN people person ON person.id = relationship.person_id
               WHERE relationship.session_id = ?
                 AND relationship.event_id = events.id
                 AND person.email = ? COLLATE NOCASE
            )
            ${
              acceptedPlan
                ? `AND EXISTS (
                     SELECT 1 FROM submissions
                      WHERE submissions.id = ?
                        AND submissions.event_id = events.id
                        AND ${acceptanceTaskPlanGuardSql}
                   )`
                : ""
            }
            ${draft.versionGuardSql}`,
      ).bind(
        input.operationId,
        viewer.eventId,
        viewer.organisationId,
        session.id,
        session.id,
        input.email,
        ...(acceptedPlan ? [acceptedPlan.submissionId] : []),
        ...draft.versionGuardBindings,
      ),
      ...draft.statements,
      this.env.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, email_verified, profile_status,
           created_at, updated_at
         )
         SELECT ?, ?, ?, 0, 'draft', unixepoch(), unixepoch()
          WHERE ${lockedEvent}
         ON CONFLICT(email) DO NOTHING`,
      ).bind(proposedPersonId, input.email, input.name, ...lockBindings),
      this.env.DB.prepare(
        `INSERT INTO session_speakers (
           session_id, event_id, person_id, position, role_label,
           participation_status, participation_confirmed_at, visibility
         )
         SELECT session.id, session.event_id, person.id,
                COALESCE((
                  SELECT MAX(existing.position) + 1
                    FROM session_speakers existing
                   WHERE existing.session_id = session.id
                ), 0),
                'Co-speaker', 'pending', NULL, 'public'
           FROM sessions session
           JOIN people person ON person.email = ? COLLATE NOCASE
          WHERE session.id = ? AND session.event_id = ?
            AND (person.id = ? OR ${directSessionSpeakerRelationshipSql})
            AND ${lockedEvent}
            ${draft.speakerGuardSql}`,
      ).bind(
        input.email,
        session.id,
        viewer.eventId,
        proposedPersonId,
        ...directSessionSpeakerRelationshipBindings(
          viewer.organisationId,
          viewer.eventId,
        ),
        ...lockBindings,
        ...draft.speakerGuardBindings,
      ),
      // Anything short of the speaker joining under this operation's lock
      // rolls the whole batch back.
      atomicBatchGuardStatement(
        this.env,
        `NOT ${lockedEvent}
          OR NOT EXISTS (
            SELECT 1 FROM session_speakers relationship
            JOIN people person ON person.id = relationship.person_id
             WHERE relationship.session_id = ? AND relationship.event_id = ?
               AND person.email = ? COLLATE NOCASE
          )`,
        [...lockBindings, session.id, viewer.eventId, input.email],
      ),
      this.env.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role,
           invited_at, invitation_expires_at, accepted_at, revoked_at,
           last_operation_id, created_at
         )
         SELECT ?, ?, ?, person.id, 'speaker', unixepoch(),
                unixepoch() + 604800, NULL, NULL, ?, unixepoch()
           FROM people person
           JOIN session_speakers relationship
             ON relationship.person_id = person.id
            AND relationship.event_id = ?
            AND relationship.session_id = ?
          WHERE person.email = ? COLLATE NOCASE
         ON CONFLICT(event_id, person_id, role) WHERE event_id IS NOT NULL
         DO UPDATE SET
           invited_at = CASE
             WHEN memberships.accepted_at IS NOT NULL
              AND memberships.revoked_at IS NULL
             THEN memberships.invited_at ELSE unixepoch() END,
           invitation_expires_at = CASE
             WHEN memberships.accepted_at IS NOT NULL
              AND memberships.revoked_at IS NULL
             THEN memberships.invitation_expires_at
             ELSE unixepoch() + 604800 END,
           accepted_at = CASE
             WHEN memberships.accepted_at IS NOT NULL
              AND memberships.revoked_at IS NULL
             THEN memberships.accepted_at ELSE NULL END,
           revoked_at = NULL,
           last_operation_id = excluded.last_operation_id
          WHERE memberships.organisation_id = excluded.organisation_id`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        input.operationId,
        viewer.eventId,
        session.id,
        input.email,
      ),
      ...materializePublishedResourceAcknowledgementsForSession(
        this.env,
        viewer.eventId,
        session.id,
      ),
      ...(acceptedPlan
        ? buildAcceptanceTaskPlanStatements({
            env: this.env,
            viewer,
            submissionId: acceptedPlan.submissionId,
            sessionId: session.id,
            decisionId: acceptedPlan.decisionId,
            materializationOperationId: input.operationId,
            addedSpeakerEmail: input.email,
          })
        : []),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id,
           event_id, actor_person_id, action, entity_type, entity_id,
           correlation_id, metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'session.speaker.added',
                'session', ?, ?,
                json_object('personId', person.id, 'email', person.email,
                            'operationId', ?),
                unixepoch()
           FROM people person
          WHERE person.email = ? COLLATE NOCASE AND ${lockedEvent}`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        session.id,
        input.operationId,
        input.operationId,
        input.email,
        ...lockBindings,
      ),
      ...invitationPlans.flatMap((plan) => plan.statements),
    ];
    try {
      await this.env.DB.batch(statements);
    } catch (error) {
      if (!isAtomicBatchGuardError(error)) throw error;
      if (
        await this.completedOperation(
          viewer,
          "session.speaker.added",
          input.operationId,
        )
      ) {
        return this.finishAdd(viewer, input.operationId, true);
      }
      // Explain a refusal the batch repeated, such as access revoked or the
      // onboarding plan changed since the checks above.
      await this.assertSpeakerAddable(viewer, input.email, acceptedPlan);
      throw new SessionSpeakerStateError(
        "The session or its schedule changed before the speaker was added. Refresh and try again.",
      );
    }
    return this.finishAdd(viewer, input.operationId, false);
  }

  /** The person must already be related to the organisation, and a speaker
   *  joining an accepted session needs an onboarding plan that acceptance
   *  itself would allow. */
  private async assertSpeakerAddable(
    viewer: Viewer,
    email: string,
    acceptedPlan: AcceptedPlan | null,
  ) {
    const unavailable = await unavailableDirectSessionSpeakerEmails({
      env: this.env,
      organisationId: viewer.organisationId,
      eventId: viewer.eventId,
      emails: [email],
    });
    if (unavailable.length) {
      throw new SessionSpeakerStateError(
        `Invite ${email} to the event and wait for acceptance before adding that existing identity to a session.`,
      );
    }
    if (!acceptedPlan) return;
    try {
      await assertAcceptanceTaskPlan(this.env, viewer.eventId);
    } catch (error) {
      if (error instanceof EvaluationStateError) {
        throw new SessionSpeakerStateError(
          `${error.message} Fix it in Tasks before adding a speaker to this accepted session.`,
        );
      }
      throw error;
    }
  }

  private async removeD1(viewer: Viewer, input: RemoveSessionSpeakerInput) {
    const previous = await this.completedOperation(
      viewer,
      "session.speaker.removed",
      input.operationId,
    );
    if (previous) return { name: previous.name, replayed: true };
    const session = await this.loadSession(viewer, input.sessionId);
    const lockedReason = sessionSpeakersLockedReason(session.status);
    if (lockedReason) throw new SessionSpeakerStateError(lockedReason);
    const speakers = await this.loadSpeakers(viewer, session.id);
    const speaker = speakers.find(
      (candidate) => candidate.personId === input.personId,
    );
    if (!speaker) {
      throw new SessionSpeakerStateError(
        "That person is no longer a speaker on this session. Refresh to see the current speakers.",
      );
    }
    if (speakers.length === 1) {
      throw new SessionSpeakerStateError(
        `A session needs at least one speaker. Add the replacement before removing ${speaker.name}.`,
      );
    }
    const draft = await this.draftConflictRebuild(
      viewer,
      session.id,
      input.operationId,
      (workspace) =>
        withRemovedSessionSpeaker(workspace, {
          sessionId: session.id,
          personId: speaker.personId,
        }),
    );
    const lockedEvent = `EXISTS (
      SELECT 1 FROM events WHERE id = ? AND last_operation_id = ?
    )`;
    const lockBindings = [viewer.eventId, input.operationId];
    try {
      await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE events
              SET revision = revision + 1, last_operation_id = ?,
                  updated_at = unixepoch()
            WHERE id = ? AND organisation_id = ?
              AND EXISTS (
                SELECT 1 FROM sessions session
                 WHERE session.id = ? AND session.event_id = events.id
                   AND session.status IN ('unscheduled', 'scheduled')
              )
              AND EXISTS (
                SELECT 1 FROM session_speakers
                 WHERE session_id = ? AND event_id = events.id
                   AND person_id = ?
              )
              AND (
                SELECT COUNT(*) FROM session_speakers
                 WHERE session_id = ? AND event_id = events.id
              ) > 1
              ${draft.versionGuardSql}`,
        ).bind(
          input.operationId,
          viewer.eventId,
          viewer.organisationId,
          session.id,
          session.id,
          speaker.personId,
          session.id,
          ...draft.versionGuardBindings,
        ),
        ...draft.statements,
        this.env.DB.prepare(
          `INSERT INTO audit_events (
             id, actor_kind, origin, metadata_version, organisation_id,
             event_id, actor_person_id, action, entity_type, entity_id,
             correlation_id, metadata_json, created_at
           )
           SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?,
                  'session.speaker.removed', 'session', ?, ?,
                  json_object('personId', relationship.person_id,
                              'name', ?, 'email', ?,
                              'participationStatus',
                              relationship.participation_status,
                              'operationId', ?),
                  unixepoch()
             FROM session_speakers relationship
            WHERE relationship.session_id = ? AND relationship.event_id = ?
              AND relationship.person_id = ? AND ${lockedEvent}`,
        ).bind(
          crypto.randomUUID(),
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          session.id,
          input.operationId,
          speaker.name,
          speaker.email,
          input.operationId,
          session.id,
          viewer.eventId,
          speaker.personId,
          ...lockBindings,
        ),
        this.env.DB.prepare(
          `DELETE FROM session_speakers
            WHERE session_id = ? AND event_id = ? AND person_id = ?
              AND ${lockedEvent}
              ${draft.speakerGuardSql}`,
        ).bind(
          session.id,
          viewer.eventId,
          speaker.personId,
          ...lockBindings,
          ...draft.speakerGuardBindings,
        ),
        atomicBatchGuardStatement(
          this.env,
          `NOT ${lockedEvent}
            OR EXISTS (
              SELECT 1 FROM session_speakers
               WHERE session_id = ? AND event_id = ? AND person_id = ?
            )`,
          [...lockBindings, session.id, viewer.eventId, speaker.personId],
        ),
      ]);
    } catch (error) {
      if (!isAtomicBatchGuardError(error)) throw error;
      const replayed = await this.completedOperation(
        viewer,
        "session.speaker.removed",
        input.operationId,
      );
      if (replayed) return { name: replayed.name, replayed: true };
      throw new SessionSpeakerStateError(
        "The session or its schedule changed before the speaker was removed. Refresh and try again.",
      );
    }
    return { name: speaker.name, replayed: false };
  }

  private async finishAdd(
    viewer: Viewer,
    operationId: string,
    replayed: boolean,
  ) {
    const added = await this.completedOperation(
      viewer,
      "session.speaker.added",
      operationId,
    );
    if (!added) {
      throw new Error("The added session speaker is missing its audit record.");
    }
    const invitations = await dispatchSpeakerInvitationsForCommand({
      env: this.env,
      organisationId: viewer.organisationId,
      eventId: viewer.eventId,
      commandId: operationId,
    });
    return {
      name: added.name,
      replayed,
      invitationWarning: invitations.some((outcome) =>
        ["queue_failed", "failed", "cancelled"].includes(outcome.status),
      )
        ? "The speaker was added, but their portal invitation needs attention in Speakers administration."
        : null,
    };
  }

  private completedOperation(
    viewer: Viewer,
    action: "session.speaker.added" | "session.speaker.removed",
    operationId: string,
  ) {
    return this.env.DB.prepare(
      `SELECT COALESCE(json_extract(audit.metadata_json, '$.name'),
                       person.display_name) AS name
         FROM audit_events audit
         LEFT JOIN people person
           ON person.id = json_extract(audit.metadata_json, '$.personId')
        WHERE audit.organisation_id = ? AND audit.event_id = ?
          AND audit.action = ? AND audit.correlation_id = ?
        LIMIT 1`,
    )
      .bind(viewer.organisationId, viewer.eventId, action, operationId)
      .first<{ name: string }>();
  }

  private async loadSession(viewer: Viewer, sessionId: string) {
    const session = await this.env.DB.prepare(
      `SELECT session.id, session.title, session.status,
              session.source_submission_id AS sourceSubmissionId,
              submission.status AS submissionStatus,
              form.kind AS formKind,
              (SELECT COUNT(*) FROM submission_decisions decision
                WHERE decision.submission_id = session.source_submission_id
                  AND decision.event_id = session.event_id
                  AND decision.status = 'published'
                  AND decision.decision = 'accepted') AS acceptanceDecisionCount,
              (SELECT decision.id FROM submission_decisions decision
                WHERE decision.submission_id = session.source_submission_id
                  AND decision.event_id = session.event_id
                  AND decision.status = 'published'
                  AND decision.decision = 'accepted'
                ORDER BY decision.published_at DESC, decision.id DESC
                LIMIT 1) AS acceptanceDecisionId
         FROM sessions session
         JOIN events event
           ON event.id = session.event_id AND event.organisation_id = ?
         LEFT JOIN submissions submission
           ON submission.id = session.source_submission_id
          AND submission.event_id = session.event_id
         LEFT JOIN form_versions version
           ON version.id = submission.form_version_id
          AND version.event_id = submission.event_id
         LEFT JOIN form_definitions form
           ON form.id = version.form_id AND form.event_id = version.event_id
        WHERE session.event_id = ? AND session.id = ?`,
    )
      .bind(viewer.organisationId, viewer.eventId, sessionId)
      .first<SessionRow>();
    if (!session) {
      throw new SessionSpeakerStateError("Session was not found.", 404);
    }
    return session;
  }

  private async loadSpeakers(viewer: Viewer, sessionId: string) {
    const rows = await this.env.DB.prepare(
      `SELECT relationship.person_id AS personId,
              person.display_name AS name, person.email,
              relationship.role_label AS roleLabel,
              relationship.participation_status AS participationStatus
         FROM session_speakers relationship
         JOIN people person ON person.id = relationship.person_id
         JOIN events event
           ON event.id = relationship.event_id AND event.organisation_id = ?
        WHERE relationship.event_id = ? AND relationship.session_id = ?
        ORDER BY relationship.position`,
    )
      .bind(viewer.organisationId, viewer.eventId, sessionId)
      .all<SessionSpeaker>();
    return rows.results;
  }

  /** Stored draft conflicts follow the speakers, as for co-speaker claims:
   *  when the session is in the draft schedule, the batch rebuilds them from
   *  the workspace with this change applied, and its writes require that
   *  draft unchanged. Otherwise they require the session still unscheduled. */
  private async draftConflictRebuild(
    viewer: Viewer,
    sessionId: string,
    operationId: string,
    change: (workspace: ScheduleWorkspace) => ScheduleWorkspace,
  ) {
    const unscheduled = {
      versionGuardSql: `AND NOT EXISTS (
           SELECT 1 FROM schedule_entries entry
           JOIN schedule_versions version
             ON version.id = entry.schedule_version_id
            AND version.event_id = entry.event_id
          WHERE entry.event_id = events.id AND entry.session_id = ?
            AND version.status = 'draft'
         )`,
      versionGuardBindings: [sessionId] as Array<string | number>,
      speakerGuardSql: "",
      speakerGuardBindings: [] as Array<string | number>,
      statements: [] as D1PreparedStatement[],
    };
    let workspace: ScheduleWorkspace;
    try {
      workspace = await loadScheduleWorkspaceD1(
        this.env,
        { organisationId: viewer.organisationId, eventId: viewer.eventId },
        { includePublicationConflicts: false },
      );
    } catch (error) {
      if (error instanceof ScheduleConfigurationError) {
        throw new SessionSpeakerStateError(error.message);
      }
      throw error;
    }
    const draft =
      workspace.version?.status === "draft" ? workspace.version : null;
    if (
      !draft ||
      !workspace.entries.some((entry) => entry.sessionId === sessionId)
    ) {
      return unscheduled;
    }
    return {
      versionGuardSql: `AND EXISTS (
           SELECT 1 FROM schedule_versions current_version
            WHERE current_version.id = ? AND current_version.event_id = events.id
              AND current_version.status = 'draft' AND current_version.revision = ?
         )`,
      versionGuardBindings: [draft.id, draft.revision] as Array<
        string | number
      >,
      speakerGuardSql: `AND EXISTS (
           SELECT 1 FROM schedule_versions current_version
            WHERE current_version.event_id = ?
              AND current_version.status = 'draft'
              AND current_version.publication_operation_id = ?
         )`,
      speakerGuardBindings: [viewer.eventId, operationId] as Array<
        string | number
      >,
      statements: scheduleDraftConflictRebuildStatements(this.env, {
        organisationId: viewer.organisationId,
        eventId: viewer.eventId,
        operationId,
        draft,
        conflicts: detectWorkspaceConflicts(change(workspace)),
      }),
    };
  }
}

function requireAdministrator(viewer: Viewer) {
  if (viewer.role !== "owner" && viewer.role !== "administrator") {
    throw new SessionSpeakerStateError(
      "Administrator access is required.",
      403,
    );
  }
}
