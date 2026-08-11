import type { Viewer } from "~/platform/auth/authorize.server";
import {
  AirtableProviderBoundary,
  airtableCommandKey,
} from "~/modules/airtable/airtable-provider-boundary.server";
import { parseEventFilePolicy } from "~/modules/files/file-policy";
import {
  appendEmbeds,
  parseResourceDocument,
  renderResourceDocument,
  type TiptapNode,
} from "./resource-content";
import { parseResourceEmbedOrigins } from "./resource-embed-policy";
import { ResourceServiceBase } from "./resource-service-base.server";
import {
  participantAudienceSql,
  resourceInputSchema,
  ResourceAudienceError,
  ResourceInvariantError,
  ResourceRevisionConflictError,
  ResourceSlugConflictError,
  ResourceTaskDependencyError,
  successfulResourcePublishAttemptSql,
  type PageRow,
  type ResourcePublishPage,
} from "./resource-service-shared";

const publicationCandidateAudienceSql = `(
  publish_version.audience_scope = 'all_speakers'
  OR (
    publish_version.audience_scope = 'accepted_speakers'
    AND EXISTS (
      SELECT 1 FROM session_speakers accepted_relationship
       WHERE accepted_relationship.event_id = resource_pages.event_id
         AND accepted_relationship.person_id = candidate.id
    )
  )
  OR (
    publish_version.audience_scope = 'custom'
    AND EXISTS (
      SELECT 1 FROM resource_audiences audience
       WHERE audience.resource_page_version_id = publish_version.id
         AND audience.event_id = resource_pages.event_id
         AND (
           (audience.target_type = 'person' AND audience.target_id = candidate.id)
           OR (audience.target_type = 'role' AND audience.target_id = 'speaker')
           OR (
             audience.target_type = 'session'
             AND EXISTS (
               SELECT 1 FROM session_speakers session_relationship
                WHERE session_relationship.event_id = resource_pages.event_id
                  AND session_relationship.session_id = audience.target_id
                  AND session_relationship.person_id = candidate.id
             )
           )
         )
    )
  )
)`;

const publicationAudienceGuardSql = `
  AND (
    publish_version.audience_scope <> 'custom'
    OR NOT EXISTS (
      SELECT 1 FROM resource_audiences selected_person
       WHERE selected_person.resource_page_version_id = publish_version.id
         AND selected_person.event_id = resource_pages.event_id
         AND selected_person.target_type = 'person'
         AND NOT EXISTS (
           SELECT 1 FROM memberships current_membership
            WHERE current_membership.event_id = resource_pages.event_id
              AND current_membership.person_id = selected_person.target_id
              AND current_membership.role = 'speaker'
              AND current_membership.accepted_at IS NOT NULL
              AND current_membership.revoked_at IS NULL
           UNION ALL
           SELECT 1 FROM session_speakers current_relationship
            WHERE current_relationship.event_id = resource_pages.event_id
              AND current_relationship.person_id = selected_person.target_id
         )
    )
  )
  AND (
    publish_version.acknowledgement_required = 0
    OR (
      (
        SELECT COUNT(*)
          FROM people candidate
         WHERE (
           EXISTS (
             SELECT 1 FROM memberships candidate_membership
              WHERE candidate_membership.event_id = resource_pages.event_id
                AND candidate_membership.person_id = candidate.id
                AND candidate_membership.role = 'speaker'
                AND candidate_membership.accepted_at IS NOT NULL
                AND candidate_membership.revoked_at IS NULL
           )
           OR EXISTS (
             SELECT 1 FROM session_speakers candidate_relationship
              WHERE candidate_relationship.event_id = resource_pages.event_id
                AND candidate_relationship.person_id = candidate.id
           )
         )
           AND ${publicationCandidateAudienceSql}
      ) = json_array_length(?)
      AND NOT EXISTS (
        SELECT 1
          FROM people candidate
         WHERE (
           EXISTS (
             SELECT 1 FROM memberships candidate_membership
              WHERE candidate_membership.event_id = resource_pages.event_id
                AND candidate_membership.person_id = candidate.id
                AND candidate_membership.role = 'speaker'
                AND candidate_membership.accepted_at IS NOT NULL
                AND candidate_membership.revoked_at IS NULL
           )
           OR EXISTS (
             SELECT 1 FROM session_speakers candidate_relationship
              WHERE candidate_relationship.event_id = resource_pages.event_id
                AND candidate_relationship.person_id = candidate.id
           )
         )
           AND ${publicationCandidateAudienceSql}
           AND candidate.id NOT IN (
             SELECT CAST(value AS TEXT) FROM json_each(?)
           )
      )
    )
  )
`;

