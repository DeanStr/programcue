import { z } from "zod";

export const resourceInputSchema = z
  .object({
    id: z.string().optional(),
    revision: z.coerce.number().int().positive().optional(),
    title: z.string().trim().min(3).max(180),
    slug: z
      .string()
      .trim()
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
        "Use a lowercase URL slug with hyphens.",
      )
      .max(100),
    category: z.string().trim().max(100),
    audienceScope: z.enum([
      "all_speakers",
      "accepted_speakers",
      "confirmed_speakers",
      "custom",
    ]),
    audiencePersonIds: z.array(z.string().trim().min(1)).max(1_000).default([]),
    acknowledgementRequired: z
      .union([z.literal("true"), z.literal("false"), z.boolean()])
      .transform((value) => value === true || value === "true"),
    document: z.unknown(),
  })
  .superRefine((value, context) => {
    const uniqueAudience = new Set(value.audiencePersonIds);
    if (uniqueAudience.size !== value.audiencePersonIds.length) {
      context.addIssue({
        code: "custom",
        path: ["audiencePersonIds"],
        message: "Select each custom-audience speaker only once.",
      });
    }
    if (value.audienceScope === "custom" && uniqueAudience.size === 0) {
      context.addIssue({
        code: "custom",
        path: ["audiencePersonIds"],
        message: "Select at least one speaker for a custom audience.",
      });
    }
    if (value.audienceScope !== "custom" && uniqueAudience.size > 0) {
      context.addIssue({
        code: "custom",
        path: ["audiencePersonIds"],
        message: "Custom speakers can be selected only for a custom audience.",
      });
    }
  });

export class ResourceRevisionConflictError extends Error {
  constructor(
    message = "This resource changed after the page loaded. Refresh before saving again.",
  ) {
    super(message);
    this.name = "ResourceRevisionConflictError";
  }
}

export class ResourceSlugConflictError extends Error {
  constructor() {
    super("That resource URL is already in use for this event.");
    this.name = "ResourceSlugConflictError";
  }
}

export class ResourceTaskDependencyError extends Error {
  constructor() {
    super(
      "This version cannot be published because a submitted or completed task depends on an acknowledgement that would be reset. Reopen the dependent task first.",
    );
    this.name = "ResourceTaskDependencyError";
  }
}

export class ResourceAudienceError extends Error {
  constructor() {
    super(
      "Every custom-audience person must still be a speaker in this event. Review the selected speakers.",
    );
    this.name = "ResourceAudienceError";
  }
}

export class ResourceInvariantError extends Error {
  constructor(pageId: string, detail: string) {
    super(`Resource page ${pageId} is invalid: ${detail}`);
    this.name = "ResourceInvariantError";
  }
}

export type PageRow = {
  id: string;
  title: string;
  slug: string;
  category: string | null;
  status: "draft" | "published" | "archived";
  audienceScope:
    | "all_speakers"
    | "accepted_speakers"
    | "confirmed_speakers"
    | "custom";
  acknowledgementRequired: number;
  revision: number;
  updatedAt: number;
  versionId: string | null;
  versionNumber: number | null;
  versionStatus: string | null;
  documentJson: string | null;
  renderedHtml: string | null;
  publishedAt: number | null;
};

export type ResourcePublishPage = {
  id: string;
  title: string;
  slug: string;
  category: string | null;
  audienceScope:
    | "all_speakers"
    | "accepted_speakers"
    | "confirmed_speakers"
    | "custom";
  revision: number;
  acknowledgementRequired: number;
  versionId: string;
  versionNumber: number;
  documentJson: string;
};

export const successfulResourcePublishAttemptSql = `EXISTS (
  SELECT 1
    FROM resource_page_versions published_version
    JOIN resource_pages publishing_page
      ON publishing_page.id = published_version.resource_page_id
     AND publishing_page.event_id = published_version.event_id
   WHERE published_version.id = ?
     AND published_version.status = 'published'
     AND publishing_page.last_operation_id = ?
)`;

