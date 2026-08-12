import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";

import { parse, stringify } from "yaml";

const execFileAsync = promisify(execFile);
const yamlUrl = new URL("../docs/openapi.yaml", import.meta.url);
const routesUrl = new URL("../app/routes.ts", import.meta.url);
const schemaEmitterUrl = new URL("./emit-openapi-schemas.ts", import.meta.url);
const tsxUrl = new URL("../node_modules/.bin/tsx", import.meta.url);
const generatedStart = "    # BEGIN GENERATED ZOD SCHEMAS";
const generatedEnd = "    # END GENERATED ZOD SCHEMAS";

async function generatedSchemas() {
  const { stdout, stderr } = await execFileAsync(
    tsxUrl.pathname,
    ["--tsconfig", "tsconfig.cloudflare.json", schemaEmitterUrl.pathname],
    { cwd: new URL("..", import.meta.url), maxBuffer: 8 * 1024 * 1024 },
  );
  assert.equal(stderr, "", `Zod schema generation wrote to stderr: ${stderr}`);
  return JSON.parse(stdout);
}

function withGeneratedSchemas(source, schemas) {
  const start = source.indexOf(generatedStart);
  const end = source.indexOf(generatedEnd);
  assert.ok(
    start >= 0,
    "OpenAPI source is missing its generated-schema start marker",
  );
  assert.ok(
    end > start,
    "OpenAPI source is missing its generated-schema end marker",
  );
  const generatedYaml = stringify(schemas, { lineWidth: 0 })
    .trimEnd()
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
  const contentStart = start + generatedStart.length;
  return `${source.slice(0, contentStart)}\n${generatedYaml}\n${source.slice(end)}`;
}

const generated = await generatedSchemas();
let yamlSource = await readFile(yamlUrl, "utf8");
if (process.argv.includes("--write")) {
  yamlSource = withGeneratedSchemas(yamlSource, generated);
  await writeFile(yamlUrl, yamlSource);
}
const yamlDocument = parse(yamlSource);
const jsonUrl = new URL("../public/openapi.json", import.meta.url);
if (process.argv.includes("--write")) {
  await writeFile(jsonUrl, `${JSON.stringify(yamlDocument, null, 2)}\n`);
}
const jsonDocument = JSON.parse(await readFile(jsonUrl, "utf8"));

