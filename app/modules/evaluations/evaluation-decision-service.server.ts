import {
  findSessionFormatConfiguration,
  parseSessionFormatsConfiguration,
} from "~/modules/events/event-configuration";
import { submittedSnapshotSchema } from "~/modules/submissions/submission-schema";
import type { Viewer } from "~/platform/auth/authorize.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import {
  persistAcceptedSpeakerQueueFailure,
  prepareAcceptedSpeakerInvitationPlans,
} from "./accepted-speaker-invitation.server";
import {
  buildDecisionStatements,
  type DecisionSubmission,
} from "./evaluation-decision-statements.server";
import {
  EvaluationDecisionAuthorityError,
  EvaluationDecisionFinalError,
  EvaluationRevisionConflictError,
  EvaluationStateError,
  EvaluationValidationError,
} from "./evaluation-errors";
import { decisionSchema } from "./evaluation-schema";
import { acceptedSpeakerInvitationOutcome } from "./evaluation-decision-invitation-outcome.server";
import {
  assertAcceptanceTaskPlan,
  assertAcceptanceTaskPlanMaterialized,
  assertDecisionViewerEvent,
} from "./evaluation-decision-acceptance-guard.server";

export class EvaluationDecisionService {
  constructor(private readonly env: CloudflareEnvironment) {}

