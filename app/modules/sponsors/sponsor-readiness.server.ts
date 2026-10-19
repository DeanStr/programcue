import { z } from "zod";
import { CommunicationDraftService } from "~/modules/communications/communication-draft-service.server";
import { CommunicationService } from "~/modules/communications/communication-service.server";
import { sourceVariables } from "~/modules/communications/communication-service-shared";
import { namedRecipient } from "~/modules/communications/manual-recipients";
import type { Viewer } from "~/platform/auth/authorize.server";
import { SponsorAssetService } from "./sponsor-assets.server";
import {
  matchesSponsorReadiness,
  sponsorFiltersSchema,
  sponsorReadiness,
} from "./sponsor-readiness";
import { SponsorStateError } from "./sponsor-schema";
import { SponsorService } from "./sponsor-service.server";
export class SponsorReadinessService {
  constructor(private readonly env: CloudflareEnvironment) {}
  async workspace(viewer: Viewer, input: unknown) {
    const parsed = sponsorFiltersSchema.safeParse(input);
    if (!parsed.success)
      throw new Response("Invalid sponsor filters", { status: 400 });
    const filters = parsed.data;
    const service = new SponsorService(this.env);
    const sponsors = await service.listAdmin(viewer);
    const now = Math.floor(Date.now() / 1000);
    const [contacts, proposals, assets] = await Promise.all([
      this.env.DB.prepare(
        `SELECT c.sponsor_id AS sponsorId,c.name,c.email,c.accepted_at AS acceptedAt,c.revoked_at AS revokedAt FROM sponsor_contacts c JOIN event_sponsorships s ON s.id=c.sponsor_id AND s.event_id=c.event_id WHERE c.event_id=? AND s.organisation_id=?`,
      )
        .bind(viewer.eventId, viewer.organisationId)
        .all<{
          sponsorId: string;
          name: string;
          email: string;
          acceptedAt: number | null;
          revokedAt: number | null;
        }>(),
      this.env.DB.prepare(
        `SELECT p.sponsor_id AS sponsorId,p.status FROM sponsored_session_proposals p JOIN event_sponsorships s ON s.id=p.sponsor_id AND s.event_id=p.event_id WHERE p.event_id=? AND s.organisation_id=?`,
      )
        .bind(viewer.eventId, viewer.organisationId)
        .all<{ sponsorId: string; status: string }>(),
      new SponsorAssetService(this.env).allAdminAssets(viewer),
    ]);
    const rows = sponsors
      .filter((s) => s.status === "active")
      .map((sponsor) => ({
        ...sponsor,
        readiness: sponsorReadiness(
          {
            ...sponsor,
            contacts: contacts.results.filter(
              (c) => c.sponsorId === sponsor.id,
            ),
            proposals: proposals.results.filter(
              (p) => p.sponsorId === sponsor.id,
            ),
            assets: assets.filter((a) => a.sponsorId === sponsor.id),
          },
          now,
        ),
      }));
    const matching = rows.filter((row) =>
      matchesSponsorReadiness(row, filters),
    );
    const recipients = [
      ...new Map(
        matching
          .flatMap((row) => row.readiness.recipients)
          .map((c) => [c.email.toLowerCase(), c]),
      ).values(),
    ];
    const centre = await new CommunicationService(this.env).listCentre(viewer);
    const templates = centre.templates.filter(
      (t) =>
        t.versionStatus === "published" &&
        ["task_reminder", "ad_hoc"].includes(t.category) &&
        sourceVariables(t).length === 0,
    );
    return { filters, rows: matching, recipients, templates };
  }
  async reminder(
    viewer: Viewer,
    filters: unknown,
    templateVersionId: string,
    draftId: string,
  ) {
    z.uuid().parse(draftId);
    const w = await this.workspace(viewer, filters);
    if (!w.recipients.length)
      throw new SponsorStateError(
        "No matching sponsors have outstanding work they can complete before their editing deadline.",
      );
    if (!w.templates.some((t) => t.id === templateVersionId))
      throw new SponsorStateError(
        "Choose a published reminder or ad hoc template without record-specific fields.",
      );
    return new CommunicationDraftService(this.env).create(
      viewer,
      {
        templateVersionId,
        audienceType: "manual",
        manualRecipients: w.recipients
          .map((c) => namedRecipient(c.name, c.email))
          .join("\n"),
        kind: "transactional",
        scheduledAt: null,
      },
      { draftId, idempotencyKey: `sponsor-readiness:${draftId}` },
    );
  }
}
