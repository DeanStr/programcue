import { z } from "zod";
import { routingSchema } from "~/modules/submissions/submission-schema";
import { createAuth } from "~/platform/auth/auth.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  EvaluationInvitationDeliveryError,
  EvaluationRevisionConflictError,
  EvaluationStateError,
} from "./evaluation-errors";
import {
  committeeChairAccessSchema,
  evaluationMemberInvitationSchema,
  evaluationPlanSchema,
  evaluationTeamMemberSchema,
  evaluationTeamSchema,
} from "./evaluation-schema";
import {
  EvaluationServiceFoundation,
  evaluationAuditActor,
  planCommandResultSchema,
  type Criterion,
  type EvaluationAdminActor,
  type EvaluationApiCommand,
  type Round,
} from "./evaluation-service-foundation.server";

export abstract class EvaluationConfigurationWorkflows extends EvaluationServiceFoundation {
  async getAdminWorkspace(viewer: Viewer) {
    return this.readAuthoritative(viewer, () =>
      this.getAdminWorkspaceD1(viewer),
    );
  }

  protected async getAdminWorkspaceD1(viewer: Viewer) {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationManager(viewer);
    const [
      planRow,
      teamRows,
      teamMemberRows,
      evaluatorRows,
      evaluatorInvitationRows,
      submissionRows,
      sessionRows,
      acceptedSpeakerInvitationRows,
      assignmentRows,
      moderationRows,
    ] = await Promise.all([
      this.env.DB.prepare(
        `
        SELECT p.id, p.name, p.status, p.revision,
               p.blinded_reviewing AS blindedReviewing,
               p.decision_role AS decisionRole
          FROM evaluation_plans p JOIN events e ON e.id = p.event_id
         WHERE p.event_id = ? AND e.organisation_id = ? AND p.status <> 'archived'
         ORDER BY p.created_at DESC LIMIT 1
      `,
      )
        .bind(viewer.eventId, viewer.organisationId)
        .first<{
          id: string;
          name: string;
          status: string;
          revision: number;
          blindedReviewing: number | boolean;
          decisionRole: "administrator" | "committee_chair";
        }>(),
      this.env.DB.prepare(
        `
        SELECT t.id, t.name, t.description,
               t.chair_person_id AS chairPersonId, t.status,
               COUNT(tm.person_id) AS memberCount,
               SUM(CASE WHEN tm.person_id IS NOT NULL AND EXISTS (
                 SELECT 1 FROM memberships active_membership
                  WHERE active_membership.event_id = t.event_id
                    AND active_membership.person_id = tm.person_id
                    AND active_membership.accepted_at IS NOT NULL
                    AND active_membership.revoked_at IS NULL
                    AND active_membership.role IN ('evaluator','committee_chair')
               ) THEN 1 ELSE 0 END) AS eligibleMemberCount
          FROM evaluation_teams t
          LEFT JOIN evaluation_team_members tm ON tm.team_id = t.id AND tm.event_id = t.event_id AND tm.removed_at IS NULL
         WHERE t.event_id = ? GROUP BY t.id ORDER BY t.name
      `,
      )
        .bind(viewer.eventId)
        .all<{
          id: string;
          name: string;
          description: string | null;
          chairPersonId: string | null;
          status: string;
          memberCount: number;
          eligibleMemberCount: number;
        }>(),
      this.env.DB.prepare(
        `
        SELECT tm.team_id AS teamId, tm.person_id AS personId,
               tm.role, p.display_name AS name, p.email,
               EXISTS (
                 SELECT 1 FROM memberships active_membership
                  WHERE active_membership.event_id = tm.event_id
                    AND active_membership.person_id = tm.person_id
                    AND active_membership.accepted_at IS NOT NULL
                    AND active_membership.revoked_at IS NULL
                    AND active_membership.role IN ('evaluator','committee_chair')
               ) AS authorised
          FROM evaluation_team_members tm
          JOIN evaluation_teams t
            ON t.id = tm.team_id AND t.event_id = tm.event_id
          JOIN people p ON p.id = tm.person_id
         WHERE tm.event_id = ? AND tm.removed_at IS NULL
           AND t.status = 'active'
         ORDER BY p.display_name
      `,
      )
        .bind(viewer.eventId)
        .all<{
          teamId: string;
          personId: string;
          role: "chair" | "evaluator";
          name: string;
          email: string;
          authorised: number | boolean;
        }>(),
      this.env.DB.prepare(
        `
        SELECT p.id, p.display_name AS name, p.email,
               CASE WHEN MAX(CASE WHEN m.role = 'committee_chair' THEN 1 ELSE 0 END) = 1
                    THEN 'committee_chair' ELSE 'evaluator' END AS role,
               MAX(CASE WHEN m.role = 'committee_chair' THEN m.id END)
                 AS chairMembershipId
          FROM memberships m JOIN people p ON p.id = m.person_id
         WHERE m.event_id = ? AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL
           AND m.role IN ('evaluator','committee_chair')
         GROUP BY p.id, p.display_name, p.email
         ORDER BY p.display_name
      `,
      )
        .bind(viewer.eventId)
        .all<{
          id: string;
          name: string;
          email: string;
          role: string;
          chairMembershipId: string | null;
        }>(),
      this.env.DB.prepare(
        `
        SELECT m.id, p.display_name AS name, p.email, m.role,
               m.invited_at AS invitedAt,
               m.invitation_expires_at AS expiresAt,
               CASE
                 WHEN m.invitation_expires_at IS NOT NULL
                  AND m.invitation_expires_at <= unixepoch() THEN 'expired'
                 ELSE 'pending'
               END AS status
          FROM memberships m
          JOIN people p ON p.id = m.person_id
         WHERE m.event_id = ? AND m.role IN ('evaluator','committee_chair')
           AND m.accepted_at IS NULL AND m.invited_at IS NOT NULL
           AND m.revoked_at IS NULL
         ORDER BY m.invited_at DESC, p.display_name
      `,
      )
        .bind(viewer.eventId)
        .all<{
          id: string;
          name: string;
          email: string;
          role: "evaluator" | "committee_chair";
          invitedAt: number;
          expiresAt: number | null;
          status: "pending" | "expired";
        }>(),
      this.env.DB.prepare(
        `
        SELECT s.id, s.public_reference AS reference, s.title,
               (
                 SELECT group_concat(selected.track_name_snapshot, ', ')
                   FROM (
                     SELECT selection.track_name_snapshot
                       FROM submission_track_selections selection
                      WHERE selection.submission_id = s.id
                        AND selection.event_id = s.event_id
                      ORDER BY selection.position
                   ) selected
               ) AS category,
               COALESCE((
                 SELECT json_group_array(json(selected.track))
                   FROM (
                     SELECT json_object(
                              'id', selection.track_id,
                              'name', track.name,
                              'submittedName', selection.track_name_snapshot,
                              'position', selection.position
                            ) AS track
                       FROM submission_track_selections selection
                       JOIN tracks track
                         ON track.id = selection.track_id
                        AND track.event_id = selection.event_id
                      WHERE selection.submission_id = s.id
                        AND selection.event_id = s.event_id
                      ORDER BY selection.position
                   ) selected
               ), '[]') AS tracksJson,
               s.format, s.status,
               COALESCE((
                 SELECT json_group_array(routed.team_id)
                   FROM (
                     SELECT route.team_id
                       FROM submission_routing_teams route
                      WHERE route.submission_id = s.id
                        AND route.event_id = s.event_id
                      ORDER BY route.team_id
                   ) routed
               ), '[]') AS routedTeamIdsJson,
               COALESCE(
                 form_version.routing_json,
                 json_extract(s.submitted_snapshot_json, '$.routing')
               ) AS routingJson,
               s.submitter_email AS submitterEmail,
               (SELECT COUNT(*) FROM submission_speakers ss
                 WHERE ss.event_id = s.event_id AND ss.submission_id = s.id
                   AND ss.person_id IS NULL) AS unclaimedSpeakerCount,
               COUNT(DISTINCT a.id) AS assignmentCount,
               COUNT(DISTINCT CASE WHEN a.status = 'submitted' THEN a.id END) AS completedReviewCount,
               AVG(r.weighted_score) AS averageScore
          FROM submissions s
          JOIN events e ON e.id = s.event_id
          LEFT JOIN form_versions form_version
            ON form_version.id = s.form_version_id
           AND form_version.event_id = s.event_id
          LEFT JOIN evaluator_assignments a ON a.submission_id = s.id AND a.event_id = s.event_id
          LEFT JOIN reviews r ON r.assignment_id = a.id AND r.status IN ('submitted','locked')
         WHERE s.event_id = ? AND e.organisation_id = ? AND s.status <> 'draft'
         GROUP BY s.id ORDER BY s.updated_at DESC
      `,
      )
        .bind(viewer.eventId, viewer.organisationId)
        .all<{
          id: string;
          reference: string;
          title: string;
          category: string | null;
          tracksJson: string;
          format: string | null;
          status: string;
          routedTeamIdsJson: string;
          routingJson: string | null;
          submitterEmail: string | null;
          unclaimedSpeakerCount: number;
          assignmentCount: number;
          completedReviewCount: number;
          averageScore: number | null;
        }>(),
      this.env.DB.prepare(
        `
        SELECT session.id, session.slug AS reference, session.title,
               session.description, session.format,
               session.duration_minutes AS durationMinutes, session.status,
               track.name AS trackName,
               COUNT(DISTINCT assignment.id) AS assignmentCount,
               COUNT(DISTINCT CASE WHEN assignment.status = 'submitted'
                              THEN assignment.id END) AS completedReviewCount,
               AVG(review.weighted_score) AS averageScore
          FROM sessions session
          JOIN events event ON event.id = session.event_id
          LEFT JOIN tracks track
            ON track.id = session.track_id AND track.event_id = session.event_id
          LEFT JOIN evaluator_assignments assignment
            ON assignment.session_id = session.id
           AND assignment.event_id = session.event_id
          LEFT JOIN reviews review
            ON review.assignment_id = assignment.id
           AND review.status IN ('submitted','locked')
         WHERE session.event_id = ? AND event.organisation_id = ?
           AND session.status NOT IN ('cancelled','archived')
         GROUP BY session.id
         ORDER BY session.updated_at DESC, session.id
      `,
      )
        .bind(viewer.eventId, viewer.organisationId)
        .all<{
          id: string;
          reference: string;
          title: string;
          description: string | null;
          format: string;
          durationMinutes: number;
          status: string;
          trackName: string | null;
          assignmentCount: number;
          completedReviewCount: number;
          averageScore: number | null;
        }>(),
      this.env.DB.prepare(
        `SELECT membership.id AS membershipId,
                membership.invitation_expires_at AS expiresAt,
                CASE WHEN membership.invitation_expires_at <= unixepoch()
                     THEN 'expired' ELSE 'pending' END AS status,
                person.id AS personId, person.display_name AS name, person.email,
                decision.id AS decisionId, decision.submission_id AS submissionId,
                session.id AS sessionId, session.title AS sessionTitle
           FROM submission_decisions decision
           JOIN events event
             ON event.id = decision.event_id AND event.organisation_id = ?
           JOIN sessions session
             ON session.source_submission_id = decision.submission_id
            AND session.event_id = decision.event_id
           JOIN session_speakers relationship
             ON relationship.session_id = session.id
            AND relationship.event_id = session.event_id
           JOIN people person ON person.id = relationship.person_id
           JOIN memberships membership
             ON membership.organisation_id = event.organisation_id
            AND membership.event_id = decision.event_id
            AND membership.person_id = person.id
            AND membership.role = 'speaker'
          WHERE decision.event_id = ? AND decision.status = 'published'
            AND decision.decision = 'accepted'
            AND membership.accepted_at IS NULL
            AND membership.revoked_at IS NULL
          ORDER BY session.title COLLATE NOCASE, person.display_name COLLATE NOCASE,
                   membership.id`,
      )
        .bind(viewer.organisationId, viewer.eventId)
        .all<{
          membershipId: string;
          expiresAt: number;
          status: "pending" | "expired";
          personId: string;
          name: string;
          email: string;
          decisionId: string;
          submissionId: string;
          sessionId: string;
          sessionTitle: string;
        }>(),
      this.env.DB.prepare(
        `
        SELECT a.id, a.round_id AS roundId,
               a.submission_id AS submissionId, a.session_id AS sessionId,
               CASE WHEN a.submission_id IS NOT NULL THEN 'submission'
                    ELSE 'session' END AS targetType,
               COALESCE(submission.title, session.title) AS targetTitle,
               a.evaluator_person_id AS evaluatorPersonId,
               p.display_name AS evaluatorName, a.team_id AS teamId,
               t.name AS teamName, a.status, a.revision,
               r.id AS reviewId, r.status AS reviewStatus,
               r.weighted_score AS weightedScore,
               r.recommendation, r.confidence,
               r.submitter_feedback AS submitterFeedback,
               r.private_notes AS privateNotes,
               conflict.notes AS conflictNotes,
               conflict.status AS conflictStatus
          FROM evaluator_assignments a
          JOIN people p ON p.id = a.evaluator_person_id
          LEFT JOIN evaluation_teams t
            ON t.id = a.team_id AND t.event_id = a.event_id
          LEFT JOIN submissions submission
            ON submission.id = a.submission_id
           AND submission.event_id = a.event_id
          LEFT JOIN sessions session
            ON session.id = a.session_id AND session.event_id = a.event_id
          LEFT JOIN reviews r
            ON r.assignment_id = a.id AND r.event_id = a.event_id
          LEFT JOIN evaluator_conflicts conflict
           ON conflict.event_id = a.event_id
           AND conflict.round_id = a.round_id
           AND conflict.evaluator_person_id = a.evaluator_person_id
           AND (
             (a.submission_id IS NOT NULL
              AND conflict.submission_id = a.submission_id)
             OR
             (a.session_id IS NOT NULL AND conflict.session_id = a.session_id)
           )
         WHERE a.event_id = ?
         ORDER BY a.assigned_at, p.display_name
      `,
      )
        .bind(viewer.eventId)
        .all<{
          id: string;
          roundId: string;
          submissionId: string | null;
          sessionId: string | null;
          targetType: "submission" | "session";
          targetTitle: string;
          evaluatorPersonId: string;
          evaluatorName: string;
          teamId: string | null;
          teamName: string | null;
          status: string;
          revision: number;
          reviewId: string | null;
          reviewStatus: string | null;
          weightedScore: number | null;
          recommendation: string | null;
          confidence: number | null;
          submitterFeedback: string | null;
          privateNotes: string | null;
          conflictNotes: string | null;
          conflictStatus: string | null;
        }>(),
      this.env.DB.prepare(
        `
        SELECT m.id, m.round_id AS roundId, m.submission_id AS submissionId,
               m.status, m.recommendation,
               m.moderated_score AS moderatedScore, m.notes,
               m.moderator_person_id AS moderatorPersonId,
               p.display_name AS moderatorName
          FROM review_moderations m
          JOIN people p ON p.id = m.moderator_person_id
         WHERE m.event_id = ? AND m.status IN ('draft','confirmed')
      `,
      )
        .bind(viewer.eventId)
        .all<{
          id: string;
          roundId: string;
          submissionId: string;
          status: "draft" | "confirmed";
          recommendation: "accept" | "waitlist" | "reject" | "advance";
          moderatedScore: number | null;
          notes: string | null;
          moderatorPersonId: string;
          moderatorName: string;
        }>(),
    ]);
    const rounds = planRow
      ? await this.getRounds(
          viewer.eventId,
          planRow.id,
          Boolean(planRow.blindedReviewing),
        )
      : [];
    const submissions = submissionRows.results.map(
      ({ routedTeamIdsJson, routingJson, tracksJson, ...submission }) => {
        if (!submission.category) {
          throw new EvaluationStateError(
            `Submission ${submission.id} is missing persisted track selections.`,
          );
        }
        const routedTeamIds = z
          .array(z.string())
          .parse(JSON.parse(routedTeamIdsJson));
        if (!routingJson) {
          throw new EvaluationStateError(
            `Submission ${submission.id} is missing its immutable routing snapshot.`,
          );
        }
        const routing = routingSchema.parse(JSON.parse(routingJson));
        const routedTeamNames = routedTeamIds.map((teamId) => {
          const name = routing.teamNames[teamId];
          if (!name) {
            throw new EvaluationStateError(
              `Submission ${submission.id} has inconsistent persisted routing teams.`,
            );
          }
          return name;
        });
        const tracks = z
          .array(
            z.object({
              id: z.string(),
              name: z.string(),
              submittedName: z.string(),
              position: z.number().int().nonnegative(),
            }),
          )
          .min(1)
          .parse(JSON.parse(tracksJson));
        return {
          ...submission,
          routedTeamIds,
          routedTeamName:
            routedTeamNames.length > 0 ? routedTeamNames.join(", ") : null,
          tracks,
        };
      },
    );
    return {
      plan: planRow
        ? {
            ...planRow,
            blindedReviewing: Boolean(planRow.blindedReviewing),
            rounds,
          }
        : null,
      teams: teamRows.results.map((team) => ({
        ...team,
        members: teamMemberRows.results
          .filter((member) => member.teamId === team.id)
          .map((member) => ({
            ...member,
            authorised: Boolean(member.authorised),
          })),
      })),
      evaluators: evaluatorRows.results,
      evaluationInvitations: evaluatorInvitationRows.results,
      submissions,
      acceptedSpeakerInvitations: acceptedSpeakerInvitationRows.results,
      sessions: sessionRows.results,
      assignments: assignmentRows.results,
      moderations: moderationRows.results,
    };
  }

