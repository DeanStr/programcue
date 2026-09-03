import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePackageExecutable } from "./package-executable.mjs";
import { validateRemotePublicSiteSchema } from "./validate-remote-public-site-schema.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REMOTE_SCHEMA_TIMEOUT_MS = 60_000;
export const lastImmutableMigrationName =
  "0032_event_brand_asset_normalization.sql";
export const reviewerAiMigrationName = "0036_reviewer_ai_hardening.sql";
export const publicSiteMigrationName = "0037_public_event_site.sql";
export const publicSiteRelationshipGuardMigrationName =
  "0039_featured_speaker_relationship_guards.sql";
export const publicSiteProgrammeMembershipGuardMigrationName =
  "0040_align_featured_speaker_session_guard.sql";
export const publicSpeakerConfirmationGuardMigrationName =
  "0042_confirmed_public_speaker_eligibility.sql";
export const speakerRelationshipIdentityGuardMigrationName =
  "0043_session_speaker_identity_immutable.sql";
export const taskInstanceConfigurationSnapshotMigrationName =
  "0049_task_instance_configuration_snapshot.sql";
export const sessionParticipationDecisionsMigrationName =
  "0050_session_participation_decisions.sql";

export const requiredSessionParticipationDecisionColumns = new Map([
  [
    "participation_revision",
    { type: "INTEGER", notnull: 1, defaultValue: "1" },
  ],
  [
    "participation_declined_at",
    { type: "INTEGER", notnull: 0, defaultValue: null },
  ],
  [
    "participation_decline_reason",
    { type: "TEXT", notnull: 0, defaultValue: null },
  ],
]);

export const pendingTaskConfigurationInventoryQuery = `SELECT 'template' AS recordType, template.id AS recordId,
            template.task_type AS taskType, template.target_type AS targetType,
            template.configuration_json AS configurationJson
       FROM task_templates template
      WHERE template.task_type IN ('link_visit', 'file_upload')
        AND (template.status = 'active' OR EXISTS (
          SELECT 1 FROM task_instances linked
           WHERE linked.template_id = template.id
             AND linked.event_id = template.event_id
        ))
      UNION ALL
     SELECT 'instance' AS recordType, instance.id AS recordId,
            instance.task_type AS taskType, instance.target_type AS targetType,
            template.configuration_json AS configurationJson
       FROM task_instances instance
       LEFT JOIN task_templates template
         ON template.id = instance.template_id
        AND template.event_id = instance.event_id
      WHERE (instance.task_type IN ('link_visit', 'file_upload')
          OR template.task_type IN ('link_visit', 'file_upload'))
        AND (template.id IS NULL
          OR template.task_type <> instance.task_type
          OR template.target_type <> instance.target_type)`;

export const requiredBrandAssetColumns = new Map([
  ["width_px", { type: "INTEGER", notnull: 0, defaultValue: null }],
  ["height_px", { type: "INTEGER", notnull: 0, defaultValue: null }],
  ["normalizer_version", { type: "TEXT", notnull: 0, defaultValue: null }],
  ["normalized_at", { type: "INTEGER", notnull: 0, defaultValue: null }],
  ["cleanup_attempts", { type: "INTEGER", notnull: 1, defaultValue: "0" }],
  [
    "cleanup_last_attempt_at",
    { type: "INTEGER", notnull: 0, defaultValue: null },
  ],
  ["cleanup_last_error", { type: "TEXT", notnull: 0, defaultValue: null }],
]);

export const requiredBrandSchemaObjects = new Map([
  ["idx_event_brand_assets_cleanup", "index"],
  ["event_brand_assets_ready_insert", "trigger"],
  ["event_brand_assets_ready_update", "trigger"],
  ["event_brand_assets_identity_immutable", "trigger"],
  ["event_brand_assets_no_restore", "trigger"],
  ["event_brand_assets_no_retire_while_referenced", "trigger"],
  ["event_brand_assets_no_delete_while_referenced", "trigger"],
  ["events_no_delete_with_brand_assets", "trigger"],
  ["events_brand_assets_ready_insert", "trigger"],
  ["events_brand_assets_ready_update", "trigger"],
  ["events_retire_unreferenced_brand_assets", "trigger"],
]);

