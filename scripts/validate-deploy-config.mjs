import { unstable_readConfig } from "wrangler";

const config = unstable_readConfig(
  { config: "./wrangler.jsonc" },
  { hideWarnings: true },
);
const variables = config.vars ?? {};
const errors = [];

function requiredString(name) {
  const value = variables[name];
  if (typeof value !== "string" || !value.trim()) {
    errors.push(`${name} must be configured with a non-empty value.`);
    return "";
  }
  return value.trim();
}

function containsPlaceholder(value) {
  const normalized = value.toLowerCase();
  return normalized.includes("replace_with_")
    || normalized.includes("example.invalid")
    || normalized.includes(".example");
}

function productionHttpsUrl(name, value) {
  if (!value) return;
  let url;
  try {
    url = new URL(value);
  } catch {
    errors.push(`${name} must be an absolute URL.`);
    return;
  }
  if (url.protocol !== "https:") errors.push(`${name} must use HTTPS in production.`);
  if (containsPlaceholder(url.hostname)) errors.push(`${name} still contains an example placeholder host.`);
}

if (variables.APP_ENV !== "production" || variables.DEMO_MODE !== "false") {
  errors.push("Production deployment requires APP_ENV=production and DEMO_MODE=false.");
}
if (typeof config.name !== "string" || !config.name || /demo/i.test(config.name)) {
  errors.push("Production Worker name must be configured and must not be a demo deployment name.");
}

const database = config.d1_databases?.find((binding) => binding.binding === "DB");
if (!database) {
  errors.push("Required D1 binding DB is missing.");
} else if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(database.database_id)) {
  errors.push("DB database_id must be replaced with the provisioned D1 UUID.");
}
if (!config.r2_buckets?.some((binding) => binding.binding === "FILES")) {
  errors.push("Required private R2 binding FILES is missing.");
}
const operationQueue = config.queues?.producers?.find((binding) => binding.binding === "OPERATIONS_QUEUE");
if (!operationQueue) {
  errors.push("Required Queue producer binding OPERATIONS_QUEUE is missing.");
} else {
  const consumer = config.queues?.consumers?.find((candidate) => candidate.queue === operationQueue.queue);
  if (!consumer) errors.push("OPERATIONS_QUEUE must have a consumer in the production Worker.");
  if (!consumer?.dead_letter_queue) errors.push("OPERATIONS_QUEUE must have a dead-letter queue.");
}
if (!config.durable_objects?.bindings?.some((binding) => binding.name === "EVENT_CHANNEL")) {
  errors.push("Required Durable Object binding EVENT_CHANNEL is missing.");
}

requiredString("DEFAULT_EVENT_ID");
requiredString("PUBLIC_EVENT_SLUG");
const authUrl = requiredString("BETTER_AUTH_URL");
productionHttpsUrl("BETTER_AUTH_URL", authUrl);
const authEmailFrom = requiredString("AUTH_EMAIL_FROM");
if (containsPlaceholder(authEmailFrom)) {
  errors.push("AUTH_EMAIL_FROM still contains an example placeholder address.");
}
const corsOrigins = requiredString("CORS_ALLOWED_ORIGINS");
for (const origin of corsOrigins.split(",").map((value) => value.trim()).filter(Boolean)) {
  productionHttpsUrl("CORS_ALLOWED_ORIGINS", origin);
}
const frameAncestors = requiredString("EMBED_FRAME_ANCESTORS");
if (frameAncestors === "*" || containsPlaceholder(frameAncestors)) {
  errors.push("EMBED_FRAME_ANCESTORS must contain explicit production origins, not a wildcard or example host.");
} else {
  for (const origin of frameAncestors.split(/\s+/).filter(Boolean)) {
    productionHttpsUrl("EMBED_FRAME_ANCESTORS", origin);
  }
}
if ("BETTER_AUTH_SECRET" in variables) {
  errors.push("BETTER_AUTH_SECRET must be a Cloudflare secret, not a checked-in Worker variable.");
}

if (errors.length) {
  console.error(`Production deployment configuration is invalid:\n- ${errors.join("\n- ")}`);
  process.exitCode = 1;
} else {
  console.log("Production deployment configuration passed fail-fast validation.");
}
