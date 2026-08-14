import { z } from "zod";

import {
  AIRTABLE_ROOMS_TABLE,
  airtableConnectionInputSchema,
} from "~/modules/airtable/airtable-schema";
import {
  emailProviderConfigurationIssue,
  requireEmailProviderConfiguration,
} from "~/modules/communications/email-provider.server";
import { INITIAL_EVENT_SESSION_FORMATS_JSON } from "~/modules/events/event-configuration";
import {
  EVENT_CREATION_STALLED_CODE,
  EVENT_CREATION_STALLED_MESSAGE,
  eventRepositoryProvisioningFailureMessage,
  EventRepositoryProvisioningError,
  EventRepositoryProvisioningService,
} from "~/modules/events/event-repository-provisioning.server";
import { timezoneSchema } from "~/modules/events/event-schema";
import { CANONICAL_EVENT_FILE_POLICY_JSON } from "~/modules/files/file-policy";
import { apiRequestHash } from "~/platform/api/api.server";
import type { Viewer } from "~/platform/auth/authorize.server";

const EVENT_CREATION_LEASE_SECONDS = 15 * 60;
const senderProfileIdSchema = z
  .string()
  .trim()
  .min(1, "Choose a verified sender profile.")
  .max(200, "Choose a verified sender profile.")
  .regex(/^[A-Za-z0-9._:-]+$/u, "Choose a verified sender profile.");

