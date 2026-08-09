import type { Viewer } from "~/platform/auth/authorize.server";
import {
  appendEmbeds,
  parseResourceDocument,
  renderResourceDocument,
  type TiptapNode,
} from "./resource-content";
import { ResourceServiceBase } from "./resource-service-base.server";
import {
  participantAudienceSql,
  resourceInputSchema,
  ResourceInvariantError,
  ResourceRevisionConflictError,
  ResourceSlugConflictError,
  ResourceTaskDependencyError,
  successfulResourcePublishAttemptSql,
  type PageRow,
  type ResourcePublishPage,
} from "./resource-service-shared";

export class ResourceAuthoringService extends ResourceServiceBase {
  async getAdminWorkspace(viewer: Viewer, selectedId?: string | null) {
    await this.assertEvent(viewer);
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
    let attachments: Array<{
      id: string;
      filename: string;
      sizeBytes: number;
      scanStatus: string;
      uploadStatus: string;
    }> = [];
    if (selected?.versionId) {
      const rows = await this.env.DB.prepare(
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
        }>();
      attachments = rows.results;
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
      pages: pages.results,
      selected: selected
        ? {
            ...selected,
            acknowledgementRequired: Boolean(selected.acknowledgementRequired),
            document: document!,
            attachments,
            publicationImpact,
          }
        : null,
    };
  }

  async save(viewer: Viewer, rawInput: unknown) {
    await this.assertEvent(viewer);
    const parsed = resourceInputSchema.parse(rawInput);
    const document = appendEmbeds(
      parseResourceDocument(parsed.document),
      parsed.embedUrls,
    );
    const renderedHtml = renderResourceDocument(document);
    if (!parsed.id) {
      const pageId = crypto.randomUUID();
      const versionId = crypto.randomUUID();
      const [created] = await this.env.DB.batch([
        this.env.DB.prepare(
          `
          INSERT INTO resource_pages (
            id, event_id, title, slug, category, status, audience_scope, acknowledgement_required,
            revision, created_by_person_id, created_at, updated_at
          ) SELECT ?, ?, ?, ?, ?, 'draft', ?, ?, 1, ?, unixepoch(), unixepoch()
             WHERE NOT EXISTS (
               SELECT 1 FROM resource_pages
                WHERE event_id = ? AND slug = ?
             )
        `,
        ).bind(
          pageId,
          viewer.eventId,
          parsed.title,
          parsed.slug,
          parsed.category || null,
          parsed.audienceScope,
          parsed.acknowledgementRequired ? 1 : 0,
          viewer.personId,
          viewer.eventId,
          parsed.slug,
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
          INSERT INTO audit_events (
            id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
          ) SELECT ?, ?, page.event_id, ?, 'resource.created', 'resource_page', page.id, '{}', unixepoch()
              FROM resource_pages page
             WHERE page.id = ? AND page.event_id = ?
        `,
        ).bind(
          crypto.randomUUID(),
          viewer.organisationId,
          viewer.personId,
          pageId,
          viewer.eventId,
        ),
      ]);
      if ((created.meta.changes ?? 0) !== 1)
        throw new ResourceSlugConflictError();
      return pageId;
    }
    if (!parsed.revision) throw new ResourceRevisionConflictError();
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
    const versionId = crypto.randomUUID();
    const saveOperationId = crypto.randomUUID();
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
        INSERT OR IGNORE INTO resource_audiences (
          resource_page_version_id, event_id, target_type, target_id, created_at
        )
        SELECT ?, event_id, target_type, target_id, created_at
         FROM resource_audiences
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
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
        ) SELECT ?, ?, ?, ?, 'resource.draft.saved', 'resource_page', ?, ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM resource_pages
             WHERE id = ? AND event_id = ? AND last_operation_id = ?
          )
      `,
      ).bind(
        crypto.randomUUID(),
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
      if (await this.hasSlugConflict(viewer.eventId, parsed.slug, parsed.id))
        throw new ResourceSlugConflictError();
      throw new ResourceRevisionConflictError();
    }
    return parsed.id;
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
          due_anchor, configuration_json, status, created_at, updated_at
        ) SELECT ?, ?, ?, ?, 'speaker', 'acknowledgement', 'medium', 'checkbox', 'none', ?, 'active', unixepoch(), unixepoch()
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

  async publish(viewer: Viewer, pageId: string, revision: number) {
    await this.assertEvent(viewer);
    const page = await this.getDraftForPublish(viewer, pageId);
    if (!page || page.revision !== revision)
      throw new ResourceRevisionConflictError();
    const operationId = crypto.randomUUID();
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
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, correlation_id, metadata_json, created_at
        ) SELECT ?, ?, ?, ?, 'resource.published', 'resource_page', ?, ?, ?, unixepoch()
          WHERE ${successfulResourcePublishAttemptSql}
      `,
      ).bind(
        crypto.randomUUID(),
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
      throw new ResourceRevisionConflictError();
    }
  }

  async attachToDraft(
    viewer: Viewer,
    pageId: string,
    versionId: string,
    revision: number,
    assetId: string,
  ) {
    await this.assertEvent(viewer);
    const inserted = await this.insertDraftAttachment(
      viewer,
      pageId,
      versionId,
      revision,
      assetId,
    );
    if ((inserted.meta.changes ?? 0) !== 1) {
      throw new ResourceRevisionConflictError();
    }
  }

  private insertDraftAttachment(
    viewer: Viewer,
    pageId: string,
    versionId: string,
    revision: number,
    assetId: string,
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
       WHERE rp.id = ? AND rp.event_id = ? AND rp.revision = ?
         AND rv.id = ? AND rv.status = 'draft'
         AND fa.id = ? AND fa.status <> 'deleted'
    `,
    )
      .bind(pageId, viewer.eventId, revision, versionId, assetId)
      .run();
  }
}
