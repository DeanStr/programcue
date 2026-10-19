import type { UploadTarget } from "~/modules/files/file-access-service.server";
import { FileAccessError } from "~/modules/files/file-service-errors";
import type { SponsorMultipartActor } from "~/modules/files/multipart-upload-contracts";

export function sponsorUploadGuard(
  actor: SponsorMultipartActor,
  targetId: string,
) {
  return {
    sql: `SELECT 1 FROM sponsor_asset_requests r
      JOIN event_sponsorships s ON s.id=r.sponsor_id AND s.event_id=r.event_id
      JOIN events e ON e.id=s.event_id AND e.organisation_id=s.organisation_id
      JOIN sponsor_contacts c ON c.sponsor_id=s.id AND c.event_id=s.event_id
      WHERE r.id=? AND r.event_id=? AND s.id=? AND s.organisation_id=?
        AND s.status='active' AND e.activation_status='active'
        AND (s.closes_at IS NULL OR s.closes_at>unixepoch())
        AND e.participant_retention_completed_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM participant_retention_locked_events WHERE event_id=e.id)
        AND lower(c.email)=lower(?) AND c.accepted_at IS NOT NULL AND c.revoked_at IS NULL`,
    bindings: [
      targetId,
      actor.eventId,
      actor.sponsorId,
      actor.organisationId,
      actor.email,
    ],
  };
}
export async function assertSponsorUpload(
  env: CloudflareEnvironment,
  actor: SponsorMultipartActor,
  target: UploadTarget,
) {
  const guard = sponsorUploadGuard(actor, target.targetId);
  if (
    target.targetType !== "resource" ||
    !target.targetId.startsWith("sponsor-asset-") ||
    !(await env.DB.prepare(guard.sql)
      .bind(...guard.bindings)
      .first())
  )
    throw new FileAccessError(
      "This sponsor asset is unavailable or its editing deadline has passed.",
    );
  const row = await env.DB.prepare(
    "SELECT kind FROM sponsor_asset_requests WHERE id=? AND event_id=?",
  )
    .bind(target.targetId, actor.eventId)
    .first<{ kind: string }>();
  if (
    target.assetKind !==
    (row?.kind === "logo" ? "other" : "supporting_document")
  )
    throw new FileAccessError(
      "Choose the file type requested by the organiser.",
    );
  return null;
}
