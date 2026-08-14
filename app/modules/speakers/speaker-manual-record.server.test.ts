import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { SBEK_FIXTURE_PEOPLE } from "~/platform/demo/demo-identities";
import type { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { SpeakerService } from "./speaker-service.server";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
  }
}

const admin: Viewer = {
  personId: "person-demo-admin",
  name: "Jordan Alvarez",
  email: "organizer@programcue.dev",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: false,
  evaluation: false,
};

beforeEach(async () => {
  await ensureDemoData(env as unknown as CloudflareEnvironment);
});

function withManualSpeakerDomainBatch(
  testEnv: CloudflareEnvironment,
  intercept: (
    database: D1Database,
    statements: D1PreparedStatement[],
  ) => Promise<D1Result[]>,
) {
  let domainBatchPrepared = false;
  let intercepted = false;
  const database = new Proxy(testEnv.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          if (
            !intercepted &&
            query.includes("INSERT INTO audit_events") &&
            query.includes("'speaker.admin.added'")
          ) {
            domainBatchPrepared = true;
          }
          return target.prepare(query);
        };
      }
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (domainBatchPrepared && !intercepted) {
            domainBatchPrepared = false;
            intercepted = true;
            return intercept(target, statements);
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(testEnv, {
    get(target, property) {
      return property === "DB" ? database : Reflect.get(target, property);
    },
  });
}