  protected async getRounds(
    eventId: string,
    planId: string,
    anonymous: boolean,
  ): Promise<Round[]> {
    const [roundRows, criterionRows] = await Promise.all([
      this.env.DB.prepare(
        `
        SELECT id, name, round_number AS roundNumber, status, revision
          FROM evaluation_rounds WHERE event_id = ? AND plan_id = ? ORDER BY round_number
      `,
      )
        .bind(eventId, planId)
        .all<Omit<Round, "criteria" | "anonymous">>(),
      this.env.DB.prepare(
        `
        SELECT c.id, c.round_id AS roundId, c.name, c.description,
               c.input_type AS inputType, c.weight_percent AS weightPercent,
               c.required, c.position
          FROM evaluation_criteria c JOIN evaluation_rounds r ON r.id = c.round_id AND r.event_id = c.event_id
         WHERE c.event_id = ? AND r.plan_id = ? ORDER BY r.round_number, c.position
      `,
      )
        .bind(eventId, planId)
        .all<Criterion & { roundId: string }>(),
    ]);
    return roundRows.results.map((round) => ({
      ...round,
      anonymous,
      criteria: criterionRows.results
        .filter((criterion) => criterion.roundId === round.id)
        .map((criterion) => ({
          ...criterion,
          required: Boolean(criterion.required),
        })),
    }));
  }

