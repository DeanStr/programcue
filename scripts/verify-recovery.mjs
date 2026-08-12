import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = process.cwd();
const wrangler = resolve(projectRoot, "node_modules/.bin/wrangler");
const migrationsDirectory = resolve(projectRoot, "migrations");
const database = "program-cue-db";

function fail(message) {
  throw new Error(`Recovery drill failed: ${message}`);
}

function runWrangler(cwd, config, args, { json = false } = {}) {
  const result = spawnSync(
    wrangler,
    [
      ...args,
      "--local",
      "--cwd",
      cwd,
      "--config",
      config,
      ...(json ? ["--json"] : []),
    ],
    { cwd: projectRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.stdout.write(result.stdout);
    fail(`Wrangler exited with status ${result.status ?? "unknown"}.`);
  }
  return result.stdout;
}

function parseResults(output) {
  const parsed = JSON.parse(output);
  if (!Array.isArray(parsed) || parsed.some((entry) => entry.success !== true))
    fail("D1 returned an unsuccessful query result.");
  return parsed;
}

function quoteIdentifier(identifier) {
  if (!/^[a-z][a-z0-9_]*$/u.test(identifier))
    fail(`Unsafe table name ${identifier}.`);
  return `"${identifier}"`;
}

async function inspectDatabase(cwd, config, tables) {
  const countStatements = tables.map(
    (table) =>
      `SELECT '${table}' AS tableName, COUNT(*) AS rowCount FROM ${quoteIdentifier(table)}`,
  );
  const statements = [
    ...countStatements,
    "SELECT COUNT(*) AS indexCount FROM sqlite_schema WHERE type = 'index' AND name NOT LIKE 'sqlite_%'",
    "SELECT COUNT(*) AS triggerCount FROM sqlite_schema WHERE type = 'trigger'",
    "PRAGMA foreign_key_check",
    "PRAGMA quick_check",
  ].join("; ");
  const results = parseResults(
    runWrangler(
      cwd,
      config,
      ["d1", "execute", database, "--command", statements],
      { json: true },
    ),
  );
  const expectedResults = countStatements.length + 4;
  if (results.length !== expectedResults)
    fail(
      `Expected ${expectedResults} inspection result sets, received ${results.length}.`,
    );
  const counts = Object.fromEntries(
    results
      .slice(0, countStatements.length)
      .flatMap((result) => result.results)
      .map((row) => [String(row.tableName), Number(row.rowCount)]),
  );
  if (Object.keys(counts).length !== tables.length)
    fail(
      `Expected ${tables.length} table counts, received ${Object.keys(counts).length}.`,
    );
  const indexResult = results[countStatements.length];
  const triggerResult = results[countStatements.length + 1];
  const foreignKeyResult = results[countStatements.length + 2];
  const integrityResult = results[countStatements.length + 3];
  if (foreignKeyResult.results.length !== 0)
    fail("Foreign-key violations were found.");
  if (integrityResult.results[0]?.quick_check !== "ok")
    fail("SQLite quick_check did not return ok.");
  return {
    counts,
    indexCount: Number(indexResult.results[0]?.indexCount),
    triggerCount: Number(triggerResult.results[0]?.triggerCount),
  };
}

const representativeSeedSql = `
INSERT INTO organisations (id,name,slug,created_at,updated_at)
VALUES ('recovery-org','Recovery Drill','recovery-drill',1700000000,1700000000);
INSERT INTO people (id,email,display_name,email_verified,profile_status,created_at,updated_at)
VALUES
  ('recovery-admin','recovery-admin@example.invalid','Recovery Administrator',1,'published',1700000000,1700000000),
  ('recovery-speaker','recovery-speaker@example.invalid','Recovery Speaker',1,'published',1700000000,1700000000);
INSERT INTO events (
  id,organisation_id,name,slug,timezone,starts_at,ends_at,venue_name,city,
  session_formats_json,file_policy_json,last_updated_by_person_id,programme_published_at,created_at,updated_at
) VALUES (
  'recovery-event','recovery-org','Recovery Conference','recovery-conference','UTC',
  1800000000,1800086400,'Recovery Hall','Test City',
  '[{"key":"keynote","label":"Keynote","defaultDurationMinutes":60,"position":0},{"key":"presentation","label":"Presentation","defaultDurationMinutes":45,"position":1},{"key":"panel","label":"Panel","defaultDurationMinutes":60,"position":2},{"key":"workshop","label":"Workshop","defaultDurationMinutes":90,"position":3},{"key":"breakout","label":"Breakout","defaultDurationMinutes":45,"position":4},{"key":"break","label":"Break","defaultDurationMinutes":30,"position":5},{"key":"other","label":"Other","defaultDurationMinutes":30,"position":6}]',
  '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}',
  'recovery-admin',1700000100,1700000000,1700000000
);
INSERT INTO memberships (
  id,organisation_id,event_id,person_id,role,invited_at,accepted_at,created_at
) VALUES (
  'recovery-membership','recovery-org','recovery-event','recovery-admin',
  'administrator',1700000000,1700000000,1700000000
);
INSERT INTO tracks (id,event_id,name,slug,colour_token,position,exclusive,is_public)
VALUES ('recovery-track','recovery-event','Recovery Track','recovery-track','#4f46e5',0,0,1);
INSERT INTO rooms (id,event_id,name,capacity,resources_json,position,status)
VALUES ('recovery-room','recovery-event','Recovery Room',250,'["projector"]',0,'active');
INSERT INTO sessions (
  id,event_id,track_id,title,slug,description,format,duration_minutes,
  expected_attendance,required_resources_json,status,visibility,revision,
  created_at,updated_at
) VALUES (
  'recovery-session','recovery-event','recovery-track','Restored session',
  'restored-session','Cross-table recovery sentinel.','presentation',60,200,
  '["projector"]','published','public',3,1700000000,1700000000
);
INSERT INTO session_speakers (session_id,event_id,person_id,position,role_label,visibility)
VALUES ('recovery-session','recovery-event','recovery-speaker',0,'Presenter','public');
INSERT INTO schedule_versions (
  id,event_id,version_number,name,status,revision,created_by_person_id,created_at,published_at
) VALUES (
  'recovery-schedule','recovery-event',1,'Published recovery schedule','published',2,
  'recovery-admin',1700000000,1700000100
);
INSERT INTO schedule_entries (
  id,event_id,schedule_version_id,session_id,room_id,starts_at,ends_at,revision,
  created_at,updated_at
) VALUES (
  'recovery-entry','recovery-event','recovery-schedule','recovery-session','recovery-room',
  1800003600,1800007200,2,1700000000,1700000000
);
INSERT INTO task_templates (
  id,event_id,name,target_type,task_type,impact,evidence_mode,due_anchor,
  fixed_due_at,auto_assign_on_acceptance,configuration_json,status,created_at,updated_at
) VALUES (
  'recovery-task-template','recovery-event','Recovery readiness','speaker','file_upload',
  'critical','file','fixed',1799990000,0,'{}','active',1700000000,1700000000
);
INSERT INTO task_instances (
  id,event_id,template_id,target_type,target_id,owner_person_id,title,task_type,
  impact,status,readiness_state,readiness_percent,revision,due_at,created_at,updated_at
) VALUES (
  'recovery-task','recovery-event','recovery-task-template','speaker','recovery-speaker',
  'recovery-speaker','Upload recovery evidence','file_upload','critical','submitted',
  'at_risk',75,4,1799990000,1700000000,1700000000
);
INSERT INTO file_assets (
  id,event_id,owner_person_id,target_type,target_id,asset_kind,status,created_at,updated_at
) VALUES (
  'recovery-asset','recovery-event','recovery-speaker','task','recovery-task',
  'task_evidence','active',1700000000,1700000000
);
INSERT INTO file_versions (
  id,event_id,asset_id,version_number,object_key,original_filename,
  declared_content_type,detected_content_type,size_bytes,checksum_sha256,object_etag,
  upload_status,signature_status,scan_status,scan_provider,scan_result_json,
  created_by_person_id,created_at,uploaded_at,scanned_at,released_at
) VALUES (
  'recovery-file-version','recovery-event','recovery-asset',1,
  'private/events/recovery-event/task/recovery-task/recovery-asset/recovery-file-version',
  'recovery-evidence.pdf','application/pdf','application/pdf',4096,
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','recovery-etag',
  'uploaded','valid','clean','recovery-drill','{"verdict":"clean"}',
  'recovery-speaker',1700000000,1700000010,1700000020,1700000030
);
UPDATE file_assets SET current_version_id = 'recovery-file-version'
WHERE id = 'recovery-asset' AND event_id = 'recovery-event';
INSERT INTO audit_events (
  id,organisation_id,event_id,actor_person_id,action,entity_type,entity_id,
  metadata_json,created_at
) VALUES (
  'recovery-audit','recovery-org','recovery-event','recovery-admin','recovery.sentinel',
  'event','recovery-event','{"drill":true}',1700000040
);
`;

async function inspectRepresentativeChain(cwd, config) {
  const results = parseResults(
    runWrangler(
      cwd,
      config,
      [
        "d1",
        "execute",
        database,
        "--command",
        `SELECT e.name AS eventName, e.timezone, membership.role,
                session.title AS sessionTitle, speaker.email AS speakerEmail,
                schedule.status AS scheduleStatus, entry.starts_at AS startsAt,
                room.name AS roomName, task.status AS taskStatus,
                task.readiness_percent AS readinessPercent,
                asset.status AS assetStatus, asset.current_version_id AS currentVersionId,
                version.object_key AS objectKey, version.checksum_sha256 AS checksum,
                version.scan_status AS scanStatus, audit.action AS auditAction,
                audit.metadata_json AS auditMetadata
           FROM events e
           JOIN memberships membership
             ON membership.event_id = e.id AND membership.id = 'recovery-membership'
           JOIN sessions session
             ON session.event_id = e.id AND session.id = 'recovery-session'
           JOIN session_speakers relation
             ON relation.event_id = e.id AND relation.session_id = session.id
           JOIN people speaker ON speaker.id = relation.person_id
           JOIN schedule_entries entry
             ON entry.event_id = e.id AND entry.session_id = session.id
           JOIN schedule_versions schedule
             ON schedule.event_id = e.id AND schedule.id = entry.schedule_version_id
           JOIN rooms room ON room.event_id = e.id AND room.id = entry.room_id
           JOIN task_instances task
             ON task.event_id = e.id AND task.id = 'recovery-task'
           JOIN file_assets asset
             ON asset.event_id = e.id AND asset.target_id = task.id
           JOIN file_versions version
             ON version.event_id = e.id AND version.id = asset.current_version_id
           JOIN audit_events audit
             ON audit.event_id = e.id AND audit.id = 'recovery-audit'
          WHERE e.id = 'recovery-event'`,
      ],
      { json: true },
    ),
  );
  if (results.length !== 1 || results[0].results.length !== 1)
    fail(
      "The representative event relationship chain was not restored exactly once.",
    );
  const row = results[0].results[0];
  const expected = {
    eventName: "Recovery Conference",
    timezone: "UTC",
    role: "administrator",
    sessionTitle: "Restored session",
    speakerEmail: "recovery-speaker@example.invalid",
    scheduleStatus: "published",
    startsAt: 1800003600,
    roomName: "Recovery Room",
    taskStatus: "submitted",
    readinessPercent: 75,
    assetStatus: "active",
    currentVersionId: "recovery-file-version",
    objectKey:
      "private/events/recovery-event/task/recovery-task/recovery-asset/recovery-file-version",
    checksum:
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    scanStatus: "clean",
    auditAction: "recovery.sentinel",
    auditMetadata: '{"drill":true}',
  };
  if (JSON.stringify(row) !== JSON.stringify(expected))
    fail(
      `The representative event values changed during recovery: ${JSON.stringify(row)}.`,
    );
  return row;
}

const temporaryRoot = await mkdtemp(join(tmpdir(), "programcue-recovery-"));
const sourceCwd = join(temporaryRoot, "source");
const restoreCwd = join(temporaryRoot, "restore");
const backup = join(temporaryRoot, "program-cue.sql");

try {
  await Promise.all([mkdir(sourceCwd), mkdir(restoreCwd)]);
  const recoveryConfig = {
    name: "program-cue-recovery-drill",
    compatibility_date: "2026-08-08",
    d1_databases: [
      {
        binding: "DB",
        database_name: database,
        database_id: "00000000-0000-0000-0000-000000000000",
      },
    ],
  };
  const sourceConfig = join(sourceCwd, "wrangler.jsonc");
  const restoreConfig = join(restoreCwd, "wrangler.jsonc");
  await Promise.all([
    writeFile(sourceConfig, JSON.stringify(recoveryConfig)),
    writeFile(restoreConfig, JSON.stringify(recoveryConfig)),
  ]);
  const migrations = (await readdir(migrationsDirectory))
    .filter((entry) => entry.endsWith(".sql"))
    .sort()
    .map((entry) => resolve(migrationsDirectory, entry));
  const migrationSql = (
    await Promise.all(migrations.map((migration) => readFile(migration, "utf8")))
  ).join("\n");
  // Build the final application inventory rather than counting CREATE TABLE
  // tokens. A numbered migration may rebuild a table by renaming the old
  // definition, creating the replacement, then dropping the legacy name.
  // Counting raw CREATE statements would reject that valid migration shape.
  const tables = new Set();
  for (const statement of migrationSql.split(/;\s*(?:\r?\n|$)/u)) {
    const create = statement.match(
      /(?:^|\n)CREATE TABLE(?: IF NOT EXISTS)? ([a-z][a-z0-9_]*)/u,
    );
    const rename = statement.match(
      /(?:^|\n)ALTER TABLE ([a-z][a-z0-9_]*) RENAME TO ([a-z][a-z0-9_]*)/u,
    );
    const drop = statement.match(
      /(?:^|\n)DROP TABLE(?: IF EXISTS)? ([a-z][a-z0-9_]*)/u,
    );
    if (create) tables.add(create[1]);
    if (rename) {
      tables.delete(rename[1]);
      tables.add(rename[2]);
    }
    if (drop) tables.delete(drop[1]);
  }
  const tableInventory = [...tables];
  if (tableInventory.length === 0)
    fail(
      "The baseline migration did not expose a unique application table inventory.",
    );

  for (const migration of migrations) {
    runWrangler(sourceCwd, sourceConfig, [
      "d1",
      "execute",
      database,
      "--file",
      migration,
      "--yes",
    ]);
  }
  runWrangler(sourceCwd, sourceConfig, [
    "d1",
    "execute",
    database,
    "--command",
    representativeSeedSql,
    "--yes",
  ]);
  const source = await inspectDatabase(sourceCwd, sourceConfig, tableInventory);
  const sourceChain = await inspectRepresentativeChain(sourceCwd, sourceConfig);

  runWrangler(sourceCwd, sourceConfig, [
    "d1",
    "export",
    database,
    "--output",
    backup,
    "--skip-confirmation",
  ]);
  const backupBytes = await readFile(backup);
  if (backupBytes.byteLength === 0) fail("D1 export produced an empty backup.");

  runWrangler(restoreCwd, restoreConfig, [
    "d1",
    "execute",
    database,
    "--file",
    backup,
    "--yes",
  ]);
  const restored = await inspectDatabase(
    restoreCwd,
    restoreConfig,
    tableInventory,
  );
  const restoredChain = await inspectRepresentativeChain(
    restoreCwd,
    restoreConfig,
  );
  if (JSON.stringify(restored) !== JSON.stringify(source))
    fail("The restored database inventory differs from the source database.");
  if (JSON.stringify(restoredChain) !== JSON.stringify(sourceChain))
    fail("The restored representative event differs from its source values.");
  const expectedNonEmptyCounts = {
    organisations: 1,
    people: 2,
    events: 1,
    memberships: 1,
    schedule_policies: 1,
    tracks: 1,
    rooms: 1,
    sessions: 1,
    session_speakers: 1,
    schedule_versions: 1,
    schedule_entries: 1,
    task_templates: 1,
    task_instances: 1,
    file_assets: 1,
    file_versions: 1,
    audit_events: 1,
  };
  for (const [table, expected] of Object.entries(expectedNonEmptyCounts)) {
    if (restored.counts[table] !== expected)
      fail(
        `Expected ${expected} restored ${table} row(s), received ${restored.counts[table]}.`,
      );
  }

  const digest = createHash("sha256").update(backupBytes).digest("hex");
  console.log(
    `Recovery drill passed: ${tableInventory.length} tables, ${restored.indexCount} indexes, ${restored.triggerCount} triggers, ${backupBytes.byteLength} backup bytes, sha256 ${digest}.`,
  );
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}