export function participantAudienceSql(
  personIdSql = "?",
  versionAlias = "rv",
  speakerAccessSql = "1",
) {
  return `(
    (${speakerAccessSql})
    AND (
    ${versionAlias}.audience_scope = 'all_speakers'
    OR (${versionAlias}.audience_scope = 'accepted_speakers' AND EXISTS (
      SELECT 1 FROM session_speakers ss
       WHERE ss.event_id = rp.event_id AND ss.person_id = ${personIdSql}
         AND ss.participation_status IN ('pending','confirmed')
    ))
    OR (${versionAlias}.audience_scope = 'confirmed_speakers' AND EXISTS (
      SELECT 1 FROM session_speakers ss
       WHERE ss.event_id = rp.event_id AND ss.person_id = ${personIdSql}
         AND ss.participation_status = 'confirmed'
    ))
    OR (${versionAlias}.audience_scope = 'custom' AND EXISTS (
      SELECT 1 FROM resource_audiences ra
       WHERE ra.resource_page_version_id = ${versionAlias}.id AND ra.event_id = rp.event_id
         AND (
           (ra.target_type = 'person' AND ra.target_id = ${personIdSql})
           OR (ra.target_type = 'role' AND ra.target_id = 'speaker')
           OR (ra.target_type = 'session' AND EXISTS (
             SELECT 1 FROM session_speakers ss
             WHERE ss.event_id = rp.event_id AND ss.session_id = ra.target_id
                AND ss.person_id = ${personIdSql}
                AND ss.participation_status IN ('pending','confirmed')
           ))
         )
    ))
    )
  )`;
}

export function participantSpeakerAccessSql(
  personIdSql: string,
  roleSql: string,
) {
  return `(
    ${roleSql} = 'speaker'
    OR EXISTS (
      SELECT 1 FROM session_speakers entitled_speaker
       WHERE entitled_speaker.event_id = rp.event_id
         AND entitled_speaker.person_id = ${personIdSql}
    )
  )`;
}

export function acknowledgementTaskStatementsForCandidates(
  env: CloudflareEnvironment,
  eventId: string,
  candidateSql: string,
  candidateBindings: unknown[],
) {
  const candidateAudienceSql = participantAudienceSql(
    "candidate.person_id",
    "rv",
  );
  return [
    env.DB.prepare(
      `
      WITH candidates(person_id) AS (${candidateSql})
      INSERT OR IGNORE INTO task_instances (
        id, event_id, template_id, target_type, target_id, owner_person_id,
        title, description, task_type, impact, status, readiness_state,
        evidence_mode, configuration_json, readiness_percent, revision,
        created_at, updated_at
      )
      SELECT 'resource-ack:' || rp.id || ':' || candidate.person_id,
             rp.event_id, template.id, 'speaker', candidate.person_id,
             candidate.person_id, 'Read ' || rv.title,
             'Read and acknowledge the current published version.',
             'acknowledgement', 'medium', 'not_started', 'on_track',
             template.evidence_mode, template.configuration_json, 0, 1,
             unixepoch(), unixepoch()
        FROM candidates candidate
        JOIN resource_pages rp ON rp.event_id = ? AND rp.status = 'published'
        JOIN resource_page_versions rv
          ON rv.resource_page_id = rp.id AND rv.event_id = rp.event_id
         AND rv.status = 'published' AND rv.acknowledgement_required = 1
        JOIN task_templates template
          ON template.id = 'resource-ack:' || rp.id
         AND template.event_id = rp.event_id AND template.status = 'active'
       WHERE ${candidateAudienceSql}
    `,
    ).bind(...candidateBindings, eventId),
    env.DB.prepare(
      `
      WITH candidates(person_id) AS (${candidateSql})
      UPDATE task_instances
         SET status = 'not_started', readiness_state = 'on_track',
             readiness_percent = 0, evidence_json = NULL, completed_at = NULL,
             completed_by_person_id = NULL, revision = revision + 1,
             updated_at = unixepoch()
       WHERE event_id = ? AND status = 'waived'
         AND waiver_json IS NULL
         AND json_extract(evidence_json, '$.reason') IN (
           'Resource audience changed',
           'Published resource no longer requires acknowledgement'
         )
         AND EXISTS (
           SELECT 1
             FROM candidates candidate
             JOIN resource_pages rp
               ON rp.event_id = task_instances.event_id
              AND task_instances.template_id = 'resource-ack:' || rp.id
             JOIN resource_page_versions rv
               ON rv.resource_page_id = rp.id AND rv.event_id = rp.event_id
              AND rv.status = 'published' AND rv.acknowledgement_required = 1
            WHERE candidate.person_id = task_instances.target_id
              AND ${candidateAudienceSql}
         )
    `,
    ).bind(...candidateBindings, eventId),
  ];
}

