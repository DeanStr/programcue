import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";

import { parse } from "yaml";

const yamlDocument = parse(await readFile(new URL("../docs/openapi.yaml", import.meta.url), "utf8"));
const jsonUrl = new URL("../public/openapi.json", import.meta.url);
if (process.argv.includes("--write")) {
  await writeFile(jsonUrl, `${JSON.stringify(yamlDocument, null, 2)}\n`);
}
const jsonDocument = JSON.parse(await readFile(jsonUrl, "utf8"));

assert.equal(yamlDocument.openapi, "3.1.0", "OpenAPI source must use version 3.1.0");
assert.equal(typeof yamlDocument.info?.title, "string", "OpenAPI info.title is required");
assert.ok(Object.keys(yamlDocument.paths ?? {}).length > 0, "OpenAPI must define at least one path");
const internalReferences = [];
function collectInternalReferences(value) {
  if (!value || typeof value !== "object") return;
  if (typeof value.$ref === "string" && value.$ref.startsWith("#/")) internalReferences.push(value.$ref);
  for (const child of Object.values(value)) collectInternalReferences(child);
}
collectInternalReferences(yamlDocument);
for (const reference of internalReferences) {
  const target = reference.slice(2).split("/").reduce(
    (value, segment) => value?.[segment.replaceAll("~1", "/").replaceAll("~0", "~")],
    yamlDocument,
  );
  assert.notEqual(target, undefined, `OpenAPI reference does not resolve: ${reference}`);
}
for (const [path, item] of Object.entries(yamlDocument.paths)) {
  assert.ok(path.startsWith("/"), `OpenAPI path ${path} must start with /`);
  for (const [method, operation] of Object.entries(item)) {
    if (!["get", "post", "put", "patch", "delete", "options", "head"].includes(method)) continue;
    assert.equal(typeof operation.summary, "string", `${method.toUpperCase()} ${path} requires a summary`);
    assert.ok(Object.keys(operation.responses ?? {}).length > 0, `${method.toUpperCase()} ${path} requires responses`);
  }
}
assert.deepEqual(jsonDocument, yamlDocument, "public/openapi.json must be generated from docs/openapi.yaml");

console.log(`OpenAPI validation passed (${Object.keys(yamlDocument.paths).length} paths, ${internalReferences.length} internal references).`);
