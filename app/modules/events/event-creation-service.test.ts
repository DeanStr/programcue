import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { DEFAULT_EVENT_BRAND_ACCENT } from "~/lib/brand";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  EventCreationInProgressError,
  EventCreationIntentConflictError,
  EventCreationSenderReuseError,
  EventCreationService,
  EventCreationSlugConflictError,
} from "./event-creation-service.server";
import { parseSessionFormatsConfiguration } from "./event-configuration";
import {
  EventRepositoryProvisioningError,
  EventRepositoryProvisioningService,
} from "./event-repository-provisioning.server";
import { parseEventFilePolicy } from "~/modules/files/file-policy";
import {
  AIRTABLE_REPOSITORY_PROVIDER,
  AirtableRepositoryConfigurationError,
  AirtableRepositoryReconciliationError,
  type PreparedAirtableRepositoryConnection,
} from "~/modules/airtable/airtable-room-repository.server";
import { AIRTABLE_SCHEMA_VERSION } from "~/modules/airtable/airtable-schema";

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

async function insertSenderProfile({
  id = crypto.randomUUID(),
  eventId = viewer.eventId,
  provider = "resend",
  status = "verified",
  providerSenderId = provider === "resend" ? `domain-${id}` : null,
}: {
  id?: string;
  eventId?: string;
  provider?: "resend" | "mailpit";
  status?: "unverified" | "verified" | "disabled";
  providerSenderId?: string | null;
} = {}) {
  await env.DB.prepare(
    `INSERT INTO sender_profiles (
       id, event_id, name, from_name, from_email, reply_to_email, provider,
       provider_sender_id, status, created_at, updated_at
     ) VALUES (?, ?, ?, 'Program Cue Events', ?, ?, ?, ?, ?,
               unixepoch(), unixepoch())`,
  )
    .bind(
      id,
      eventId,
      `Sender ${id}`,
      `events-${id}@example.com`,
      `reply-${id}@example.com`,
      provider,
      providerSenderId,
      status,
    )
    .run();
  return id;
}

function preparedConnection(): PreparedAirtableRepositoryConnection {
  return {
    connectionId: crypto.randomUUID(),
    encryptedCredentials: '{"version":1,"iv":"test","ciphertext":"test"}',
    configuration: {
      baseId: "app12345678901234",
      schemaVersion: AIRTABLE_SCHEMA_VERSION,
      tables:
        {} as PreparedAirtableRepositoryConnection["configuration"]["tables"],
      authoritativeEntities: [
        "rooms",
        "event_configuration",
        "forms",
        "submissions",
        "evaluations",
        "sessions",
        "tasks",
        "published_programme",
      ],
    },
  };
}