export function materializePublishedConfirmedSpeakerAcknowledgements(
  env: CloudflareEnvironment,
  eventId: string,
  personId: string,
  confirmationAuditEventId: string,
) {
  const firstConfirmationCandidateSql = `
    SELECT ? AS person_id
     WHERE EXISTS (
       SELECT 1 FROM audit_events audit
        WHERE audit.id = ? AND audit.event_id = ?
          AND audit.action = 'speaker.participation.confirmed'
          AND json_extract(audit.metadata_json, '$.personId') = ?
     )
       AND 1 = (
         SELECT COUNT(*) FROM session_speakers relationship
          WHERE relationship.event_id = ? AND relationship.person_id = ?
            AND relationship.participation_status = 'confirmed'
       )`;
  const candidateBindings = [
    personId,
    confirmationAuditEventId,
    eventId,
    personId,
    eventId,
    personId,
  ];
  return [
    env.DB.prepare(
      `
      WITH candidates(person_id) AS (${firstConfirmationCandidateSql})
      INSERT OR IGNORE INTO task_instances (
        id, event_id, template_id, target_type, target_id, owner_person_id,
        title, description, task_type, impact, status, readiness_state,
        evidence_mode, configuration_json, readiness_percent, revision,
        created_at, updated_at
      )
      SELECT 'resource-ack:' || rp.id || ':' || candidate.person_id,
             rp.event_id, template.id, 'speaker', candidate.person_id,
             candidate.person_id, 'Read ' || rv.title,
             'Read and acknowledge the current published version.',
             'acknowledgement', 'medium', 'not_started', 'on_track',
             template.evidence_mode, template.configuration_json, 0, 1,
             unixepoch(), unixepoch()
        FROM candidates candidate
        JOIN resource_pages rp ON rp.event_id = ? AND rp.status = 'published'
        JOIN resource_page_versions rv
          ON rv.resource_page_id = rp.id AND rv.event_id = rp.event_id
         AND rv.status = 'published' AND rv.acknowledgement_required = 1
         AND rv.audience_scope = 'confirmed_speakers'
        JOIN task_templates template
          ON template.id = 'resource-ack:' || rp.id
         AND template.event_id = rp.event_id AND template.status = 'active'
    `,
    ).bind(...candidateBindings, eventId),
    env.DB.prepare(
      `
      WITH candidates(person_id) AS (${firstConfirmationCandidateSql})
      UPDATE task_instances
         SET title = 'Read ' || current_version.title,
             description = 'Read and acknowledge the current published version.',
             status = 'not_started', readiness_state = 'on_track',
             readiness_percent = 0, evidence_json = NULL, waiver_json = NULL,
             submitted_at = NULL, completed_at = NULL,
             completed_by_person_id = NULL,
             revision = task_instances.revision + 1,
             updated_at = unixepoch()
        FROM resource_pages page
        JOIN resource_page_versions current_version
          ON current_version.resource_page_id = page.id
         AND current_version.event_id = page.event_id
         AND current_version.status = 'published'
         AND current_version.acknowledgement_required = 1
         AND current_version.audience_scope = 'confirmed_speakers'
       WHERE task_instances.event_id = ?
         AND task_instances.target_id = ?
         AND task_instances.template_id = 'resource-ack:' || page.id
         AND page.event_id = task_instances.event_id
         AND page.status = 'published'
         AND task_instances.status = 'waived'
         AND task_instances.waiver_json IS NULL
         AND json_extract(task_instances.evidence_json, '$.reason') IN (
           'Resource audience changed',
           'Published resource no longer requires acknowledgement'
         )
         AND EXISTS (
           SELECT 1 FROM candidates candidate
            WHERE candidate.person_id = task_instances.target_id
         )
    `,
    ).bind(...candidateBindings, eventId, personId),
  ];
}

