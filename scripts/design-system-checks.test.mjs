import assert from "node:assert/strict";
import test from "node:test";

import {
  formControlViolations,
  hasSpecificitySuppression,
  isTokenizedShadow,
  sourceLiterals,
  withoutCssComments,
} from "./design-system-checks.mjs";

test("withoutCssComments preserves source positions and ignores comment examples", () => {
  const source = ".card {\n  color: var(--ink); /* #123456 */\n}\n";
  const stripped = withoutCssComments(source);

  assert.equal(stripped.length, source.length);
  assert.equal(stripped.split("\n").length, source.split("\n").length);
  assert.equal(stripped.includes("#123456"), false);
  assert.equal(stripped.includes("color: var(--ink);"), true);
});

test("sourceLiterals scans syntax rather than quoted comments", () => {
  const source = `
    // "btn danger" and "#123456" are documentation, not source values.
    const base = "btn primary";
    const dynamic = \`btn small \${tone}\`;
  `;

  assert.deepEqual(
    sourceLiterals(source).map(({ value }) => value),
    ["btn primary", "btn small "],
  );
});

test("isTokenizedShadow rejects a raw layer mixed with a semantic token", () => {
  assert.equal(isTokenizedShadow("var(--elev-3)"), true);
  assert.equal(isTokenizedShadow("none !important"), true);
  assert.equal(
    isTokenizedShadow("inset 3px 0 0 var(--state-bad-solid), var(--elev-1)"),
    false,
  );
  assert.equal(
    isTokenizedShadow("0 0 0 var(--focus-halo-width) var(--focus-halo)"),
    false,
  );
});

test("specificity suppressions cannot replace a cascade fix", () => {
  assert.equal(
    hasSpecificitySuppression(
      "/* biome-ignore lint/style/noDescendingSpecificity: unrelated */",
    ),
    true,
  );
  assert.equal(
    hasSpecificitySuppression("/* ordinary cascade explanation */"),
    false,
  );
});

test("form controls use canonical or explicit specialized chrome", () => {
  const source = `
    <>
      <input className="field" />
      <select className="select"><option>One</option></select>
      <textarea className="textarea" />
      <input className="branding-accent-hex" />
      <input type="checkbox" />
      <input type="hidden" />
    </>
  `;

  assert.deepEqual(formControlViolations(source), []);
});

test("form controls reject missing and mismatched chrome", () => {
  const source = `
    <>
      <input className="input" />
      <select />
      <textarea className="field" />
      <input className={invalid ? "field" : ""} />
    </>
  `;

  assert.deepEqual(
    formControlViolations(source).map(({ tag }) => tag),
    ["input", "select", "textarea", "input"],
  );
});

test("form controls accept chrome guaranteed by every dynamic branch", () => {
  const source = `
    <>
      <input className={invalid ? "field has-error" : "field"} />
      <select className={cn("select", compact && "compact")} />
      <textarea className={\`textarea \${tone}\`} />
    </>
  `;

  assert.deepEqual(formControlViolations(source), []);
});