  async savePlan(
    viewer: EvaluationAdminActor,
    input: unknown,
    command?: EvaluationApiCommand,
  ) {
    return this.projectCommand(
      viewer,
      "evaluation.plan.save",
      input,
      command,
      () => this.savePlanD1(viewer, input, command),
    );
  }

  protected async savePlanD1(
    viewer: EvaluationAdminActor,
    input: unknown,
    command?: EvaluationApiCommand,
  ) {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationManager(viewer);
    const auditActor = evaluationAuditActor(viewer);
    const commandState = await this.prepareApiCommand(
      viewer,
      "evaluation.plan.save",
      command,
      planCommandResultSchema,
    );
    if (commandState.replay) return commandState.replay.planId;
    const commandGuard = this.commandGuard(commandState.prepared);
    const parsed = evaluationPlanSchema.parse(input);
    const blindedReviewing = parsed.rounds[0].anonymous ? 1 : 0;
    const existing = await this.env.DB.prepare(
      `
      SELECT id, revision, decision_role AS decisionRole
        FROM evaluation_plans
       WHERE event_id = ? AND status <> 'archived' ORDER BY created_at DESC LIMIT 1
    `,
    )
      .bind(viewer.eventId)
      .first<{
        id: string;
        revision: number;
        decisionRole: "administrator" | "committee_chair";
      }>();
    if (existing && existing.revision !== parsed.revision)
      throw new EvaluationRevisionConflictError(
        "The evaluation plan changed after it was loaded.",
      );
    if (
      !("kind" in viewer) &&
      viewer.role === "committee_chair" &&
      parsed.decisionRole !== (existing?.decisionRole ?? "administrator")
    ) {
      throw new Response(
        "Only an owner or administrator can change final decision authority.",
        { status: 403 },
      );
    }
    if (existing) {
      const assignment = await this.env.DB.prepare(
        `
        SELECT a.id FROM evaluator_assignments a JOIN evaluation_rounds r ON r.id = a.round_id
         WHERE r.plan_id = ? LIMIT 1
      `,
      )
        .bind(existing.id)
        .first();
      if (assignment)
        throw new EvaluationStateError(
          "A plan with assignments cannot have its rounds or rubric replaced. Create the next round instead.",
        );
    }
    const planId = existing?.id ?? crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const planHasNoAssignments = `
      NOT EXISTS (
        SELECT 1
          FROM evaluator_assignments assignment
          JOIN evaluation_rounds assigned_round
            ON assigned_round.id = assignment.round_id
           AND assigned_round.event_id = assignment.event_id
         WHERE assigned_round.plan_id = ?
           AND assigned_round.event_id = ?
      )
    `;
    const commandStatements = this.commandClaimStatements(
      commandState.prepared,
    );
    const domainStatementIndex = commandStatements.length;
    const statements: D1PreparedStatement[] = [
      ...commandStatements,
      existing
        ? this.env.DB.prepare(
            `
            UPDATE events
               SET last_operation_id = ?, updated_at = unixepoch()
             WHERE id = ? AND organisation_id = ?
               AND EXISTS (
                 SELECT 1 FROM evaluation_plans plan
                  WHERE plan.id = ? AND plan.event_id = events.id
                    AND plan.revision = ? AND ${planHasNoAssignments}
               )
               ${commandGuard.sql}
          `,
          ).bind(
            operationId,
            viewer.eventId,
            viewer.organisationId,
            planId,
            parsed.revision,
            planId,
            viewer.eventId,
            ...commandGuard.bindings,
          )
        : this.env.DB.prepare(
            `
            UPDATE events
               SET last_operation_id = ?, updated_at = unixepoch()
             WHERE id = ? AND organisation_id = ?
               AND NOT EXISTS (
                 SELECT 1 FROM evaluation_plans plan
                  WHERE plan.event_id = events.id AND plan.status <> 'archived'
               )
               ${commandGuard.sql}
          `,
          ).bind(
            operationId,
            viewer.eventId,
            viewer.organisationId,
            ...commandGuard.bindings,
          ),
      ...(existing
        ? [
            this.env.DB.prepare(
              `
        UPDATE evaluation_plans SET name = ?, status = ?, blinded_reviewing = ?, decision_role = ?, revision = revision + 1,
               updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND revision = ?
           AND ${planHasNoAssignments}
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
            ).bind(
              parsed.name,
              parsed.status,
              blindedReviewing,
              parsed.decisionRole,
              planId,
              viewer.eventId,
              parsed.revision,
              planId,
              viewer.eventId,
              viewer.eventId,
              viewer.organisationId,
              operationId,
            ),
            this.env.DB.prepare(
              `
        DELETE FROM evaluation_rounds
         WHERE plan_id = ? AND event_id = ?
           AND ${planHasNoAssignments}
           AND EXISTS (
             SELECT 1 FROM evaluation_plans
              WHERE id = ? AND event_id = ? AND revision = ? AND name = ? AND status = ?
           )
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
            ).bind(
              planId,
              viewer.eventId,
              planId,
              viewer.eventId,
              planId,
              viewer.eventId,
              parsed.revision + 1,
              parsed.name,
              parsed.status,
              viewer.eventId,
              viewer.organisationId,
              operationId,
            ),
          ]
        : [
            this.env.DB.prepare(
              `
        INSERT INTO evaluation_plans (
          id, event_id, name, status, blinded_reviewing, decision_role, revision,
          created_by_person_id, created_at, updated_at
        ) SELECT ?, e.id, ?, ?, ?, ?, 1, ?, unixepoch(), unixepoch()
          FROM events e
         WHERE e.id = ? AND e.organisation_id = ? AND e.last_operation_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM evaluation_plans current_plan
              WHERE current_plan.event_id = e.id AND current_plan.status <> 'archived'
           )
      `,
            ).bind(
              planId,
              parsed.name,
              parsed.status,
              blindedReviewing,
              parsed.decisionRole,
              auditActor.personId,
              viewer.eventId,
              viewer.organisationId,
              operationId,
            ),
          ]),
    ];
    for (const [roundIndex, round] of parsed.rounds.entries()) {
      statements.push(
        this.env.DB.prepare(
          `
        INSERT INTO evaluation_rounds (
          id, event_id, plan_id, round_number, name, status, closes_at,
          advancement_rule_json, revision, created_at, updated_at
        )
        SELECT ?, p.event_id, p.id, ?, ?, ?, ?, '{}', 1, unixepoch(), unixepoch()
          FROM evaluation_plans p
         WHERE p.id = ? AND p.event_id = ? AND p.revision = ? AND p.name = ? AND p.status = ?
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
        ).bind(
          round.id,
          roundIndex + 1,
          round.name,
          parsed.status === "active" && roundIndex === 0 ? "active" : "draft",
          round.dueAt ? Math.floor(Date.parse(round.dueAt) / 1_000) : null,
          planId,
          viewer.eventId,
          parsed.revision + 1,
          parsed.name,
          parsed.status,
          viewer.eventId,
          viewer.organisationId,
          operationId,
        ),
      );
      for (const criterion of round.criteria) {
        statements.push(
          this.env.DB.prepare(
            `
          INSERT INTO evaluation_criteria (
            id, event_id, round_id, name, description, input_type, weight_percent, required, position
          )
          SELECT ?, r.event_id, r.id, ?, ?, ?, ?, ?, ?
            FROM evaluation_rounds r
            JOIN evaluation_plans p ON p.id = r.plan_id AND p.event_id = r.event_id
           WHERE r.id = ? AND r.event_id = ? AND p.id = ? AND p.revision = ? AND p.name = ? AND p.status = ?
             AND EXISTS (
               SELECT 1 FROM events
                WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
             )
        `,
          ).bind(
            criterion.id,
            criterion.name,
            criterion.description || null,
            criterion.inputType,
            criterion.weightPercent,
            criterion.required ? 1 : 0,
            criterion.position,
            round.id,
            viewer.eventId,
            planId,
            parsed.revision + 1,
            parsed.name,
            parsed.status,
            viewer.eventId,
            viewer.organisationId,
            operationId,
          ),
        );
      }
    }
    statements.push(
      this.env.DB.prepare(
        `
      INSERT INTO audit_events (
        id, organisation_id, event_id, actor_person_id, actor_id, action, entity_type, entity_id, metadata_json, created_at
      )
      SELECT ?, ?, ?, ?, ?, 'evaluation.plan.saved', 'evaluation_plan', ?, ?, unixepoch()
       WHERE EXISTS (
         SELECT 1 FROM evaluation_plans
          WHERE id = ? AND event_id = ? AND revision = ? AND name = ? AND status = ?
       )
       AND EXISTS (
         SELECT 1 FROM events
          WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
       )
    `,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        auditActor.personId,
        auditActor.actorId,
        planId,
        JSON.stringify({
          rounds: parsed.rounds.length,
          blindedReviewing: Boolean(blindedReviewing),
        }),
        planId,
        viewer.eventId,
        parsed.revision + 1,
        parsed.name,
        parsed.status,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
    );
    if (commandState.prepared) {
      statements.push(
        this.env.DB.prepare(
          `
          UPDATE idempotency_records
             SET status = 'completed', response_status = 200,
                 response_json = json_object('planId', ?),
                 entity_type = 'evaluation_plan', entity_id = ?,
                 completed_at = unixepoch()
           WHERE id = ? AND organisation_id = ? AND event_id = ?
             AND actor_id = ? AND scope = 'evaluation.plan.save'
             AND idempotency_key = ? AND request_hash = ?
             AND status = 'processing'
             AND EXISTS (
               SELECT 1 FROM evaluation_plans committed_plan
                WHERE committed_plan.id = ?
                  AND committed_plan.event_id = idempotency_records.event_id
                  AND committed_plan.revision = ?
             )
             AND EXISTS (
               SELECT 1 FROM events committed_event
                WHERE committed_event.id = idempotency_records.event_id
                  AND committed_event.organisation_id = idempotency_records.organisation_id
                  AND committed_event.last_operation_id = ?
             )
        `,
        ).bind(
          planId,
          planId,
          commandState.prepared.recordId,
          viewer.organisationId,
          viewer.eventId,
          commandState.prepared.actor.actorId,
          commandState.prepared.input.idempotencyKey,
          commandState.prepared.input.requestHash,
          planId,
          parsed.revision + 1,
          operationId,
        ),
      );
    }
    const results = await this.env.DB.batch(statements);
    const claimed = results[domainStatementIndex]!;
    if ((claimed.meta.changes ?? 0) !== 1) {
      const replay = await this.recoverApiCommand(commandState.prepared);
      if (replay) return replay.planId;
      if (existing) {
        const assignment = await this.env.DB.prepare(
          `
          SELECT a.id FROM evaluator_assignments a
          JOIN evaluation_rounds r
            ON r.id = a.round_id AND r.event_id = a.event_id
         WHERE r.plan_id = ? AND r.event_id = ? LIMIT 1
        `,
        )
          .bind(existing.id, viewer.eventId)
          .first();
        if (assignment) {
          throw new EvaluationStateError(
            "A plan with assignments cannot have its rounds or rubric replaced. Create the next round instead.",
          );
        }
      }
      throw new EvaluationRevisionConflictError(
        "The evaluation plan changed after it was loaded.",
      );
    }
    if (commandState.prepared) {
      const replay = await this.readApiCommand(commandState.prepared);
      if (!replay) {
        throw new Error(
          "The evaluation plan command did not commit an idempotency result.",
        );
      }
      return replay.planId;
    }
    return planId;
  }

  async saveTeam(viewer: Viewer, input: unknown) {
    return this.projectCommand(
      viewer,
      "evaluation.team.save",
      input,
      undefined,
      () => this.saveTeamD1(viewer, input),
    );
  }

  protected async saveTeamD1(viewer: Viewer, input: unknown) {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationManager(viewer);
    const parsed = evaluationTeamSchema.parse(input);
    if (parsed.chairPersonId) {
      const chair = await this.env.DB.prepare(
        `
        SELECT 1 FROM memberships
         WHERE event_id = ? AND person_id = ?
           AND role = 'committee_chair' AND accepted_at IS NOT NULL
           AND revoked_at IS NULL
      `,
      )
        .bind(viewer.eventId, parsed.chairPersonId)
        .first();
      if (!chair) {
        throw new EvaluationStateError(
          "The team chair must have an active committee-chair membership for this event.",
        );
      }
    }
    const duplicate = await this.env.DB.prepare(
      `
      SELECT id FROM evaluation_teams
       WHERE event_id = ? AND name = ? AND (? IS NULL OR id <> ?)
      `,
    )
      .bind(viewer.eventId, parsed.name, parsed.teamId, parsed.teamId)
      .first();
    if (duplicate) {
      throw new EvaluationStateError(
        "An evaluation team with that name already exists.",
      );
    }
    const teamId = parsed.teamId ?? crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const mutation = parsed.teamId
      ? this.env.DB.prepare(
          `
          UPDATE evaluation_teams
             SET name = ?, description = ?, chair_person_id = ?, status = ?,
                 updated_at = unixepoch()
           WHERE id = ? AND event_id = ?
             AND (
               ? IS NULL OR EXISTS (
                 SELECT 1 FROM memberships chair_membership
                  WHERE chair_membership.event_id = evaluation_teams.event_id
                    AND chair_membership.person_id = ?
                    AND chair_membership.role = 'committee_chair'
                    AND chair_membership.accepted_at IS NOT NULL
                    AND chair_membership.revoked_at IS NULL
               )
             )
        `,
        ).bind(
          parsed.name,
          parsed.description || null,
          parsed.chairPersonId,
          parsed.status,
          teamId,
          viewer.eventId,
          parsed.chairPersonId,
          parsed.chairPersonId,
        )
      : this.env.DB.prepare(
          `
          INSERT INTO evaluation_teams (
            id, event_id, name, description, chair_person_id, status,
            created_at, updated_at
          )
          SELECT ?, event.id, ?, ?, ?, ?, unixepoch(), unixepoch()
            FROM events event
           WHERE event.id = ? AND event.organisation_id = ?
             AND (
               ? IS NULL OR EXISTS (
                 SELECT 1 FROM memberships chair_membership
                  WHERE chair_membership.event_id = event.id
                    AND chair_membership.person_id = ?
                    AND chair_membership.role = 'committee_chair'
                    AND chair_membership.accepted_at IS NOT NULL
                    AND chair_membership.revoked_at IS NULL
               )
             )
        `,
        ).bind(
          teamId,
          parsed.name,
          parsed.description || null,
          parsed.chairPersonId,
          parsed.status,
          viewer.eventId,
          viewer.organisationId,
          parsed.chairPersonId,
          parsed.chairPersonId,
        );
    const statements = [mutation];
    statements.push(
      this.env.DB.prepare(
        `
        UPDATE evaluation_team_members SET role = 'evaluator'
         WHERE team_id = ? AND event_id = ? AND role = 'chair'
           AND removed_at IS NULL
           AND (? IS NULL OR person_id <> ?)
      `,
      ).bind(
        teamId,
        viewer.eventId,
        parsed.chairPersonId,
        parsed.chairPersonId,
      ),
    );
    if (parsed.chairPersonId) {
      statements.push(
        this.env.DB.prepare(
          `
          INSERT INTO evaluation_team_members (
            team_id, event_id, person_id, role, joined_at, removed_at
          ) VALUES (?, ?, ?, 'chair', unixepoch(), NULL)
          ON CONFLICT(team_id, person_id) DO UPDATE SET
            role = 'chair', joined_at = unixepoch(), removed_at = NULL
        `,
        ).bind(teamId, viewer.eventId, parsed.chairPersonId),
      );
    }
    statements.push(
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, ?, 'evaluation_team', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM evaluation_teams
            WHERE id = ? AND event_id = ? AND name = ? AND status = ?
         )
      `,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.teamId ? "evaluation.team.updated" : "evaluation.team.created",
        teamId,
        JSON.stringify({ status: parsed.status }),
        teamId,
        viewer.eventId,
        parsed.name,
        parsed.status,
      ),
    );
    const [changed] = await this.env.DB.batch(statements);
    if ((changed.meta.changes ?? 0) !== 1) {
      if (parsed.chairPersonId) {
        const chairStillAuthorised = await this.env.DB.prepare(
          `
          SELECT 1 FROM memberships
           WHERE event_id = ? AND person_id = ?
             AND role = 'committee_chair' AND accepted_at IS NOT NULL
             AND revoked_at IS NULL
        `,
        )
          .bind(viewer.eventId, parsed.chairPersonId)
          .first();
        if (!chairStillAuthorised) {
          throw new EvaluationStateError(
            "The selected team chair no longer has active committee-chair access.",
          );
        }
      }
      throw new EvaluationStateError(
        "The evaluation team was not found in this event.",
      );
    }
    return teamId;
  }

  async inviteEvaluationMember(viewer: Viewer, input: unknown) {
    return this.projectCommand(
      viewer,
      "evaluation.member.invite",
      input,
      undefined,
      () => this.inviteEvaluationMemberD1(viewer, input),
    );
  }

  protected async inviteEvaluationMemberD1(viewer: Viewer, input: unknown) {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationManager(viewer);
    const parsed = evaluationMemberInvitationSchema.parse(input);
    if (parsed.role === "committee_chair") {
      this.assertEvaluationAccessAdministrator(viewer);
    }
    const roleLabel =
      parsed.role === "committee_chair" ? "committee chair" : "evaluator";
    const proposedPersonId = crypto.randomUUID();
    await this.env.DB.prepare(
      `
      INSERT INTO people (
        id, email, display_name, email_verified, profile_status,
        created_at, updated_at
      ) VALUES (?, ?, ?, 0, 'draft', unixepoch(), unixepoch())
      ON CONFLICT(email) DO NOTHING
    `,
    )
      .bind(proposedPersonId, parsed.email, parsed.name)
      .run();
    const person = await this.env.DB.prepare(
      `
      SELECT p.id
        FROM people p
        JOIN events e ON e.id = ? AND e.organisation_id = ?
       WHERE p.email = ? COLLATE NOCASE
    `,
    )
      .bind(viewer.eventId, viewer.organisationId, parsed.email)
      .first<{ id: string }>();
    if (!person) {
      throw new EvaluationStateError(
        "The participant could not be added to the authorised event.",
      );
    }
    const existing = await this.env.DB.prepare(
      `
      SELECT id, accepted_at AS acceptedAt, revoked_at AS revokedAt
        FROM memberships
       WHERE organisation_id = ? AND event_id = ? AND person_id = ?
         AND role = ?
    `,
    )
      .bind(viewer.organisationId, viewer.eventId, person.id, parsed.role)
      .first<{
        id: string;
        acceptedAt: number | null;
        revokedAt: number | null;
      }>();
    if (existing?.acceptedAt && !existing.revokedAt) {
      throw new EvaluationStateError(
        `This person already has active ${roleLabel} access for the event.`,
      );
    }
    if (parsed.teamId) {
      const team = await this.env.DB.prepare(
        `
        SELECT id FROM evaluation_teams
         WHERE id = ? AND event_id = ? AND status = 'active'
      `,
      )
        .bind(parsed.teamId, viewer.eventId)
        .first();
      if (!team) {
        throw new EvaluationStateError(
          "The selected evaluation team is not active in this event.",
        );
      }
    }
    const membershipId = existing?.id ?? crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const membershipMutation = existing
      ? this.env.DB.prepare(
          `
          UPDATE memberships
             SET invited_at = unixepoch(),
                 invitation_expires_at = unixepoch() + 604800,
                 accepted_at = NULL, revoked_at = NULL
           WHERE id = ? AND organisation_id = ? AND event_id = ?
             AND person_id = ? AND role = ?
             AND (accepted_at IS NULL OR revoked_at IS NOT NULL)
             AND EXISTS (
               SELECT 1 FROM events
                WHERE id = ? AND organisation_id = ?
                  AND last_operation_id = ?
             )
        `,
        ).bind(
          membershipId,
          viewer.organisationId,
          viewer.eventId,
          person.id,
          parsed.role,
          viewer.eventId,
          viewer.organisationId,
          operationId,
        )
      : this.env.DB.prepare(
          `
          INSERT INTO memberships (
            id, organisation_id, event_id, person_id, role, invited_at,
            invitation_expires_at, accepted_at, created_at
          )
          SELECT ?, ?, ?, ?, ?, unixepoch(),
                 unixepoch() + 604800, NULL, unixepoch()
           WHERE EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ?
                AND last_operation_id = ?
           )
             AND NOT EXISTS (
               SELECT 1 FROM memberships
                WHERE organisation_id = ? AND event_id = ? AND person_id = ?
                  AND role = ?
             )
        `,
        ).bind(
          membershipId,
          viewer.organisationId,
          viewer.eventId,
          person.id,
          parsed.role,
          viewer.eventId,
          viewer.organisationId,
          operationId,
          viewer.organisationId,
          viewer.eventId,
          person.id,
          parsed.role,
        );
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `
        UPDATE events SET last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND organisation_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM memberships active_member
              WHERE active_member.organisation_id = events.organisation_id
                AND active_member.event_id = events.id
                AND active_member.person_id = ?
                AND active_member.role = ?
                AND active_member.accepted_at IS NOT NULL
                AND active_member.revoked_at IS NULL
           )
           AND (
             ? IS NULL OR EXISTS (
               SELECT 1 FROM evaluation_teams team
                WHERE team.id = ? AND team.event_id = events.id
                  AND team.status = 'active'
             )
           )
      `,
      ).bind(
        operationId,
        viewer.eventId,
        viewer.organisationId,
        person.id,
        parsed.role,
        parsed.teamId,
        parsed.teamId,
      ),
      membershipMutation,
    ];
    if (parsed.teamId) {
      statements.push(
        this.env.DB.prepare(
          `
          INSERT INTO evaluation_team_members (
            team_id, event_id, person_id, role, joined_at, removed_at
          )
          SELECT ?, ?, ?, 'evaluator', unixepoch(), NULL
           WHERE EXISTS (
             SELECT 1 FROM memberships invited_membership
              WHERE invited_membership.id = ?
                AND invited_membership.organisation_id = ?
                AND invited_membership.event_id = ?
                AND invited_membership.person_id = ?
                AND invited_membership.role = 'evaluator'
                AND invited_membership.invited_at IS NOT NULL
                AND invited_membership.revoked_at IS NULL
           )
          ON CONFLICT(team_id, person_id) DO UPDATE SET
            role = 'evaluator', joined_at = unixepoch(), removed_at = NULL
        `,
        ).bind(
          parsed.teamId,
          viewer.eventId,
          person.id,
          membershipId,
          viewer.organisationId,
          viewer.eventId,
          person.id,
        ),
      );
    }
    statements.push(
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, ?,
               'membership', invited_membership.id, ?, unixepoch()
          FROM memberships invited_membership
         WHERE invited_membership.id = ?
           AND invited_membership.organisation_id = ?
           AND invited_membership.event_id = ?
           AND invited_membership.person_id = ?
           AND invited_membership.role = ?
           AND invited_membership.accepted_at IS NULL
           AND invited_membership.revoked_at IS NULL
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ?
                AND last_operation_id = ?
           )
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        `membership.${parsed.role}.invited`,
        JSON.stringify({ email: parsed.email, teamId: parsed.teamId }),
        membershipId,
        viewer.organisationId,
        viewer.eventId,
        person.id,
        parsed.role,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
    );
    const results = await this.env.DB.batch(statements);
    if (
      (results[0]?.meta.changes ?? 0) !== 1 ||
      (results[1]?.meta.changes ?? 0) !== 1 ||
      (results.at(-1)?.meta.changes ?? 0) !== 1
    ) {
      throw new EvaluationRevisionConflictError(
        "Evaluation access or team membership changed before the invitation could be saved.",
      );
    }
    if (String(this.env.DEMO_MODE) === "true") {
      return { membershipId, delivery: "demo_not_sent" as const };
    }
    try {
      await createAuth(this.env).api.signInMagicLink({
        body: {
          email: parsed.email,
          callbackURL:
            parsed.role === "committee_chair"
              ? "/admin/review"
              : "/review/workbench",
        },
        headers: new Headers({ origin: this.env.BETTER_AUTH_URL }),
      });
    } catch (error) {
      throw new EvaluationInvitationDeliveryError(
        membershipId,
        roleLabel,
        error,
      );
    }
    return { membershipId, delivery: "sent" as const };
  }

  async changeCommitteeChairAccess(viewer: Viewer, input: unknown) {
    return this.projectCommand(
      viewer,
      "evaluation.committee_chair.access",
      input,
      undefined,
      () => this.changeCommitteeChairAccessD1(viewer, input),
    );
  }

  protected async changeCommitteeChairAccessD1(viewer: Viewer, input: unknown) {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationAccessAdministrator(viewer);
    const parsed = committeeChairAccessSchema.parse(input);
    const current = await this.env.DB.prepare(
      `
      SELECT id, accepted_at AS acceptedAt, revoked_at AS revokedAt
        FROM memberships
       WHERE organisation_id = ? AND event_id = ? AND person_id = ?
         AND role = 'committee_chair'
    `,
    )
      .bind(viewer.organisationId, viewer.eventId, parsed.personId)
      .first<{
        id: string;
        acceptedAt: number | null;
        revokedAt: number | null;
      }>();
    const active = Boolean(current?.acceptedAt && !current.revokedAt);
    if (parsed.operation === "promote") {
      if (active) {
        throw new EvaluationStateError(
          "This person already has active committee-chair access.",
        );
      }
      const evaluator = await this.env.DB.prepare(
        `
        SELECT 1 FROM memberships
         WHERE organisation_id = ? AND event_id = ? AND person_id = ?
           AND role = 'evaluator' AND accepted_at IS NOT NULL
           AND revoked_at IS NULL
      `,
      )
        .bind(viewer.organisationId, viewer.eventId, parsed.personId)
        .first();
      if (!evaluator) {
        throw new EvaluationStateError(
          "Only an active evaluator can be promoted directly. Invite a new committee chair instead.",
        );
      }
    } else if (!active || !current) {
      throw new EvaluationStateError(
        "Active committee-chair access was not found.",
      );
    }

    const membershipId = current?.id ?? crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const expectedAccessSql =
      parsed.operation === "promote"
        ? `NOT EXISTS (
             SELECT 1 FROM memberships active_chair
              WHERE active_chair.event_id = events.id
                AND active_chair.person_id = ?
                AND active_chair.role = 'committee_chair'
                AND active_chair.accepted_at IS NOT NULL
                AND active_chair.revoked_at IS NULL
           )
           AND EXISTS (
             SELECT 1 FROM memberships active_evaluator
              WHERE active_evaluator.event_id = events.id
                AND active_evaluator.person_id = ?
                AND active_evaluator.role = 'evaluator'
                AND active_evaluator.accepted_at IS NOT NULL
                AND active_evaluator.revoked_at IS NULL
           )`
        : `EXISTS (
             SELECT 1 FROM memberships active_chair
              WHERE active_chair.id = ?
                AND active_chair.event_id = events.id
                AND active_chair.person_id = ?
                AND active_chair.role = 'committee_chair'
                AND active_chair.accepted_at IS NOT NULL
                AND active_chair.revoked_at IS NULL
           )`;
    const expectedAccessBindings =
      parsed.operation === "promote"
        ? [parsed.personId, parsed.personId]
        : [membershipId, parsed.personId];
    const accessMutation =
      parsed.operation === "promote"
        ? current
          ? this.env.DB.prepare(
              `
              UPDATE memberships
                 SET invited_at = COALESCE(invited_at, unixepoch()),
                     invitation_expires_at = NULL, accepted_at = unixepoch(),
                     revoked_at = NULL
               WHERE id = ? AND organisation_id = ? AND event_id = ?
                 AND person_id = ? AND role = 'committee_chair'
                 AND EXISTS (
                   SELECT 1 FROM events
                    WHERE id = ? AND organisation_id = ?
                      AND last_operation_id = ?
                 )
            `,
            ).bind(
              membershipId,
              viewer.organisationId,
              viewer.eventId,
              parsed.personId,
              viewer.eventId,
              viewer.organisationId,
              operationId,
            )
          : this.env.DB.prepare(
              `
              INSERT INTO memberships (
                id, organisation_id, event_id, person_id, role, invited_at,
                invitation_expires_at, accepted_at, created_at
              )
              SELECT ?, ?, ?, ?, 'committee_chair', unixepoch(), NULL,
                     unixepoch(), unixepoch()
               WHERE EXISTS (
                 SELECT 1 FROM events
                  WHERE id = ? AND organisation_id = ?
                    AND last_operation_id = ?
               )
            `,
            ).bind(
              membershipId,
              viewer.organisationId,
              viewer.eventId,
              parsed.personId,
              viewer.eventId,
              viewer.organisationId,
              operationId,
            )
        : this.env.DB.prepare(
            `
            UPDATE memberships SET revoked_at = unixepoch()
             WHERE id = ? AND organisation_id = ? AND event_id = ?
               AND person_id = ? AND role = 'committee_chair'
               AND accepted_at IS NOT NULL AND revoked_at IS NULL
               AND EXISTS (
                 SELECT 1 FROM events
                  WHERE id = ? AND organisation_id = ?
                    AND last_operation_id = ?
               )
          `,
          ).bind(
            membershipId,
            viewer.organisationId,
            viewer.eventId,
            parsed.personId,
            viewer.eventId,
            viewer.organisationId,
            operationId,
          );
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `
        UPDATE events SET last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND organisation_id = ? AND ${expectedAccessSql}
      `,
      ).bind(
        operationId,
        viewer.eventId,
        viewer.organisationId,
        ...expectedAccessBindings,
      ),
      accessMutation,
    ];
    if (parsed.operation === "revoke") {
      statements.push(
        this.env.DB.prepare(
          `
          UPDATE evaluation_teams
             SET chair_person_id = NULL, updated_at = unixepoch()
           WHERE event_id = ? AND chair_person_id = ?
             AND EXISTS (
               SELECT 1 FROM events
                WHERE id = ? AND organisation_id = ?
                  AND last_operation_id = ?
             )
        `,
        ).bind(
          viewer.eventId,
          parsed.personId,
          viewer.eventId,
          viewer.organisationId,
          operationId,
        ),
        this.env.DB.prepare(
          `
          UPDATE evaluation_team_members SET role = 'evaluator'
           WHERE event_id = ? AND person_id = ? AND removed_at IS NULL
             AND role = 'chair'
             AND EXISTS (
               SELECT 1 FROM events
                WHERE id = ? AND organisation_id = ?
                  AND last_operation_id = ?
             )
        `,
        ).bind(
          viewer.eventId,
          parsed.personId,
          viewer.eventId,
          viewer.organisationId,
          operationId,
        ),
      );
    }
    statements.push(
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, ?, 'membership', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM events
            WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
         )
           AND EXISTS (
             SELECT 1 FROM memberships membership
              WHERE membership.id = ? AND membership.event_id = ?
                AND membership.person_id = ?
                AND membership.role = 'committee_chair'
                AND (
                  (? = 'promote' AND membership.accepted_at IS NOT NULL
                    AND membership.revoked_at IS NULL)
                  OR
                  (? = 'revoke' AND membership.revoked_at IS NOT NULL)
                )
           )
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        `membership.committee_chair.${
          parsed.operation === "promote" ? "promoted" : "revoked"
        }`,
        membershipId,
        JSON.stringify({ personId: parsed.personId }),
        viewer.eventId,
        viewer.organisationId,
        operationId,
        membershipId,
        viewer.eventId,
        parsed.personId,
        parsed.operation,
        parsed.operation,
      ),
    );
    const results = await this.env.DB.batch(statements);
    if (
      (results[0]?.meta.changes ?? 0) !== 1 ||
      (results[1]?.meta.changes ?? 0) !== 1 ||
      (results.at(-1)?.meta.changes ?? 0) !== 1
    ) {
      throw new EvaluationRevisionConflictError(
        "Committee-chair access changed before this operation could be committed.",
      );
    }
    return { membershipId, operation: parsed.operation };
  }

  async changeTeamMember(viewer: Viewer, input: unknown) {
    return this.projectCommand(
      viewer,
      "evaluation.team_member.change",
      input,
      undefined,
      () => this.changeTeamMemberD1(viewer, input),
    );
  }

  protected async changeTeamMemberD1(viewer: Viewer, input: unknown) {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationManager(viewer);
    const parsed = evaluationTeamMemberSchema.parse(input);
    const authorisedPerson =
      parsed.operation === "add"
        ? await this.env.DB.prepare(
            `
            SELECT 1 FROM memberships m
            JOIN evaluation_teams t ON t.event_id = m.event_id
             WHERE t.id = ? AND t.event_id = ? AND t.status = 'active'
               AND m.person_id = ? AND m.accepted_at IS NOT NULL
               AND m.revoked_at IS NULL
               AND m.role IN ('evaluator','committee_chair')
          `,
          )
            .bind(parsed.teamId, viewer.eventId, parsed.personId)
            .first()
        : await this.env.DB.prepare(
            `
            SELECT 1 FROM evaluation_team_members tm
            JOIN evaluation_teams t
              ON t.id = tm.team_id AND t.event_id = tm.event_id
             WHERE tm.team_id = ? AND tm.event_id = ? AND tm.person_id = ?
               AND tm.removed_at IS NULL AND t.status = 'active'
          `,
          )
            .bind(parsed.teamId, viewer.eventId, parsed.personId)
            .first();
    if (!authorisedPerson) {
      throw new EvaluationStateError(
        "The person or active team was not found in this event.",
      );
    }
    if (parsed.operation === "add" && parsed.role === "chair") {
      const membership = await this.env.DB.prepare(
        `
        SELECT 1 FROM memberships
         WHERE event_id = ? AND person_id = ? AND role = 'committee_chair'
           AND accepted_at IS NOT NULL AND revoked_at IS NULL
      `,
      )
        .bind(viewer.eventId, parsed.personId)
        .first();
      if (!membership) {
        throw new EvaluationStateError(
          "Only an active committee chair can be the chair of an evaluation team.",
        );
      }
    }
    const operationId = crypto.randomUUID();
    const mutation =
      parsed.operation === "add"
        ? this.env.DB.prepare(
            `
            INSERT INTO evaluation_team_members (
              team_id, event_id, person_id, role, joined_at, removed_at
            )
            SELECT t.id, t.event_id, ?, ?, unixepoch(), NULL
              FROM evaluation_teams t
             WHERE t.id = ? AND t.event_id = ? AND t.status = 'active'
               AND EXISTS (
                 SELECT 1 FROM memberships m
                  WHERE m.event_id = t.event_id AND m.person_id = ?
                    AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL
                    AND m.role ${
                      parsed.role === "chair"
                        ? "= 'committee_chair'"
                        : "IN ('evaluator','committee_chair')"
                    }
               )
            ON CONFLICT(team_id, person_id) DO UPDATE SET
              role = excluded.role, joined_at = unixepoch(), removed_at = NULL
          `,
          ).bind(
            parsed.personId,
            parsed.role,
            parsed.teamId,
            viewer.eventId,
            parsed.personId,
          )
        : this.env.DB.prepare(
            `
            UPDATE evaluation_team_members SET removed_at = unixepoch()
             WHERE team_id = ? AND event_id = ? AND person_id = ?
               AND removed_at IS NULL
               AND EXISTS (
                 SELECT 1 FROM evaluation_teams t
                  WHERE t.id = evaluation_team_members.team_id
                    AND t.event_id = evaluation_team_members.event_id
                    AND t.status = 'active'
               )
          `,
          ).bind(parsed.teamId, viewer.eventId, parsed.personId);
    const statements: D1PreparedStatement[] = [mutation];
    if (parsed.operation === "add" && parsed.role === "chair") {
      statements.push(
        this.env.DB.prepare(
          `
          UPDATE evaluation_team_members SET role = 'evaluator'
           WHERE team_id = ? AND event_id = ? AND person_id <> ?
             AND role = 'chair' AND removed_at IS NULL
        `,
        ).bind(parsed.teamId, viewer.eventId, parsed.personId),
        this.env.DB.prepare(
          `
          UPDATE evaluation_teams SET chair_person_id = ?, updated_at = unixepoch()
           WHERE id = ? AND event_id = ? AND status = 'active'
             AND EXISTS (
               SELECT 1 FROM evaluation_team_members tm
                WHERE tm.team_id = evaluation_teams.id
                  AND tm.event_id = evaluation_teams.event_id
                  AND tm.person_id = ? AND tm.role = 'chair'
                  AND tm.removed_at IS NULL
             )
        `,
        ).bind(parsed.personId, parsed.teamId, viewer.eventId, parsed.personId),
      );
    } else if (parsed.operation === "add") {
      statements.push(
        this.env.DB.prepare(
          `
          UPDATE evaluation_teams SET chair_person_id = NULL,
                 updated_at = unixepoch()
           WHERE id = ? AND event_id = ? AND chair_person_id = ?
             AND EXISTS (
               SELECT 1 FROM evaluation_team_members tm
                WHERE tm.team_id = evaluation_teams.id
                  AND tm.event_id = evaluation_teams.event_id
                  AND tm.person_id = ? AND tm.role = 'evaluator'
                  AND tm.removed_at IS NULL
             )
        `,
        ).bind(parsed.teamId, viewer.eventId, parsed.personId, parsed.personId),
      );
    } else if (parsed.operation === "remove") {
      statements.push(
        this.env.DB.prepare(
          `
          UPDATE evaluation_teams SET chair_person_id = NULL,
                 updated_at = unixepoch()
           WHERE id = ? AND event_id = ? AND chair_person_id = ?
        `,
        ).bind(parsed.teamId, viewer.eventId, parsed.personId),
      );
    }
    statements.push(
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, ?, 'evaluation_team', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM evaluation_teams
            WHERE id = ? AND event_id = ? AND status = 'active'
         )
           AND (
             (? = 'add' AND EXISTS (
               SELECT 1 FROM evaluation_team_members
                WHERE team_id = ? AND event_id = ? AND person_id = ?
                  AND role = ? AND removed_at IS NULL
             ))
             OR
             (? = 'remove' AND NOT EXISTS (
               SELECT 1 FROM evaluation_team_members
                WHERE team_id = ? AND event_id = ? AND person_id = ?
                  AND removed_at IS NULL
             ))
           )
      `,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.operation === "add"
          ? "evaluation.team.member.added"
          : "evaluation.team.member.removed",
        parsed.teamId,
        JSON.stringify({
          personId: parsed.personId,
          role: parsed.role,
        }),
        parsed.teamId,
        viewer.eventId,
        parsed.operation,
        parsed.teamId,
        viewer.eventId,
        parsed.personId,
        parsed.role,
        parsed.operation,
        parsed.teamId,
        viewer.eventId,
        parsed.personId,
      ),
    );
    const results = await this.env.DB.batch(statements);
    const changed = results[0];
    const audited = results.at(-1);
    if (
      (changed?.meta.changes ?? 0) !== 1 ||
      (audited?.meta.changes ?? 0) !== 1
    ) {
      throw new EvaluationStateError(
        parsed.operation === "remove"
          ? "The person is not an active member of this team."
          : "The team member could not be saved.",
      );
    }
  }
}
