import { z } from "zod";
import type { Viewer } from "~/platform/auth/authorize.server";
import { revisionInputSchema, sponsorInputSchema } from "./public-site";
import {
  parsePublicSiteCommandReplay,
  preparePublicSiteCommand,
  publicSiteCommandClaimStatements,
  publicSiteCommandCompletionStatement,
  publicSiteCommandGuard,
  resolvePublicSiteCommandRace,
} from "./public-site-command.server";
import {
  PublicSiteRevisionConflictError,
  PublicSiteValidationError,
} from "./public-site-errors";
import {
  publicSiteAtomicBatch,
  publicSiteAtomicMutationGuard,
  publicSiteChangeSequence,
  publicSiteMutationEvidence,
} from "./public-site-mutation-evidence.server";

const entityCommandResponseSchema = z.object({ id: z.string().min(1) });
const emptyCommandResponseSchema = z.object({});

type SiteRow = {
  draftJson: string;
  draftRevision: number;
  publishedJson: string | null;
  publishedRevision: number | null;
  publishedAt: number | null;
};

export class PublicSiteSponsorWorkflow {
  constructor(private readonly env: CloudflareEnvironment) {}

  private async site(viewer: Pick<Viewer, "eventId" | "organisationId">) {
    return this.env.DB.prepare(
      `SELECT draft_json AS draftJson, draft_revision AS draftRevision,
              published_json AS publishedJson,
              published_revision AS publishedRevision,
              published_at AS publishedAt
         FROM event_public_sites
        WHERE event_id = ? AND organisation_id = ?`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<SiteRow>();
  }

  async saveSponsor(viewer: Viewer, input: unknown) {
    const parsed = sponsorInputSchema.parse(input);
    const prepared = await preparePublicSiteCommand(
      this.env,
      viewer,
      "public_site.sponsor.save",
      parsed.commandId,
      {
        id: parsed.id,
        revision: parsed.revision,
        name: parsed.name,
        tier: parsed.tier,
        websiteUrl: parsed.websiteUrl,
        logoUrl: parsed.logoUrl,
        description: parsed.description,
        position: parsed.position,
      },
    );
    if (prepared.replay)
      return parsePublicSiteCommandReplay(
        prepared.replay,
        entityCommandResponseSchema,
      );
    const command = prepared.command;
    const site = await this.site(viewer);
    if (!site)
      throw new PublicSiteValidationError(
        "Save the public-site draft before adding sponsors.",
      );
    const id = parsed.id ?? crypto.randomUUID();
    const operationId = command.id;
    const commandGuard = publicSiteCommandGuard(viewer, command);
    const mutation = parsed.id
      ? this.env.DB.prepare(
          `UPDATE event_site_sponsors
              SET name = ?, tier = ?, website_url = ?, logo_url = ?,
                  description = ?, position = ?, revision = revision + 1,
                  last_updated_by_person_id = ?, last_operation_id = ?,
                  updated_at = unixepoch()
            WHERE id = ? AND event_id = ? AND organisation_id = ? AND revision = ?
              AND EXISTS (
                SELECT 1 FROM event_public_sites site
                 WHERE site.event_id = event_site_sponsors.event_id
                   AND site.organisation_id = event_site_sponsors.organisation_id
                   AND site.draft_revision = ?
              )
              AND EXISTS (${commandGuard.sql})`,
        ).bind(
          parsed.name,
          parsed.tier,
          parsed.websiteUrl,
          parsed.logoUrl,
          parsed.description,
          parsed.position,
          viewer.personId,
          operationId,
          id,
          viewer.eventId,
          viewer.organisationId,
          parsed.revision,
          site.draftRevision,
          ...commandGuard.bindings,
        )
      : this.env.DB.prepare(
          `INSERT INTO event_site_sponsors (
             id, organisation_id, event_id, name, tier, website_url, logo_url,
             description, position, revision, last_updated_by_person_id,
             last_operation_id, created_at, updated_at
           ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, unixepoch(), unixepoch()
              WHERE EXISTS (
                SELECT 1 FROM event_public_sites site
                 WHERE site.event_id = ? AND site.organisation_id = ?
                   AND site.draft_revision = ?
              )
                AND EXISTS (${commandGuard.sql})`,
        ).bind(
          id,
          viewer.organisationId,
          viewer.eventId,
          parsed.name,
          parsed.tier,
          parsed.websiteUrl,
          parsed.logoUrl,
          parsed.description,
          parsed.position,
          viewer.personId,
          operationId,
          viewer.eventId,
          viewer.organisationId,
          site.draftRevision,
          ...commandGuard.bindings,
        );
    const mutationDescriptor = {
      action: parsed.id
        ? "public_site.sponsor_updated"
        : "public_site.sponsor_created",
      entityType: "event_sponsor",
      entityId: id,
      changeType: parsed.id ? ("updated" as const) : ("created" as const),
      metadata: { name: parsed.name, tier: parsed.tier },
    };
    const mutationResult = { id };
    const mutationActivation = {
      sql: `SELECT 1 FROM event_site_sponsors
             WHERE id = ? AND event_id = ? AND organisation_id = ?
               AND last_operation_id = ?`,
      bindings: [id, viewer.eventId, viewer.organisationId, operationId],
    };
    const sponsorState = {
      sql: `SELECT 1 FROM event_site_sponsors sponsor
             WHERE sponsor.id = ? AND sponsor.event_id = ?
               AND sponsor.organisation_id = ? AND sponsor.name = ?
               AND sponsor.tier = ? AND sponsor.website_url IS ?
               AND sponsor.logo_url IS ? AND sponsor.description IS ?
               AND sponsor.position = ? AND sponsor.revision = ?
               AND sponsor.last_operation_id = ?
               AND EXISTS (
                 SELECT 1 FROM event_public_sites site
                  WHERE site.event_id = sponsor.event_id
                    AND site.organisation_id = sponsor.organisation_id
                    AND site.draft_revision = ?
                    AND site.last_operation_id = ?
               )`,
      bindings: [
        id,
        viewer.eventId,
        viewer.organisationId,
        parsed.name,
        parsed.tier,
        parsed.websiteUrl,
        parsed.logoUrl,
        parsed.description,
        parsed.position,
        parsed.id ? parsed.revision + 1 : 1,
        operationId,
        site.draftRevision + 1,
        operationId,
      ],
    };
    const evidence = publicSiteMutationEvidence(
      this.env,
      viewer,
      operationId,
      mutationDescriptor,
      mutationActivation,
    );
    const results = await publicSiteAtomicBatch(this.env, [
      ...publicSiteCommandClaimStatements(this.env, viewer, command),
      mutation,
      this.env.DB.prepare(
        `UPDATE event_public_sites
            SET draft_revision = draft_revision + 1,
                last_updated_by_person_id = ?, last_operation_id = ?,
                updated_at = unixepoch()
          WHERE event_id = ? AND organisation_id = ?
            AND draft_revision = ?
            AND EXISTS (
              SELECT 1 FROM event_site_sponsors
               WHERE id = ? AND event_id = ? AND last_operation_id = ?
            )`,
      ).bind(
        viewer.personId,
        operationId,
        viewer.eventId,
        viewer.organisationId,
        site.draftRevision,
        id,
        viewer.eventId,
        operationId,
      ),
      ...evidence,
      publicSiteCommandCompletionStatement(
        this.env,
        viewer,
        command,
        mutationResult,
      ),
      publicSiteAtomicMutationGuard(
        this.env,
        viewer,
        command,
        mutationDescriptor,
        mutationResult,
        mutationActivation,
        sponsorState,
      ),
    ]);
    if ((results[2]?.meta.changes ?? 0) !== 1) {
      const replay = await resolvePublicSiteCommandRace(
        this.env,
        viewer,
        command,
      );
      if (replay)
        return parsePublicSiteCommandReplay(
          replay,
          entityCommandResponseSchema,
        );
      throw new PublicSiteRevisionConflictError();
    }
    return { id, changeSequence: publicSiteChangeSequence(results[5]) };
  }
  async deleteSponsor(viewer: Viewer, input: unknown) {
    const parsed = revisionInputSchema.parse(input);
    const prepared = await preparePublicSiteCommand(
      this.env,
      viewer,
      "public_site.sponsor.delete",
      parsed.commandId,
      { id: parsed.id, revision: parsed.revision, confirmed: parsed.confirmed },
    );
    if (prepared.replay)
      return parsePublicSiteCommandReplay(
        prepared.replay,
        emptyCommandResponseSchema,
      );
    const command = prepared.command;
    const site = await this.site(viewer);
    if (!site)
      throw new PublicSiteValidationError(
        "Save the public-site draft before removing sponsors.",
      );
    const operationId = command.id;
    const commandGuard = publicSiteCommandGuard(viewer, command);
    const mutationDescriptor = {
      action: "public_site.sponsor_deleted",
      entityType: "event_sponsor",
      entityId: parsed.id,
      changeType: "deleted" as const,
      metadata: { revision: parsed.revision },
    };
    const mutationResult = {};
    const mutationActivation = {
      sql: `SELECT 1 FROM event_public_sites
             WHERE event_id = ? AND organisation_id = ?
               AND last_operation_id = ?`,
      bindings: [viewer.eventId, viewer.organisationId, operationId],
    };
    const sponsorDeletionState = {
      sql: `SELECT 1 FROM event_public_sites site
             WHERE site.event_id = ? AND site.organisation_id = ?
               AND site.draft_revision = ?
               AND site.last_operation_id = ?
               AND NOT EXISTS (
                 SELECT 1 FROM event_site_sponsors sponsor
                  WHERE sponsor.id = ? AND sponsor.event_id = site.event_id
                    AND sponsor.organisation_id = site.organisation_id
               )`,
      bindings: [
        viewer.eventId,
        viewer.organisationId,
        site.draftRevision + 1,
        operationId,
        parsed.id,
      ],
    };
    const evidence = publicSiteMutationEvidence(
      this.env,
      viewer,
      operationId,
      mutationDescriptor,
      mutationActivation,
    );
    const results = await publicSiteAtomicBatch(this.env, [
      ...publicSiteCommandClaimStatements(this.env, viewer, command),
      this.env.DB.prepare(
        `UPDATE event_public_sites
            SET draft_revision = draft_revision + 1,
                last_updated_by_person_id = ?, last_operation_id = ?,
                updated_at = unixepoch()
          WHERE event_id = ? AND organisation_id = ?
            AND draft_revision = ?
            AND EXISTS (${commandGuard.sql})
            AND EXISTS (
              SELECT 1 FROM event_site_sponsors
               WHERE id = ? AND event_id = ? AND organisation_id = ?
                 AND revision = ?
            )`,
      ).bind(
        viewer.personId,
        operationId,
        viewer.eventId,
        viewer.organisationId,
        site.draftRevision,
        ...commandGuard.bindings,
        parsed.id,
        viewer.eventId,
        viewer.organisationId,
        parsed.revision,
      ),
      this.env.DB.prepare(
        `DELETE FROM event_site_sponsors
          WHERE id = ? AND event_id = ? AND organisation_id = ? AND revision = ?
            AND EXISTS (
              SELECT 1 FROM event_public_sites
               WHERE event_id = ? AND organisation_id = ?
                 AND last_operation_id = ?
            )`,
      ).bind(
        parsed.id,
        viewer.eventId,
        viewer.organisationId,
        parsed.revision,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      ...evidence,
      publicSiteCommandCompletionStatement(
        this.env,
        viewer,
        command,
        mutationResult,
      ),
      publicSiteAtomicMutationGuard(
        this.env,
        viewer,
        command,
        mutationDescriptor,
        mutationResult,
        mutationActivation,
        sponsorDeletionState,
      ),
    ]);
    if (
      (results[2]?.meta.changes ?? 0) !== 1 ||
      (results[3]?.meta.changes ?? 0) !== 1
    ) {
      const replay = await resolvePublicSiteCommandRace(
        this.env,
        viewer,
        command,
      );
      if (replay)
        return parsePublicSiteCommandReplay(replay, emptyCommandResponseSchema);
      throw new PublicSiteRevisionConflictError();
    }
    return { changeSequence: publicSiteChangeSequence(results[5]) };
  }
}
