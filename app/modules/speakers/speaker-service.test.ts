import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { ResourceService } from "~/modules/resources/resource-service.server";
import {
  getPublicSessionPage,
  getPublicSpeakerPage,
} from "~/platform/api/api-public-programme.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoProgramme } from "~/platform/demo/seed.server";
import { ensureDemoSpeakerData } from "./demo.server";
import {
  SpeakerProfileConflictError,
  SpeakerService,
} from "./speaker-service.server";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    FILES: R2Bucket;
  }
}

const speaker: Viewer = {
  personId: "person-demo-speaker",
  name: "Priya Shah",
  email: "priya.speaker@example.com",
  role: "speaker",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

const submitter: Viewer = {
  personId: "person-demo-submitter",
  name: "Alex Morgan",
  email: "alex.submitter@example.com",
  role: "submitter",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

const admin: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

async function addRosterRecord(
  service: SpeakerService,
  input: { idempotencyKey: string; name: string; email: string },
) {
  return service.addManualSpeakerRecord(admin, {
    ...input,
    idempotencyKey: `record:${input.idempotencyKey}`,
    jobTitle: "",
    organisationName: "",
    biography: "",
  });
}

async function inviteRosterRecord(
  service: SpeakerService,
  input: { idempotencyKey: string; personId: string },
) {
  return service.inviteSpeakerRecord(admin, {
    ...input,
    confirmation: "send",
  });
}

function withSuppressedStatement(
  testEnv: CloudflareEnvironment,
  pattern: RegExp,
) {
  let suppressed = 0;
  const faultingDb = new Proxy(testEnv.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          const statement = target.prepare(query);
          if (suppressed > 0 || !pattern.test(query)) return statement;
          suppressed += 1;
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty === "bind") {
                return () =>
                  target.prepare(
                    "UPDATE people SET display_name = display_name WHERE 0",
                  );
              }
              const value = Reflect.get(statementTarget, statementProperty);
              return typeof value === "function"
                ? value.bind(statementTarget)
                : value;
            },
          });
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    env: new Proxy(testEnv, {
      get(target, property) {
        return property === "DB" ? faultingDb : Reflect.get(target, property);
      },
    }),
    suppressed: () => suppressed,
  };
}

