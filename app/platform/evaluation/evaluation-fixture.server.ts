import { z } from "zod";

import { emailDeliveryIssue } from "~/modules/communications/email-deliverability";
import { requireEmailProviderConfiguration } from "~/modules/communications/email-provider.server";
import { ResendDomainProvider } from "~/modules/communications/resend-domain.server";
import {
  DEMO_EVENT_ID,
  DEMO_IDENTITIES,
  DEMO_ORGANISATION_ID,
  DEMO_RESET_CONFIRMATION,
  SBEK_FIXTURE_PEOPLE,
  SBEK_SECOND_SPEAKER,
} from "~/platform/demo/demo-identities";
import {
  DEMO_RESET_EVENT_TABLES,
  resetDemoEvent,
  type DemoActiveWork,
} from "~/platform/demo/demo-reset.server";
import { findPersonLinkedOutsideEvaluationOrganisation } from "~/platform/evaluation/evaluation-identity-isolation.server";
import {
  acquireEvaluationFixtureReset,
  assertEvaluationFixtureResetOwner,
  completeEvaluationFixtureReset,
  EVALUATION_FIXTURE_RESET_ACTOR_ID,
  EVALUATION_FIXTURE_RESET_OPERATION_ID,
  EVALUATION_FIXTURE_RESET_OPERATION_TYPE,
  markEvaluationFixtureResetFailed,
} from "~/platform/evaluation/evaluation-fixture-reset-lock.server";
import { requireRuntimeMode } from "~/platform/runtime-environment.server";

const EVALUATION_SENDER_ID = "sender-production-evaluation-fixture";
const EVALUATION_ORGANISATION_SLUG = "future-events-association";
const EVALUATION_EVENT_SLUG = "future-of-events-2027";
const EVALUATION_ORGANIZER_MEMBERSHIP_ID =
  "membership-production-evaluation-organizer-org";
const WORKERS_AI_MODEL = "@cf/openai/gpt-oss-120b";

const deliverableEmailSchema = z
  .email()
  .transform((value) => value.trim().toLowerCase())
  .refine((value) => emailDeliveryIssue(value, "production") === null, {
    message:
      "Evaluator addresses must not use a reserved or local-only domain.",
  });

const fixtureEmailSchema = z
  .object({
    organizer: deliverableEmailSchema,
    speaker: deliverableEmailSchema,
    speaker2: deliverableEmailSchema,
    reviewer: deliverableEmailSchema,
  })
  .superRefine((value, context) => {
    if (new Set(Object.values(value)).size !== 4) {
      context.addIssue({
        code: "custom",
        message: "The four evaluator email addresses must be distinct.",
      });
    }
  });

export type EvaluationFixtureEmails = z.infer<typeof fixtureEmailSchema>;

type DomainReader = Pick<ResendDomainProvider, "list">;

export type ProductionEvaluationFixtureEvidence = {
  fixturePeople: number;
  fixtureVerifiedPeople: number;
  fixtureSessions: number;
  fixtureAccounts: number;
  fixtureCalendarConnections: number;
  fixtureVerificationTokens: number;
  verifiedSenders: number;
  workersAiSettings: number;
  fixtureOrganisationAdministrators: number;
  fixtureOrganisationMemberships: number;
  fixtureApplicantMemberships: number;
  nonDiscardedExtraEvents: number;
};

type FixtureEvent = {
  id: string;
  organisationId: string;
  slug: string;
  activationStatus: string;
};

type FixtureAuxiliaryPerson = {
  id: string;
  email: string;
};

type FixtureScope = {
  extraEvents: FixtureEvent[];
  auxiliaryPeople: FixtureAuxiliaryPerson[];
  identityEmails: string[];
};

function productionFixtureEmails(env: CloudflareEnvironment) {
  return fixtureEmailSchema.parse({
    organizer: env.EVALUATOR_ORGANIZER_EMAIL,
    speaker: env.EVALUATOR_SPEAKER_EMAIL,
    speaker2: env.EVALUATOR_SECOND_SPEAKER_EMAIL,
    reviewer: env.EVALUATOR_REVIEWER_EMAIL,
  });
}

function demoSeedEnvironment(env: CloudflareEnvironment) {
  // Grant the existing demo-gated seed capability only inside the already
  // authenticated, fixed-ID production fixture operation. This adapted object
  // never reaches request authentication or ordinary runtime selection.
  return new Proxy(env, {
    get(target, property, receiver) {
      if (property === "APP_ENV") return "demo";
      if (property === "DEMO_MODE") return "true";
      if (property === "EVALUATION_MODE") return "false";
      if (property === "DEFAULT_EVENT_ID") return DEMO_EVENT_ID;
      return Reflect.get(target, property, receiver);
    },
  }) as CloudflareEnvironment;
}

