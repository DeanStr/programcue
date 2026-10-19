import { z } from "zod";
import {
  parseEventFilePolicy,
  safeDownloadName,
} from "~/modules/files/file-policy";
import type { SponsorMultipartActor } from "~/modules/files/multipart-upload-contracts";
import { sponsorInputSchema } from "~/modules/public-site/public-site";
import type { Viewer } from "~/platform/auth/authorize.server";
import { atomicBatchGuardStatement } from "~/platform/database/atomic-batch-guard.server";
import { type SponsorAsset, sponsorAssetState } from "./sponsor-assets";
import { type SponsorPerson, SponsorStateError } from "./sponsor-schema";
import { SponsorStore } from "./sponsor-store.server";
export class SponsorAssetService extends SponsorStore {
  async actor(
    person: SponsorPerson,
    eventId: string,
    sponsorId: string,
  ): Promise<SponsorMultipartActor> {
    const auth = await this.contact(person, eventId, sponsorId);
    return {
      kind: "sponsor",
      organisationId: auth.organisationId,
      eventId,
      sponsorId,
      personId: person.personId,
      email: person.email,
    };
  }
  private async list(eventId: string, sponsorId: string | null) {
    return (
      await this.env.DB.prepare(`SELECT r.id,r.sponsor_id AS sponsorId,r.name,r.kind,r.required,r.revision,
      r.review_status AS reviewStatus,r.reviewed_version_id AS reviewedVersionId,r.review_note AS reviewNote,
      v.id AS versionId,v.original_filename AS filename,v.upload_status AS uploadStatus,v.scan_status AS scanStatus,v.released_at AS releasedAt,
      CASE WHEN upload.status IN ('requested','initiated') THEN upload.expires_at END AS uploadExpiresAt
      FROM sponsor_asset_requests r LEFT JOIN file_versions v ON v.id=(
        SELECT version.id FROM file_versions version JOIN file_assets asset ON asset.id=version.asset_id AND asset.event_id=version.event_id
        WHERE asset.event_id=r.event_id AND asset.target_type='resource' AND asset.target_id=r.id
          AND asset.status<>'deleted' AND version.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM audit_events WHERE id='file-erasure:'||asset.id)
        ORDER BY version.created_at DESC,version.rowid DESC LIMIT 1)
      LEFT JOIN file_multipart_uploads upload ON upload.version_id=v.id AND upload.event_id=v.event_id
      WHERE r.event_id=? AND (? IS NULL OR r.sponsor_id=?) ORDER BY r.created_at,r.id`)
        .bind(eventId, sponsorId, sponsorId)
        .all<SponsorAsset>()
    ).results;
  }
  async allAdminAssets(viewer: Viewer) {
    await this.admin(viewer);
    return this.list(viewer.eventId, null);
  }
  async adminAssets(viewer: Viewer, sponsorId: string) {
    await this.admin(viewer);
    return this.list(viewer.eventId, sponsorId);
  }
  async portalAssets(
    person: SponsorPerson,
    eventId: string,
    sponsorId: string,
  ) {
    await this.contact(person, eventId, sponsorId);
    return this.list(eventId, sponsorId);
  }
  async filePolicy(eventId: string) {
    const row = await this.env.DB.prepare(
      "SELECT file_policy_json AS policy FROM events WHERE id=?",
    )
      .bind(eventId)
      .first<{ policy: string }>();
    if (!row) throw new Response("Event not found", { status: 404 });
    return parseEventFilePolicy(row.policy);
  }
  async request(
    viewer: Viewer,
    sponsorId: string,
    input: unknown,
    key: string,
  ) {
    const auth = await this.admin(viewer);
    const parsed = z
      .object({
        name: z.string().trim().min(1).max(120),
        kind: z.enum(["logo", "document"]),
        required: z.boolean(),
      })
      .parse(input);
    const id = `sponsor-asset-${crypto.randomUUID()}`;
    return this.commit(
      auth,
      key,
      "sponsor.asset.requested",
      { sponsorId, ...parsed },
      id,
      [
        this.env.DB.prepare(`INSERT INTO sponsor_asset_requests (id,event_id,sponsor_id,name,kind,required)
      SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM event_sponsorships WHERE id=? AND event_id=? AND organisation_id=? AND status='active')
      AND (SELECT count(*) FROM sponsor_asset_requests WHERE sponsor_id=? AND event_id=?)<20`).bind(
          id,
          viewer.eventId,
          sponsorId,
          parsed.name,
          parsed.kind,
          Number(parsed.required),
          sponsorId,
          viewer.eventId,
          viewer.organisationId,
          sponsorId,
          viewer.eventId,
        ),
      ],
    );
  }
  async review(viewer: Viewer, sponsorId: string, input: unknown, key: string) {
    const auth = await this.admin(viewer);
    const p = z
      .object({
        id: z.string(),
        revision: z.coerce.number().int().positive(),
        versionId: z.string().min(1),
        decision: z.enum(["approved", "changes_requested"]),
        note: z.string().trim().max(1000),
      })
      .parse(input);
    if (p.decision === "changes_requested" && !p.note)
      throw new SponsorStateError("Explain what the sponsor needs to change.");
    const a = (await this.list(viewer.eventId, sponsorId)).find(
      (a) => a.id === p.id,
    );
    if (
      !a ||
      a.versionId !== p.versionId ||
      !a.releasedAt ||
      a.scanStatus !== "clean"
    )
      throw new SponsorStateError("Review the latest clean uploaded version.");
    return this.commit(
      auth,
      key,
      "sponsor.asset.reviewed",
      { sponsorId, ...p },
      p.id,
      [
        this.env.DB.prepare(`UPDATE sponsor_asset_requests SET review_status=?,review_note=?,reviewed_version_id=?,revision=revision+1
      WHERE id=? AND event_id=? AND sponsor_id=? AND revision=?
      AND EXISTS (SELECT 1 FROM file_versions v JOIN file_assets a ON a.id=v.asset_id AND a.event_id=v.event_id WHERE v.id=? AND v.event_id=sponsor_asset_requests.event_id AND a.target_id=sponsor_asset_requests.id
        AND v.scan_status='clean' AND v.released_at IS NOT NULL AND v.deleted_at IS NULL AND a.status<>'deleted'
        AND NOT EXISTS (SELECT 1 FROM audit_events WHERE id='file-erasure:'||a.id))
      AND ?=(SELECT v.id FROM file_versions v JOIN file_assets a ON a.id=v.asset_id AND a.event_id=v.event_id
        WHERE a.target_id=sponsor_asset_requests.id AND a.event_id=sponsor_asset_requests.event_id
          AND a.target_type='resource' AND a.status<>'deleted' AND v.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM audit_events WHERE id='file-erasure:'||a.id)
        ORDER BY v.created_at DESC,v.rowid DESC LIMIT 1)`).bind(
          p.decision,
          p.note,
          p.versionId,
          p.id,
          viewer.eventId,
          sponsorId,
          p.revision,
          p.versionId,
          p.versionId,
        ),
      ],
    );
  }
  async portalDownload(
    person: SponsorPerson,
    eventId: string,
    sponsorId: string,
    requestId: string,
    versionId: string,
  ) {
    await this.contact(person, eventId, sponsorId);
    return this.bytes(eventId, requestId, versionId, false, sponsorId);
  }
  async adminDownload(
    viewer: Viewer,
    sponsorId: string,
    requestId: string,
    versionId: string,
    inlineLogo = false,
  ) {
    await this.admin(viewer);
    return this.bytes(
      viewer.eventId,
      requestId,
      versionId,
      inlineLogo,
      sponsorId,
    );
  }
  private async bytes(
    eventId: string,
    requestId: string,
    versionId: string,
    inline: boolean,
    sponsorId?: string,
  ) {
    const read = () =>
      this.env.DB.prepare(`SELECT v.object_key AS objectKey,v.object_etag AS etag,v.original_filename AS filename,v.detected_content_type AS contentType,r.kind
      FROM sponsor_asset_requests r JOIN file_assets a ON a.target_id=r.id AND a.target_type='resource' AND a.event_id=r.event_id
      JOIN file_versions v ON v.asset_id=a.id AND v.event_id=a.event_id
      WHERE r.id=? AND r.event_id=? AND v.id=? AND (? IS NULL OR r.sponsor_id=?) AND a.status<>'deleted'
        AND v.upload_status='uploaded' AND v.signature_status='valid' AND v.scan_status='clean' AND v.released_at IS NOT NULL AND v.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM audit_events WHERE id='file-erasure:'||a.id)
        AND (? IS NOT NULL OR EXISTS (
          SELECT 1 FROM event_public_sites site JOIN events e ON e.id=site.event_id AND e.organisation_id=site.organisation_id,
          json_each(site.published_json,'$.sponsors') sponsor
          WHERE site.event_id=r.event_id AND e.activation_status='active' AND e.participant_retention_completed_at IS NULL
            AND json_extract(sponsor.value,'$.logoUrl')=?
        ))`)
        .bind(
          requestId,
          eventId,
          versionId,
          sponsorId ?? null,
          sponsorId ?? null,
          sponsorId ?? null,
          `/public/sponsor-assets/${eventId}/${requestId}/${versionId}`,
        )
        .first<{
          objectKey: string;
          etag: string;
          filename: string;
          contentType: string;
          kind: string;
        }>();
    const row = await read();
    if (!row) throw new Response("Clean file not found", { status: 404 });
    if (
      inline &&
      (row.kind !== "logo" ||
        !["image/png", "image/jpeg", "image/webp"].includes(row.contentType))
    )
      throw new Response("Logo not found", { status: 404 });
    if (!this.env.FILES)
      throw new Error("Required private R2 binding FILES is unavailable.");
    const object = await this.env.FILES.get(row.objectKey);
    try {
      const current = await read();
      if (
        !current ||
        current.objectKey !== row.objectKey ||
        current.etag !== row.etag ||
        current.contentType !== row.contentType ||
        current.filename !== row.filename ||
        current.kind !== row.kind
      )
        throw new Response("Clean file not found", { status: 404 });
      if (!object || !row.etag || object.httpEtag !== row.etag)
        throw new Error(
          "The private file no longer matches its scanned version.",
        );
    } catch (error) {
      if (object) await object.body.cancel();
      throw error;
    }
    return new Response(object.body, {
      headers: {
        "content-type": row.contentType,
        "content-disposition": `${inline ? "inline" : "attachment"}; filename="${safeDownloadName(row.filename)}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
  async stageLogo(
    viewer: Viewer,
    sponsorId: string,
    requestId: string,
    versionId: string,
    profile: unknown,
    key: string,
  ) {
    await this.admin(viewer);
    const a = (await this.list(viewer.eventId, sponsorId)).find(
      (a) => a.id === requestId,
    );
    if (
      a?.kind !== "logo" ||
      a.versionId !== versionId ||
      sponsorAssetState(a) !== "approved"
    )
      throw new SponsorStateError("Choose the latest approved logo.");
    const id = `sponsor-portal-${sponsorId}`;
    const logoUrl = `/public/sponsor-assets/${viewer.eventId}/${requestId}/${versionId}`;
    const details = {
      ...sponsorInputSchema
        .pick({ name: true, tier: true, description: true, websiteUrl: true })
        .parse(profile),
      logoUrl,
    };
    const site = await this.env.DB.prepare(
      "SELECT draft_revision AS revision FROM event_public_sites WHERE event_id=? AND organisation_id=?",
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{ revision: number }>();
    if (!site)
      throw new SponsorStateError(
        "Save an event website draft before selecting a logo.",
      );
    const authority = await this.admin(viewer);
    return this.commit(
      authority,
      key,
      "sponsor.logo.staged",
      { sponsorId, requestId, versionId, details },
      id,
      [
        atomicBatchGuardStatement(
          this.env,
          `NOT EXISTS (SELECT 1 FROM sponsor_asset_requests r
            JOIN file_versions v ON v.id=r.reviewed_version_id AND v.event_id=r.event_id
            JOIN file_assets a ON a.id=v.asset_id AND a.event_id=v.event_id AND a.target_type='resource' AND a.target_id=r.id
            WHERE r.id=? AND r.event_id=? AND r.sponsor_id=? AND r.reviewed_version_id=? AND r.review_status='approved' AND r.revision=?
              AND v.upload_status='uploaded' AND v.signature_status='valid' AND v.scan_status='clean' AND v.released_at IS NOT NULL
              AND v.deleted_at IS NULL AND a.status<>'deleted'
              AND NOT EXISTS (SELECT 1 FROM audit_events WHERE id='file-erasure:'||a.id)
              AND v.id=(SELECT latest.id FROM file_versions latest JOIN file_assets asset ON asset.id=latest.asset_id AND asset.event_id=latest.event_id
                WHERE asset.event_id=r.event_id AND asset.target_type='resource' AND asset.target_id=r.id AND asset.status<>'deleted' AND latest.deleted_at IS NULL
                  AND NOT EXISTS (SELECT 1 FROM audit_events WHERE id='file-erasure:'||asset.id)
                ORDER BY latest.created_at DESC,latest.rowid DESC LIMIT 1))`,
          [requestId, viewer.eventId, sponsorId, versionId, a.revision],
        ),
        this.env.DB.prepare(`INSERT INTO event_site_sponsors (id,organisation_id,event_id,name,tier,website_url,logo_url,description,position,revision,last_updated_by_person_id,last_operation_id)
        VALUES (?,?,?,?,?,?,?,?,0,1,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,tier=excluded.tier,website_url=excluded.website_url,logo_url=excluded.logo_url,description=excluded.description,revision=event_site_sponsors.revision+1,last_updated_by_person_id=excluded.last_updated_by_person_id,last_operation_id=excluded.last_operation_id,updated_at=unixepoch()
        WHERE event_site_sponsors.event_id=excluded.event_id AND event_site_sponsors.organisation_id=excluded.organisation_id`).bind(
          id,
          viewer.organisationId,
          viewer.eventId,
          details.name,
          details.tier,
          details.websiteUrl,
          details.logoUrl,
          details.description,
          viewer.personId,
          key,
        ),
        atomicBatchGuardStatement(this.env, "changes()<>1", []),
        this.env.DB.prepare(
          `UPDATE event_public_sites SET draft_revision=draft_revision+1,last_operation_id=?,last_updated_by_person_id=?,updated_at=unixepoch() WHERE event_id=? AND organisation_id=? AND draft_revision=?`,
        ).bind(
          key,
          viewer.personId,
          viewer.eventId,
          viewer.organisationId,
          site.revision,
        ),
      ],
    );
  }
  async publicLogo(eventId: string, requestId: string, versionId: string) {
    return this.bytes(eventId, requestId, versionId, true);
  }
}
