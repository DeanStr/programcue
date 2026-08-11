import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  CHECKED_IN_SECRET_NAMES,
  REQUIRED_PRODUCTION_SECRET_NAMES,
} from "./deploy-contract.mjs";
import {
  readDeploymentConfigs,
  validateDeploymentConfigs,
} from "./validate-deploy-config.mjs";
import { missingRequiredSecretNames } from "./validate-deploy-secrets.mjs";
import { nodeOnlyTestFiles } from "../vitest.test-files.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ignoredTestDiscoveryDirectories = new Set([
  ".claude",
  ".git",
  ".artifacts",
  ".react-router",
  ".wrangler",
  "build",
  "coverage",
  "node_modules",
  "playwright-report",
  "test-results",
]);

async function discoverTestFiles(directory = repositoryRoot) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      if (ignoredTestDiscoveryDirectories.has(entry.name)) return [];
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return discoverTestFiles(path);
      if (!entry.isFile()) return [];
      const repositoryPath = relative(repositoryRoot, path).replaceAll(
        "\\",
        "/",
      );
      return /(?:\.test\.(?:mjs|ts|tsx)|\.unit\.ts|\.spec\.ts)$/u.test(
        repositoryPath,
      )
        ? [repositoryPath]
        : [];
    }),
  );
  return files.flat();
}

test("Wrangler profiles have no structural configuration issues", () => {
  const issues = validateDeploymentConfigs(readDeploymentConfigs());
  assert.deepEqual(
    issues.filter(({ kind }) => kind === "configuration"),
    [],
  );
  assert.ok(issues.every(({ profile }) => profile === "production"));
  assert.deepEqual(
    issues.map(({ message }) => message),
    [
      "SOURCE_REVISION must be replaced with the deployed 7-64 character hexadecimal Git revision.",
      "DB database_id must be replaced with the provisioned D1 UUID.",
      "BETTER_AUTH_URL still contains an example placeholder host.",
      "AUTH_EMAIL_FROM still contains an example placeholder address.",
      "CORS_ALLOWED_ORIGINS still contains an example placeholder host.",
      "EMBED_FRAME_ANCESTORS still contains an example placeholder host.",
      "RESOURCE_EMBED_ORIGINS still contains an example placeholder host.",
      "TURNSTILE_SITE_KEY must be replaced with the production site key.",
      "CLOUDFLARE_ACCOUNT_ID must be replaced with the 32-character account ID.",
      "D1_DATABASE_ID must be replaced with the provisioned D1 UUID.",
      "R2_ACCOUNT_ID must be replaced with the 32-character account ID.",
      "FILE_SCANNER_API_URL still contains an example placeholder host.",
    ],
  );
});

test("deployment validation rejects missing or non-Git production revisions", () => {
  const missingRevision = readDeploymentConfigs();
  delete missingRevision.production.vars.SOURCE_REVISION;
  const missingIssues = validateDeploymentConfigs(missingRevision);
  assert.ok(
    missingIssues.some(
      ({ profile, kind, message }) =>
        profile === "production" &&
        kind === "configuration" &&
        message ===
          "SOURCE_REVISION must be configured with a non-empty string.",
    ),
  );
  assert.ok(
    missingIssues.some(
      ({ profile, kind, message }) =>
        profile === "production" &&
        kind === "provisioning" &&
        message.includes("hexadecimal Git revision"),
    ),
  );

  const nonGitRevision = readDeploymentConfigs();
  nonGitRevision.production.vars.SOURCE_REVISION = "release-main";
  assert.ok(
    validateDeploymentConfigs(nonGitRevision).some(
      ({ profile, kind, message }) =>
        profile === "production" &&
        kind === "provisioning" &&
        message.includes("hexadecimal Git revision"),
    ),
  );
});

test("production event identity is configurable while remaining well formed", () => {
  const configs = readDeploymentConfigs();
  configs.production.vars.DEFAULT_EVENT_ID = "evt-client-conference-2027";
  configs.production.vars.PUBLIC_EVENT_SLUG = "client-conference-2027";
  assert.deepEqual(
    validateDeploymentConfigs(configs).filter(
      ({ kind, message }) =>
        kind === "configuration" &&
        (message.includes("DEFAULT_EVENT_ID") ||
          message.includes("PUBLIC_EVENT_SLUG")),
    ),
    [],
  );

  configs.production.vars.DEFAULT_EVENT_ID = "bad event id";
  configs.production.vars.PUBLIC_EVENT_SLUG = "Bad Slug";
  assert.deepEqual(
    validateDeploymentConfigs(configs)
      .filter(
        ({ kind, message }) =>
          kind === "configuration" &&
          (message.includes("DEFAULT_EVENT_ID") ||
            message.includes("PUBLIC_EVENT_SLUG")),
      )
      .map(({ message }) => message),
    [
      "DEFAULT_EVENT_ID must be a stable 3-128 character event identifier.",
      "PUBLIC_EVENT_SLUG must be a lowercase kebab-case slug.",
    ],
  );
});

