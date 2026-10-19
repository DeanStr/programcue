import { z } from "zod";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  atomicBatchGuardStatement,
  isAtomicBatchGuardError,
} from "~/platform/database/atomic-batch-guard.server";
import { type SponsorPerson, SponsorStateError } from "./sponsor-schema";

export type SponsorAuthority = {
  organisationId: string;
  eventId: string;
  personId: string;
  origin: "admin_ui" | "participant_ui";
  sql: string;
  bindings: Array<string | number | null>;
};

export class SponsorStore {
  constructor(protected readonly env: CloudflareEnvironment) {}

  protected async admin(viewer: Viewer): Promise<SponsorAuthority> {
    if (viewer.role !== "owner" && viewer.role !== "administrator")
      throw new Response("Administrator access required", { status: 403 });
    const sql = `SELECT 1 FROM events e JOIN memberships m ON m.organisation_id=e.organisation_id
      AND (m.event_id=e.id OR m.event_id IS NULL)
      WHERE e.id=? AND e.organisation_id=? AND e.activation_status='active'
        AND m.person_id=? AND m.role IN ('owner','administrator') AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL`;
    const bindings = [viewer.eventId, viewer.organisationId, viewer.personId];
    if (
      !(await this.env.DB.prepare(sql)
        .bind(...bindings)
        .first())
    )
      throw new Response("Administrator access required", { status: 403 });
    return { ...viewer, origin: "admin_ui", sql, bindings };
  }

  protected async contact(
    person: SponsorPerson,
    eventId: string,
    sponsorId: string,
    pending = false,
  ): Promise<SponsorAuthority> {
    const sql = `SELECT s.organisation_id AS organisationId FROM event_sponsorships s
      JOIN events e ON e.id=s.event_id AND e.organisation_id=s.organisation_id
      JOIN sponsor_contacts c ON c.sponsor_id=s.id AND c.event_id=s.event_id
      WHERE s.id=? AND s.event_id=? AND s.status='active' AND e.activation_status='active'
        AND e.participant_retention_completed_at IS NULL
        AND lower(c.email)=lower(?) AND c.revoked_at IS NULL
        AND (? IS NULL OR s.organisation_id=?)
        AND (?=1 OR c.accepted_at IS NOT NULL)`;
    const bindings = [
      sponsorId,
      eventId,
      person.email,
      person.restrictedOrganisationId,
      person.restrictedOrganisationId,
      pending ? 1 : 0,
    ];
    const row = await this.env.DB.prepare(sql)
      .bind(...bindings)
      .first<{ organisationId: string }>();
    if (!row) throw new Response("Sponsor access not found", { status: 404 });
    return {
      organisationId: row.organisationId,
      eventId,
      personId: person.personId,
      origin: "participant_ui",
      sql,
      bindings,
    };
  }

  protected async commit(
    authority: SponsorAuthority,
    key: string,
    scope: string,
    payload: unknown,
    entityId: string,
    statements: D1PreparedStatement[],
  ) {
    z.uuid().parse(key);
    if (
      await this.env.DB.prepare(
        `SELECT 1 FROM participant_retention_locked_events WHERE event_id=? AND organisation_id=?`,
      )
        .bind(authority.eventId, authority.organisationId)
        .first()
    )
      throw new SponsorStateError(
        "Participant retention is complete for this event. Sponsor data can no longer be changed.",
      );
    const bytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(payload)),
    );
    const hash = Array.from(new Uint8Array(bytes), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const recover = async () => {
      const row = await this.env.DB.prepare(
        `SELECT request_hash AS hash, entity_id AS entityId, status FROM idempotency_records WHERE organisation_id=? AND event_id=? AND actor_id=? AND scope=? AND idempotency_key=?`,
      )
        .bind(
          authority.organisationId,
          authority.eventId,
          authority.personId,
          scope,
          key,
        )
        .first<{ hash: string; entityId: string; status: string }>();
      if (!row) return null;
      if (row.hash !== hash || row.status !== "completed")
        throw new SponsorStateError(
          "This action has already been used for different details. Refresh and try again.",
        );
      return row.entityId;
    };
    const replay = await recover();
    if (replay) return replay;
    const commandId = crypto.randomUUID();
    try {
      await this.env.DB.batch([
        atomicBatchGuardStatement(
          this.env,
          `NOT EXISTS (${authority.sql})`,
          authority.bindings,
        ),
        this.env.DB.prepare(
          `INSERT INTO idempotency_records (id,organisation_id,event_id,actor_id,scope,idempotency_key,request_hash,status,expires_at) VALUES (?,?,?,?,?,?,?,'processing',unixepoch()+2592000)`,
        ).bind(
          commandId,
          authority.organisationId,
          authority.eventId,
          authority.personId,
          scope,
          key,
          hash,
        ),
        ...statements,
        atomicBatchGuardStatement(this.env, "changes() <> 1", []),
        this.env.DB.prepare(
          `INSERT INTO audit_events (id,organisation_id,event_id,actor_person_id,actor_kind,origin,metadata_version,action,entity_type,entity_id,correlation_id,metadata_json,created_at) VALUES (?,?,?,?,'person',?,1,?,'sponsorship',?,?,?,unixepoch())`,
        ).bind(
          commandId,
          authority.organisationId,
          authority.eventId,
          authority.personId,
          authority.origin,
          scope,
          entityId,
          commandId,
          JSON.stringify({ version: 1, entityId }),
        ),
        this.env.DB.prepare(
          `UPDATE idempotency_records SET status='completed',entity_type='sponsorship',entity_id=?,response_status=200,response_json=?,completed_at=unixepoch() WHERE id=?`,
        ).bind(entityId, JSON.stringify({ entityId }), commandId),
      ]);
    } catch (error) {
      if (
        error instanceof Error &&
        /participant retention is complete/i.test(error.message)
      )
        throw new SponsorStateError(
          "Participant retention is complete for this event. Sponsor data can no longer be changed.",
        );
      const concurrent = await recover();
      if (concurrent) return concurrent;
      if (
        isAtomicBatchGuardError(error) ||
        (error instanceof Error && /UNIQUE constraint/.test(error.message))
      )
        throw new SponsorStateError(
          "The sponsor record, access or remaining allowance changed. Refresh and review before trying again.",
        );
      throw error;
    }
    return entityId;
  }
}
