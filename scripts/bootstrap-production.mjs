import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { randomUUID } from "node:crypto";

import { unstable_readConfig } from "wrangler";

const PREFLIGHT_TIMEOUT_MS = 30_000;
const REMOTE_BOOTSTRAP_TIMEOUT_MS = 5 * 60_000;

const HELP = `Usage:
  npm run db:bootstrap:production -- \\
    --owner-email owner@example.com \\
    --owner-name "Owner Name" \\
    --organisation-name "Organisation" \\
    --organisation-slug organisation \\
    --event-name "Event Name" \\
    --timezone America/Toronto \\
    --start-date 2027-05-20 \\
    --end-date 2027-05-22 \\
    --yes

This is a one-time production command. It requires an empty migrated D1 database
and uses DEFAULT_EVENT_ID and PUBLIC_EVENT_SLUG from wrangler.jsonc. It creates
the first Better Auth person, organisation-wide owner membership, and event.
`;

function fail(message) {
  throw new Error(message);
}

function required(values, name) {
  const value = values[name];
  if (typeof value !== "string" || !value.trim())
    fail(`--${name.replaceAll("_", "-")} is required.`);
  return value.trim();
}

function sqlString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function exactDate(value, name) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    fail(`--${name} must use YYYY-MM-DD.`);
  const date = new Date(`${value}T00:00:00Z`);
  if (
    !Number.isFinite(date.valueOf()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    fail(`--${name} must be a real calendar date.`);
  }
  return value;
}

function epoch(date, endOfDay = false) {
  return Math.floor(
    Date.parse(`${date}T${endOfDay ? "23:59:59" : "00:00:00"}Z`) / 1_000,
  );
}

function validateSlug(value, name) {
  if (value.length > 120 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) {
    fail(
      `${name} must contain only lowercase letters, numbers, and single hyphens.`,
    );
  }
  return value;
}

function bootstrapSql(input) {
  const organisationId = randomUUID();
  const personId = randomUUID();
  const membershipId = randomUUID();
  const auditId = randomUUID();
  const guardName = `program_cue_bootstrap_${randomUUID().replaceAll("-", "_")}`;
  const filePolicyJson = JSON.stringify({
    headshotMaximumBytes: 10 * 1_048_576,
    slidesMaximumBytes: 100 * 1_048_576,
    supportingDocumentMaximumBytes: 100 * 1_048_576,
    videoMaximumBytes: 1_024 * 1_048_576,
  });
  const sessionFormatsJson = JSON.stringify([
    {
      key: "keynote",
      label: "Keynote",
      defaultDurationMinutes: 60,
      position: 0,
    },
    {
      key: "presentation",
      label: "Presentation",
      defaultDurationMinutes: 45,
      position: 1,
    },
    { key: "panel", label: "Panel", defaultDurationMinutes: 60, position: 2 },
    {
      key: "workshop",
      label: "Workshop",
      defaultDurationMinutes: 90,
      position: 3,
    },
    {
      key: "breakout",
      label: "Breakout",
      defaultDurationMinutes: 45,
      position: 4,
    },
    { key: "break", label: "Break", defaultDurationMinutes: 30, position: 5 },
    { key: "other", label: "Other", defaultDurationMinutes: 30, position: 6 },
  ]);
  return `PRAGMA foreign_keys = ON;
CREATE TRIGGER ${guardName}
BEFORE INSERT ON organisations
WHEN EXISTS (SELECT 1 FROM organisations)
  OR EXISTS (SELECT 1 FROM events)
  OR EXISTS (SELECT 1 FROM people)
  OR EXISTS (SELECT 1 FROM memberships)
BEGIN
  SELECT RAISE(ABORT, 'Production bootstrap requires an empty application database');
END;

INSERT INTO organisations (id, name, slug, created_at, updated_at)
VALUES (${sqlString(organisationId)}, ${sqlString(input.organisationName)}, ${sqlString(input.organisationSlug)}, unixepoch(), unixepoch());

INSERT INTO people (
  id, email, display_name, email_verified, profile_status, created_at, updated_at
) VALUES (
  ${sqlString(personId)}, ${sqlString(input.ownerEmail)}, ${sqlString(input.ownerName)},
  0, 'draft', unixepoch(), unixepoch()
);

INSERT INTO events (
  id, organisation_id, name, slug, timezone, starts_at, ends_at,
  session_formats_json, file_policy_json, last_updated_by_person_id, created_at, updated_at
) VALUES (
  ${sqlString(input.eventId)}, ${sqlString(organisationId)}, ${sqlString(input.eventName)},
  ${sqlString(input.eventSlug)}, ${sqlString(input.timezone)}, ${input.startsAt}, ${input.endsAt},
  ${sqlString(sessionFormatsJson)}, ${sqlString(filePolicyJson)}, ${sqlString(personId)}, unixepoch(), unixepoch()
);

INSERT INTO memberships (
  id, organisation_id, event_id, person_id, role, invited_at, accepted_at, created_at
) VALUES (
  ${sqlString(membershipId)}, ${sqlString(organisationId)}, NULL, ${sqlString(personId)},
  'owner', unixepoch(), unixepoch(), unixepoch()
);

INSERT INTO audit_events (
  id, organisation_id, event_id, actor_person_id, action,
  entity_type, entity_id, metadata_json, created_at
) VALUES (
  ${sqlString(auditId)}, ${sqlString(organisationId)}, ${sqlString(input.eventId)},
  ${sqlString(personId)}, 'production.bootstrap.completed', 'event', ${sqlString(input.eventId)},
  ${sqlString(JSON.stringify({ ownerEmail: input.ownerEmail }))}, unixepoch()
);

DROP TRIGGER ${guardName};
`;
}

