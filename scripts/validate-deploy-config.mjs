import { fileURLToPath } from "node:url";

import { unstable_readConfig } from "wrangler";

import { CHECKED_IN_SECRET_NAMES } from "./deploy-contract.mjs";

export const CONFIG_FILES = Object.freeze({
  production: "./wrangler.jsonc",
  demo: "./wrangler.demo.jsonc",
  development: "./wrangler.development.jsonc",
});

const profileSpecs = Object.freeze({
  production: {
    workerName: "program-cue",
    appEnvironment: "production",
    demoMode: "false",
    evaluationMode: "true",
    sourceRevision: null,
    queueName: "program-cue-operations",
    traceSamplingRate: 0.1,
    crons: ["* * * * *", "17 2 * * *"],
  },
  demo: {
    workerName: "program-cue-demo",
    appEnvironment: "demo",
    demoMode: "true",
    evaluationMode: "false",
    sourceRevision: "local-demo",
    queueName: "program-cue-operations-demo",
    traceSamplingRate: 1,
    crons: ["* * * * *"],
  },
  development: {
    workerName: "program-cue-development",
    appEnvironment: "development",
    demoMode: "true",
    evaluationMode: "false",
    sourceRevision: "local-development",
    queueName: "program-cue-operations-development",
    traceSamplingRate: 1,
    crons: ["* * * * *"],
  },
});

const commonVariableNames = [
  "APP_ENV",
  "DEMO_MODE",
  "EVALUATION_MODE",
  "SOURCE_REVISION",
  "BETTER_AUTH_URL",
  "AUTH_EMAIL_FROM",
  "EMAIL_PROVIDER",
  "TURNSTILE_SITE_KEY",
  "CORS_ALLOWED_ORIGINS",
  "EMBED_FRAME_ANCESTORS",
  "RESOURCE_EMBED_ORIGINS",
];
const productionVariableNames = new Set([
  ...commonVariableNames,
  "CLOUDFLARE_ACCOUNT_ID",
  "D1_DATABASE_ID",
  "R2_ACCOUNT_ID",
  "R2_BUCKET_NAME",
  "FILE_SCANNER_API_URL",
]);
const localVariableNames = new Set([
  ...commonVariableNames,
  "DEFAULT_EVENT_ID",
  "PUBLIC_EVENT_SLUG",
  "MAILPIT_SEND_API_URL",
]);

function issue(profile, kind, message) {
  return { profile, kind, message };
}

function sameMembers(actual = [], expected = []) {
  return (
    actual.length === expected.length &&
    [...actual]
      .sort()
      .every((value, index) => value === [...expected].sort()[index])
  );
}

function binding(config, collection, key, value) {
  return (config[collection] ?? []).filter(
    (candidate) => candidate[key] === value,
  );
}

function requiredVariable(profile, variables, name, issues) {
  const value = variables[name];
  if (typeof value !== "string" || !value.trim()) {
    issues.push(
      issue(
        profile,
        "configuration",
        `${name} must be configured with a non-empty string.`,
      ),
    );
    return "";
  }
  return value.trim();
}

function containsPlaceholder(value) {
  const normalized = value.toLowerCase();
  return (
    normalized.includes("replace_with_") ||
    normalized.includes("example.invalid") ||
    normalized.includes(".example")
  );
}

function productionUrl(profile, name, value, issues) {
  if (!value) return;
  let url;
  try {
    url = new URL(value);
  } catch {
    issues.push(
      issue(profile, "configuration", `${name} must be an absolute URL.`),
    );
    return;
  }
  if (url.protocol !== "https:") {
    issues.push(
      issue(profile, "configuration", `${name} must use HTTPS in production.`),
    );
  }
  if (containsPlaceholder(url.hostname)) {
    issues.push(
      issue(
        profile,
        "provisioning",
        `${name} still contains an example placeholder host.`,
      ),
    );
  }
}

function resourceEmbedOrigins(profile, value, issues) {
  const normalizedValue = value.trim();
  if (!normalizedValue || normalizedValue.toLowerCase() === "none") return [];
  const requested = normalizedValue.split(",").map((origin) => origin.trim());
  if (
    !requested.length ||
    requested.some((origin) => !origin) ||
    requested.length > 16
  ) {
    issues.push(
      issue(
        profile,
        "configuration",
        'RESOURCE_EMBED_ORIGINS must contain 1-16 exact HTTPS origins, or "none".',
      ),
    );
    return [];
  }
  const normalized = [];
  for (const origin of requested) {
    let url;
    try {
      url = new URL(origin);
    } catch {
      url = null;
    }
    if (
      !url ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      issues.push(
        issue(
          profile,
          "configuration",
          "RESOURCE_EMBED_ORIGINS entries must be exact HTTPS origins without credentials, paths, queries or fragments.",
        ),
      );
      continue;
    }
    normalized.push(url.origin);
  }
  if (new Set(normalized).size !== normalized.length) {
    issues.push(
      issue(
        profile,
        "configuration",
        "RESOURCE_EMBED_ORIGINS must not contain duplicate origins.",
      ),
    );
  }
  return normalized;
}