test("resource embed origins are explicit exact HTTPS origins", () => {
  const configs = readDeploymentConfigs();
  configs.production.vars.RESOURCE_EMBED_ORIGINS =
    "https://docs.google.com,https://player.vimeo.com";
  assert.deepEqual(
    validateDeploymentConfigs(configs).filter(({ message }) =>
      message.includes("RESOURCE_EMBED_ORIGINS"),
    ),
    [],
  );

  configs.production.vars.RESOURCE_EMBED_ORIGINS =
    "https://docs.google.com/document,https://docs.google.com";
  assert.ok(
    validateDeploymentConfigs(configs).some(
      ({ profile, kind, message }) =>
        profile === "production" &&
        kind === "configuration" &&
        message.includes("exact HTTPS origins"),
    ),
  );

  configs.production.vars.RESOURCE_EMBED_ORIGINS = "https://docs.google.com,";
  assert.ok(
    validateDeploymentConfigs(configs).some(
      ({ profile, kind, message }) =>
        profile === "production" &&
        kind === "configuration" &&
        message.includes("1-16 exact HTTPS origins"),
    ),
  );

  configs.production.vars.RESOURCE_EMBED_ORIGINS = "none";
  assert.deepEqual(
    validateDeploymentConfigs(configs).filter(({ message }) =>
      message.includes("RESOURCE_EMBED_ORIGINS"),
    ),
    [],
  );

  configs.production.vars.RESOURCE_EMBED_ORIGINS = " none ";
  assert.deepEqual(
    validateDeploymentConfigs(configs).filter(({ message }) =>
      message.includes("RESOURCE_EMBED_ORIGINS"),
    ),
    [],
  );
});

test("deployment validation requires invocation logs and sampled traces", () => {
  const configs = readDeploymentConfigs();
  configs.production.observability.logs.enabled = false;
  delete configs.demo.observability.logs;
  configs.development.observability.traces.enabled = false;

  const observabilityIssues = validateDeploymentConfigs(configs).filter(
    ({ message }) => message.includes("invocation logs and traces"),
  );
  assert.deepEqual(
    observabilityIssues.map(({ profile, kind }) => ({ profile, kind })),
    [
      { profile: "production", kind: "configuration" },
      { profile: "demo", kind: "configuration" },
      { profile: "development", kind: "configuration" },
    ],
  );
});

test("production secret inventory is centralized, unique, and fail-closed", async () => {
  assert.equal(
    new Set(REQUIRED_PRODUCTION_SECRET_NAMES).size,
    REQUIRED_PRODUCTION_SECRET_NAMES.length,
  );
  assert.equal(
    new Set(CHECKED_IN_SECRET_NAMES).size,
    CHECKED_IN_SECRET_NAMES.length,
  );

  const complete = REQUIRED_PRODUCTION_SECRET_NAMES.map((name) => ({
    name,
    type: "secret_text",
  }));
  assert.deepEqual(missingRequiredSecretNames(complete), []);
  assert.deepEqual(missingRequiredSecretNames(complete.slice(0, -1)), [
    REQUIRED_PRODUCTION_SECRET_NAMES.at(-1),
  ]);
  assert.throws(
    () => missingRequiredSecretNames({}),
    /expected a secret inventory array/u,
  );

  const readinessSource = await readFile(
    new URL("../app/platform/runtime-readiness.server.ts", import.meta.url),
    "utf8",
  );
  const readinessValues = readinessSource.match(
    /const requiredProductionValues = \[([\s\S]*?)\] as const;/u,
  );
  assert.ok(readinessValues, "runtime readiness value inventory is missing");
  const runtimeNames = Array.from(
    readinessValues[1].matchAll(/"([A-Z0-9_]+)"/gu),
    (match) => match[1],
  );
  assert.deepEqual(
    REQUIRED_PRODUCTION_SECRET_NAMES.filter(
      (name) => !runtimeNames.includes(name),
    ),
    [],
  );
});

test("README secret commands and local example cannot drift from the contract", async () => {
  const readme = await readFile(
    new URL("../README.md", import.meta.url),
    "utf8",
  );
  const documented = Array.from(
    readme.matchAll(/^wrangler secret put ([A-Z0-9_]+)$/gmu),
    (match) => match[1],
  );
  assert.deepEqual(documented, REQUIRED_PRODUCTION_SECRET_NAMES);

  const localExample = await readFile(
    new URL("../.dev.vars.example", import.meta.url),
    "utf8",
  );
  const localValues = new Map(
    localExample
      .split("\n")
      .filter((line) => /^[A-Z0-9_]+=/u.test(line))
      .map((line) => {
        const separator = line.indexOf("=");
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  assert.ok(localValues.has("BETTER_AUTH_SECRET"));
  for (const [name, value] of localValues)
    assert.equal(value, "", `${name} must not have a checked-in example value`);
});

test("every test file is registered in an executable project", async () => {
  const testFiles = await discoverTestFiles();
  const nodeOnly = new Set(nodeOnlyTestFiles);
  assert.equal(nodeOnly.size, nodeOnlyTestFiles.length);
  assert.deepEqual(
    [...nodeOnly].filter((path) => !testFiles.includes(path)),
    [],
  );

  const unregistered = testFiles.filter((path) => {
    if (nodeOnly.has(path)) return false;
    if (path === "app/modules/ai/program-cue-agent.test.ts") return false;
    if (path.startsWith("app/") && path.endsWith(".test.ts")) return false;
    if (path === "scripts/deploy-contract.test.mjs") return false;
    return !(path.startsWith("e2e/") && path.endsWith(".spec.ts"));
  });
  assert.deepEqual(unregistered, []);
});