export const requiredReviewerAiReviewColumns = new Map([
  ["ai_suggestion_id", { type: "TEXT", notnull: 0, defaultValue: null }],
  [
    "imported_criterion_ids_json",
    { type: "TEXT", notnull: 1, defaultValue: "'[]'" },
  ],
  [
    "confirmed_ai_criterion_ids_json",
    { type: "TEXT", notnull: 1, defaultValue: "'[]'" },
  ],
]);

export const requiredReviewerAiSuggestionColumns = new Map([
  ["event_id", { type: "TEXT", notnull: 1, defaultValue: null }],
  ["assignment_id", { type: "TEXT", notnull: 1, defaultValue: null }],
  ["evaluator_person_id", { type: "TEXT", notnull: 1, defaultValue: null }],
  ["status", { type: "TEXT", notnull: 1, defaultValue: "'offered'" }],
  ["lifecycle_operation_id", { type: "TEXT", notnull: 0, defaultValue: null }],
  ["last_operation_id", { type: "TEXT", notnull: 1, defaultValue: null }],
]);

export const requiredReviewerAiSchemaObjects = new Map([
  ["idx_reviewer_ai_suggestions_assignment", "index"],
  ["ux_reviewer_ai_suggestions_active", "index"],
  ["idx_reviewer_ai_operations_organisation_usage", "index"],
  ["idx_reviewer_ai_operations_assignment_usage", "index"],
  ["reviewer_ai_suggestions_assignment_provenance_insert", "trigger"],
  ["reviewer_ai_suggestions_generated_fields_immutable", "trigger"],
  ["reviewer_ai_suggestions_lifecycle", "trigger"],
  ["reviewer_ai_suggestions_participant_retention_no_pii_insert", "trigger"],
  ["reviews_ai_suggestion_provenance_insert", "trigger"],
  ["reviews_ai_suggestion_provenance_update", "trigger"],
  ["reviewer_ai_suggestions_import_requires_review", "trigger"],
  ["reviewer_ai_suggestions_dismiss_requires_unreferenced", "trigger"],
  ["review_revisions_ai_suggestion_provenance_insert", "trigger"],
  ["review_revisions_ai_suggestion_provenance_update", "trigger"],
]);

export const requiredPublicSiteColumns = new Map([
  [
    "event_public_sites",
    new Map([
      ["event_id", { type: "TEXT", notnull: 0, defaultValue: null, pk: 1 }],
      ["organisation_id", { type: "TEXT", notnull: 1, defaultValue: null }],
      ["draft_json", { type: "TEXT", notnull: 1, defaultValue: null }],
      ["draft_revision", { type: "INTEGER", notnull: 1, defaultValue: "1" }],
      ["published_json", { type: "TEXT", notnull: 0, defaultValue: null }],
      [
        "published_revision",
        { type: "INTEGER", notnull: 0, defaultValue: null },
      ],
      ["published_at", { type: "INTEGER", notnull: 0, defaultValue: null }],
      ["last_operation_id", { type: "TEXT", notnull: 1, defaultValue: null }],
    ]),
  ],
  [
    "event_public_site_references",
    new Map([
      ["event_id", { type: "TEXT", notnull: 1, defaultValue: null, pk: 1 }],
      ["organisation_id", { type: "TEXT", notnull: 1, defaultValue: null }],
      ["kind", { type: "TEXT", notnull: 1, defaultValue: null, pk: 2 }],
      ["record_id", { type: "TEXT", notnull: 1, defaultValue: null, pk: 3 }],
      ["site_revision", { type: "INTEGER", notnull: 1, defaultValue: null }],
    ]),
  ],
  [
    "event_site_sponsors",
    new Map([
      ["id", { type: "TEXT", notnull: 0, defaultValue: null, pk: 1 }],
      ["organisation_id", { type: "TEXT", notnull: 1, defaultValue: null }],
      ["event_id", { type: "TEXT", notnull: 1, defaultValue: null }],
      ["revision", { type: "INTEGER", notnull: 1, defaultValue: "1" }],
      ["last_operation_id", { type: "TEXT", notnull: 1, defaultValue: null }],
    ]),
  ],
  [
    "event_session_recordings",
    new Map([
      ["id", { type: "TEXT", notnull: 0, defaultValue: null, pk: 1 }],
      ["organisation_id", { type: "TEXT", notnull: 1, defaultValue: null }],
      ["event_id", { type: "TEXT", notnull: 1, defaultValue: null }],
      ["session_id", { type: "TEXT", notnull: 1, defaultValue: null }],
      ["draft_revision", { type: "INTEGER", notnull: 1, defaultValue: "1" }],
      ["published_title", { type: "TEXT", notnull: 0, defaultValue: null }],
      [
        "published_recording_url",
        { type: "TEXT", notnull: 0, defaultValue: null },
      ],
      [
        "published_revision",
        { type: "INTEGER", notnull: 0, defaultValue: null },
      ],
      ["published_at", { type: "INTEGER", notnull: 0, defaultValue: null }],
      ["last_operation_id", { type: "TEXT", notnull: 1, defaultValue: null }],
    ]),
  ],
]);