export class ResourceAuthoringService extends ResourceServiceBase {
  private readonly airtable: AirtableProviderBoundary;

  constructor(
    env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    super(env);
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
  }

  async getAdminWorkspace(viewer: Viewer, selectedId?: string | null) {
    await this.airtable.assertReadable(viewer);
    const resourceEmbedOrigins = parseResourceEmbedOrigins(
      this.env.RESOURCE_EMBED_ORIGINS,
    );
    const previewEvent = await this.env.DB.prepare(
      `SELECT name, brand_accent AS brandAccent,
              file_policy_json AS filePolicyJson
         FROM events
        WHERE id = ? AND organisation_id = ?`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{ name: string; brandAccent: string; filePolicyJson: string }>();
    if (!previewEvent) throw new Response("Event not found.", { status: 404 });
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
        ? await this.getPublicationImpact(viewer, {
            id: selected.id,
            versionId: selected.versionId,
            acknowledgementRequired: selected.acknowledgementRequired,
          })
        : null;
    let document: TiptapNode | null = null;
    if (selected) {
      try {
        document = parseResourceDocument(JSON.parse(selected.documentJson!));
      } catch {
        throw new ResourceInvariantError(
          selected.id,
          "the current version contains invalid content",
        );
      }
    }
    return {
      resourceEmbedOrigins,
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
      (await this.hasInvalidAudience(viewer.eventId, parsed.audiencePersonIds))
    )
      throw new ResourceAudienceError();
    const resourceEmbedOrigins = parseResourceEmbedOrigins(
      this.env.RESOURCE_EMBED_ORIGINS,
    );
    const document = appendEmbeds(
      parseResourceDocument(parsed.document),
      parsed.embedUrls,
      resourceEmbedOrigins,
    );
    const renderedHtml = renderResourceDocument(document, resourceEmbedOrigins);
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
            id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
          ) SELECT ?, ?, page.event_id, ?, 'resource.created', 'resource_page', page.id, '{}', unixepoch()
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
          (await this.hasInvalidAudience(
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
          id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
        ) SELECT ?, ?, ?, ?, 'resource.draft.saved', 'resource_page', ?, ?, unixepoch()
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
        (await this.hasInvalidAudience(
          viewer.eventId,
          parsed.audiencePersonIds,
        ))
      )
        throw new ResourceAudienceError();
      if (await this.hasSlugConflict(viewer.eventId, parsed.slug, parsed.id))
        throw new ResourceSlugConflictError();
      throw new ResourceRevisionConflictError();
    }
    return parsed.id;
  }

  private async hasInvalidAudience(eventId: string, personIds: string[]) {
    if (!personIds.length) return false;
    const row = await this.env.DB.prepare(
      `SELECT 1 FROM json_each(?) requested
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
        LIMIT 1`,
    )
      .bind(JSON.stringify(personIds), eventId, eventId)
      .first();
    return Boolean(row);
  }

  private async hasSlugConflict(eventId: string, slug: string, pageId: string) {
    return Boolean(
      await this.env.DB.prepare(
        `SELECT 1 FROM resource_pages
          WHERE event_id = ? AND slug = ? AND id <> ? LIMIT 1`,
      )
        .bind(eventId, slug, pageId)
        .first(),
    );
  }

  private async customAudiencePersonIds(eventId: string, versionId: string) {
    const audience = await this.env.DB.prepare(
      `SELECT target_id AS id FROM resource_audiences
        WHERE event_id = ? AND resource_page_version_id = ?
          AND target_type = 'person'
        ORDER BY target_id`,
    )
      .bind(eventId, versionId)
      .all<{ id: string }>();
    return audience.results.map((target) => target.id);
  }

  private async acknowledgementTaskStatements(
    viewer: Viewer,
    page: {
      id: string;
      title: string;
      versionId: string;
      acknowledgementRequired: number;
    },
    operationId: string,
    eligibleIds: string[],
  ) {
    const templateId = `resource-ack:${page.id}`;
    if (!page.acknowledgementRequired) {
      return [
        this.env.DB.prepare(
          `
          UPDATE task_instances
             SET status = 'waived', readiness_state = 'on_track', readiness_percent = 100,
                 evidence_json = ?, completed_at = unixepoch(), completed_by_person_id = ?,
                 revision = revision + 1, updated_at = unixepoch()
           WHERE event_id = ? AND template_id = ? AND status NOT IN ('completed','waived')
             AND ${successfulResourcePublishAttemptSql}
        `,
        ).bind(
          JSON.stringify({
            reason: "Published resource no longer requires acknowledgement",
          }),
          viewer.personId,
          viewer.eventId,
          templateId,
          page.versionId,
          operationId,
        ),
        this.env.DB.prepare(
          `
          DELETE FROM task_template_dependencies
           WHERE depends_on_template_id = ?
             AND ${successfulResourcePublishAttemptSql}
        `,
        ).bind(templateId, page.versionId, operationId),
        this.env.DB.prepare(
          `
          UPDATE task_templates SET status = 'archived', updated_at = unixepoch()
           WHERE id = ? AND event_id = ?
             AND ${successfulResourcePublishAttemptSql}
        `,
        ).bind(templateId, viewer.eventId, page.versionId, operationId),
      ];
    }
    const statements = [
      this.env.DB.prepare(
        `
        INSERT INTO task_templates (
          id, event_id, name, description, target_type, task_type, impact, evidence_mode,
          due_anchor, auto_assign_on_acceptance, configuration_json, status, created_at, updated_at
        ) SELECT ?, ?, ?, ?, 'speaker', 'acknowledgement', 'medium', 'checkbox', 'none', 0, ?, 'active', unixepoch(), unixepoch()
          WHERE ${successfulResourcePublishAttemptSql}
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description,
          configuration_json = excluded.configuration_json, status = 'active', updated_at = unixepoch()
        WHERE task_templates.event_id = excluded.event_id
      `,
      ).bind(
        templateId,
        viewer.eventId,
        `Read ${page.title}`,
        "Read and acknowledge the current published version.",
        JSON.stringify({ resourcePageId: page.id }),
        page.versionId,
        operationId,
      ),
    ];
    if (eligibleIds.length) {
      const eligibleIdsJson = JSON.stringify(eligibleIds);
      statements.push(
        this.env.DB.prepare(
          `
          UPDATE task_instances
             SET title = ?, description = ?, status = 'not_started', readiness_state = 'on_track',
                 readiness_percent = 0, evidence_json = NULL, completed_at = NULL,
                 completed_by_person_id = NULL, revision = revision + 1, updated_at = unixepoch()
           WHERE event_id = ? AND template_id = ?
             AND target_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
             AND ${successfulResourcePublishAttemptSql}
        `,
        ).bind(
          `Read ${page.title}`,
          "Read and acknowledge the current published version.",
          viewer.eventId,
          templateId,
          eligibleIdsJson,
          page.versionId,
          operationId,
        ),
        this.env.DB.prepare(
          `
          UPDATE task_instances
             SET status = 'waived', readiness_state = 'on_track', readiness_percent = 100,
                 evidence_json = ?, completed_at = unixepoch(), completed_by_person_id = ?,
                 revision = revision + 1, updated_at = unixepoch()
           WHERE event_id = ? AND template_id = ?
             AND target_id NOT IN (SELECT CAST(value AS TEXT) FROM json_each(?))
             AND status <> 'waived'
             AND ${successfulResourcePublishAttemptSql}
        `,
        ).bind(
          JSON.stringify({ reason: "Resource audience changed" }),
          viewer.personId,
          viewer.eventId,
          templateId,
          eligibleIdsJson,
          page.versionId,
          operationId,
        ),
      );
    } else {
      statements.push(
        this.env.DB.prepare(
          `
        UPDATE task_instances
           SET status = 'waived', readiness_state = 'on_track', readiness_percent = 100,
               evidence_json = ?, completed_at = unixepoch(), completed_by_person_id = ?,
               revision = revision + 1, updated_at = unixepoch()
         WHERE event_id = ? AND template_id = ? AND status <> 'waived'
           AND ${successfulResourcePublishAttemptSql}
      `,
        ).bind(
          JSON.stringify({ reason: "Resource audience changed" }),
          viewer.personId,
          viewer.eventId,
          templateId,
          page.versionId,
          operationId,
        ),
      );
    }
    if (eligibleIds.length) {
      statements.push(
        this.env.DB.prepare(
          `
        INSERT OR IGNORE INTO task_instances (
          id, event_id, template_id, target_type, target_id, owner_person_id, title, description,
          task_type, impact, status, readiness_state, readiness_percent, revision, created_at, updated_at
        ) SELECT ? || CAST(audience.value AS TEXT), ?, ?, 'speaker', CAST(audience.value AS TEXT),
                 CAST(audience.value AS TEXT), ?, ?, 'acknowledgement', 'medium',
                 'not_started', 'on_track', 0, 1, unixepoch(), unixepoch()
            FROM json_each(?) audience
           WHERE ${successfulResourcePublishAttemptSql}
      `,
        ).bind(
          `resource-ack:${page.id}:`,
          viewer.eventId,
          templateId,
          `Read ${page.title}`,
          "Read and acknowledge the current published version.",
          JSON.stringify(eligibleIds),
          page.versionId,
          operationId,
        ),
      );
    }
    return statements;
  }

  private async eligibleAcknowledgementSpeakerIds(
    viewer: Viewer,
    pageId: string,
    versionId: string,
  ) {
    const speakers = await this.env.DB.prepare(
      `
      WITH event_speakers(person_id) AS (
        SELECT person_id FROM memberships
         WHERE event_id = ? AND role = 'speaker' AND accepted_at IS NOT NULL AND revoked_at IS NULL
        UNION
        SELECT person_id FROM session_speakers WHERE event_id = ?
      )
      SELECT event_speakers.person_id AS id
        FROM event_speakers
        JOIN resource_pages rp ON rp.id = ? AND rp.event_id = ?
        JOIN resource_page_versions rv ON rv.id = ? AND rv.resource_page_id = rp.id AND rv.event_id = rp.event_id
       WHERE ${participantAudienceSql("event_speakers.person_id", "rv")}
       ORDER BY event_speakers.person_id
    `,
    )
      .bind(viewer.eventId, viewer.eventId, pageId, viewer.eventId, versionId)
      .all<{ id: string }>();
    return speakers.results.map((speaker) => speaker.id);
  }

  private async getPublicationImpact(
    viewer: Viewer,
    page: {
      id: string;
      versionId: string;
      acknowledgementRequired: number;
    },
  ) {
    const eligibleSpeakerIds = page.acknowledgementRequired
      ? await this.eligibleAcknowledgementSpeakerIds(
          viewer,
          page.id,
          page.versionId,
        )
      : [];
    const templateId = `resource-ack:${page.id}`;
    const [existing, blockingDependents, templateDependencies] =
      await Promise.all([
        this.env.DB.prepare(
          `SELECT target_id AS targetId, status
             FROM task_instances
            WHERE event_id = ? AND template_id = ?`,
        )
          .bind(viewer.eventId, templateId)
          .all<{ targetId: string; status: string }>(),
        eligibleSpeakerIds.length
          ? this.env.DB.prepare(
              `
              SELECT COUNT(DISTINCT dependent.id) AS count
                FROM task_instances prerequisite
                JOIN task_instance_dependencies dependency
                  ON dependency.depends_on_task_id = prerequisite.id
                JOIN task_instances dependent ON dependent.id = dependency.task_id
               WHERE prerequisite.event_id = ? AND prerequisite.template_id = ?
                 AND prerequisite.target_id IN (
                   SELECT CAST(value AS TEXT) FROM json_each(?)
                 )
                 AND dependent.status IN ('submitted','completed')
            `,
            )
              .bind(
                viewer.eventId,
                templateId,
                JSON.stringify(eligibleSpeakerIds),
              )
              .first<{ count: number }>()
          : Promise.resolve({ count: 0 }),
        this.env.DB.prepare(
          `
          SELECT COUNT(*) AS count
            FROM task_template_dependencies dependency
            JOIN task_templates dependent ON dependent.id = dependency.template_id
           WHERE dependency.depends_on_template_id = ?
             AND dependent.event_id = ? AND dependent.status = 'active'
        `,
        )
          .bind(templateId, viewer.eventId)
          .first<{ count: number }>(),
      ]);
    const eligible = new Set(eligibleSpeakerIds);
    const tasksWaived = page.acknowledgementRequired
      ? existing.results.filter(
          (task) => !eligible.has(task.targetId) && task.status !== "waived",
        ).length
      : existing.results.filter(
          (task) => !["completed", "waived"].includes(task.status),
        ).length;
    return {
      eligibleSpeakerCount: eligibleSpeakerIds.length,
      tasksCreatedOrReset: page.acknowledgementRequired
        ? eligibleSpeakerIds.length
        : 0,
      tasksWaived,
      blockingDependentTasks: page.acknowledgementRequired
        ? (blockingDependents?.count ?? 0)
        : 0,
      templateDependenciesRemoved: page.acknowledgementRequired
        ? 0
        : (templateDependencies?.count ?? 0),
    };
  }

  private async hasBlockingAcknowledgementDependents(
    eventId: string,
    templateId: string,
    eligibleIds: string[],
  ) {
    if (!eligibleIds.length) return false;
    const row = await this.env.DB.prepare(
      `
      SELECT 1
        FROM task_instances prerequisite
        JOIN task_instance_dependencies dependency
          ON dependency.depends_on_task_id = prerequisite.id
        JOIN task_instances dependent ON dependent.id = dependency.task_id
       WHERE prerequisite.event_id = ? AND prerequisite.template_id = ?
         AND prerequisite.target_id IN (
           SELECT CAST(value AS TEXT) FROM json_each(?)
         )
         AND dependent.status IN ('submitted','completed')
       LIMIT 1
    `,
    )
      .bind(eventId, templateId, JSON.stringify(eligibleIds))
      .first();
    return Boolean(row);
  }

  private async getDraftForPublish(viewer: Viewer, pageId: string) {
    return this.env.DB.prepare(
      `
      SELECT rp.id, rp.revision, rv.title, rv.slug, rv.category,
             rv.audience_scope AS audienceScope,
             rv.acknowledgement_required AS acknowledgementRequired,
             rv.id AS versionId, rv.version_number AS versionNumber
        FROM resource_pages rp
        JOIN resource_page_versions rv ON rv.resource_page_id = rp.id AND rv.status = 'draft'
       WHERE rp.id = ? AND rp.event_id = ?
       ORDER BY rv.version_number DESC LIMIT 1
    `,
    )
      .bind(pageId, viewer.eventId)
      .first<ResourcePublishPage>();
  }

  async publish(
    viewer: Viewer,
    pageId: string,
    revision: number,
    command?: { operationId: string; auditId: string },
  ) {
    const operation = "resource.publish";
    const idempotencyKey = await airtableCommandKey(operation, viewer, {
      pageId,
      revision,
      operationId: command?.operationId ?? null,
    });
    const d1Command = command ?? {
      operationId: crypto.randomUUID(),
      auditId: crypto.randomUUID(),
    };
    return this.airtable.executeIdempotent(
      viewer,
      { idempotencyKey, operation },
      () => this.publishD1(viewer, pageId, revision, d1Command),
    );
  }

  private async publishD1(
    viewer: Viewer,
    pageId: string,
    revision: number,
    command: { operationId: string; auditId: string },
  ) {
    await this.assertEvent(viewer);
    const recovered = await this.env.DB.prepare(
      `SELECT 1 FROM resource_pages page
        WHERE page.id = ? AND page.event_id = ?
          AND page.status = 'published' AND page.last_operation_id = ?
          AND page.revision = ?`,
    )
      .bind(pageId, viewer.eventId, command.operationId, revision + 1)
      .first();
    if (recovered) return { pageId };
    const page = await this.getDraftForPublish(viewer, pageId);
    if (!page || page.revision !== revision)
      throw new ResourceRevisionConflictError();
    const operationId = command.operationId;
    const acknowledgementTemplateId = `resource-ack:${page.id}`;
    const eligibleIds = page.acknowledgementRequired
      ? await this.eligibleAcknowledgementSpeakerIds(
          viewer,
          page.id,
          page.versionId,
        )
      : [];
    const acknowledgementStatements = await this.acknowledgementTaskStatements(
      viewer,
      page,
      operationId,
      eligibleIds,
    );
    const dependentGuardSql = eligibleIds.length
      ? `NOT EXISTS (
          SELECT 1
            FROM task_instances prerequisite
            JOIN task_instance_dependencies dependency
              ON dependency.depends_on_task_id = prerequisite.id
            JOIN task_instances dependent ON dependent.id = dependency.task_id
           WHERE prerequisite.event_id = resource_pages.event_id
             AND prerequisite.template_id = ?
             AND prerequisite.target_id IN (
               SELECT CAST(value AS TEXT) FROM json_each(?)
             )
             AND dependent.status IN ('submitted','completed')
        )`
      : "1 = 1";
    const [updated] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE resource_pages
           SET status = 'published', title = ?, slug = ?, category = ?, audience_scope = ?,
               acknowledgement_required = ?, revision = revision + 1, last_operation_id = ?,
               updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND revision = ?
           AND EXISTS (
             SELECT 1 FROM resource_page_versions publish_version
              WHERE publish_version.id = ? AND publish_version.event_id = ?
                AND publish_version.resource_page_id = resource_pages.id
                AND publish_version.status = 'draft'
                ${publicationAudienceGuardSql}
           )
           AND NOT EXISTS (
             SELECT 1 FROM resource_pages slug_owner
              WHERE slug_owner.event_id = resource_pages.event_id
                AND slug_owner.slug = ? AND slug_owner.id <> resource_pages.id
           )
           AND ${dependentGuardSql}
      `,
      ).bind(
        page.title,
        page.slug,
        page.category,
        page.audienceScope,
        page.acknowledgementRequired,
        operationId,
        page.id,
        viewer.eventId,
        revision,
        page.versionId,
        viewer.eventId,
        JSON.stringify(eligibleIds),
        JSON.stringify(eligibleIds),
        page.slug,
        ...(eligibleIds.length
          ? [acknowledgementTemplateId, JSON.stringify(eligibleIds)]
          : []),
      ),
      this.env.DB.prepare(
        `
        UPDATE resource_page_versions SET status = 'retired'
         WHERE resource_page_id = ? AND status = 'published'
           AND EXISTS (
             SELECT 1 FROM resource_pages
              WHERE id = ? AND event_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(page.id, page.id, viewer.eventId, operationId),
      this.env.DB.prepare(
        `
        UPDATE resource_page_versions SET status = 'published', published_at = unixepoch()
         WHERE id = ? AND event_id = ? AND status = 'draft'
           AND EXISTS (
             SELECT 1 FROM resource_pages
              WHERE id = ? AND event_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        page.versionId,
        viewer.eventId,
        page.id,
        viewer.eventId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT OR IGNORE INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, correlation_id, metadata_json, created_at
        ) SELECT ?, ?, ?, ?, 'resource.published', 'resource_page', ?, ?, ?, unixepoch()
          WHERE ${successfulResourcePublishAttemptSql}
      `,
      ).bind(
        command.auditId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        page.id,
        operationId,
        JSON.stringify({ versionNumber: page.versionNumber }),
        page.versionId,
        operationId,
      ),
      ...acknowledgementStatements,
    ]);
    if ((updated.meta.changes ?? 0) !== 1) {
      const recovered = await this.env.DB.prepare(
        `SELECT 1 FROM resource_pages
          WHERE id = ? AND event_id = ? AND status = 'published'
            AND last_operation_id = ? AND revision = ?`,
      )
        .bind(pageId, viewer.eventId, command.operationId, revision + 1)
        .first();
      if (recovered) return { pageId };
      if (
        await this.hasBlockingAcknowledgementDependents(
          viewer.eventId,
          acknowledgementTemplateId,
          eligibleIds,
        )
      )
        throw new ResourceTaskDependencyError();
      if (await this.hasSlugConflict(viewer.eventId, page.slug, page.id))
        throw new ResourceSlugConflictError();
      if (
        page.audienceScope === "custom" &&
        (await this.hasInvalidAudience(
          viewer.eventId,
          await this.customAudiencePersonIds(viewer.eventId, page.versionId),
        ))
      ) {
        throw new ResourceAudienceError();
      }
      throw new ResourceRevisionConflictError();
    }
    return { pageId };
  }

  async attachToDraft(
    viewer: Viewer,
    pageId: string,
    versionId: string,
    revision: number,
    assetId: string,
    fileVersionId: string,
  ) {
    await this.assertEvent(viewer);
    const inserted = await this.insertDraftAttachment(
      viewer,
      pageId,
      versionId,
      revision,
      assetId,
      fileVersionId,
    );
    if ((inserted.meta.changes ?? 0) === 1) return;

    // The asset/version pair is a natural idempotency boundary. A client may
    // lose the response after the attachment commits and safely retry, but it
    // must never attach to a different or stale resource version.
    const alreadyAttached = await this.env.DB.prepare(
      `
      SELECT 1
        FROM resource_page_versions rv
        JOIN resource_pages rp
          ON rp.id = rv.resource_page_id AND rp.event_id = rv.event_id
        JOIN resource_attachments attachment
          ON attachment.resource_page_version_id = rv.id
         AND attachment.event_id = rv.event_id
        JOIN file_assets asset
          ON asset.id = attachment.file_asset_id
         AND asset.event_id = attachment.event_id
        JOIN file_versions file_version
          ON file_version.id = ? AND file_version.asset_id = asset.id
         AND file_version.event_id = asset.event_id
       WHERE rp.id = ? AND rp.event_id = ? AND rp.revision = ?
         AND rv.id = ? AND rv.status = 'draft'
         AND asset.id = ? AND asset.target_type = 'resource'
         AND asset.target_id = rp.id AND asset.status <> 'deleted'
         AND file_version.upload_status = 'uploaded'
         AND file_version.signature_status = 'valid'
      LIMIT 1
    `,
    )
      .bind(fileVersionId, pageId, viewer.eventId, revision, versionId, assetId)
      .first();
    if (!alreadyAttached) throw new ResourceRevisionConflictError();
  }

  private insertDraftAttachment(
    viewer: Viewer,
    pageId: string,
    versionId: string,
    revision: number,
    assetId: string,
    fileVersionId: string,
  ) {
    return this.env.DB.prepare(
      `
      INSERT OR IGNORE INTO resource_attachments (resource_page_version_id, event_id, file_asset_id, position, label)
      SELECT rv.id, rv.event_id, fa.id,
             (SELECT COUNT(*) FROM resource_attachments existing
               WHERE existing.resource_page_version_id = rv.id),
             NULL
        FROM resource_page_versions rv
        JOIN resource_pages rp
          ON rp.id = rv.resource_page_id AND rp.event_id = rv.event_id
        JOIN file_assets fa
          ON fa.event_id = rv.event_id AND fa.target_type = 'resource'
         AND fa.target_id = rp.id
        JOIN file_versions fv
          ON fv.id = ? AND fv.event_id = fa.event_id AND fv.asset_id = fa.id
       WHERE rp.id = ? AND rp.event_id = ? AND rp.revision = ?
         AND rv.id = ? AND rv.status = 'draft'
         AND fa.id = ? AND fa.status <> 'deleted'
         AND fv.upload_status = 'uploaded' AND fv.signature_status = 'valid'
    `,
    )
      .bind(fileVersionId, pageId, viewer.eventId, revision, versionId, assetId)
      .run();
  }
}
