export type RestrictedMarkdownInline = {
  text: string;
  bold?: boolean;
  href?: string;
};

export type RestrictedMarkdownBlock =
  | { type: "paragraph" | "heading"; content: RestrictedMarkdownInline[] }
  | { type: "bulletList"; items: RestrictedMarkdownInline[][] };

const escapedMarkdownCharacter = /\\([\\[\]*#-])/gu;
const boldMarkdown = /\*\*((?:\\[\\[\]*#-]|[^*])+)\*\*/gu;
export const restrictedMarkdownLink =
  /\[((?:\\[\\[\]*#-]|[^\]])+)\]\((<[^>\r\n]*>|[^)\r\n]*)\)/gu;

export function escapeRestrictedMarkdownText(value: string) {
  return value.replace(/[\\[\]*]/gu, "\\$&");
}

function unescapeRestrictedMarkdownText(value: string) {
  return value.replace(escapedMarkdownCharacter, "$1");
}

export function safeRestrictedMarkdownLink(value: string) {
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

function appendInline(
  nodes: RestrictedMarkdownInline[],
  node: RestrictedMarkdownInline,
) {
  if (!node.text) return;
  const previous = nodes.at(-1);
  if (previous && previous.bold === node.bold && previous.href === node.href) {
    previous.text += node.text;
    return;
  }
  nodes.push(node);
}

function boldLinkLabel(value: string, href?: string) {
  const nodes: RestrictedMarkdownInline[] = [];
  let cursor = 0;
  for (const match of value.matchAll(boldMarkdown)) {
    const index = match.index ?? 0;
    appendInline(nodes, {
      text: unescapeRestrictedMarkdownText(value.slice(cursor, index)),
      href,
    });
    appendInline(nodes, {
      text: unescapeRestrictedMarkdownText(match[1] ?? ""),
      bold: true,
      href,
    });
    cursor = index + match[0].length;
  }
  appendInline(nodes, {
    text: unescapeRestrictedMarkdownText(value.slice(cursor)),
    href,
  });
  return nodes;
}

export function parseRestrictedMarkdownInline(value: string) {
  const nodes: RestrictedMarkdownInline[] = [];
  const expression =
    /\[((?:\\[\\[\]*#-]|[^\]])+)\]\((<[^>\r\n]*>|[^)\r\n]*)\)|\*\*((?:\\[\\[\]*#-]|[^*])+)\*\*/gu;
  let cursor = 0;
  for (const match of value.matchAll(expression)) {
    const index = match.index ?? 0;
    appendInline(nodes, {
      text: unescapeRestrictedMarkdownText(value.slice(cursor, index)),
    });
    if (match[1] && match[2]) {
      const rawTarget = match[2];
      const target =
        rawTarget.startsWith("<") && rawTarget.endsWith(">")
          ? rawTarget.slice(1, -1)
          : rawTarget;
      const href =
        target === target.trim() ? safeRestrictedMarkdownLink(target) : null;
      for (const node of boldLinkLabel(match[1], href ?? undefined))
        appendInline(nodes, node);
    } else {
      appendInline(nodes, {
        text: unescapeRestrictedMarkdownText(match[3] ?? ""),
        bold: true,
      });
    }
    cursor = index + match[0].length;
  }
  appendInline(nodes, {
    text: unescapeRestrictedMarkdownText(value.slice(cursor)),
  });
  return nodes;
}

export function parseRestrictedMarkdown(value: string) {
  const blocks: RestrictedMarkdownBlock[] = [];
  const lines = value.replace(/\r\n?/gu, "\n").split("\n");
  let paragraph: string[] = [];
  let list: RestrictedMarkdownInline[][] = [];

  const flushParagraph = () => {
    if (!paragraph.length) return;
    const text = paragraph.join(" ").trim();
    if (text)
      blocks.push({
        type: "paragraph",
        content: parseRestrictedMarkdownInline(text),
      });
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    blocks.push({ type: "bulletList", items: list });
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
      blocks.push({
        type: "heading",
        content: parseRestrictedMarkdownInline(line.slice(3)),
      });
    } else if (line.startsWith("- ")) {
      flushParagraph();
      list.push(parseRestrictedMarkdownInline(line.slice(2)));
    } else {
      flushList();
      paragraph.push(line);
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}

export function restrictedMarkdownModelPlainText(value: string) {
  return parseRestrictedMarkdown(value)
    .flatMap((block) =>
      block.type === "bulletList" ? block.items : [block.content],
    )
    .map((content) => content.map((node) => node.text).join(""))
    .join(" ")
    .replace(/\s+/gu, " ")
    .trim();
}