export const requiredPublicSiteSchemaObjects = new Map([
  ["idx_event_site_sponsors_order", "index"],
  ["idx_event_session_recordings_public", "index"],
  ["prevent_referenced_public_session_eligibility_change", "trigger"],
  ["prevent_referenced_public_speaker_profile_demotion", "trigger"],
]);

export const requiredFeaturedSpeakerRelationshipObjects = new Map([
  [
    "prevent_referenced_public_speaker_relationship_visibility_change",
    "trigger",
  ],
  ["prevent_referenced_public_speaker_relationship_delete", "trigger"],
]);

export const requiredSpeakerRelationshipIdentityObjects = new Map([
  ["session_speakers_identity_immutable", "trigger"],
]);

export const requiredPublicSiteForeignKeys = [
  {
    tableName: "event_public_sites",
    targetTable: "events",
    columns: [
      ["event_id", "id"],
      ["organisation_id", "organisation_id"],
    ],
    onDelete: "CASCADE",
  },
  {
    tableName: "event_public_sites",
    targetTable: "people",
    columns: [["last_updated_by_person_id", "id"]],
    onDelete: "NO ACTION",
  },
  {
    tableName: "event_public_site_references",
    targetTable: "events",
    columns: [
      ["event_id", "id"],
      ["organisation_id", "organisation_id"],
    ],
    onDelete: "CASCADE",
  },
  {
    tableName: "event_public_site_references",
    targetTable: "event_public_sites",
    columns: [["event_id", "event_id"]],
    onDelete: "CASCADE",
  },
  {
    tableName: "event_site_sponsors",
    targetTable: "events",
    columns: [
      ["event_id", "id"],
      ["organisation_id", "organisation_id"],
    ],
    onDelete: "CASCADE",
  },
  {
    tableName: "event_site_sponsors",
    targetTable: "people",
    columns: [["last_updated_by_person_id", "id"]],
    onDelete: "NO ACTION",
  },
  {
    tableName: "event_session_recordings",
    targetTable: "events",
    columns: [
      ["event_id", "id"],
      ["organisation_id", "organisation_id"],
    ],
    onDelete: "CASCADE",
  },
  {
    tableName: "event_session_recordings",
    targetTable: "sessions",
    columns: [
      ["session_id", "id"],
      ["event_id", "event_id"],
    ],
    onDelete: "CASCADE",
  },
  {
    tableName: "event_session_recordings",
    targetTable: "people",
    columns: [["last_updated_by_person_id", "id"]],
    onDelete: "NO ACTION",
  },
];

