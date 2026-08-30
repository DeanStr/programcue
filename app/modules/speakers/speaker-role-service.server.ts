import { z } from "zod";

import {
  type AirtableProviderBoundary,
  airtableCommandKey,
} from "~/modules/airtable/airtable-provider-boundary.server";
import {
  materializePublishedConfirmedSpeakerAcknowledgements,
  materializePublishedResourceAcknowledgementsForParticipationReset,
  materializePublishedResourceAcknowledgementsForRoleAssignment,
} from "~/modules/resources/resource-service-shared";
import type { Viewer } from "~/platform/auth/authorize.server";
import { SpeakerAdminStateError } from "./speaker-service-errors";

export const participantRoleSchema = z.enum(["speaker", "moderator", "chair"]);
export type ParticipantRole = z.infer<typeof participantRoleSchema>;

const roleLabels: Record<ParticipantRole, string> = {
  speaker: "Speaker",
  moderator: "Moderator",
  chair: "Chair",
};

const roleResponseSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(200),
    role: participantRoleSchema,
    roleRevision: z.coerce.number().int().positive(),
    response: z.enum(["confirmed", "declined"]),
    reason: z
      .string()
      .trim()
      .max(500, "A decline reason must be 500 characters or fewer.")
      .transform((value) => value || null),
  })
  .strict();

const externalRoleResponseSchema = roleResponseSchema.extend({
  externalConfirmation: z.literal("confirmed"),
});

const resetRoleSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(200),
    role: participantRoleSchema,
    roleRevision: z.coerce.number().int().positive(),
    resetConfirmation: z.literal("pending"),
  })
  .strict();

const addRoleSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(200),
    role: participantRoleSchema,
    confirmation: z.literal("add"),
  })
  .strict();

type RoleTarget = {
  title: string;
  sessionStatus: string;
  relationshipRevision: number;
  relationshipStatus: "pending" | "confirmed" | "declined";
  roleStatus: "pending" | "confirmed" | "declined";
  roleRevision: number;
  roleLabel: string;
  roleDeclineReason: string | null;
};

function aggregateStatus(
  statuses: Array<"pending" | "confirmed" | "declined">,
) {
  if (statuses.includes("confirmed")) return "confirmed" as const;
  if (statuses.includes("pending")) return "pending" as const;
  return "declined" as const;
}