describe("blank event creation", () => {
  beforeEach(async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    await env.DB.prepare(
      `INSERT OR IGNORE INTO memberships (
         id, organisation_id, event_id, person_id, role,
         invited_at, accepted_at, created_at
       ) VALUES (
         'membership-create-organisation-admin', ?, NULL, ?,
         'administrator', unixepoch(), unixepoch(), unixepoch()
       )`,
    )
      .bind(viewer.organisationId, viewer.personId)
      .run();
  });

  it("creates a blank D1 event with canonical baseline configuration and audit", async () => {
    const token = crypto.randomUUID().slice(0, 8);
    const result = await new EventCreationService(
      env as unknown as CloudflareEnvironment,
    ).create(viewer, {
      creationIntentId: crypto.randomUUID(),
      name: `Blank event ${token}`,
      slug: `blank-event-${token}`,
      timezone: "Australia/Sydney",
      startDate: "2027-09-10",
      endDate: "2027-09-12",
      repositoryProvider: "d1",
      personalAccessToken: "",
      baseId: "",
      tableName: "Program Cue Rooms",
    });

    expect(result.repositoryProvider).toBe("d1");
    const event = await env.DB.prepare(
      `SELECT name, slug, timezone, repository_provider AS repositoryProvider,
              activation_status AS activationStatus,
              brand_accent AS brandAccent,
              brand_draft_accent AS brandDraftAccent,
              session_formats_json AS sessionFormatsJson,
              file_policy_json AS filePolicyJson
         FROM events WHERE id = ? AND organisation_id = ?`,
    )
      .bind(result.eventId, viewer.organisationId)
      .first<{
        name: string;
        slug: string;
        timezone: string;
        repositoryProvider: string;
        activationStatus: string;
        brandAccent: string;
        brandDraftAccent: string;
        sessionFormatsJson: string;
        filePolicyJson: string;
      }>();
    expect(event).toMatchObject({
      name: `Blank event ${token}`,
      slug: `blank-event-${token}`,
      timezone: "Australia/Sydney",
      repositoryProvider: "d1",
      activationStatus: "active",
      brandAccent: DEFAULT_EVENT_BRAND_ACCENT,
      brandDraftAccent: DEFAULT_EVENT_BRAND_ACCENT,
    });
    expect(
      parseSessionFormatsConfiguration(event!.sessionFormatsJson),
    ).not.toHaveLength(0);
    expect(parseEventFilePolicy(event!.filePolicyJson)).toBeTruthy();
    expect(
      await env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM rooms WHERE event_id = ?) AS rooms,
           (SELECT COUNT(*) FROM tracks WHERE event_id = ?) AS tracks,
           (SELECT COUNT(*) FROM form_definitions WHERE event_id = ?) AS forms,
           (SELECT COUNT(*) FROM schedule_policies WHERE event_id = ?) AS policies,
           (SELECT COUNT(*) FROM sender_profiles WHERE event_id = ?) AS senders`,
      )
        .bind(
          result.eventId,
          result.eventId,
          result.eventId,
          result.eventId,
          result.eventId,
        )
        .first(),
    ).toEqual({ rooms: 0, tracks: 0, forms: 0, policies: 1, senders: 0 });
    expect(
      await env.DB.prepare(
        "SELECT status, type FROM operation_jobs WHERE id = ? AND event_id = ?",
      )
        .bind(result.operationId, result.eventId)
        .first(),
    ).toEqual({ status: "completed", type: "event.create" });
    expect(
      await env.DB.prepare(
        "SELECT action FROM audit_events WHERE event_id = ? AND action = 'event.created'",
      )
        .bind(result.eventId)
        .first(),
    ).toEqual({ action: "event.created" });
  });

  it("keeps no-sender creation available when email is not configured", async () => {
    const unconfiguredEnv = {
      ...(env as unknown as CloudflareEnvironment),
      EMAIL_PROVIDER: undefined,
      RESEND_API_KEY: undefined,
    } as unknown as CloudflareEnvironment;
    const service = new EventCreationService(unconfiguredEnv);
    const prepared = await service.prepare(viewer);
    expect(prepared).toMatchObject({
      emailProvider: null,
      emailProviderIssue:
        "Email delivery is not configured for this installation.",
      reusableSenderProfiles: [],
    });

    const token = crypto.randomUUID().slice(0, 8);
    await expect(
      service.create(viewer, {
        creationIntentId: crypto.randomUUID(),
        name: `No sender event ${token}`,
        slug: `no-sender-event-${token}`,
        timezone: "UTC",
        startDate: "2027-09-10",
        endDate: "2027-09-12",
        repositoryProvider: "d1",
      }),
    ).resolves.toMatchObject({ repositoryProvider: "d1" });
  });

  it("copies an explicitly selected verified sender in the creation transaction and replays once", async () => {
    const sourceSenderId = await insertSenderProfile();
    const token = crypto.randomUUID().slice(0, 8);
    const input = {
      creationIntentId: crypto.randomUUID(),
      name: `Sender reuse event ${token}`,
      slug: `sender-reuse-event-${token}`,
      timezone: "UTC",
      startDate: "2027-09-10",
      endDate: "2027-09-12",
      repositoryProvider: "d1" as const,
      reuseSenderProfileId: sourceSenderId,
    };
    const service = new EventCreationService(
      env as unknown as CloudflareEnvironment,
    );

    const result = await service.create(viewer, input);
    await env.DB.prepare(
      "UPDATE sender_profiles SET status = 'disabled' WHERE id = ?",
    )
      .bind(sourceSenderId)
      .run();
    await expect(service.create(viewer, input)).resolves.toEqual(result);

    const copied = await env.DB.prepare(
      `SELECT name, from_name AS fromName, from_email AS fromEmail,
              reply_to_email AS replyToEmail, provider,
              provider_sender_id AS providerSenderId, status
         FROM sender_profiles WHERE event_id = ?`,
    )
      .bind(result.eventId)
      .first();
    expect(copied).toEqual({
      name: `Sender ${sourceSenderId}`,
      fromName: "Program Cue Events",
      fromEmail: `events-${sourceSenderId}@example.com`,
      replyToEmail: `reply-${sourceSenderId}@example.com`,
      provider: "resend",
      providerSenderId: `domain-${sourceSenderId}`,
      status: "verified",
    });
    const evidence = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM sender_profiles WHERE event_id = ?) AS senders,
         (SELECT COUNT(*) FROM audit_events
           WHERE event_id = ? AND action = 'communication.sender.reused') AS reuseAudits,
         (SELECT json_extract(payload_json, '$.reusedSenderProfileId')
            FROM operation_jobs WHERE id = ?) AS selectedSenderId`,
    )
      .bind(result.eventId, result.eventId, result.operationId)
      .first();
    expect(evidence).toEqual({
      senders: 1,
      reuseAudits: 1,
      selectedSenderId: sourceSenderId,
    });
  });

  it("lists and authorizes only verified configured-provider senders from active events in the organisation", async () => {
    const eligibleId = await insertSenderProfile();
    const unverifiedId = await insertSenderProfile({ status: "unverified" });
    const wrongProviderId = await insertSenderProfile({ provider: "mailpit" });
    const missingDomainId = await insertSenderProfile({
      providerSenderId: null,
    });
    const inactiveEventId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO events (
         id, organisation_id, name, slug, timezone, starts_at, ends_at,
         repository_provider, activation_status, file_policy_json
       )
       SELECT ?, organisation_id, 'Inactive sender source', ?, timezone,
              starts_at, ends_at, 'd1', 'discarded', file_policy_json
         FROM events WHERE id = ? AND organisation_id = ?`,
    )
      .bind(
        inactiveEventId,
        `inactive-sender-source-${inactiveEventId}`,
        viewer.eventId,
        viewer.organisationId,
      )
      .run();
    const inactiveEventSenderId = await insertSenderProfile({
      eventId: inactiveEventId,
    });
    const foreignOrganisationId = crypto.randomUUID();
    const foreignEventId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO organisations (id, name, slug) VALUES (?, 'Foreign organisation', ?)",
      ).bind(foreignOrganisationId, `foreign-${foreignOrganisationId}`),
      env.DB.prepare(
        `INSERT INTO events (
           id, organisation_id, name, slug, timezone, starts_at, ends_at,
           repository_provider, activation_status, file_policy_json
         )
         SELECT ?, ?, 'Foreign sender source', ?, timezone, starts_at, ends_at,
                'd1', 'active', file_policy_json
           FROM events WHERE id = ? AND organisation_id = ?`,
      ).bind(
        foreignEventId,
        foreignOrganisationId,
        `foreign-sender-source-${foreignEventId}`,
        viewer.eventId,
        viewer.organisationId,
      ),
    ]);
    const foreignSenderId = await insertSenderProfile({
      eventId: foreignEventId,
    });
    const service = new EventCreationService(
      env as unknown as CloudflareEnvironment,
    );
    const prepared = await service.prepare(viewer);

    expect(prepared.emailProvider).toBe("resend");
    expect(
      prepared.reusableSenderProfiles.map((profile) => profile.id),
    ).toContain(eligibleId);
    expect(
      prepared.reusableSenderProfiles.map((profile) => profile.id),
    ).not.toEqual(
      expect.arrayContaining([
        unverifiedId,
        wrongProviderId,
        missingDomainId,
        inactiveEventSenderId,
        foreignSenderId,
      ]),
    );

    for (const [index, reuseSenderProfileId] of [
      unverifiedId,
      wrongProviderId,
      missingDomainId,
      inactiveEventSenderId,
      foreignSenderId,
    ].entries()) {
      const slug = `invalid-sender-reuse-${index}-${crypto.randomUUID().slice(0, 8)}`;
      await expect(
        service.create(viewer, {
          creationIntentId: crypto.randomUUID(),
          name: `Invalid sender reuse ${index}`,
          slug,
          timezone: "UTC",
          startDate: "2027-09-10",
          endDate: "2027-09-12",
          repositoryProvider: "d1",
          reuseSenderProfileId,
        }),
      ).rejects.toBeInstanceOf(EventCreationSenderReuseError);
      await expect(
        env.DB.prepare("SELECT 1 FROM events WHERE slug = ?")
          .bind(slug)
          .first(),
      ).resolves.toBeNull();
    }
  });

  it("includes the sender selection in the creation intent hash", async () => {
    const firstSenderId = await insertSenderProfile();
    const secondSenderId = await insertSenderProfile();
    const token = crypto.randomUUID().slice(0, 8);
    const input = {
      creationIntentId: crypto.randomUUID(),
      name: `Sender intent event ${token}`,
      slug: `sender-intent-event-${token}`,
      timezone: "UTC",
      startDate: "2027-09-10",
      endDate: "2027-09-12",
      repositoryProvider: "d1" as const,
      reuseSenderProfileId: firstSenderId,
    };
    const service = new EventCreationService(
      env as unknown as CloudflareEnvironment,
    );

    await service.create(viewer, input);
    await expect(
      service.create(viewer, {
        ...input,
        reuseSenderProfileId: secondSenderId,
      }),
    ).rejects.toBeInstanceOf(EventCreationIntentConflictError);
  });

  it("rejects sender reuse when Airtable authority is selected", async () => {
    const sourceSenderId = await insertSenderProfile();
    const slug = `airtable-sender-reuse-${crypto.randomUUID().slice(0, 8)}`;

    await expect(
      new EventCreationService(env as unknown as CloudflareEnvironment).create(
        viewer,
        {
          creationIntentId: crypto.randomUUID(),
          name: "Airtable sender reuse",
          slug,
          timezone: "UTC",
          startDate: "2027-09-10",
          endDate: "2027-09-12",
          repositoryProvider: "airtable",
          reuseSenderProfileId: sourceSenderId,
          personalAccessToken: "pat-test-token-at-least-twenty",
          baseId: "app12345678901234",
          tableName: "Program Cue Rooms",
        },
      ),
    ).rejects.toThrow(/reused when Program Cue holds the new event's data/i);
    await expect(
      env.DB.prepare("SELECT 1 FROM events WHERE slug = ?").bind(slug).first(),
    ).resolves.toBeNull();
  });

  it("replays the exact event and operation for one creation intent", async () => {
    const token = crypto.randomUUID().slice(0, 8);
    const creationIntentId = crypto.randomUUID();
    const input = {
      creationIntentId,
      name: `Replay event ${token}`,
      slug: `replay-event-${token}`,
      timezone: "UTC",
      startDate: "2027-09-10",
      endDate: "2027-09-12",
      repositoryProvider: "d1" as const,
      personalAccessToken: "",
      baseId: "",
      tableName: "Program Cue Rooms",
    };
    const service = new EventCreationService(
      env as unknown as CloudflareEnvironment,
    );

    const [first, replay] = await Promise.all([
      service.create(viewer, input),
      service.create(viewer, input),
    ]);

    expect(replay).toEqual(first);
    expect(first.operationId).toBe(creationIntentId);
    expect(
      await env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM events WHERE slug = ?) AS events,
           (SELECT COUNT(*) FROM operation_jobs
             WHERE id = ? AND type = 'event.create') AS operations,
           (SELECT COUNT(*) FROM audit_events
             WHERE event_id = ? AND action = 'event.created') AS audits`,
      )
        .bind(input.slug, creationIntentId, first.eventId)
        .first(),
    ).toEqual({ events: 1, operations: 1, audits: 1 });

    await expect(
      service.create(viewer, { ...input, name: "Different event intent" }),
    ).rejects.toBeInstanceOf(EventCreationIntentConflictError);
  });

  it("rejects duplicate slugs without creating another event", async () => {
    await expect(
      new EventCreationService(env as unknown as CloudflareEnvironment).create(
        viewer,
        {
          creationIntentId: crypto.randomUUID(),
          name: "Duplicate event",
          slug: "future-of-events-2027",
          timezone: "UTC",
          startDate: "2027-01-01",
          endDate: "2027-01-02",
          repositoryProvider: "d1",
          personalAccessToken: "",
          baseId: "",
          tableName: "Program Cue Rooms",
        },
      ),
    ).rejects.toBeInstanceOf(EventCreationSlugConflictError);
  });

  it("rejects malformed Airtable credentials before creating an event", async () => {
    const slug = `invalid-airtable-${crypto.randomUUID().slice(0, 8)}`;

    await expect(
      new EventCreationService(env as unknown as CloudflareEnvironment).create(
        viewer,
        {
          creationIntentId: crypto.randomUUID(),
          name: "Invalid Airtable event",
          slug,
          timezone: "UTC",
          startDate: "2027-01-01",
          endDate: "2027-01-02",
          repositoryProvider: "airtable",
          personalAccessToken: "short",
          baseId: "not-a-base",
          tableName: "Program Cue Rooms",
        },
      ),
    ).rejects.toThrow("Enter a valid Airtable personal access token.");
    expect(
      await env.DB.prepare("SELECT 1 FROM events WHERE slug = ?")
        .bind(slug)
        .first(),
    ).toBeNull();
  });

  it("rejects a direct Airtable insert that omits the provisioning lifecycle", async () => {
    const token = crypto.randomUUID();
    await expect(
      env.DB.prepare(
        `INSERT INTO events (
           id, organisation_id, name, slug, timezone, starts_at, ends_at,
           repository_provider, file_policy_json
         ) SELECT ?, organisation_id, 'Direct Airtable event', ?, timezone,
                  starts_at, ends_at, 'airtable', file_policy_json
             FROM events WHERE id = ? AND organisation_id = ?`,
      )
        .bind(
          `direct-airtable-${token}`,
          `direct-airtable-${token}`,
          viewer.eventId,
          viewer.organisationId,
        )
        .run(),
    ).rejects.toThrow(/must enter provisioning before activation/i);
  });

  it("activates Airtable only after the initial projection reconciles", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    const prepared = preparedConnection();
    const provisioning = new EventRepositoryProvisioningService(testEnv, {
      rooms: {
        provisionForEvent: async (_viewer, _eventId, connection) => {
          expect(connection).toEqual({
            personalAccessToken: "pat-test-token-at-least-twenty",
            baseId: "app12345678901234",
            tableName: "Program Cue Rooms",
          });
          return prepared;
        },
        replaceRooms: async () => ({ rooms: [] }) as never,
      },
      eventData: {
        synchronizeFromD1: async () => ({
          runId: "airtable-initial-sync",
          idempotent: false,
        }),
      },
    });
    const token = crypto.randomUUID().slice(0, 8);

    const result = await new EventCreationService(testEnv, {
      provisioning,
    }).create(viewer, {
      creationIntentId: crypto.randomUUID(),
      name: `Airtable event ${token}`,
      slug: `airtable-event-${token}`,
      timezone: "UTC",
      startDate: "2027-04-10",
      endDate: "2027-04-11",
      repositoryProvider: "airtable",
      personalAccessToken: "pat-test-token-at-least-twenty",
      baseId: "app12345678901234",
    });

    expect(result.repositoryProvider).toBe("airtable");
    expect(
      await env.DB.prepare(
        `SELECT repository_provider AS provider,
                activation_status AS activationStatus
           FROM events WHERE id = ?`,
      )
        .bind(result.eventId)
        .first(),
    ).toEqual({ provider: "airtable", activationStatus: "active" });
    expect(
      await env.DB.prepare("SELECT status FROM operation_jobs WHERE id = ?")
        .bind(result.operationId)
        .first(),
    ).toEqual({ status: "completed" });
  });

  it("reports an existing Airtable operation as in progress without repeating provider work", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    let releaseProvisioning!: () => void;
    let markProvisioningStarted!: () => void;
    const provisioningStarted = new Promise<void>((resolve) => {
      markProvisioningStarted = resolve;
    });
    const provisioningRelease = new Promise<void>((resolve) => {
      releaseProvisioning = resolve;
    });
    let provisionCount = 0;
    const provisioning = {
      provisionAirtable: async (
        _viewer: Viewer,
        eventId: string,
        operationId: string,
      ) => {
        provisionCount += 1;
        markProvisioningStarted();
        await provisioningRelease;
        await testEnv.DB.batch([
          testEnv.DB.prepare(
            `UPDATE events
                SET activation_status = 'active', repository_locked_at = unixepoch()
              WHERE id = ? AND last_operation_id = ?`,
          ).bind(eventId, operationId),
          testEnv.DB.prepare(
            `UPDATE operation_jobs
                SET status = 'completed', progress_completed = progress_total,
                    result_json = ?, completed_at = unixepoch(), updated_at = unixepoch()
              WHERE id = ? AND event_id = ? AND status = 'running'`,
          ).bind(
            JSON.stringify({
              targetEventId: eventId,
              repositoryProvider: "airtable",
            }),
            operationId,
            eventId,
          ),
        ]);
        return { runId: "controlled-provisioning", idempotent: false };
      },
    };
    const creationIntentId = crypto.randomUUID();
    const token = crypto.randomUUID().slice(0, 8);
    const input = {
      creationIntentId,
      name: `In-progress Airtable event ${token}`,
      slug: `in-progress-airtable-${token}`,
      timezone: "UTC",
      startDate: "2027-04-10",
      endDate: "2027-04-11",
      repositoryProvider: "airtable" as const,
      personalAccessToken: "pat-test-token-at-least-twenty",
      baseId: "app12345678901234",
      tableName: "Program Cue Rooms",
    };
    const service = new EventCreationService(testEnv, { provisioning });
    const first = service.create(viewer, input);
    await provisioningStarted;

    await expect(service.create(viewer, input)).rejects.toMatchObject({
      name: EventCreationInProgressError.name,
      result: {
        operationId: creationIntentId,
        repositoryProvider: "airtable",
      },
    });
    expect(provisionCount).toBe(1);
    expect(
      await testEnv.DB.prepare(
        `SELECT claim_expires_at > unixepoch() AS leaseActive
           FROM operation_jobs WHERE id = ?`,
      )
        .bind(creationIntentId)
        .first(),
    ).toEqual({ leaseActive: 1 });

    releaseProvisioning();
    await expect(first).resolves.toMatchObject({
      operationId: creationIntentId,
      repositoryProvider: "airtable",
    });
  });

  it("fails an expired Airtable creation lease without repeating provider work", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    const prepared = preparedConnection();
    let releaseProvisioning!: () => void;
    let markProvisioningStarted!: () => void;
    const provisioningStarted = new Promise<void>((resolve) => {
      markProvisioningStarted = resolve;
    });
    const provisioningRelease = new Promise<void>((resolve) => {
      releaseProvisioning = resolve;
    });
    let provisionCount = 0;
    let replaceCount = 0;
    let synchronizationCount = 0;
    const provisioning = new EventRepositoryProvisioningService(testEnv, {
      rooms: {
        provisionForEvent: async () => {
          provisionCount += 1;
          markProvisioningStarted();
          await provisioningRelease;
          return prepared;
        },
        replaceRooms: async () => {
          replaceCount += 1;
          return { rooms: [] } as never;
        },
      },
      eventData: {
        synchronizeFromD1: async () => {
          synchronizationCount += 1;
          return { runId: "stale-provisioning-sync", idempotent: false };
        },
      },
    });
    const creationIntentId = crypto.randomUUID();
    const token = crypto.randomUUID().slice(0, 8);
    const input = {
      creationIntentId,
      name: `Expired Airtable event ${token}`,
      slug: `expired-airtable-${token}`,
      timezone: "UTC",
      startDate: "2027-04-10",
      endDate: "2027-04-11",
      repositoryProvider: "airtable" as const,
      personalAccessToken: "pat-test-token-at-least-twenty",
      baseId: "app12345678901234",
      tableName: "Program Cue Rooms",
    };
    const service = new EventCreationService(testEnv, { provisioning });
    const first = service.create(viewer, input);
    await provisioningStarted;
    await testEnv.DB.prepare(
      `UPDATE operation_jobs SET claim_expires_at = unixepoch() - 1
        WHERE id = ? AND status = 'running'`,
    )
      .bind(creationIntentId)
      .run();

    await expect(service.create(viewer, input)).rejects.toMatchObject({
      name: EventRepositoryProvisioningError.name,
      operationId: creationIntentId,
      failureKind: "internal",
      message: expect.stringMatching(/stopped before Airtable provisioning/iu),
    });
    expect(provisionCount).toBe(1);
    expect(
      await testEnv.DB.prepare(
        `SELECT event.activation_status AS activationStatus,
                operation.status, operation.claim_expires_at AS claimExpiresAt,
                json_extract(operation.result_json, '$.failureCode') AS failureCode,
                (SELECT COUNT(*) FROM audit_events audit
                  WHERE audit.event_id = event.id
                    AND audit.action = 'event.repository.provisioning_failed'
                    AND audit.correlation_id = operation.id) AS failureAudits
           FROM operation_jobs operation
           JOIN events event ON event.id = operation.event_id
          WHERE operation.id = ?`,
      )
        .bind(creationIntentId)
        .first(),
    ).toEqual({
      activationStatus: "provisioning_failed",
      status: "failed",
      claimExpiresAt: null,
      failureCode: "event_creation_lease_expired",
      failureAudits: 1,
    });

    releaseProvisioning();
    await expect(first).rejects.toMatchObject({
      name: EventRepositoryProvisioningError.name,
      operationId: creationIntentId,
      failureKind: "internal",
    });
    expect(replaceCount).toBe(0);
    expect(synchronizationCount).toBe(0);
    expect(
      await testEnv.DB.prepare(
        `SELECT activation_status AS activationStatus
           FROM events WHERE last_operation_id = ?`,
      )
        .bind(creationIntentId)
        .first(),
    ).toEqual({ activationStatus: "provisioning_failed" });
  });

  it("does not activate when the Airtable creation lease expires during provider work", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    const prepared = preparedConnection();
    let releaseProvisioning!: () => void;
    let markProvisioningStarted!: () => void;
    const provisioningStarted = new Promise<void>((resolve) => {
      markProvisioningStarted = resolve;
    });
    const provisioningRelease = new Promise<void>((resolve) => {
      releaseProvisioning = resolve;
    });
    let replaceCount = 0;
    let synchronizationCount = 0;
    const provisioning = new EventRepositoryProvisioningService(testEnv, {
      rooms: {
        provisionForEvent: async () => {
          markProvisioningStarted();
          await provisioningRelease;
          return prepared;
        },
        replaceRooms: async () => {
          replaceCount += 1;
          return { rooms: [] } as never;
        },
      },
      eventData: {
        synchronizeFromD1: async () => {
          synchronizationCount += 1;
          return { runId: "expired-provider-work", idempotent: false };
        },
      },
    });
    const creationIntentId = crypto.randomUUID();
    const token = crypto.randomUUID().slice(0, 8);
    const creation = new EventCreationService(testEnv, { provisioning }).create(
      viewer,
      {
        creationIntentId,
        name: `Expired provider work ${token}`,
        slug: `expired-provider-work-${token}`,
        timezone: "UTC",
        startDate: "2027-04-10",
        endDate: "2027-04-11",
        repositoryProvider: "airtable",
        personalAccessToken: "pat-test-token-at-least-twenty",
        baseId: "app12345678901234",
        tableName: "Program Cue Rooms",
      },
    );
    await provisioningStarted;
    await testEnv.DB.prepare(
      `UPDATE operation_jobs SET claim_expires_at = unixepoch() - 1
        WHERE id = ? AND status = 'running'`,
    )
      .bind(creationIntentId)
      .run();

    releaseProvisioning();
    await expect(creation).rejects.toMatchObject({
      name: EventRepositoryProvisioningError.name,
      operationId: creationIntentId,
      failureKind: "internal",
      message: expect.stringMatching(/stopped before Airtable provisioning/iu),
    });
    expect(replaceCount).toBe(0);
    expect(synchronizationCount).toBe(0);
    expect(
      await testEnv.DB.prepare(
        `SELECT event.activation_status AS activationStatus,
                operation.status, operation.claim_expires_at AS claimExpiresAt,
                json_extract(operation.result_json, '$.failureCode') AS failureCode
           FROM operation_jobs operation
           JOIN events event ON event.id = operation.event_id
          WHERE operation.id = ?`,
      )
        .bind(creationIntentId)
        .first(),
    ).toEqual({
      activationStatus: "provisioning_failed",
      status: "failed",
      claimExpiresAt: null,
      failureCode: "event_creation_lease_expired",
    });
  });

  it("keeps a failed Airtable event inactive when reconciliation fails after commit", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    const prepared = preparedConnection();
    let provisionCount = 0;
    const provisioning = new EventRepositoryProvisioningService(testEnv, {
      rooms: {
        provisionForEvent: async () => {
          provisionCount += 1;
          return prepared;
        },
        replaceRooms: async () => ({ rooms: [] }) as never,
      },
      eventData: {
        synchronizeFromD1: async () => {
          throw new AirtableRepositoryReconciliationError(
            "simulated Airtable reconciliation failure",
          );
        },
      },
    });
    const slug = `airtable-failed-${crypto.randomUUID().slice(0, 8)}`;
    const creationIntentId = crypto.randomUUID();
    const input = {
      creationIntentId,
      name: "Failed Airtable event",
      slug,
      timezone: "UTC",
      startDate: "2027-04-10",
      endDate: "2027-04-11",
      repositoryProvider: "airtable" as const,
      personalAccessToken: "pat-test-token-at-least-twenty",
      baseId: "app12345678901234",
      tableName: "Program Cue Rooms",
    };
    let failure: EventRepositoryProvisioningError | null = null;

    try {
      await new EventCreationService(testEnv, { provisioning }).create(
        viewer,
        input,
      );
    } catch (error) {
      if (error instanceof EventRepositoryProvisioningError) failure = error;
      else throw error;
    }

    expect(failure).not.toBeNull();
    expect(failure!.failureKind).toBe("provider");
    await expect(
      new EventCreationService(testEnv, { provisioning }).create(viewer, input),
    ).rejects.toMatchObject({
      eventId: failure!.eventId,
      operationId: creationIntentId,
      failureKind: "provider",
    });
    expect(provisionCount).toBe(1);
    await expect(
      new EventCreationService(testEnv, { provisioning }).create(viewer, {
        ...input,
        personalAccessToken: "pat-different-token-at-least-twenty",
      }),
    ).rejects.toBeInstanceOf(EventCreationIntentConflictError);
    expect(provisionCount).toBe(1);
    expect(
      await env.DB.prepare(
        `SELECT repository_provider AS provider,
                activation_status AS activationStatus
           FROM events WHERE id = ?`,
      )
        .bind(failure!.eventId)
        .first(),
    ).toEqual({
      provider: "airtable",
      activationStatus: "provisioning_failed",
    });
    expect(
      await env.DB.prepare(
        "SELECT status, last_error AS lastError FROM operation_jobs WHERE id = ?",
      )
        .bind(failure!.operationId)
        .first(),
    ).toEqual({
      status: "failed",
      lastError: "simulated Airtable reconciliation failure",
    });
    expect(
      await env.DB.prepare(
        `SELECT status FROM integration_connections
          WHERE event_id = ? AND provider = ?`,
      )
        .bind(failure!.eventId, AIRTABLE_REPOSITORY_PROVIDER)
        .first(),
    ).toEqual({ status: "needs_attention" });
    expect(
      await env.DB.prepare(
        `SELECT action FROM audit_events
          WHERE event_id = ? AND action = 'event.created'`,
      )
        .bind(failure!.eventId)
        .first(),
    ).toEqual({ action: "event.created" });
  });

  it("fails activation when a provisioning event is already repository-locked", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    const prepared = preparedConnection();
    const provisioning = new EventRepositoryProvisioningService(testEnv, {
      rooms: {
        provisionForEvent: async () => prepared,
        replaceRooms: async () => ({ rooms: [] }) as never,
      },
      eventData: {
        synchronizeFromD1: async (scope) => {
          await testEnv.DB.prepare(
            "UPDATE events SET repository_locked_at = unixepoch() WHERE id = ?",
          )
            .bind(scope.eventId)
            .run();
          return { runId: "unexpected-prelocked-sync", idempotent: false };
        },
      },
    });
    let failure: EventRepositoryProvisioningError | null = null;

    try {
      await new EventCreationService(testEnv, { provisioning }).create(viewer, {
        creationIntentId: crypto.randomUUID(),
        name: "Prelocked Airtable event",
        slug: `airtable-prelocked-${crypto.randomUUID().slice(0, 8)}`,
        timezone: "UTC",
        startDate: "2027-04-10",
        endDate: "2027-04-11",
        repositoryProvider: "airtable",
        personalAccessToken: "pat-test-token-at-least-twenty",
        baseId: "app12345678901234",
        tableName: "Program Cue Rooms",
      });
    } catch (error) {
      if (error instanceof EventRepositoryProvisioningError) failure = error;
      else throw error;
    }

    expect(failure).toMatchObject({ failureKind: "internal" });
    expect(
      await env.DB.prepare(
        `SELECT activation_status AS activationStatus
           FROM events WHERE id = ?`,
      )
        .bind(failure!.eventId)
        .first(),
    ).toEqual({ activationStatus: "provisioning_failed" });
  });

  it("records the event and failed operation before Airtable validation begins", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    const provisioning = new EventRepositoryProvisioningService(testEnv, {
      rooms: {
        provisionForEvent: async () => {
          throw new AirtableRepositoryConfigurationError(
            "simulated Airtable credential rejection",
          );
        },
        replaceRooms: async () => ({ rooms: [] }) as never,
      },
      eventData: {
        synchronizeFromD1: async () => ({
          runId: "unreachable",
          idempotent: false,
        }),
      },
    });
    const slug = `airtable-validation-failed-${crypto.randomUUID().slice(0, 8)}`;
    let failure: EventRepositoryProvisioningError | null = null;

    try {
      await new EventCreationService(testEnv, { provisioning }).create(viewer, {
        creationIntentId: crypto.randomUUID(),
        name: "Rejected Airtable event",
        slug,
        timezone: "UTC",
        startDate: "2027-04-10",
        endDate: "2027-04-11",
        repositoryProvider: "airtable",
        personalAccessToken: "pat-test-token-at-least-twenty",
        baseId: "app12345678901234",
        tableName: "Program Cue Rooms",
      });
    } catch (error) {
      if (error instanceof EventRepositoryProvisioningError) failure = error;
      else throw error;
    }

    expect(failure).not.toBeNull();
    expect(failure!.failureKind).toBe("provider");
    expect(
      await env.DB.prepare(
        `SELECT event.repository_provider AS provider,
                event.activation_status AS activationStatus, operation.status,
                operation.last_error AS lastError
           FROM events event
           JOIN operation_jobs operation ON operation.id = event.last_operation_id
          WHERE event.id = ? AND event.slug = ?`,
      )
        .bind(failure!.eventId, slug)
        .first(),
    ).toEqual({
      provider: "airtable",
      activationStatus: "provisioning_failed",
      status: "failed",
      lastError: "simulated Airtable credential rejection",
    });
  });

  it("does not overwrite a newer provisioning owner during Airtable finalization", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    const prepared = preparedConnection();
    const provisioning = new EventRepositoryProvisioningService(testEnv, {
      rooms: {
        provisionForEvent: async () => prepared,
        replaceRooms: async () => ({ rooms: [] }) as never,
      },
      eventData: {
        synchronizeFromD1: async (scope) => {
          await testEnv.DB.prepare(
            "UPDATE events SET last_operation_id = 'concurrent-operation' WHERE id = ?",
          )
            .bind(scope.eventId)
            .run();
          return { runId: "airtable-concurrent-sync", idempotent: false };
        },
      },
    });
    let failure: EventRepositoryProvisioningError | null = null;

    try {
      await new EventCreationService(testEnv, { provisioning }).create(viewer, {
        creationIntentId: crypto.randomUUID(),
        name: "Concurrent Airtable event",
        slug: `airtable-concurrent-${crypto.randomUUID().slice(0, 8)}`,
        timezone: "UTC",
        startDate: "2027-04-10",
        endDate: "2027-04-11",
        repositoryProvider: "airtable",
        personalAccessToken: "pat-test-token-at-least-twenty",
        baseId: "app12345678901234",
        tableName: "Program Cue Rooms",
      });
    } catch (error) {
      if (error instanceof EventRepositoryProvisioningError) failure = error;
      else throw error;
    }

    expect(failure).not.toBeNull();
    expect(failure!.failureKind).toBe("internal");
    expect(
      await env.DB.prepare(
        `SELECT repository_provider AS provider,
                activation_status AS activationStatus
           FROM events WHERE id = ?`,
      )
        .bind(failure!.eventId)
        .first(),
    ).toEqual({
      provider: "airtable",
      activationStatus: "provisioning",
    });
    expect(
      await env.DB.prepare("SELECT status FROM operation_jobs WHERE id = ?")
        .bind(failure!.operationId)
        .first(),
    ).toEqual({ status: "failed" });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
          WHERE event_id = ? AND action = 'event.repository.selected'`,
      )
        .bind(failure!.eventId)
        .first(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
          WHERE event_id = ?
            AND action = 'event.repository.provisioning_failed'`,
      )
        .bind(failure!.eventId)
        .first(),
    ).toEqual({ count: 0 });
  });

  it("rejects an event-scoped administrator", async () => {
    await env.DB.prepare(
      "DELETE FROM memberships WHERE id = 'membership-create-organisation-admin'",
    ).run();
    await expect(
      new EventCreationService(env as unknown as CloudflareEnvironment).create(
        viewer,
        {
          creationIntentId: crypto.randomUUID(),
          name: "Forbidden event",
          slug: `forbidden-event-${crypto.randomUUID()}`,
          timezone: "UTC",
          startDate: "2027-01-01",
          endDate: "2027-01-02",
          repositoryProvider: "d1",
          personalAccessToken: "",
          baseId: "",
          tableName: "Program Cue Rooms",
        },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});