export function materializePublishedResourceAcknowledgementsForSession(
  env: CloudflareEnvironment,
  eventId: string,
  sessionId: string,
) {
  return acknowledgementTaskStatementsForCandidates(
    env,
    eventId,
    "SELECT DISTINCT person_id FROM session_speakers WHERE event_id = ? AND session_id = ?",
    [eventId, sessionId],
  );
}

export function materializePublishedResourceAcknowledgementsForParticipationReset(
  env: CloudflareEnvironment,
  eventId: string,
  sessionId: string,
  personId: string,
  participationRevision: number,
  resetAuditEventId: string,
) {
  return acknowledgementTaskStatementsForCandidates(
    env,
    eventId,
    `SELECT relationship.person_id
       FROM session_speakers relationship
      WHERE relationship.event_id = ?
        AND relationship.session_id = ?
        AND relationship.person_id = ?
        AND relationship.participation_status = 'pending'
        AND relationship.participation_revision = ?
        AND EXISTS (
          SELECT 1 FROM audit_events audit
           WHERE audit.id = ? AND audit.event_id = relationship.event_id
             AND audit.action = 'speaker.participation.reset'
             AND json_extract(audit.metadata_json, '$.sessionId') = relationship.session_id
             AND json_extract(audit.metadata_json, '$.personId') = relationship.person_id
        )`,
    [eventId, sessionId, personId, participationRevision, resetAuditEventId],
  );
}

export function materializePublishedResourceAcknowledgementsForRoleAssignment(
  env: CloudflareEnvironment,
  eventId: string,
  sessionId: string,
  personId: string,
  role: string,
  assignmentAuditEventId: string,
) {
  return acknowledgementTaskStatementsForCandidates(
    env,
    eventId,
    `SELECT relationship.person_id
       FROM session_speakers relationship
      WHERE relationship.event_id = ?
        AND relationship.session_id = ?
        AND relationship.person_id = ?
        AND relationship.participation_status = 'pending'
        AND EXISTS (
          SELECT 1 FROM audit_events audit
           WHERE audit.id = ? AND audit.event_id = relationship.event_id
             AND audit.action = 'speaker.role.assigned'
             AND audit.entity_id = relationship.session_id || ':' || relationship.person_id || ':' || ?
        )
        AND EXISTS (
          SELECT 1 FROM session_participant_roles assigned_role
           WHERE assigned_role.event_id = relationship.event_id
             AND assigned_role.session_id = relationship.session_id
             AND assigned_role.person_id = relationship.person_id
             AND assigned_role.role = ?
             AND assigned_role.participation_status = 'pending'
             AND assigned_role.participation_revision = 1
        )`,
    [eventId, sessionId, personId, assignmentAuditEventId, role, role],
  );
}

export function materializePublishedResourceAcknowledgementsForClaimedSpeaker(
  env: CloudflareEnvironment,
  eventId: string,
  invitationId: string,
  personId: string,
  operationId: string,
) {
  return acknowledgementTaskStatementsForCandidates(
    env,
    eventId,
    `SELECT DISTINCT speaker.person_id
       FROM submission_speakers speaker
       JOIN events event ON event.id = speaker.event_id
      WHERE speaker.id = ? AND speaker.event_id = ?
        AND speaker.person_id = ? AND speaker.invitation_status = 'claimed'
        AND event.last_operation_id = ?
        AND EXISTS (
          SELECT 1 FROM session_speakers relationship
           WHERE relationship.event_id = speaker.event_id
             AND relationship.person_id = speaker.person_id
        )`,
    [invitationId, eventId, personId, operationId],
  );
}
