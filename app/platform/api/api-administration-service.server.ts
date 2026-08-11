import { z } from "zod";

import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import {
  decodePrivateCursor,
  encodePrivateCursor,
  isoTimestamp,
  parseStrictQuery,
} from "./api-pagination.server";
import type { ApiKeyScope } from "./api-key-service.server";
import { ApiError, type ApiPrincipal } from "./api.server";

export const ADMIN_API_RESOURCES = [
  "submissions",
  "forms",
  "people",
  "speakers",
  "sessions",
  "schedule-versions",
  "decisions",
  "communications",
  "resources",
] as const;

export type AdminApiResource = (typeof ADMIN_API_RESOURCES)[number];

const AIRTABLE_MANAGED_ADMIN_RESOURCES = new Set<AdminApiResource>([
  "submissions",
  "forms",
  "people",
  "speakers",
  "sessions",
  "schedule-versions",
  "decisions",
]);

export function isAirtableManagedAdminResource(resource: AdminApiResource) {
  return AIRTABLE_MANAGED_ADMIN_RESOURCES.has(resource);
}

const resourceSchema = z.enum(ADMIN_API_RESOURCES);
const limitSchema = z
  .string()
  .regex(/^\d+$/u, "limit must be a whole number from 1 to 100")
  .transform(Number)
  .pipe(z.number().int().min(1).max(100))
  .default(50);
const baseQuery = {
  limit: limitSchema,
  cursor: z.string().trim().min(1).max(512).optional(),
  q: z.string().trim().min(1).max(160).optional(),
};

