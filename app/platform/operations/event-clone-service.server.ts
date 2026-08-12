import { z } from "zod";

import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import {
  AIRTABLE_ROOMS_TABLE,
  airtableConnectionInputSchema,
} from "~/modules/airtable/airtable-schema";
import { communicationTriggerConfigurationSchema } from "~/modules/communications/communication-schema";
import { parseSessionFormatsConfiguration } from "~/modules/events/event-configuration";
import {
  EventRepositoryProvisioningService,
  type AirtableProvisioningRoom,
} from "~/modules/events/event-repository-provisioning.server";
import { timezoneSchema } from "~/modules/events/event-schema";
import { parseEventFilePolicy } from "~/modules/files/file-policy";
import { routingSchema } from "~/modules/submissions/submission-schema";
import type { Viewer } from "~/platform/auth/authorize.server";

const EVENT_NAME_MAX_LENGTH = 160;
const EVENT_SLUG_MAX_LENGTH = 120;
const CLONE_NAME_SUFFIX = " Copy";
const CLONE_SLUG_SUFFIX = "-copy";

const cloneEventSchema = z
  .object({
    name: z.string().trim().min(1).max(EVENT_NAME_MAX_LENGTH),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(EVENT_SLUG_MAX_LENGTH)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    timezone: timezoneSchema,
    startDate: z.iso.date(),
    endDate: z.iso.date(),
    repositoryProvider: z.enum(["d1", "airtable"]),
    personalAccessToken: z.string().trim().optional(),
    baseId: z.string().trim().optional(),
    tableName: z.string().trim().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.endDate < value.startDate)
      context.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "End date cannot be before the start date.",
      });
    if (value.repositoryProvider !== "airtable") return;
    const connection = airtableConnectionInputSchema.safeParse({
      personalAccessToken: value.personalAccessToken,
      baseId: value.baseId,
      tableName: value.tableName,
    });
    if (!connection.success)
      for (const issue of connection.error.issues)
        context.addIssue({
          code: "custom",
          path: issue.path,
          message: issue.message,
        });
  });

function startEpoch(date: string) {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1_000);
}

function endEpoch(date: string) {
  return Math.floor(Date.parse(`${date}T23:59:59Z`) / 1_000);
}

function date(epoch: number) {
  return new Date(epoch * 1_000).toISOString().slice(0, 10);
}

function nextYear(value: string) {
  const parsed = new Date(`${value}T12:00:00Z`);
  parsed.setUTCFullYear(parsed.getUTCFullYear() + 1);
  return parsed.toISOString().slice(0, 10);
}

function cloneNameDefault(sourceName: string) {
  return `${sourceName.slice(0, EVENT_NAME_MAX_LENGTH - CLONE_NAME_SUFFIX.length)}${CLONE_NAME_SUFFIX}`;
}

function cloneSlugDefault(sourceSlug: string) {
  const stem = sourceSlug
    .slice(0, EVENT_SLUG_MAX_LENGTH - CLONE_SLUG_SUFFIX.length)
    .replace(/-+$/u, "");
  return `${stem}${CLONE_SLUG_SUFFIX}`;
}

