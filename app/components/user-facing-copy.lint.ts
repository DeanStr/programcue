import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

// A `.lint.ts` file reads the repository from disk, so it compiles under the
// Node project rather than the Worker one, and imports nothing from `app`.
// See tsconfig.node.json.

const APP = resolve(import.meta.dirname, "..");

/**
 * Vocabulary that describes how Program Cue is built rather than what the
 * reader is doing. Each entry leaked into a rendered surface at least once
 * before this test existed: storage products the reader has never heard of,
 * library names, and the internal words for records and identifiers.
 */
const NAMED_PRODUCTS = [
  { pattern: /\bD1\b/u, note: "storage product name" },
  { pattern: /\bR2\b/u, note: "storage product name" },
  { pattern: /\bKV\b/u, note: "storage product name" },
  { pattern: /\bDurable Object/iu, note: "runtime primitive" },
  { pattern: /\bUppy\b/u, note: "library name" },
  { pattern: /bpmn\.io/u, note: "library name" },
];

const BANNED = [
  ...NAMED_PRODUCTS,
  { pattern: /\bbinding\b/iu, note: "deployment wiring" },
  { pattern: /\bmultipart\b/iu, note: "transfer protocol detail" },
  {
    pattern: /\bprojection\b/iu,
    note: "internal word for a synchronised copy",
  },
  { pattern: /\boutbox\b/iu, note: "internal delivery mechanism" },
  { pattern: /\bidempotenc/iu, note: "internal retry mechanism" },
  { pattern: /\bfingerprint\b/iu, note: "internal identifier" },
  { pattern: /\bepoch\b/iu, note: "internal timestamp format" },
  { pattern: /\btenanc(y|ies)\b/iu, note: "internal isolation model" },
  { pattern: /\bupsert\b/iu, note: "database operation" },
  { pattern: /\bno-?op\b/iu, note: "database operation" },
  { pattern: /\bserializ|\bdeserializ/iu, note: "encoding detail" },
  { pattern: /\bfan-?out\b/iu, note: "internal delivery mechanism" },
  { pattern: /\bJSON\b/u, note: "encoding detail" },
  { pattern: /\bboolean\b/iu, note: "type jargon" },
  { pattern: /\bnullable\b/iu, note: "type jargon" },
  { pattern: /\bHTTP \d{3}\b/u, note: "protocol status code" },
  { pattern: /\bstatus \d{3}\b/u, note: "protocol status code" },
];

/**
 * Surfaces whose audience really is technical, and where the vocabulary above
 * is the accurate word rather than a leak. Each needs a stated reason; nothing
 * is exempt by default.
 */
const EXEMPT_PATTERNS: ReadonlyArray<{ pattern: RegExp; reason: string }> = [
  {
    pattern: /^routes\/api-[^/]+\.ts$/u,
    reason:
      "JSON API and provider webhook endpoints, where the caller is a program and the protocol is the subject.",
  },
  {
    pattern: /^routes\/demo-[^/]+\.tsx?$/u,
    reason:
      "Demonstration fixtures, which describe the mechanism they are demonstrating.",
  },
];

const EXEMPT: ReadonlyArray<{ file: string; reason: string }> = [
  {
    file: "routes/demo-guide.tsx",
    reason:
      "Internal demonstration walkthrough that documents the architecture on purpose.",
  },
  {
    file: "routes/evaluation-guide.tsx",
    reason:
      "Internal evaluation walkthrough that documents the architecture on purpose.",
  },
  {
    file: "routes/api-docs.tsx",
    reason:
      "API reference written for developers integrating with Program Cue.",
  },
  {
    file: "routes/api-settings.tsx",
    reason:
      "API key and outbound webhook setup, read by whoever writes the consumer.",
  },
  {
    file: "components/programme-embed-builder.tsx",
    reason:
      "Feed format links (JSON, HTML, iCal) for whoever embeds the programme in a website; the format is the label.",
  },
];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    if (!/\.tsx?$/u.test(path)) return [];
    // Tests quote the vocabulary they assert on, and this lint spells it out.
    if (/\.(test|lint)\.tsx?$/u.test(path)) return [];
    return [path];
  });
}

