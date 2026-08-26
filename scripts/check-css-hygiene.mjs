/*
 * CSS hygiene gate.
 *
 * The design system is expressed as tokens in app/styles/tokens.css. These
 * rules stop literals and cascade contracts drifting.
 *
 *   1. No non-system hex literal outside the token layer.
 *   2. No var(--x) without a definition.
 *   3. No font-size below the 12px floor.
 *   4. No raw px padding/margin/gap outside the token layer.
 *   5. No raw shadows outside the semantic elevation/focus roles.
 *   6. Breakpoints use the shared responsive vocabulary.
 *   7. Core selectors have one owning stylesheet.
 *   8. Descending-specificity diagnostics cannot be suppressed.
 *
 * tokens.css is exempt from literal rules by design.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  hasSpecificitySuppression,
  isTokenizedShadow,
  withoutCssComments,
} from "./design-system-checks.mjs";
import { repositoryRoot } from "./e2e-runtime.mjs";

const STYLE_DIR = join(repositoryRoot, "app/styles");
const TOKEN_FILE = "tokens.css";
const MIN_FONT_PX = 12;
const CANONICAL_BREAKPOINTS = new Set([
  360, 400, 560, 600, 760, 761, 900, 1_000, 1_001, 1_180, 1_181, 1_350, 1_351,
]);
const CORE_SELECTOR_OWNERS = new Map([
  ["btn", "base.css"],
  ["icon-btn", "base.css"],
  ["field", "form-controls.css"],
  ["select", "form-controls.css"],
  ["textarea", "form-controls.css"],
  ["pill", "form-controls.css"],
  ["status", "design-primitives.css"],
]);

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

for (const [file, source] of sources) {
  const isTokenFile = file === TOKEN_FILE;
  const lines = source.split("\n");
  const cssWithoutComments = withoutCssComments(source);
  const codeLines = cssWithoutComments.split("\n");

  lines.forEach((text, index) => {
    const line = index + 1;
    if (hasSpecificitySuppression(text)) {
      record(
        file,
        line,
        "specificity-suppression",
        "resolve the cascade instead of suppressing noDescendingSpecificity",
      );
    }
    const code = codeLines[index];
    if (!code.trim()) return;

    /* 2. undefined custom properties — applies everywhere including base.css */
    for (const [, name] of code.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)) {
      if (!definedTokens.has(name)) {
        record(file, line, "undefined-token", `var(${name}) is never defined`);
      }
    }

    if (isTokenFile) return;

    const coreSelector = code.match(
      /^\s*\.(btn|icon-btn|field|select|textarea|pill|status)\s*(?:,|\{)/,
    )?.[1];
    if (coreSelector) {
      const owner = CORE_SELECTOR_OWNERS.get(coreSelector);
      if (file !== owner) {
        record(
          file,
          line,
          "selector-owner",
          `.${coreSelector} is owned by ${owner}`,
        );
      }
    }

    /* 1. Every non-system hex belongs in the token layer. */
    for (const [, hex] of code.matchAll(/(#[0-9a-f]{3,8})\b/gi)) {
      const value = hex.toLowerCase();
      if (ALLOWED_HEX.has(value)) continue;
      const token = tokenValues.get(value);
      if (token) {
        record(file, line, "retyped-token", `${hex} is var(${token})`);
      } else {
        record(
          file,
          line,
          "colour-literal",
          `${hex} must be declared in ${TOKEN_FILE}`,
        );
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

  /* 5. Match complete declarations so multiline and mixed recipes cannot
     evade the raw-shadow gate. A declaration is tokenized only when the whole
     value is a semantic elevation or focus token; merely including one token
     beside a raw layer is not sufficient. */
  for (const match of cssWithoutComments.matchAll(
    /box-shadow\s*:\s*([^;{}]+)/gi,
  )) {
    const value = match[1];
    if (isTokenizedShadow(value)) {
      continue;
    }
    record(
      file,
      source.slice(0, match.index).split("\n").length,
      "raw-shadow",
      "use a semantic --elev-* or --focus-* shadow token",
    );
  }

  /* 6. Paired min-width boundaries one pixel above a max-width are explicit
     members of the vocabulary rather than hidden exceptions. */
  for (const mediaMatch of cssWithoutComments.matchAll(
    /@media\b([^{}]*)\{/gi,
  )) {
    for (const widthMatch of mediaMatch[1].matchAll(
      /\((?:min|max)-width:\s*(\d+)px\)/gi,
    )) {
      const value = Number(widthMatch[1]);
      if (CANONICAL_BREAKPOINTS.has(value)) continue;
      const key = `${value}px`;
      const index = mediaMatch.index + widthMatch.index;
      record(
        file,
        source.slice(0, index).split("\n").length,
        "non-canonical-breakpoint",
        `${key} is outside ${[...CANONICAL_BREAKPOINTS].join(", ")}px`,
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
