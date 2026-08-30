import { z } from "zod";
import { requireValue } from "~/lib/required-value";

import { communicationTriggerConfigurationSchema } from "~/modules/communications/communication-schema";
import { parseSessionFormatsConfiguration } from "~/modules/events/event-configuration";
import type { AirtableProvisioningRoom } from "~/modules/events/event-repository-provisioning.server";
import { parseEventFilePolicy } from "~/modules/files/file-policy";
import { routingSchema } from "~/modules/submissions/submission-schema";
import type { Viewer } from "~/platform/auth/authorize.server";
import type { EventCloneSource } from "./event-clone-source.server";

const EVENT_NAME_MAX_LENGTH = 160;
const EVENT_SLUG_MAX_LENGTH = 120;
const CLONE_NAME_SUFFIX = " Copy";
const CLONE_SLUG_SUFFIX = "-copy";

export class EventCloneConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventCloneConfigurationError";
  }
}

function startEpoch(date: string) {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1_000);
}

function endEpoch(date: string) {
  return Math.floor(Date.parse(`${date}T23:59:59Z`) / 1_000);
}

export function cloneDate(epoch: number) {
  return new Date(epoch * 1_000).toISOString().slice(0, 10);
}

export function nextYearDate(value: string) {
  const parsed = new Date(`${value}T12:00:00Z`);
  parsed.setUTCFullYear(parsed.getUTCFullYear() + 1);
  return parsed.toISOString().slice(0, 10);
}

export function cloneNameDefault(sourceName: string) {
  return `${sourceName.slice(0, EVENT_NAME_MAX_LENGTH - CLONE_NAME_SUFFIX.length)}${CLONE_NAME_SUFFIX}`;
}

export function cloneSlugDefault(
  sourceSlug: string,
  takenSlugs: ReadonlyArray<string> = [],
) {
  const reserved = new Set(takenSlugs);
  const firstStem = sourceSlug
    .slice(0, EVENT_SLUG_MAX_LENGTH - CLONE_SLUG_SUFFIX.length)
    .replace(/-+$/u, "");
  const first = `${firstStem}${CLONE_SLUG_SUFFIX}`;
  if (!reserved.has(first)) return first;
  for (let index = 2; index < 1000; index += 1) {
    const numberedSuffix = `${CLONE_SLUG_SUFFIX}-${index}`;
    const stem = sourceSlug
      .slice(0, EVENT_SLUG_MAX_LENGTH - numberedSuffix.length)
      .replace(/-+$/u, "");
    const candidate = `${stem}${numberedSuffix}`;
    if (!reserved.has(candidate)) return candidate;
  }
  throw new EventCloneConfigurationError(
    "Could not allocate a unique slug for the cloned event.",
  );
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
  throw new EventCloneConfigurationError(
    `${context} references a resource page, which event cloning does not copy. Remove or archive the generated acknowledgement task before cloning this event.`,
  );
}

function cloneConfirmationTemplateId(
  sourceTemplateId: string | null,
  clonedTemplateIds: Map<string, string>,
  formId: string,
) {
  if (sourceTemplateId === null) return null;
  const clonedTemplateId = clonedTemplateIds.get(sourceTemplateId);
  if (!clonedTemplateId) {
    throw new EventCloneConfigurationError(
      `Form ${formId} references confirmation template ${sourceTemplateId}, which is not available to clone. Remove the reference or restore the template before cloning this event.`,
    );
  }
  return clonedTemplateId;
}

function cloneFormSlug(eventSlug: string, name: string, formId: string) {
  const nameSlug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "") || "form";
  return `${eventSlug}-${nameSlug}-${formId.slice(0, 8)}`;
}

export type EventClonePlanReusedSender = {
  id: string;
  sourceEventId: string;
  name: string;
  fromName: string;
  fromEmail: string;
  replyToEmail: string | null;
  provider: string;
  providerSenderId: string | null;
};

type EventClonePlanInput = {
  name: string;
  slug: string;
  timezone: string;
  startDate: string;
  endDate: string;
  repositoryProvider: "d1" | "airtable";
  reusedSender?: EventClonePlanReusedSender | null;
};

