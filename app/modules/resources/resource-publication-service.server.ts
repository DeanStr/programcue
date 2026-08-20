import {
  AirtableProviderBoundary,
  airtableCommandKey,
} from "~/modules/airtable/airtable-provider-boundary.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  parseResourceDocument,
  validateResourceDocumentEmbeds,
} from "./resource-content";
import { resourceEmbedConfiguration } from "./resource-embed-policy";
import { ResourceServiceBase } from "./resource-service-base.server";
import {
  participantAudienceSql,
  ResourceAudienceError,
  type ResourcePublishPage,
  ResourceRevisionConflictError,
  ResourceSlugConflictError,
  ResourceTaskDependencyError,
  successfulResourcePublishAttemptSql,
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
    publish_version.audience_scope = 'confirmed_speakers'
    AND EXISTS (
      SELECT 1 FROM session_speakers confirmed_relationship
       WHERE confirmed_relationship.event_id = resource_pages.event_id
         AND confirmed_relationship.person_id = candidate.id
         AND confirmed_relationship.participation_status = 'confirmed'
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

export class ResourcePublicationService extends ResourceServiceBase {
  private readonly airtable: AirtableProviderBoundary;

  constructor(
    env: CloudflareEnvironment,
    airtable: AirtableProviderBoundary = new AirtableProviderBoundary(env),
  ) {
    super(env);
    this.airtable = airtable;
  }

  async hasInvalidAudience(eventId: string, personIds: string[]) {
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

  async hasSlugConflict(eventId: string, slug: string, pageId: string) {
    return Boolean(
      await this.env.DB.prepare(
        `SELECT 1 FROM resource_pages
          WHERE event_id = ? AND slug = ? AND id <> ? LIMIT 1`,
      )
        .bind(eventId, slug, pageId)
        .first(),
    );
  }

  async customAudiencePersonIds(eventId: string, versionId: string) {
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
          task_type, impact, status, readiness_state, evidence_mode,
          configuration_json, readiness_percent, revision, created_at, updated_at
        ) SELECT ? || CAST(audience.value AS TEXT), ?, ?, 'speaker', CAST(audience.value AS TEXT),
                 CAST(audience.value AS TEXT), ?, ?, 'acknowledgement', 'medium',
                 'not_started', 'on_track', template.evidence_mode,
                 template.configuration_json, 0, 1,
                 unixepoch(), unixepoch()
            FROM json_each(?) audience
            JOIN task_templates template
              ON template.id = ? AND template.event_id = ?
           WHERE ${successfulResourcePublishAttemptSql}
      `,
        ).bind(
          `resource-ack:${page.id}:`,
          viewer.eventId,
          templateId,
          `Read ${page.title}`,
          "Read and acknowledge the current published version.",
          JSON.stringify(eligibleIds),
          templateId,
          viewer.eventId,
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

  async getPublicationImpact(
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
             rv.id AS versionId, rv.version_number AS versionNumber,
             rv.document_json AS documentJson
        FROM resource_pages rp
        JOIN resource_page_versions rv
          ON rv.resource_page_id = rp.id
         AND rv.event_id = rp.event_id
         AND rv.status = 'draft'
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
    const document = parseResourceDocument(JSON.parse(page.documentJson));
    validateResourceDocumentEmbeds(
      document,
      resourceEmbedConfiguration(this.env),
    );
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
          id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, correlation_id, metadata_json, created_at
        ) SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'resource.published', 'resource_page', ?, ?, ?, unixepoch()
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
}