/**
 * Attribute names whose value is read by a person. Every other attribute holds
 * a class name, a route, a form value or an element id, none of which reach the
 * screen as words.
 */
const COPY_ATTRIBUTES = new Set([
  "alt",
  "aria-label",
  "aria-description",
  "caption",
  "confirmLabel",
  "description",
  "detail",
  "heading",
  "help",
  "hint",
  "label",
  "message",
  "notice",
  "placeholder",
  "problem",
  "subject",
  "summary",
  "title",
]);

/** Literals that are addressed to a database or a router, not to a person. */
function isMachineText(text: string) {
  return (
    /^(SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|DROP|ALTER|PRAGMA|BEGIN|COMMIT)\b/iu.test(
      text,
    ) ||
    (/\bFROM\b/u.test(text) && /\bWHERE\b|\bJOIN\b/u.test(text)) ||
    /^\/[^\s]*\/?/u.test(text)
  );
}

/**
 * Text a reader could plausibly see, read from a real parse of the file.
 *
 * Two earlier versions of this matched `>text<` with a regex, and both shipped
 * a leak that the passing lint hid: first anything Prettier had wrapped across
 * lines, then anything sitting beside a `{…}` interpolation, because `{` and
 * `}` had to be excluded from the pattern to keep TypeScript generics out. The
 * parser knows which angle brackets open an element and which close a generic,
 * so neither compromise is needed and neither blind spot can come back.
 *
 * `prose` holds anything containing a space and is checked against the whole
 * banned list. `identifiers` are single tokens — paths, class names, stored
 * values — where only the product and library names mean anything, and where a
 * bare `D1` or `R2` is still a leak if it reaches the screen.
 */
function renderedText(source: string, fileName = "copy.tsx") {
  const file = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  // A lone text child is reported both on its own and by the element join
  // below, so both buckets are sets: one leak should be listed once.
  const prose = new Set<string>();
  const identifiers = new Set<string>();

  const collect = (raw: string, machineTextPossible: boolean) => {
    const text = raw.replaceAll(/\s+/gu, " ").trim();
    if (!/[a-zA-Z]/u.test(text)) return;
    if (machineTextPossible && isMachineText(text)) return;
    (/\s/u.test(text) ? prose : identifiers).add(text);
  };

  /** True when this literal is a module path, or an attribute nobody reads. */
  const isNonCopyPosition = (node: ts.Node) => {
    const parent = node.parent;
    if (!parent) return false;
    if (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent))
      return true;
    if (ts.isJsxAttribute(parent))
      return !COPY_ATTRIBUTES.has(parent.name.getText(file));
    if (ts.isJsxExpression(parent) && parent.parent) {
      const attribute = parent.parent;
      if (ts.isJsxAttribute(attribute))
        return !COPY_ATTRIBUTES.has(attribute.name.getText(file));
    }
    return false;
  };

  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) {
      collect(node.text, false);
    } else if (
      ts.isStringLiteral(node) ||
      ts.isNoSubstitutionTemplateLiteral(node)
    ) {
      if (!isNonCopyPosition(node)) collect(node.text, true);
    } else if (ts.isTemplateExpression(node)) {
      // Interpolations are values, not copy. A space keeps the words either
      // side of the hole from running together into a phantom compound.
      collect(
        [node.head.text, ...node.templateSpans.map((span) => span.literal.text)]
          .join(" ")
          .trim(),
        true,
      );
    }

    // A sentence broken by an interpolation arrives as several JsxText nodes.
    // Joining an element's own text children restores what the reader sees, so
    // a banned word spanning the break is still caught.
    if (ts.isJsxElement(node) || ts.isJsxFragment(node)) {
      const joined = node.children
        .filter((child): child is ts.JsxText => ts.isJsxText(child))
        .map((child) => child.text)
        .join(" ");
      if (joined.trim()) collect(joined, false);
    }

    ts.forEachChild(node, visit);
  };

  visit(file);
  return { prose: [...prose], identifiers: [...identifiers] };
}