function withFirstBatchRace(
  testEnv: CloudflareEnvironment,
  race: () => Promise<void>,
) {
  let injectRace = true;
  const racingDb = new Proxy(testEnv.DB, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          if (injectRace) {
            injectRace = false;
            await race();
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(testEnv, {
    get(target, property) {
      return property === "DB" ? racingDb : Reflect.get(target, property);
    },
  });
}

function withMissingFirstBatchResults(testEnv: CloudflareEnvironment) {
  let omitResults = true;
  const incompleteDb = new Proxy(testEnv.DB, {
    get(target, property) {
      if (property === "batch") {
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(statements);
          if (!omitResults) return results;
          omitResults = false;
          return [];
        };
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(testEnv, {
    get(target, property) {
      return property === "DB" ? incompleteDb : Reflect.get(target, property);
    },
  });
}

async function insertPendingPublishedSpeaker(
  testEnv: CloudflareEnvironment,
  personId: string,
) {
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO people (
         id, email, display_name, email_verified, profile_status,
         created_at, updated_at
       ) VALUES (?, ?, 'Cursor Confirm Speaker', 1, 'published',
                 unixepoch(), unixepoch())`,
    ).bind(personId, `${personId}@example.com`),
    testEnv.DB.prepare(
      `INSERT INTO session_speakers (
         session_id, event_id, person_id, position, role_label,
         participation_status, participation_confirmed_at, visibility
       ) VALUES ('demo-session-1', ?, ?, 5000, 'Speaker',
                 'pending', NULL, 'public')`,
    ).bind(speaker.eventId, personId),
  ]);
}

async function confirmationPublicState(
  testEnv: CloudflareEnvironment,
  personId: string,
) {
  return testEnv.DB.prepare(
    `SELECT relationship.participation_status AS participationStatus,
            (SELECT public_projection_revision FROM events WHERE id = ?) AS revision,
            (SELECT COUNT(*) FROM event_changes change
              WHERE change.event_id = relationship.event_id
                AND change.entity_type = 'person'
                AND change.entity_id = relationship.person_id) AS personChangeCount
       FROM session_speakers relationship
      WHERE relationship.event_id = ? AND relationship.session_id = 'demo-session-1'
        AND relationship.person_id = ?`,
  )
    .bind(speaker.eventId, speaker.eventId, personId)
    .first<{
      participationStatus: string;
      revision: number;
      personChangeCount: number;
    }>();
}

describe("speaker profile service", () => {
  it("records speaker and administrator participation confirmation independently of portal access", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new SpeakerService(testEnv);
    const sessionId = "session-demo-speaker";
    await testEnv.DB.prepare(
      `UPDATE session_speakers
          SET participation_status = 'pending', participation_revision = 1,
              participation_confirmed_at = NULL, participation_declined_at = NULL,
              participation_decline_reason = NULL
        WHERE event_id = ? AND session_id = ? AND person_id = ?`,
    )
      .bind(speaker.eventId, sessionId, speaker.personId)
      .run();
    await expect(
      service.confirmOwnParticipation(speaker, {
        sessionId,
        participationRevision: 1,
        confirmation: "confirmed",
      }),
    ).resolves.toMatchObject({
      sessionId,
      participationStatus: "confirmed",
      changed: true,
      changeSequence: null,
    });
    await expect(
      service.confirmOwnParticipation(speaker, {
        sessionId,
        participationRevision: 1,
        confirmation: "confirmed",
      }),
    ).resolves.toMatchObject({ changed: false });
    await expect(
      testEnv.DB.prepare(
        `SELECT participation_status AS participationStatus,
                participation_confirmed_at AS participationConfirmedAt
           FROM session_speakers
          WHERE event_id = ? AND session_id = ? AND person_id = ?`,
      )
        .bind(speaker.eventId, sessionId, speaker.personId)
        .first(),
    ).resolves.toEqual({
      participationStatus: "confirmed",
      participationConfirmedAt: expect.any(Number),
    });

    await testEnv.DB.prepare(
      `UPDATE session_speakers
          SET participation_status = 'pending', participation_revision = participation_revision + 1,
              participation_confirmed_at = NULL
        WHERE event_id = ? AND session_id = ? AND person_id = ?`,
    )
      .bind(speaker.eventId, sessionId, speaker.personId)
      .run();
    await expect(
      service.confirmExternalParticipation(speaker, speaker.personId, {
        sessionId,
        participationRevision: 3,
        confirmation: "confirmed",
        externalConfirmation: "confirmed",
      }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.confirmExternalParticipation(admin, speaker.personId, {
        sessionId,
        participationRevision: 3,
        confirmation: "confirmed",
        externalConfirmation: "confirmed",
      }),
    ).resolves.toMatchObject({ changed: true });
    const audits = await testEnv.DB.prepare(
      `SELECT actor_person_id AS actorPersonId, origin,
              json_extract(metadata_json, '$.source') AS source
         FROM audit_events
        WHERE event_id = ? AND action = 'speaker.participation.confirmed'
          AND entity_id = ?
        ORDER BY created_at, id`,
    )
      .bind(speaker.eventId, `${sessionId}:${speaker.personId}`)
      .all<{ actorPersonId: string; origin: string; source: string }>();
    expect(audits.results).toHaveLength(2);
    expect(audits.results).toEqual(
      expect.arrayContaining([
        {
          actorPersonId: speaker.personId,
          origin: "participant_ui",
          source: "speaker",
        },
        {
          actorPersonId: admin.personId,
          origin: "admin_ui",
          source: "administrator_external",
        },
      ]),
    );
  });

  it("declines and resets one invitation cycle without replaying stale decisions or exposing the private reason in audit metadata", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new SpeakerService(testEnv);
    const sessionId = "session-demo-speaker";
    await testEnv.DB.prepare(
      `UPDATE session_speakers
          SET participation_status = 'pending', participation_revision = 1,
              participation_confirmed_at = NULL,
              participation_declined_at = NULL,
              participation_decline_reason = NULL
        WHERE event_id = ? AND session_id = ? AND person_id = ?`,
    )
      .bind(speaker.eventId, sessionId, speaker.personId)
      .run();

    const decline = {
      sessionId,
      participationRevision: 1,
      declineConfirmation: "declined",
      reason: "I have a private scheduling conflict.",
    };
    await expect(
      service.declineOwnParticipation(speaker, decline),
    ).resolves.toMatchObject({
      participationStatus: "declined",
      participationRevision: 2,
      changed: true,
    });
    await expect(
      service.declineOwnParticipation(speaker, decline),
    ).resolves.toMatchObject({ changed: false, participationRevision: 2 });
    await expect(
      service.declineOwnParticipation(speaker, {
        ...decline,
        reason: "A different reason must not replace the first.",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.resetDeclinedParticipation(speaker, speaker.personId, {
        sessionId,
        participationRevision: 2,
        resetConfirmation: "pending",
      }),
    ).rejects.toMatchObject({ status: 403 });

    await expect(
      service.resetDeclinedParticipation(admin, speaker.personId, {
        sessionId,
        participationRevision: 2,
        resetConfirmation: "pending",
      }),
    ).resolves.toMatchObject({
      participationStatus: "pending",
      participationRevision: 3,
      changed: true,
    });
    await expect(
      service.resetDeclinedParticipation(admin, speaker.personId, {
        sessionId,
        participationRevision: 2,
        resetConfirmation: "pending",
      }),
    ).resolves.toMatchObject({ changed: false, participationRevision: 3 });
    await expect(
      service.confirmOwnParticipation(speaker, {
        sessionId,
        participationRevision: 1,
        confirmation: "confirmed",
      }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.declineOwnParticipation(speaker, decline),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.declineOwnParticipation(speaker, {
        ...decline,
        participationRevision: 3,
      }),
    ).resolves.toMatchObject({
      participationStatus: "declined",
      participationRevision: 4,
      changed: true,
    });

    const persisted = await testEnv.DB.prepare(
      `SELECT participation_status AS participationStatus,
              participation_revision AS participationRevision,
              participation_confirmed_at AS confirmedAt,
              participation_declined_at AS declinedAt,
              participation_decline_reason AS declineReason
         FROM session_speakers
        WHERE event_id = ? AND session_id = ? AND person_id = ?`,
    )
      .bind(speaker.eventId, sessionId, speaker.personId)
      .first();
    expect(persisted).toEqual({
      participationStatus: "declined",
      participationRevision: 4,
      confirmedAt: null,
      declinedAt: expect.any(Number),
      declineReason: decline.reason,
    });
    const audits = await testEnv.DB.prepare(
      `SELECT action, metadata_json AS metadataJson
         FROM audit_events
        WHERE event_id = ? AND entity_id = ?
          AND action IN ('speaker.participation.declined', 'speaker.participation.reset')
        ORDER BY created_at, id`,
    )
      .bind(speaker.eventId, `${sessionId}:${speaker.personId}`)
      .all<{ action: string; metadataJson: string }>();
    expect(audits.results).toHaveLength(3);
    expect(
      audits.results.every(
        (audit) => !audit.metadataJson.includes(decline.reason),
      ),
    ).toBe(true);

    await service.resetDeclinedParticipation(admin, speaker.personId, {
      sessionId,
      participationRevision: 4,
      resetConfirmation: "pending",
    });
  });

  it("replays committed participation transitions after the session becomes inactive", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new SpeakerService(testEnv);
    const sessionId = "session-demo-speaker";
    const session = await testEnv.DB.prepare(
      "SELECT status FROM sessions WHERE event_id = ? AND id = ?",
    )
      .bind(speaker.eventId, sessionId)
      .first<{ status: string }>();
    if (!session) throw new Error("Demo speaker session is missing.");
    await testEnv.DB.prepare(
      `UPDATE session_speakers
          SET participation_status = 'pending', participation_revision = 1,
              participation_confirmed_at = NULL,
              participation_declined_at = NULL,
              participation_decline_reason = NULL
        WHERE event_id = ? AND session_id = ? AND person_id = ?`,
    )
      .bind(speaker.eventId, sessionId, speaker.personId)
      .run();

    const decline = {
      sessionId,
      participationRevision: 1,
      declineConfirmation: "declined" as const,
      reason: "A committed response must remain replayable.",
    };
    try {
      await service.declineOwnParticipation(speaker, decline);
      await testEnv.DB.prepare(
        "UPDATE sessions SET status = 'cancelled' WHERE event_id = ? AND id = ?",
      )
        .bind(speaker.eventId, sessionId)
        .run();
      await expect(
        service.declineOwnParticipation(speaker, decline),
      ).resolves.toMatchObject({
        participationStatus: "declined",
        participationRevision: 2,
        changed: false,
      });

      await testEnv.DB.prepare(
        "UPDATE sessions SET status = ? WHERE event_id = ? AND id = ?",
      )
        .bind(session.status, speaker.eventId, sessionId)
        .run();
      const reset = {
        sessionId,
        participationRevision: 2,
        resetConfirmation: "pending" as const,
      };
      await service.resetDeclinedParticipation(admin, speaker.personId, reset);
      await testEnv.DB.prepare(
        "UPDATE sessions SET status = 'archived' WHERE event_id = ? AND id = ?",
      )
        .bind(speaker.eventId, sessionId)
        .run();
      await expect(
        service.resetDeclinedParticipation(admin, speaker.personId, reset),
      ).resolves.toMatchObject({
        participationStatus: "pending",
        participationRevision: 3,
        changed: false,
      });
      await expect(
        service.declineOwnParticipation(speaker, {
          ...decline,
          participationRevision: 3,
        }),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      await testEnv.DB.prepare(
        "UPDATE sessions SET status = ? WHERE event_id = ? AND id = ?",
      )
        .bind(session.status, speaker.eventId, sessionId)
        .run();
    }
  });

  it("revalidates Airtable participation replays against the current invitation cycle", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const sessionId = "session-demo-speaker";
    await testEnv.DB.prepare(
      `UPDATE session_speakers
          SET participation_status = 'pending', participation_revision = 1,
              participation_confirmed_at = NULL,
              participation_declined_at = NULL,
              participation_decline_reason = NULL
        WHERE event_id = ? AND session_id = ? AND person_id = ?`,
    )
      .bind(speaker.eventId, sessionId, speaker.personId)
      .run();
    const decline = {
      sessionId,
      participationRevision: 1,
      declineConfirmation: "declined" as const,
      reason: "This exact replay must be checked against D1.",
    };
    const committed = await new SpeakerService(testEnv).declineOwnParticipation(
      speaker,
      decline,
    );
    const replayBoundary = {
      executeIdempotent: async () => committed,
    } as unknown as AirtableProviderBoundary;
    const replayService = new SpeakerService(testEnv, {
      airtable: replayBoundary,
    });

    await expect(
      replayService.declineOwnParticipation(speaker, decline),
    ).resolves.toMatchObject({
      changed: false,
      participationStatus: "declined",
      participationRevision: 2,
    });

    await new SpeakerService(testEnv).resetDeclinedParticipation(
      admin,
      speaker.personId,
      {
        sessionId,
        participationRevision: 2,
        resetConfirmation: "pending",
      },
    );
    await expect(
      replayService.declineOwnParticipation(speaker, decline),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("converges concurrent exact participation retries without duplicating transitions", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new SpeakerService(testEnv);
    const sessionId = "session-demo-speaker";
    await testEnv.DB.prepare(
      `UPDATE session_speakers
          SET participation_status = 'pending', participation_revision = 1,
              participation_confirmed_at = NULL,
              participation_declined_at = NULL,
              participation_decline_reason = NULL
        WHERE event_id = ? AND session_id = ? AND person_id = ?`,
    )
      .bind(speaker.eventId, sessionId, speaker.personId)
      .run();
    const transitionCounts = async () => {
      const rows = await testEnv.DB.prepare(
        `SELECT action, COUNT(*) AS count
           FROM audit_events
          WHERE event_id = ? AND entity_id = ?
            AND action IN (
              'speaker.participation.confirmed',
              'speaker.participation.declined',
              'speaker.participation.reset'
            )
          GROUP BY action`,
      )
        .bind(speaker.eventId, `${sessionId}:${speaker.personId}`)
        .all<{ action: string; count: number }>();
      return Object.fromEntries(
        rows.results.map(({ action, count }) => [action, count]),
      );
    };
    const before = await transitionCounts();

    const confirmation = {
      sessionId,
      participationRevision: 1,
      confirmation: "confirmed" as const,
    };
    await expect(
      new SpeakerService(
        withFirstBatchRace(testEnv, () =>
          service.confirmOwnParticipation(speaker, confirmation).then(() => {}),
        ),
      ).confirmOwnParticipation(speaker, confirmation),
    ).resolves.toMatchObject({ changed: false, participationRevision: 2 });

    await testEnv.DB.prepare(
      `UPDATE session_speakers
          SET participation_status = 'pending', participation_revision = 3,
              participation_confirmed_at = NULL,
              participation_declined_at = NULL,
              participation_decline_reason = NULL
        WHERE event_id = ? AND session_id = ? AND person_id = ?`,
    )
      .bind(speaker.eventId, sessionId, speaker.personId)
      .run();
    const decline = {
      sessionId,
      participationRevision: 3,
      declineConfirmation: "declined" as const,
      reason: "The same private reason must converge.",
    };
    await expect(
      new SpeakerService(
        withFirstBatchRace(testEnv, () =>
          service.declineOwnParticipation(speaker, decline).then(() => {}),
        ),
      ).declineOwnParticipation(speaker, decline),
    ).resolves.toMatchObject({ changed: false, participationRevision: 4 });

    const reset = {
      sessionId,
      participationRevision: 4,
      resetConfirmation: "pending" as const,
    };
    await expect(
      new SpeakerService(
        withFirstBatchRace(testEnv, () =>
          service
            .resetDeclinedParticipation(admin, speaker.personId, reset)
            .then(() => {}),
        ),
      ).resetDeclinedParticipation(admin, speaker.personId, reset),
    ).resolves.toMatchObject({ changed: false, participationRevision: 5 });

    const after = await transitionCounts();
    expect(after["speaker.participation.confirmed"] ?? 0).toBe(
      (before["speaker.participation.confirmed"] ?? 0) + 1,
    );
    expect(after["speaker.participation.declined"] ?? 0).toBe(
      (before["speaker.participation.declined"] ?? 0) + 1,
    );
    expect(after["speaker.participation.reset"] ?? 0).toBe(
      (before["speaker.participation.reset"] ?? 0) + 1,
    );
  });

  it("fails explicitly when D1 omits decline or reset mutation results", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const sessionId = "session-demo-speaker";
    await testEnv.DB.prepare(
      `UPDATE session_speakers
          SET participation_status = 'pending', participation_revision = 20,
              participation_confirmed_at = NULL,
              participation_declined_at = NULL,
              participation_decline_reason = NULL
        WHERE event_id = ? AND session_id = ? AND person_id = ?`,
    )
      .bind(speaker.eventId, sessionId, speaker.personId)
      .run();

    await expect(
      new SpeakerService(
        withMissingFirstBatchResults(testEnv),
      ).declineOwnParticipation(speaker, {
        sessionId,
        participationRevision: 20,
        declineConfirmation: "declined",
        reason: "A private reason.",
      }),
    ).rejects.toMatchObject({
      name: "SpeakerAdminIntegrityError",
      status: 500,
      message: "Participation decline is missing its audit result.",
    });
    await expect(
      testEnv.DB.prepare(
        `SELECT participation_status AS status, participation_revision AS revision
           FROM session_speakers
          WHERE event_id = ? AND session_id = ? AND person_id = ?`,
      )
        .bind(speaker.eventId, sessionId, speaker.personId)
        .first(),
    ).resolves.toEqual({ status: "declined", revision: 21 });

    await expect(
      new SpeakerService(
        withMissingFirstBatchResults(testEnv),
      ).resetDeclinedParticipation(admin, speaker.personId, {
        sessionId,
        participationRevision: 21,
        resetConfirmation: "pending",
      }),
    ).rejects.toMatchObject({
      name: "SpeakerAdminIntegrityError",
      status: 500,
      message: "Participation reset is missing its audit result.",
    });
    await expect(
      testEnv.DB.prepare(
        `SELECT participation_status AS status, participation_revision AS revision
           FROM session_speakers
          WHERE event_id = ? AND session_id = ? AND person_id = ?`,
      )
        .bind(speaker.eventId, sessionId, speaker.personId)
        .first(),
    ).resolves.toEqual({ status: "pending", revision: 22 });

    await testEnv.DB.prepare(
      `UPDATE session_speakers
          SET participation_revision = 1
        WHERE event_id = ? AND session_id = ? AND person_id = ?`,
    )
      .bind(speaker.eventId, sessionId, speaker.personId)
      .run();
  });

  it("materialises confirmed-speaker acknowledgement tasks on confirmation", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const sessionId = "session-demo-speaker";
    await testEnv.DB.prepare(
      `UPDATE session_speakers
          SET participation_status = 'pending', participation_revision = 1,
              participation_confirmed_at = NULL, participation_declined_at = NULL,
              participation_decline_reason = NULL
        WHERE event_id = ? AND session_id = ? AND person_id = ?`,
    )
      .bind(speaker.eventId, sessionId, speaker.personId)
      .run();
    const resources = new ResourceService(testEnv);
    const pageId = await resources.save(admin, {
      title: "Confirmation briefing",
      slug: `confirm-ack-${crypto.randomUUID().slice(0, 8)}`,
      category: "Preparation",
      audienceScope: "confirmed_speakers",
      acknowledgementRequired: true,
      document: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Read me." }] },
        ],
      },
    });
    const draft = (await resources.getAdminWorkspace(admin, pageId)).selected!;
    await resources.publish(admin, pageId, draft.revision);
    const taskId = `resource-ack:${pageId}:${speaker.personId}`;
    await expect(
      testEnv.DB.prepare("SELECT id FROM task_instances WHERE id = ?")
        .bind(taskId)
        .first(),
    ).resolves.toBeNull();

    await new SpeakerService(testEnv).confirmOwnParticipation(speaker, {
      sessionId,
      participationRevision: 1,
      confirmation: "confirmed",
    });
    await expect(
      testEnv.DB.prepare("SELECT status FROM task_instances WHERE id = ?")
        .bind(taskId)
        .first(),
    ).resolves.toEqual({ status: "not_started" });
  });

  it("materialises only the confirming person's confirmed-speaker acknowledgements and preserves explicit waivers", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const sessionId = "session-demo-speaker";
    const otherPersonId = `confirmation-other-${crypto.randomUUID()}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `UPDATE session_speakers
            SET participation_status = 'pending', participation_revision = 1,
                participation_confirmed_at = NULL, participation_declined_at = NULL,
                participation_decline_reason = NULL
          WHERE event_id = ? AND session_id = ? AND person_id = ?`,
      ).bind(speaker.eventId, sessionId, speaker.personId),
      testEnv.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, email_verified, profile_status,
           created_at, updated_at
         ) VALUES (?, ?, 'Other Session Speaker', 1, 'published',
                   unixepoch(), unixepoch())`,
      ).bind(otherPersonId, `${otherPersonId}@example.com`),
      testEnv.DB.prepare(
        `INSERT INTO session_speakers (
           session_id, event_id, person_id, position, role_label,
           participation_status, participation_confirmed_at, visibility
         ) VALUES (?, ?, ?, 9000, 'Speaker', 'pending', NULL, 'public')`,
      ).bind(sessionId, speaker.eventId, otherPersonId),
    ]);

    const resources = new ResourceService(testEnv);
    const publishResource = async (
      label: string,
      audienceScope: "accepted_speakers" | "confirmed_speakers",
    ) => {
      const pageId = await resources.save(admin, {
        title: label,
        slug: `${label.toLowerCase().replaceAll(" ", "-")}-${crypto.randomUUID().slice(0, 8)}`,
        category: "Preparation",
        audienceScope,
        acknowledgementRequired: true,
        document: {
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Read this briefing." }],
            },
          ],
        },
      });
      const draft = (await resources.getAdminWorkspace(admin, pageId))
        .selected!;
      await resources.publish(admin, pageId, draft.revision);
      return pageId;
    };
    const acceptedPageId = await publishResource(
      "Accepted confirmation boundary",
      "accepted_speakers",
    );
    const newConfirmedPageId = await publishResource(
      "New confirmed acknowledgement",
      "confirmed_speakers",
    );
    const waivedConfirmedPageId = await publishResource(
      "Waived confirmed acknowledgement",
      "confirmed_speakers",
    );
    const acceptedSpeakerTaskId = `resource-ack:${acceptedPageId}:${speaker.personId}`;
    const acceptedOtherTaskId = `resource-ack:${acceptedPageId}:${otherPersonId}`;
    const waivedConfirmedTaskId = `resource-ack:${waivedConfirmedPageId}:${speaker.personId}`;
    const explicitWaiver = JSON.stringify({
      reason: "Administrator explicitly waived this requirement",
      by: admin.personId,
    });
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `UPDATE task_instances
            SET status = 'waived', readiness_percent = 100,
                waiver_json = ?, completed_at = unixepoch(),
                completed_by_person_id = ?, revision = revision + 1
          WHERE id IN (?, ?) AND event_id = ?`,
      ).bind(
        explicitWaiver,
        admin.personId,
        acceptedSpeakerTaskId,
        acceptedOtherTaskId,
        speaker.eventId,
      ),
      testEnv.DB.prepare(
        `INSERT INTO task_instances (
           id, event_id, template_id, target_type, target_id, owner_person_id,
           title, description, task_type, impact, status, readiness_state,
           readiness_percent, revision, waiver_json, completed_at,
           completed_by_person_id, created_at, updated_at
         ) VALUES (?, ?, ?, 'speaker', ?, ?, 'Read waived briefing',
                   'Read and acknowledge the current published version.',
                   'acknowledgement', 'medium', 'waived', 'on_track', 100, 1,
                   ?, unixepoch(), ?, unixepoch(), unixepoch())`,
      ).bind(
        waivedConfirmedTaskId,
        speaker.eventId,
        `resource-ack:${waivedConfirmedPageId}`,
        speaker.personId,
        speaker.personId,
        explicitWaiver,
        admin.personId,
      ),
    ]);
    const preservedTaskIds = [
      acceptedSpeakerTaskId,
      acceptedOtherTaskId,
      waivedConfirmedTaskId,
    ];
    const preservedState = () =>
      Promise.all(
        preservedTaskIds.map((taskId) =>
          testEnv.DB.prepare(
            `SELECT status, revision, waiver_json AS waiverJson
               FROM task_instances WHERE id = ?`,
          )
            .bind(taskId)
            .first(),
        ),
      );
    const before = await preservedState();
    expect(before).toEqual([
      { status: "waived", revision: 2, waiverJson: explicitWaiver },
      { status: "waived", revision: 2, waiverJson: explicitWaiver },
      { status: "waived", revision: 1, waiverJson: explicitWaiver },
    ]);

    const service = new SpeakerService(testEnv);
    await expect(
      service.confirmOwnParticipation(speaker, {
        sessionId,
        participationRevision: 1,
        confirmation: "confirmed",
      }),
    ).resolves.toMatchObject({ changed: true });

    await expect(preservedState()).resolves.toEqual(before);
    await expect(
      testEnv.DB.prepare(
        "SELECT status, revision FROM task_instances WHERE id = ?",
      )
        .bind(`resource-ack:${newConfirmedPageId}:${speaker.personId}`)
        .first(),
    ).resolves.toEqual({ status: "not_started", revision: 1 });
    for (const pageId of [newConfirmedPageId, waivedConfirmedPageId]) {
      await expect(
        testEnv.DB.prepare("SELECT id FROM task_instances WHERE id = ?")
          .bind(`resource-ack:${pageId}:${otherPersonId}`)
          .first(),
      ).resolves.toBeNull();
    }

    const afterConfirmation = await preservedState();
    await expect(
      service.confirmOwnParticipation(speaker, {
        sessionId,
        participationRevision: 1,
        confirmation: "confirmed",
      }),
    ).resolves.toMatchObject({ changed: false });
    await expect(preservedState()).resolves.toEqual(afterConfirmation);
  });

  it("does not materialise acknowledgements from a losing concurrent confirmation", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const sessionId = "session-demo-speaker";
    await testEnv.DB.prepare(
      `UPDATE session_speakers
          SET participation_status = 'pending', participation_revision = 101,
              participation_confirmed_at = NULL, participation_declined_at = NULL,
              participation_decline_reason = NULL
        WHERE event_id = ? AND session_id = ? AND person_id = ?`,
    )
      .bind(speaker.eventId, sessionId, speaker.personId)
      .run();
    const resources = new ResourceService(testEnv);
    const pageId = await resources.save(admin, {
      title: "Concurrent confirmation waiver",
      slug: `concurrent-confirm-waiver-${crypto.randomUUID().slice(0, 8)}`,
      category: "Preparation",
      audienceScope: "confirmed_speakers",
      acknowledgementRequired: true,
      document: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Read me." }] },
        ],
      },
    });
    const draft = (await resources.getAdminWorkspace(admin, pageId)).selected!;
    await resources.publish(admin, pageId, draft.revision);
    const taskId = `resource-ack:${pageId}:${speaker.personId}`;
    const explicitWaiver = JSON.stringify({
      reason: "Explicit concurrent waiver",
      by: admin.personId,
    });
    await testEnv.DB.prepare(
      `INSERT INTO task_instances (
         id, event_id, template_id, target_type, target_id, owner_person_id,
         title, description, task_type, impact, status, readiness_state,
         readiness_percent, revision, waiver_json, completed_at,
         completed_by_person_id, created_at, updated_at
       ) VALUES (?, ?, ?, 'speaker', ?, ?, 'Read concurrent briefing',
                 'Read and acknowledge the current published version.',
                 'acknowledgement', 'medium', 'waived', 'on_track', 100, 4,
                 ?, unixepoch(), ?, unixepoch(), unixepoch())`,
    )
      .bind(
        taskId,
        speaker.eventId,
        `resource-ack:${pageId}`,
        speaker.personId,
        speaker.personId,
        explicitWaiver,
        admin.personId,
      )
      .run();
    const before = await testEnv.DB.prepare(
      `SELECT status, revision, waiver_json AS waiverJson
         FROM task_instances WHERE id = ?`,
    )
      .bind(taskId)
      .first();
    const racingEnv = withFirstBatchRace(testEnv, async () => {
      await testEnv.DB.prepare(
        `UPDATE session_speakers
            SET participation_status = 'confirmed',
                participation_revision = participation_revision + 1,
                participation_confirmed_at = unixepoch()
          WHERE event_id = ? AND session_id = ? AND person_id = ?
            AND participation_status = 'pending'`,
      )
        .bind(speaker.eventId, sessionId, speaker.personId)
        .run();
    });

    await expect(
      new SpeakerService(racingEnv).confirmOwnParticipation(speaker, {
        sessionId,
        participationRevision: 101,
        confirmation: "confirmed",
      }),
    ).rejects.toThrow(/changed while confirmation/i);
    await expect(
      testEnv.DB.prepare(
        `SELECT status, revision, waiver_json AS waiverJson
           FROM task_instances WHERE id = ?`,
      )
        .bind(taskId)
        .first(),
    ).resolves.toEqual(before);
  });

  it("does not materialise acknowledgements from a losing concurrent reset", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const sessionId = "session-demo-speaker";
    await testEnv.DB.prepare(
      `UPDATE session_speakers
          SET participation_status = 'declined', participation_revision = 201,
              participation_confirmed_at = NULL,
              participation_declined_at = unixepoch(),
              participation_decline_reason = NULL
        WHERE event_id = ? AND session_id = ? AND person_id = ?`,
    )
      .bind(speaker.eventId, sessionId, speaker.personId)
      .run();
    const resources = new ResourceService(testEnv);
    const pageId = await resources.save(admin, {
      title: "Concurrent reset acknowledgement",
      slug: `concurrent-reset-ack-${crypto.randomUUID().slice(0, 8)}`,
      category: "Preparation",
      audienceScope: "all_speakers",
      acknowledgementRequired: true,
      document: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Read me." }] },
        ],
      },
    });
    const draft = (await resources.getAdminWorkspace(admin, pageId)).selected!;
    await resources.publish(admin, pageId, draft.revision);
    const taskId = `resource-ack:${pageId}:${speaker.personId}`;
    await testEnv.DB.prepare("DELETE FROM task_instances WHERE id = ?")
      .bind(taskId)
      .run();

    const racingEnv = withFirstBatchRace(testEnv, async () => {
      await testEnv.DB.prepare(
        `UPDATE sessions SET status = 'archived', revision = revision + 1
          WHERE id = ? AND event_id = ?`,
      )
        .bind(sessionId, speaker.eventId)
        .run();
    });
    await expect(
      new SpeakerService(racingEnv).resetDeclinedParticipation(
        admin,
        speaker.personId,
        {
          sessionId,
          participationRevision: 201,
          resetConfirmation: "pending",
        },
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      testEnv.DB.prepare("SELECT id FROM task_instances WHERE id = ?")
        .bind(taskId)
        .first(),
    ).resolves.toBeNull();
    await expect(
      testEnv.DB.prepare(
        `SELECT participation_status AS status,
                participation_revision AS revision
           FROM session_speakers
          WHERE event_id = ? AND session_id = ? AND person_id = ?`,
      )
        .bind(speaker.eventId, sessionId, speaker.personId)
        .first(),
    ).resolves.toEqual({ status: "declined", revision: 201 });
    await testEnv.DB.prepare(
      `UPDATE sessions SET status = 'scheduled', revision = revision + 1
        WHERE id = ? AND event_id = ?`,
    )
      .bind(sessionId, speaker.eventId)
      .run();
  });

  it("does not rematerialise confirmed-speaker tasks after eligibility was already established", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const sessionId = "session-demo-speaker";
    const existingConfirmedSessionId = `already-confirmed-${crypto.randomUUID()}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `UPDATE session_speakers
            SET participation_status = 'pending', participation_revision = 1,
                participation_confirmed_at = NULL, participation_declined_at = NULL,
                participation_decline_reason = NULL
          WHERE event_id = ? AND session_id = ? AND person_id = ?`,
      ).bind(speaker.eventId, sessionId, speaker.personId),
      testEnv.DB.prepare(
        `INSERT INTO sessions (
           id, event_id, title, slug, format, duration_minutes,
           status, visibility, created_at, updated_at
         ) VALUES (?, ?, 'Already confirmed session', ?, 'presentation', 45,
                   'scheduled', 'public', unixepoch(), unixepoch())`,
      ).bind(
        existingConfirmedSessionId,
        speaker.eventId,
        existingConfirmedSessionId,
      ),
      testEnv.DB.prepare(
        `INSERT INTO session_speakers (
           session_id, event_id, person_id, position, role_label,
           participation_status, participation_confirmed_at, visibility
         ) VALUES (?, ?, ?, 0, 'Speaker', 'confirmed', unixepoch(), 'public')`,
      ).bind(existingConfirmedSessionId, speaker.eventId, speaker.personId),
    ]);
    const resources = new ResourceService(testEnv);
    const pageId = await resources.save(admin, {
      title: "Established confirmation briefing",
      slug: `established-confirmation-${crypto.randomUUID().slice(0, 8)}`,
      category: "Preparation",
      audienceScope: "confirmed_speakers",
      acknowledgementRequired: true,
      document: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Read me." }] },
        ],
      },
    });
    const draft = (await resources.getAdminWorkspace(admin, pageId)).selected!;
    await resources.publish(admin, pageId, draft.revision);
    const taskId = `resource-ack:${pageId}:${speaker.personId}`;
    await expect(
      testEnv.DB.prepare("SELECT id FROM task_instances WHERE id = ?")
        .bind(taskId)
        .first(),
    ).resolves.toEqual({ id: taskId });
    await testEnv.DB.prepare("DELETE FROM task_instances WHERE id = ?")
      .bind(taskId)
      .run();

    await expect(
      new SpeakerService(testEnv).confirmOwnParticipation(speaker, {
        sessionId,
        participationRevision: 1,
        confirmation: "confirmed",
      }),
    ).resolves.toMatchObject({ changed: true });
    await expect(
      testEnv.DB.prepare("SELECT id FROM task_instances WHERE id = ?")
        .bind(taskId)
        .first(),
    ).resolves.toBeNull();
  });

  it("invalidates public session and speaker cursors when confirmation joins the published programme", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoProgramme(testEnv);
    const personId = `confirm-cursor-speaker-${crypto.randomUUID()}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, email_verified, profile_status,
           created_at, updated_at
         ) VALUES (?, ?, 'Cursor Confirm Speaker', 1, 'published',
                   unixepoch(), unixepoch())`,
      ).bind(personId, `${personId}@example.com`),
      testEnv.DB.prepare(
        `INSERT INTO session_speakers (
           session_id, event_id, person_id, position, role_label,
           participation_status, participation_confirmed_at, visibility
         ) VALUES ('demo-session-1', ?, ?, 5000, 'Speaker',
                   'pending', NULL, 'public')`,
      ).bind(speaker.eventId, personId),
    ]);

    try {
      const speakerPage = await getPublicSpeakerPage(
        testEnv,
        "future-of-events-2027",
        {
          limit: 1,
        },
      );
      const sessionPage = await getPublicSessionPage(
        testEnv,
        "future-of-events-2027",
        {
          limit: 1,
        },
      );
      expect(speakerPage.body.nextCursor).toEqual(expect.any(String));
      expect(sessionPage.body.nextCursor).toEqual(expect.any(String));
      const before = await testEnv.DB.prepare(
        `SELECT public_projection_revision AS revision
         FROM events WHERE id = ?`,
      )
        .bind(speaker.eventId)
        .first<{ revision: number }>();

      await expect(
        new SpeakerService(testEnv).confirmExternalParticipation(
          admin,
          personId,
          {
            sessionId: "demo-session-1",
            participationRevision: 1,
            confirmation: "confirmed",
            externalConfirmation: "confirmed",
          },
        ),
      ).resolves.toMatchObject({
        changed: true,
        changeSequence: expect.any(Number),
      });

      const after = await testEnv.DB.prepare(
        `SELECT public_projection_revision AS revision
         FROM events WHERE id = ?`,
      )
        .bind(speaker.eventId)
        .first<{ revision: number }>();
      expect(after!.revision).toBeGreaterThan(before!.revision);
      await expect(
        testEnv.DB.prepare(
          `SELECT entity_type AS entityType, change_type AS changeType
           FROM event_changes
          WHERE event_id = ? AND entity_type = 'person' AND entity_id = ?
          ORDER BY sequence DESC LIMIT 1`,
        )
          .bind(speaker.eventId, personId)
          .first(),
      ).resolves.toEqual({ entityType: "person", changeType: "updated" });

      await expect(
        getPublicSpeakerPage(testEnv, "future-of-events-2027", {
          limit: 1,
          cursor: speakerPage.body.nextCursor!,
        }),
      ).rejects.toMatchObject({ status: 409, code: "PUBLICATION_CHANGED" });
      await expect(
        getPublicSessionPage(testEnv, "future-of-events-2027", {
          limit: 1,
          cursor: sessionPage.body.nextCursor!,
        }),
      ).rejects.toMatchObject({ status: 409, code: "PUBLICATION_CHANGED" });
    } finally {
      await testEnv.DB.batch([
        testEnv.DB.prepare(
          `DELETE FROM task_instances
            WHERE event_id = ? AND (target_id = ? OR owner_person_id = ?)`,
        ).bind(speaker.eventId, personId, personId),
        testEnv.DB.prepare(
          `DELETE FROM session_speakers
            WHERE event_id = ? AND person_id = ?`,
        ).bind(speaker.eventId, personId),
        testEnv.DB.prepare("DELETE FROM people WHERE id = ?").bind(personId),
      ]);
    }
  });

  it.each([
    [
      "audit insertion",
      /INSERT INTO audit_events[\s\S]*'speaker\.participation\.confirmed'/u,
    ],
    [
      "public event-change insertion",
      /INSERT INTO event_changes[\s\S]*'person'/u,
    ],
  ])(
    "rolls back public confirmation when its %s is suppressed",
    async (_label, pattern) => {
      const testEnv = env as unknown as CloudflareEnvironment;
      await ensureDemoProgramme(testEnv);
      const personId = `confirm-atomic-${crypto.randomUUID()}`;
      await insertPendingPublishedSpeaker(testEnv, personId);
      const before = await confirmationPublicState(testEnv, personId);
      expect(before).toMatchObject({
        participationStatus: "pending",
        personChangeCount: 0,
      });
      const fault = withSuppressedStatement(testEnv, pattern);

      try {
        await expect(
          new SpeakerService(fault.env).confirmExternalParticipation(
            admin,
            personId,
            {
              sessionId: "demo-session-1",
              participationRevision: 1,
              confirmation: "confirmed",
              externalConfirmation: "confirmed",
            },
          ),
        ).rejects.toThrow(
          /audit record and public change|changed while confirmation was being recorded/i,
        );
        expect(fault.suppressed()).toBe(1);
        await expect(
          confirmationPublicState(testEnv, personId),
        ).resolves.toEqual(before);
      } finally {
        await testEnv.DB.batch([
          testEnv.DB.prepare(
            `DELETE FROM task_instances
              WHERE event_id = ? AND (target_id = ? OR owner_person_id = ?)`,
          ).bind(speaker.eventId, personId, personId),
          testEnv.DB.prepare(
            `DELETE FROM session_speakers
              WHERE event_id = ? AND person_id = ?`,
          ).bind(speaker.eventId, personId),
          testEnv.DB.prepare("DELETE FROM people WHERE id = ?").bind(personId),
        ]);
      }
    },
  );

  it("refuses participation confirmation after a session is cancelled", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const sessionId = "session-demo-speaker";
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `UPDATE session_speakers
            SET participation_status = 'pending', participation_revision = 1,
                participation_confirmed_at = NULL, participation_declined_at = NULL,
                participation_decline_reason = NULL
          WHERE event_id = ? AND session_id = ? AND person_id = ?`,
      ).bind(speaker.eventId, sessionId, speaker.personId),
      testEnv.DB.prepare(
        `UPDATE sessions SET status = 'cancelled'
          WHERE event_id = ? AND id = ?`,
      ).bind(speaker.eventId, sessionId),
    ]);

    try {
      await expect(
        new SpeakerService(testEnv).confirmOwnParticipation(speaker, {
          sessionId,
          participationRevision: 1,
          confirmation: "confirmed",
        }),
      ).rejects.toMatchObject({ status: 404 });
    } finally {
      await testEnv.DB.prepare(
        `UPDATE sessions SET status = 'scheduled'
          WHERE event_id = ? AND id = ?`,
      )
        .bind(speaker.eventId, sessionId)
        .run();
    }
  });

  it("persists and replays one durable invitation delivery operation", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const suffix = crypto.randomUUID();
    const email = `durable-invitation-${suffix}@programcue.dev`;
    const queued: unknown[] = [];
    await testEnv.DB.prepare(
      `INSERT INTO sender_profiles (
         id, event_id, name, from_name, from_email, reply_to_email,
         provider, status, created_at, updated_at
       ) VALUES (?, ?, ?, 'Program Cue', 'speakers@example.com',
                 'speakers@example.com', 'resend', 'verified',
                 unixepoch(), unixepoch())`,
    )
      .bind(
        `durable-speaker-sender-${suffix}`,
        admin.eventId,
        `Durable speaker sender ${suffix}`,
      )
      .run();
    const productionEnv = {
      ...testEnv,
      APP_ENV: "production",
      DEMO_MODE: "false",
      BETTER_AUTH_URL: "https://programcue.test",
      BETTER_AUTH_SECRET: "a".repeat(32),
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "test-provider-key",
      OPERATIONS_QUEUE: {
        send: async (message: unknown) => queued.push(message),
      },
    } as unknown as CloudflareEnvironment;
    const input = {
      idempotencyKey: `durable-invitation:${suffix}`,
      name: "Durable Invitee",
      email,
    };
    const service = new SpeakerService(productionEnv);

    const record = await addRosterRecord(service, input);
    const created = await inviteRosterRecord(service, {
      idempotencyKey: input.idempotencyKey,
      personId: record.personId,
    });
    expect(created.delivery).toBe("queued");
    expect(queued).toHaveLength(1);
    await expect(
      testEnv.DB.prepare(
        `SELECT workflow.status, workflow.source,
                workflow.updated_by_person_id AS updatedByPersonId
           FROM event_speaker_workflows workflow
          WHERE workflow.event_id = ? AND workflow.person_id = ?`,
      )
        .bind(admin.eventId, created.personId)
        .first(),
    ).resolves.toEqual({
      status: "invited",
      source: "manual",
      updatedByPersonId: admin.personId,
    });
    await expect(
      inviteRosterRecord(service, {
        idempotencyKey: input.idempotencyKey,
        personId: record.personId,
      }),
    ).resolves.toEqual(created);
    expect(queued).toHaveLength(1);
    await testEnv.DB.prepare(
      `UPDATE memberships SET accepted_at = unixepoch()
        WHERE id = ? AND event_id = ?`,
    )
      .bind(created.membershipId, admin.eventId)
      .run();
    await expect(
      inviteRosterRecord(service, {
        idempotencyKey: input.idempotencyKey,
        personId: record.personId,
      }),
    ).resolves.toEqual({
      ...created,
      accepted: true,
      delivery: "not_required",
    });
    expect(queued).toHaveLength(1);
    await expect(
      testEnv.DB.prepare(
        `SELECT operation.status, operation.dispatched_at IS NOT NULL AS dispatched,
                communication.status AS communicationStatus,
                delivery.status AS deliveryStatus
           FROM operation_jobs operation
           JOIN communications communication
             ON communication.operation_id = operation.id
           JOIN communication_deliveries delivery
             ON delivery.communication_id = communication.id
          WHERE operation.event_id = ?
            AND json_extract(communication.audience_json, '$.email') = ?`,
      )
        .bind(admin.eventId, email)
        .first(),
    ).resolves.toEqual({
      status: "queued",
      dispatched: 1,
      communicationStatus: "queued",
      deliveryStatus: "queued",
    });
  });

  it("records a successful dispatch after a fast Queue consumer advances the job", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const suffix = crypto.randomUUID();
    const email = `fast-consumer-${suffix}@programcue.dev`;
    await testEnv.DB.prepare(
      `INSERT INTO sender_profiles (
         id, event_id, name, from_name, from_email, reply_to_email,
         provider, status, created_at, updated_at
       ) VALUES (?, ?, ?, 'Program Cue', 'speakers@example.com',
                 'speakers@example.com', 'resend', 'verified',
                 unixepoch(), unixepoch())`,
    )
      .bind(
        `fast-consumer-sender-${suffix}`,
        admin.eventId,
        `Fast consumer sender ${suffix}`,
      )
      .run();
    const productionEnv = {
      ...testEnv,
      APP_ENV: "production",
      DEMO_MODE: "false",
      BETTER_AUTH_URL: "https://programcue.test",
      BETTER_AUTH_SECRET: "a".repeat(32),
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "test-provider-key",
      OPERATIONS_QUEUE: {
        send: async (message: unknown) => {
          const operationId = (message as { operationId: string }).operationId;
          await testEnv.DB.prepare(
            `UPDATE operation_jobs SET status = 'running'
              WHERE id = ? AND event_id = ? AND status = 'queued'`,
          )
            .bind(operationId, admin.eventId)
            .run();
        },
      },
    } as unknown as CloudflareEnvironment;

    const service = new SpeakerService(productionEnv);
    const input = {
      idempotencyKey: `fast-consumer:${suffix}`,
      name: "Fast Queue Consumer",
      email,
    };
    const record = await addRosterRecord(service, input);
    const created = await inviteRosterRecord(service, {
      idempotencyKey: input.idempotencyKey,
      personId: record.personId,
    });

    expect(created.delivery).toBe("queued");
    await expect(
      testEnv.DB.prepare(
        `SELECT operation.status,
                operation.dispatched_at IS NOT NULL AS dispatched
           FROM operation_jobs operation
           JOIN communications communication
             ON communication.operation_id = operation.id
            AND communication.event_id = operation.event_id
          WHERE operation.event_id = ?
            AND json_extract(communication.audience_json, '$.email') = ?`,
      )
        .bind(admin.eventId, email)
        .first(),
    ).resolves.toEqual({ status: "running", dispatched: 1 });
  });

  it("fails before saving an invitation when durable delivery is unavailable", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const email = `missing-queue-${crypto.randomUUID()}@programcue.dev`;
    const productionWithoutQueue = {
      ...testEnv,
      APP_ENV: "production",
      DEMO_MODE: "false",
      OPERATIONS_QUEUE: undefined,
    } as unknown as CloudflareEnvironment;

    const service = new SpeakerService(productionWithoutQueue);
    const input = {
      idempotencyKey: `missing-queue:${crypto.randomUUID()}`,
      name: "Missing Queue",
      email,
    };
    const record = await addRosterRecord(service, input);
    await expect(
      inviteRosterRecord(service, {
        idempotencyKey: input.idempotencyKey,
        personId: record.personId,
      }),
    ).rejects.toThrow(/OPERATIONS_QUEUE.*no speaker invitation was saved/i);
    await expect(
      testEnv.DB.prepare(
        `SELECT invited_at AS invitedAt, invitation_expires_at AS expiresAt
           FROM memberships WHERE event_id = ? AND person_id = ?`,
      )
        .bind(admin.eventId, record.personId)
        .first(),
    ).resolves.toEqual({ invitedAt: null, expiresAt: null });
  });

  it("reactivates the existing event membership when an administrator re-adds a revoked speaker", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const suffix = crypto.randomUUID();
    const personId = `manual-reactivate-person-${suffix}`;
    const membershipId = `manual-reactivate-membership-${suffix}`;
    const email = `manual-reactivate-${suffix}@example.com`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO people (id, email, display_name, email_verified, profile_status)
         VALUES (?, ?, 'Revoked Speaker', 1, 'draft')`,
      ).bind(personId, email),
      testEnv.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role,
           invited_at, accepted_at, revoked_at
         ) VALUES (?, ?, ?, ?, 'speaker', unixepoch() - 200,
                   unixepoch() - 100, unixepoch() - 50)`,
      ).bind(membershipId, admin.organisationId, admin.eventId, personId),
      testEnv.DB.prepare(
        `INSERT INTO event_speaker_workflows (
           event_id, person_id, status, source, last_operation_id,
           updated_by_person_id, created_at, updated_at
         ) VALUES (?, ?, 'withdrawn', 'manual', ?, ?, unixepoch(), unixepoch())`,
      ).bind(
        admin.eventId,
        personId,
        `reactivate-workflow:${suffix}`,
        admin.personId,
      ),
    ]);

    await expect(
      new SpeakerService(testEnv).inviteSpeakerRecord(admin, {
        idempotencyKey: `reactivate:${suffix}`,
        personId,
        confirmation: "send",
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      testEnv.DB.prepare(
        `SELECT id, accepted_at AS acceptedAt, revoked_at AS revokedAt
           FROM memberships
          WHERE event_id = ? AND person_id = ? AND role = 'speaker'`,
      )
        .bind(admin.eventId, personId)
        .first(),
    ).resolves.toEqual({
      id: membershipId,
      acceptedAt: expect.any(Number),
      revokedAt: expect.any(Number),
    });

    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `UPDATE event_speaker_workflows
            SET status = 'prospect', revision = revision + 1,
                last_operation_id = ?, updated_at = unixepoch()
          WHERE event_id = ? AND person_id = ?`,
      ).bind(`reactivate-approved:${suffix}`, admin.eventId, personId),
      testEnv.DB.prepare(
        `INSERT INTO organisation_contacts (
           organisation_id, person_id, source, status, created_by_person_id,
           created_at, updated_at
         ) VALUES (?, ?, 'event', 'active', ?, unixepoch(), unixepoch())`,
      ).bind(admin.organisationId, personId, admin.personId),
    ]);
    await expect(
      new SpeakerService(testEnv).inviteSpeakerRecord(admin, {
        idempotencyKey: `reactivate-approved:${suffix}`,
        personId,
        confirmation: "send",
      }),
    ).resolves.toMatchObject({
      personId,
      membershipId,
      email,
      accepted: false,
      delivery: "demo_not_sent",
      invitationExpiresAt: expect.any(Number),
    });

    await expect(
      testEnv.DB.prepare(
        `SELECT id, accepted_at AS acceptedAt, revoked_at AS revokedAt,
                invitation_expires_at AS invitationExpiresAt
           FROM memberships
          WHERE event_id = ? AND person_id = ? AND role = 'speaker'`,
      )
        .bind(admin.eventId, personId)
        .first(),
    ).resolves.toEqual({
      id: membershipId,
      acceptedAt: null,
      revokedAt: null,
      invitationExpiresAt: expect.any(Number),
    });
  });

  it("does not invite an identity from another organisation without an event roster relationship", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const suffix = crypto.randomUUID();
    const otherOrganisationId = `other-org-${suffix}`;
    const personId = `other-person-${suffix}`;
    const email = `other-person-${suffix}@example.com`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO organisations (id, name, slug)
         VALUES (?, 'Other organisation', ?)`,
      ).bind(otherOrganisationId, otherOrganisationId),
      testEnv.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, email_verified, biography, profile_status
         ) VALUES (?, ?, 'Person-owned name', 1, 'Person-owned biography', 'published')`,
      ).bind(personId, email),
      testEnv.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role, invited_at,
           accepted_at, created_at
         ) VALUES (?, ?, NULL, ?, 'owner', unixepoch(), unixepoch(), unixepoch())`,
      ).bind(`other-membership-${suffix}`, otherOrganisationId, personId),
    ]);

    await expect(
      new SpeakerService(testEnv).inviteSpeakerRecord(admin, {
        idempotencyKey: `cross-org:${suffix}`,
        personId,
        confirmation: "send",
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      testEnv.DB.prepare(
        `SELECT display_name AS name, biography
           FROM people WHERE id = ?`,
      )
        .bind(personId)
        .first(),
    ).resolves.toEqual({
      name: "Person-owned name",
      biography: "Person-owned biography",
    });
  });

  it("fails closed when a pending speaker invitation has no expiry", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const suffix = crypto.randomUUID();
    const service = new SpeakerService(testEnv);
    const input = {
      idempotencyKey: `missing-expiry:${suffix}`,
      name: "Missing Expiry",
      email: `missing-expiry-${suffix}@example.com`,
    };
    const record = await addRosterRecord(service, input);
    const created = await inviteRosterRecord(service, {
      idempotencyKey: input.idempotencyKey,
      personId: record.personId,
    });
    await testEnv.DB.prepare(
      "UPDATE memberships SET invitation_expires_at = NULL WHERE id = ?",
    )
      .bind(created.membershipId)
      .run();

    await expect(
      new SpeakerService(testEnv).listAdminSpeakerPage(
        admin,
        { personId: "", query: "", profileStatus: "", readiness: "" },
        1,
      ),
    ).rejects.toThrow(/missing its required expiry/i);
    await testEnv.DB.prepare(
      "UPDATE memberships SET invitation_expires_at = unixepoch() + 604800 WHERE id = ?",
    )
      .bind(created.membershipId)
      .run();
  });

  it("loads only the authenticated speaker workspace and protects revision updates", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new SpeakerService(testEnv);
    const portal = await service.getPortal(speaker);
    expect(portal.profile.id).toBe(speaker.personId);
    expect(portal.sessions.map((session) => session.id)).toContain(
      "session-demo-speaker",
    );

    await service.updateProfile(speaker, {
      revision: portal.profile.revision,
      name: "Priya Shah",
      biography:
        "Priya designs inclusive event technology experiences for teams and audiences worldwide.",
      pronunciation: "PREE-yah SHAH",
      organisationName: "EventLab",
      jobTitle: "Director",
      linkedinUrl: "https://www.linkedin.com/in/priya-shah",
      xHandle: "@priya_shah",
      travelPreferences: "Vegetarian meals and step-free ground transport.",
      publish: true,
    });
    const saved = await service.getPortal(speaker);
    expect(saved.profile.jobTitle).toBe("Director");
    expect(saved.profile).toMatchObject({
      linkedinUrl: "https://www.linkedin.com/in/priya-shah",
      xHandle: "priya_shah",
      travelPreferences: "Vegetarian meals and step-free ground transport.",
    });
    expect(saved.profile.revision).toBe(portal.profile.revision + 1);
    expect(saved.profileHistory[0]).toMatchObject({
      source: "canonical_person",
      profileRevision: saved.profile.revision,
      displayName: saved.profile.name,
      jobTitle: "Director",
      publicationStatus: "published",
      recordedByName: speaker.name,
    });
    expect(saved.profileHistory[0]).not.toHaveProperty("travelPreferences");
    expect(saved.profileHistory[0]).not.toHaveProperty("email");
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO speaker_profile_revisions (
           id, organisation_id, event_id, person_id, source, profile_revision,
           display_name, publication_status, correlation_id, created_at
         ) VALUES (?, 'other-organisation', ?, ?, 'canonical_person', 999,
                   'Cross-organisation leak', 'published', ?, unixepoch() + 10)`,
      ).bind(
        crypto.randomUUID(),
        speaker.eventId,
        speaker.personId,
        crypto.randomUUID(),
      ),
      testEnv.DB.prepare(
        `INSERT INTO speaker_profile_revisions (
           id, organisation_id, event_id, person_id, source, profile_revision,
           display_name, publication_status, correlation_id, created_at
         ) VALUES (?, ?, 'other-event', ?, 'canonical_person', 998,
                   'Cross-event leak', 'published', ?, unixepoch() + 10)`,
      ).bind(
        crypto.randomUUID(),
        speaker.organisationId,
        speaker.personId,
        crypto.randomUUID(),
      ),
    ]);
    expect(
      (await service.getPortal(speaker)).profileHistory.map(
        ({ displayName }) => displayName,
      ),
    ).not.toEqual(
      expect.arrayContaining(["Cross-organisation leak", "Cross-event leak"]),
    );

    await expect(
      service.updateProfile(speaker, {
        revision: saved.profile.revision,
        name: saved.profile.name,
        biography: saved.profile.biography ?? "",
        pronunciation: saved.profile.pronunciation ?? "",
        organisationName: saved.profile.organisationName ?? "",
        jobTitle: saved.profile.jobTitle ?? "",
        linkedinUrl: "https://example.com/not-linkedin",
        xHandle: "invalid handle",
        travelPreferences: saved.profile.travelPreferences ?? "",
        publish: true,
      }),
    ).rejects.toMatchObject({ name: "ZodError" });

    const auditCountBeforeStale = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM audit_events
        WHERE event_id = ? AND entity_id = ? AND action = 'participant.profile.updated'`,
    )
      .bind(speaker.eventId, speaker.personId)
      .first<{ count: number }>();

    await expect(
      service.updateProfile(speaker, {
        revision: portal.profile.revision,
        name: "Stale Name",
        biography:
          "This biography is deliberately long enough but must never replace the latest profile value.",
        pronunciation: "",
        organisationName: "",
        jobTitle: "",
        linkedinUrl: "",
        xHandle: "",
        travelPreferences: "",
        publish: false,
      }),
    ).rejects.toBeInstanceOf(SpeakerProfileConflictError);

    const auditCountAfterStale = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM audit_events
        WHERE event_id = ? AND entity_id = ? AND action = 'participant.profile.updated'`,
    )
      .bind(speaker.eventId, speaker.personId)
      .first<{ count: number }>();
    expect(auditCountAfterStale?.count).toBe(auditCountBeforeStale?.count);
    expect(auditCountAfterStale?.count).toBe(1);
  });

  it("updates a profile through an accepted submitter membership", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new SpeakerService(testEnv);
    const portal = await service.getPortal(submitter);

    await service.updateProfile(submitter, {
      revision: portal.profile.revision,
      name: "Alex Morgan",
      biography:
        "Alex develops practical event proposals and collaborates with programme teams worldwide.",
      pronunciation: "AL-ex MOR-gan",
      organisationName: "Morgan Events",
      jobTitle: "Programme Lead",
      linkedinUrl: "",
      xHandle: "",
      travelPreferences: "",
      publish: true,
    });

    await expect(service.getPortal(submitter)).resolves.toMatchObject({
      profile: {
        name: "Alex Morgan",
        jobTitle: "Programme Lead",
        revision: portal.profile.revision + 1,
      },
    });
  });

  it("isolates private travel preferences for the same participant across organisations", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const token = crypto.randomUUID();
    const personId = `travel-profile-person-${token}`;
    const firstOrganisationId = `travel-profile-org-a-${token}`;
    const secondOrganisationId = `travel-profile-org-b-${token}`;
    const firstEventId = `travel-profile-event-a-${token}`;
    const secondEventId = `travel-profile-event-b-${token}`;
    const filePolicy =
      '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}';
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, biography, profile_status,
           created_at, updated_at
         ) VALUES (?, ?, 'Shared Travel Speaker',
                   'A sufficiently detailed biography for the shared travel profile isolation test.',
                   'published', unixepoch(), unixepoch())`,
      ).bind(personId, `travel-profile-${token}@example.com`),
      testEnv.DB.prepare(
        "INSERT INTO organisations (id, name, slug) VALUES (?, 'Travel profile organisation A', ?)",
      ).bind(firstOrganisationId, `travel-profile-org-a-${token}`),
      testEnv.DB.prepare(
        "INSERT INTO organisations (id, name, slug) VALUES (?, 'Travel profile organisation B', ?)",
      ).bind(secondOrganisationId, `travel-profile-org-b-${token}`),
      testEnv.DB.prepare(
        `INSERT INTO events (
           id, organisation_id, name, slug, timezone, starts_at, ends_at,
           file_policy_json
         ) VALUES (?, ?, 'Travel profile event A', ?, 'UTC', 1800000000,
                   1800086400, ?)`,
      ).bind(
        firstEventId,
        firstOrganisationId,
        `travel-profile-event-a-${token}`,
        filePolicy,
      ),
      testEnv.DB.prepare(
        `INSERT INTO events (
           id, organisation_id, name, slug, timezone, starts_at, ends_at,
           file_policy_json
         ) VALUES (?, ?, 'Travel profile event B', ?, 'UTC', 1800000000,
                   1800086400, ?)`,
      ).bind(
        secondEventId,
        secondOrganisationId,
        `travel-profile-event-b-${token}`,
        filePolicy,
      ),
      testEnv.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role, accepted_at
         ) VALUES (?, ?, ?, ?, 'speaker', unixepoch())`,
      ).bind(
        `travel-profile-membership-a-${token}`,
        firstOrganisationId,
        firstEventId,
        personId,
      ),
      testEnv.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role, accepted_at
         ) VALUES (?, ?, ?, ?, 'speaker', unixepoch())`,
      ).bind(
        `travel-profile-membership-b-${token}`,
        secondOrganisationId,
        secondEventId,
        personId,
      ),
    ]);
    const service = new SpeakerService(testEnv);
    const firstSpeaker: Viewer = {
      personId,
      name: "Shared Travel Speaker",
      email: `travel-profile-${token}@example.com`,
      role: "speaker",
      organisationId: firstOrganisationId,
      eventId: firstEventId,
      demo: true,
    };
    const secondSpeaker: Viewer = {
      ...firstSpeaker,
      organisationId: secondOrganisationId,
      eventId: secondEventId,
    };
    const update = async (viewer: Viewer, travelPreferences: string) => {
      const portal = await service.getPortal(viewer);
      await service.updateProfile(viewer, {
        revision: portal.profile.revision,
        name: portal.profile.name,
        biography: portal.profile.biography ?? "",
        pronunciation: portal.profile.pronunciation ?? "",
        organisationName: portal.profile.organisationName ?? "",
        jobTitle: portal.profile.jobTitle ?? "",
        linkedinUrl: portal.profile.linkedinUrl ?? "",
        xHandle: portal.profile.xHandle ?? "",
        travelPreferences,
        publish: portal.profile.profileStatus === "published",
      });
    };

    await update(firstSpeaker, "Primary event ground transport preferences");
    await update(secondSpeaker, "Other organisation dietary preferences");

    await expect(service.getPortal(firstSpeaker)).resolves.toMatchObject({
      profile: {
        travelPreferences: "Primary event ground transport preferences",
      },
    });
    await expect(service.getPortal(secondSpeaker)).resolves.toMatchObject({
      profile: {
        travelPreferences: "Other organisation dietary preferences",
      },
    });
    await expect(
      service.getAdminSpeakerDetail(
        {
          ...admin,
          organisationId: firstOrganisationId,
          eventId: firstEventId,
        },
        personId,
      ),
    ).resolves.toMatchObject({
      profile: {
        travelPreferences: "Primary event ground transport preferences",
      },
    });
    await expect(
      service.getAdminSpeakerDetail(
        {
          ...admin,
          organisationId: secondOrganisationId,
          eventId: secondEventId,
        },
        personId,
      ),
    ).resolves.toMatchObject({
      profile: {
        travelPreferences: "Other organisation dietary preferences",
      },
    });
    const storedProfiles = await testEnv.DB.prepare(
      `SELECT event_id AS eventId, organisation_id AS organisationId,
              travel_preferences AS travelPreferences
         FROM event_participant_profiles
        WHERE person_id = ?
          AND event_id IN (?, ?)
        ORDER BY event_id`,
    )
      .bind(personId, firstEventId, secondEventId)
      .all();
    expect(storedProfiles.results).toEqual(
      expect.arrayContaining([
        {
          eventId: firstEventId,
          organisationId: firstOrganisationId,
          travelPreferences: "Primary event ground transport preferences",
        },
        {
          eventId: secondEventId,
          organisationId: secondOrganisationId,
          travelPreferences: "Other organisation dietary preferences",
        },
      ]),
    );
    await expect(
      service.getPortal({
        ...firstSpeaker,
        organisationId: secondOrganisationId,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.getAdminSpeakerDetail(
        {
          ...admin,
          organisationId: secondOrganisationId,
          eventId: firstEventId,
        },
        personId,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects a person without a current speaker membership", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    await expect(
      new SpeakerService(testEnv).getPortal({
        ...speaker,
        personId: "person-demo-admin",
        role: "speaker",
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
