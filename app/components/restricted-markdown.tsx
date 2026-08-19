import type { ReactNode } from "react";

function safeHttpsLink(value: string) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.hostname &&
      !url.username &&
      !url.password
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function inlineMarkdown(value: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const expression = /\[([^\]]+)\]\((https:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*/gu;
  let cursor = 0;
  for (const match of value.matchAll(expression)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(value.slice(cursor, index));
    if (match[1] && match[2]) {
      const href = safeHttpsLink(match[2]);
      nodes.push(
        href ? (
          <a key={`${index}:${href}`} href={href} rel="noreferrer">
            {match[1]}
          </a>
        ) : (
          match[1]
        ),
      );
    } else if (match[3]) {
      nodes.push(<strong key={`${index}:strong`}>{match[3]}</strong>);
    }
    cursor = index + match[0].length;
  }
  if (cursor < value.length) nodes.push(value.slice(cursor));
  return nodes;
}

/** Plain text for metadata derived from the same deliberately small subset. */
export function restrictedMarkdownPlainText(value: string) {
  return value
    .replace(/\[([^\]]+)\]\(https:\/\/[^\s)]+\)/gu, "$1")
    .replace(/\*\*([^*]+)\*\*/gu, "$1")
    .replace(/^\s*(?:## |- )/gmu, "")
    .replace(/\s+/gu, " ")
    .trim();
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
  const lines = children.replace(/\r\n?/gu, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const text = paragraph.join(" ").trim();
    if (text)
      blocks.push(<p key={`p:${blocks.length}`}>{inlineMarkdown(text)}</p>);
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    const occurrences = new Map<string, number>();
    blocks.push(
      <ul key={`ul:${blocks.length}`}>
        {list.map((item) => {
          const occurrence = occurrences.get(item) ?? 0;
          occurrences.set(item, occurrence + 1);
          return <li key={`${item}:${occurrence}`}>{inlineMarkdown(item)}</li>;
        })}
      </ul>,
    );
    list = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      flushParagraph();
      flushList();
    } else if (line.startsWith("## ")) {
      flushParagraph();
      flushList();
      blocks.push(
        <Heading key={`h:${blocks.length}`}>
          {inlineMarkdown(line.slice(3))}
        </Heading>,
      );
    } else if (line.startsWith("- ")) {
      flushParagraph();
      list.push(line.slice(2));
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return <div className="public-site-markdown">{blocks}</div>;
}