function configuredContractPaths(source) {
  const registeredPaths = [...source.matchAll(/route\(\s*"([^"]+)"\s*,/gu)]
    .map((match) => `/${match[1]}`)
    .filter(
      (path) =>
        path.startsWith("/api/v1/") ||
        path.startsWith("/api/webhooks/") ||
        path === "/admin/events/:eventId/changes",
    );
  const routeShapes = registeredPaths.map((path) =>
    path.replace(/:[A-Za-z][A-Za-z0-9_]*/gu, "{}"),
  );
  assert.equal(
    new Set(routeShapes).size,
    routeShapes.length,
    "Versioned API and webhook route patterns must not be registered twice",
  );
  return new Set(
    registeredPaths.map((path) =>
      path.replace(/:([A-Za-z][A-Za-z0-9_]*)/gu, "{$1}"),
    ),
  );
}

const configuredPaths = configuredContractPaths(
  await readFile(routesUrl, "utf8"),
);
const routeAliases = new Map([
  [
    "/api/v1/events/{eventId}/evaluation/plans",
    "/api/v1/events/{eventId}/evaluation/{resource}",
  ],
  [
    "/api/v1/events/{eventId}/evaluation/rounds",
    "/api/v1/events/{eventId}/evaluation/{resource}",
  ],
  [
    "/api/v1/events/{eventId}/evaluation/assignments",
    "/api/v1/events/{eventId}/evaluation/{resource}",
  ],
  [
    "/api/v1/events/{eventId}/evaluation/round-reviewers",
    "/api/v1/events/{eventId}/evaluation/{resource}",
  ],
]);
const documentedPaths = new Set(Object.keys(yamlDocument.paths ?? {}));
for (const path of configuredPaths) {
  assert.ok(
    documentedPaths.has(path) ||
      [...routeAliases].some(
        ([documentedPath, configuredPath]) =>
          configuredPath === path && documentedPaths.has(documentedPath),
      ),
    `Registered API route is missing from OpenAPI: ${path}`,
  );
}
for (const path of documentedPaths) {
  assert.ok(
    configuredPaths.has(path) || configuredPaths.has(routeAliases.get(path)),
    `OpenAPI path is not registered by app/routes.ts: ${path}`,
  );
}

assert.equal(
  yamlDocument.openapi,
  "3.1.0",
  "OpenAPI source must use version 3.1.0",
);
assert.equal(
  typeof yamlDocument.info?.title,
  "string",
  "OpenAPI info.title is required",
);
assert.ok(
  Object.keys(yamlDocument.paths ?? {}).length > 0,
  "OpenAPI must define at least one path",
);
for (const [name, schema] of Object.entries(generated)) {
  assert.deepEqual(
    yamlDocument.components?.schemas?.[name],
    schema,
    `OpenAPI component ${name} is stale; run npm run openapi:sync`,
  );
}
const internalReferences = [];
function resolveInternalReference(reference) {
  return reference
    .slice(2)
    .split("/")
    .reduce(
      (value, segment) =>
        value?.[segment.replaceAll("~1", "/").replaceAll("~0", "~")],
      yamlDocument,
    );
}
function collectInternalReferences(value) {
  if (!value || typeof value !== "object") return;
  if (typeof value.$ref === "string" && value.$ref.startsWith("#/"))
    internalReferences.push(value.$ref);
  for (const child of Object.values(value)) collectInternalReferences(child);
}
collectInternalReferences(yamlDocument);
for (const reference of internalReferences) {
  const target = resolveInternalReference(reference);
  assert.notEqual(
    target,
    undefined,
    `OpenAPI reference does not resolve: ${reference}`,
  );
}
const operationIds = new Set();
const httpMethods = new Set([
  "get",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "head",
]);
for (const [path, item] of Object.entries(yamlDocument.paths)) {
  assert.ok(path.startsWith("/"), `OpenAPI path ${path} must start with /`);
  for (const [method, operation] of Object.entries(item)) {
    if (!httpMethods.has(method)) continue;
    assert.equal(
      typeof operation.summary,
      "string",
      `${method.toUpperCase()} ${path} requires a summary`,
    );
    assert.ok(
      Object.keys(operation.responses ?? {}).length > 0,
      `${method.toUpperCase()} ${path} requires responses`,
    );
    assert.equal(
      typeof operation.operationId,
      "string",
      `${method.toUpperCase()} ${path} requires an operationId`,
    );
    assert.ok(
      !operationIds.has(operation.operationId),
      `OpenAPI operationId is duplicated: ${operation.operationId}`,
    );
    operationIds.add(operation.operationId);

    const parameters = [
      ...(Array.isArray(item.parameters) ? item.parameters : []),
      ...(Array.isArray(operation.parameters) ? operation.parameters : []),
    ].map((parameter) =>
      typeof parameter?.$ref === "string"
        ? resolveInternalReference(parameter.$ref)
        : parameter,
    );
    const parameterKeys = parameters.map(
      (parameter) => `${parameter?.in}:${parameter?.name}`,
    );
    assert.equal(
      new Set(parameterKeys).size,
      parameterKeys.length,
      `${method.toUpperCase()} ${path} declares a parameter more than once`,
    );
    for (const name of [...path.matchAll(/\{([^}]+)\}/gu)].map(
      (match) => match[1],
    )) {
      const parameter = parameters.find(
        (candidate) => candidate?.in === "path" && candidate.name === name,
      );
      assert.ok(
        parameter?.required === true,
        `${method.toUpperCase()} ${path} must declare required path parameter ${name}`,
      );
    }

    const security = operation.security ?? item.security ?? [];
    const sessionAuthenticated = security.some((requirement) =>
      Object.hasOwn(requirement, "sessionAuth"),
    );
    const apiKeyAuthenticated = security.some((requirement) =>
      Object.hasOwn(requirement, "apiKeyAuth"),
    );
    if (!["get", "head", "options"].includes(method) && sessionAuthenticated) {
      assert.ok(
        parameters.some(
          (parameter) =>
            parameter?.in === "header" && parameter.name === "Origin",
        ),
        `${method.toUpperCase()} ${path} must document its same-origin mutation boundary`,
      );
    }
    if (!["get", "head", "options"].includes(method) && apiKeyAuthenticated) {
      assert.ok(
        parameters.some(
          (parameter) =>
            parameter?.in === "header" && parameter.name === "Idempotency-Key",
        ),
        `${method.toUpperCase()} ${path} must document its idempotency key`,
      );
    }
  }
}
assert.deepEqual(
  jsonDocument,
  yamlDocument,
  "public/openapi.json must be generated from docs/openapi.yaml",
);

console.log(
  `OpenAPI validation passed (${Object.keys(yamlDocument.paths).length} paths, ${internalReferences.length} internal references).`,
);