function validateVariableInventory(profile, variables, allowed, issues) {
  for (const name of Object.keys(variables)) {
    if (allowed.has(name)) continue;
    const secret = CHECKED_IN_SECRET_NAMES.includes(name);
    issues.push(
      issue(
        profile,
        "configuration",
        secret
          ? `${name} must be supplied as a local or Cloudflare secret, not a checked-in Worker variable.`
          : `${name} is an unexpected or stale checked-in Worker variable.`,
      ),
    );
  }
}

function validateCommonProfile(profile, config, spec, issues) {
  const variables = config.vars ?? {};
  const local = profile !== "production";

  if (config.name !== spec.workerName) {
    issues.push(
      issue(
        profile,
        "configuration",
        `Worker name must be ${spec.workerName}.`,
      ),
    );
  }
  if (!config.main?.endsWith("/workers/index.ts")) {
    issues.push(
      issue(profile, "configuration", "Worker main must be workers/index.ts."),
    );
  }
  if (config.compatibility_date !== "2026-08-08") {
    issues.push(
      issue(
        profile,
        "configuration",
        "Worker compatibility_date must be 2026-08-08.",
      ),
    );
  }
  if (!sameMembers(config.compatibility_flags, ["nodejs_compat"])) {
    issues.push(
      issue(
        profile,
        "configuration",
        "Worker compatibility_flags must contain only nodejs_compat.",
      ),
    );
  }

  if (
    variables.APP_ENV !== spec.appEnvironment ||
    variables.DEMO_MODE !== spec.demoMode ||
    variables.EVALUATION_MODE !== spec.evaluationMode
  ) {
    issues.push(
      issue(
        profile,
        "configuration",
        `${profile} requires APP_ENV=${spec.appEnvironment}, DEMO_MODE=${spec.demoMode} and EVALUATION_MODE=${spec.evaluationMode}.`,
      ),
    );
  }
  if (local && variables.SOURCE_REVISION !== spec.sourceRevision) {
    issues.push(
      issue(
        profile,
        "configuration",
        `SOURCE_REVISION must be ${spec.sourceRevision}.`,
      ),
    );
  }
  if (
    !local &&
    !/^[0-9a-f]{7,64}$/iu.test(String(variables.SOURCE_REVISION ?? ""))
  ) {
    issues.push(
      issue(
        profile,
        "provisioning",
        "SOURCE_REVISION must be replaced with the deployed 7-64 character hexadecimal Git revision.",
      ),
    );
  }

  validateVariableInventory(
    profile,
    variables,
    local ? localVariableNames : productionVariableNames,
    issues,
  );

  for (const name of commonVariableNames) {
    requiredVariable(profile, variables, name, issues);
  }
  resourceEmbedOrigins(
    profile,
    String(variables.RESOURCE_EMBED_ORIGINS ?? ""),
    issues,
  );
  if (
    profile !== "production" &&
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(
      String(variables.DEFAULT_EVENT_ID ?? ""),
    )
  ) {
    issues.push(
      issue(
        profile,
        "configuration",
        "DEFAULT_EVENT_ID must be a stable 3-128 character event identifier.",
      ),
    );
  }
  if (
    profile !== "production" &&
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(
      String(variables.PUBLIC_EVENT_SLUG ?? ""),
    )
  ) {
    issues.push(
      issue(
        profile,
        "configuration",
        "PUBLIC_EVENT_SLUG must be a lowercase kebab-case slug.",
      ),
    );
  }

  const databases = binding(config, "d1_databases", "binding", "DB");
  if (databases.length !== 1 || (config.d1_databases ?? []).length !== 1) {
    issues.push(
      issue(
        profile,
        "configuration",
        "Exactly one D1 binding named DB is required.",
      ),
    );
  }
  const database = databases[0];
  if (database) {
    if (
      database.database_name !== "program-cue-db" ||
      database.migrations_dir !== "migrations"
    ) {
      issues.push(
        issue(
          profile,
          "configuration",
          "DB must use program-cue-db and the migrations directory.",
        ),
      );
    }
    if (local && database.database_id !== "REPLACE_WITH_D1_DATABASE_ID") {
      issues.push(
        issue(
          profile,
          "configuration",
          "Local DB must retain the non-deployable local-emulator database identifier.",
        ),
      );
    }
    if (local && database.remote === true) {
      issues.push(
        issue(
          profile,
          "configuration",
          "Local DB must not require a remote Cloudflare binding.",
        ),
      );
    }
  }

  const files = binding(config, "r2_buckets", "binding", "FILES");
  if (files.length !== 1 || files[0]?.bucket_name !== "program-cue-files") {
    issues.push(
      issue(
        profile,
        "configuration",
        "Exactly one private FILES bucket binding is required.",
      ),
    );
  }
  if (local && files[0]?.remote === true) {
    issues.push(
      issue(
        profile,
        "configuration",
        "Local FILES must use Wrangler's local R2 emulator.",
      ),
    );
  }

  const durableObjects = config.durable_objects?.bindings ?? [];
  const expectedDurableObjects = new Map([
    ["EVENT_CHANNEL", "EventChannel"],
    ["PROGRAM_CUE_AGENT", "ProgramCueEventAgent"],
  ]);
  if (durableObjects.length !== expectedDurableObjects.size) {
    issues.push(
      issue(
        profile,
        "configuration",
        "Exactly two canonical Durable Object bindings are required.",
      ),
    );
  }
  for (const [name, className] of expectedDurableObjects) {
    const matches = durableObjects.filter(
      (candidate) => candidate.name === name,
    );
    if (matches.length !== 1 || matches[0]?.class_name !== className) {
      issues.push(
        issue(profile, "configuration", `${name} must reference ${className}.`),
      );
    }
  }
  const migrationV1 =
    config.migrations?.filter((candidate) => candidate.tag === "v1") ?? [];
  const migrationV2 =
    config.migrations?.filter((candidate) => candidate.tag === "v2") ?? [];
  if (
    migrationV1.length !== 1 ||
    !sameMembers(migrationV1[0]?.new_sqlite_classes, ["EventChannel"])
  ) {
    issues.push(
      issue(
        profile,
        "configuration",
        "Durable Object migration v1 must create only EventChannel.",
      ),
    );
  }
  if (
    migrationV2.length !== 1 ||
    !sameMembers(migrationV2[0]?.new_sqlite_classes, ["ProgramCueEventAgent"])
  ) {
    issues.push(
      issue(
        profile,
        "configuration",
        "Durable Object migration v2 must create only ProgramCueEventAgent.",
      ),
    );
  }

  const producers = config.queues?.producers ?? [];
  const consumers = config.queues?.consumers ?? [];
  if (
    producers.length !== 1 ||
    producers[0]?.binding !== "OPERATIONS_QUEUE" ||
    producers[0]?.queue !== spec.queueName
  ) {
    issues.push(
      issue(
        profile,
        "configuration",
        `OPERATIONS_QUEUE must produce to ${spec.queueName}.`,
      ),
    );
  }
  const consumer = consumers[0];
  if (
    consumers.length !== 1 ||
    consumer?.queue !== spec.queueName ||
    consumer?.max_batch_size !== 20 ||
    consumer?.max_batch_timeout !== 5 ||
    consumer?.max_retries !== 3 ||
    consumer?.dead_letter_queue !== `${spec.queueName}-dlq`
  ) {
    issues.push(
      issue(
        profile,
        "configuration",
        `${spec.queueName} must have the canonical retrying consumer and DLQ.`,
      ),
    );
  }

  if (!sameMembers(config.triggers?.crons, spec.crons)) {
    issues.push(
      issue(
        profile,
        "configuration",
        `${profile} must configure exactly the expected scheduler cron set.`,
      ),
    );
  }
  if (
    config.observability?.enabled !== true ||
    config.observability?.logs?.enabled !== true ||
    config.observability?.logs?.invocation_logs !== true ||
    config.observability?.traces?.enabled !== true ||
    config.observability?.traces?.head_sampling_rate !== spec.traceSamplingRate
  ) {
    issues.push(
      issue(
        profile,
        "configuration",
        `${profile} must enable invocation logs and traces at sampling rate ${spec.traceSamplingRate}.`,
      ),
    );
  }
}