function validateColumns(rows, requiredColumns, tableName) {
  const columns = new Map(rows.map((row) => [row.name, row]));
  for (const [name, expected] of requiredColumns) {
    const column = columns.get(name);
    if (
      !column ||
      column.type !== expected.type ||
      column.notnull !== expected.notnull ||
      column.dflt_value !== expected.defaultValue ||
      (Object.hasOwn(expected, "pk") && column.pk !== expected.pk)
    ) {
      throw new Error(
        `Remote D1 ${tableName}.${name} is missing or has the wrong contract.`,
      );
    }
  }
  return columns;
}

function successfulResults(result, label) {
  if (result?.success !== true || !Array.isArray(result.results)) {
    throw new Error(`Remote D1 ${label} query did not succeed.`);
  }
  return result.results;
}

function sameOrder(actual, expected) {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

function credentialFreeHttpsUrl(value) {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" && url.username === "" && url.password === ""
    );
  } catch {
    return false;
  }
}

export function validatePendingTaskConfigurationInventory(rows) {
  const invalid = [];
  for (const row of rows) {
    if (row.recordType === "instance") {
      invalid.push(`instance ${row.recordId ?? "unknown"}`);
      continue;
    }
    let configuration;
    try {
      configuration = JSON.parse(row.configurationJson);
    } catch {
      configuration = null;
    }
    const validObject =
      configuration !== null &&
      typeof configuration === "object" &&
      !Array.isArray(configuration);
    const configurationKeys = validObject ? Object.keys(configuration) : [];
    const validLink =
      row.taskType !== "link_visit" ||
      (validObject &&
        configurationKeys.length === 1 &&
        configurationKeys[0] === "destinationUrl" &&
        typeof configuration.destinationUrl === "string" &&
        configuration.destinationUrl.length <= 2_048 &&
        credentialFreeHttpsUrl(configuration.destinationUrl));
    const validFile =
      row.taskType !== "file_upload" ||
      (validObject &&
        configurationKeys.length === 1 &&
        configurationKeys[0] === "fileScope" &&
        ((configuration.fileScope === "participant_document" &&
          row.targetType === "speaker") ||
          (configuration.fileScope === "session_deliverable" &&
            row.targetType === "session")));
    if (!validLink || !validFile) {
      invalid.push(
        `${row.recordType ?? "record"} ${row.recordId ?? "unknown"}`,
      );
    }
  }
  if (invalid.length > 0) {
    throw new Error(
      `Remote D1 contains legacy participant tasks with invalid configuration (${invalid.join(", ")}). Resolve every reported ID before migration ${taskInstanceConfigurationSnapshotMigrationName}: add an organizer-owned credential-free HTTPS destination to each link template, explicitly classify each file template as a participant document or session deliverable with the matching target, and attach each direct or mismatched instance to an explicitly reviewed matching template or delete it through an approved data-remediation operation. Completing or waiving an instance does not repair its historical snapshot. Participant-entered URLs and inferred file scope are not accepted.`,
    );
  }
  return rows.length;
}

function wranglerFailureMessage(result) {
  const stderr = result.stderr?.trim();
  if (stderr) return stderr;
  try {
    const parsed = JSON.parse(result.stdout);
    const message = parsed?.error?.text;
    if (typeof message === "string" && message.trim()) return message.trim();
  } catch {
    // The stable failure below is preferable to echoing unstructured output.
  }
  return "Wrangler returned no diagnostic.";
}

