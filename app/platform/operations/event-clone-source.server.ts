import type { Viewer } from "~/platform/auth/authorize.server";

export async function readEventCloneSource(
  env: CloudflareEnvironment,
  viewer: Viewer,
) {
  const [
    source,
    rooms,
    tracks,
    forms,
    formVersions,
    plans,
    rounds,
    criteria,
    taskTemplates,
    taskDependencies,
    communicationTemplates,
    communicationVersions,
    communicationTriggers,
  ] = await Promise.all([
    env.DB.prepare(
      `SELECT venue_name AS venueName, city, description,
              brand_accent AS brandAccent, retention_months AS retentionMonths,
              session_formats_json AS sessionFormatsJson,
              submission_access_mode AS submissionAccessMode,
              allow_anonymous_drafts AS allowAnonymousDrafts,
              duplicate_person_warnings AS duplicatePersonWarnings,
              file_policy_json AS filePolicyJson
         FROM events WHERE id = ? AND organisation_id = ?`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{
        venueName: string | null;
        city: string | null;
        description: string | null;
        brandAccent: string;
        retentionMonths: number;
        sessionFormatsJson: string;
        submissionAccessMode: string;
        allowAnonymousDrafts: number;
        duplicatePersonWarnings: number;
        filePolicyJson: string;
      }>(),
    env.DB.prepare(
      "SELECT id, name, building, level, capacity, resources_json AS resourcesJson, position, status FROM rooms WHERE event_id = ? AND status = 'active' ORDER BY position, id",
    )
      .bind(viewer.eventId)
      .all<{
        id: string;
        name: string;
        building: string | null;
        level: string | null;
        capacity: number;
        resourcesJson: string;
        position: number;
        status: string;
      }>(),
    env.DB.prepare(
      "SELECT id, name, slug, colour_token AS colour, position, exclusive, is_public AS isPublic FROM tracks WHERE event_id = ? ORDER BY position, id",
    )
      .bind(viewer.eventId)
      .all<{
        id: string;
        name: string;
        slug: string;
        colour: string | null;
        position: number;
        exclusive: number;
        isPublic: number;
      }>(),
    env.DB.prepare(
      "SELECT id, name, description, kind, closes_at AS closesAt, submission_limit AS submissionLimit, min_speakers AS minSpeakers, max_speakers AS maxSpeakers, access_mode AS accessMode, confirmation_template_id AS confirmationTemplateId FROM form_definitions WHERE event_id = ? AND status <> 'archived' ORDER BY created_at, id",
    )
      .bind(viewer.eventId)
      .all<{
        id: string;
        name: string;
        description: string | null;
        kind: string;
        closesAt: number | null;
        submissionLimit: number | null;
        minSpeakers: number;
        maxSpeakers: number | null;
        accessMode: string;
        confirmationTemplateId: string | null;
      }>(),
    env.DB.prepare(
      "SELECT fv.id, fv.form_id AS formId, fv.version_number AS versionNumber, fv.schema_json AS schemaJson, fv.routing_json AS routingJson, fv.settings_snapshot_json AS settingsJson FROM form_versions fv JOIN form_definitions f ON f.id = fv.form_id AND f.event_id = fv.event_id WHERE fv.event_id = ? AND f.status <> 'archived' ORDER BY fv.form_id, fv.version_number",
    )
      .bind(viewer.eventId)
      .all<{
        id: string;
        formId: string;
        versionNumber: number;
        schemaJson: string;
        routingJson: string;
        settingsJson: string;
      }>(),
    env.DB.prepare(
      "SELECT id, name, blinded_reviewing AS blindedReviewing, decision_role AS decisionRole FROM evaluation_plans WHERE event_id = ? AND status <> 'archived' ORDER BY created_at, id",
    )
      .bind(viewer.eventId)
      .all<{
        id: string;
        name: string;
        blindedReviewing: number;
        decisionRole: string;
      }>(),
    env.DB.prepare(
      "SELECT r.id, r.plan_id AS planId, r.round_number AS roundNumber, r.name, r.opens_at AS opensAt, r.closes_at AS closesAt, r.advancement_rule_json AS advancementRuleJson FROM evaluation_rounds r JOIN evaluation_plans p ON p.id = r.plan_id AND p.event_id = r.event_id WHERE r.event_id = ? AND r.status <> 'archived' AND p.status <> 'archived' ORDER BY r.plan_id, r.round_number",
    )
      .bind(viewer.eventId)
      .all<{
        id: string;
        planId: string;
        roundNumber: number;
        name: string;
        opensAt: number | null;
        closesAt: number | null;
        advancementRuleJson: string;
      }>(),
    env.DB.prepare(
      "SELECT c.id, c.round_id AS roundId, c.name, c.description, c.input_type AS inputType, c.weight_percent AS weightPercent, c.required, c.position FROM evaluation_criteria c JOIN evaluation_rounds r ON r.id = c.round_id AND r.event_id = c.event_id JOIN evaluation_plans p ON p.id = r.plan_id AND p.event_id = r.event_id WHERE c.event_id = ? AND r.status <> 'archived' AND p.status <> 'archived' ORDER BY c.round_id, c.position",
    )
      .bind(viewer.eventId)
      .all<{
        id: string;
        roundId: string;
        name: string;
        description: string | null;
        inputType: string;
        weightPercent: number;
        required: number;
        position: number;
      }>(),
    env.DB.prepare(
      "SELECT id, name, description, target_type AS targetType, task_type AS taskType, impact, evidence_mode AS evidenceMode, due_anchor AS dueAnchor, due_offset_minutes AS dueOffsetMinutes, fixed_due_at AS fixedDueAt, auto_assign_on_acceptance AS autoAssignOnAcceptance, configuration_json AS configurationJson, status FROM task_templates WHERE event_id = ? AND status <> 'archived' ORDER BY created_at, id",
    )
      .bind(viewer.eventId)
      .all<{
        id: string;
        name: string;
        description: string | null;
        targetType: string;
        taskType: string;
        impact: string;
        evidenceMode: string;
        dueAnchor: string;
        dueOffsetMinutes: number | null;
        fixedDueAt: number | null;
        autoAssignOnAcceptance: number;
        configurationJson: string;
        status: string;
      }>(),
    env.DB.prepare(
      "SELECT d.template_id AS templateId, d.depends_on_template_id AS dependsOnTemplateId FROM task_template_dependencies d JOIN task_templates t ON t.id = d.template_id JOIN task_templates dependency ON dependency.id = d.depends_on_template_id WHERE t.event_id = ? AND dependency.event_id = ? AND t.status <> 'archived' AND dependency.status <> 'archived'",
    )
      .bind(viewer.eventId, viewer.eventId)
      .all<{ templateId: string; dependsOnTemplateId: string }>(),
    env.DB.prepare(
      "SELECT id, name, category FROM communication_templates WHERE event_id = ? AND status <> 'archived' ORDER BY created_at, id",
    )
      .bind(viewer.eventId)
      .all<{ id: string; name: string; category: string }>(),
    env.DB.prepare(
      "SELECT v.id, v.template_id AS templateId, v.version_number AS versionNumber, v.name, v.category, v.channel, v.subject_template AS subjectTemplate, v.content_json AS contentJson, v.rendered_preview_html AS previewHtml FROM communication_template_versions v JOIN communication_templates t ON t.id = v.template_id AND t.event_id = v.event_id WHERE v.event_id = ? AND t.status <> 'archived' ORDER BY v.template_id, v.version_number, v.channel",
    )
      .bind(viewer.eventId)
      .all<{
        id: string;
        templateId: string;
        versionNumber: number;
        name: string;
        category: string;
        channel: string;
        subjectTemplate: string | null;
        contentJson: string;
        previewHtml: string | null;
      }>(),
    env.DB.prepare(
      "SELECT trigger.template_id AS templateId, trigger.trigger_type AS triggerType, trigger.configuration_json AS configurationJson FROM communication_triggers trigger JOIN communication_templates template ON template.id = trigger.template_id AND template.event_id = trigger.event_id WHERE trigger.event_id = ? AND template.status <> 'archived' ORDER BY trigger.trigger_type, trigger.id",
    )
      .bind(viewer.eventId)
      .all<{
        templateId: string;
        triggerType: string;
        configurationJson: string;
      }>(),
  ]);
  return {
    source,
    rooms,
    tracks,
    forms,
    formVersions,
    plans,
    rounds,
    criteria,
    taskTemplates,
    taskDependencies,
    communicationTemplates,
    communicationVersions,
    communicationTriggers,
  };
}

export type EventCloneSource = Awaited<ReturnType<typeof readEventCloneSource>>;