function validateProduction(config, issues) {
  const profile = "production";
  const variables = config.vars ?? {};
  const database = binding(config, "d1_databases", "binding", "DB")[0];
  const files = binding(config, "r2_buckets", "binding", "FILES")[0];
  const backups = binding(config, "r2_buckets", "binding", "BACKUPS");

  if (
    !database ||
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(
      database.database_id,
    )
  ) {
    issues.push(
      issue(
        profile,
        "provisioning",
        "DB database_id must be replaced with the provisioned D1 UUID.",
      ),
    );
  }
  if (
    (config.r2_buckets ?? []).length !== 2 ||
    backups.length !== 1 ||
    !backups[0]?.bucket_name ||
    backups[0]?.bucket_name === files?.bucket_name
  ) {
    issues.push(
      issue(
        profile,
        "configuration",
        "BACKUPS must use one private R2 bucket separate from FILES.",
      ),
    );
  }
  const workflows = config.workflows ?? [];
  if (
    workflows.length !== 1 ||
    workflows[0]?.binding !== "D1_BACKUP_WORKFLOW" ||
    workflows[0]?.name !== "program-cue-d1-backup" ||
    workflows[0]?.class_name !== "D1BackupWorkflow"
  ) {
    issues.push(
      issue(
        profile,
        "configuration",
        "D1_BACKUP_WORKFLOW must use the canonical production Workflow.",
      ),
    );
  }
  if (config.ai?.binding !== "AI") {
    issues.push(
      issue(
        profile,
        "configuration",
        "The production Workers AI binding must be named AI.",
      ),
    );
  }
  if (config.upload_source_maps !== true) {
    issues.push(
      issue(
        profile,
        "configuration",
        "Production source-map upload must be enabled.",
      ),
    );
  }
  if (variables.EMAIL_PROVIDER !== "resend") {
    issues.push(
      issue(
        profile,
        "configuration",
        "Production requires EMAIL_PROVIDER=resend.",
      ),
    );
  }

  const authUrl = requiredVariable(
    profile,
    variables,
    "BETTER_AUTH_URL",
    issues,
  );
  productionUrl(profile, "BETTER_AUTH_URL", authUrl, issues);
  const authEmail = requiredVariable(
    profile,
    variables,
    "AUTH_EMAIL_FROM",
    issues,
  );
  if (containsPlaceholder(authEmail)) {
    issues.push(
      issue(
        profile,
        "provisioning",
        "AUTH_EMAIL_FROM still contains an example placeholder address.",
      ),
    );
  }
  const corsOrigins = requiredVariable(
    profile,
    variables,
    "CORS_ALLOWED_ORIGINS",
    issues,
  );
  for (const origin of corsOrigins
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)) {
    productionUrl(profile, "CORS_ALLOWED_ORIGINS", origin, issues);
  }
  const frameAncestors = requiredVariable(
    profile,
    variables,
    "EMBED_FRAME_ANCESTORS",
    issues,
  );
  if (frameAncestors === "*") {
    issues.push(
      issue(
        profile,
        "configuration",
        "EMBED_FRAME_ANCESTORS must not be a production wildcard.",
      ),
    );
  } else {
    for (const origin of frameAncestors.split(/\s+/u).filter(Boolean)) {
      productionUrl(profile, "EMBED_FRAME_ANCESTORS", origin, issues);
    }
  }
  const embedOrigins = resourceEmbedOrigins(
    profile,
    String(variables.RESOURCE_EMBED_ORIGINS ?? ""),
    [],
  );
  for (const origin of embedOrigins) {
    productionUrl(profile, "RESOURCE_EMBED_ORIGINS", origin, issues);
  }

  const turnstileSiteKey = requiredVariable(
    profile,
    variables,
    "TURNSTILE_SITE_KEY",
    issues,
  );
  if (containsPlaceholder(turnstileSiteKey)) {
    issues.push(
      issue(
        profile,
        "provisioning",
        "TURNSTILE_SITE_KEY must be replaced with the production site key.",
      ),
    );
  }
  const cloudflareAccountId = requiredVariable(
    profile,
    variables,
    "CLOUDFLARE_ACCOUNT_ID",
    issues,
  );
  if (!/^[0-9a-f]{32}$/iu.test(cloudflareAccountId)) {
    issues.push(
      issue(
        profile,
        "provisioning",
        "CLOUDFLARE_ACCOUNT_ID must be replaced with the 32-character account ID.",
      ),
    );
  }
  const d1DatabaseId = requiredVariable(
    profile,
    variables,
    "D1_DATABASE_ID",
    issues,
  );
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(d1DatabaseId)) {
    issues.push(
      issue(
        profile,
        "provisioning",
        "D1_DATABASE_ID must be replaced with the provisioned D1 UUID.",
      ),
    );
  } else if (
    database?.database_id.toLowerCase() !== d1DatabaseId.toLowerCase()
  ) {
    issues.push(
      issue(
        profile,
        "configuration",
        "D1_DATABASE_ID must match the DB binding database_id.",
      ),
    );
  }
  const r2AccountId = requiredVariable(
    profile,
    variables,
    "R2_ACCOUNT_ID",
    issues,
  );
  if (!/^[0-9a-f]{32}$/iu.test(r2AccountId)) {
    issues.push(
      issue(
        profile,
        "provisioning",
        "R2_ACCOUNT_ID must be replaced with the 32-character account ID.",
      ),
    );
  } else if (cloudflareAccountId !== r2AccountId) {
    issues.push(
      issue(
        profile,
        "configuration",
        "R2_ACCOUNT_ID must match CLOUDFLARE_ACCOUNT_ID.",
      ),
    );
  }
  const r2BucketName = requiredVariable(
    profile,
    variables,
    "R2_BUCKET_NAME",
    issues,
  );
  if (r2BucketName !== files?.bucket_name) {
    issues.push(
      issue(
        profile,
        "configuration",
        "R2_BUCKET_NAME must match the FILES bucket binding.",
      ),
    );
  }
  const scannerUrl = requiredVariable(
    profile,
    variables,
    "FILE_SCANNER_API_URL",
    issues,
  );
  productionUrl(profile, "FILE_SCANNER_API_URL", scannerUrl, issues);
}

