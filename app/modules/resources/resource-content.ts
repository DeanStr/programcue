import { z } from "zod";

import {
  assertExternalEmbedEnabled,
  externalEmbedPresentation,
  parseExternalEmbed,
  type ExternalEmbed,
  type ResourceEmbedConfiguration,
} from "./resource-embed-policy";

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
  configuration: ResourceEmbedConfiguration,
) {
  return (node.content ?? [])
    .map((child) => renderNode(child, configuration))
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
  configuration: ResourceEmbedConfiguration,
): string {
  switch (node.type) {
    case "doc":
      return renderChildren(node, configuration);
    case "text":
      return renderText(node);
    case "paragraph":
      return `<p>${renderChildren(node, configuration)}</p>`;
    case "heading": {
      const level = Math.min(4, Math.max(2, Number(node.attrs?.level) || 2));
      return `<h${level}>${renderChildren(node, configuration)}</h${level}>`;
    }
    case "bulletList":
      return `<ul>${renderChildren(node, configuration)}</ul>`;
    case "orderedList":
      return `<ol>${renderChildren(node, configuration)}</ol>`;
    case "listItem":
      return `<li>${renderChildren(node, configuration)}</li>`;
    case "blockquote":
      return `<blockquote>${renderChildren(node, configuration)}</blockquote>`;
    case "codeBlock":
      return `<pre><code>${renderChildren(node, configuration)}</code></pre>`;
    case "horizontalRule":
      return "<hr>";
    case "hardBreak":
      return "<br>";
    case "embed": {
      const embed = parseExternalEmbed(node.attrs);
      assertExternalEmbedEnabled(embed, configuration);
      const presentation = externalEmbedPresentation(embed, configuration);
      return `<section class="resource-external-embed resource-external-embed--inert"><p><strong>${escapeHtml(presentation.contentLabel)}</strong></p><p>External content loads only after the speaker chooses to open it.</p><a href="${escapeHtml(presentation.sourceUrl)}" rel="noreferrer noopener">${escapeHtml(presentation.sourceLabel)}</a></section>`;
    }
    default:
      throw new ResourceContentError(
        `Resource node type ${node.type} is not allowed.`,
      );
  }
}

export function renderResourceDocument(
  document: TiptapNode,
  configuration: ResourceEmbedConfiguration,
) {
  validateResourceDocumentEmbeds(document, configuration);
  return renderNode(document, configuration);
}

export function resourceDocumentEmbeds(document: TiptapNode) {
  return (document.content ?? [])
    .filter((node) => node.type === "embed")
    .map((node) => parseExternalEmbed(node.attrs));
}

export function replaceResourceDocumentEmbeds(
  document: TiptapNode,
  embeds: readonly ExternalEmbed[],
) {
  if (embeds.length > 8) {
    throw new ResourceContentError(
      "A resource can contain at most eight external video or map blocks.",
    );
  }
  return parseResourceDocument({
    ...document,
    content: [
      ...(document.content ?? []).filter((node) => node.type !== "embed"),
      ...embeds.map(
        (embed) =>
          ({
            type: "embed",
            attrs: parseExternalEmbed(embed),
          }) satisfies TiptapNode,
      ),
    ],
  });
}

export function validateResourceDocumentEmbeds(
  document: TiptapNode,
  configuration: ResourceEmbedConfiguration,
) {
  validateResourceDocumentEmbedStructure(document);
  for (const embed of resourceDocumentEmbeds(document))
    assertExternalEmbedEnabled(embed, configuration);
}

export function validateResourceDocumentEmbedStructure(document: TiptapNode) {
  let count = 0;
  const visit = (node: TiptapNode, depth: number) => {
    if (node.type === "embed") {
      if (depth !== 1 || node.content?.length) {
        throw new ResourceContentError(
          "External video and map blocks must be top-level resource blocks.",
        );
      }
      count += 1;
      if (count > 8) {
        throw new ResourceContentError(
          "A resource can contain at most eight external video or map blocks.",
        );
      }
      parseExternalEmbed(node.attrs);
    }
    for (const child of node.content ?? []) visit(child, depth + 1);
  };
  visit(document, 0);
}