async function main() {
  const { values } = parseArgs({
    options: {
      "owner-email": { type: "string" },
      "owner-name": { type: "string" },
      "organisation-name": { type: "string" },
      "organisation-slug": { type: "string" },
      "event-name": { type: "string" },
      timezone: { type: "string" },
      "start-date": { type: "string" },
      "end-date": { type: "string" },
      yes: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
  if (values.help) {
    console.log(HELP);
    return;
  }
  if (!values.yes)
    fail("Refusing to bootstrap without the explicit --yes confirmation.");

  const ownerEmail = required(values, "owner-email").toLowerCase();
  if (
    ownerEmail.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail)
  ) {
    fail("--owner-email must be a valid email address.");
  }
  const ownerName = required(values, "owner-name");
  const organisationName = required(values, "organisation-name");
  const organisationSlug = validateSlug(
    required(values, "organisation-slug"),
    "Organisation slug",
  );
  const eventName = required(values, "event-name");
  const timezone = required(values, "timezone");
  try {
    new Intl.DateTimeFormat("en", { timeZone: timezone }).format(0);
  } catch {
    fail("--timezone must be a valid IANA timezone.");
  }
  const startDate = exactDate(required(values, "start-date"), "start-date");
  const endDate = exactDate(required(values, "end-date"), "end-date");
  if (endDate < startDate) fail("--end-date cannot be before --start-date.");

  const configPath = "wrangler.jsonc";
  const config = unstable_readConfig(
    { config: configPath },
    { hideWarnings: true },
  );
  if (
    config.vars?.APP_ENV !== "production" ||
    config.vars?.DEMO_MODE !== "false"
  ) {
    fail(
      "Production bootstrap requires APP_ENV=production and DEMO_MODE=false.",
    );
  }
  const eventId = String(config.vars?.DEFAULT_EVENT_ID ?? "").trim();
  if (!eventId) fail("DEFAULT_EVENT_ID must be configured before bootstrap.");
  const eventSlug = validateSlug(
    String(config.vars?.PUBLIC_EVENT_SLUG ?? "").trim(),
    "PUBLIC_EVENT_SLUG",
  );
  const database = config.d1_databases?.find(
    (binding) => binding.binding === "DB",
  );
  if (!database?.database_name)
    fail("The production DB binding must name a D1 database.");

  const preflight = spawnSync(
    process.execPath,
    ["scripts/validate-deploy-config.mjs"],
    {
      stdio: "inherit",
      timeout: PREFLIGHT_TIMEOUT_MS,
    },
  );
  if (preflight.status !== 0)
    fail("Production configuration preflight failed.");

  const directory = await mkdtemp(join(tmpdir(), "program-cue-bootstrap-"));
  const file = join(directory, "bootstrap.sql");
  try {
    await writeFile(
      file,
      bootstrapSql({
        ownerEmail,
        ownerName,
        organisationName,
        organisationSlug,
        eventId,
        eventName,
        eventSlug,
        timezone,
        startsAt: epoch(startDate),
        endsAt: epoch(endDate, true),
      }),
      { mode: 0o600 },
    );
    const result = spawnSync(
      process.platform === "win32" ? "npx.cmd" : "npx",
      [
        "--no-install",
        "wrangler",
        "d1",
        "execute",
        database.database_name,
        "--remote",
        "-c",
        configPath,
        "--file",
        file,
        "--yes",
      ],
      { stdio: "inherit", timeout: REMOTE_BOOTSTRAP_TIMEOUT_MS },
    );
    if (result.error?.code === "ETIMEDOUT") {
      fail(
        "Production bootstrap timed out with an unknown remote completion state. Inspect the D1 database before retrying.",
      );
    }
    if (result.error) throw result.error;
    if (result.status !== 0)
      fail(
        "Production bootstrap failed; D1 did not accept the atomic bootstrap batch.",
      );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  console.log(
    `Production bootstrap complete for ${ownerEmail}. Request a magic link at ${config.vars?.BETTER_AUTH_URL}/sign-in.`,
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