function validateLocal(profile, config, issues) {
  const variables = config.vars ?? {};
  if ((config.r2_buckets ?? []).length !== 1) {
    issues.push(
      issue(
        profile,
        "configuration",
        "Local profiles must bind only the emulated FILES bucket.",
      ),
    );
  }
  if ((config.workflows ?? []).length !== 0) {
    issues.push(
      issue(
        profile,
        "configuration",
        "Local profiles must not advertise the remote-auth D1 backup Workflow.",
      ),
    );
  }
  if (config.ai) {
    issues.push(
      issue(
        profile,
        "configuration",
        "Local profiles must not require a remote Workers AI binding.",
      ),
    );
  }
  if (variables.EMAIL_PROVIDER !== "mailpit") {
    issues.push(
      issue(
        profile,
        "configuration",
        "Local profiles require EMAIL_PROVIDER=mailpit.",
      ),
    );
  }
  if (variables.MAILPIT_SEND_API_URL !== "http://127.0.0.1:8025/api/v1/send") {
    issues.push(
      issue(
        profile,
        "configuration",
        "Local Mailpit delivery must use the pinned loopback API endpoint.",
      ),
    );
  }
  if (variables.BETTER_AUTH_SECRET) {
    issues.push(
      issue(
        profile,
        "configuration",
        "Local signing secrets must come from an ignored .dev.vars file or ephemeral test injection.",
      ),
    );
  }
  if (variables.TURNSTILE_SITE_KEY !== "1x00000000000000000000AA") {
    issues.push(
      issue(
        profile,
        "configuration",
        "Local profiles must use Cloudflare's documented always-pass Turnstile site key.",
      ),
    );
  }
}

export function readDeploymentConfigs() {
  return Object.fromEntries(
    Object.entries(CONFIG_FILES).map(([profile, file]) => [
      profile,
      unstable_readConfig({ config: file }, { hideWarnings: true }),
    ]),
  );
}

export function validateDeploymentConfigs(configs) {
  const issues = [];
  for (const [profile, spec] of Object.entries(profileSpecs)) {
    const config = configs[profile];
    if (!config) {
      issues.push(
        issue(
          profile,
          "configuration",
          `Missing ${profile} Wrangler configuration.`,
        ),
      );
      continue;
    }
    validateCommonProfile(profile, config, spec, issues);
    if (profile === "production") validateProduction(config, issues);
    else validateLocal(profile, config, issues);
  }
  return issues;
}

function run() {
  const issues = validateDeploymentConfigs(readDeploymentConfigs());
  if (issues.length) {
    console.error(
      `Worker deployment configuration is not release-ready:\n${issues
        .map(
          ({ profile, kind, message }) => `- [${profile}/${kind}] ${message}`,
        )
        .join("\n")}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log("All Worker deployment profiles passed fail-fast validation.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  run();