describe("manual speaker roster records", () => {
  it("keeps an existing-contact prospect handoff behind the event repository authority", async () => {
    const suffix = crypto.randomUUID();
    const personId = `airtable-prospect-${suffix}`;
    const email = `airtable-prospect-${suffix}@example.com`;
    const testEnv = env as unknown as CloudflareEnvironment;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO people (id, email, display_name, email_verified, profile_status)
         VALUES (?, ?, 'Airtable prospect', 0, 'draft')`,
      ).bind(personId, email),
      testEnv.DB.prepare(
        `INSERT INTO organisation_contacts (
           organisation_id, person_id, source, status, created_by_person_id,
           created_at, updated_at
         ) VALUES (?, ?, 'manual', 'active', ?, unixepoch(), unixepoch())`,
      ).bind(admin.organisationId, personId, admin.personId),
    ]);
    const operations: string[] = [];
    const authority = {
      executeIdempotent: async <T>(
        _viewer: Viewer,
        command: { operation: string },
        execute: () => Promise<T>,
      ) => {
        operations.push(command.operation);
        return execute();
      },
    } as unknown as AirtableProviderBoundary;

    await expect(
      new SpeakerService(testEnv, {
        airtable: authority,
      }).addExistingSpeakerProspect(admin, {
        idempotencyKey: `airtable-prospect:${suffix}`,
        personId,
      }),
    ).resolves.toMatchObject({
      personId,
      workflowStatus: "prospect",
      created: true,
    });
    expect(operations).toEqual(["speaker.admin.prospect.add_existing"]);
  });

  it("adds an ordinary production prospect with profile data and creates no invitation work", async () => {
    const suffix = crypto.randomUUID();
    const email = `production-prospect-${suffix}@example.com`;
    const productionEnv = {
      ...(env as unknown as CloudflareEnvironment),
      APP_ENV: "production",
      DEMO_MODE: "false",
      EVALUATION_MODE: "false",
      OPERATIONS_QUEUE: undefined,
    } as unknown as CloudflareEnvironment;
    const result = await new SpeakerService(
      productionEnv,
    ).addManualSpeakerRecord(admin, {
      idempotencyKey: `production-prospect:${suffix}`,
      name: "Production Prospect",
      email,
      jobTitle: "Director",
      organisationName: "Signal Works",
      biography: "Runs event operations.",
    });

    expect(result).toMatchObject({
      email,
      createdIdentity: true,
      createdRosterAssociation: true,
      routing: null,
    });
    await expect(
      productionEnv.DB.prepare(
        `SELECT person.job_title AS jobTitle,
                person.organisation_name AS organisationName,
                person.biography,
                membership.invited_at AS invitedAt,
                membership.invitation_expires_at AS invitationExpiresAt,
                workflow.status,
                (SELECT COUNT(*) FROM operation_jobs operation
                  WHERE operation.event_id = membership.event_id
                    AND operation.correlation_id = audit.correlation_id
                ) AS operationCount,
                (SELECT COUNT(*) FROM communications communication
                  JOIN operation_jobs operation
                    ON operation.id = communication.operation_id
                  WHERE communication.event_id = membership.event_id
                    AND operation.correlation_id = audit.correlation_id
                ) AS communicationCount
           FROM people person
           JOIN memberships membership
             ON membership.person_id = person.id AND membership.event_id = ?
            AND membership.role = 'speaker'
           JOIN event_speaker_workflows workflow
             ON workflow.event_id = membership.event_id
            AND workflow.person_id = membership.person_id
           JOIN audit_events audit
             ON audit.event_id = membership.event_id
            AND audit.entity_id = person.id
            AND audit.action = 'speaker.admin.added'
          WHERE person.email = ? COLLATE NOCASE`,
      )
        .bind(admin.eventId, email)
        .first(),
    ).resolves.toEqual({
      jobTitle: "Director",
      organisationName: "Signal Works",
      biography: "Runs event operations.",
      invitedAt: null,
      invitationExpiresAt: null,
      status: "prospect",
      operationCount: 0,
      communicationCount: 0,
    });
  });

  it("rejects a reserved production portal destination before changing the prospect", async () => {
    const suffix = crypto.randomUUID();
    const email = `reserved-portal-${suffix}@example.com`;
    const productionEnv = {
      ...(env as unknown as CloudflareEnvironment),
      APP_ENV: "production",
      DEMO_MODE: "false",
      EVALUATION_MODE: "false",
      OPERATIONS_QUEUE: undefined,
    } as unknown as CloudflareEnvironment;
    const service = new SpeakerService(productionEnv);
    const prospect = await service.addManualSpeakerRecord(admin, {
      idempotencyKey: `reserved-portal-prospect:${suffix}`,
      name: "Reserved Portal Prospect",
      email,
      jobTitle: "Director",
      organisationName: "Signal Works",
      biography: "Runs event operations.",
    });

    await expect(
      service.inviteSpeakerRecord(admin, {
        idempotencyKey: `reserved-portal-invite:${suffix}`,
        personId: prospect.personId,
        confirmation: "send",
      }),
    ).rejects.toThrow(/not deliverable: reserved or local-only domain/i);
    await expect(
      productionEnv.DB.prepare(
        `SELECT membership.invited_at AS invitedAt,
                membership.invitation_expires_at AS invitationExpiresAt,
                workflow.status,
                (SELECT COUNT(*) FROM operation_jobs operation
                  WHERE operation.event_id = membership.event_id
                    AND operation.idempotency_key LIKE ?) AS operationCount,
                (SELECT COUNT(*) FROM communications communication
                  WHERE communication.event_id = membership.event_id
                    AND json_extract(communication.audience_json, '$.email') = ?)
                  AS communicationCount
           FROM memberships membership
           JOIN event_speaker_workflows workflow
             ON workflow.event_id = membership.event_id
            AND workflow.person_id = membership.person_id
          WHERE membership.event_id = ? AND membership.person_id = ?
            AND membership.role = 'speaker'`,
      )
        .bind("speaker-invitation:%", email, admin.eventId, prospect.personId)
        .first(),
    ).resolves.toEqual({
      invitedAt: null,
      invitationExpiresAt: null,
      status: "prospect",
      operationCount: 0,
      communicationCount: 0,
    });
  });

  it("reuses and discloses the exact fixed evaluator identity without sending", async () => {
    const routeable = {
      [SBEK_FIXTURE_PEOPLE.organizer.personId]:
        "evaluation-organizer@programcue.dev",
      [SBEK_FIXTURE_PEOPLE.speaker.personId]:
        "evaluation-speaker@programcue.dev",
      [SBEK_FIXTURE_PEOPLE.speaker2.personId]:
        "evaluation-speaker-2@programcue.dev",
      [SBEK_FIXTURE_PEOPLE.reviewer.personId]:
        "evaluation-reviewer@programcue.dev",
    } as const;
    const testEnv = env as unknown as CloudflareEnvironment;
    await testEnv.DB.batch(
      Object.entries(routeable).map(([personId, email]) =>
        testEnv.DB.prepare("UPDATE people SET email = ? WHERE id = ?").bind(
          email,
          personId,
        ),
      ),
    );
    const productionEvaluationEnv = {
      ...testEnv,
      APP_ENV: "production",
      DEMO_MODE: "false",
      EVALUATION_MODE: "true",
      OPERATIONS_QUEUE: undefined,
    } as unknown as CloudflareEnvironment;
    const evaluationAdmin: Viewer = {
      ...admin,
      personId: SBEK_FIXTURE_PEOPLE.organizer.personId,
      email: routeable[SBEK_FIXTURE_PEOPLE.organizer.personId],
      evaluation: true,
    };
    const enteredEmail = "marcus.speaker@sbek-test.example.com";
    const result = await new SpeakerService(
      productionEvaluationEnv,
    ).addManualSpeakerRecord(evaluationAdmin, {
      idempotencyKey: `evaluation-prospect:${crypto.randomUUID()}`,
      name: "Marcus Okafor",
      email: enteredEmail,
      jobTitle: "CTO",
      organisationName: "Relay Labs",
      biography: "Builds resilient systems.",
    });

    expect(result).toEqual({
      personId: SBEK_FIXTURE_PEOPLE.speaker2.personId,
      email: routeable[SBEK_FIXTURE_PEOPLE.speaker2.personId],
      createdIdentity: false,
      createdRosterAssociation: true,
      routing: {
        enteredEmail,
        routedEmail: routeable[SBEK_FIXTURE_PEOPLE.speaker2.personId],
        personId: SBEK_FIXTURE_PEOPLE.speaker2.personId,
      },
    });
    await expect(
      testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM people WHERE email = ? COLLATE NOCASE`,
      )
        .bind(enteredEmail)
        .first<{ count: number }>(),
    ).resolves.toEqual({ count: 0 });
    await expect(
      testEnv.DB.prepare(
        `SELECT json_extract(metadata_json, '$.enteredEmail') AS enteredEmail,
                json_extract(metadata_json, '$.routedEmail') AS routedEmail,
                (SELECT COUNT(*) FROM communications communication
                  WHERE communication.event_id = audit_events.event_id
                    AND json_extract(communication.audience_json, '$.email') = ?
                ) AS communicationCount
           FROM audit_events
          WHERE event_id = ? AND action = 'speaker.admin.added'
            AND entity_id = ?
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
        .bind(
          routeable[SBEK_FIXTURE_PEOPLE.speaker2.personId],
          evaluationAdmin.eventId,
          SBEK_FIXTURE_PEOPLE.speaker2.personId,
        )
        .first(),
    ).resolves.toEqual({
      enteredEmail,
      routedEmail: routeable[SBEK_FIXTURE_PEOPLE.speaker2.personId],
      communicationCount: 0,
    });
  });

  it("reactivates a revoked roster association without silently restoring portal access", async () => {
    const suffix = crypto.randomUUID();
    const personId = `revoked-record-${suffix}`;
    const email = `revoked-record-${suffix}@example.com`;
    const testEnv = env as unknown as CloudflareEnvironment;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO people (id, email, display_name, email_verified, profile_status)
         VALUES (?, ?, 'Revoked record', 1, 'draft')`,
      ).bind(personId, email),
      testEnv.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role, invited_at,
           invitation_expires_at, accepted_at, revoked_at, created_at
         ) VALUES (?, ?, ?, ?, 'speaker', unixepoch() - 300,
                   unixepoch() + 300, unixepoch() - 200, unixepoch() - 100,
                   unixepoch())`,
      ).bind(
        `revoked-membership-${suffix}`,
        admin.organisationId,
        admin.eventId,
        personId,
      ),
      testEnv.DB.prepare(
        `INSERT INTO event_speaker_workflows (
           event_id, person_id, status, source, last_operation_id,
           updated_by_person_id, created_at, updated_at
         ) VALUES (?, ?, 'withdrawn', 'manual', ?, ?, unixepoch(), unixepoch())`,
      ).bind(
        admin.eventId,
        personId,
        `withdrawn-record:${suffix}`,
        admin.personId,
      ),
    ]);

    const restored = await new SpeakerService(testEnv).addManualSpeakerRecord(
      { ...admin, demo: true },
      {
        idempotencyKey: `reactivate-record:${suffix}`,
        name: "Revoked record",
        email,
        jobTitle: "",
        organisationName: "",
        biography: "",
      },
    );
    expect(restored).toMatchObject({
      personId,
      createdIdentity: false,
      createdRosterAssociation: true,
    });
    await expect(
      testEnv.DB.prepare(
        `SELECT invited_at AS invitedAt,
                invitation_expires_at AS invitationExpiresAt,
                accepted_at AS acceptedAt, revoked_at AS revokedAt
           FROM memberships
          WHERE event_id = ? AND person_id = ? AND role = 'speaker'`,
      )
        .bind(admin.eventId, personId)
        .first(),
    ).resolves.toEqual({
      invitedAt: null,
      invitationExpiresAt: null,
      acceptedAt: null,
      revokedAt: null,
    });
  });

  it("refuses to link a globally existing identity with no organisation relationship", async () => {
    const suffix = crypto.randomUUID();
    const personId = `foreign-record-${suffix}`;
    const email = `foreign-record-${suffix}@outside.invalidmail.dev`;
    const testEnv = env as unknown as CloudflareEnvironment;
    await testEnv.DB.prepare(
      `INSERT INTO people (
         id, email, display_name, email_verified, profile_status,
         created_at, updated_at
       ) VALUES (?, ?, 'Foreign record', 1, 'published',
                 unixepoch(), unixepoch())`,
    )
      .bind(personId, email)
      .run();

    await expect(
      new SpeakerService(testEnv).addManualSpeakerRecord(
        { ...admin, demo: true },
        {
          idempotencyKey: `foreign-record:${suffix}`,
          name: "Foreign record",
          email,
          jobTitle: "",
          organisationName: "",
          biography: "",
        },
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      testEnv.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM memberships
             WHERE event_id = ? AND person_id = ?) AS memberships,
           (SELECT COUNT(*) FROM event_speaker_workflows
             WHERE event_id = ? AND person_id = ?) AS workflows,
           (SELECT COUNT(*) FROM audit_events
             WHERE event_id = ? AND entity_id = ?
               AND action = 'speaker.admin.added') AS audits`,
      )
        .bind(
          admin.eventId,
          personId,
          admin.eventId,
          personId,
          admin.eventId,
          personId,
        )
        .first(),
    ).resolves.toEqual({ memberships: 0, workflows: 0, audits: 0 });
  });

  it("converges on a concurrent active roster association without rewriting it", async () => {
    const suffix = crypto.randomUUID();
    const personId = `concurrent-record-${suffix}`;
    const email = `concurrent-record-${suffix}@example.com`;
    const membershipOperationId = `concurrent-membership:${suffix}`;
    const workflowOperationId = `concurrent-workflow:${suffix}`;
    const testEnv = env as unknown as CloudflareEnvironment;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, email_verified, profile_status,
           created_at, updated_at
         ) VALUES (?, ?, 'Concurrent winner', 0, 'draft',
                   unixepoch(), unixepoch())`,
      ).bind(personId, email),
      testEnv.DB.prepare(
        `INSERT INTO organisation_contacts (
           organisation_id, person_id, source, status, created_by_person_id,
           created_at, updated_at
         ) VALUES (?, ?, 'manual', 'active', ?, unixepoch(), unixepoch())`,
      ).bind(admin.organisationId, personId, admin.personId),
    ]);
    const racingEnv = withManualSpeakerDomainBatch(
      testEnv,
      async (database, statements) => {
        await database.batch([
          database
            .prepare(
              `INSERT INTO memberships (
               id, organisation_id, event_id, person_id, role,
               last_operation_id, created_at
             ) VALUES (?, ?, ?, ?, 'speaker', ?, unixepoch())`,
            )
            .bind(
              `concurrent-membership-${suffix}`,
              admin.organisationId,
              admin.eventId,
              personId,
              membershipOperationId,
            ),
          database
            .prepare(
              `INSERT INTO event_speaker_workflows (
               event_id, person_id, status, source, last_operation_id,
               updated_by_person_id, created_at, updated_at
             ) VALUES (?, ?, 'prospect', 'manual', ?, ?,
                       unixepoch(), unixepoch())`,
            )
            .bind(admin.eventId, personId, workflowOperationId, admin.personId),
        ]);
        return database.batch(statements);
      },
    );
    const service = new SpeakerService(racingEnv);
    const input = {
      idempotencyKey: `concurrent-record:${suffix}`,
      name: "Losing update",
      email,
      jobTitle: "Changed title",
      organisationName: "Changed organisation",
      biography: "Changed biography",
    };

    const converged = await service.addManualSpeakerRecord(admin, input);
    expect(converged).toEqual({
      personId,
      email,
      createdIdentity: false,
      createdRosterAssociation: false,
      routing: null,
    });
    await expect(service.addManualSpeakerRecord(admin, input)).resolves.toEqual(
      converged,
    );
    await expect(
      service.addManualSpeakerRecord(admin, {
        ...input,
        idempotencyKey: `concurrent-record-fresh:${suffix}`,
      }),
    ).resolves.toEqual(converged);
    await expect(
      testEnv.DB.prepare(
        `SELECT person.display_name AS name,
                membership.last_operation_id AS membershipOperationId,
                workflow.last_operation_id AS workflowOperationId,
                workflow.revision,
                (SELECT COUNT(*) FROM audit_events audit
                  WHERE audit.event_id = workflow.event_id
                    AND audit.entity_id = workflow.person_id
                    AND audit.action = 'speaker.admin.added') AS auditCount
           FROM people person
           JOIN memberships membership
             ON membership.event_id = ? AND membership.person_id = person.id
            AND membership.role = 'speaker'
           JOIN event_speaker_workflows workflow
             ON workflow.event_id = membership.event_id
            AND workflow.person_id = membership.person_id
          WHERE person.id = ?`,
      )
        .bind(admin.eventId, personId)
        .first(),
    ).resolves.toEqual({
      name: "Concurrent winner",
      membershipOperationId,
      workflowOperationId,
      revision: 1,
      auditCount: 0,
    });
  });

  it("rolls the whole domain batch back when completion drifts at its boundary", async () => {
    const suffix = crypto.randomUUID();
    const email = `atomic-record-${suffix}@example.com`;
    const idempotencyKey = `atomic-record:${suffix}`;
    const triggerName = "test_manual_speaker_completion_drift";
    const testEnv = env as unknown as CloudflareEnvironment;
    const racingEnv = withManualSpeakerDomainBatch(
      testEnv,
      async (database, statements) => {
        await database
          .prepare(
            `CREATE TRIGGER ${triggerName}
           AFTER INSERT ON memberships
           WHEN NEW.event_id = '${admin.eventId}'
            AND NEW.role = 'speaker'
           BEGIN
             UPDATE memberships SET revoked_at = unixepoch()
              WHERE id = NEW.id;
           END`,
          )
          .run();
        return database.batch(statements);
      },
    );

    try {
      await expect(
        new SpeakerService(racingEnv).addManualSpeakerRecord(admin, {
          idempotencyKey,
          name: "Atomic record",
          email,
          jobTitle: "Director",
          organisationName: "Rollback Works",
          biography: "Tests the transactional boundary.",
        }),
      ).rejects.toThrow(/NOT NULL constraint failed: people\.email/i);
    } finally {
      await testEnv.DB.prepare(`DROP TRIGGER IF EXISTS ${triggerName}`).run();
    }

    await expect(
      testEnv.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM people
             WHERE email = ? COLLATE NOCASE) AS people,
           (SELECT COUNT(*) FROM memberships membership
             JOIN people person ON person.id = membership.person_id
            WHERE membership.event_id = ?
              AND person.email = ? COLLATE NOCASE) AS memberships,
           (SELECT COUNT(*) FROM event_speaker_workflows workflow
             JOIN people person ON person.id = workflow.person_id
            WHERE workflow.event_id = ?
              AND person.email = ? COLLATE NOCASE) AS workflows,
           (SELECT COUNT(*) FROM audit_events audit
            WHERE audit.event_id = ?
              AND audit.action = 'speaker.admin.added'
              AND json_extract(audit.metadata_json, '$.enteredEmail') = ?) AS audits,
           (SELECT COUNT(*) FROM idempotency_records command
            WHERE command.event_id = ?
              AND command.scope = 'speaker.admin.add'
              AND command.idempotency_key = ?) AS commands`,
      )
        .bind(
          email,
          admin.eventId,
          email,
          admin.eventId,
          email,
          admin.eventId,
          email,
          admin.eventId,
          idempotencyKey,
        )
        .first(),
    ).resolves.toEqual({
      people: 0,
      memberships: 0,
      workflows: 0,
      audits: 0,
      commands: 0,
    });
  });

  it("recovers a committed complete batch and replays it exactly once", async () => {
    const suffix = crypto.randomUUID();
    const email = `replay-record-${suffix}@example.com`;
    const idempotencyKey = `replay-record:${suffix}`;
    const testEnv = env as unknown as CloudflareEnvironment;
    let lostDomainBatchResponse = false;
    const responseLosingEnv = withManualSpeakerDomainBatch(
      testEnv,
      async (database, statements) => {
        await database.batch(statements);
        lostDomainBatchResponse = true;
        throw new Error(
          "The committed manual-speaker batch response was lost.",
        );
      },
    );
    const service = new SpeakerService(responseLosingEnv);
    const input = {
      idempotencyKey,
      name: "Replay record",
      email,
      jobTitle: "Producer",
      organisationName: "Replay Works",
      biography: "Tests exact recovery and replay.",
    };

    const created = await service.addManualSpeakerRecord(admin, input);
    expect(lostDomainBatchResponse).toBe(true);
    await expect(service.addManualSpeakerRecord(admin, input)).resolves.toEqual(
      created,
    );
    expect(created).toMatchObject({
      email,
      createdIdentity: true,
      createdRosterAssociation: true,
      routing: null,
    });
    await expect(
      testEnv.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM people
             WHERE email = ? COLLATE NOCASE) AS people,
           (SELECT COUNT(*) FROM memberships membership
             JOIN people person ON person.id = membership.person_id
            WHERE membership.event_id = ?
              AND membership.role = 'speaker'
              AND person.email = ? COLLATE NOCASE) AS memberships,
           (SELECT COUNT(*) FROM event_speaker_workflows workflow
             JOIN people person ON person.id = workflow.person_id
            WHERE workflow.event_id = ?
              AND person.email = ? COLLATE NOCASE) AS workflows,
           (SELECT COUNT(*) FROM audit_events audit
            WHERE audit.event_id = ?
              AND audit.action = 'speaker.admin.added'
              AND json_extract(audit.metadata_json, '$.enteredEmail') = ?) AS audits,
           (SELECT COUNT(*) FROM idempotency_records command
            WHERE command.event_id = ?
              AND command.scope = 'speaker.admin.add'
              AND command.idempotency_key = ?
              AND command.status = 'completed') AS commands`,
      )
        .bind(
          email,
          admin.eventId,
          email,
          admin.eventId,
          email,
          admin.eventId,
          email,
          admin.eventId,
          idempotencyKey,
        )
        .first(),
    ).resolves.toEqual({
      people: 1,
      memberships: 1,
      workflows: 1,
      audits: 1,
      commands: 1,
    });
  });
});