function executeRemoteCommands(commands, label) {
  const result = spawnSync(
    resolvePackageExecutable("wrangler", "wrangler"),
    [
      "d1",
      "execute",
      "program-cue-db-wnam",
      "--remote",
      "--config",
      resolve(repositoryRoot, "wrangler.jsonc"),
      "--command",
      commands.join("; "),
      "--json",
    ],
    {
      cwd: repositoryRoot,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      timeout: REMOTE_SCHEMA_TIMEOUT_MS,
    },
  );
  if (result.error?.code === "ETIMEDOUT") {
    throw new Error(`Remote D1 ${label} timed out.`);
  }
  if (result.error) {
    throw new Error(`Remote D1 ${label} could not start Wrangler.`);
  }
  if (result.status !== 0) {
    throw new Error(
      `Remote D1 ${label} could not query production: ${wranglerFailureMessage(result)}`,
    );
  }
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    throw new Error(`Remote D1 ${label} received invalid JSON.`);
  }
  if (!Array.isArray(response)) {
    throw new Error(`Remote D1 ${label} received an invalid response.`);
  }
  return response;
}

export function validateRemoteSchemaEvidence(
  response,
  localMigrationNames,
  { allowPendingMigrations = false } = {},
) {
  if (!Array.isArray(response) || response.length !== 13) {
    throw new Error(
      "Remote D1 schema validation returned an unexpected result set.",
    );
  }
  const appliedMigrationNames = successfulResults(
    response[0],
    "migration ledger",
  ).map((row) => row.name);
  const immutableMigrationCount =
    localMigrationNames.indexOf(lastImmutableMigrationName) + 1;
  if (immutableMigrationCount === 0) {
    throw new Error(
      `Local migrations are missing immutable production migration ${lastImmutableMigrationName}.`,
    );
  }
  const expectedAppliedNames = localMigrationNames.slice(
    0,
    appliedMigrationNames.length,
  );
  if (
    appliedMigrationNames.some((name) => typeof name !== "string") ||
    appliedMigrationNames.length < immutableMigrationCount ||
    !sameOrder(appliedMigrationNames, expectedAppliedNames) ||
    (!allowPendingMigrations &&
      appliedMigrationNames.length !== localMigrationNames.length)
  ) {
    const local = new Set(localMigrationNames);
    const applied = new Set(appliedMigrationNames);
    const missing = localMigrationNames.filter((name) => !applied.has(name));
    const unexpected = appliedMigrationNames.filter((name) => !local.has(name));
    const orderMismatch = !sameOrder(
      appliedMigrationNames,
      expectedAppliedNames,
    );
    throw new Error(
      `Remote D1 migration ledger does not match this release (missing: ${missing.join(", ") || "none"}; unexpected: ${unexpected.join(", ") || "none"}; order mismatch: ${orderMismatch ? "yes" : "no"}).`,
    );
  }

  const sessionParticipationDecisionsApplied = appliedMigrationNames.includes(
    sessionParticipationDecisionsMigrationName,
  );
  if (sessionParticipationDecisionsApplied) {
    validateColumns(
      successfulResults(response[12], "session participation decision columns"),
      requiredSessionParticipationDecisionColumns,
      "session_speakers",
    );
  }

  if (
    localMigrationNames.includes(
      taskInstanceConfigurationSnapshotMigrationName,
    ) &&
    !appliedMigrationNames.includes(
      taskInstanceConfigurationSnapshotMigrationName,
    )
  ) {
    validatePendingTaskConfigurationInventory(
      successfulResults(response[11], "legacy participant-task configuration"),
    );
  }

  const quickCheck = successfulResults(response[6], "integrity");
  if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== "ok") {
    throw new Error("Remote D1 quick_check did not return ok.");
  }
  const foreignKeyFailures = successfulResults(
    response[7],
    "foreign-key integrity",
  );
  if (foreignKeyFailures.length > 0) {
    throw new Error("Remote D1 foreign_key_check returned violations.");
  }

  validateColumns(
    successfulResults(response[1], "brand asset columns"),
    requiredBrandAssetColumns,
    "event_brand_assets",
  );

  const objects = new Map(
    successfulResults(response[2], "required schema objects").map((row) => [
      row.name,
      row.type,
    ]),
  );
  for (const [name, type] of requiredBrandSchemaObjects) {
    if (objects.get(name) !== type) {
      throw new Error(`Remote D1 is missing required ${type} ${name}.`);
    }
  }

  const reviewerAiApplied = appliedMigrationNames.includes(
    reviewerAiMigrationName,
  );
  if (reviewerAiApplied) {
    validateColumns(
      successfulResults(response[3], "review AI columns"),
      requiredReviewerAiReviewColumns,
      "reviews",
    );
    validateColumns(
      successfulResults(response[4], "review revision AI columns"),
      requiredReviewerAiReviewColumns,
      "review_revisions",
    );
    const suggestionColumns = validateColumns(
      successfulResults(response[5], "reviewer AI suggestion columns"),
      requiredReviewerAiSuggestionColumns,
      "reviewer_ai_suggestions",
    );
    if (suggestionColumns.has("imported_review_id")) {
      throw new Error(
        "Remote D1 reviewer_ai_suggestions retains redundant imported_review_id.",
      );
    }
    for (const [name, type] of requiredReviewerAiSchemaObjects) {
      if (objects.get(name) !== type) {
        throw new Error(`Remote D1 is missing required ${type} ${name}.`);
      }
    }
    const assignmentUsageIndex = successfulResults(
      response[2],
      "schema objects",
    ).find((row) => row.name === "idx_reviewer_ai_operations_assignment_usage");
    if (
      typeof assignmentUsageIndex?.sql !== "string" ||
      !/created_at\s+DESC/iu.test(assignmentUsageIndex.sql)
    ) {
      throw new Error(
        "Remote D1 reviewer AI assignment usage index does not cover the rolling window.",
      );
    }
  }

  const publicSiteEvidence = validateRemotePublicSiteSchema({
    appliedMigrationNames,
    response,
    objects,
    publicSiteMigrationName,
    publicSiteRelationshipGuardMigrationName,
    publicSiteProgrammeMembershipGuardMigrationName,
    publicSpeakerConfirmationGuardMigrationName,
    speakerRelationshipIdentityGuardMigrationName,
    requiredPublicSiteColumns,
    requiredPublicSiteSchemaObjects,
    requiredFeaturedSpeakerRelationshipObjects,
    requiredSpeakerRelationshipIdentityObjects,
    requiredPublicSiteForeignKeys,
    successfulResults,
    validateColumns,
  });

  return {
    migrationCount: appliedMigrationNames.length,
    pendingMigrationCount:
      localMigrationNames.length - appliedMigrationNames.length,
    brandingColumnCount: requiredBrandAssetColumns.size,
    brandingObjectCount: requiredBrandSchemaObjects.size,
    reviewerAiColumnCount: reviewerAiApplied
      ? requiredReviewerAiReviewColumns.size * 2 +
        requiredReviewerAiSuggestionColumns.size
      : 0,
    reviewerAiObjectCount: reviewerAiApplied
      ? requiredReviewerAiSchemaObjects.size
      : 0,
    publicSiteColumnCount: publicSiteEvidence.publicSiteColumnCount,
    publicSiteObjectCount: publicSiteEvidence.publicSiteObjectCount,
    publicSiteForeignKeyCount: publicSiteEvidence.publicSiteForeignKeyCount,
  };
}

