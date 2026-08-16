import { z } from "zod";

import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { ApiError, type ApiPrincipal } from "./api.server";
import { ApiAdministrationResourceRepository } from "./api-administration-resource-repository.server";
import type { ApiKeyScope } from "./api-key-service.server";
import {
  encodePrivateCursor,
  isoTimestamp,
  parseStrictQuery,
} from "./api-pagination.server";

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

export type AdminQuery = {
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

export type EventPrincipal = ApiPrincipal & { eventId: string };

export class ApiAdministrationService {
  private readonly airtable: AirtableProviderBoundary;
  private readonly resources: ApiAdministrationResourceRepository;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
    this.resources = new ApiAdministrationResourceRepository(this.env);
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
    const page = await this.resources.query(principal, resource, input);
    const visible = page.slice(0, input.limit);
    return {
      [responseKeys[resource]]: visible.map(({ sort: _sort, ...row }) =>
        this.resources.serialise(resource, row),
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
}
