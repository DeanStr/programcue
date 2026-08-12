import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import {
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

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

function preparedConnection(): PreparedAirtableRepositoryConnection {
  return {
    connectionId: crypto.randomUUID(),
    encryptedCredentials: '{"version":1,"iv":"test","ciphertext":"test"}',
    configuration: {
      baseId: "app12345678901234",
      schemaVersion: 4,
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
        sessionFormatsJson: string;
        filePolicyJson: string;
      }>();
    expect(event).toMatchObject({
      name: `Blank event ${token}`,
      slug: `blank-event-${token}`,
      timezone: "Australia/Sydney",
      repositoryProvider: "d1",
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
           (SELECT COUNT(*) FROM schedule_policies WHERE event_id = ?) AS policies`,
      )
        .bind(result.eventId, result.eventId, result.eventId, result.eventId)
        .first(),
    ).toEqual({ rooms: 0, tracks: 0, forms: 0, policies: 1 });
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

  it("rejects duplicate slugs without creating another event", async () => {
    await expect(
      new EventCreationService(env as unknown as CloudflareEnvironment).create(
        viewer,
        {
          name: "Duplicate event",
          slug: "future-of-events-2025",
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
        "SELECT repository_provider AS provider FROM events WHERE id = ?",
      )
        .bind(result.eventId)
        .first(),
    ).toEqual({ provider: "airtable" });
    expect(
      await env.DB.prepare("SELECT status FROM operation_jobs WHERE id = ?")
        .bind(result.operationId)
        .first(),
    ).toEqual({ status: "completed" });
  });

  it("leaves an honestly failed D1 event when Airtable reconciliation fails after commit", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    const prepared = preparedConnection();
    const provisioning = new EventRepositoryProvisioningService(testEnv, {
      rooms: {
        provisionForEvent: async () => prepared,
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
    let failure: EventRepositoryProvisioningError | null = null;

    try {
      await new EventCreationService(testEnv, { provisioning }).create(viewer, {
        name: "Failed Airtable event",
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
        "SELECT repository_provider AS provider FROM events WHERE id = ?",
      )
        .bind(failure!.eventId)
        .first(),
    ).toEqual({ provider: "d1" });
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
        `SELECT event.repository_provider AS provider, operation.status,
                operation.last_error AS lastError
           FROM events event
           JOIN operation_jobs operation ON operation.id = event.last_operation_id
          WHERE event.id = ? AND event.slug = ?`,
      )
        .bind(failure!.eventId, slug)
        .first(),
    ).toEqual({
      provider: "d1",
      status: "failed",
      lastError: "simulated Airtable credential rejection",
    });
  });

  it("does not switch authority when the event changes before Airtable finalization", async () => {
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
        "SELECT repository_provider AS provider FROM events WHERE id = ?",
      )
        .bind(failure!.eventId)
        .first(),
    ).toEqual({ provider: "d1" });
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
  });

  it("rejects an event-scoped administrator", async () => {
    await env.DB.prepare(
      "DELETE FROM memberships WHERE id = 'membership-create-organisation-admin'",
    ).run();
    await expect(
      new EventCreationService(env as unknown as CloudflareEnvironment).create(
        viewer,
        {
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
