/*
 * CSS hygiene gate.
 *
 * The design system is expressed as tokens in app/styles/base.css. These four
 * rules stop the codebase drifting back to literals, which is how it accreted
 * 123 hex colours, 29 font sizes and 29 spacing values in the first place.
 *
 *   1. No hex literal that already has a token.
 *   2. No var(--x) without a definition.
 *   3. No font-size below the 12px floor.
 *   4. No raw px padding/margin/gap outside the token layer.
 *
 * base.css is the token layer and is exempt from 1, 3 and 4 by design.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { repositoryRoot } from "./e2e-runtime.mjs";

const STYLE_DIR = join(repositoryRoot, "app/styles");
const TOKEN_FILE = "tokens.css";
const MIN_FONT_PX = 12;
const BASELINE_PATH = join(repositoryRoot, "scripts/css-literal-baseline.json");
const UPDATE_BASELINE = process.argv.includes("--update-baseline");

/* Values that are legitimately not tokens. */
const ALLOWED_HEX = new Set(["#fff", "#ffffff", "#000", "#000000"]);
/* Structural values a spacing token would not improve. */
const ALLOWED_SPACE_PX = new Set(["0px", "1px", "2px", "3px"]);

const files = readdirSync(STYLE_DIR).filter((name) => name.endsWith(".css"));
const sources = new Map(
  files.map((name) => [name, readFileSync(join(STYLE_DIR, name), "utf8")]),
);
const tokenSource = sources.get(TOKEN_FILE) ?? "";

/* --- token inventory ---------------------------------------------------- */
const tokenValues = new Map(); // hex value -> token name
const definedTokens = new Set();
for (const [, name, value] of tokenSource.matchAll(
  /(--[a-z0-9-]+)\s*:\s*([^;]+);/gi,
)) {
  definedTokens.add(name);
  const hex = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3,8}$/.test(hex) && !ALLOWED_HEX.has(hex)) {
    if (!tokenValues.has(hex)) tokenValues.set(hex, name);
  }
}
for (const source of sources.values()) {
  for (const [, name] of source.matchAll(/(--[a-z0-9-]+)\s*:/gi)) {
    definedTokens.add(name);
  }
}
/* Set from TSX via inline style, not from CSS. */
for (const name of [
  "--event-accent",
  "--pct",
  "--rail",
  "--grid-min",
  "--hero-image",
  "--eval-banner-offset",
  "--pc-entry-offset",
  "--pc-entry-minutes",
  "--pc-entry-column",
  "--pc-entry-columns",
  "--timetable-min-width",
  "--timetable-columns",
  "--timetable-rows",
  "--timetable-column",
  "--timetable-row",
]) {
  definedTokens.add(name);
}

const failures = [];
const record = (file, line, rule, detail) =>
  failures.push({ file, line, rule, detail });

/* Every hex literal seen outside the token layer, and where it appeared. */
const observed = {};
const literalLines = [];
let baseline = {};
try {
  baseline = JSON.parse(readFileSync(BASELINE_PATH, "utf8")).literals ?? {};
} catch {
  baseline = {};
}