export class SpeakerRoleService {
  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly airtable: AirtableProviderBoundary,
  ) {}

  async addRole(viewer: Viewer, rawPersonId: string, rawInput: unknown) {
    this.assertAdministrator(viewer);
    const personId = z.string().trim().min(1).max(200).parse(rawPersonId);
    const input = addRoleSchema.parse(rawInput);
    const idempotencyKey = await airtableCommandKey(
      "speaker.role.add",
      viewer,
      { personId, ...input },
    );
    return this.executeRoleIdempotent(
      viewer,
      { idempotencyKey, operation: "speaker.role.add" },
      () => this.addRoleD1(viewer, personId, input),
      () => this.requireAssignedRoleReplay(viewer, personId, input),
    );
  }

  private async addRoleD1(
    viewer: Viewer,
    personId: string,
    input: z.infer<typeof addRoleSchema>,
  ) {
    const replay = await this.replayAssignedRole(viewer, personId, input);
    if (replay) return replay;
    const auditId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const result = await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO session_participant_roles (
           event_id, session_id, person_id, role, label, position,
           participation_status, participation_revision, created_at, updated_at
         )
         SELECT relationship.event_id, relationship.session_id,
                relationship.person_id, ?, ?,
                COALESCE((SELECT MAX(existing.position) + 1
                            FROM session_participant_roles existing
                           WHERE existing.session_id = relationship.session_id
                             AND existing.person_id = relationship.person_id), 0),
                'pending', 1, unixepoch(), unixepoch()
           FROM session_speakers relationship
           JOIN sessions session
             ON session.id = relationship.session_id
            AND session.event_id = relationship.event_id
           JOIN events event ON event.id = relationship.event_id
          WHERE relationship.event_id = ? AND relationship.session_id = ?
            AND relationship.person_id = ? AND event.organisation_id = ?
            AND session.status NOT IN ('cancelled','archived')
            AND NOT EXISTS (
              SELECT 1 FROM session_participant_roles existing
               WHERE existing.session_id = relationship.session_id
                 AND existing.person_id = relationship.person_id
                 AND existing.role = ?
            )`,
      ).bind(
        input.role,
        roleLabels[input.role],
        viewer.eventId,
        input.sessionId,
        personId,
        viewer.organisationId,
        input.role,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id,
           actor_person_id, action, entity_type, entity_id, correlation_id,
           metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?,
                'speaker.role.assigned', 'session_participant_role', ?, ?, ?,
                unixepoch()
          WHERE changes() = 1`,
      ).bind(
        auditId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        `${input.sessionId}:${personId}:${input.role}`,
        correlationId,
        JSON.stringify({
          sessionId: input.sessionId,
          personId,
          role: input.role,
          label: roleLabels[input.role],
        }),
      ),
      this.env.DB.prepare(
        `UPDATE session_speakers
            SET participation_status = CASE
                  WHEN EXISTS (
                    SELECT 1 FROM session_participant_roles current_role
                     WHERE current_role.event_id = session_speakers.event_id
                       AND current_role.session_id = session_speakers.session_id
                       AND current_role.person_id = session_speakers.person_id
                       AND current_role.participation_status = 'confirmed'
                  ) THEN 'confirmed'
                  WHEN EXISTS (
                    SELECT 1 FROM session_participant_roles current_role
                     WHERE current_role.event_id = session_speakers.event_id
                       AND current_role.session_id = session_speakers.session_id
                       AND current_role.person_id = session_speakers.person_id
                       AND current_role.participation_status = 'pending'
                  ) THEN 'pending'
                  ELSE 'declined'
                END,
                participation_revision = participation_revision + 1,
                participation_confirmed_at = CASE
                  WHEN EXISTS (
                    SELECT 1 FROM session_participant_roles current_role
                     WHERE current_role.event_id = session_speakers.event_id
                       AND current_role.session_id = session_speakers.session_id
                       AND current_role.person_id = session_speakers.person_id
                       AND current_role.participation_status = 'confirmed'
                  ) THEN COALESCE(participation_confirmed_at, unixepoch())
                  ELSE NULL END,
                participation_declined_at = CASE
                  WHEN NOT EXISTS (
                    SELECT 1 FROM session_participant_roles current_role
                     WHERE current_role.event_id = session_speakers.event_id
                       AND current_role.session_id = session_speakers.session_id
                       AND current_role.person_id = session_speakers.person_id
                       AND current_role.participation_status IN ('confirmed','pending')
                  ) THEN COALESCE(participation_declined_at, unixepoch())
                  ELSE NULL END,
                participation_decline_reason = NULL
          WHERE event_id = ? AND session_id = ? AND person_id = ?
            AND EXISTS (
              SELECT 1 FROM audit_events audit
               WHERE audit.id = ? AND audit.action = 'speaker.role.assigned'
                 AND audit.event_id = session_speakers.event_id
            )
            AND EXISTS (
              SELECT 1 FROM session_participant_roles assigned_role
               WHERE assigned_role.event_id = session_speakers.event_id
                 AND assigned_role.session_id = session_speakers.session_id
                 AND assigned_role.person_id = session_speakers.person_id
                 AND assigned_role.role = ?
                 AND assigned_role.participation_status = 'pending'
                 AND assigned_role.participation_revision = 1
            )`,
      ).bind(viewer.eventId, input.sessionId, personId, auditId, input.role),
      ...materializePublishedResourceAcknowledgementsForRoleAssignment(
        this.env,
        viewer.eventId,
        input.sessionId,
        personId,
        input.role,
        auditId,
      ),
      this.env.DB.prepare(
        `INSERT INTO event_changes (
           event_id, entity_type, entity_id, change_type, correlation_id,
           created_at
         )
          SELECT ?, 'person', ?, 'updated', ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM audit_events audit
             WHERE audit.id = ? AND audit.action = 'speaker.role.assigned'
               AND audit.event_id = ?
          )
         RETURNING sequence`,
      ).bind(viewer.eventId, personId, correlationId, auditId, viewer.eventId),
    ]);
    if (
      (result[0]?.meta.changes ?? 0) !== 1 ||
      (result[1]?.meta.changes ?? 0) !== 1 ||
      (result[2]?.meta.changes ?? 0) !== 1 ||
      (result.at(-1)?.meta.changes ?? 0) !== 1
    ) {
      const committed = await this.replayAssignedRole(viewer, personId, input);
      if (committed) return committed;
      throw new SpeakerAdminStateError(
        "That role is already assigned or the active session relationship is unavailable.",
        409,
      );
    }
    const changeResult = result.at(-1) as D1Result<{ sequence: number }>;
    return {
      sessionId: input.sessionId,
      personId,
      role: input.role,
      label: roleLabels[input.role],
      changeSequence: Number(changeResult.results?.[0]?.sequence ?? 0),
      changed: true,
    };
  }

  async respondOwnRole(viewer: Viewer, rawInput: unknown) {
    const input = roleResponseSchema.parse(rawInput);
    return this.runTransitionIdempotent(
      viewer,
      viewer.personId,
      input,
      input.response,
      input.response === "declined" ? input.reason : null,
      "speaker",
      "speaker.role.respond",
    );
  }

  async respondExternalRole(
    viewer: Viewer,
    rawPersonId: string,
    rawInput: unknown,
  ) {
    this.assertAdministrator(viewer);
    const personId = z.string().trim().min(1).max(200).parse(rawPersonId);
    const input = externalRoleResponseSchema.parse(rawInput);
    return this.runTransitionIdempotent(
      viewer,
      personId,
      input,
      input.response,
      input.response === "declined" ? input.reason : null,
      "administrator_external",
      "speaker.role.respond_external",
    );
  }

  async resetRole(viewer: Viewer, rawPersonId: string, rawInput: unknown) {
    this.assertAdministrator(viewer);
    const personId = z.string().trim().min(1).max(200).parse(rawPersonId);
    const input = resetRoleSchema.parse(rawInput);
    return this.runTransitionIdempotent(
      viewer,
      personId,
      input,
      "pending",
      null,
      "administrator",
      "speaker.role.reset",
    );
  }

  private async runTransitionIdempotent(
    viewer: Viewer,
    personId: string,
    input: {
      sessionId: string;
      role: ParticipantRole;
      roleRevision: number;
    },
    nextRoleStatus: "pending" | "confirmed" | "declined",
    reason: string | null,
    source: "speaker" | "administrator" | "administrator_external",
    operation: string,
  ) {
    const idempotencyKey = await airtableCommandKey(operation, viewer, {
      personId,
      ...input,
      nextRoleStatus,
      reason,
    });
    return this.executeRoleIdempotent(
      viewer,
      { idempotencyKey, operation },
      () =>
        this.transition(
          viewer,
          personId,
          input,
          nextRoleStatus,
          reason,
          source,
        ),
      () =>
        this.requireTransitionReplay(
          viewer,
          personId,
          input,
          nextRoleStatus,
          reason,
          source,
        ),
    );
  }

  private async transition(
    viewer: Viewer,
    personId: string,
    input: {
      sessionId: string;
      role: ParticipantRole;
      roleRevision: number;
    },
    nextRoleStatus: "pending" | "confirmed" | "declined",
    reason: string | null,
    source: "speaker" | "administrator" | "administrator_external",
  ) {
    const target = await this.roleTarget(viewer, personId, input);
    const replay = await this.replayTransition(
      viewer,
      personId,
      input,
      nextRoleStatus,
      reason,
      source,
      target,
    );
    if (replay) return replay;
    const expectedCurrentStatus =
      nextRoleStatus === "pending" ? "declined" : "pending";
    if (
      target.sessionStatus === "cancelled" ||
      target.sessionStatus === "archived"
    ) {
      throw new Response(
        "Active participant session not found in this event.",
        {
          status: 404,
        },
      );
    }
    if (
      target.roleStatus !== expectedCurrentStatus ||
      target.roleRevision !== input.roleRevision
    ) {
      const committed = await this.replayTransition(
        viewer,
        personId,
        input,
        nextRoleStatus,
        reason,
        source,
      );
      if (committed) return committed;
      throw new SpeakerAdminStateError(
        "This role response changed after the page loaded. Refresh before responding.",
        409,
      );
    }
    const roles = await this.env.DB.prepare(
      `SELECT role, participation_status AS status
         FROM session_participant_roles
        WHERE event_id = ? AND session_id = ? AND person_id = ?
        ORDER BY position, role`,
    )
      .bind(viewer.eventId, input.sessionId, personId)
      .all<{
        role: ParticipantRole;
        status: "pending" | "confirmed" | "declined";
      }>();
    const nextRelationshipStatus = aggregateStatus(
      roles.results.map((role) =>
        role.role === input.role ? nextRoleStatus : role.status,
      ),
    );
    const action =
      nextRoleStatus === "confirmed"
        ? "speaker.participation.confirmed"
        : nextRoleStatus === "declined"
          ? "speaker.participation.declined"
          : "speaker.participation.reset";
    const origin = source === "speaker" ? "participant_ui" : "admin_ui";
    const auditId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const nextRelationshipRevision = target.relationshipRevision + 1;
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id,
           actor_person_id, action, entity_type, entity_id, correlation_id,
           metadata_json, created_at
         )
         SELECT ?, 'person', ?, 1, ?, ?, ?, ?, 'session_participant_role',
                ?, ?, ?, unixepoch()
           FROM session_participant_roles role
           JOIN events event ON event.id = role.event_id
           JOIN sessions session
             ON session.id = role.session_id AND session.event_id = role.event_id
          WHERE role.event_id = ? AND role.session_id = ?
            AND role.person_id = ? AND role.role = ?
            AND role.participation_status = ?
            AND role.participation_revision = ?
            AND event.organisation_id = ?
            AND session.status NOT IN ('cancelled','archived')`,
      ).bind(
        auditId,
        origin,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        action,
        `${input.sessionId}:${personId}:${input.role}`,
        correlationId,
        JSON.stringify({
          sessionId: input.sessionId,
          personId,
          role: input.role,
          label: target.roleLabel,
          source,
          from: target.roleStatus,
          to: nextRoleStatus,
          participationRevision: input.roleRevision,
        }),
        viewer.eventId,
        input.sessionId,
        personId,
        input.role,
        expectedCurrentStatus,
        input.roleRevision,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `UPDATE session_participant_roles
            SET participation_status = ?,
                participation_revision = participation_revision + 1,
                participation_confirmed_at = CASE WHEN ? = 'confirmed' THEN unixepoch() ELSE NULL END,
                participation_declined_at = CASE WHEN ? = 'declined' THEN unixepoch() ELSE NULL END,
                participation_decline_reason = CASE WHEN ? = 'declined' THEN ? ELSE NULL END,
                updated_at = unixepoch()
          WHERE event_id = ? AND session_id = ? AND person_id = ? AND role = ?
            AND participation_status = ? AND participation_revision = ?
            AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)`,
      ).bind(
        nextRoleStatus,
        nextRoleStatus,
        nextRoleStatus,
        nextRoleStatus,
        reason,
        viewer.eventId,
        input.sessionId,
        personId,
        input.role,
        expectedCurrentStatus,
        input.roleRevision,
        auditId,
      ),
      this.env.DB.prepare(
        `UPDATE session_speakers
            SET participation_status = CASE
                  WHEN EXISTS (
                    SELECT 1 FROM session_participant_roles current_role
                     WHERE current_role.session_id = session_speakers.session_id
                       AND current_role.person_id = session_speakers.person_id
                       AND current_role.participation_status = 'confirmed'
                  ) THEN 'confirmed'
                  WHEN EXISTS (
                    SELECT 1 FROM session_participant_roles current_role
                     WHERE current_role.session_id = session_speakers.session_id
                       AND current_role.person_id = session_speakers.person_id
                       AND current_role.participation_status = 'pending'
                  ) THEN 'pending'
                  ELSE 'declined'
                END,
                participation_revision = participation_revision + 1,
                participation_confirmed_at = CASE
                  WHEN EXISTS (
                    SELECT 1 FROM session_participant_roles current_role
                     WHERE current_role.session_id = session_speakers.session_id
                       AND current_role.person_id = session_speakers.person_id
                       AND current_role.participation_status = 'confirmed'
                  ) THEN COALESCE(participation_confirmed_at, unixepoch())
                  ELSE NULL END,
                participation_declined_at = CASE
                  WHEN NOT EXISTS (
                    SELECT 1 FROM session_participant_roles current_role
                     WHERE current_role.session_id = session_speakers.session_id
                       AND current_role.person_id = session_speakers.person_id
                       AND current_role.participation_status IN ('confirmed','pending')
                  ) THEN unixepoch() ELSE NULL END,
                participation_decline_reason = NULL
          WHERE event_id = ? AND session_id = ? AND person_id = ?
            AND EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
            AND EXISTS (
              SELECT 1 FROM session_participant_roles changed_role
               WHERE changed_role.session_id = session_speakers.session_id
                 AND changed_role.person_id = session_speakers.person_id
                 AND changed_role.role = ?
                 AND changed_role.participation_status = ?
                 AND changed_role.participation_revision = ?
            )`,
      ).bind(
        viewer.eventId,
        input.sessionId,
        personId,
        auditId,
        input.role,
        nextRoleStatus,
        input.roleRevision + 1,
      ),
    ];
    if (
      target.relationshipStatus !== "confirmed" &&
      nextRelationshipStatus === "confirmed"
    ) {
      statements.push(
        ...materializePublishedConfirmedSpeakerAcknowledgements(
          this.env,
          viewer.eventId,
          personId,
          auditId,
        ),
      );
    }
    if (
      target.relationshipStatus === "declined" &&
      nextRelationshipStatus === "pending"
    ) {
      statements.push(
        ...materializePublishedResourceAcknowledgementsForParticipationReset(
          this.env,
          viewer.eventId,
          input.sessionId,
          personId,
          nextRelationshipRevision,
          auditId,
        ),
      );
    }
    statements.push(
      this.env.DB.prepare(
        `INSERT INTO event_changes (
           event_id, entity_type, entity_id, change_type, correlation_id,
           created_at
         )
         SELECT ?, 'person', ?, 'updated', ?, unixepoch()
          WHERE EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
         RETURNING sequence`,
      ).bind(viewer.eventId, personId, correlationId, auditId),
    );
    const results = await this.env.DB.batch(statements);
    if (
      (results[0]?.meta.changes ?? 0) !== 1 ||
      (results[1]?.meta.changes ?? 0) !== 1 ||
      (results[2]?.meta.changes ?? 0) < 1
    ) {
      throw new SpeakerAdminStateError(
        "This role response changed after the page loaded. Refresh before responding.",
        409,
      );
    }
    const change = results.at(-1)?.results?.[0] as
      | { sequence?: number }
      | undefined;
    return {
      sessionId: input.sessionId,
      title: target.title,
      role: input.role,
      label: target.roleLabel,
      participationStatus: nextRoleStatus,
      participationRevision: input.roleRevision + 1,
      changeSequence: Number(change?.sequence ?? 0),
      changed: true,
    };
  }

  private async executeRoleIdempotent<T>(
    viewer: Viewer,
    commandIdentity: { idempotencyKey: string; operation: string },
    command: () => Promise<T>,
    replay: () => Promise<T>,
  ) {
    let executed = false;
    const result = await this.airtable.executeIdempotent(
      viewer,
      commandIdentity,
      () => {
        executed = true;
        return command();
      },
    );
    return executed ? result : replay();
  }

  private async requireAssignedRoleReplay(
    viewer: Viewer,
    personId: string,
    input: z.infer<typeof addRoleSchema>,
  ) {
    const replay = await this.replayAssignedRole(viewer, personId, input);
    if (replay) return replay;
    throw new SpeakerAdminStateError(
      "That role assignment changed after this request was first recorded. Refresh before trying again.",
      409,
    );
  }

  private async replayAssignedRole(
    viewer: Viewer,
    personId: string,
    input: z.infer<typeof addRoleSchema>,
  ) {
    const committed = await this.env.DB.prepare(
      `SELECT session.title, role.label, change.sequence
         FROM session_participant_roles role
         JOIN sessions session
           ON session.id = role.session_id AND session.event_id = role.event_id
         JOIN audit_events audit
           ON audit.organisation_id = ? AND audit.event_id = role.event_id
          AND audit.actor_person_id = ?
          AND audit.action = 'speaker.role.assigned'
          AND audit.entity_type = 'session_participant_role'
          AND audit.entity_id = ?
          AND json_valid(audit.metadata_json)
          AND json_extract(audit.metadata_json, '$.sessionId') = role.session_id
          AND json_extract(audit.metadata_json, '$.personId') = role.person_id
          AND json_extract(audit.metadata_json, '$.role') = role.role
         JOIN event_changes change
           ON change.event_id = audit.event_id
          AND change.entity_type = 'person'
          AND change.entity_id = role.person_id
          AND change.correlation_id = audit.correlation_id
        WHERE role.event_id = ? AND role.session_id = ?
          AND role.person_id = ? AND role.role = ?
          AND role.participation_status = 'pending'
          AND role.participation_revision = 1
        ORDER BY change.sequence
        LIMIT 1`,
    )
      .bind(
        viewer.organisationId,
        viewer.personId,
        `${input.sessionId}:${personId}:${input.role}`,
        viewer.eventId,
        input.sessionId,
        personId,
        input.role,
      )
      .first<{ title: string; label: string; sequence: number }>();
    return committed
      ? {
          sessionId: input.sessionId,
          personId,
          role: input.role,
          label: committed.label,
          changeSequence: Number(committed.sequence),
          changed: false,
        }
      : null;
  }

  private async requireTransitionReplay(
    viewer: Viewer,
    personId: string,
    input: {
      sessionId: string;
      role: ParticipantRole;
      roleRevision: number;
    },
    nextRoleStatus: "pending" | "confirmed" | "declined",
    reason: string | null,
    source: "speaker" | "administrator" | "administrator_external",
  ) {
    const replay = await this.replayTransition(
      viewer,
      personId,
      input,
      nextRoleStatus,
      reason,
      source,
    );
    if (replay) return replay;
    throw new SpeakerAdminStateError(
      "This role response changed after this request was first recorded. Refresh before responding.",
      409,
    );
  }

  private async replayTransition(
    viewer: Viewer,
    personId: string,
    input: {
      sessionId: string;
      role: ParticipantRole;
      roleRevision: number;
    },
    nextRoleStatus: "pending" | "confirmed" | "declined",
    reason: string | null,
    source: "speaker" | "administrator" | "administrator_external",
    knownTarget?: RoleTarget,
  ) {
    const target =
      knownTarget ?? (await this.roleTarget(viewer, personId, input));
    if (
      target.roleStatus !== nextRoleStatus ||
      target.roleRevision !== input.roleRevision + 1 ||
      target.roleDeclineReason !== reason
    ) {
      return null;
    }
    const action =
      nextRoleStatus === "confirmed"
        ? "speaker.participation.confirmed"
        : nextRoleStatus === "declined"
          ? "speaker.participation.declined"
          : "speaker.participation.reset";
    const expectedFrom = nextRoleStatus === "pending" ? "declined" : "pending";
    const committed = await this.env.DB.prepare(
      `SELECT change.sequence
         FROM audit_events audit
         JOIN event_changes change
           ON change.event_id = audit.event_id
          AND change.entity_type = 'person'
          AND change.entity_id = ?
          AND change.correlation_id = audit.correlation_id
        WHERE audit.organisation_id = ? AND audit.event_id = ?
          AND audit.actor_person_id = ? AND audit.action = ?
          AND audit.entity_type = 'session_participant_role'
          AND audit.entity_id = ?
          AND json_valid(audit.metadata_json)
          AND json_extract(audit.metadata_json, '$.sessionId') = ?
          AND json_extract(audit.metadata_json, '$.personId') = ?
          AND json_extract(audit.metadata_json, '$.role') = ?
          AND json_extract(audit.metadata_json, '$.source') = ?
          AND json_extract(audit.metadata_json, '$.from') = ?
          AND json_extract(audit.metadata_json, '$.to') = ?
          AND json_extract(audit.metadata_json, '$.participationRevision') = ?
        ORDER BY change.sequence
        LIMIT 1`,
    )
      .bind(
        personId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        action,
        `${input.sessionId}:${personId}:${input.role}`,
        input.sessionId,
        personId,
        input.role,
        source,
        expectedFrom,
        nextRoleStatus,
        input.roleRevision,
      )
      .first<{ sequence: number }>();
    return committed
      ? {
          sessionId: input.sessionId,
          title: target.title,
          role: input.role,
          label: target.roleLabel,
          participationStatus: nextRoleStatus,
          participationRevision: input.roleRevision + 1,
          changeSequence: Number(committed.sequence),
          changed: false,
        }
      : null;
  }

  private async roleTarget(
    viewer: Viewer,
    personId: string,
    input: { sessionId: string; role: ParticipantRole },
  ) {
    const target = await this.env.DB.prepare(
      `SELECT session.title, session.status AS sessionStatus,
              relationship.participation_revision AS relationshipRevision,
              relationship.participation_status AS relationshipStatus,
              role.participation_status AS roleStatus,
              role.participation_revision AS roleRevision,
              role.label AS roleLabel,
              role.participation_decline_reason AS roleDeclineReason
         FROM session_participant_roles role
         JOIN session_speakers relationship
           ON relationship.session_id = role.session_id
          AND relationship.person_id = role.person_id
          AND relationship.event_id = role.event_id
         JOIN sessions session
           ON session.id = relationship.session_id
          AND session.event_id = relationship.event_id
         JOIN events event ON event.id = relationship.event_id
        WHERE role.event_id = ? AND role.session_id = ?
          AND role.person_id = ? AND role.role = ?
          AND event.organisation_id = ?`,
    )
      .bind(
        viewer.eventId,
        input.sessionId,
        personId,
        input.role,
        viewer.organisationId,
      )
      .first<RoleTarget>();
    if (!target) {
      throw new Response("Participant role not found in this event.", {
        status: 404,
      });
    }
    return target;
  }

  private assertAdministrator(viewer: Viewer) {
    if (viewer.role !== "owner" && viewer.role !== "administrator") {
      throw new Response("Event administrator access is required.", {
        status: 403,
      });
    }
  }
}
