import { z } from "zod";
import type { Viewer } from "~/platform/auth/authorize.server";
import type { CommunicationCategory } from "./communication-schema";
import { CommunicationStateError } from "./communication-service-shared";
import { STARTER_TEMPLATES } from "./starter-templates";

type StarterTemplate = (typeof STARTER_TEMPLATES)[number] & {
  templateId: string;
  versionId: string;
};

export function withStarterIdentifiers(): StarterTemplate[] {
  return STARTER_TEMPLATES.map((starter) => ({
    ...starter,
    templateId: crypto.randomUUID(),
    versionId: crypto.randomUUID(),
  }));
}

/** Publishes one starter email. The template insert reads the organisation
 *  postal address in the same statement, so the footer is never invented,
 *  and inserts nothing when the event already has a published email version
 *  in that category. The later statements follow the template insert, so its change
 *  count says whether the starter was created. */
export function starterTemplateStatements(
  env: CloudflareEnvironment,
  viewer: Pick<Viewer, "organisationId" | "personId">,
  input: { eventId: string; operationId: string; correlationId: string },
  starter: StarterTemplate,
) {
  return [
    env.DB.prepare(
      `INSERT INTO communication_templates (
         id, event_id, name, category, status, last_operation_id,
         created_by_person_id, created_at, updated_at
       )
       SELECT ?, event.id, ?, ?, 'active', ?, ?, unixepoch(), unixepoch()
         FROM events event
         JOIN organisations organisation
           ON organisation.id = event.organisation_id
        WHERE event.id = ? AND event.organisation_id = ?
          AND organisation.communication_physical_address IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
              FROM communication_templates existing
              JOIN communication_template_versions version
                ON version.template_id = existing.id
               AND version.event_id = existing.event_id
             WHERE existing.event_id = event.id
               AND existing.status = 'active'
               AND version.status = 'published' AND version.channel = 'email'
               AND version.category = ?
          )`,
    ).bind(
      starter.templateId,
      starter.name,
      starter.category,
      input.operationId,
      viewer.personId,
      input.eventId,
      viewer.organisationId,
      starter.category,
    ),
    env.DB.prepare(
      `INSERT INTO communication_template_versions (
         id, event_id, template_id, version_number, name, category, channel,
         subject_template, content_json, rendered_preview_html, status,
         created_by_person_id, created_at, published_at
       )
       SELECT ?, template.event_id, template.id, 1, template.name,
              template.category, 'email', ?,
              json_object(
                'body', ?,
                'physicalAddress',
                trim(organisation.communication_physical_address)
              ),
              NULL, 'published', ?, unixepoch(), unixepoch()
         FROM communication_templates template
         JOIN events event ON event.id = template.event_id
         JOIN organisations organisation
           ON organisation.id = event.organisation_id
        WHERE template.id = ? AND template.event_id = ?`,
    ).bind(
      starter.versionId,
      starter.subject,
      starter.body,
      viewer.personId,
      starter.templateId,
      input.eventId,
    ),
    env.DB.prepare(
      `INSERT INTO audit_events (
         id, actor_kind, origin, metadata_version, organisation_id, event_id,
         actor_person_id, action, entity_type, entity_id, correlation_id,
         metadata_json, created_at
       )
       SELECT ?, 'person', 'admin_ui', 1, ?, version.event_id, ?,
              'communication.template.starter_published',
              'communication_template_version', version.id, ?,
              json_object(
                'templateId', version.template_id,
                'versionNumber', version.version_number,
                'category', version.category,
                'operationId', ?
              ),
              unixepoch()
         FROM communication_template_versions version
        WHERE version.id = ? AND version.event_id = ?`,
    ).bind(
      crypto.randomUUID(),
      viewer.organisationId,
      viewer.personId,
      input.correlationId,
      input.operationId,
      starter.versionId,
      input.eventId,
    ),
  ];
}

/** Categories one operation published starters for. The audit rows are
 *  append-only, so this holds after the templates themselves change. */
export async function starterCategoriesPublishedBy(
  env: CloudflareEnvironment,
  input: { eventId: string; operationId: string },
) {
  const rows = await env.DB.prepare(
    `SELECT json_extract(metadata_json, '$.category') AS category
       FROM audit_events
      WHERE event_id = ?
        AND action = 'communication.template.starter_published'
        AND json_extract(metadata_json, '$.operationId') = ?`,
  )
    .bind(input.eventId, input.operationId)
    .all<{ category: CommunicationCategory }>();
  const published = new Set(rows.results.map((row) => row.category));
  return STARTER_TEMPLATES.map((starter) => starter.category).filter(
    (category) => published.has(category),
  );
}

/** Starter categories without a published email in the event. Like
 *  readiness and decision release, this reads the published version's
 *  category: saving a draft changes the template's category before that
 *  draft is published. */
export async function missingStarterCategories(
  env: CloudflareEnvironment,
  viewer: Pick<Viewer, "organisationId" | "eventId">,
) {
  const rows = await env.DB.prepare(
    `SELECT DISTINCT version.category AS category
       FROM communication_templates template
       JOIN events event
         ON event.id = template.event_id AND event.organisation_id = ?
       JOIN communication_template_versions version
         ON version.template_id = template.id
        AND version.event_id = template.event_id
      WHERE template.event_id = ? AND template.status = 'active'
        AND version.status = 'published' AND version.channel = 'email'`,
  )
    .bind(viewer.organisationId, viewer.eventId)
    .all<{ category: CommunicationCategory }>();
  const published = new Set(rows.results.map((row) => row.category));
  return STARTER_TEMPLATES.map((starter) => starter.category).filter(
    (category) => !published.has(category),
  );
}

const operationIdSchema = z.uuid();

/** Publishes the starters an existing event is missing, for organisations
 *  that added their postal address after creating it or events that predate
 *  starters. Retrying the same operation returns its original result. */
export async function createMissingStarterTemplates(
  env: CloudflareEnvironment,
  viewer: Viewer,
  rawOperationId: unknown,
): Promise<{ created: CommunicationCategory[] }> {
  const operationId = operationIdSchema.parse(rawOperationId);
  const previous = await starterCategoriesPublishedBy(env, {
    eventId: viewer.eventId,
    operationId,
  });
  if (previous.length) return { created: previous };
  const organisation = await env.DB.prepare(
    `SELECT communication_physical_address IS NOT NULL AS hasPostalAddress
       FROM organisations WHERE id = ?`,
  )
    .bind(viewer.organisationId)
    .first<{ hasPostalAddress: number }>();
  if (!organisation?.hasPostalAddress) {
    throw new CommunicationStateError(
      "Starter emails need the organisation postal address for their footer. Add it in Delivery settings, then try again.",
    );
  }
  const starters = withStarterIdentifiers();
  const statementSets = starters.map((starter) =>
    starterTemplateStatements(
      env,
      viewer,
      { eventId: viewer.eventId, operationId, correlationId: operationId },
      starter,
    ),
  );
  const results = await env.DB.batch(statementSets.flat());
  const created = starters
    .filter(
      (_starter, index) =>
        (results[index * statementSets[0].length]?.meta.changes ?? 0) === 1,
    )
    .map((starter) => starter.category);
  if (!created.length && (await missingStarterCategories(env, viewer)).length) {
    // The address was removed between the check and the batch.
    throw new CommunicationStateError(
      "Starter emails were not created because the organisation postal address is no longer set. Add it in Delivery settings, then try again.",
    );
  }
  return { created };
}
