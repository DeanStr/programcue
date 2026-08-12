import { z } from "zod";

import {
  AIRTABLE_ROOMS_TABLE,
  airtableConnectionInputSchema,
} from "~/modules/airtable/airtable-schema";
import { INITIAL_EVENT_SESSION_FORMATS_JSON } from "~/modules/events/event-configuration";
import { EventRepositoryProvisioningService } from "~/modules/events/event-repository-provisioning.server";
import { timezoneSchema } from "~/modules/events/event-schema";
import { CANONICAL_EVENT_FILE_POLICY_JSON } from "~/modules/files/file-policy";
import type { Viewer } from "~/platform/auth/authorize.server";

const eventCreationInputSchema = z
  .object({
    name: z.string().trim().min(1, "Event name is required.").max(160),
    slug: z
      .string()
      .trim()
      .min(1, "Public slug is required.")
      .max(120)
      .regex(
        /^[a-z0-9]+(?:-[a-z0-9]+)*$/u,
        "Use lowercase letters, numbers and hyphens for the public slug.",
      ),
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

export class EventCreationSlugConflictError extends Error {
  constructor() {
    super("Another event already uses that public slug.");
    this.name = "EventCreationSlugConflictError";
  }
}

export type EventCreationResult = {
  eventId: string;
  operationId: string;
  repositoryProvider: "d1" | "airtable";
};

type EventCreationDependencies = {
  provisioning?: Pick<EventRepositoryProvisioningService, "provisionAirtable">;
};

function startEpoch(date: string) {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1_000);
}

function endEpoch(date: string) {
  return Math.floor(Date.parse(`${date}T23:59:59Z`) / 1_000);
}

function isoDate(epoch: number) {
  return new Date(epoch * 1_000).toISOString().slice(0, 10);
}

function nextYear(value: string) {
  const parsed = new Date(`${value}T12:00:00Z`);
  parsed.setUTCFullYear(parsed.getUTCFullYear() + 1);
  return parsed.toISOString().slice(0, 10);
}

export class EventCreationService {
  private readonly provisioning;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: EventCreationDependencies = {},
  ) {
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
    if (!membership)
      throw new Response(
        "Organisation owner or administrator access is required to create an event.",
        { status: 403 },
      );
  }

  async prepare(viewer: Viewer) {
    await this.assertOrganisationAuthority(viewer);
    const source = await this.env.DB.prepare(
      `SELECT timezone, starts_at AS startsAt, ends_at AS endsAt
         FROM events
        WHERE id = ? AND organisation_id = ?`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{ timezone: string; startsAt: number; endsAt: number }>();
    if (!source)
      throw new Response("Current event not found.", { status: 404 });
    return {
      timezone: source.timezone,
      startDate: nextYear(isoDate(source.startsAt)),
      endDate: nextYear(isoDate(source.endsAt)),
      airtableTableName: AIRTABLE_ROOMS_TABLE,
    };
  }

  async create(
    viewer: Viewer,
    rawInput: unknown,
  ): Promise<EventCreationResult> {
    await this.assertOrganisationAuthority(viewer);
    const input = eventCreationInputSchema.parse(rawInput);
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
    if (conflict) throw new EventCreationSlugConflictError();

    const eventId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const pendingAirtable = airtableConnection !== null;
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `INSERT INTO events (
           id, organisation_id, name, slug, timezone, starts_at, ends_at,
           session_formats_json, repository_provider, activation_status,
           file_policy_json,
           revision, last_operation_id, last_updated_by_person_id,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?,
                   unixepoch(), unixepoch())`,
      ).bind(
        eventId,
        viewer.organisationId,
        input.name,
        input.slug,
        input.timezone,
        startEpoch(input.startDate),
        endEpoch(input.endDate),
        INITIAL_EVENT_SESSION_FORMATS_JSON,
        input.repositoryProvider,
        pendingAirtable ? "provisioning" : "active",
        CANONICAL_EVENT_FILE_POLICY_JSON,
        operationId,
        viewer.personId,
      ),
      this.env.DB.prepare(
        `INSERT INTO operation_jobs (
           id, organisation_id, event_id, requested_by_person_id, type,
           idempotency_key, correlation_id, status, payload_json, result_json,
           progress_total, progress_completed, progress_failed, cancellable,
           started_at, completed_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'event.create', ?, ?, ?, ?, ?, 1, ?, 0, 0,
                   unixepoch(), ?, unixepoch(), unixepoch())`,
      ).bind(
        operationId,
        viewer.organisationId,
        eventId,
        viewer.personId,
        `event-create:${operationId}`,
        correlationId,
        pendingAirtable ? "running" : "completed",
        JSON.stringify({
          type: "event.create",
          targetEventId: eventId,
          requestedRepositoryProvider: input.repositoryProvider,
        }),
        pendingAirtable
          ? null
          : JSON.stringify({
              targetEventId: eventId,
              repositoryProvider: "d1",
            }),
        pendingAirtable ? 0 : 1,
        pendingAirtable ? null : Math.floor(Date.now() / 1_000),
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         ) VALUES (?, ?, ?, ?, ?, 'event', ?, ?, ?, unixepoch())`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        eventId,
        viewer.personId,
        "event.created",
        eventId,
        correlationId,
        JSON.stringify({
          operationId,
          name: input.name,
          slug: input.slug,
          repositoryProvider: input.repositoryProvider,
          activationStatus: pendingAirtable ? "provisioning" : "active",
          requestedRepositoryProvider: input.repositoryProvider,
        }),
      ),
    ];
    try {
      await this.env.DB.batch(statements);
    } catch (error) {
      if (
        error instanceof Error &&
        /UNIQUE constraint failed: events\.slug/iu.test(error.message)
      )
        throw new EventCreationSlugConflictError();
      throw error;
    }

    if (pendingAirtable) {
      await this.provisioning.provisionAirtable(
        viewer,
        eventId,
        operationId,
        "blank_event_creation",
        airtableConnection,
        [],
      );
    }
    return {
      eventId,
      operationId,
      repositoryProvider: input.repositoryProvider,
    };
  }
}