for (const [file, source] of sources) {
  const isTokenFile = file === TOKEN_FILE;
  const lines = source.split("\n");

  lines.forEach((text, index) => {
    const line = index + 1;
    const code = text.split("/*")[0];
    if (!code.trim()) return;

    /* 2. undefined custom properties — applies everywhere including base.css */
    for (const [, name] of code.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
      if (!definedTokens.has(name)) {
        record(file, line, "undefined-token", `var(${name}) is never defined`);
      }
    }

    if (isTokenFile) return;

    /* 1. hex literals that duplicate a token, and any literal not already
       recorded in the baseline. The baseline is a ceiling: removing literals
       never fails, introducing one always does. */
    for (const [, hex] of code.matchAll(/(#[0-9a-f]{3,8})\b/gi)) {
      const value = hex.toLowerCase();
      if (ALLOWED_HEX.has(value)) continue;
      observed[file] ??= {};
      observed[file][value] = (observed[file][value] ?? 0) + 1;
      literalLines.push({ file, line, value });
      const token = tokenValues.get(value);
      if (token) {
        record(file, line, "retyped-token", `${hex} is var(${token})`);
      }
    }

    /* 3. font sizes below the readable floor */
    for (const [, size] of code.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/gi)) {
      if (Number(size) < MIN_FONT_PX) {
        record(
          file,
          line,
          "tiny-type",
          `${size}px is below the ${MIN_FONT_PX}px floor`,
        );
      }
    }

    /* 4. raw px spacing.
       Fluid values are exempt: clamp()/calc()/min()/max() spacing is a
       deliberate responsive choice, not the drift this rule exists to catch.
       Negative offsets are optical corrections, not scale steps. */
    for (const [, prop, value] of code.matchAll(
      /(?:^|[;{]|\s)(padding|margin|gap|row-gap|column-gap)(?:-(?:top|right|bottom|left|inline|block))?\s*:\s*([^;{]+)/gi,
    )) {
      if (/\b(clamp|calc|min|max)\(/i.test(value)) continue;
      for (const [, px] of value.matchAll(/(-?\d+px)/g)) {
        if (ALLOWED_SPACE_PX.has(px) || px.startsWith("-")) continue;
        record(
          file,
          line,
          "raw-space",
          `${prop}: ${px} should use a --space-* token`,
        );
      }
    }
  });
}

if (UPDATE_BASELINE) {
  const sorted = {};
  for (const file of Object.keys(observed).sort()) {
    sorted[file] = Object.fromEntries(
      Object.entries(observed[file]).sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  const total = Object.values(observed).reduce(
    (sum, values) => sum + Object.values(values).reduce((a, b) => a + b, 0),
    0,
  );
  writeFileSync(
    BASELINE_PATH,
    `${JSON.stringify(
      {
        note: "Hex literals outside app/styles/tokens.css that predate the token layer. This is a ceiling: removing literals passes, introducing one fails. Regenerate with: node scripts/check-css-hygiene.mjs --update-baseline",
        total,
        literals: sorted,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`CSS hygiene: baseline written with ${total} recorded literals.`);
  process.exit(0);
}

/* Any literal beyond what the baseline records is new and must be a token. */
for (const { file, line, value } of literalLines) {
  const allowed = baseline[file]?.[value] ?? 0;
  if (allowed === 0) {
    record(
      file,
      line,
      "new-literal",
      `${value} is not a token; declare it in ${TOKEN_FILE}`,
    );
  }
}
for (const [file, values] of Object.entries(observed)) {
  for (const [value, count] of Object.entries(values)) {
    const allowed = baseline[file]?.[value] ?? 0;
    if (allowed > 0 && count > allowed) {
      record(
        file,
        0,
        "new-literal",
        `${value} appears ${count} times, baseline allows ${allowed}`,
      );
    }
  }
}

if (failures.length > 0) {
  const byRule = new Map();
  for (const failure of failures) {
    byRule.set(failure.rule, (byRule.get(failure.rule) ?? 0) + 1);
  }
  console.error(`CSS hygiene: ${failures.length} violation(s)\n`);
  for (const failure of failures.slice(0, 40)) {
    console.error(
      `  ${failure.file}:${failure.line}  [${failure.rule}] ${failure.detail}`,
    );
  }
  if (failures.length > 40) {
    console.error(`  … and ${failures.length - 40} more`);
  }
  console.error("");
  for (const [rule, count] of [...byRule].sort((a, b) => b[1] - a[1])) {
    console.error(`  ${String(count).padStart(5)}  ${rule}`);
  }
  process.exit(1);
}

console.log(`CSS hygiene: ${sources.size} stylesheets clean.`);
