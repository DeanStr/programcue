import { z } from "zod";

import { allowedResourceEmbedUrl } from "./resource-embed-policy";

type TiptapMark = { type: string; attrs?: Record<string, any> };
export type TiptapNode = {
  type: string;
  attrs?: Record<string, any>;
  marks?: TiptapMark[];
  text?: string;
  content?: TiptapNode[];
};

const documentEnvelope = z.object({
  type: z.literal("doc"),
  content: z.array(z.unknown()).default([]),
});
const allowedNodeTypes = new Set([
  "doc",
  "paragraph",
  "heading",
  "bulletList",
  "orderedList",
  "listItem",
  "blockquote",
  "codeBlock",
  "horizontalRule",
  "hardBreak",
  "text",
  "embed",
]);

export class ResourceContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceContentError";
  }
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeUrl(raw: unknown, allowedProtocols = ["https:", "mailto:"]) {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw);
    return allowedProtocols.includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function validateNode(
  raw: unknown,
  depth: number,
  state: { count: number },
): TiptapNode {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new ResourceContentError(
      "Resource content contains an invalid node.",
    );
  if (depth > 20)
    throw new ResourceContentError("Resource content is nested too deeply.");
  state.count += 1;
  if (state.count > 4_000)
    throw new ResourceContentError("Resource content contains too many nodes.");
  const node = raw as Record<string, unknown>;
  if (typeof node.type !== "string" || !allowedNodeTypes.has(node.type))
    throw new ResourceContentError(
      `Resource node type ${String(node.type)} is not allowed.`,
    );
  const validated: TiptapNode = { type: node.type };
  if (typeof node.text === "string")
    validated.text = node.text.slice(0, 20_000);
  if (
    node.attrs &&
    typeof node.attrs === "object" &&
    !Array.isArray(node.attrs)
  )
    validated.attrs = node.attrs as Record<string, any>;
  if (Array.isArray(node.marks))
    validated.marks = node.marks.slice(0, 12).map((mark) => {
      if (!mark || typeof mark !== "object")
        throw new ResourceContentError(
          "Resource content contains an invalid mark.",
        );
      const value = mark as { type?: unknown; attrs?: Record<string, any> };
      if (
        !["bold", "italic", "strike", "code", "link"].includes(
          String(value.type),
        )
      )
        throw new ResourceContentError(
          `Resource mark ${String(value.type)} is not allowed.`,
        );
      return {
        type: String(value.type),
        attrs:
          value.attrs && typeof value.attrs === "object"
            ? value.attrs
            : undefined,
      };
    });
  if (Array.isArray(node.content))
    validated.content = node.content.map((child) =>
      validateNode(child, depth + 1, state),
    );
  return validated;
}

export function parseResourceDocument(raw: unknown): TiptapNode {
  const envelope = documentEnvelope.parse(raw);
  return validateNode(envelope, 0, { count: 0 });
}

function renderChildren(
  node: TiptapNode,
  allowedEmbedOrigins: readonly string[],
) {
  return (node.content ?? [])
    .map((child) => renderNode(child, allowedEmbedOrigins))
    .join("");
}

function renderText(node: TiptapNode) {
  let content = escapeHtml(node.text ?? "");
  for (const mark of node.marks ?? []) {
    if (mark.type === "bold") content = `<strong>${content}</strong>`;
    if (mark.type === "italic") content = `<em>${content}</em>`;
    if (mark.type === "strike") content = `<s>${content}</s>`;
    if (mark.type === "code") content = `<code>${content}</code>`;
    if (mark.type === "link") {
      const href = safeUrl(mark.attrs?.href);
      if (href)
        content = `<a href="${escapeHtml(href)}" rel="noreferrer noopener">${content}</a>`;
    }
  }
  return content;
}

function renderNode(
  node: TiptapNode,
  allowedEmbedOrigins: readonly string[],
): string {
  switch (node.type) {
    case "doc":
      return renderChildren(node, allowedEmbedOrigins);
    case "text":
      return renderText(node);
    case "paragraph":
      return `<p>${renderChildren(node, allowedEmbedOrigins)}</p>`;
    case "heading": {
      const level = Math.min(4, Math.max(2, Number(node.attrs?.level) || 2));
      return `<h${level}>${renderChildren(node, allowedEmbedOrigins)}</h${level}>`;
    }
    case "bulletList":
      return `<ul>${renderChildren(node, allowedEmbedOrigins)}</ul>`;
    case "orderedList":
      return `<ol>${renderChildren(node, allowedEmbedOrigins)}</ol>`;
    case "listItem":
      return `<li>${renderChildren(node, allowedEmbedOrigins)}</li>`;
    case "blockquote":
      return `<blockquote>${renderChildren(node, allowedEmbedOrigins)}</blockquote>`;
    case "codeBlock":
      return `<pre><code>${renderChildren(node, allowedEmbedOrigins)}</code></pre>`;
    case "horizontalRule":
      return "<hr>";
    case "hardBreak":
      return "<br>";
    case "embed": {
      const src = allowedResourceEmbedUrl(node.attrs?.src, allowedEmbedOrigins);
      const title =
        typeof node.attrs?.title === "string"
          ? node.attrs.title.slice(0, 160)
          : "Embedded resource";
      return `<iframe class="resource-embed" title="${escapeHtml(title)}" sandbox="" referrerpolicy="no-referrer" loading="lazy" src="${escapeHtml(src)}"></iframe>`;
    }
    default:
      throw new ResourceContentError(
        `Resource node type ${node.type} is not allowed.`,
      );
  }
}

export function renderResourceDocument(
  document: TiptapNode,
  allowedEmbedOrigins: readonly string[],
) {
  return renderNode(document, allowedEmbedOrigins);
}

export function appendEmbeds(
  document: TiptapNode,
  embedUrls: string[],
  allowedEmbedOrigins: readonly string[],
) {
  const embeds = embedUrls.filter(Boolean).map(
    (src) =>
      ({
        type: "embed",
        attrs: {
          src: allowedResourceEmbedUrl(src, allowedEmbedOrigins),
          title: "Embedded reference",
        },
      }) satisfies TiptapNode,
  );
  return parseResourceDocument({
    ...document,
    content: [
      ...(document.content ?? []).filter((node) => node.type !== "embed"),
      ...embeds,
    ],
  });
}