  async decide(viewer: Viewer, input: unknown, commandId?: string) {
    await assertDecisionViewerEvent(this.env, viewer);
    if (
      viewer.role !== "owner" &&
      viewer.role !== "administrator" &&
      viewer.role !== "committee_chair"
    ) {
      throw new EvaluationDecisionAuthorityError();
    }
    const parsed = decisionSchema.parse(input);
    if (commandId) {
      const recovered = await this.env.DB.prepare(
        `SELECT decision.id AS decisionId,
                decision.status AS decisionStatus,
                decision.decision AS decision,
                decision.submission_id AS submissionId,
                session.id AS sessionId,
                operation.id AS notificationOperationId,
                operation.status AS notificationStatus
           FROM submission_decisions decision
           JOIN submissions submission
             ON submission.id = decision.submission_id
            AND submission.event_id = decision.event_id
           JOIN events event
             ON event.id = decision.event_id AND event.organisation_id = ?
           LEFT JOIN sessions session
             ON session.source_submission_id = decision.submission_id
            AND session.event_id = decision.event_id
           LEFT JOIN operation_jobs operation
             ON operation.event_id = decision.event_id
            AND operation.idempotency_key = 'decision-notification:' || decision.id
          WHERE decision.id = ? AND decision.event_id = ?`,
      )
        .bind(viewer.organisationId, commandId, viewer.eventId)
        .first<{
          decisionId: string;
          decisionStatus: string;
          decision: string;
          submissionId: string;
          sessionId: string | null;
          notificationOperationId: string | null;
          notificationStatus: string | null;
        }>();
      if (recovered) {
        if (
          recovered.decisionStatus === "published" &&
          recovered.decision === "accepted" &&
          recovered.sessionId
        )
          await assertAcceptanceTaskPlanMaterialized(this.env, {
            eventId: viewer.eventId,
            submissionId: recovered.submissionId,
            sessionId: recovered.sessionId,
            decisionId: recovered.decisionId,
          });
        const speakerInvitations = await acceptedSpeakerInvitationOutcome(
          this.env,
          viewer,
          recovered.decisionId,
          recovered.sessionId,
        );
        return {
          decisionId: recovered.decisionId,
          sessionId: recovered.sessionId,
          notificationOperationId: recovered.notificationOperationId,
          notificationStatus:
            recovered.notificationStatus === "queue_failed"
              ? ("queue_failed" as const)
              : recovered.notificationOperationId
                ? ("queued" as const)
                : ("not_requested" as const),
          ...speakerInvitations,
        };
      }
    }
    if (
      parsed.release &&
      viewer.role !== "owner" &&
      viewer.role !== "administrator"
    ) {
      const plan = await this.env.DB.prepare(
        `
        SELECT decision_role AS decisionRole
          FROM evaluation_plans
         WHERE event_id = ? AND status = 'active'
         ORDER BY created_at DESC LIMIT 1
      `,
      )
        .bind(viewer.eventId)
        .first<{ decisionRole: string }>();
      if (
        viewer.role !== "committee_chair" ||
        plan?.decisionRole !== "committee_chair"
      ) {
        throw new EvaluationDecisionAuthorityError();
      }
    }
    const submission = await this.env.DB.prepare(
      `
      SELECT s.id, s.title, s.public_reference AS reference, s.format, s.category,
             s.status, s.revision, s.submitted_snapshot_json AS snapshotJson
        FROM submissions s JOIN events e ON e.id = s.event_id
       WHERE s.id = ? AND s.event_id = ? AND e.organisation_id = ? AND s.status NOT IN ('draft','withdrawn')
    `,
    )
      .bind(parsed.submissionId, viewer.eventId, viewer.organisationId)
      .first<DecisionSubmission>();
    if (!submission)
      throw new EvaluationStateError(
        "Submission not found or cannot be decided.",
      );
    const terminalStatuses = new Set(["accepted", "waitlisted", "rejected"]);
    const prior = await this.env.DB.prepare(
      `
      SELECT COALESCE(MAX(revision_number), 0) AS revision,
             COALESCE(MAX(CASE WHEN status = 'published' THEN 1 ELSE 0 END), 0) AS hasPublished
        FROM submission_decisions WHERE event_id = ? AND submission_id = ?
    `,
    )
      .bind(viewer.eventId, submission.id)
      .first<{ revision: number; hasPublished: number }>();
    if (
      terminalStatuses.has(submission.status) ||
      Number(prior?.hasPublished ?? 0) > 0
    ) {
      throw new EvaluationDecisionFinalError();
    }
    const revision = (prior?.revision ?? 0) + 1;
    const completedRound = await this.env.DB.prepare(
      `
      SELECT a.round_id AS roundId
        FROM evaluator_assignments a
        JOIN reviews r
          ON r.assignment_id = a.id AND r.event_id = a.event_id
         AND r.status IN ('submitted','locked')
        JOIN evaluation_rounds round
          ON round.id = a.round_id AND round.event_id = a.event_id
       WHERE a.event_id = ? AND a.submission_id = ?
       ORDER BY round.round_number DESC LIMIT 1
    `,
    )
      .bind(viewer.eventId, submission.id)
      .first<{ roundId: string }>();
    if (parsed.release && !completedRound) {
      if (!parsed.confirmedWithoutReview) {
        throw new EvaluationValidationError(
          "Confirm the review-evidence override before releasing a decision without completed review evidence.",
        );
      }
    }
    const notificationFeedback =
      parsed.includeReviewerFeedback && completedRound
        ? (
            await this.env.DB.prepare(
              `SELECT trim(review.submitter_feedback) AS feedback
                 FROM evaluator_assignments assignment
                 JOIN reviews review
                   ON review.assignment_id = assignment.id
                  AND review.event_id = assignment.event_id
                WHERE assignment.event_id = ?
                  AND assignment.submission_id = ?
                  AND assignment.round_id = ?
                  AND review.status IN ('submitted','locked')
                  AND length(trim(COALESCE(review.submitter_feedback, ''))) > 0
                ORDER BY assignment.assigned_at, assignment.id`,
            )
              .bind(viewer.eventId, submission.id, completedRound.roundId)
              .all<{ feedback: string }>()
          ).results.map((row) => row.feedback)
        : [];
    const decisionId = commandId ?? crypto.randomUUID();
    const sessionId =
      parsed.release && parsed.decision === "accepted"
        ? commandId
          ? `session:${commandId}`
          : crypto.randomUUID()
        : null;
    let sessionTitle = "";
    let sessionDescription = "";
    let format = "";
    let sessionDurationMinutes = 0;
    let sessionTrack: { id: string; name: string } | null = null;
    let acceptedEvent: {
      name: string;
      brandAccent: string;
      startsAt: number;
      endsAt: number;
      venueName: string | null;
      city: string | null;
    } | null = null;
    if (parsed.decision === "accepted") {
      sessionTrack = await this.env.DB.prepare(
        `SELECT selection.track_id AS id, track.name
           FROM submission_track_selections selection
           JOIN tracks track
             ON track.id = selection.track_id
            AND track.event_id = selection.event_id
          WHERE selection.submission_id = ? AND selection.event_id = ?
            AND selection.track_id = ?`,
      )
        .bind(submission.id, viewer.eventId, parsed.sessionTrackId)
        .first<{ id: string; name: string }>();
      if (!sessionTrack) {
        throw new EvaluationValidationError(
          "Choose one of the tracks submitted with this proposal for the accepted session.",
        );
      }
    }
    if (sessionId) {
      let rawSnapshot: unknown;
      try {
        rawSnapshot = JSON.parse(submission.snapshotJson ?? "null");
      } catch {
        rawSnapshot = null;
      }
      const snapshot = submittedSnapshotSchema.safeParse(rawSnapshot);
      if (!snapshot.success) {
        throw new EvaluationStateError(
          "The accepted submission is missing its valid immutable snapshot.",
        );
      }
      const title = snapshot.data.answers.title;
      sessionTitle = Array.isArray(title)
        ? title
            .map((value) => value.trim())
            .filter(Boolean)
            .join(", ")
        : typeof title === "string"
          ? title.trim()
          : "";
      if (!sessionTitle) {
        throw new EvaluationStateError(
          "The accepted submission snapshot is missing its session title.",
        );
      }
      const description = snapshot.data.answers.description;
      sessionDescription =
        typeof description === "string" ? description.trim() : "";
      const submittedFormat = snapshot.data.answers.format;
      const formatLabel = Array.isArray(submittedFormat)
        ? submittedFormat.join(", ")
        : typeof submittedFormat === "string"
          ? submittedFormat
          : "";
      const event = await this.env.DB.prepare(
        `SELECT name, brand_accent AS brandAccent,
                starts_at AS startsAt, ends_at AS endsAt,
                venue_name AS venueName, city,
                session_formats_json AS sessionFormatsJson
           FROM events WHERE id = ? AND organisation_id = ?`,
      )
        .bind(viewer.eventId, viewer.organisationId)
        .first<{
          name: string;
          brandAccent: string;
          startsAt: number;
          endsAt: number;
          venueName: string | null;
          city: string | null;
          sessionFormatsJson: string;
        }>();
      if (!event) {
        throw new EvaluationStateError(
          "The accepted submission event is unavailable.",
        );
      }
      let configuredFormat;
      try {
        configuredFormat = findSessionFormatConfiguration(
          parseSessionFormatsConfiguration(event.sessionFormatsJson),
          formatLabel,
        );
      } catch (error) {
        throw new EvaluationStateError(
          error instanceof Error
            ? error.message
            : "The event has invalid session-format configuration.",
        );
      }
      if (!configuredFormat) {
        throw new EvaluationStateError(
          `The accepted submission format ${formatLabel ? `“${formatLabel}”` : "is missing and"} is not configured for this event.`,
        );
      }
      format = configuredFormat.key;
      sessionDurationMinutes =
        parsed.sessionDurationMinutes ??
        configuredFormat.defaultDurationMinutes;
      acceptedEvent = event;
    }
    const notificationOperationId = parsed.release
      ? commandId
        ? `decision-notification:${commandId}`
        : crypto.randomUUID()
      : null;
    const status = parsed.release ? "published" : "draft";
    const submissionStatus = parsed.release
      ? parsed.decision
      : "decision_ready";
    const slug = `${
      (sessionTitle || submission.title)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 80) || "session"
    }-${submission.reference.toLowerCase()}`;
    const acceptedSpeakers = sessionId
      ? await this.env.DB.prepare(
          `
          SELECT DISTINCT person.id, person.email,
                 membership.id AS existingMembershipId,
                 membership.accepted_at AS membershipAcceptedAt,
                 membership.revoked_at AS membershipRevokedAt
            FROM submission_speakers submission_speaker
            JOIN people person ON person.id = submission_speaker.person_id
            LEFT JOIN memberships membership
              ON membership.event_id = submission_speaker.event_id
             AND membership.person_id = submission_speaker.person_id
             AND membership.role = 'speaker'
           WHERE submission_speaker.event_id = ?
             AND submission_speaker.submission_id = ?
             AND submission_speaker.person_id IS NOT NULL
           ORDER BY person.id
        `,
        )
          .bind(viewer.eventId, submission.id)
          .all<{
            id: string;
            email: string;
            existingMembershipId: string | null;
            membershipAcceptedAt: number | null;
            membershipRevokedAt: number | null;
          }>()
      : {
          results: [] as Array<{
            id: string;
            email: string;
            existingMembershipId: string | null;
            membershipAcceptedAt: number | null;
            membershipRevokedAt: number | null;
          }>,
        };
    if (sessionId && acceptedSpeakers.results.length === 0) {
      throw new EvaluationStateError(
        "An accepted session requires at least one claimed speaker before release.",
      );
    }
    if (sessionId) await assertAcceptanceTaskPlan(this.env, viewer.eventId);
    const speakerMemberships = acceptedSpeakers.results.map((speaker) => ({
      membershipId:
        speaker.existingMembershipId ??
        (commandId
          ? `speaker-membership:${commandId}:${speaker.id}`
          : crypto.randomUUID()),
      personId: speaker.id,
    }));
    const speakerInvitations = acceptedSpeakers.results
      .map((speaker, index) => ({
        ...speaker,
        membershipId: speakerMemberships[index]!.membershipId,
      }))
      .filter(
        (speaker) =>
          speaker.membershipAcceptedAt === null ||
          speaker.membershipRevokedAt !== null,
      );
    const operationsQueue = this.env.OPERATIONS_QUEUE;
    if (parsed.release && !operationsQueue) {
      throw new Error("Required OPERATIONS_QUEUE binding is unavailable.");
    }
    const speakerInvitationPlans =
      sessionId && acceptedEvent
        ? await prepareAcceptedSpeakerInvitationPlans({
            env: this.env,
            viewer,
            decisionId,
            sessionId,
            event: acceptedEvent,
            speakers: speakerInvitations,
          })
        : [];
    const auditEventId = crypto.randomUUID();
    const webhookService = new WebhookService(this.env);
    const preparedWebhook = await webhookService.prepareEventForAudit(
      viewer,
      {
        eventType: parsed.release ? "decision.released" : "decision.recorded",
        entityType: "submission_decision",
        entityId: decisionId,
        idempotencyKey: `${parsed.release ? "decision.released" : "decision.recorded"}:${decisionId}`,
        correlationId: decisionId,
        data: {
          submissionId: submission.id,
          decision: parsed.decision,
          released: parsed.release,
          sessionId,
          sessionTrackId: sessionTrack?.id ?? null,
        },
      },
      auditEventId,
    );
    const statements = buildDecisionStatements({
      env: this.env,
      viewer,
      parsed,
      submission,
      revision,
      decisionId,
      status,
      submissionStatus,
      sessionId,
      sessionTitle,
      sessionDescription,
      slug,
      format,
      sessionDurationMinutes,
      sessionTrack,
      notificationOperationId,
      notificationFeedback,
      roundId: completedRound?.roundId ?? null,
      speakerMemberships,
      speakerInvitationPlans,
      auditEventId,
    });
    statements.push(...preparedWebhook.statements);
    const [updated] = await this.env.DB.batch(statements);
    if ((updated.meta.changes ?? 0) !== 1) {
      if (sessionId) {
        await assertAcceptanceTaskPlan(this.env, viewer.eventId);
        const pendingSpeaker = await this.env.DB.prepare(
          `
          SELECT 1 FROM submission_speakers
           WHERE event_id = ? AND submission_id = ? AND person_id IS NULL
           LIMIT 1
        `,
        )
          .bind(viewer.eventId, submission.id)
          .first();
        if (pendingSpeaker) {
          throw new EvaluationStateError(
            "Claim every co-speaker before releasing an accepted decision. No speaker will be silently omitted from the session.",
          );
        }
      }
      if (parsed.decision === "accepted") {
        const submittedTrack = await this.env.DB.prepare(
          `SELECT track.name
             FROM submission_track_selections selection
             JOIN tracks track
               ON track.id = selection.track_id
              AND track.event_id = selection.event_id
            WHERE selection.submission_id = ? AND selection.event_id = ?
              AND selection.track_id = ? LIMIT 1`,
        )
          .bind(submission.id, viewer.eventId, parsed.sessionTrackId)
          .first<{ name: string }>();
        if (!submittedTrack) {
          throw new EvaluationStateError(
            "The accepted session track is no longer one of the proposal's submitted tracks. Refresh before releasing it.",
          );
        }
        if (submittedTrack.name !== sessionTrack?.name) {
          throw new EvaluationStateError(
            "The accepted programme track was renamed after the decision preview. Refresh and confirm the current track name before releasing it.",
          );
        }
      }
      if (parsed.release && viewer.role === "committee_chair") {
        const authority = await this.env.DB.prepare(
          `
          SELECT 1 FROM evaluation_plans
           WHERE event_id = ? AND status = 'active'
             AND decision_role = 'committee_chair'
           LIMIT 1
        `,
        )
          .bind(viewer.eventId)
          .first();
        if (!authority) throw new EvaluationDecisionAuthorityError();
      }
      throw new EvaluationRevisionConflictError(
        "This submission changed before the decision was saved. Refresh before trying again.",
      );
    }
    const webhookDeliveries =
      await webhookService.dispatchPreparedEvent(preparedWebhook);
    if (sessionId)
      await assertAcceptanceTaskPlanMaterialized(this.env, {
        eventId: viewer.eventId,
        submissionId: submission.id,
        sessionId,
        decisionId,
      });
    let notificationStatus: "not_requested" | "queued" | "queue_failed" =
      notificationOperationId ? "queued" : "not_requested";
    if (notificationOperationId) {
      const message = {
        operationId: notificationOperationId,
        eventId: viewer.eventId,
        organisationId: viewer.organisationId,
        type: "decision.notification",
        idempotencyKey: `decision-notification:${decisionId}`,
        payload: { decisionId },
      };
      try {
        await operationsQueue!.send(message);
      } catch (error) {
        notificationStatus = "queue_failed";
        await this.env.DB.prepare(
          "UPDATE operation_jobs SET status = 'queue_failed', last_error = ?, updated_at = unixepoch() WHERE id = ?",
        )
          .bind(
            error instanceof Error ? error.message : String(error),
            notificationOperationId,
          )
          .run();
      }
    }
    let speakerInvitationStatus:
      | "not_required"
      | "queued"
      | "queue_failed"
      | "demo_not_sent"
      | "demo_activation_failed" = "not_required";
    let speakerInvitationCount = speakerInvitations.length;
    if (speakerInvitationCount > 0) {
      if (String(this.env.DEMO_MODE) === "true") {
        const outcome = await acceptedSpeakerInvitationOutcome(
          this.env,
          viewer,
          decisionId,
          sessionId,
        );
        speakerInvitationStatus = outcome.speakerInvitationStatus;
        speakerInvitationCount = outcome.speakerInvitationCount;
      } else {
        speakerInvitationStatus = "queued";
        for (const plan of speakerInvitationPlans) {
          try {
            await operationsQueue!.send(plan.message);
          } catch (error) {
            await persistAcceptedSpeakerQueueFailure(this.env, plan, error);
            speakerInvitationStatus = "queue_failed";
          }
        }
      }
    }
    return {
      decisionId,
      sessionId,
      notificationOperationId,
      notificationStatus,
      speakerInvitationStatus,
      speakerInvitationCount,
      webhookDeliveries,
    };
  }
}