function run() {
  const allowPendingMigrations = process.argv.includes("--before-migrate");
  const localMigrationNames = readdirSync(resolve(repositoryRoot, "migrations"))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/u.test(name))
    .sort();
  const objectNames = [
    ...requiredBrandSchemaObjects.keys(),
    ...requiredReviewerAiSchemaObjects.keys(),
    ...requiredPublicSiteSchemaObjects.keys(),
    ...requiredFeaturedSpeakerRelationshipObjects.keys(),
    ...requiredSpeakerRelationshipIdentityObjects.keys(),
  ]
    .map((name) => `'${name.replaceAll("'", "''")}'`)
    .join(", ");
  const publicSiteColumnQuery = [...requiredPublicSiteColumns.keys()]
    .map(
      (tableName) =>
        `SELECT '${tableName}' AS tableName, name, type, "notnull", dflt_value, pk FROM pragma_table_info('${tableName}')`,
    )
    .join(" UNION ALL ");
  const publicSiteForeignKeyQuery = [...requiredPublicSiteColumns.keys()]
    .map(
      (tableName) =>
        `SELECT '${tableName}' AS tableName, id, seq, "table", "from", "to", on_delete FROM pragma_foreign_key_list('${tableName}')`,
    )
    .join(" UNION ALL ");
  const commands = [
    "SELECT name FROM d1_migrations ORDER BY id",
    "PRAGMA table_info(event_brand_assets)",
    `SELECT type, name, sql FROM sqlite_master WHERE name IN (${objectNames}) ORDER BY type, name`,
    "PRAGMA table_info(reviews)",
    "PRAGMA table_info(review_revisions)",
    "PRAGMA table_info(reviewer_ai_suggestions)",
    "PRAGMA foreign_key_check",
    publicSiteColumnQuery,
    publicSiteForeignKeyQuery,
    `SELECT COUNT(*) AS invalidCount FROM programme_embeds
      WHERE json_extract(configuration_json, '$.theme') IS NULL
         OR json_extract(configuration_json, '$.theme') NOT IN ('light','dark','system')`,
    pendingTaskConfigurationInventoryQuery,
    "PRAGMA table_info(session_speakers)",
  ];
  const response = executeRemoteCommands(
    commands.slice(0, 6),
    "schema metadata validation",
  );
  const tableInventoryResponse = executeRemoteCommands(
    [
      "SELECT name FROM sqlite_master WHERE type = 'table' AND substr(name, 1, 4) <> '_cf_' ORDER BY name",
    ],
    "integrity table inventory",
  );
  if (tableInventoryResponse.length !== 1) {
    throw new Error(
      "Remote D1 integrity table inventory returned an unexpected result set.",
    );
  }
  const tableNames = successfulResults(
    tableInventoryResponse[0],
    "integrity table inventory",
  ).map((row) => row.name);
  if (
    tableNames.length === 0 ||
    tableNames.some((name) => typeof name !== "string" || name.length === 0)
  ) {
    throw new Error("Remote D1 integrity table inventory was invalid.");
  }
  const integrityResponse = executeRemoteCommands(
    tableNames.map(
      (name) => `PRAGMA quick_check('${name.replaceAll("'", "''")}')`,
    ),
    "table integrity validation",
  );
  if (integrityResponse.length !== tableNames.length) {
    throw new Error(
      "Remote D1 table integrity validation returned an unexpected result set.",
    );
  }
  for (const [index, result] of integrityResponse.entries()) {
    const rows = successfulResults(
      result,
      `integrity for table ${tableNames[index]}`,
    );
    if (rows.length !== 1 || rows[0]?.quick_check !== "ok") {
      throw new Error(
        `Remote D1 quick_check did not return ok for table ${tableNames[index]}.`,
      );
    }
  }
  response.push({ results: [{ quick_check: "ok" }], success: true });
  response.push(
    ...executeRemoteCommands(
      commands.slice(6),
      "schema relationship validation",
    ),
  );
  const evidence = validateRemoteSchemaEvidence(response, localMigrationNames, {
    allowPendingMigrations,
  });
  if (allowPendingMigrations) {
    console.log(
      `Remote D1 migration preflight passed (${evidence.migrationCount} applied and ${evidence.pendingMigrationCount} pending migrations).`,
    );
  } else {
    console.log(
      `Remote D1 schema validation passed (${evidence.migrationCount} migrations, ${evidence.brandingColumnCount} branding columns, ${evidence.brandingObjectCount} branding indexes/triggers, ${evidence.reviewerAiColumnCount} reviewer-AI columns, ${evidence.reviewerAiObjectCount} reviewer-AI indexes/triggers, ${evidence.publicSiteColumnCount} public-site columns, ${evidence.publicSiteObjectCount} public-site indexes/triggers and ${evidence.publicSiteForeignKeyCount} public-site foreign keys).`,
    );
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
