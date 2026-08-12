import { z } from "zod";

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
import { resetDemoEvent } from "~/platform/demo/demo-reset.server";
import { requireRuntimeMode } from "~/platform/runtime-environment.server";

const EVALUATION_SENDER_ID = "sender-production-evaluation-fixture";
const EVALUATION_ORGANISATION_SLUG = "future-events-association";
const EVALUATION_EVENT_SLUG = "future-of-events-2025";
const EVALUATION_OPERATOR_ACTOR_ID = "production-evaluation-fixture-operator";
const WORKERS_AI_MODEL = "@cf/openai/gpt-oss-120b";
const RESERVED_EMAIL_DOMAIN =
  /(?:^|\.)(?:example(?:\.(?:com|net|org))?|invalid|localhost|test)$/iu;

const deliverableEmailSchema = z
  .email()
  .transform((value) => value.trim().toLowerCase())
  .refine((value) => !RESERVED_EMAIL_DOMAIN.test(value.split("@")[1] ?? ""), {
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
) {
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
    `SELECT id, organisation_id AS organisationId, slug FROM events
      WHERE id = ? OR slug = ?
         OR organisation_id = ?`,
  )
    .bind(DEMO_EVENT_ID, EVALUATION_EVENT_SLUG, DEMO_ORGANISATION_ID)
    .all<{ id: string; organisationId: string; slug: string }>();
  if (
    eventCollision.results.some(
      (row) =>
        row.id !== DEMO_EVENT_ID ||
        row.organisationId !== DEMO_ORGANISATION_ID ||
        row.slug !== EVALUATION_EVENT_SLUG,
    )
  ) {
    throw new Error(
      "The production evaluation fixture requires a dedicated organisation containing only its canonical event.",
    );
  }

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

  const idPlaceholders = targetIds.map(() => "?").join(",");
  const crossTenantIdentity = await env.DB.prepare(
    `SELECT person.id
       FROM people person
      WHERE person.id IN (${idPlaceholders})
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
            SELECT 1 FROM submissions submission
            JOIN events event ON event.id = submission.event_id
             WHERE submission.submitter_person_id = person.id
               AND event.organisation_id <> ?
          )
          OR EXISTS (
            SELECT 1 FROM session_speakers speaker
            JOIN events event ON event.id = speaker.event_id
             WHERE speaker.person_id = person.id
               AND event.organisation_id <> ?
          )
          OR EXISTS (
            SELECT 1 FROM calendar_connections connection
             WHERE connection.person_id = person.id
               AND connection.organisation_id <> ?
          )
        )
      LIMIT 1`,
  )
    .bind(
      ...targetIds,
      DEMO_ORGANISATION_ID,
      DEMO_ORGANISATION_ID,
      DEMO_ORGANISATION_ID,
      DEMO_ORGANISATION_ID,
      DEMO_ORGANISATION_ID,
    )
    .first<{ id: string }>();
  if (crossTenantIdentity) {
    throw new Error(
      `Fixture person ${crossTenantIdentity.id} is linked outside the dedicated evaluation organisation.`,
    );
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
) {
  const identities = Object.entries(emails) as Array<
    [keyof EvaluationFixtureEmails, string]
  >;
  const ids = identities.map(([key]) => SBEK_FIXTURE_PEOPLE[key].personId);
  const tokenEmails = [
    ...Object.values(SBEK_FIXTURE_PEOPLE).map((identity) => identity.email),
    ...Object.values(emails),
  ];
  const row = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM people
         WHERE ${identities.map(() => "(id = ? AND email = ? COLLATE NOCASE)").join(" OR ")}) AS fixturePeople,
       (SELECT COUNT(*) FROM people
         WHERE id IN (${ids.map(() => "?").join(",")})
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
         WHERE organisation_id = ? AND provider = 'workers_ai' AND model = ?) AS workersAiSettings`,
  )
    .bind(
      ...identities.flatMap(([key, email]) => [
        SBEK_FIXTURE_PEOPLE[key].personId,
        email,
      ]),
      ...ids,
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
    evidence.workersAiSettings === 1
  );
}

export async function resetProductionEvaluationFixture(
  env: CloudflareEnvironment,
  confirmation: unknown,
  domains?: DomainReader,
) {
  const runtime = requireRuntimeMode(env);
  if (runtime.appEnvironment !== "production" || runtime.demo) {
    throw new Error(
      "The production evaluation fixture can run only in the ordinary production runtime.",
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
  await assertDedicatedFixtureIdentity(env, emails);
  const sender = await verifiedSender(
    env,
    domains ?? evaluationDomainReader(env),
  );

  const seeded = await resetDemoEvent(
    demoSeedEnvironment(env),
    null,
    confirmation,
    EVALUATION_OPERATOR_ACTOR_ID,
  );
  const fixtureEntries = Object.entries(emails) as Array<
    [keyof EvaluationFixtureEmails, string]
  >;
  const fixtureIds = fixtureEntries.map(
    ([key]) => SBEK_FIXTURE_PEOPLE[key].personId,
  );
  const oldAndNewEmails = [
    ...Object.values(SBEK_FIXTURE_PEOPLE).map((identity) => identity.email),
    ...Object.values(emails),
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
      `INSERT INTO audit_events (
         id, organisation_id, event_id, actor_id, action,
         entity_type, entity_id, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, 'evaluation.fixture.reset', 'event', ?, ?, unixepoch())`,
    ).bind(
      crypto.randomUUID(),
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      EVALUATION_OPERATOR_ACTOR_ID,
      DEMO_EVENT_ID,
      JSON.stringify({
        provider: "resend",
        senderDomain: sender.domainName,
        aiProvider: "workers_ai",
        aiModel: WORKERS_AI_MODEL,
      }),
    ),
  ]);

  const evidence = await productionEvidence(env, emails);
  if (!fixtureIsComplete(evidence)) {
    throw new Error("The production evaluation fixture is incomplete.");
  }
  return { ...seeded, evidence };
}