const querySchemas = {
  submissions: z
    .object({
      ...baseQuery,
      status: z
        .enum([
          "draft",
          "submitted",
          "assigned",
          "in_review",
          "decision_ready",
          "accepted",
          "waitlisted",
          "rejected",
          "withdrawn",
        ])
        .optional(),
      formId: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
  forms: z
    .object({
      ...baseQuery,
      status: z.enum(["draft", "published", "closed", "archived"]).optional(),
      kind: z.enum(["submission", "direct_session"]).optional(),
    })
    .strict(),
  people: z
    .object({
      ...baseQuery,
      profileStatus: z.enum(["draft", "published", "archived"]).optional(),
      role: z
        .enum([
          "owner",
          "administrator",
          "committee_chair",
          "evaluator",
          "submitter",
          "speaker",
        ])
        .optional(),
    })
    .strict(),
  speakers: z
    .object({
      ...baseQuery,
      profileStatus: z.enum(["draft", "published", "archived"]).optional(),
    })
    .strict(),
  sessions: z
    .object({
      ...baseQuery,
      status: z
        .enum([
          "unscheduled",
          "scheduled",
          "published",
          "cancelled",
          "archived",
        ])
        .optional(),
      visibility: z.enum(["public", "private", "hidden"]).optional(),
      trackId: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
  "schedule-versions": z
    .object({
      ...baseQuery,
      status: z
        .enum(["draft", "publishing", "published", "archived", "failed"])
        .optional(),
    })
    .strict(),
  decisions: z
    .object({
      ...baseQuery,
      status: z
        .enum(["draft", "published", "superseded", "revoked"])
        .optional(),
      decision: z.enum(["accepted", "rejected", "waitlisted"]).optional(),
      submissionId: z.string().trim().min(1).max(200).optional(),
    })
    .strict(),
  communications: z
    .object({
      ...baseQuery,
      status: z
        .enum([
          "draft",
          "scheduled",
          "queued",
          "sending",
          "sent",
          "partially_failed",
          "failed",
          "cancelled",
        ])
        .optional(),
      channel: z.enum(["email", "sms", "push", "calendar"]).optional(),
    })
    .strict(),
  resources: z
    .object({
      ...baseQuery,
      status: z.enum(["draft", "published", "archived"]).optional(),
      category: z.string().trim().min(1).max(120).optional(),
    })
    .strict(),
} satisfies Record<AdminApiResource, z.ZodType>;

type AdminQuery = {
  limit: number;
  cursor?: string;
  q?: string;
  status?: string;
  formId?: string;
  kind?: string;
  profileStatus?: string;
  visibility?: string;
  trackId?: string;
  decision?: string;
  submissionId?: string;
  channel?: string;
  category?: string;
  role?: string;
};

export const ADMIN_RESOURCE_SCOPES: Record<AdminApiResource, ApiKeyScope> = {
  submissions: "submissions:read",
  forms: "forms:read",
  people: "people:read",
  speakers: "speakers:read",
  sessions: "sessions:read",
  "schedule-versions": "schedule:read",
  decisions: "decisions:read",
  communications: "communications:read",
  resources: "resources:read",
};

const responseKeys: Record<AdminApiResource, string> = {
  submissions: "submissions",
  forms: "forms",
  people: "people",
  speakers: "speakers",
  sessions: "sessions",
  "schedule-versions": "scheduleVersions",
  decisions: "decisions",
  communications: "communications",
  resources: "resources",
};

export function parseAdminResource(value: string | undefined) {
  const parsed = resourceSchema.safeParse(value);
  if (!parsed.success)
    throw new ApiError(
      404,
      "API_RESOURCE_NOT_FOUND",
      "Administration API resource not found",
    );
  return parsed.data;
}

export function parseAdminQuery(
  request: Request,
  resource: AdminApiResource,
): AdminQuery {
  return parseStrictQuery(
    request,
    querySchemas[resource] as unknown as z.ZodType<AdminQuery>,
    `The ${resource} query parameters are invalid`,
  );
}

type EventPrincipal = ApiPrincipal & { eventId: string };
type PageRow = { id: string; sort: number } & Record<string, unknown>;

const submissionTracksSchema = z.array(
  z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    position: z.number().int().nonnegative(),
  }),
);
const submissionRoutedTeamIdsSchema = z.array(z.string().min(1));

function jsonValue(value: unknown, label: string) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${label} contains invalid persisted JSON.`);
  }
}

function containsFilter(column: string, value: string | undefined) {
  return value
    ? {
        sql: ` AND ${column} LIKE ? ESCAPE '\\' COLLATE NOCASE`,
        bindings: [
          `%${value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`,
        ],
      }
    : { sql: "", bindings: [] as unknown[] };
}

function exactFilter(column: string, value: string | undefined) {
  return value
    ? { sql: ` AND ${column} = ?`, bindings: [value] }
    : { sql: "", bindings: [] as unknown[] };
}

function cursorFilter(cursorValue: string | undefined, column: string) {
  if (!cursorValue) return { sql: "", bindings: [] as unknown[] };
  const cursor = decodePrivateCursor(cursorValue);
  return {
    sql: ` AND (${column} < ? OR (${column} = ? AND base.id < ?))`,
    bindings: [cursor.sort, cursor.sort, cursor.id],
  };
}

export class ApiAdministrationService {
  private readonly airtable: AirtableProviderBoundary;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
  }

  async getEvent(principal: EventPrincipal) {
    await this.airtable.assertReadable(principal);
    const row = await this.env.DB.prepare(
      `SELECT event.id, event.name, event.slug, event.timezone,
              event.starts_at AS startsAt, event.ends_at AS endsAt,
              event.venue_name AS venue, event.city, event.description,
              event.brand_accent AS brandAccent,
              event.repository_provider AS repositoryProvider,
              event.retention_months AS retentionMonths,
              event.submission_access_mode AS submissionAccessMode,
              event.allow_anonymous_drafts AS allowAnonymousDrafts,
              event.duplicate_person_warnings AS duplicatePersonWarnings,
              event.revision, event.programme_published_at AS programmePublishedAt,
              event.created_at AS createdAt, event.updated_at AS updatedAt
         FROM events event
        WHERE event.id = ? AND event.organisation_id = ?`,
    )
      .bind(principal.eventId, principal.organisationId)
      .first<
        Record<string, unknown> & {
          startsAt: number;
          endsAt: number;
          programmePublishedAt: number | null;
          createdAt: number;
          updatedAt: number;
          allowAnonymousDrafts: number;
          duplicatePersonWarnings: number;
        }
      >();
    if (!row) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");
    return {
      ...row,
      startsAt: isoTimestamp(row.startsAt),
      endsAt: isoTimestamp(row.endsAt),
      programmePublishedAt: isoTimestamp(row.programmePublishedAt),
      createdAt: isoTimestamp(row.createdAt),
      updatedAt: isoTimestamp(row.updatedAt),
      allowAnonymousDrafts: Boolean(row.allowAnonymousDrafts),
      duplicatePersonWarnings: Boolean(row.duplicatePersonWarnings),
    };
  }

  async list(
    principal: EventPrincipal,
    resource: AdminApiResource,
    input: AdminQuery,
  ) {
    if (isAirtableManagedAdminResource(resource)) {
      await this.airtable.assertReadable(principal);
    }
    const page = await this.query(principal, resource, input);
    const visible = page.slice(0, input.limit);
    return {
      [responseKeys[resource]]: visible.map(({ sort: _sort, ...row }) =>
        this.serialise(resource, row),
      ),
      nextCursor:
        page.length > input.limit && visible.length
          ? encodePrivateCursor(
              visible.at(-1)!.sort,
              String(visible.at(-1)!.id),
            )
          : null,
    };
  }

  private async query(
    principal: EventPrincipal,
    resource: AdminApiResource,
    input: AdminQuery,
  ): Promise<PageRow[]> {
    const q = containsFilter(
      resource === "speakers" || resource === "people"
        ? "base.displayName"
        : "base.title",
      input.q,
    );
    const cursorColumns: Record<AdminApiResource, string> = {
      submissions: "base.sort",
      forms: "base.sort",
      people: "base.sort",
      speakers: "base.sort",
      sessions: "base.sort",
      "schedule-versions": "base.sort",
      decisions: "base.sort",
      communications: "base.sort",
      resources: "base.sort",
    };
    const cursor = cursorFilter(input.cursor, cursorColumns[resource]);
    const limit = input.limit + 1;

    if (resource === "submissions") {
      const status = exactFilter("base.status", input.status);
      const form = exactFilter("base.formId", input.formId);
      return (
        await this.env.DB.prepare(
          `SELECT * FROM (
             SELECT submission.id, submission.created_at AS sort,
                    submission.public_reference AS publicReference,
                    submission.form_version_id AS formVersionId,
                    version.form_id AS formId,
                    submission.submitter_person_id AS submitterPersonId,
                    submission.submitter_email AS submitterEmail,
                    submission.title, submission.category, submission.format,
                    COALESCE((
                      SELECT json_group_array(routed.team_id)
                        FROM (
                          SELECT route.team_id
                            FROM submission_routing_teams route
                           WHERE route.submission_id = submission.id
                             AND route.event_id = submission.event_id
                           ORDER BY route.team_id
                        ) routed
                    ), '[]') AS routedTeamIdsJson,
                    COALESCE((
                      SELECT json_group_array(json(selected.track))
                        FROM (
                          SELECT json_object(
                                   'id', selection.track_id,
                                   'name', selection.track_name_snapshot,
                                   'position', selection.position
                                 ) AS track
                            FROM submission_track_selections selection
                           WHERE selection.submission_id = submission.id
                             AND selection.event_id = submission.event_id
                           ORDER BY selection.position
                        ) selected
                    ), '[]') AS tracksJson,
                    submission.status, submission.revision,
                    submission.submitted_at AS submittedAt,
                    submission.withdrawn_at AS withdrawnAt,
                    submission.created_at AS createdAt,
                    submission.updated_at AS updatedAt
               FROM submissions submission
               JOIN events event ON event.id = submission.event_id
                 AND event.organisation_id = ?
               LEFT JOIN form_versions version
                 ON version.id = submission.form_version_id
                AND version.event_id = submission.event_id
              WHERE submission.event_id = ?
           ) base WHERE 1 = 1${q.sql}${status.sql}${form.sql}${cursor.sql}
           ORDER BY base.sort DESC, base.id DESC LIMIT ?`,
        )
          .bind(
            principal.organisationId,
            principal.eventId,
            ...q.bindings,
            ...status.bindings,
            ...form.bindings,
            ...cursor.bindings,
            limit,
          )
          .all<PageRow>()
      ).results;
    }
    if (resource === "forms") {
      const status = exactFilter("base.status", input.status);
      const kind = exactFilter("base.kind", input.kind);
      return (
        await this.env.DB.prepare(
          `SELECT * FROM (
             SELECT form.id, form.created_at AS sort, form.name AS title,
                    form.description, form.kind, form.status,
                    form.public_slug AS publicSlug, form.closes_at AS closesAt,
                    form.submission_limit AS submissionLimit,
                    form.min_speakers AS minSpeakers,
                    form.max_speakers AS maxSpeakers,
                    form.access_mode AS accessMode, form.revision,
                    form.created_at AS createdAt, form.updated_at AS updatedAt,
                    (SELECT MAX(version.version_number) FROM form_versions version
                      WHERE version.form_id = form.id) AS latestVersionNumber,
                    (SELECT version.id FROM form_versions version
                      WHERE version.form_id = form.id AND version.status = 'published'
                      LIMIT 1) AS publishedVersionId
               FROM form_definitions form
               JOIN events event ON event.id = form.event_id
                 AND event.organisation_id = ?
              WHERE form.event_id = ?
           ) base WHERE 1 = 1${q.sql}${status.sql}${kind.sql}${cursor.sql}
           ORDER BY base.sort DESC, base.id DESC LIMIT ?`,
        )
          .bind(
            principal.organisationId,
            principal.eventId,
            ...q.bindings,
            ...status.bindings,
            ...kind.bindings,
            ...cursor.bindings,
            limit,
          )
          .all<PageRow>()
      ).results;
    }
    if (resource === "speakers") {
      const status = exactFilter("base.profileStatus", input.profileStatus);
      return (
        await this.env.DB.prepare(
          `SELECT * FROM (
             SELECT person.id, person.created_at AS sort,
                    person.display_name AS displayName, person.email,
                    person.email_verified AS emailVerified,
                    person.image_url AS imageUrl, person.biography,
                    person.pronunciation,
                    person.organisation_name AS organisationName,
                    person.job_title AS jobTitle,
                    person.profile_status AS profileStatus,
                    person.profile_revision AS profileRevision,
                    person.created_at AS createdAt,
                    person.updated_at AS updatedAt
               FROM people person
              WHERE EXISTS (
                SELECT 1 FROM events event
                 WHERE event.id = ? AND event.organisation_id = ?
              ) AND (
                EXISTS (
                  SELECT 1 FROM memberships membership
                   WHERE membership.person_id = person.id
                     AND membership.event_id = ? AND membership.role = 'speaker'
                     AND membership.accepted_at IS NOT NULL
                     AND membership.revoked_at IS NULL
                ) OR EXISTS (
                  SELECT 1 FROM session_speakers relationship
                   WHERE relationship.person_id = person.id
                     AND relationship.event_id = ?
                ) OR EXISTS (
                  SELECT 1 FROM submission_speakers relationship
                   WHERE relationship.person_id = person.id
                     AND relationship.event_id = ?
                )
              )
           ) base WHERE 1 = 1${q.sql}${status.sql}${cursor.sql}
           ORDER BY base.sort DESC, base.id DESC LIMIT ?`,
        )
          .bind(
            principal.eventId,
            principal.organisationId,
            principal.eventId,
            principal.eventId,
            principal.eventId,
            ...q.bindings,
            ...status.bindings,
            ...cursor.bindings,
            limit,
          )
          .all<PageRow>()
      ).results;
    }
    if (resource === "people") {
      const status = exactFilter("base.profileStatus", input.profileStatus);
      const selectedRolePredicate = input.role ? "AND membership.role = ?" : "";
      const selectedRoleBindings = input.role ? [input.role] : [];
      const role = exactFilter("base.role", input.role);
      return (
        await this.env.DB.prepare(
          `SELECT * FROM (
             SELECT person.id, person.created_at AS sort,
                    person.display_name AS displayName, person.email,
                    person.email_verified AS emailVerified,
                    person.image_url AS imageUrl, person.biography,
                    person.pronunciation,
                    person.organisation_name AS organisationName,
                    person.job_title AS jobTitle,
                    person.profile_status AS profileStatus,
                    person.profile_revision AS profileRevision,
                    selected_membership.role,
                    selected_membership.accepted_at AS acceptedAt,
                    selected_membership.invited_at AS invitedAt,
                    person.created_at AS createdAt,
                    person.updated_at AS updatedAt
               FROM people person
               LEFT JOIN memberships selected_membership
                 ON selected_membership.id = (
                   SELECT membership.id
                     FROM memberships membership
                    WHERE membership.person_id = person.id
                      AND membership.organisation_id = ?
                      AND (membership.event_id = ? OR (
                        membership.event_id IS NULL
                        AND membership.role IN ('owner','administrator')
                      ))
                      AND membership.revoked_at IS NULL
                      ${selectedRolePredicate}
                    ORDER BY CASE membership.role
                      WHEN 'owner' THEN 0
                      WHEN 'administrator' THEN 1
                      WHEN 'committee_chair' THEN 2
                      WHEN 'evaluator' THEN 3
                      WHEN 'speaker' THEN 4
                      WHEN 'submitter' THEN 5
                      ELSE 6
                    END,
                    CASE WHEN membership.event_id = ? THEN 0 ELSE 1 END,
                    membership.id
                    LIMIT 1
                 )
              WHERE EXISTS (
                SELECT 1 FROM events event
                 WHERE event.id = ? AND event.organisation_id = ?
              ) AND EXISTS (
                SELECT 1 FROM memberships membership
                 WHERE membership.person_id = person.id
                   AND membership.organisation_id = ?
                   AND (membership.event_id = ? OR (
                     membership.event_id IS NULL
                     AND membership.role IN ('owner','administrator')
                   ))
                   AND membership.revoked_at IS NULL
              )
           ) base WHERE 1 = 1${q.sql}${status.sql}${role.sql}${cursor.sql}
           ORDER BY base.sort DESC, base.id DESC LIMIT ?`,
        )
          .bind(
            principal.organisationId,
            principal.eventId,
            ...selectedRoleBindings,
            principal.eventId,
            principal.eventId,
            principal.organisationId,
            principal.organisationId,
            principal.eventId,
            ...q.bindings,
            ...status.bindings,
            ...role.bindings,
            ...cursor.bindings,
            limit,
          )
          .all<PageRow>()
      ).results;
    }
    if (resource === "sessions") {
      const status = exactFilter("base.status", input.status);
      const visibility = exactFilter("base.visibility", input.visibility);
      const track = exactFilter("base.trackId", input.trackId);
      return (
        await this.env.DB.prepare(
          `SELECT * FROM (
             SELECT session.id, session.created_at AS sort,
                    session.source_submission_id AS sourceSubmissionId,
                    session.track_id AS trackId, track.name AS trackName,
                    session.title, session.slug, session.description,
                    session.format, session.duration_minutes AS durationMinutes,
                    session.expected_attendance AS expectedAttendance,
                    session.required_resources_json AS requiredResourcesJson,
                    session.status, session.visibility, session.revision,
                    session.created_at AS createdAt,
                    session.updated_at AS updatedAt,
                    (SELECT GROUP_CONCAT(relationship.person_id, '||')
                       FROM session_speakers relationship
                      WHERE relationship.session_id = session.id
                        AND relationship.event_id = session.event_id
                      ORDER BY relationship.position) AS speakerIds
               FROM sessions session
               JOIN events event ON event.id = session.event_id
                 AND event.organisation_id = ?
               LEFT JOIN tracks track ON track.id = session.track_id
                 AND track.event_id = session.event_id
              WHERE session.event_id = ?
           ) base WHERE 1 = 1${q.sql}${status.sql}${visibility.sql}${track.sql}${cursor.sql}
           ORDER BY base.sort DESC, base.id DESC LIMIT ?`,
        )
          .bind(
            principal.organisationId,
            principal.eventId,
            ...q.bindings,
            ...status.bindings,
            ...visibility.bindings,
            ...track.bindings,
            ...cursor.bindings,
            limit,
          )
          .all<PageRow>()
      ).results;
    }
    if (resource === "schedule-versions") {
      const status = exactFilter("base.status", input.status);
      return (
        await this.env.DB.prepare(
          `SELECT * FROM (
             SELECT version.id, version.created_at AS sort,
                    COALESCE(version.name, 'Schedule version ' || version.version_number) AS title,
                    version.name, version.version_number AS versionNumber,
                    version.status, version.revision,
                    version.publication_operation_id AS publicationOperationId,
                    version.created_by_person_id AS createdByPersonId,
                    version.created_at AS createdAt,
                    version.published_at AS publishedAt,
                    (SELECT COUNT(*) FROM schedule_entries entry
                      WHERE entry.schedule_version_id = version.id
                        AND entry.event_id = version.event_id) AS entryCount,
                    (SELECT COUNT(*) FROM schedule_conflicts conflict
                      WHERE conflict.schedule_version_id = version.id
                        AND conflict.event_id = version.event_id
                        AND conflict.resolved_at IS NULL) AS openConflictCount
               FROM schedule_versions version
               JOIN events event ON event.id = version.event_id
                 AND event.organisation_id = ?
              WHERE version.event_id = ?
           ) base WHERE 1 = 1${q.sql}${status.sql}${cursor.sql}
           ORDER BY base.sort DESC, base.id DESC LIMIT ?`,
        )
          .bind(
            principal.organisationId,
            principal.eventId,
            ...q.bindings,
            ...status.bindings,
            ...cursor.bindings,
            limit,
          )
          .all<PageRow>()
      ).results;
    }
    if (resource === "decisions") {
      const status = exactFilter("base.status", input.status);
      const decision = exactFilter("base.decision", input.decision);
      const submission = exactFilter("base.submissionId", input.submissionId);
      return (
        await this.env.DB.prepare(
          `SELECT * FROM (
             SELECT decision.id, decision.decided_at AS sort,
                    submission.title, decision.submission_id AS submissionId,
                    decision.round_id AS roundId,
                    decision.revision_number AS revisionNumber,
                    decision.status, decision.decision, decision.rationale,
                    decision.effect_preview_json AS effectPreviewJson,
                    decision.decided_by_person_id AS decidedByPersonId,
                    decision.decided_at AS decidedAt,
                    decision.published_at AS publishedAt
               FROM submission_decisions decision
               JOIN events event ON event.id = decision.event_id
                 AND event.organisation_id = ?
               JOIN submissions submission ON submission.id = decision.submission_id
                 AND submission.event_id = decision.event_id
              WHERE decision.event_id = ?
           ) base WHERE 1 = 1${q.sql}${status.sql}${decision.sql}${submission.sql}${cursor.sql}
           ORDER BY base.sort DESC, base.id DESC LIMIT ?`,
        )
          .bind(
            principal.organisationId,
            principal.eventId,
            ...q.bindings,
            ...status.bindings,
            ...decision.bindings,
            ...submission.bindings,
            ...cursor.bindings,
            limit,
          )
          .all<PageRow>()
      ).results;
    }
    if (resource === "communications") {
      const status = exactFilter("base.status", input.status);
      const channel = exactFilter("base.channel", input.channel);
      return (
        await this.env.DB.prepare(
          `SELECT * FROM (
             SELECT communication.id, communication.created_at AS sort,
                    COALESCE(template.name, communication.id) AS title,
                    communication.template_version_id AS templateVersionId,
                    communication.sender_profile_id AS senderProfileId,
                    communication.operation_id AS operationId,
                    communication.kind, communication.channel,
                    communication.status,
                    communication.recipient_count AS recipientCount,
                    communication.scheduled_at AS scheduledAt,
                    communication.queued_at AS queuedAt,
                    communication.sent_at AS sentAt,
                    communication.cancelled_at AS cancelledAt,
                    communication.created_at AS createdAt,
                    communication.updated_at AS updatedAt
               FROM communications communication
               JOIN events event ON event.id = communication.event_id
                 AND event.organisation_id = ?
               LEFT JOIN communication_template_versions version
                 ON version.id = communication.template_version_id
                AND version.event_id = communication.event_id
               LEFT JOIN communication_templates template
                 ON template.id = version.template_id
                AND template.event_id = communication.event_id
              WHERE communication.event_id = ?
           ) base WHERE 1 = 1${q.sql}${status.sql}${channel.sql}${cursor.sql}
           ORDER BY base.sort DESC, base.id DESC LIMIT ?`,
        )
          .bind(
            principal.organisationId,
            principal.eventId,
            ...q.bindings,
            ...status.bindings,
            ...channel.bindings,
            ...cursor.bindings,
            limit,
          )
          .all<PageRow>()
      ).results;
    }
    const status = exactFilter("base.status", input.status);
    const category = exactFilter("base.category", input.category);
    return (
      await this.env.DB.prepare(
        `SELECT * FROM (
           SELECT page.id, page.created_at AS sort, page.title, page.slug,
                  page.category, page.status,
                  page.audience_scope AS audienceScope,
                  page.acknowledgement_required AS acknowledgementRequired,
                  page.revision, page.created_at AS createdAt,
                  page.updated_at AS updatedAt, page.archived_at AS archivedAt,
                  (SELECT version.id FROM resource_page_versions version
                    WHERE version.resource_page_id = page.id
                      AND version.event_id = page.event_id
                      AND version.status = 'published'
                    ORDER BY version.version_number DESC LIMIT 1) AS publishedVersionId
             FROM resource_pages page
             JOIN events event ON event.id = page.event_id
               AND event.organisation_id = ?
            WHERE page.event_id = ?
         ) base WHERE 1 = 1${q.sql}${status.sql}${category.sql}${cursor.sql}
         ORDER BY base.sort DESC, base.id DESC LIMIT ?`,
      )
        .bind(
          principal.organisationId,
          principal.eventId,
          ...q.bindings,
          ...status.bindings,
          ...category.bindings,
          ...cursor.bindings,
          limit,
        )
        .all<PageRow>()
    ).results;
  }

  private serialise(resource: AdminApiResource, row: Record<string, unknown>) {
    const result = { ...row };
    for (const field of [
      "startsAt",
      "endsAt",
      "closesAt",
      "submittedAt",
      "withdrawnAt",
      "createdAt",
      "updatedAt",
      "publishedAt",
      "decidedAt",
      "scheduledAt",
      "queuedAt",
      "sentAt",
      "cancelledAt",
      "archivedAt",
      "acceptedAt",
      "invitedAt",
    ]) {
      if (field in result)
        result[field] = isoTimestamp(result[field] as number | null);
    }
    if (resource === "speakers" || resource === "people")
      result.emailVerified = Boolean(result.emailVerified);
    if (resource === "submissions") {
      const tracks = submissionTracksSchema.parse(
        jsonValue(result.tracksJson, `Submission ${String(result.id)} tracks`),
      );
      if (result.status !== "draft" && tracks.length === 0) {
        throw new Error(
          `Submission ${String(result.id)} is missing persisted track selections.`,
        );
      }
      result.tracks = tracks;
      delete result.tracksJson;
      result.routedTeamIds = submissionRoutedTeamIdsSchema.parse(
        jsonValue(
          result.routedTeamIdsJson,
          `Submission ${String(result.id)} routed team IDs`,
        ),
      );
      delete result.routedTeamIdsJson;
    }
    if (resource === "sessions") {
      result.requiredResources = jsonValue(
        result.requiredResourcesJson,
        `Session ${String(result.id)} required resources`,
      );
      delete result.requiredResourcesJson;
      result.speakerIds =
        typeof result.speakerIds === "string"
          ? result.speakerIds.split("||")
          : [];
    }
    if (resource === "decisions") {
      result.effectPreview = jsonValue(
        result.effectPreviewJson,
        `Decision ${String(result.id)} effect preview`,
      );
      delete result.effectPreviewJson;
    }
    if (resource === "resources")
      result.acknowledgementRequired = Boolean(result.acknowledgementRequired);
    return result;
  }
}