function jsonObject(value: string, context: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${context} contains invalid JSON.`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${context} must contain a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

function cloneTriggerConfiguration(value: string, context: string) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error(`${context} contains invalid JSON.`);
  }
  const parsed = communicationTriggerConfigurationSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error(
      `${context} is invalid: ${parsed.error.issues[0]?.message ?? "schema mismatch"}.`,
    );
  }
  return JSON.stringify({
    audienceType: parsed.data.audienceType,
    kind: parsed.data.kind,
    sendHourUtc: parsed.data.sendHourUtc,
  });
}

function cloneFormRouting(
  value: string,
  context: string,
  clonedTrackIds: Map<string, string>,
) {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error(`${context} contains invalid JSON.`);
  }
  const parsed = routingSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new Error(
      `${context} is invalid: ${parsed.error.issues[0]?.message ?? "schema mismatch"}.`,
    );
  }
  const trackIds: Record<string, string> = {};
  const trackNames: Record<string, string> = {};
  for (const [trackName, sourceTrackId] of Object.entries(
    parsed.data.trackIds,
  )) {
    if (parsed.data.trackNames[sourceTrackId] !== trackName) {
      throw new Error(
        `${context} has inconsistent saved event-track identity.`,
      );
    }
    const clonedTrackId = clonedTrackIds.get(sourceTrackId);
    if (!clonedTrackId) {
      throw new Error(
        `${context} references event track ${sourceTrackId}, which is not cloneable.`,
      );
    }
    trackIds[trackName] = clonedTrackId;
    trackNames[clonedTrackId] = trackName;
  }
  return {
    ...parsed.data,
    // Evaluation teams are event-owned and deliberately are not cloned. A
    // draft must be explicitly routed to teams created in the new event.
    categories: {},
    trackIds,
    trackNames,
    teamNames: {},
    passwordHash: null,
  };
}

function cloneableTaskConfiguration(
  value: string,
  context: string,
  taskType: string,
) {
  const configuration = jsonObject(value, context);
  if (!Object.hasOwn(configuration, "resourcePageId")) {
    return JSON.stringify(configuration);
  }
  if (
    taskType !== "acknowledgement" ||
    typeof configuration.resourcePageId !== "string" ||
    !configuration.resourcePageId.trim()
  ) {
    throw new Error(
      `${context} contains an invalid resource acknowledgement reference.`,
    );
  }
  // Resource pages are intentionally not cloned. Their generated task
  // templates cannot be valid in the target event and are recreated only
  // when a target-event resource is published with acknowledgement enabled.
  return null;
}

function cloneFormSlug(eventSlug: string, name: string, formId: string) {
  const nameSlug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "") || "form";
  return `${eventSlug}-${nameSlug}-${formId.slice(0, 8)}`;
}

export class EventCloneSlugConflictError extends Error {
  constructor() {
    super("Another event already uses that public slug.");
    this.name = "EventCloneSlugConflictError";
  }
}

export type EventCloneSummary = {
  eventId: string;
  operationId: string;
  repositoryProvider: "d1" | "airtable";
  copied: {
    rooms: number;
    tracks: number;
    forms: number;
    formVersions: number;
    evaluationPlans: number;
    evaluationRounds: number;
    evaluationCriteria: number;
    taskTemplates: number;
    communicationTemplates: number;
    communicationTemplateVersions: number;
  };
};

export type EventClonePreparation = {
  source: {
    name: string;
    slug: string;
    timezone: string;
    startsAt: number;
    endsAt: number;
  };
  defaults: {
    name: string;
    slug: string;
    timezone: string;
    startDate: string;
    endDate: string;
    airtableTableName: string;
  };
};

export class EventCloneService {
  private readonly airtable: AirtableProviderBoundary;
  private readonly provisioning: Pick<
    EventRepositoryProvisioningService,
    "provisionAirtable"
  >;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: {
      airtable?: AirtableProviderBoundary;
      provisioning?: Pick<
        EventRepositoryProvisioningService,
        "provisionAirtable"
      >;
    } = {},
  ) {
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
    this.provisioning =
      dependencies.provisioning ??
      new EventRepositoryProvisioningService(this.env);
  }

  private async assertOrganisationAuthority(viewer: Viewer) {
    const membership = await this.env.DB.prepare(
      `SELECT 1
         FROM memberships
        WHERE organisation_id = ? AND person_id = ? AND event_id IS NULL
          AND role IN ('owner', 'administrator')
          AND accepted_at IS NOT NULL AND revoked_at IS NULL
        LIMIT 1`,
    )
      .bind(viewer.organisationId, viewer.personId)
      .first();
    if (!membership) {
      throw new Response(
        "Organisation owner or administrator access is required to create an event.",
        { status: 403 },
      );
    }
  }

  async prepare(viewer: Viewer): Promise<EventClonePreparation> {
    await this.assertOrganisationAuthority(viewer);
    await this.airtable.assertReadable(viewer);
    const source = await this.env.DB.prepare(
      `SELECT name, slug, timezone, starts_at AS startsAt, ends_at AS endsAt
         FROM events
        WHERE id = ? AND organisation_id = ?`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<EventClonePreparation["source"]>();
    if (!source) throw new Response("Event not found", { status: 404 });

    return {
      source,
      defaults: {
        name: cloneNameDefault(source.name),
        slug: cloneSlugDefault(source.slug),
        timezone: source.timezone,
        startDate: nextYear(date(source.startsAt)),
        endDate: nextYear(date(source.endsAt)),
        airtableTableName: AIRTABLE_ROOMS_TABLE,
      },
    };
  }

  async clone(viewer: Viewer, rawInput: unknown): Promise<EventCloneSummary> {
    await this.assertOrganisationAuthority(viewer);
    const input = cloneEventSchema.parse(rawInput);
    const airtableConnection =
      input.repositoryProvider === "airtable"
        ? airtableConnectionInputSchema.parse({
            personalAccessToken: input.personalAccessToken,
            baseId: input.baseId,
            tableName: input.tableName,
          })
        : null;
    const conflict = await this.env.DB.prepare(
      "SELECT 1 FROM events WHERE slug = ? LIMIT 1",
    )
      .bind(input.slug)
      .first();
    if (conflict) throw new EventCloneSlugConflictError();
    await this.airtable.assertReadable(viewer);

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
      this.env.DB.prepare(
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
      this.env.DB.prepare(
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
      this.env.DB.prepare(
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
      this.env.DB.prepare(
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
      this.env.DB.prepare(
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
      this.env.DB.prepare(
        "SELECT id, name, blinded_reviewing AS blindedReviewing, decision_role AS decisionRole FROM evaluation_plans WHERE event_id = ? AND status <> 'archived' ORDER BY created_at, id",
      )
        .bind(viewer.eventId)
        .all<{
          id: string;
          name: string;
          blindedReviewing: number;
          decisionRole: string;
        }>(),
      this.env.DB.prepare(
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
      this.env.DB.prepare(
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
      this.env.DB.prepare(
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
      this.env.DB.prepare(
        "SELECT d.template_id AS templateId, d.depends_on_template_id AS dependsOnTemplateId FROM task_template_dependencies d JOIN task_templates t ON t.id = d.template_id JOIN task_templates dependency ON dependency.id = d.depends_on_template_id WHERE t.event_id = ? AND dependency.event_id = ? AND t.status <> 'archived' AND dependency.status <> 'archived'",
      )
        .bind(viewer.eventId, viewer.eventId)
        .all<{ templateId: string; dependsOnTemplateId: string }>(),
      this.env.DB.prepare(
        "SELECT id, name, category FROM communication_templates WHERE event_id = ? AND status <> 'archived' ORDER BY created_at, id",
      )
        .bind(viewer.eventId)
        .all<{ id: string; name: string; category: string }>(),
      this.env.DB.prepare(
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
      this.env.DB.prepare(
        "SELECT trigger.template_id AS templateId, trigger.trigger_type AS triggerType, trigger.configuration_json AS configurationJson FROM communication_triggers trigger JOIN communication_templates template ON template.id = trigger.template_id AND template.event_id = trigger.event_id WHERE trigger.event_id = ? AND template.status <> 'archived' ORDER BY trigger.trigger_type, trigger.id",
      )
        .bind(viewer.eventId)
        .all<{
          templateId: string;
          triggerType: string;
          configurationJson: string;
        }>(),
    ]);
    if (!source) throw new Response("Source event not found", { status: 404 });
    const filePolicyJson = JSON.stringify(
      parseEventFilePolicy(source.filePolicyJson),
    );
    const sessionFormatsJson = JSON.stringify(
      parseSessionFormatsConfiguration(source.sessionFormatsJson),
    );
    const clonedCommunicationTriggers = communicationTriggers.results.map(
      (row) => ({
        ...row,
        configurationJson: cloneTriggerConfiguration(
          row.configurationJson,
          `Communication trigger ${row.triggerType}`,
        ),
      }),
    );
    const clonedTaskTemplates = taskTemplates.results.flatMap((row) => {
      const configurationJson = cloneableTaskConfiguration(
        row.configurationJson,
        `Task template ${row.id} configuration`,
        row.taskType,
      );
      return configurationJson === null ? [] : [{ ...row, configurationJson }];
    });
    const clonedTaskTemplateIds = new Set(
      clonedTaskTemplates.map((row) => row.id),
    );
    const clonedTaskDependencies = taskDependencies.results.filter(
      (row) =>
        clonedTaskTemplateIds.has(row.templateId) &&
        clonedTaskTemplateIds.has(row.dependsOnTemplateId),
    );

    const recordCount =
      rooms.results.length +
      tracks.results.length +
      forms.results.length +
      formVersions.results.length +
      plans.results.length +
      rounds.results.length +
      criteria.results.length +
      clonedTaskTemplates.length +
      clonedTaskDependencies.length +
      communicationTemplates.results.length +
      communicationVersions.results.length +
      communicationTriggers.results.length;
    if (recordCount > 500) {
      throw new Error(
        "This event template contains more than 500 configuration records and cannot be cloned in one request.",
      );
    }
    const eventId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const pendingAirtable = airtableConnection !== null;
    const formIds = new Map(
      forms.results.map((row) => [row.id, crypto.randomUUID()]),
    );
    const roomIds = new Map(
      rooms.results.map((row) => [row.id, crypto.randomUUID()]),
    );
    const clonedRooms: AirtableProvisioningRoom[] = pendingAirtable
      ? rooms.results.map((room, index) => {
          let resources: unknown;
          try {
            resources = JSON.parse(room.resourcesJson);
          } catch {
            throw new Error(
              `Room ${index + 1} contains invalid resource configuration JSON.`,
            );
          }
          const parsedResources = z.array(z.string()).safeParse(resources);
          if (!parsedResources.success)
            throw new Error(
              `Room ${index + 1} contains invalid resource configuration.`,
            );
          return {
            id: roomIds.get(room.id)!,
            name: room.name,
            building: room.building,
            level: room.level,
            capacity: room.capacity,
            resources: parsedResources.data,
            position: room.position,
          };
        })
      : [];
    const trackIds = new Map(
      tracks.results.map((row) => [row.id, crypto.randomUUID()]),
    );
    const formSlugs = new Map(
      forms.results.map((row) => {
        const id = formIds.get(row.id)!;
        return [row.id, cloneFormSlug(input.slug, row.name, id)];
      }),
    );
    const planIds = new Map(
      plans.results.map((row) => [row.id, crypto.randomUUID()]),
    );
    const roundIds = new Map(
      rounds.results.map((row) => [row.id, crypto.randomUUID()]),
    );
    const taskIds = new Map(
      clonedTaskTemplates.map((row) => [row.id, crypto.randomUUID()]),
    );
    const communicationIds = new Map(
      communicationTemplates.results.map((row) => [
        row.id,
        crypto.randomUUID(),
      ]),
    );
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `INSERT INTO events (
           id, organisation_id, name, slug, timezone, starts_at, ends_at,
           venue_name, city, description, brand_accent, session_formats_json,
           repository_provider,
           retention_months, submission_access_mode, allow_anonymous_drafts,
           duplicate_person_warnings, file_policy_json, revision, last_operation_id,
           last_updated_by_person_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'd1', ?, ?, ?, ?, ?, 1, ?, ?, unixepoch(), unixepoch())`,
      ).bind(
        eventId,
        viewer.organisationId,
        input.name,
        input.slug,
        input.timezone,
        startEpoch(input.startDate),
        endEpoch(input.endDate),
        source.venueName,
        source.city,
        source.description,
        source.brandAccent,
        sessionFormatsJson,
        source.retentionMonths,
        source.submissionAccessMode,
        source.allowAnonymousDrafts,
        source.duplicatePersonWarnings,
        filePolicyJson,
        operationId,
        viewer.personId,
      ),
      this.env.DB.prepare(
        `UPDATE schedule_policies SET
           room_overlap_action = source.room_overlap_action,
           speaker_overlap_action = source.speaker_overlap_action,
           required_resource_overlap_action = source.required_resource_overlap_action,
           exclusive_track_overlap_action = source.exclusive_track_overlap_action,
           event_boundary_action = source.event_boundary_action,
           capacity_action = source.capacity_action,
           minimum_turnaround_minutes = source.minimum_turnaround_minutes,
           revision = 1, updated_at = unixepoch()
          FROM schedule_policies source
         WHERE schedule_policies.event_id = ? AND source.event_id = ?`,
      ).bind(eventId, viewer.eventId),
      ...rooms.results.map((row) =>
        this.env.DB.prepare(
          "INSERT INTO rooms (id,event_id,name,building,level,capacity,resources_json,position,status) VALUES (?,?,?,?,?,?,?,?,?)",
        ).bind(
          roomIds.get(row.id),
          eventId,
          row.name,
          row.building,
          row.level,
          row.capacity,
          row.resourcesJson,
          row.position,
          row.status,
        ),
      ),
      ...tracks.results.map((row) =>
        this.env.DB.prepare(
          "INSERT INTO tracks (id,event_id,name,slug,colour_token,position,exclusive,is_public) VALUES (?,?,?,?,?,?,?,?)",
        ).bind(
          trackIds.get(row.id),
          eventId,
          row.name,
          row.slug,
          row.colour,
          row.position,
          row.exclusive,
          row.isPublic,
        ),
      ),
      ...communicationTemplates.results.map((row) =>
        this.env.DB.prepare(
          "INSERT INTO communication_templates (id,event_id,name,category,status,last_operation_id,created_by_person_id,created_at,updated_at) VALUES (?,?,?,?, 'draft',?,?,unixepoch(),unixepoch())",
        ).bind(
          communicationIds.get(row.id),
          eventId,
          row.name,
          row.category,
          operationId,
          viewer.personId,
        ),
      ),
      ...communicationVersions.results.map((row) =>
        this.env.DB.prepare(
          "INSERT INTO communication_template_versions (id,event_id,template_id,version_number,name,category,channel,subject_template,content_json,rendered_preview_html,status,created_by_person_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,'draft',?,unixepoch())",
        ).bind(
          crypto.randomUUID(),
          eventId,
          communicationIds.get(row.templateId),
          row.versionNumber,
          row.name,
          row.category,
          row.channel,
          row.subjectTemplate,
          row.contentJson,
          row.previewHtml,
          viewer.personId,
        ),
      ),
      ...clonedCommunicationTriggers.map((row) =>
        this.env.DB.prepare(
          "INSERT INTO communication_triggers (id,event_id,template_id,trigger_type,configuration_json,enabled,created_at,updated_at) VALUES (?,?,?,?,?,0,unixepoch(),unixepoch())",
        ).bind(
          crypto.randomUUID(),
          eventId,
          communicationIds.get(row.templateId),
          row.triggerType,
          row.configurationJson,
        ),
      ),
      ...forms.results.map((row) =>
        this.env.DB.prepare(
          "INSERT INTO form_definitions (id,event_id,name,description,kind,status,public_slug,closes_at,submission_limit,min_speakers,max_speakers,access_mode,confirmation_template_id,revision,last_operation_id,created_by_person_id,created_at,updated_at) VALUES (?,?,?,?,?,'draft',?,NULL,?,?,?,?,?,1,?,?,unixepoch(),unixepoch())",
        ).bind(
          formIds.get(row.id),
          eventId,
          row.name,
          row.description,
          row.kind,
          formSlugs.get(row.id),
          row.submissionLimit,
          row.minSpeakers,
          row.maxSpeakers,
          row.accessMode === "password_protected"
            ? "email_verified"
            : row.accessMode,
          row.confirmationTemplateId
            ? (communicationIds.get(row.confirmationTemplateId) ?? null)
            : null,
          operationId,
          viewer.personId,
        ),
      ),
      ...formVersions.results.map((row) => {
        const sourceForm = forms.results.find((form) => form.id === row.formId);
        if (!sourceForm)
          throw new Error(`Form version ${row.id} has no cloneable parent.`);
        const accessMode =
          sourceForm.accessMode === "password_protected"
            ? "email_verified"
            : sourceForm.accessMode;
        const routing = cloneFormRouting(
          row.routingJson,
          `Form version ${row.id} routing`,
          trackIds,
        );
        const settings = {
          ...jsonObject(row.settingsJson, `Form version ${row.id} settings`),
          publicSlug: formSlugs.get(row.formId),
          closesAt: null,
          accessMode,
        };
        return this.env.DB.prepare(
          "INSERT INTO form_versions (id,event_id,form_id,version_number,schema_json,routing_json,settings_snapshot_json,status,revision,created_by_person_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,'draft',1,?,unixepoch(),unixepoch())",
        ).bind(
          crypto.randomUUID(),
          eventId,
          formIds.get(row.formId),
          row.versionNumber,
          row.schemaJson,
          JSON.stringify(routing),
          JSON.stringify(settings),
          viewer.personId,
        );
      }),
      ...plans.results.map((row) =>
        this.env.DB.prepare(
          "INSERT INTO evaluation_plans (id,event_id,name,status,blinded_reviewing,decision_role,revision,created_by_person_id,created_at,updated_at) VALUES (?,?,?,'draft',?,?,1,?,unixepoch(),unixepoch())",
        ).bind(
          planIds.get(row.id),
          eventId,
          row.name,
          row.blindedReviewing,
          row.decisionRole,
          viewer.personId,
        ),
      ),
      ...rounds.results.map((row) =>
        this.env.DB.prepare(
          "INSERT INTO evaluation_rounds (id,event_id,plan_id,round_number,name,status,opens_at,closes_at,advancement_rule_json,revision,created_at,updated_at) VALUES (?,?,?,?,?,'draft',NULL,NULL,?,1,unixepoch(),unixepoch())",
        ).bind(
          roundIds.get(row.id),
          eventId,
          planIds.get(row.planId),
          row.roundNumber,
          row.name,
          row.advancementRuleJson,
        ),
      ),
      ...criteria.results.map((row) =>
        this.env.DB.prepare(
          "INSERT INTO evaluation_criteria (id,event_id,round_id,name,description,input_type,weight_percent,required,position) VALUES (?,?,?,?,?,?,?,?,?)",
        ).bind(
          crypto.randomUUID(),
          eventId,
          roundIds.get(row.roundId),
          row.name,
          row.description,
          row.inputType,
          row.weightPercent,
          row.required,
          row.position,
        ),
      ),
      ...clonedTaskTemplates.map((row) =>
        this.env.DB.prepare(
          "INSERT INTO task_templates (id,event_id,name,description,target_type,task_type,impact,evidence_mode,due_anchor,due_offset_minutes,fixed_due_at,auto_assign_on_acceptance,configuration_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,NULL,?,?,?,unixepoch(),unixepoch())",
        ).bind(
          taskIds.get(row.id),
          eventId,
          row.name,
          row.description,
          row.targetType,
          row.taskType,
          row.impact,
          row.evidenceMode,
          row.dueAnchor === "fixed" ? "none" : row.dueAnchor,
          row.dueAnchor === "fixed" ? null : row.dueOffsetMinutes,
          row.autoAssignOnAcceptance,
          row.configurationJson,
          row.status,
        ),
      ),
      ...clonedTaskDependencies.map((row) =>
        this.env.DB.prepare(
          "INSERT INTO task_template_dependencies (template_id,depends_on_template_id,created_at) VALUES (?,?,unixepoch())",
        ).bind(
          taskIds.get(row.templateId),
          taskIds.get(row.dependsOnTemplateId),
        ),
      ),
    ];
    const copied = {
      rooms: rooms.results.length,
      tracks: tracks.results.length,
      forms: forms.results.length,
      formVersions: formVersions.results.length,
      evaluationPlans: plans.results.length,
      evaluationRounds: rounds.results.length,
      evaluationCriteria: criteria.results.length,
      taskTemplates: clonedTaskTemplates.length,
      communicationTemplates: communicationTemplates.results.length,
      communicationTemplateVersions: communicationVersions.results.length,
    };
    statements.push(
      this.env.DB.prepare(
        `INSERT INTO operation_jobs (
           id,organisation_id,event_id,requested_by_person_id,type,idempotency_key,
           correlation_id,status,payload_json,result_json,progress_total,
           progress_completed,progress_failed,cancellable,started_at,completed_at,
           created_at,updated_at
         ) VALUES (?, ?, ?, ?, 'event.clone', ?, ?, ?, ?, ?, ?, ?, 0, 0,
                   unixepoch(), ?, unixepoch(), unixepoch())`,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        `event-clone:${operationId}`,
        correlationId,
        pendingAirtable ? "running" : "completed",
        JSON.stringify({
          type: "event.clone",
          sourceEventId: viewer.eventId,
          targetEventId: eventId,
          requestedRepositoryProvider: input.repositoryProvider,
        }),
        pendingAirtable
          ? null
          : JSON.stringify({
              targetEventId: eventId,
              copied,
              repositoryProvider: "d1",
            }),
        recordCount,
        pendingAirtable ? 0 : recordCount,
        pendingAirtable ? null : Math.floor(Date.now() / 1_000),
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id,organisation_id,event_id,actor_person_id,action,entity_type,
           entity_id,correlation_id,metadata_json,created_at
         ) VALUES (?,?,?,?, 'event.cloned','event',?,?,?,unixepoch())`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        eventId,
        correlationId,
        JSON.stringify({
          operationId,
          sourceEventId: viewer.eventId,
          targetEventId: eventId,
          name: input.name,
          slug: input.slug,
          copied,
          requestedRepositoryProvider: input.repositoryProvider,
        }),
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id,organisation_id,event_id,actor_person_id,action,entity_type,
           entity_id,correlation_id,metadata_json,created_at
         ) VALUES (?,?,?,?, 'event.created_from_template','event',?,?,?,unixepoch())`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        eventId,
        viewer.personId,
        eventId,
        correlationId,
        JSON.stringify({ operationId, sourceEventId: viewer.eventId, copied }),
      ),
    );
    try {
      await this.env.DB.batch(statements);
    } catch (error) {
      if (
        error instanceof Error &&
        /UNIQUE constraint failed: events\.slug/iu.test(error.message)
      ) {
        throw new EventCloneSlugConflictError();
      }
      throw error;
    }
    if (pendingAirtable) {
      await this.provisioning.provisionAirtable(
        viewer,
        eventId,
        operationId,
        "event_clone",
        airtableConnection,
        clonedRooms,
        { copied },
      );
    }
    return {
      eventId,
      operationId,
      copied,
      repositoryProvider: input.repositoryProvider,
    };
  }
}