export function buildEventClonePlan(
  env: CloudflareEnvironment,
  viewer: Viewer,
  input: EventClonePlanInput,
  data: EventCloneSource & {
    source: NonNullable<EventCloneSource["source"]>;
  },
) {
  const {
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
    participantFieldPolicies,
    fieldDefinitions,
  } = data;
  if (
    source.participantLogoUrl ||
    source.programmeHeroImageUrl ||
    source.brandLogoAssetId ||
    source.brandBannerAssetId ||
    source.brandDraftLogoAssetId ||
    source.brandDraftBannerAssetId
  )
    throw new EventCloneConfigurationError(
      "This event has logo or banner images that the clone workflow cannot copy safely. Remove them from both the branding draft and published branding before cloning.",
    );
  if (
    source.brandDraftAccent !== source.brandAccent ||
    source.brandDraftWelcomeText !== source.participantWelcomeText ||
    source.brandDraftSupportUrl !== source.participantSupportUrl
  )
    throw new EventCloneConfigurationError(
      "This event has unpublished branding changes. Publish or discard them before cloning so the copied branding is unambiguous.",
    );
  const pendingAirtable = input.repositoryProvider === "airtable";
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
  const clonedTaskTemplates = taskTemplates.results.map((row) => {
    const configurationJson = cloneableTaskConfiguration(
      row.configurationJson,
      `Task template ${row.id} configuration`,
      row.taskType,
    );
    return { ...row, configurationJson };
  });
  const clonedTaskTemplateIds = new Set(
    clonedTaskTemplates.map((row) => row.id),
  );
  const clonedTaskDependencies = taskDependencies.results.filter(
    (row) =>
      clonedTaskTemplateIds.has(row.templateId) &&
      clonedTaskTemplateIds.has(row.dependsOnTemplateId),
  );

  const reusedSenderCount = input.reusedSender ? 1 : 0;
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
    communicationTriggers.results.length +
    participantFieldPolicies.results.length +
    fieldDefinitions.results.length +
    reusedSenderCount;
  if (recordCount > 500) {
    throw new Error(
      "This event template contains more than 500 configuration records and cannot be cloned in one request.",
    );
  }
  const eventId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const correlationId = crypto.randomUUID();
  const clonedSenderProfileId = input.reusedSender ? crypto.randomUUID() : null;
  const reusedSenderEvidence =
    input.reusedSender && clonedSenderProfileId
      ? {
          reusedSenderProfileId: input.reusedSender.id,
          reusedSenderSourceEventId: input.reusedSender.sourceEventId,
          clonedSenderProfileId,
        }
      : {};
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
          id: requireValue(
            roomIds.get(room.id),
            "Required roomIds.get(room.id) is unavailable.",
          ),
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
      const id = requireValue(
        formIds.get(row.id),
        "Required formIds.get(row.id) is unavailable.",
      );
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
    communicationTemplates.results.map((row) => [row.id, crypto.randomUUID()]),
  );
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO events (
         id, organisation_id, name, slug, timezone, starts_at, ends_at,
         venue_name, venue_address, venue_map_url, programme_hero_image_url,
         city, description, brand_accent, participant_logo_url,
         participant_welcome_text, participant_support_url,
         brand_draft_accent, brand_draft_welcome_text,
         brand_draft_support_url, brand_published_at, session_formats_json,
         repository_provider, activation_status,
         retention_months, submission_access_mode, allow_anonymous_drafts,
         duplicate_person_warnings, file_policy_json, revision, last_operation_id,
         last_updated_by_person_id, created_at, updated_at
       ) VALUES (
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, ?,
         unixepoch(), ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, unixepoch(), unixepoch()
       )`,
    ).bind(
      eventId,
      viewer.organisationId,
      input.name,
      input.slug,
      input.timezone,
      startEpoch(input.startDate),
      endEpoch(input.endDate),
      source.venueName,
      source.venueAddress,
      source.venueMapUrl,
      source.city,
      source.description,
      source.brandAccent,
      source.participantWelcomeText,
      source.participantSupportUrl,
      source.brandAccent,
      source.participantWelcomeText,
      source.participantSupportUrl,
      sessionFormatsJson,
      input.repositoryProvider,
      pendingAirtable ? "provisioning" : "active",
      source.retentionMonths,
      source.submissionAccessMode,
      source.allowAnonymousDrafts,
      source.duplicatePersonWarnings,
      filePolicyJson,
      operationId,
      viewer.personId,
    ),
    env.DB.prepare(
      `UPDATE schedule_policies SET
         room_overlap_action = source.room_overlap_action,
         speaker_overlap_action = source.speaker_overlap_action,
         required_resource_overlap_action = source.required_resource_overlap_action,
         exclusive_track_overlap_action = source.exclusive_track_overlap_action,
         event_boundary_action = source.event_boundary_action,
         capacity_action = source.capacity_action,
         speaker_unavailable_action = source.speaker_unavailable_action,
         minimum_turnaround_minutes = source.minimum_turnaround_minutes,
         revision = 1, updated_at = unixepoch()
        FROM schedule_policies source
       WHERE schedule_policies.event_id = ? AND source.event_id = ?`,
    ).bind(eventId, viewer.eventId),
    ...rooms.results.map((row) =>
      env.DB.prepare(
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
      env.DB.prepare(
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
    ...participantFieldPolicies.results.map((row) =>
      env.DB.prepare(
        `INSERT INTO event_participant_field_policies (
           event_id, field_key, participant_access, updated_by_person_id,
           updated_at
         ) VALUES (?, ?, ?, ?, unixepoch())`,
      ).bind(eventId, row.fieldKey, row.participantAccess, viewer.personId),
    ),
    ...fieldDefinitions.results.map((row) =>
      env.DB.prepare(
        `INSERT INTO event_field_definitions (
           id, event_id, owner_type, field_key, label, field_type,
           options_json, participant_access, required, position, status,
           revision, created_by_person_id, updated_by_person_id, created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, ?, ?,
                   unixepoch(), unixepoch())`,
      ).bind(
        crypto.randomUUID(),
        eventId,
        row.ownerType,
        row.fieldKey,
        row.label,
        row.fieldType,
        row.optionsJson,
        row.participantAccess,
        row.required,
        row.position,
        viewer.personId,
        viewer.personId,
      ),
    ),
    ...communicationTemplates.results.map((row) =>
      env.DB.prepare(
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
      env.DB.prepare(
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
      env.DB.prepare(
        "INSERT INTO communication_triggers (id,event_id,template_id,trigger_type,configuration_json,enabled,created_at,updated_at) VALUES (?,?,?,?,?,0,unixepoch(),unixepoch())",
      ).bind(
        crypto.randomUUID(),
        eventId,
        communicationIds.get(row.templateId),
        row.triggerType,
        row.configurationJson,
      ),
    ),
    ...forms.results.map((row) => {
      const confirmationTemplateId = cloneConfirmationTemplateId(
        row.confirmationTemplateId,
        communicationIds,
        row.id,
      );
      return env.DB.prepare(
        "INSERT INTO form_definitions (id,event_id,name,description,kind,status,public_slug,opens_at,closes_at,submission_limit,per_person_submission_limit,min_speakers,max_speakers,access_mode,confirmation_template_id,revision,last_operation_id,created_by_person_id,created_at,updated_at) VALUES (?,?,?,?,?,'draft',?,NULL,NULL,?,?,?,?,?,?,1,?,?,unixepoch(),unixepoch())",
      ).bind(
        formIds.get(row.id),
        eventId,
        row.name,
        row.description,
        row.kind,
        formSlugs.get(row.id),
        row.submissionLimit,
        row.perPersonSubmissionLimit,
        row.minSpeakers,
        row.maxSpeakers,
        row.accessMode === "password_protected"
          ? "email_verified"
          : row.accessMode,
        confirmationTemplateId,
        operationId,
        viewer.personId,
      );
    }),
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
        opensAt: null,
        closesAt: null,
        accessMode,
      };
      return env.DB.prepare(
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
      env.DB.prepare(
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
      env.DB.prepare(
        "INSERT INTO evaluation_rounds (id,event_id,plan_id,round_number,name,status,opens_at,closes_at,blinded_reviewing,scorecard_id,scorecard_version,recommendation_choices_json,advancement_rule_json,revision,created_at,updated_at) VALUES (?,?,?,?,?,'draft',NULL,NULL,?,?,?,?,?,1,unixepoch(),unixepoch())",
      ).bind(
        roundIds.get(row.id),
        eventId,
        planIds.get(row.planId),
        row.roundNumber,
        row.name,
        row.blindedReviewing,
        row.scorecardId,
        row.scorecardVersion,
        row.recommendationChoicesJson,
        row.advancementRuleJson,
      ),
    ),
    ...criteria.results.map((row) =>
      env.DB.prepare(
        "INSERT INTO evaluation_criteria (id,event_id,round_id,name,description,input_type,options_json,weight_percent,required,position) VALUES (?,?,?,?,?,?,?,?,?,?)",
      ).bind(
        crypto.randomUUID(),
        eventId,
        roundIds.get(row.roundId),
        row.name,
        row.description,
        row.inputType,
        row.optionsJson,
        row.weightPercent,
        row.required,
        row.position,
      ),
    ),
    ...clonedTaskTemplates.map((row) =>
      env.DB.prepare(
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
      env.DB.prepare(
        "INSERT INTO task_template_dependencies (template_id,depends_on_template_id,created_at) VALUES (?,?,unixepoch())",
      ).bind(taskIds.get(row.templateId), taskIds.get(row.dependsOnTemplateId)),
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
    participantFieldPolicies: participantFieldPolicies.results.length,
    fieldDefinitions: fieldDefinitions.results.length,
    senders: reusedSenderCount,
  };
  statements.push(
    env.DB.prepare(
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
        ...reusedSenderEvidence,
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
    env.DB.prepare(
      `INSERT INTO audit_events (
         id, actor_kind, origin, metadata_version,organisation_id,event_id,actor_person_id,action,entity_type,
         entity_id,correlation_id,metadata_json,created_at
       ) VALUES (?, 'person', 'admin_ui', 1,?,?,?, 'event.cloned','event',?,?,?,unixepoch())`,
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
        ...reusedSenderEvidence,
      }),
    ),
    env.DB.prepare(
      `INSERT INTO audit_events (
         id, actor_kind, origin, metadata_version,organisation_id,event_id,actor_person_id,action,entity_type,
         entity_id,correlation_id,metadata_json,created_at
       ) VALUES (?, 'person', 'admin_ui', 1,?,?,?, 'event.created_from_template','event',?,?,?,unixepoch())`,
    ).bind(
      crypto.randomUUID(),
      viewer.organisationId,
      eventId,
      viewer.personId,
      eventId,
      correlationId,
      JSON.stringify({
        operationId,
        sourceEventId: viewer.eventId,
        copied,
        ...reusedSenderEvidence,
      }),
    ),
    ...(input.reusedSender && clonedSenderProfileId
      ? [
          env.DB.prepare(
            `INSERT INTO sender_profiles (
               id, event_id, name, from_name, from_email, reply_to_email,
               provider, provider_sender_id, status, created_at, updated_at
             )
             SELECT ?, ?, verified.name, verified.from_name, verified.from_email,
                    verified.reply_to_email, verified.provider,
                    verified.provider_sender_id, 'verified',
                    unixepoch(), unixepoch()
               FROM (SELECT 1 AS probe)
               LEFT JOIN (
                 SELECT sender.name, sender.from_name, sender.from_email,
                        sender.reply_to_email, sender.provider,
                        sender.provider_sender_id
                   FROM sender_profiles sender
                   JOIN events event ON event.id = sender.event_id
                  WHERE sender.id = ? AND sender.event_id = ?
                    AND event.organisation_id = ?
                    AND event.activation_status = 'active'
                    AND sender.status = 'verified' AND sender.provider = ?
                    AND sender.name = ? AND sender.from_name = ?
                    AND sender.from_email = ? AND sender.reply_to_email IS ?
                    AND sender.provider_sender_id IS ?
                    AND (sender.provider <> 'resend'
                         OR sender.provider_sender_id IS NOT NULL)
               ) verified ON 1 = 1`,
          ).bind(
            clonedSenderProfileId,
            eventId,
            input.reusedSender.id,
            input.reusedSender.sourceEventId,
            viewer.organisationId,
            input.reusedSender.provider,
            input.reusedSender.name,
            input.reusedSender.fromName,
            input.reusedSender.fromEmail,
            input.reusedSender.replyToEmail,
            input.reusedSender.providerSenderId,
          ),
          env.DB.prepare(
            `INSERT INTO audit_events (
               id, actor_kind, origin, metadata_version, organisation_id,
               event_id, actor_person_id, action, entity_type, entity_id,
               correlation_id, metadata_json, created_at
             ) VALUES (?, 'person', 'admin_ui', 1, ?, ?, ?,
                       'communication.sender.reused', 'sender_profile', ?, ?, ?,
                       unixepoch())`,
          ).bind(
            crypto.randomUUID(),
            viewer.organisationId,
            eventId,
            viewer.personId,
            clonedSenderProfileId,
            correlationId,
            JSON.stringify({
              sourceEventId: input.reusedSender.sourceEventId,
              sourceSenderProfileId: input.reusedSender.id,
              provider: input.reusedSender.provider,
              providerSenderId: input.reusedSender.providerSenderId,
              fromEmail: input.reusedSender.fromEmail,
            }),
          ),
        ]
      : []),
  );
  return {
    statements,
    copied,
    clonedRooms,
    eventId,
    operationId,
    recordCount,
  };
}
