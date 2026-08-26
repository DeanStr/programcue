/*
 * Ratchet React adoption of the behavioural design-system primitives.
 *
 * Raw `btn` and `icon-btn` class strings fail directly. Editable native form
 * controls must use the canonical field classes or one of the deliberately
 * specialized treatments. UI TSX colour literals are not grandfathered:
 * values that genuinely need to cross the CSS boundary belong in
 * app/lib/product-colours.ts.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import {
  formControlViolations,
  sourceLiterals,
} from "./design-system-checks.mjs";
import { repositoryRoot } from "./e2e-runtime.mjs";

const APP_DIR = join(repositoryRoot, "app");
const AUTHORITATIVE_BUTTON_FILE = "app/components/ui/button.tsx";

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesBelow(path) : [path];
  });
}

const files = filesBelow(APP_DIR)
  .filter((file) => file.endsWith(".tsx"))
  .filter((file) => !/\.(?:test|spec)\.tsx$/.test(file));
const observed = {};
const observedIconButtons = {};
const failures = [];

for (const file of files) {
  const relativeFile = relative(repositoryRoot, file);
  const source = readFileSync(file, "utf8");
  if (relativeFile !== AUTHORITATIVE_BUTTON_FILE) {
    const rawButtonClasses = sourceLiterals(source, relativeFile).filter(
      ({ value }) => /(?:^|\s)btn(?=$|\s|\$)/.test(value),
    ).length;
    if (rawButtonClasses > 0) observed[relativeFile] = rawButtonClasses;
    const rawIconButtonClasses = sourceLiterals(source, relativeFile).filter(
      ({ value }) => /(?:^|\s)icon-btn(?=$|\s|\$)/.test(value),
    ).length;
    if (rawIconButtonClasses > 0) {
      observedIconButtons[relativeFile] = rawIconButtonClasses;
    }
  }

  const isUiSource =
    relativeFile === "app/root.tsx" ||
    relativeFile.startsWith("app/components/") ||
    relativeFile.startsWith("app/routes/");
  if (isUiSource) {
    for (const string of sourceLiterals(source, relativeFile)) {
      for (const match of string.value.matchAll(/#[0-9a-f]{3,8}\b/gi)) {
        const line = source
          .slice(0, string.index + match.index)
          .split("\n").length;
        failures.push(
          `${relativeFile}:${line} [ui-colour-literal] ${match[0]} belongs in CSS tokens or app/lib/product-colours.ts`,
        );
      }
    }
    for (const violation of formControlViolations(source, relativeFile)) {
      failures.push(
        `${relativeFile}:${violation.line} [form-control] ${violation.detail}`,
      );
    }
  }
}

for (const [file, count] of Object.entries(observed)) {
  failures.push(
    `${file}:0 [raw-button-class] ${count} raw btn class strings. Use Button or ButtonLink.`,
  );
}

for (const [file, count] of Object.entries(observedIconButtons)) {
  failures.push(
    `${file}:0 [raw-icon-button-class] ${count} raw icon-btn class strings. Use IconButton or IconButtonAnchor.`,
  );
}

if (failures.length > 0) {
  console.error(`Design-system adoption: ${failures.length} violation(s)\n`);
  for (const failure of failures.slice(0, 40)) console.error(`  ${failure}`);
  if (failures.length > 40) {
    console.error(`  … and ${failures.length - 40} more`);
  }
  process.exit(1);
}

const total = Object.values(observed).reduce((sum, count) => sum + count, 0);
const iconButtonTotal = Object.values(observedIconButtons).reduce(
  (sum, count) => sum + count,
  0,
);
console.log(
  `Design-system adoption: ${total} raw button and ${iconButtonTotal} raw icon-button class strings; form controls use owned chrome.`,
);
