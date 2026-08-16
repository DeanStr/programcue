import {
  airtableIntentCommand,
  AirtableProviderBoundary,
} from "~/modules/airtable/airtable-provider-boundary.server";
import { emailDeliveryIssue } from "~/modules/communications/email-deliverability";
import { ApiPersonIdempotencyService } from "~/platform/api/api-person-idempotency.server";
import { ApiError } from "~/platform/api/api.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  dispatchSpeakerInvitationsForCommand,
  prepareSpeakerInvitations,
  SpeakerInvitationDeliveryError,
  type SpeakerInvitationDelivery,
} from "./speaker-invitation.server";
import { SpeakerAdminStateError } from "./speaker-service-errors";

import {
  organisationAdministratorViewer,
  speakerInvitationSchema,
} from "./speaker-administration-contracts.server";

export class SpeakerInvitationCommands {
  private readonly airtable: AirtableProviderBoundary;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
  }

  async inviteSpeakerRecord(viewer: Viewer, rawInput: unknown) {
    organisationAdministratorViewer(viewer);
    const input = speakerInvitationSchema.parse(rawInput);
    const speaker = await this.env.DB.prepare(
      `SELECT person.email,
              EXISTS (
                SELECT 1 FROM memberships membership
                 WHERE membership.organisation_id = event.organisation_id
                   AND membership.event_id = event.id
                   AND membership.person_id = person.id
                   AND membership.role = 'speaker'
                   AND membership.accepted_at IS NOT NULL
                   AND membership.revoked_at IS NULL
              ) AS portalAccessAccepted
         FROM people person
         JOIN event_speaker_workflows workflow
           ON workflow.person_id = person.id AND workflow.event_id = ?
         JOIN events event ON event.id = workflow.event_id
        WHERE person.id = ? AND event.organisation_id = ?
          AND event.activation_status = 'active'
          AND workflow.status IN ('prospect','invited','confirmed')`,
    )
      .bind(viewer.eventId, input.personId, viewer.organisationId)
      .first<{ email: string; portalAccessAccepted: number }>();
    if (!speaker) {
      throw new SpeakerAdminStateError(
        "Only an active speaker record in this event can be invited.",
        404,
      );
    }
    const deliveryIssue = emailDeliveryIssue(speaker.email, this.env.APP_ENV);
    if (!speaker.portalAccessAccepted && deliveryIssue) {
      throw new SpeakerAdminStateError(
        `The speaker invitation email address is not deliverable: ${deliveryIssue.toLowerCase()}.`,
        422,
      );
    }
    const command = await airtableIntentCommand(
      "speaker.admin.invite",
      viewer,
      input.idempotencyKey,
      { personId: input.personId },
    );
    const result = await this.airtable.executeIdempotent(
      viewer,
      command,
      async () => {
        try {
          const { result } = await new ApiPersonIdempotencyService(
            this.env,
          ).run({
            viewer,
            scope: "speaker.admin.invite",
            idempotencyKey: input.idempotencyKey,
            input: { personId: input.personId },
            execute: (commandId) =>
              this.inviteSpeakerRecordD1(viewer, input.personId, commandId),
            recover: (commandId) =>
              this.recoverSpeakerInvitation(viewer, input.personId, commandId),
          });
          return result;
        } catch (error) {
          if (error instanceof ApiError) {
            throw new SpeakerAdminStateError(error.message, error.status);
          }
          throw error;
        }
      },
    );
    const invitationOutcomes = await dispatchSpeakerInvitationsForCommand({
      env: this.env,
      organisationId: viewer.organisationId,
      eventId: viewer.eventId,
      commandId: result.commandId,
    });
    const invitationOutcome = invitationOutcomes[0];
    const accepted =
      result.accepted || invitationOutcome?.status === "not_required";
    const delivery: SpeakerInvitationDelivery = accepted
      ? "not_required"
      : (invitationOutcome?.status ?? "not_required");
    if (!accepted && delivery === "not_required") {
      throw new Error(
        "The pending speaker invitation is missing its delivery outcome.",
      );
    }
    if (["queue_failed", "failed", "cancelled"].includes(delivery)) {
      throw new SpeakerInvitationDeliveryError(result.membershipId);
    }
    const { commandId: _commandId, ...publicResult } = result;
    return { ...publicResult, accepted, delivery };
  }

  private async inviteSpeakerRecordD1(
    viewer: Viewer,
    personId: string,
    commandId: string,
  ) {
    const speaker = await this.env.DB.prepare(
      `SELECT person.email
         FROM people person
         JOIN event_speaker_workflows workflow
           ON workflow.person_id = person.id AND workflow.event_id = ?
         JOIN events event ON event.id = workflow.event_id
        WHERE person.id = ? AND event.organisation_id = ?
          AND event.activation_status = 'active'
          AND workflow.status IN ('prospect','invited','confirmed')`,
    )
      .bind(viewer.eventId, personId, viewer.organisationId)
      .first<{ email: string }>();
    if (!speaker) {
      throw new SpeakerAdminStateError(
        "Only an active speaker record in this event can be invited.",
        404,
      );
    }

    const membershipId = crypto.randomUUID();
    const invitationPlans = await prepareSpeakerInvitations({
      env: this.env,
      actor: {
        organisationId: viewer.organisationId,
        eventId: viewer.eventId,
        personId: viewer.personId,
      },
      commandId,
      source: "speaker_network",
      emails: [speaker.email],
    });
    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role,
           invited_at, invitation_expires_at, accepted_at, revoked_at,
           last_operation_id, created_at
         )
         SELECT ?, event.organisation_id, event.id, person.id, 'speaker',
                unixepoch(), unixepoch() + 604800, NULL, NULL, ?, unixepoch()
           FROM people person
           JOIN event_speaker_workflows workflow
             ON workflow.event_id = ? AND workflow.person_id = person.id
           JOIN events event ON event.id = workflow.event_id
          WHERE person.id = ? AND event.organisation_id = ?
            AND event.activation_status = 'active'
            AND workflow.status IN ('prospect','invited','confirmed')
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
        membershipId,
        commandId,
        viewer.eventId,
        personId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `UPDATE event_speaker_workflows
            SET status = CASE WHEN status = 'confirmed'
                              THEN status ELSE 'invited' END,
                source = CASE WHEN status = 'confirmed'
                              THEN source ELSE 'manual' END,
                revision = revision + 1,
                last_operation_id = ?,
                updated_by_person_id = ?,
                updated_at = unixepoch()
          WHERE event_id = ? AND person_id = ?
            AND status IN ('prospect','invited','confirmed')
            AND EXISTS (
              SELECT 1 FROM memberships membership
               WHERE membership.organisation_id = ?
                 AND membership.event_id = event_speaker_workflows.event_id
                 AND membership.person_id = event_speaker_workflows.person_id
                 AND membership.role = 'speaker'
                 AND membership.accepted_at IS NULL
                 AND membership.revoked_at IS NULL
                 AND membership.last_operation_id = ?
            )`,
      ).bind(
        `${commandId}:workflow`,
        viewer.personId,
        viewer.eventId,
        personId,
        viewer.organisationId,
        commandId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, event.organisation_id, event.id, ?,
                CASE WHEN membership.accepted_at IS NULL
                     THEN 'speaker.admin.invited'
                     ELSE 'speaker.admin.reused' END,
                'person', person.id, ?,
                json_object('source', 'speaker_roster'), unixepoch()
           FROM people person
           JOIN event_speaker_workflows workflow
             ON workflow.event_id = ? AND workflow.person_id = person.id
           JOIN events event ON event.id = workflow.event_id
           JOIN memberships membership
             ON membership.organisation_id = event.organisation_id
            AND membership.event_id = event.id
            AND membership.person_id = person.id
            AND membership.role = 'speaker'
            AND membership.last_operation_id = ?
          WHERE person.id = ? AND event.organisation_id = ?
            AND event.activation_status = 'active'
            AND membership.revoked_at IS NULL
            AND workflow.status IN ('prospect','invited','confirmed')
            AND (
              membership.accepted_at IS NOT NULL
              OR (
                workflow.last_operation_id = ?
                AND workflow.updated_by_person_id = ?
              )
            )`,
      ).bind(
        crypto.randomUUID(),
        viewer.personId,
        commandId,
        viewer.eventId,
        commandId,
        personId,
        viewer.organisationId,
        `${commandId}:workflow`,
        viewer.personId,
      ),
      ...invitationPlans.flatMap((plan) => plan.statements),
    ]);
    const invitation = await this.recoverSpeakerInvitation(
      viewer,
      personId,
      commandId,
    );
    if (!invitation) {
      throw new SpeakerAdminStateError(
        "The speaker record changed before its invitation could be saved. Refresh before trying again.",
        409,
      );
    }
    return invitation;
  }

  private async recoverSpeakerInvitation(
    viewer: Viewer,
    personId: string,
    commandId: string,
  ) {
    const row = await this.env.DB.prepare(
      `SELECT audit.entity_id AS personId, person.email,
              membership.id AS membershipId,
              membership.accepted_at IS NOT NULL AS accepted,
              membership.invitation_expires_at AS invitationExpiresAt
         FROM audit_events audit
         JOIN people person ON person.id = audit.entity_id
         JOIN memberships membership
           ON membership.person_id = audit.entity_id
          AND membership.organisation_id = audit.organisation_id
          AND membership.event_id = audit.event_id
          AND membership.role = 'speaker'
          AND membership.revoked_at IS NULL
         JOIN event_speaker_workflows workflow
           ON workflow.event_id = audit.event_id
          AND workflow.person_id = audit.entity_id
        WHERE audit.organisation_id = ? AND audit.event_id = ?
          AND audit.actor_person_id = ?
          AND audit.action IN ('speaker.admin.invited','speaker.admin.reused')
          AND audit.entity_type = 'person' AND audit.entity_id = ?
          AND audit.correlation_id = ?
          AND workflow.status IN ('prospect','invited','confirmed')
        LIMIT 1`,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        personId,
        commandId,
      )
      .first<{
        personId: string;
        email: string;
        membershipId: string;
        accepted: number;
        invitationExpiresAt: number | null;
      }>();
    return row
      ? {
          ...row,
          commandId,
          accepted: Boolean(row.accepted),
        }
      : null;
  }
}