function parseSender(value: string | undefined) {
  const configured = value?.trim() ?? "";
  const bracketed = /^(.*?)\s*<([^<>]+)>$/u.exec(configured);
  const name = bracketed?.[1]?.trim() ?? "";
  if (!name || !bracketed?.[2]) {
    throw new Error(
      "AUTH_EMAIL_FROM must use the explicit Display Name <address> format for the evaluation sender.",
    );
  }
  const address = deliverableEmailSchema.parse(bracketed[2].trim());
  return { name, address, domain: address.slice(address.lastIndexOf("@") + 1) };
}

function allSeedIdentities() {
  return [...Object.values(DEMO_IDENTITIES), SBEK_SECOND_SPEAKER];
}

async function assertDedicatedFixtureIdentity(
  env: CloudflareEnvironment,
  emails: EvaluationFixtureEmails,
): Promise<FixtureScope> {
  const organisationCollision = await env.DB.prepare(
    `SELECT id, slug FROM organisations
      WHERE id = ? OR slug = ?`,
  )
    .bind(DEMO_ORGANISATION_ID, EVALUATION_ORGANISATION_SLUG)
    .all<{ id: string; slug: string }>();
  if (
    organisationCollision.results.some(
      (row) =>
        row.id !== DEMO_ORGANISATION_ID ||
        row.slug !== EVALUATION_ORGANISATION_SLUG,
    )
  ) {
    throw new Error(
      "The canonical production evaluation organisation identity is not dedicated to this fixture.",
    );
  }

  const eventCollision = await env.DB.prepare(
    `SELECT id, organisation_id AS organisationId, slug,
            activation_status AS activationStatus
       FROM events
      WHERE id = ? OR slug = ?
         OR organisation_id = ?`,
  )
    .bind(DEMO_EVENT_ID, EVALUATION_EVENT_SLUG, DEMO_ORGANISATION_ID)
    .all<FixtureEvent>();
  const canonicalEventCollisions = eventCollision.results.filter(
    (row) => row.id === DEMO_EVENT_ID || row.slug === EVALUATION_EVENT_SLUG,
  );
  if (
    canonicalEventCollisions.some(
      (row) =>
        row.id !== DEMO_EVENT_ID ||
        row.organisationId !== DEMO_ORGANISATION_ID ||
        row.slug !== EVALUATION_EVENT_SLUG,
    )
  ) {
    throw new Error(
      "The canonical production evaluation event identity is not dedicated to this fixture.",
    );
  }
  const extraEvents = eventCollision.results.filter(
    (row) =>
      row.organisationId === DEMO_ORGANISATION_ID && row.id !== DEMO_EVENT_ID,
  );

  const identities = allSeedIdentities();
  const targetIds = identities.map((identity) => identity.personId);
  if (organisationCollision.results.length === 0) {
    const preexistingFixtureId = await env.DB.prepare(
      `SELECT id FROM people
        WHERE id IN (${targetIds.map(() => "?").join(",")})
        LIMIT 1`,
    )
      .bind(...targetIds)
      .first<{ id: string }>();
    if (preexistingFixtureId) {
      throw new Error(
        `Fixture person ID ${preexistingFixtureId.id} already exists without the dedicated evaluation organisation.`,
      );
    }
  }
  const expectedEmailOwners = new Map(
    identities.map((identity) => [
      identity.email.toLowerCase(),
      identity.personId,
    ]),
  );
  for (const [key, email] of Object.entries(emails) as Array<
    [keyof EvaluationFixtureEmails, string]
  >) {
    expectedEmailOwners.set(email, SBEK_FIXTURE_PEOPLE[key].personId);
  }
  const emailPlaceholders = [...expectedEmailOwners].map(() => "?").join(",");
  const emailOwners = await env.DB.prepare(
    `SELECT id, email FROM people WHERE email COLLATE NOCASE IN (${emailPlaceholders})`,
  )
    .bind(...expectedEmailOwners.keys())
    .all<{ id: string; email: string }>();
  for (const row of emailOwners.results) {
    if (expectedEmailOwners.get(row.email.toLowerCase()) !== row.id) {
      throw new Error(
        `Evaluator fixture email ${row.email} already belongs to another person.`,
      );
    }
  }

  const crossTenantIdentity =
    await findPersonLinkedOutsideEvaluationOrganisation(env, targetIds);
  if (crossTenantIdentity) {
    throw new Error(
      `Fixture person ${crossTenantIdentity.id} is linked outside the dedicated evaluation organisation.`,
    );
  }
  const identityEmails = (
    await env.DB.prepare(
      `SELECT email FROM people
        WHERE id IN (${targetIds.map(() => "?").join(",")})`,
    )
      .bind(...targetIds)
      .all<{ email: string }>()
  ).results.map(({ email }) => email);

  const organiserMembershipCollision = await env.DB.prepare(
    `SELECT organisation_id AS organisationId, event_id AS eventId,
            person_id AS personId, role
       FROM memberships WHERE id = ?`,
  )
    .bind(EVALUATION_ORGANIZER_MEMBERSHIP_ID)
    .first<{
      organisationId: string;
      eventId: string | null;
      personId: string;
      role: string;
    }>();
  if (
    organiserMembershipCollision &&
    (organiserMembershipCollision.organisationId !== DEMO_ORGANISATION_ID ||
      organiserMembershipCollision.eventId !== null ||
      organiserMembershipCollision.personId !==
        SBEK_FIXTURE_PEOPLE.organizer.personId ||
      organiserMembershipCollision.role !== "administrator")
  ) {
    throw new Error(
      "The production evaluation organiser membership ID belongs to another identity or tenant.",
    );
  }

  const latestReset = await env.DB.prepare(
    `SELECT created_at AS createdAt
       FROM audit_events
      WHERE organisation_id = ? AND action = 'evaluation.fixture.reset'
        AND json_extract(metadata_json, '$.status') = 'completed'
      ORDER BY rowid DESC
      LIMIT 1`,
  )
    .bind(DEMO_ORGANISATION_ID)
    .first<{ createdAt: number }>();
  let auxiliaryPeople: FixtureAuxiliaryPerson[] = [];
  if (latestReset) {
    const excludedIds = allSeedIdentities().map(
      (identity) => identity.personId,
    );
    auxiliaryPeople = (
      await env.DB.prepare(
        `SELECT DISTINCT person.id, person.email
           FROM people person
          WHERE person.created_at >= ?
            AND person.id NOT IN (${excludedIds.map(() => "?").join(",")})
            AND (
              EXISTS (
                SELECT 1 FROM organisation_contacts contact
                 WHERE contact.person_id = person.id
                   AND contact.organisation_id = ?
              )
              OR EXISTS (
                SELECT 1 FROM memberships membership
                 WHERE membership.person_id = person.id
                   AND membership.organisation_id = ?
              )
              OR EXISTS (
                SELECT 1 FROM submissions submission
                JOIN events event ON event.id = submission.event_id
                 WHERE submission.submitter_person_id = person.id
                   AND event.organisation_id = ?
              )
              OR EXISTS (
                SELECT 1 FROM submission_speakers speaker
                JOIN events event ON event.id = speaker.event_id
                 WHERE speaker.person_id = person.id
                   AND event.organisation_id = ?
              )
              OR EXISTS (
                SELECT 1 FROM event_speaker_workflows workflow
                JOIN events event ON event.id = workflow.event_id
                 WHERE workflow.person_id = person.id
                   AND event.organisation_id = ?
              )
              OR EXISTS (
                SELECT 1 FROM event_participant_profiles profile
                JOIN events event ON event.id = profile.event_id
                 WHERE profile.person_id = person.id
                   AND event.organisation_id = ?
              )
              OR EXISTS (
                SELECT 1 FROM session_speakers speaker
                JOIN events event ON event.id = speaker.event_id
                 WHERE speaker.person_id = person.id
                   AND event.organisation_id = ?
              )
            )`,
      )
        .bind(
          latestReset.createdAt,
          ...excludedIds,
          DEMO_ORGANISATION_ID,
          DEMO_ORGANISATION_ID,
          DEMO_ORGANISATION_ID,
          DEMO_ORGANISATION_ID,
          DEMO_ORGANISATION_ID,
          DEMO_ORGANISATION_ID,
          DEMO_ORGANISATION_ID,
        )
        .all<FixtureAuxiliaryPerson>()
    ).results;
    if (auxiliaryPeople.length) {
      const auxiliaryIds = auxiliaryPeople.map((person) => person.id);
      const crossTenantAuxiliaryPerson =
        await findPersonLinkedOutsideEvaluationOrganisation(env, auxiliaryIds);
      if (crossTenantAuxiliaryPerson) {
        throw new Error(
          `Evaluation-created person ${crossTenantAuxiliaryPerson.id} is linked outside the dedicated evaluation organisation and cannot be removed safely.`,
        );
      }
      const unsafeAuxiliaryPerson = await env.DB.prepare(
        `SELECT person.id
           FROM people person
          WHERE person.id IN (${auxiliaryIds.map(() => "?").join(",")})
            AND (
              EXISTS (
                SELECT 1 FROM memberships membership
                 WHERE membership.person_id = person.id
                   AND membership.organisation_id <> ?
              )
              OR EXISTS (
                SELECT 1 FROM organisation_contacts contact
                 WHERE contact.person_id = person.id
                   AND contact.organisation_id <> ?
              )
              OR EXISTS (
                SELECT 1 FROM calendar_connections connection
                 WHERE connection.person_id = person.id
              )
              OR EXISTS (
                SELECT 1 FROM auth_sessions session
                 WHERE session.person_id = person.id
              )
              OR EXISTS (
                SELECT 1 FROM auth_accounts account
                 WHERE account.person_id = person.id
              )
              OR EXISTS (
                SELECT 1 FROM audit_events audit
                 WHERE audit.actor_person_id = person.id
              )
            )
          LIMIT 1`,
      )
        .bind(...auxiliaryIds, DEMO_ORGANISATION_ID, DEMO_ORGANISATION_ID)
        .first<{ id: string }>();
      if (unsafeAuxiliaryPerson) {
        throw new Error(
          `Evaluation-created person ${unsafeAuxiliaryPerson.id} has authentication, audit, or cross-tenant state and cannot be removed safely.`,
        );
      }
    }
  }

  const senderCollision = await env.DB.prepare(
    `SELECT event_id AS eventId FROM sender_profiles WHERE id = ?`,
  )
    .bind(EVALUATION_SENDER_ID)
    .first<{ eventId: string }>();
  if (senderCollision && senderCollision.eventId !== DEMO_EVENT_ID) {
    throw new Error(
      "The production evaluation sender ID belongs to another event.",
    );
  }
  return { extraEvents, auxiliaryPeople, identityEmails };
}

