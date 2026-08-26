import ts from "typescript";

/** Remove CSS comments without changing offsets or line numbers. */
export function withoutCssComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    comment.replace(/[^\n]/g, " "),
  );
}

/** Return real JavaScript/JSX string segments without matching quoted comments. */
export function sourceLiterals(source, fileName = "source.tsx") {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const literals = [];

  function visit(node) {
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        node.kind === ts.SyntaxKind.TemplateHead ||
        node.kind === ts.SyntaxKind.TemplateMiddle ||
        node.kind === ts.SyntaxKind.TemplateTail) &&
      node.text.length > 0
    ) {
      literals.push({ value: node.text, index: node.getStart(sourceFile) + 1 });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return literals;
}

const FORM_CONTROL_CLASSES = {
  input: new Set([
    "field",
    "branding-accent-hex",
    "fb-canvas-preview-control",
    "fb-inline-input",
  ]),
  select: new Set(["select", "fb-canvas-preview-control"]),
  textarea: new Set([
    "textarea",
    "fb-canvas-preview-control",
    "fb-inline-input",
  ]),
};
const INPUT_TYPES_WITH_OWN_CHROME = new Set([
  "button",
  "checkbox",
  "color",
  "file",
  "hidden",
  "image",
  "radio",
  "range",
  "reset",
  "submit",
]);

function jsxAttribute(node, name) {
  return node.attributes.properties.find(
    (property) =>
      ts.isJsxAttribute(property) && property.name.getText() === name,
  );
}

function jsxAttributeValue(node, name, sourceFile) {
  const attribute = jsxAttribute(node, name);
  if (!attribute?.initializer) return "";
  if (ts.isStringLiteral(attribute.initializer)) {
    return attribute.initializer.text;
  }
  if (
    ts.isJsxExpression(attribute.initializer) &&
    attribute.initializer.expression
  ) {
    if (
      ts.isStringLiteral(attribute.initializer.expression) ||
      ts.isNoSubstitutionTemplateLiteral(attribute.initializer.expression)
    ) {
      return attribute.initializer.expression.text;
    }
    return attribute.initializer.expression.getText(sourceFile);
  }
  return attribute.initializer.getText(sourceFile);
}

function literalClassNames(value, leftBoundary = true, rightBoundary = true) {
  const classes = new Set();
  for (const match of value.matchAll(/\S+/g)) {
    const start = match.index;
    const end = start + match[0].length;
    if ((start > 0 || leftBoundary) && (end < value.length || rightBoundary)) {
      classes.add(match[0]);
    }
  }
  return classes;
}

function unionClasses(target, source) {
  for (const className of source) target.add(className);
  return target;
}

function intersectClasses(left, right) {
  return new Set([...left].filter((className) => right.has(className)));
}

/** Classes that every runtime result of an expression is guaranteed to keep. */
function guaranteedClassNames(expression) {
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return literalClassNames(expression.text);
  }
  if (ts.isParenthesizedExpression(expression)) {
    return guaranteedClassNames(expression.expression);
  }
  if (ts.isTemplateExpression(expression)) {
    const classes = literalClassNames(expression.head.text, true, false);
    expression.templateSpans.forEach((span, index) => {
      unionClasses(
        classes,
        literalClassNames(
          span.literal.text,
          false,
          index === expression.templateSpans.length - 1,
        ),
      );
    });
    return classes;
  }
  if (ts.isConditionalExpression(expression)) {
    return intersectClasses(
      guaranteedClassNames(expression.whenTrue),
      guaranteedClassNames(expression.whenFalse),
    );
  }
  if (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    ["cn", "clsx"].includes(expression.expression.text)
  ) {
    return expression.arguments.reduce(
      (classes, argument) =>
        unionClasses(classes, guaranteedClassNames(argument)),
      new Set(),
    );
  }
  return new Set();
}

function jsxGuaranteedClassNames(node, sourceFile) {
  const attribute = jsxAttribute(node, "className");
  if (!attribute?.initializer) return new Set();
  if (ts.isStringLiteral(attribute.initializer)) {
    return literalClassNames(attribute.initializer.text);
  }
  if (
    ts.isJsxExpression(attribute.initializer) &&
    attribute.initializer.expression
  ) {
    return guaranteedClassNames(attribute.initializer.expression);
  }
  return literalClassNames(attribute.initializer.getText(sourceFile));
}

/**
 * Editable native controls must opt into the shared chrome or one of the few
 * deliberately specialized control treatments. Hidden fields and native
 * controls with their own visual contract are outside this rule.
 */
export function formControlViolations(source, fileName = "source.tsx") {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const violations = [];

  function visit(node) {
    const element =
      ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)
        ? node
        : null;
    if (element) {
      const tag = element.tagName.getText(sourceFile);
      const allowedClasses = FORM_CONTROL_CLASSES[tag];
      if (allowedClasses) {
        const type = jsxAttributeValue(element, "type", sourceFile);
        if (!(tag === "input" && INPUT_TYPES_WITH_OWN_CHROME.has(type))) {
          const classNames = jsxGuaranteedClassNames(element, sourceFile);
          if (![...allowedClasses].some((allowed) => classNames.has(allowed))) {
            const { line } = sourceFile.getLineAndCharacterOfPosition(
              element.getStart(sourceFile),
            );
            violations.push({
              line: line + 1,
              tag,
              detail: `<${tag}> must use ${[...allowedClasses]
                .map((allowed) => `.${allowed}`)
                .join(" or ")}`,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

/** A shadow is tokenized only when its complete value is an approved role. */
export function isTokenizedShadow(value) {
  return /^(?:none|var\(--(?:elev-(?:[0-4]|top-3|overlay)|focus-(?:halo-shadow|error-halo|selection))\))(?:\s*!important)?$/i.test(
    value.replace(/\s+/g, " ").trim(),
  );
}

/** Specificity debt must be fixed, not hidden from the repository gate. */
export function hasSpecificitySuppression(value) {
  return /biome-ignore(?:-all)?\b[^\n]*\bnoDescendingSpecificity\b/.test(value);
}
