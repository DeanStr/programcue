import type { ReactNode } from "react";
import {
  parseRestrictedMarkdown,
  type RestrictedMarkdownInline,
  restrictedMarkdownModelPlainText,
} from "~/modules/public-site/restricted-markdown";

function inlineMarkdown(nodes: RestrictedMarkdownInline[]): ReactNode[] {
  const occurrences = new Map<string, number>();
  const rendered: ReactNode[] = [];
  const content = (node: RestrictedMarkdownInline, key: string) =>
    node.bold ? <strong key={`${key}:strong`}>{node.text}</strong> : node.text;
  for (let index = 0; index < nodes.length; ) {
    const node = nodes[index];
    if (!node) break;
    if (!node.href) {
      const identity = `${node.text}:${node.bold ?? false}`;
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      rendered.push(content(node, `${identity}:${occurrence}`));
      index += 1;
      continue;
    }
    const linkNodes = [node];
    let nextIndex = index + 1;
    while (nodes[nextIndex]?.href === node.href) {
      linkNodes.push(nodes[nextIndex] as RestrictedMarkdownInline);
      nextIndex += 1;
    }
    const identity = `${linkNodes
      .map((segment) => `${segment.text}:${segment.bold ?? false}`)
      .join("")}:${node.href}`;
    const occurrence = occurrences.get(identity) ?? 0;
    occurrences.set(identity, occurrence + 1);
    const key = `${identity}:${occurrence}`;
    rendered.push(
      <a key={`${key}:link`} href={node.href} rel="noreferrer">
        {linkNodes.map((segment, segmentIndex) =>
          content(segment, `${key}:${segmentIndex}`),
        )}
      </a>,
    );
    index = nextIndex;
  }
  return rendered;
}

/** Plain text for metadata derived from the same deliberately small subset. */
export function restrictedMarkdownPlainText(value: string) {
  return restrictedMarkdownModelPlainText(value);
}

/**
 * A deliberately small Markdown subset: headings, lists, paragraphs, bold and
 * HTTPS links.
 *
 * `headingLevel` is the level `## ` renders at. It defaults to 3 because most
 * of this content sits under a section heading on the event homepage. A fixed
 * page has no section heading between its `h1` and its body, so it passes 2
 * and the page reads h1 → h2 rather than skipping a level.
 */
export function RestrictedMarkdown({
  children,
  headingLevel = 3,
}: {
  children: string;
  headingLevel?: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  const blocks: ReactNode[] = [];
  for (const block of parseRestrictedMarkdown(children)) {
    if (block.type === "heading") {
      blocks.push(
        <Heading key={`h:${blocks.length}`}>
          {inlineMarkdown(block.content)}
        </Heading>,
      );
      continue;
    }
    if (block.type === "bulletList") {
      const occurrences = new Map<string, number>();
      blocks.push(
        <ul key={`ul:${blocks.length}`}>
          {block.items.map((item) => {
            const text = item.map((node) => node.text).join("");
            const occurrence = occurrences.get(text) ?? 0;
            occurrences.set(text, occurrence + 1);
            return (
              <li key={`${text}:${occurrence}`}>{inlineMarkdown(item)}</li>
            );
          })}
        </ul>,
      );
      continue;
    }
    blocks.push(
      <p key={`p:${blocks.length}`}>{inlineMarkdown(block.content)}</p>,
    );
  }
  return <div className="public-site-markdown">{blocks}</div>;
}
