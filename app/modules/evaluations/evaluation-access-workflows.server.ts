import { createAuth } from "~/platform/auth/auth.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  EvaluationInvitationDeliveryError,
  EvaluationRevisionConflictError,
  EvaluationStateError,
} from "./evaluation-errors";
import { EvaluationPlanWorkflows } from "./evaluation-plan-workflows.server";
import {
  committeeChairAccessSchema,
  evaluationMemberInvitationSchema,
} from "./evaluation-schema";

export abstract class EvaluationAccessWorkflows extends EvaluationPlanWorkflows {
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
}