describe("user-facing copy", () => {
  const files = sourceFiles(join(APP, "routes")).concat(
    sourceFiles(join(APP, "components")),
  );

  it("scans the rendering layer", () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it("never shows Program Cue's implementation vocabulary to a reader", () => {
    const exempt = new Set(EXEMPT.map((entry) => entry.file));
    const leaks: string[] = [];
    for (const file of files) {
      const name = relative(APP, file).replaceAll("\\", "/");
      if (exempt.has(name)) continue;
      if (EXEMPT_PATTERNS.some((entry) => entry.pattern.test(name))) continue;
      const { prose, identifiers } = renderedText(readFileSync(file, "utf8"));
      for (const [texts, patterns] of [
        [prose, BANNED],
        [identifiers, NAMED_PRODUCTS],
      ] as const) {
        for (const text of texts) {
          const banned = patterns.find((entry) => entry.pattern.test(text));
          if (banned)
            leaks.push(`${name}: ${banned.note} — ${text.slice(0, 120)}`);
        }
      }
    }
    expect(leaks).toEqual([]);
  });

  it("keeps every exemption pointed at a file that still exists", () => {
    const names = new Set(
      files.map((file) => relative(APP, file).replaceAll("\\", "/")),
    );
    expect(EXEMPT.filter((entry) => !names.has(entry.file))).toEqual([]);
  });
});

/**
 * A green lint is only worth something if it would have gone red.
 *
 * These are the shapes real copy takes in this codebase, and the shapes that
 * previously produced false positives. Without them the check above silently
 * degrades into a test that passes because it looks at nothing — which is
 * exactly what happened when it only matched single-line JSX.
 */
describe("copy detection", () => {
  const flagged = (source: string) => {
    const { prose, identifiers } = renderedText(source);
    return [
      ...prose.filter((text) => BANNED.some((rule) => rule.pattern.test(text))),
      ...identifiers.filter((text) =>
        NAMED_PRODUCTS.some((rule) => rule.pattern.test(text)),
      ),
    ];
  };

  it("reads a sentence that Prettier wrapped across lines", () => {
    expect(
      flagged(`
        <p className="help">
          Secrets and the Workers AI binding stay in the deployment
          environment.
        </p>
      `),
    ).toEqual([
      "Secrets and the Workers AI binding stay in the deployment environment.",
    ]);
  });

  it("reads a short JSX label on its own line", () => {
    expect(flagged(`<button>\n  Retry this projection\n</button>`)).toEqual([
      "Retry this projection",
    ]);
  });

  it("reads a bare product name with no surrounding prose", () => {
    expect(flagged(`const label = "D1";`)).toEqual(["D1"]);
    expect(flagged(`<span>\n  R2\n</span>`)).toEqual(["R2"]);
  });

  it("reads copy passed as a prop rather than rendered as a child", () => {
    expect(
      flagged(`<X description="Uploading to private R2 with Uppy." />`),
    ).toEqual(["Uploading to private R2 with Uppy."]);
  });

  it("reads an interpolated sentence in a template literal", () => {
    expect(
      flagged("const m = `Saved to D1 as revision ${revision}.`;"),
    ).toEqual(["Saved to D1 as revision ."]);
  });

  it("ignores TypeScript generics that sit between angle brackets", () => {
    expect(
      flagged(
        `type X = { dirty: boolean; setDirty: Dispatch<SetStateAction<boolean>> };`,
      ),
    ).toEqual([]);
  });

  it("ignores SQL and request paths", () => {
    expect(
      flagged(
        "const q = `SELECT id FROM operation_jobs WHERE idempotency_key = ?`;",
      ),
    ).toEqual([]);
    expect(flagged('const u = "/files/multipart/initiate";')).toEqual([]);
  });

  it("ignores a lowercase stored value that shares a product's spelling", () => {
    expect(flagged('<input value="d1" name="repositoryProvider" />')).toEqual(
      [],
    );
  });
});