async function readExtraEventActiveWork(
  env: CloudflareEnvironment,
): Promise<DemoActiveWork> {
  const extraEvents =
    "SELECT id FROM events WHERE organisation_id = ? AND id <> ?";
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM operation_jobs
         WHERE event_id IN (${extraEvents})
           AND status IN ('queued','received','running','retrying')) AS operations,
       (SELECT COUNT(*) FROM file_multipart_uploads
         WHERE event_id IN (${extraEvents})
           AND status IN ('requested','initiated','completing')) AS multipartUploads,
       (SELECT COUNT(*) FROM integration_runs run
          JOIN integration_connections connection ON connection.id = run.connection_id
         WHERE connection.event_id IN (${extraEvents})
           AND run.status IN ('queued','running')) AS integrationRuns,
       (SELECT COUNT(*) FROM communications
         WHERE event_id IN (${extraEvents})
           AND status IN ('scheduled','queued','sending')) AS communications,
       (SELECT COUNT(*) FROM calendar_sync_attempts attempt
          JOIN calendar_invitations invitation ON invitation.id = attempt.invitation_id
         WHERE invitation.event_id IN (${extraEvents})
           AND attempt.status IN ('queued','running')) AS calendarAttempts,
       (SELECT COUNT(*) FROM webhook_deliveries delivery
          JOIN webhook_endpoints endpoint ON endpoint.id = delivery.endpoint_id
         WHERE endpoint.event_id IN (${extraEvents})
           AND delivery.status IN ('queued','delivering')) AS webhookDeliveries`,
  )
    .bind(
      ...Array.from({ length: 6 }, () => [
        DEMO_ORGANISATION_ID,
        DEMO_EVENT_ID,
      ]).flat(),
    )
    .first<DemoActiveWork>();
  if (!row) throw new Error("The evaluation event activity boundary failed.");
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, Number(value)]),
  ) as DemoActiveWork;
}

async function clearEventObjects(
  bucket: R2Bucket,
  eventId: string,
  assertOwner: () => Promise<void>,
) {
  const prefix = `private/events/${eventId}/`;
  let deleted = 0;
  let previousPage: string | null = null;
  let repeatedPageCount = 0;
  while (true) {
    await assertOwner();
    const page = await bucket.list({ prefix, limit: 1_000 });
    const keys = page.objects.map((object) => object.key);
    if (!keys.length) return deleted;
    const pageIdentity = JSON.stringify(keys);
    repeatedPageCount =
      pageIdentity === previousPage ? repeatedPageCount + 1 : 0;
    if (repeatedPageCount >= 3) {
      throw new Error(
        `Evaluation event ${eventId} storage did not make progress after repeated delete attempts.`,
      );
    }
    previousPage = pageIdentity;
    await assertOwner();
    await bucket.delete(keys);
    deleted += keys.length;
    if (deleted > 100_000) {
      throw new Error(
        `Evaluation event ${eventId} exceeded the 100,000-object reset safety limit.`,
      );
    }
  }
}

async function retireExtraFixtureEvents(
  env: CloudflareEnvironment,
  events: FixtureEvent[],
  assertOwner: () => Promise<void>,
) {
  for (const event of events) {
    await clearEventObjects(env.FILES, event.id, assertOwner);
  }
  if (!events.length) return 0;
  await assertOwner();
  const eventPlaceholders = events.map(() => "?").join(",");
  const eventIds = events.map((event) => event.id);
  const newlyRetired = events.filter(
    (event) =>
      event.activationStatus !== "discarded" ||
      event.slug !== `discarded:evaluation:${event.id}`,
  );
  const results = await env.DB.batch([
    ...DEMO_RESET_EVENT_TABLES.map((table) =>
      env.DB.prepare(
        `DELETE FROM ${table} WHERE event_id IN (${eventPlaceholders})`,
      ).bind(...eventIds),
    ),
    ...newlyRetired.map((event) =>
      env.DB.prepare(
        `UPDATE events
            SET activation_status = 'discarded',
                slug = ?, name = 'Retired evaluation event',
                last_operation_id = ?, last_updated_by_person_id = NULL,
                revision = revision + 1, updated_at = unixepoch()
          WHERE id = ? AND organisation_id = ?
            AND (
              activation_status <> 'discarded'
              OR slug <> ?
            )`,
      ).bind(
        `discarded:evaluation:${event.id}`,
        `evaluation-fixture-retire:${crypto.randomUUID()}`,
        event.id,
        DEMO_ORGANISATION_ID,
        `discarded:evaluation:${event.id}`,
      ),
    ),
  ]);
  if (!newlyRetired.length) return 0;
  return results
    .slice(-newlyRetired.length)
    .reduce((count, result) => count + (result.meta.changes ?? 0), 0);
}

async function verifiedSender(
  env: CloudflareEnvironment,
  domains: DomainReader,
) {
  const configuration = requireEmailProviderConfiguration(env);
  if (configuration.provider !== "resend") {
    throw new Error("The production evaluation fixture requires Resend.");
  }
  const sender = parseSender(env.AUTH_EMAIL_FROM);
  const domain = (await domains.list()).find(
    (candidate) =>
      candidate.name.toLowerCase() === sender.domain &&
      candidate.status.toLowerCase() === "verified",
  );
  if (!domain) {
    throw new Error(
      `Resend must report ${sender.domain} as verified before the production evaluation fixture can be reset.`,
    );
  }
  return {
    name: sender.name,
    address: sender.address,
    domainName: sender.domain,
    providerDomain: domain,
  };
}

function evaluationDomainReader(env: CloudflareEnvironment) {
  const apiKey = env.EVALUATION_RESEND_API_KEY?.trim() ?? "";
  if (apiKey.length < 20) {
    throw new Error(
      "EVALUATION_RESEND_API_KEY must be a temporary full-access Resend key used to read domain status.",
    );
  }
  return new ResendDomainProvider(apiKey);
}

async function productionEvidence(
  env: CloudflareEnvironment,
  emails: EvaluationFixtureEmails,
  previousEmails: string[],
) {
  const routedIdentities = Object.entries(emails) as Array<
    [keyof EvaluationFixtureEmails, string]
  >;
  const routedIds = routedIdentities.map(
    ([key]) => SBEK_FIXTURE_PEOPLE[key].personId,
  );
  const ids = allSeedIdentities().map((identity) => identity.personId);
  const tokenEmails = [
    ...new Set(
      [
        ...allSeedIdentities().map((identity) => identity.email),
        ...previousEmails,
        ...Object.values(emails),
      ].map((email) => email.toLowerCase()),
    ),
  ];
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM people
         WHERE ${routedIdentities.map(() => "(id = ? AND email = ? COLLATE NOCASE)").join(" OR ")}) AS fixturePeople,
       (SELECT COUNT(*) FROM people
         WHERE id IN (${routedIds.map(() => "?").join(",")})
           AND email_verified = 1) AS fixtureVerifiedPeople,
       (SELECT COUNT(*) FROM auth_sessions WHERE person_id IN (${ids.map(() => "?").join(",")})) AS fixtureSessions,
       (SELECT COUNT(*) FROM auth_accounts WHERE person_id IN (${ids.map(() => "?").join(",")})) AS fixtureAccounts,
       (SELECT COUNT(*) FROM calendar_connections
         WHERE person_id IN (${ids.map(() => "?").join(",")})) AS fixtureCalendarConnections,
       (SELECT COUNT(*) FROM verification_tokens
         WHERE identifier COLLATE NOCASE IN (${tokenEmails.map(() => "?").join(",")})
            OR CASE WHEN json_valid(value)
                    THEN json_extract(value, '$.email') END COLLATE NOCASE
               IN (${tokenEmails.map(() => "?").join(",")})
            OR CASE WHEN json_valid(value)
                    THEN json_extract(value, '$.link.email') END COLLATE NOCASE
               IN (${tokenEmails.map(() => "?").join(",")})
            OR CASE WHEN json_valid(value)
                    THEN json_extract(value, '$.link.userId') END
               IN (${ids.map(() => "?").join(",")})) AS fixtureVerificationTokens,
       (SELECT COUNT(*) FROM sender_profiles
         WHERE id = ? AND event_id = ? AND provider = 'resend'
           AND status = 'verified') AS verifiedSenders,
       (SELECT COUNT(*) FROM organisation_ai_settings
         WHERE organisation_id = ? AND provider = 'workers_ai' AND model = ?) AS workersAiSettings,
       (SELECT COUNT(*) FROM memberships
         WHERE id = ? AND organisation_id = ? AND event_id IS NULL
           AND person_id = ? AND role = 'administrator'
           AND accepted_at IS NOT NULL AND revoked_at IS NULL) AS fixtureOrganisationAdministrators,
       (SELECT COUNT(*) FROM memberships
         WHERE organisation_id = ? AND event_id IS NULL) AS fixtureOrganisationMemberships,
       (SELECT COUNT(*) FROM memberships
         WHERE id = 'membership-production-evaluation-applicant-event') AS fixtureApplicantMemberships,
       (SELECT COUNT(*) FROM events
         WHERE organisation_id = ? AND id <> ?
           AND activation_status <> 'discarded') AS nonDiscardedExtraEvents`,
  )
    .bind(
      ...routedIdentities.flatMap(([key, email]) => [
        SBEK_FIXTURE_PEOPLE[key].personId,
        email,
      ]),
      ...routedIds,
      ...ids,
      ...ids,
      ...ids,
      ...tokenEmails,
      ...tokenEmails,
      ...tokenEmails,
      ...ids,
      EVALUATION_SENDER_ID,
      DEMO_EVENT_ID,
      DEMO_ORGANISATION_ID,
      WORKERS_AI_MODEL,
      EVALUATION_ORGANIZER_MEMBERSHIP_ID,
      DEMO_ORGANISATION_ID,
      SBEK_FIXTURE_PEOPLE.organizer.personId,
      DEMO_ORGANISATION_ID,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
    )
    .first<ProductionEvaluationFixtureEvidence>();
  if (!row)
    throw new Error("The production evaluation fixture could not be verified.");
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, Number(value)]),
  ) as ProductionEvaluationFixtureEvidence;
}

