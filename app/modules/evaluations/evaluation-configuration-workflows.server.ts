import type { Viewer } from "~/platform/auth/authorize.server";
import {
  EvaluationRevisionConflictError,
  EvaluationStateError,
} from "./evaluation-errors";
import {
  evaluationRoundReviewerSchema,
  evaluationTeamMemberSchema,
  evaluationTeamSchema,
} from "./evaluation-schema";
import {
  roundReviewerCommandResultSchema,
  EvaluationServiceFoundation,
  type EvaluationAdminActor,
  type EvaluationApiCommand,
  type EvaluationRoundReviewerResult,
} from "./evaluation-service-foundation.server";

export class EvaluationConfigurationWorkflows extends EvaluationServiceFoundation {
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
    const audited = results.at(-1)!;
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

  async changeRoundReviewerPool(
    viewer: EvaluationAdminActor,
    input: unknown,
    command?: EvaluationApiCommand,
  ) {
    return this.projectCommand(
      viewer,
      "evaluation.round_reviewer.change",
      input,
      command,
      () => this.changeRoundReviewerPoolD1(viewer, input, command),
    );
  }

  protected async changeRoundReviewerPoolD1(
    viewer: EvaluationAdminActor,
    input: unknown,
    command?: EvaluationApiCommand,
  ): Promise<EvaluationRoundReviewerResult> {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationManager(viewer);
    const commandState = await this.prepareApiCommand(
      viewer,
      "evaluation.round_reviewer.change",
      command,
      roundReviewerCommandResultSchema,
    );
    if (commandState.replay) return commandState.replay;
    const commandGuard = this.commandGuard(commandState.prepared);
    const parsed = evaluationRoundReviewerSchema.parse(input);
    const membership =
      parsed.operation === "add"
        ? await this.env.DB.prepare(
            `
            SELECT 1
              FROM memberships m
              JOIN events e
                ON e.id = m.event_id AND e.organisation_id = ?
             WHERE m.event_id = ? AND m.person_id = ?
               AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL
               AND m.role IN ('evaluator','committee_chair')
          `,
          )
            .bind(viewer.organisationId, viewer.eventId, parsed.personId)
            .first()
        : await this.env.DB.prepare(
            `
            SELECT 1
              FROM evaluation_round_reviewers pool
              JOIN evaluation_rounds round
                ON round.id = pool.round_id AND round.event_id = pool.event_id
              JOIN evaluation_plans plan
                ON plan.id = round.plan_id AND plan.event_id = round.event_id
              JOIN events e
                ON e.id = pool.event_id AND e.organisation_id = ?
             WHERE pool.event_id = ? AND pool.round_id = ? AND pool.person_id = ?
               AND round.status <> 'archived' AND plan.status <> 'archived'
          `,
          )
            .bind(
              viewer.organisationId,
              viewer.eventId,
              parsed.roundId,
              parsed.personId,
            )
            .first();
    if (!membership) {
      throw new EvaluationStateError(
        parsed.operation === "add"
          ? "Only an active evaluator or committee chair in this event can join a round pool."
          : "The evaluator is not in this round pool.",
      );
    }
    const operationId = crypto.randomUUID();
    const mutations =
      parsed.operation === "add"
        ? [
            this.env.DB.prepare(
              `
            INSERT INTO evaluation_round_reviewers (
              id, event_id, round_id, person_id, added_by_person_id,
              revision, created_at, updated_at
            )
            SELECT ?, r.event_id, r.id, ?, ?, 1, unixepoch(), unixepoch()
              FROM evaluation_rounds r
              JOIN evaluation_plans plan
                ON plan.id = r.plan_id AND plan.event_id = r.event_id
              JOIN events e ON e.id = r.event_id AND e.organisation_id = ?
              JOIN memberships m
                ON m.event_id = r.event_id
               AND m.person_id = ?
               AND m.accepted_at IS NOT NULL
               AND m.revoked_at IS NULL
               AND m.role IN ('evaluator','committee_chair')
             WHERE r.id = ? AND r.event_id = ?
               AND r.status IN ('draft','active','closed')
               AND plan.status <> 'archived'
               ${commandGuard.sql}
            ON CONFLICT(round_id, person_id) DO UPDATE SET
              revision = evaluation_round_reviewers.revision + 1,
              updated_at = unixepoch(), added_by_person_id = excluded.added_by_person_id
          `,
            ).bind(
              crypto.randomUUID(),
              parsed.personId,
              viewer.personId,
              viewer.organisationId,
              parsed.personId,
              parsed.roundId,
              viewer.eventId,
              ...commandGuard.bindings,
            ),
          ]
        : [
            this.env.DB.prepare(
              `
            UPDATE evaluator_assignments
               SET status = 'cancelled', revision = revision + 1,
                   last_operation_id = ?, cancellation_reason = 'reviewer_removed'
             WHERE event_id = ? AND round_id = ? AND evaluator_person_id = ?
               AND status IN ('assigned','in_progress','reopened')
               AND EXISTS (
                 SELECT 1 FROM evaluation_rounds r
                 JOIN evaluation_plans plan
                   ON plan.id = r.plan_id AND plan.event_id = r.event_id
                 JOIN events e
                   ON e.id = r.event_id AND e.organisation_id = ?
                WHERE r.id = evaluator_assignments.round_id
                  AND r.event_id = evaluator_assignments.event_id
                  AND r.status <> 'archived'
                  AND plan.status <> 'archived'
               )
               ${commandGuard.sql}
          `,
            ).bind(
              operationId,
              viewer.eventId,
              parsed.roundId,
              parsed.personId,
              viewer.organisationId,
              ...commandGuard.bindings,
            ),
            this.env.DB.prepare(
              `
            DELETE FROM evaluation_round_reviewers
             WHERE event_id = ? AND round_id = ? AND person_id = ?
               AND EXISTS (
                 SELECT 1 FROM evaluation_rounds r
                 JOIN evaluation_plans plan
                   ON plan.id = r.plan_id AND plan.event_id = r.event_id
                 JOIN events e
                   ON e.id = r.event_id AND e.organisation_id = ?
                  WHERE r.id = evaluation_round_reviewers.round_id
                    AND r.event_id = evaluation_round_reviewers.event_id
                    AND r.status <> 'archived'
                    AND plan.status <> 'archived'
               )
               ${commandGuard.sql}
          `,
            ).bind(
              viewer.eventId,
              parsed.roundId,
              parsed.personId,
              viewer.organisationId,
              ...commandGuard.bindings,
            ),
          ];
    const audit = this.env.DB.prepare(
      `
      INSERT INTO audit_events (
        id, organisation_id, event_id, actor_person_id, action,
        entity_type, entity_id, metadata_json, created_at
      )
      SELECT ?, ?, ?, ?, ?, 'evaluation_round', ?,
              json_object(
                'personId', ?,
                'cancelledAssignmentCount', (
                  SELECT COUNT(*) FROM evaluator_assignments assignment
                   WHERE assignment.event_id = ?
                     AND assignment.round_id = ?
                     AND assignment.evaluator_person_id = ?
                     AND assignment.last_operation_id = ?
                     AND assignment.status = 'cancelled'
                )
              ), unixepoch()
       WHERE EXISTS (
         SELECT 1 FROM evaluation_rounds r
         JOIN evaluation_plans plan
           ON plan.id = r.plan_id AND plan.event_id = r.event_id
         JOIN events e ON e.id = r.event_id AND e.organisation_id = ?
        WHERE r.id = ? AND r.event_id = ?
          AND r.status <> 'archived' AND plan.status <> 'archived'
       )
       ${commandGuard.sql}
    `,
    ).bind(
      operationId,
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      parsed.operation === "add"
        ? "evaluation.round.reviewer.added"
        : "evaluation.round.reviewer.removed",
      parsed.roundId,
      parsed.personId,
      viewer.eventId,
      parsed.roundId,
      parsed.personId,
      operationId,
      viewer.organisationId,
      parsed.roundId,
      viewer.eventId,
      ...commandGuard.bindings,
    );
    const commandStatements = this.commandClaimStatements(
      commandState.prepared,
    );
    const domainStatementIndex = commandStatements.length;
    const auditIndex = domainStatementIndex + mutations.length;
    const statements: D1PreparedStatement[] = [
      ...commandStatements,
      ...mutations,
      audit,
    ];
    if (commandState.prepared) {
      statements.push(
        this.env.DB.prepare(
          `
          UPDATE idempotency_records
             SET status = 'completed', response_status = 200,
                 response_json = json_object(
                   'roundId', ?,
                   'personId', ?,
                   'operation', ?,
                   'cancelledAssignmentCount', CASE WHEN ? = 'remove' THEN (
                     SELECT COUNT(*) FROM evaluator_assignments assignment
                      WHERE assignment.event_id = ?
                        AND assignment.round_id = ?
                        AND assignment.evaluator_person_id = ?
                        AND assignment.last_operation_id = ?
                        AND assignment.status = 'cancelled'
                   ) ELSE 0 END
                 ),
                 entity_type = 'evaluation_round_reviewer', entity_id = ?,
                 completed_at = unixepoch()
           WHERE id = ? AND organisation_id = ? AND event_id = ?
             AND actor_id = ? AND scope = 'evaluation.round_reviewer.change'
             AND idempotency_key = ? AND request_hash = ?
             AND status = 'processing'
             AND EXISTS (
               SELECT 1 FROM audit_events committed_audit
                WHERE committed_audit.id = ?
                  AND committed_audit.organisation_id = idempotency_records.organisation_id
                  AND committed_audit.event_id = idempotency_records.event_id
                  AND committed_audit.action = ?
             )
        `,
        ).bind(
          parsed.roundId,
          parsed.personId,
          parsed.operation,
          parsed.operation,
          viewer.eventId,
          parsed.roundId,
          parsed.personId,
          operationId,
          parsed.roundId,
          commandState.prepared.recordId,
          viewer.organisationId,
          viewer.eventId,
          commandState.prepared.actor.actorId,
          commandState.prepared.input.idempotencyKey,
          commandState.prepared.input.requestHash,
          operationId,
          parsed.operation === "add"
            ? "evaluation.round.reviewer.added"
            : "evaluation.round.reviewer.removed",
        ),
      );
    }
    const results = await this.env.DB.batch(statements);
    const changed =
      results[domainStatementIndex + (parsed.operation === "add" ? 0 : 1)];
    const audited = results[auditIndex];
    const commandCompleted = commandState.prepared
      ? (results.at(-1)?.meta.changes ?? 0) === 1
      : true;
    if (
      (changed?.meta.changes ?? 0) !== 1 ||
      (audited?.meta.changes ?? 0) !== 1 ||
      !commandCompleted
    ) {
      const replay = await this.recoverApiCommand(commandState.prepared);
      if (replay) return replay;
      throw new EvaluationRevisionConflictError(
        "The round reviewer pool changed before it could be saved. Refresh and try again.",
      );
    }
    const result: EvaluationRoundReviewerResult = {
      roundId: parsed.roundId,
      personId: parsed.personId,
      operation: parsed.operation,
      cancelledAssignmentCount:
        parsed.operation === "remove"
          ? (results[domainStatementIndex]?.meta.changes ?? 0)
          : 0,
    };
    if (commandState.prepared) {
      const replay = await this.readApiCommand(commandState.prepared);
      if (!replay) {
        throw new Error(
          "The evaluation reviewer-pool command did not commit an idempotency result.",
        );
      }
      return replay;
    }
    return result;
  }
}