const eventCreationInputSchema = z
  .object({
    creationIntentId: z.uuid("Refresh before creating this event."),
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
    reuseSenderProfileId: z
      .union([senderProfileIdSchema, z.literal("")])
      .optional()
      .transform((value) => value || null),
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
    if (
      value.repositoryProvider !== "d1" &&
      value.reuseSenderProfileId !== null
    )
      context.addIssue({
        code: "custom",
        path: ["reuseSenderProfileId"],
        message:
          "An existing sender can only be reused when Program Cue holds the new event's data.",
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

export class EventCreationIntentConflictError extends Error {
  constructor() {
    super(
      "This event-creation intent was already used with different settings. Refresh before creating another event.",
    );
    this.name = "EventCreationIntentConflictError";
  }
}

export class EventCreationSenderReuseError extends Error {
  constructor(
    message = "The selected verified sender is no longer available in this organisation. Refresh before creating the event.",
  ) {
    super(message);
    this.name = "EventCreationSenderReuseError";
  }
}

export type EventCreationResult = {
  eventId: string;
  operationId: string;
  repositoryProvider: "d1" | "airtable";
};

export class EventCreationInProgressError extends Error {
  readonly committed = true;

  constructor(readonly result: EventCreationResult) {
    super(
      "This event creation is still in progress. Review the existing operation instead of submitting another event.",
    );
    this.name = "EventCreationInProgressError";
  }
}

export class EventCreationLeaseStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventCreationLeaseStateError";
  }
}

const eventCreationOperationPayloadSchema = z.object({
  type: z.literal("event.create"),
  targetEventId: z.string().min(1),
  requestedRepositoryProvider: z.enum(["d1", "airtable"]),
  requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
  reusedSenderProfileId: senderProfileIdSchema.optional(),
});

const eventCreationOperationResultSchema = z.object({
  targetEventId: z.string().min(1),
  repositoryProvider: z.enum(["d1", "airtable"]),
  failureKind: z.enum(["provider", "internal"]).optional(),
  failureCode: z.literal(EVENT_CREATION_STALLED_CODE).optional(),
});

type EventCreationOperation = {
  id: string;
  organisationId: string | null;
  eventId: string | null;
  requestedByPersonId: string | null;
  type: string;
  status: string;
  payloadJson: string;
  resultJson: string | null;
  claimExpiresAt: number | null;
  leaseExpired: number | null;
};

type EventCreationDependencies = {
  provisioning?: Pick<EventRepositoryProvisioningService, "provisionAirtable">;
};

type ReusableSenderProfile = {
  id: string;
  sourceEventId: string;
  sourceEventName: string;
  name: string;
  fromName: string;
  fromEmail: string;
  replyToEmail: string | null;
  provider: "resend" | "mailpit";
  providerSenderId: string | null;
};

type ReusableSenderProfileOption = Omit<
  ReusableSenderProfile,
  "providerSenderId"
>;

function parseStoredOperationPayload(value: string) {
  try {
    const parsed = eventCreationOperationPayloadSchema.safeParse(
      JSON.parse(value) as unknown,
    );
    if (parsed.success) return parsed.data;
  } catch {
    // Report corrupt durable state as an invariant failure below.
  }
  throw new Error(
    "The event-creation operation has an invalid durable payload.",
  );
}

function parseStoredOperationResult(value: string) {
  try {
    const parsed = eventCreationOperationResultSchema.safeParse(
      JSON.parse(value) as unknown,
    );
    if (parsed.success) return parsed.data;
  } catch {
    // Report corrupt durable state as an invariant failure below.
  }
  throw new Error(
    "The event-creation operation has an invalid durable result.",
  );
}

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
    let emailProvider: "resend" | "mailpit" | null = null;
    const emailProviderIssue = emailProviderConfigurationIssue(this.env);
    if (!emailProviderIssue) {
      emailProvider = requireEmailProviderConfiguration(this.env).provider;
    }
    const reusableSenderProfiles = emailProvider
      ? await this.env.DB.prepare(
          `SELECT sender.id, sender.event_id AS sourceEventId,
                  event.name AS sourceEventName, sender.name,
                  sender.from_name AS fromName, sender.from_email AS fromEmail,
                  sender.reply_to_email AS replyToEmail, sender.provider
             FROM sender_profiles sender
             JOIN events event ON event.id = sender.event_id
            WHERE event.organisation_id = ?
              AND event.activation_status = 'active'
              AND sender.provider = ? AND sender.status = 'verified'
              AND (sender.provider <> 'resend' OR sender.provider_sender_id IS NOT NULL)
            ORDER BY event.name COLLATE NOCASE, sender.name COLLATE NOCASE,
                     sender.id`,
        )
          .bind(viewer.organisationId, emailProvider)
          .all<ReusableSenderProfileOption>()
      : { results: [] as ReusableSenderProfileOption[] };
    return {
      creationIntentId: crypto.randomUUID(),
      timezone: source.timezone,
      startDate: nextYear(isoDate(source.startsAt)),
      endDate: nextYear(isoDate(source.endsAt)),
      airtableTableName: AIRTABLE_ROOMS_TABLE,
      emailProvider,
      emailProviderIssue,
      reusableSenderProfiles: reusableSenderProfiles.results,
    };
  }

  private async requireReusableSender(
    viewer: Viewer,
    profileId: string,
  ): Promise<ReusableSenderProfile> {
    let emailProvider: "resend" | "mailpit";
    try {
      emailProvider = requireEmailProviderConfiguration(this.env).provider;
    } catch (error) {
      throw new EventCreationSenderReuseError(
        error instanceof Error
          ? error.message
          : "The email provider configuration is invalid.",
      );
    }
    const profile = await this.env.DB.prepare(
      `SELECT sender.id, sender.event_id AS sourceEventId,
              event.name AS sourceEventName, sender.name,
              sender.from_name AS fromName, sender.from_email AS fromEmail,
              sender.reply_to_email AS replyToEmail, sender.provider,
              sender.provider_sender_id AS providerSenderId
         FROM sender_profiles sender
         JOIN events event ON event.id = sender.event_id
        WHERE sender.id = ? AND event.organisation_id = ?
          AND event.activation_status = 'active'
          AND sender.provider = ? AND sender.status = 'verified'
          AND (sender.provider <> 'resend' OR sender.provider_sender_id IS NOT NULL)`,
    )
      .bind(profileId, viewer.organisationId, emailProvider)
      .first<ReusableSenderProfile>();
    if (!profile) throw new EventCreationSenderReuseError();
    return profile;
  }

  private async loadOperation(creationIntentId: string) {
    return this.env.DB.prepare(
      `SELECT id, organisation_id AS organisationId, event_id AS eventId,
              requested_by_person_id AS requestedByPersonId, type, status,
              payload_json AS payloadJson, result_json AS resultJson,
              claim_expires_at AS claimExpiresAt,
              CASE WHEN claim_expires_at IS NULL THEN NULL
                   WHEN claim_expires_at <= unixepoch() THEN 1
                   ELSE 0 END AS leaseExpired
         FROM operation_jobs
        WHERE id = ?`,
    )
      .bind(creationIntentId)
      .first<EventCreationOperation>();
  }

  private async replay(
    viewer: Viewer,
    creationIntentId: string,
    requestHash: string,
    mayFailExpired = true,
  ): Promise<EventCreationResult | null> {
    const operation = await this.loadOperation(creationIntentId);
    if (!operation) return null;
    if (
      operation.organisationId !== viewer.organisationId ||
      operation.requestedByPersonId !== viewer.personId ||
      operation.type !== "event.create" ||
      !operation.eventId
    ) {
      throw new EventCreationIntentConflictError();
    }
    const payload = parseStoredOperationPayload(operation.payloadJson);
    if (
      payload.requestHash !== requestHash ||
      payload.targetEventId !== operation.eventId
    ) {
      throw new EventCreationIntentConflictError();
    }
    const result: EventCreationResult = {
      eventId: operation.eventId,
      operationId: operation.id,
      repositoryProvider: payload.requestedRepositoryProvider,
    };
    if (operation.status === "completed") {
      if (!operation.resultJson) {
        throw new Error(
          "The completed event-creation operation is missing its durable result.",
        );
      }
      const stored = parseStoredOperationResult(operation.resultJson);
      if (
        stored.targetEventId !== result.eventId ||
        stored.repositoryProvider !== result.repositoryProvider ||
        stored.failureKind ||
        stored.failureCode
      ) {
        throw new Error(
          "The completed event-creation operation has an inconsistent durable result.",
        );
      }
      return result;
    }
    if (operation.status === "failed") {
      if (!operation.resultJson) {
        throw new Error(
          "The failed event-creation operation is missing its durable result.",
        );
      }
      const stored = parseStoredOperationResult(operation.resultJson);
      if (
        stored.targetEventId !== result.eventId ||
        stored.repositoryProvider !== "airtable" ||
        !stored.failureKind ||
        (stored.failureCode !== undefined && stored.failureKind !== "internal")
      ) {
        throw new Error(
          "The failed event-creation operation has an inconsistent durable result.",
        );
      }
      throw new EventRepositoryProvisioningError(
        stored.failureCode === EVENT_CREATION_STALLED_CODE
          ? EVENT_CREATION_STALLED_MESSAGE
          : eventRepositoryProvisioningFailureMessage(stored.failureKind),
        result.eventId,
        result.operationId,
        stored.failureKind,
      );
    }
    if (operation.status === "running") {
      if (result.repositoryProvider !== "airtable") {
        throw new Error(
          "A running event-creation operation must use Airtable authority.",
        );
      }
      if (operation.claimExpiresAt === null) {
        throw new Error(
          "The running event-creation operation is missing its processing lease.",
        );
      }
      if (operation.leaseExpired === 1) {
        if (!mayFailExpired) {
          throw new Error(
            "The expired event-creation operation could not enter durable recovery.",
          );
        }
        await this.failExpiredOperation(viewer, operation);
        const converged = await this.replay(
          viewer,
          creationIntentId,
          requestHash,
          false,
        );
        if (!converged) {
          throw new Error(
            "The expired event-creation operation disappeared during recovery.",
          );
        }
        return converged;
      }
      throw new EventCreationInProgressError(result);
    }
    throw new Error(
      `The event-creation operation has an unsupported ${operation.status} status.`,
    );
  }

  private async failExpiredOperation(
    viewer: Viewer,
    operation: EventCreationOperation,
  ) {
    const resultJson = JSON.stringify({
      targetEventId: operation.eventId,
      repositoryProvider: "airtable",
      failureKind: "internal",
      failureCode: EVENT_CREATION_STALLED_CODE,
    });
    await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE operation_jobs
            SET status = 'failed', progress_failed = progress_total,
                result_json = ?, last_error = ?, claim_token = NULL,
                claim_expires_at = NULL, completed_at = unixepoch(),
                updated_at = unixepoch()
          WHERE id = ? AND organisation_id = ? AND event_id = ?
            AND requested_by_person_id = ? AND type = 'event.create'
            AND status = 'running' AND claim_expires_at IS NOT NULL
            AND claim_expires_at <= unixepoch()
            AND EXISTS (
              SELECT 1 FROM events event
               WHERE event.id = operation_jobs.event_id
                 AND event.organisation_id = operation_jobs.organisation_id
                 AND event.repository_provider = 'airtable'
                 AND event.activation_status = 'provisioning'
                 AND event.last_operation_id = operation_jobs.id
            )`,
      ).bind(
        resultJson,
        EVENT_CREATION_STALLED_MESSAGE,
        operation.id,
        viewer.organisationId,
        operation.eventId,
        operation.requestedByPersonId,
      ),
      this.env.DB.prepare(
        `UPDATE events
            SET activation_status = 'provisioning_failed',
                revision = revision + 1,
                last_updated_by_person_id = ?, updated_at = unixepoch()
          WHERE id = ? AND organisation_id = ?
            AND repository_provider = 'airtable'
            AND activation_status = 'provisioning'
            AND last_operation_id = ?
            AND EXISTS (
              SELECT 1 FROM operation_jobs operation
               WHERE operation.id = events.last_operation_id
                 AND operation.organisation_id = events.organisation_id
                 AND operation.event_id = events.id
                 AND operation.status = 'failed'
                 AND json_extract(operation.result_json, '$.failureCode') = ?
            )`,
      ).bind(
        viewer.personId,
        operation.eventId,
        viewer.organisationId,
        operation.id,
        EVENT_CREATION_STALLED_CODE,
      ),
      this.env.DB.prepare(
        `UPDATE integration_connections
            SET status = 'needs_attention', revision = revision + 1,
                updated_at = unixepoch()
          WHERE organisation_id = ? AND event_id = ?
            AND provider = 'airtable' AND last_operation_id = ?
            AND status = 'connected'
            AND EXISTS (
              SELECT 1 FROM events event
               WHERE event.id = integration_connections.event_id
                 AND event.organisation_id = integration_connections.organisation_id
                 AND event.activation_status = 'provisioning_failed'
                 AND event.last_operation_id = integration_connections.last_operation_id
            )`,
      ).bind(viewer.organisationId, operation.eventId, operation.id),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         ) SELECT ?, ?, ?, ?, 'event.repository.provisioning_failed',
                  'event', ?, ?, ?, unixepoch()
            WHERE EXISTS (
              SELECT 1
                FROM operation_jobs operation
                JOIN events event ON event.id = operation.event_id
               WHERE operation.id = ? AND operation.organisation_id = ?
                 AND operation.event_id = ? AND operation.status = 'failed'
                 AND event.organisation_id = operation.organisation_id
                 AND event.activation_status = 'provisioning_failed'
                 AND event.last_operation_id = operation.id
                 AND json_extract(operation.result_json, '$.failureCode') = ?
            )
              AND NOT EXISTS (
                SELECT 1 FROM audit_events existing
                 WHERE existing.organisation_id = ? AND existing.event_id = ?
                   AND existing.action = 'event.repository.provisioning_failed'
                   AND existing.correlation_id = ?
              )`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        operation.eventId,
        viewer.personId,
        operation.eventId,
        operation.id,
        JSON.stringify({
          operationId: operation.id,
          requestedRepositoryProvider: "airtable",
          failureKind: "internal",
          failureCode: EVENT_CREATION_STALLED_CODE,
          errorName: "EventCreationLeaseExpired",
        }),
        operation.id,
        viewer.organisationId,
        operation.eventId,
        EVENT_CREATION_STALLED_CODE,
        viewer.organisationId,
        operation.eventId,
        operation.id,
      ),
    ]);
  }

  async failStalledCreation(viewer: Viewer, operationId: string) {
    await this.assertOrganisationAuthority(viewer);
    const operation = await this.loadOperation(operationId);
    if (
      !operation ||
      operation.organisationId !== viewer.organisationId ||
      !operation.requestedByPersonId ||
      operation.type !== "event.create" ||
      !operation.eventId
    ) {
      throw new EventCreationLeaseStateError(
        "The stalled event-creation operation is unavailable.",
      );
    }
    const payload = parseStoredOperationPayload(operation.payloadJson);
    if (
      payload.targetEventId !== operation.eventId ||
      payload.requestedRepositoryProvider !== "airtable"
    ) {
      throw new EventCreationLeaseStateError(
        "The stalled event-creation operation is inconsistent.",
      );
    }
    if (operation.status === "running" && operation.leaseExpired === 1) {
      await this.failExpiredOperation(viewer, operation);
    }
    const converged = await this.loadOperation(operationId);
    if (
      !converged ||
      converged.status !== "failed" ||
      !converged.resultJson ||
      parseStoredOperationResult(converged.resultJson).failureCode !==
        EVENT_CREATION_STALLED_CODE
    ) {
      throw new EventCreationLeaseStateError(
        "Only an expired, still-running Airtable creation can enter recovery.",
      );
    }
    return {
      eventId: operation.eventId,
      operationId: operation.id,
      activationStatus: "provisioning_failed" as const,
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
    const credentialFingerprint = airtableConnection
      ? await apiRequestHash(airtableConnection.personalAccessToken)
      : null;
    const requestHash = await apiRequestHash({
      name: input.name,
      slug: input.slug,
      timezone: input.timezone,
      startDate: input.startDate,
      endDate: input.endDate,
      repositoryProvider: input.repositoryProvider,
      ...(input.reuseSenderProfileId
        ? { reuseSenderProfileId: input.reuseSenderProfileId }
        : {}),
      ...(airtableConnection
        ? {
            baseId: airtableConnection.baseId,
            tableName: airtableConnection.tableName,
            credentialFingerprint,
          }
        : {}),
    });
    const replay = await this.replay(
      viewer,
      input.creationIntentId,
      requestHash,
    );
    if (replay) return replay;
    const reusableSender = input.reuseSenderProfileId
      ? await this.requireReusableSender(viewer, input.reuseSenderProfileId)
      : null;
    const conflict = await this.env.DB.prepare(
      "SELECT 1 FROM events WHERE slug = ? LIMIT 1",
    )
      .bind(input.slug)
      .first();
    if (conflict) throw new EventCreationSlugConflictError();

    const eventId = crypto.randomUUID();
    const operationId = input.creationIntentId;
    const correlationId = input.creationIntentId;
    const pendingAirtable = airtableConnection !== null;
    const reusedSenderProfileId = reusableSender ? crypto.randomUUID() : null;
    const statements: D1PreparedStatement[] = [
      reusableSender
        ? this.env.DB.prepare(
            `INSERT INTO events (
               id, organisation_id, name, slug, timezone, starts_at, ends_at,
               session_formats_json, repository_provider, activation_status,
               file_policy_json,
               revision, last_operation_id, last_updated_by_person_id,
               created_at, updated_at
             )
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'd1', 'active', ?, 1, ?, ?,
                    unixepoch(), unixepoch()
               FROM sender_profiles sender
               JOIN events source_event ON source_event.id = sender.event_id
              WHERE sender.id = ? AND sender.event_id = ?
                AND source_event.organisation_id = ?
                AND source_event.activation_status = 'active'
                AND sender.status = 'verified' AND sender.provider = ?
                AND sender.name = ? AND sender.from_name = ?
                AND sender.from_email = ? AND sender.reply_to_email IS ?
                AND sender.provider_sender_id IS ?`,
          ).bind(
            eventId,
            viewer.organisationId,
            input.name,
            input.slug,
            input.timezone,
            startEpoch(input.startDate),
            endEpoch(input.endDate),
            INITIAL_EVENT_SESSION_FORMATS_JSON,
            CANONICAL_EVENT_FILE_POLICY_JSON,
            operationId,
            viewer.personId,
            reusableSender.id,
            reusableSender.sourceEventId,
            viewer.organisationId,
            reusableSender.provider,
            reusableSender.name,
            reusableSender.fromName,
            reusableSender.fromEmail,
            reusableSender.replyToEmail,
            reusableSender.providerSenderId,
          )
        : this.env.DB.prepare(
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
      ...(reusableSender && reusedSenderProfileId
        ? [
            this.env.DB.prepare(
              `INSERT INTO sender_profiles (
                 id, event_id, name, from_name, from_email, reply_to_email,
                 provider, provider_sender_id, status, created_at, updated_at
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'verified',
                         unixepoch(), unixepoch())`,
            ).bind(
              reusedSenderProfileId,
              eventId,
              reusableSender.name,
              reusableSender.fromName,
              reusableSender.fromEmail,
              reusableSender.replyToEmail,
              reusableSender.provider,
              reusableSender.providerSenderId,
            ),
          ]
        : []),
      this.env.DB.prepare(
        `INSERT INTO operation_jobs (
           id, organisation_id, event_id, requested_by_person_id, type,
           idempotency_key, correlation_id, status, payload_json, result_json,
           progress_total, progress_completed, progress_failed, cancellable,
           claim_expires_at, started_at, completed_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'event.create', ?, ?, ?, ?, ?, 1, ?, 0, 0,
                   CASE WHEN ? = 1
                        THEN unixepoch() + ${EVENT_CREATION_LEASE_SECONDS}
                        ELSE NULL END,
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
          requestHash,
          ...(reusableSender
            ? { reusedSenderProfileId: reusableSender.id }
            : {}),
        }),
        pendingAirtable
          ? null
          : JSON.stringify({
              targetEventId: eventId,
              repositoryProvider: "d1",
            }),
        pendingAirtable ? 0 : 1,
        pendingAirtable ? 1 : 0,
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
          ...(reusableSender
            ? {
                reusedSenderProfileId: reusableSender.id,
                reusedSenderSourceEventId: reusableSender.sourceEventId,
              }
            : {}),
        }),
      ),
      ...(reusableSender && reusedSenderProfileId
        ? [
            this.env.DB.prepare(
              `INSERT INTO audit_events (
                 id, organisation_id, event_id, actor_person_id, action,
                 entity_type, entity_id, correlation_id, metadata_json,
                 created_at
               ) VALUES (?, ?, ?, ?, 'communication.sender.reused',
                         'sender_profile', ?, ?, ?, unixepoch())`,
            ).bind(
              crypto.randomUUID(),
              viewer.organisationId,
              eventId,
              viewer.personId,
              reusedSenderProfileId,
              correlationId,
              JSON.stringify({
                sourceEventId: reusableSender.sourceEventId,
                sourceSenderProfileId: reusableSender.id,
                provider: reusableSender.provider,
                providerSenderId: reusableSender.providerSenderId,
                fromEmail: reusableSender.fromEmail,
              }),
            ),
          ]
        : []),
    ];
    try {
      await this.env.DB.batch(statements);
    } catch (error) {
      const concurrentReplay = await this.replay(
        viewer,
        input.creationIntentId,
        requestHash,
      );
      if (concurrentReplay) return concurrentReplay;
      if (
        error instanceof Error &&
        /UNIQUE constraint failed: events\.slug/iu.test(error.message)
      )
        throw new EventCreationSlugConflictError();
      if (reusableSender) {
        const current = await this.requireReusableSender(
          viewer,
          reusableSender.id,
        );
        if (
          current.sourceEventId !== reusableSender.sourceEventId ||
          current.name !== reusableSender.name ||
          current.fromName !== reusableSender.fromName ||
          current.fromEmail !== reusableSender.fromEmail ||
          current.replyToEmail !== reusableSender.replyToEmail ||
          current.provider !== reusableSender.provider ||
          current.providerSenderId !== reusableSender.providerSenderId
        )
          throw new EventCreationSenderReuseError(
            "The selected verified sender changed while the event was being created. Refresh and confirm the sender identity again.",
          );
      }
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