function fixtureIsComplete(evidence: ProductionEvaluationFixtureEvidence) {
  return (
    evidence.fixturePeople === 4 &&
    evidence.fixtureVerifiedPeople === 0 &&
    evidence.fixtureSessions === 0 &&
    evidence.fixtureAccounts === 0 &&
    evidence.fixtureCalendarConnections === 0 &&
    evidence.fixtureVerificationTokens === 0 &&
    evidence.verifiedSenders === 1 &&
    evidence.workersAiSettings === 1 &&
    evidence.fixtureOrganisationAdministrators === 1 &&
    evidence.fixtureOrganisationMemberships === 2 &&
    evidence.fixtureApplicantMemberships === 0 &&
    evidence.nonDiscardedExtraEvents === 0
  );
}

export async function resetProductionEvaluationFixture(
  env: CloudflareEnvironment,
  confirmation: unknown,
  domains?: DomainReader,
) {
  const runtime = requireRuntimeMode(env);
  if (
    runtime.appEnvironment !== "production" ||
    runtime.demo ||
    !runtime.evaluation
  ) {
    throw new Error(
      "The production evaluation fixture can run only when production evaluation mode is enabled.",
    );
  }
  if (confirmation !== DEMO_RESET_CONFIRMATION) {
    throw new Error(
      `Type ${DEMO_RESET_CONFIRMATION} exactly to reset the fixture.`,
    );
  }
  if (!env.DB)
    throw new Error("Required Cloudflare binding DB is unavailable.");
  if (!env.FILES)
    throw new Error("Required Cloudflare binding FILES is unavailable.");
  if (!env.AI)
    throw new Error("Required Cloudflare binding AI is unavailable.");

  const emails = productionFixtureEmails(env);
  const fixtureScope = await assertDedicatedFixtureIdentity(env, emails);
  const sender = await verifiedSender(
    env,
    domains ?? evaluationDomainReader(env),
  );
  const retainedEventWithCompletedRetention = await env.DB.prepare(
    `SELECT id FROM events
      WHERE organisation_id = ? AND id <> ?
        AND participant_retention_completed_at IS NOT NULL
      LIMIT 1`,
  )
    .bind(DEMO_ORGANISATION_ID, DEMO_EVENT_ID)
    .first<{ id: string }>();
  if (retainedEventWithCompletedRetention) {
    throw new Error(
      `Evaluation event ${retainedEventWithCompletedRetention.id} has completed participant retention and cannot be reset.`,
    );
  }
  const extraActiveWork = await readExtraEventActiveWork(env);
  if (Object.values(extraActiveWork).some((count) => count > 0)) {
    throw new Error(
      `The evaluation fixture cannot reset while extra events have active work: ${JSON.stringify(extraActiveWork)}.`,
    );
  }
  const fixtureAttemptId = crypto.randomUUID();
  let retiredEventCount = 0;

  await acquireEvaluationFixtureReset(env, fixtureAttemptId);
  try {
    await assertEvaluationFixtureResetOwner(env, fixtureAttemptId);
    const seeded = await resetDemoEvent(
      demoSeedEnvironment(env),
      null,
      confirmation,
      EVALUATION_FIXTURE_RESET_ACTOR_ID,
      async () => {
        await assertEvaluationFixtureResetOwner(env, fixtureAttemptId);
        const started = await env.DB.prepare(
          `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_id, action,
           entity_type, entity_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, ?, 'evaluation.fixture.reset.started', 'event', ?, ?,
                unixepoch()
           FROM operation_jobs
          WHERE id = ? AND type = ? AND status = 'running'
            AND claim_token = ?
            AND claim_expires_at IS NOT NULL
            AND claim_expires_at > unixepoch()
            AND json_extract(payload_json, '$.attemptId') = ?`,
        )
          .bind(
            fixtureAttemptId,
            DEMO_ORGANISATION_ID,
            DEMO_EVENT_ID,
            EVALUATION_FIXTURE_RESET_ACTOR_ID,
            DEMO_EVENT_ID,
            JSON.stringify({
              status: "started",
              provider: "resend",
              senderDomain: sender.domainName,
              aiProvider: "workers_ai",
              aiModel: WORKERS_AI_MODEL,
            }),
            EVALUATION_FIXTURE_RESET_OPERATION_ID,
            EVALUATION_FIXTURE_RESET_OPERATION_TYPE,
            fixtureAttemptId,
            fixtureAttemptId,
          )
          .run();
        if ((started.meta.changes ?? 0) !== 1) {
          throw new Error(
            "The production evaluation fixture start marker could not be recorded.",
          );
        }
        const boundaryExtraActiveWork = await readExtraEventActiveWork(env);
        if (Object.values(boundaryExtraActiveWork).some((count) => count > 0)) {
          throw new Error(
            `The evaluation fixture cannot reset while extra events have active work: ${JSON.stringify(boundaryExtraActiveWork)}.`,
          );
        }
        await assertEvaluationFixtureResetOwner(env, fixtureAttemptId);
        retiredEventCount = await retireExtraFixtureEvents(
          env,
          fixtureScope.extraEvents,
          () => assertEvaluationFixtureResetOwner(env, fixtureAttemptId),
        );
        await assertEvaluationFixtureResetOwner(env, fixtureAttemptId);
      },
      () => assertEvaluationFixtureResetOwner(env, fixtureAttemptId),
    );
    await assertEvaluationFixtureResetOwner(env, fixtureAttemptId);
    const fixtureEntries = Object.entries(emails) as Array<
      [keyof EvaluationFixtureEmails, string]
    >;
    const fixtureIds = allSeedIdentities().map((identity) => identity.personId);
    const oldAndNewEmails = [
      ...new Set(
        [
          ...allSeedIdentities().map((identity) => identity.email),
          ...fixtureScope.identityEmails,
          ...Object.values(emails),
        ].map((email) => email.toLowerCase()),
      ),
    ];

    await env.DB.batch([
      ...fixtureEntries.map(([key, email]) =>
        env.DB.prepare(
          `UPDATE people SET email = ?, email_verified = 0, updated_at = unixepoch()
          WHERE id = ?`,
        ).bind(email, SBEK_FIXTURE_PEOPLE[key].personId),
      ),
      env.DB.prepare(
        `DELETE FROM auth_sessions WHERE person_id IN (${fixtureIds.map(() => "?").join(",")})`,
      ).bind(...fixtureIds),
      env.DB.prepare(
        `DELETE FROM auth_accounts WHERE person_id IN (${fixtureIds.map(() => "?").join(",")})`,
      ).bind(...fixtureIds),
      env.DB.prepare(
        `DELETE FROM calendar_connections
        WHERE organisation_id = ?
          AND person_id IN (${fixtureIds.map(() => "?").join(",")})`,
      ).bind(DEMO_ORGANISATION_ID, ...fixtureIds),
      env.DB.prepare(
        `DELETE FROM verification_tokens
        WHERE identifier COLLATE NOCASE IN (${oldAndNewEmails.map(() => "?").join(",")})
           OR CASE WHEN json_valid(value)
                   THEN json_extract(value, '$.email') END COLLATE NOCASE
              IN (${oldAndNewEmails.map(() => "?").join(",")})
           OR CASE WHEN json_valid(value)
                   THEN json_extract(value, '$.link.email') END COLLATE NOCASE
              IN (${oldAndNewEmails.map(() => "?").join(",")})
           OR CASE WHEN json_valid(value)
                   THEN json_extract(value, '$.link.userId') END
              IN (${fixtureIds.map(() => "?").join(",")})`,
      ).bind(
        ...oldAndNewEmails,
        ...oldAndNewEmails,
        ...oldAndNewEmails,
        ...fixtureIds,
      ),
      env.DB.prepare(
        `UPDATE organisation_ai_settings
          SET provider = 'workers_ai', model = ?, revision = revision + 1,
              last_updated_by_person_id = NULL, last_operation_id = ?,
              updated_at = unixepoch()
        WHERE organisation_id = ?`,
      ).bind(
        WORKERS_AI_MODEL,
        `evaluation-fixture-ai:${crypto.randomUUID()}`,
        DEMO_ORGANISATION_ID,
      ),
      env.DB.prepare(
        `INSERT INTO sender_profiles (
         id, event_id, name, from_name, from_email, reply_to_email,
         provider, provider_sender_id, status, created_at, updated_at
       ) VALUES (?, ?, 'Program Cue evaluation sender', ?, ?, NULL,
                 'resend', ?, 'verified', unixepoch(), unixepoch())`,
      ).bind(
        EVALUATION_SENDER_ID,
        DEMO_EVENT_ID,
        sender.name,
        sender.address,
        sender.providerDomain.id,
      ),
      env.DB.prepare(
        `INSERT INTO memberships (
       id, organisation_id, event_id, person_id, role,
         invited_at, accepted_at, revoked_at, last_operation_id, created_at
       ) VALUES (?, ?, NULL, ?, 'administrator', NULL, unixepoch(),
                 NULL, ?, unixepoch())
       ON CONFLICT(id) DO UPDATE SET
         accepted_at = unixepoch(),
         revoked_at = NULL,
         last_operation_id = excluded.last_operation_id
       WHERE memberships.organisation_id = excluded.organisation_id
         AND memberships.event_id IS NULL
         AND memberships.person_id = excluded.person_id
         AND memberships.role = excluded.role`,
      ).bind(
        EVALUATION_ORGANIZER_MEMBERSHIP_ID,
        DEMO_ORGANISATION_ID,
        SBEK_FIXTURE_PEOPLE.organizer.personId,
        `evaluation-fixture-membership:${crypto.randomUUID()}`,
      ),
      ...(fixtureScope.auxiliaryPeople.length
        ? [
            env.DB.prepare(
              `DELETE FROM verification_tokens
              WHERE identifier COLLATE NOCASE IN (${fixtureScope.auxiliaryPeople.map(() => "?").join(",")})
                 OR CASE WHEN json_valid(value)
                         THEN json_extract(value, '$.email') END COLLATE NOCASE
                    IN (${fixtureScope.auxiliaryPeople.map(() => "?").join(",")})
                 OR CASE WHEN json_valid(value)
                         THEN json_extract(value, '$.link.email') END COLLATE NOCASE
                    IN (${fixtureScope.auxiliaryPeople.map(() => "?").join(",")})
                 OR CASE WHEN json_valid(value)
                         THEN json_extract(value, '$.link.userId') END
                    IN (${fixtureScope.auxiliaryPeople.map(() => "?").join(",")})`,
            ).bind(
              ...fixtureScope.auxiliaryPeople.map((person) => person.email),
              ...fixtureScope.auxiliaryPeople.map((person) => person.email),
              ...fixtureScope.auxiliaryPeople.map((person) => person.email),
              ...fixtureScope.auxiliaryPeople.map((person) => person.id),
            ),
          ]
        : []),
      ...(fixtureScope.auxiliaryPeople.length
        ? [
            env.DB.prepare(
              `DELETE FROM people
              WHERE id IN (${fixtureScope.auxiliaryPeople.map(() => "?").join(",")})`,
            ).bind(...fixtureScope.auxiliaryPeople.map((person) => person.id)),
          ]
        : []),
    ]);

    const evidence = await productionEvidence(
      env,
      emails,
      fixtureScope.identityEmails,
    );
    if (!fixtureIsComplete(evidence)) {
      throw new Error("The production evaluation fixture is incomplete.");
    }
    await assertEvaluationFixtureResetOwner(env, fixtureAttemptId);
    const fixtureGeneration = crypto.randomUUID();
    await completeEvaluationFixtureReset(
      env,
      fixtureAttemptId,
      fixtureGeneration,
      {
        provider: "resend",
        senderDomain: sender.domainName,
        aiProvider: "workers_ai",
        aiModel: WORKERS_AI_MODEL,
        retiredEventCount,
        removedAuxiliaryPersonCount: fixtureScope.auxiliaryPeople.length,
      },
    );
    return { ...seeded, evidence };
  } catch (error) {
    try {
      await markEvaluationFixtureResetFailed(env, fixtureAttemptId, error);
    } catch (ownershipError) {
      throw new AggregateError(
        [error, ownershipError],
        "The production evaluation fixture reset failed after losing its ownership claim.",
      );
    }
    throw error;
  }
}
