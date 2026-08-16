import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { parseEventFilePolicy } from "~/modules/files/file-policy";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ResourceAttachmentAuthoringService } from "./resource-attachment-authoring-service.server";
import {
  parseResourceDocument,
  renderResourceDocument,
  type TiptapNode,
  validateResourceDocumentEmbedStructure,
} from "./resource-content";
import { resourceEmbedConfiguration } from "./resource-embed-policy";
import { ResourcePublicationService } from "./resource-publication-service.server";
import { ResourceServiceBase } from "./resource-service-base.server";
import {
  type PageRow,
  ResourceAudienceError,
  ResourceInvariantError,
  ResourceRevisionConflictError,
  ResourceSlugConflictError,
  resourceInputSchema,
} from "./resource-service-shared";

export class ResourceAuthoringService extends ResourceServiceBase {
  private readonly airtable: AirtableProviderBoundary;
  private readonly publication: ResourcePublicationService;
  private readonly attachments: ResourceAttachmentAuthoringService;

  constructor(
    env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    super(env);
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
    this.publication = new ResourcePublicationService(this.env, this.airtable);
    this.attachments = new ResourceAttachmentAuthoringService(this.env);
  }

  async getAdminWorkspace(viewer: Viewer, selectedId?: string | null) {
    await this.airtable.assertReadable(viewer);
    const embedConfiguration = resourceEmbedConfiguration(this.env);
    const previewEvent = await this.env.DB.prepare(
      `SELECT name, brand_accent AS brandAccent,
              file_policy_json AS filePolicyJson
         FROM events
        WHERE id = ? AND organisation_id = ?`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{ name: string; brandAccent: string; filePolicyJson: string }>();
    if (!previewEvent)
      throw new Response("This event could not be found.", { status: 404 });
    const { filePolicyJson, ...previewEventSummary } = previewEvent;
    const pages = await this.env.DB.prepare(
      `${this.pageSelect()} WHERE rp.event_id = ? ORDER BY rp.status = 'archived', rv.category, rv.title`,
    )
      .bind(viewer.eventId)
      .all<PageRow>();
    const requestedPage = selectedId !== null && selectedId !== undefined;
    const selected = requestedPage
      ? (pages.results.find((page) => page.id === selectedId) ?? null)
      : (pages.results[0] ?? null);
    if (requestedPage && !selected) {
      throw new Response("Resource page not found", { status: 404 });
    }
    for (const page of pages.results) {
      if (
        !page.versionId ||
        page.versionNumber === null ||
        !page.versionStatus ||
        typeof page.title !== "string" ||
        typeof page.slug !== "string" ||
        !page.audienceScope ||
        typeof page.acknowledgementRequired !== "number" ||
        !page.documentJson
      ) {
        throw new ResourceInvariantError(
          page.id,
          "a current version with complete metadata and content is required",
        );
      }
    }
    const audienceCandidates = await this.env.DB.prepare(
      `WITH event_speakers(person_id) AS (
         SELECT person_id FROM memberships
          WHERE event_id = ? AND role = 'speaker'
            AND accepted_at IS NOT NULL AND revoked_at IS NULL
         UNION
         SELECT person_id FROM session_speakers WHERE event_id = ?
       )
       SELECT person.id, person.display_name AS displayName, person.email
         FROM event_speakers
         JOIN people person ON person.id = event_speakers.person_id
        ORDER BY person.display_name, person.email`,
    )
      .bind(viewer.eventId, viewer.eventId)
      .all<{ id: string; displayName: string; email: string }>();
    let attachments: Array<{
      id: string;
      filename: string;
      sizeBytes: number;
      scanStatus: string;
      uploadStatus: string;
    }> = [];
    let audiencePersonIds: string[] = [];
    if (selected?.versionId) {
      const [attachmentRows, audienceRows] = await Promise.all([
        this.env.DB.prepare(
          `
          SELECT fa.id, fv.original_filename AS filename, fv.size_bytes AS sizeBytes,
                 fv.scan_status AS scanStatus, fv.upload_status AS uploadStatus
            FROM resource_attachments ra
            JOIN file_assets fa ON fa.id = ra.file_asset_id AND fa.event_id = ra.event_id
            JOIN file_versions fv ON fv.id = (
              SELECT id FROM file_versions candidate WHERE candidate.asset_id = fa.id ORDER BY version_number DESC LIMIT 1
            )
           WHERE ra.resource_page_version_id = ? ORDER BY ra.position
        `,
        )
          .bind(selected.versionId)
          .all<{
            id: string;
            filename: string;
            sizeBytes: number;
            scanStatus: string;
            uploadStatus: string;
          }>(),
        this.env.DB.prepare(
          `SELECT target_id AS personId
             FROM resource_audiences
            WHERE resource_page_version_id = ? AND event_id = ?
              AND target_type = 'person'
            ORDER BY target_id`,
        )
          .bind(selected.versionId, viewer.eventId)
          .all<{ personId: string }>(),
      ]);
      attachments = attachmentRows.results;
      audiencePersonIds = audienceRows.results.map((row) => row.personId);
    }
    const publicationImpact =
      selected?.versionId && selected.versionStatus === "draft"
        ? await this.publication.getPublicationImpact(viewer, {
            id: selected.id,
            versionId: selected.versionId,
            acknowledgementRequired: selected.acknowledgementRequired,
          })
        : null;
    let document: TiptapNode | null = null;
    if (selected) {
      try {
        document = parseResourceDocument(JSON.parse(selected.documentJson!));
        validateResourceDocumentEmbedStructure(document);
      } catch {
        throw new ResourceInvariantError(
          selected.id,
          "the current version contains invalid content",
        );
      }
    }
    return {
      embedConfiguration,
      previewEvent: {
        ...previewEventSummary,
        filePolicy: parseEventFilePolicy(filePolicyJson),
      },
      pages: pages.results,
      selected: selected
        ? {
            ...selected,
            acknowledgementRequired: Boolean(selected.acknowledgementRequired),
            document: document!,
            attachments,
            audiencePersonIds,
            publicationImpact,
          }
        : null,
      audienceCandidates: audienceCandidates.results,
    };
  }

  async save(
    viewer: Viewer,
    rawInput: unknown,
    command?: {
      operationId: string;
      pageId: string;
      versionId: string;
      auditId: string;
    },
  ) {
    await this.airtable.assertReadable(viewer);
    await this.assertEvent(viewer);
    const parsed = resourceInputSchema.parse(rawInput);
    if (
      parsed.audienceScope === "custom" &&
      (await this.publication.hasInvalidAudience(
        viewer.eventId,
        parsed.audiencePersonIds,
      ))
    )
      throw new ResourceAudienceError();
    const embedConfiguration = resourceEmbedConfiguration(this.env);
    const document = parseResourceDocument(parsed.document);
    const renderedHtml = renderResourceDocument(document, embedConfiguration);
    const audienceIdsJson = JSON.stringify(parsed.audiencePersonIds);
    if (!parsed.id) {
      const pageId = command?.pageId ?? crypto.randomUUID();
      const versionId = command?.versionId ?? crypto.randomUUID();
      if (command) {
        const recovered = await this.env.DB.prepare(
          `SELECT page.id
             FROM resource_pages page
             JOIN events event
               ON event.id = page.event_id AND event.organisation_id = ?
            WHERE page.id = ? AND page.event_id = ?
              AND page.last_operation_id = ?
              AND EXISTS (
                SELECT 1 FROM resource_page_versions version
                 WHERE version.id = ? AND version.resource_page_id = page.id
                   AND version.event_id = page.event_id
              )`,
        )
          .bind(
            viewer.organisationId,
            pageId,
            viewer.eventId,
            command.operationId,
            versionId,
          )
          .first();
        if (recovered) return pageId;
      }
      const [created] = await this.env.DB.batch([
        this.env.DB.prepare(
          `
          INSERT INTO resource_pages (
            id, event_id, title, slug, category, status, audience_scope, acknowledgement_required,
            revision, last_operation_id, created_by_person_id, created_at, updated_at
          ) SELECT ?, ?, ?, ?, ?, 'draft', ?, ?, 1, ?, ?, unixepoch(), unixepoch()
             WHERE NOT EXISTS (
               SELECT 1 FROM resource_pages
                WHERE event_id = ? AND slug = ?
             )
               AND (? <> 'custom' OR NOT EXISTS (
                 SELECT 1 FROM json_each(?) requested
                  WHERE NOT EXISTS (
                    SELECT 1 FROM memberships membership
                     WHERE membership.event_id = ?
                       AND membership.person_id = CAST(requested.value AS TEXT)
                       AND membership.role = 'speaker'
                       AND membership.accepted_at IS NOT NULL
                       AND membership.revoked_at IS NULL
                    UNION ALL
                    SELECT 1 FROM session_speakers relationship
                     WHERE relationship.event_id = ?
                       AND relationship.person_id = CAST(requested.value AS TEXT)
                  )
               ))
        `,
        ).bind(
          pageId,
          viewer.eventId,
          parsed.title,
          parsed.slug,
          parsed.category || null,
          parsed.audienceScope,
          parsed.acknowledgementRequired ? 1 : 0,
          command?.operationId ?? null,
          viewer.personId,
          viewer.eventId,
          parsed.slug,
          parsed.audienceScope,
          audienceIdsJson,
          viewer.eventId,
          viewer.eventId,
        ),
        this.env.DB.prepare(
          `
          INSERT INTO resource_page_versions (
            id, event_id, resource_page_id, version_number, title, slug, category,
            audience_scope, acknowledgement_required, document_json, rendered_html,
            status, created_by_person_id, created_at
          ) SELECT ?, page.event_id, page.id, 1, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, unixepoch()
              FROM resource_pages page
             WHERE page.id = ? AND page.event_id = ?
        `,
        ).bind(
          versionId,
          parsed.title,
          parsed.slug,
          parsed.category || null,
          parsed.audienceScope,
          parsed.acknowledgementRequired ? 1 : 0,
          JSON.stringify(document),
          renderedHtml,
          viewer.personId,
          pageId,
          viewer.eventId,
        ),
        this.env.DB.prepare(
          `
          INSERT INTO resource_audiences (
            resource_page_version_id, event_id, target_type, target_id, created_at
          )
          SELECT ?, ?, 'person', CAST(requested.value AS TEXT), unixepoch()
            FROM json_each(?) requested
           WHERE ? = 'custom'
             AND EXISTS (
               SELECT 1 FROM resource_page_versions version
                WHERE version.id = ? AND version.event_id = ?
                  AND version.resource_page_id = ? AND version.status = 'draft'
             )
        `,
        ).bind(
          versionId,
          viewer.eventId,
          audienceIdsJson,
          parsed.audienceScope,
          versionId,
          viewer.eventId,
          pageId,
        ),
        this.env.DB.prepare(
          `
          INSERT OR IGNORE INTO audit_events (
            id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
          ) SELECT ?, 'person', 'admin_ui', 1, ?, page.event_id, ?, 'resource.created', 'resource_page', page.id, '{}', unixepoch()
              FROM resource_pages page
             WHERE page.id = ? AND page.event_id = ?
        `,
        ).bind(
          command?.auditId ?? crypto.randomUUID(),
          viewer.organisationId,
          viewer.personId,
          pageId,
          viewer.eventId,
        ),
      ]);
      if ((created.meta.changes ?? 0) !== 1) {
        if (command) {
          const recovered = await this.env.DB.prepare(
            `SELECT 1 FROM resource_pages page
              WHERE page.id = ? AND page.event_id = ?
                AND page.last_operation_id = ?
                AND EXISTS (
                  SELECT 1 FROM resource_page_versions version
                   WHERE version.id = ? AND version.resource_page_id = page.id
                     AND version.event_id = page.event_id
                )`,
          )
            .bind(pageId, viewer.eventId, command.operationId, versionId)
            .first();
          if (recovered) return pageId;
        }
        if (
          parsed.audienceScope === "custom" &&
          (await this.publication.hasInvalidAudience(
            viewer.eventId,
            parsed.audiencePersonIds,
          ))
        )
          throw new ResourceAudienceError();
      }
      if ((created.meta.changes ?? 0) !== 1) {
        throw new ResourceSlugConflictError();
      }
      return pageId;
    }
    if (!parsed.revision) throw new ResourceRevisionConflictError();
    if (command) {
      const recovered = await this.env.DB.prepare(
        `SELECT 1 FROM resource_pages page
          WHERE page.id = ? AND page.event_id = ?
            AND page.last_operation_id = ? AND page.revision = ?
            AND EXISTS (
              SELECT 1 FROM resource_page_versions version
               WHERE version.id = ? AND version.resource_page_id = page.id
                 AND version.event_id = page.event_id
                 AND version.status = 'draft'
            )`,
      )
        .bind(
          parsed.id,
          viewer.eventId,
          command.operationId,
          parsed.revision + 1,
          command.versionId,
        )
        .first();
      if (recovered) return parsed.id;
    }
    const current = await this.env.DB.prepare(
      `
      SELECT revision, status,
             (SELECT COALESCE(MAX(version_number), 0) FROM resource_page_versions WHERE resource_page_id = resource_pages.id) AS versionNumber,
             (SELECT id FROM resource_page_versions WHERE resource_page_id = resource_pages.id ORDER BY version_number DESC LIMIT 1) AS latestVersionId
        FROM resource_pages WHERE id = ? AND event_id = ?
    `,
    )
      .bind(parsed.id, viewer.eventId)
      .first<{
        revision: number;
        status: string;
        versionNumber: number;
        latestVersionId: string | null;
      }>();
    if (!current || current.revision !== parsed.revision)
      throw new ResourceRevisionConflictError();
    const versionId = command?.versionId ?? crypto.randomUUID();
    const saveOperationId = command?.operationId ?? crypto.randomUUID();
    const [updated] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE resource_pages SET
          title = CASE WHEN status = 'draft' THEN ? ELSE title END,
          slug = CASE WHEN status = 'draft' THEN ? ELSE slug END,
          category = CASE WHEN status = 'draft' THEN ? ELSE category END,
          audience_scope = CASE WHEN status = 'draft' THEN ? ELSE audience_scope END,
          acknowledgement_required = CASE WHEN status = 'draft' THEN ? ELSE acknowledgement_required END,
          revision = revision + 1, last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND revision = ?
           AND (
             status <> 'draft'
             OR NOT EXISTS (
               SELECT 1 FROM resource_pages slug_owner
                WHERE slug_owner.event_id = resource_pages.event_id
                  AND slug_owner.slug = ? AND slug_owner.id <> resource_pages.id
             )
           )
           AND (? <> 'custom' OR NOT EXISTS (
             SELECT 1 FROM json_each(?) requested
              WHERE NOT EXISTS (
                SELECT 1 FROM memberships membership
                 WHERE membership.event_id = resource_pages.event_id
                   AND membership.person_id = CAST(requested.value AS TEXT)
                   AND membership.role = 'speaker'
                   AND membership.accepted_at IS NOT NULL
                   AND membership.revoked_at IS NULL
                UNION ALL
                SELECT 1 FROM session_speakers relationship
                 WHERE relationship.event_id = resource_pages.event_id
                   AND relationship.person_id = CAST(requested.value AS TEXT)
              )
           ))
      `,
      ).bind(
        parsed.title,
        parsed.slug,
        parsed.category || null,
        parsed.audienceScope,
        parsed.acknowledgementRequired ? 1 : 0,
        saveOperationId,
        parsed.id,
        viewer.eventId,
        parsed.revision,
        parsed.slug,
        parsed.audienceScope,
        audienceIdsJson,
      ),
      this.env.DB.prepare(
        `
        UPDATE resource_page_versions SET status = 'retired'
         WHERE resource_page_id = ? AND status = 'draft'
           AND EXISTS (
             SELECT 1 FROM resource_pages
              WHERE id = ? AND event_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(parsed.id, parsed.id, viewer.eventId, saveOperationId),
      this.env.DB.prepare(
        `
        INSERT INTO resource_page_versions (
          id, event_id, resource_page_id, version_number, title, slug, category,
          audience_scope, acknowledgement_required, document_json, rendered_html,
          status, created_by_person_id, created_at
        ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM resource_pages
             WHERE id = ? AND event_id = ? AND last_operation_id = ?
          )
      `,
      ).bind(
        versionId,
        viewer.eventId,
        parsed.id,
        current.versionNumber + 1,
        parsed.title,
        parsed.slug,
        parsed.category || null,
        parsed.audienceScope,
        parsed.acknowledgementRequired ? 1 : 0,
        JSON.stringify(document),
        renderedHtml,
        viewer.personId,
        parsed.id,
        viewer.eventId,
        saveOperationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO resource_audiences (
          resource_page_version_id, event_id, target_type, target_id, created_at
        )
        SELECT ?, ?, 'person', CAST(requested.value AS TEXT), unixepoch()
         FROM json_each(?) requested
         WHERE ? = 'custom'
           AND EXISTS (
             SELECT 1 FROM resource_pages
              WHERE id = ? AND event_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        versionId,
        viewer.eventId,
        audienceIdsJson,
        parsed.audienceScope,
        parsed.id,
        viewer.eventId,
        saveOperationId,
      ),
      this.env.DB.prepare(
        `
        INSERT OR IGNORE INTO resource_attachments (
          resource_page_version_id, event_id, file_asset_id, position, label
        )
        SELECT ?, event_id, file_asset_id, position, label
         FROM resource_attachments
         WHERE resource_page_version_id = ?
           AND EXISTS (
             SELECT 1 FROM resource_pages
              WHERE id = ? AND event_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        versionId,
        current.latestVersionId,
        parsed.id,
        viewer.eventId,
        saveOperationId,
      ),
      this.env.DB.prepare(
        `
        INSERT OR IGNORE INTO audit_events (
          id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
        ) SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'resource.draft.saved', 'resource_page', ?, ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM resource_pages
             WHERE id = ? AND event_id = ? AND last_operation_id = ?
          )
      `,
      ).bind(
        command?.auditId ?? crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.id,
        JSON.stringify({ versionNumber: current.versionNumber + 1 }),
        parsed.id,
        viewer.eventId,
        saveOperationId,
      ),
    ]);
    if ((updated.meta.changes ?? 0) !== 1) {
      if (command) {
        const recovered = await this.env.DB.prepare(
          `SELECT 1 FROM resource_pages page
            WHERE page.id = ? AND page.event_id = ?
              AND page.last_operation_id = ? AND page.revision = ?
              AND EXISTS (
                SELECT 1 FROM resource_page_versions version
                 WHERE version.id = ? AND version.resource_page_id = page.id
                   AND version.event_id = page.event_id
                   AND version.status = 'draft'
              )`,
        )
          .bind(
            parsed.id,
            viewer.eventId,
            command.operationId,
            parsed.revision + 1,
            command.versionId,
          )
          .first();
        if (recovered) return parsed.id;
      }
      if (
        parsed.audienceScope === "custom" &&
        (await this.publication.hasInvalidAudience(
          viewer.eventId,
          parsed.audiencePersonIds,
        ))
      )
        throw new ResourceAudienceError();
      if (
        await this.publication.hasSlugConflict(
          viewer.eventId,
          parsed.slug,
          parsed.id,
        )
      )
        throw new ResourceSlugConflictError();
      throw new ResourceRevisionConflictError();
    }
    return parsed.id;
  }

  publish(...args: Parameters<ResourcePublicationService["publish"]>) {
    return this.publication.publish(...args);
  }

  attachToDraft(
    ...args: Parameters<ResourceAttachmentAuthoringService["attachToDraft"]>
  ) {
    return this.attachments.attachToDraft(...args);
  }
}
