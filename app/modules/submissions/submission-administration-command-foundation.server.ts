import { hashApplicantToken } from "./applicant-session.server";
import { SubmissionServiceFoundation } from "./submission-service-foundation.server";
import { SubmissionStateError } from "./submission-repository.server";
import {
  isSubmissionApiActor,
  type AdminMutationRecord,
  type PreparedAdminMutation,
  type SubmissionAdminActor,
} from "./submission-service-foundation.server";

export class SubmissionAdministrationCommandFoundation extends SubmissionServiceFoundation {
  protected async readAdminMutation(
    command: Omit<PreparedAdminMutation, "recordId">,
  ) {
    const row = await this.env.DB.prepare(
      `SELECT id, request_hash AS requestHash, status, entity_id AS entityId
         FROM idempotency_records
        WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
          AND scope = ? AND idempotency_key = ?
          AND expires_at > unixepoch()`,
    )
      .bind(
        command.organisationId,
        command.eventId,
        command.actorId,
        command.scope,
        command.idempotencyKey,
      )
      .first<AdminMutationRecord>();
    if (!row) return null;
    if (row.requestHash !== command.requestHash) {
      throw new SubmissionStateError(
        "This idempotency key was already used with different record details. Refresh before trying again.",
      );
    }
    if (row.status !== "completed") {
      throw new SubmissionStateError(
        "This record creation request is already being processed. Wait for it to finish before retrying.",
      );
    }
    if (!row.entityId) {
      throw new Error(
        "A completed submission administration idempotency record is missing its entity ID.",
      );
    }
    return { entityId: row.entityId, recordId: row.id };
  }

  protected async prepareAdminMutation(
    actor: SubmissionAdminActor,
    scope: PreparedAdminMutation["scope"],
    idempotencyKey: string,
    requestPayload: unknown,
  ) {
    if (isSubmissionApiActor(actor) && !actor.actorId.startsWith("api_key:")) {
      throw new Error("Submission API actor IDs must identify an API key.");
    }
    const requestHash = await hashApplicantToken(
      JSON.stringify(requestPayload),
    );
    const identity = {
      scope,
      idempotencyKey,
      requestHash,
      organisationId: actor.organisationId,
      eventId: actor.eventId,
      actorId: isSubmissionApiActor(actor) ? actor.actorId : actor.personId,
    };
    const replay = await this.readAdminMutation(identity);
    return replay
      ? { replay, command: null }
      : {
          replay: null,
          command: { ...identity, recordId: crypto.randomUUID() },
        };
  }

  protected adminMutationClaimStatements(command: PreparedAdminMutation) {
    return [
      this.env.DB.prepare(
        `DELETE FROM idempotency_records
          WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
            AND scope = ? AND idempotency_key = ?
            AND expires_at <= unixepoch()`,
      ).bind(
        command.organisationId,
        command.eventId,
        command.actorId,
        command.scope,
        command.idempotencyKey,
      ),
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO idempotency_records (
           id, organisation_id, event_id, actor_id, scope, idempotency_key,
           request_hash, status, expires_at, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'processing',
                   unixepoch() + 2592000, unixepoch())`,
      ).bind(
        command.recordId,
        command.organisationId,
        command.eventId,
        command.actorId,
        command.scope,
        command.idempotencyKey,
        command.requestHash,
      ),
    ];
  }

  protected async resolveAdminMutationRace(command: PreparedAdminMutation) {
    const row = await this.env.DB.prepare(
      `SELECT id, request_hash AS requestHash, status, entity_id AS entityId
         FROM idempotency_records
        WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
          AND scope = ? AND idempotency_key = ?
          AND expires_at > unixepoch()`,
    )
      .bind(
        command.organisationId,
        command.eventId,
        command.actorId,
        command.scope,
        command.idempotencyKey,
      )
      .first<AdminMutationRecord>();
    if (!row) return null;
    if (row.requestHash !== command.requestHash) {
      throw new SubmissionStateError(
        "This idempotency key was already used with different record details. Refresh before trying again.",
      );
    }
    if (row.status === "completed") {
      if (!row.entityId) {
        throw new Error(
          "A completed submission administration idempotency record is missing its entity ID.",
        );
      }
      return { entityId: row.entityId, recordId: row.id };
    }
    if (row.id !== command.recordId) {
      throw new SubmissionStateError(
        "This record creation request is already being processed. Wait for it to finish before retrying.",
      );
    }
    await this.env.DB.prepare(
      `DELETE FROM idempotency_records
        WHERE id = ? AND organisation_id = ? AND event_id = ?
          AND actor_id = ? AND status = 'processing'`,
    )
      .bind(
        command.recordId,
        command.organisationId,
        command.eventId,
        command.actorId,
      )
      .run();
    return null;
  }
}
