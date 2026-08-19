import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  type KeyboardEvent,
  type MouseEvent,
  useEffect,
  useId,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import {
  escapeRestrictedMarkdownText,
  parseRestrictedMarkdown,
  type RestrictedMarkdownInline,
  safeRestrictedMarkdownLink,
} from "~/modules/public-site/restricted-markdown";

type TiptapMark = { type: "bold" | "link"; attrs?: { href?: string } };
type TiptapNode = {
  type: string;
  attrs?: { level?: number };
  content?: TiptapNode[];
  marks?: TiptapMark[];
  text?: string;
};

function inlineDocument(content: RestrictedMarkdownInline[]) {
  return content.map(
    (node): TiptapNode => ({
      type: "text",
      text: node.text,
      ...((node.bold || node.href) && {
        marks: [
          ...(node.bold ? ([{ type: "bold" }] satisfies TiptapMark[]) : []),
          ...(node.href
            ? ([
                { type: "link", attrs: { href: node.href } },
              ] satisfies TiptapMark[])
            : []),
        ],
      }),
    }),
  );
}

export function restrictedMarkdownEditorDocument(value: string): TiptapNode {
  const content: TiptapNode[] = parseRestrictedMarkdown(value).map((block) => {
    if (block.type === "heading")
      return {
        type: "heading",
        attrs: { level: 2 },
        content: inlineDocument(block.content),
      };
    if (block.type === "bulletList")
      return {
        type: "bulletList",
        content: block.items.map((item) => ({
          type: "listItem",
          content: [{ type: "paragraph", content: inlineDocument(item) }],
        })),
      };
    return { type: "paragraph", content: inlineDocument(block.content) };
  });
  return {
    type: "doc",
    content: content.length ? content : [{ type: "paragraph" }],
  };
}

function serializeInline(node: TiptapNode) {
  const segments = (node.content ?? []).map((child) => {
    const text = escapeRestrictedMarkdownText(
      (child.text ?? "").replace(/\s*\n\s*/gu, " "),
    );
    const bold = child.marks?.some((mark) => mark.type === "bold");
    const rawHref = child.marks?.find((mark) => mark.type === "link")?.attrs
      ?.href;
    return {
      href: rawHref ? safeRestrictedMarkdownLink(rawHref) : null,
      label: bold && text ? `**${text}**` : text,
    };
  });
  const markdown: string[] = [];
  for (let index = 0; index < segments.length; ) {
    const segment = segments[index];
    if (!segment?.href) {
      markdown.push(segment?.label ?? "");
      index += 1;
      continue;
    }
    const labels = [segment.label];
    let nextIndex = index + 1;
    while (segments[nextIndex]?.href === segment.href) {
      labels.push(segments[nextIndex]?.label ?? "");
      nextIndex += 1;
    }
    const label = labels.join("");
    const destination = /[()]/u.test(segment.href)
      ? `<${segment.href}>`
      : segment.href;
    markdown.push(label ? `[${label}](${destination})` : "");
    index = nextIndex;
  }
  return markdown.join("");
}

function bulletListMarkdown(node: TiptapNode): string[] {
  return (node.content ?? []).flatMap((item) =>
    (item.content ?? []).flatMap((child) => {
      if (child.type === "bulletList") return bulletListMarkdown(child);
      if (child.type !== "paragraph") return [];
      const content = serializeInline(child);
      return content ? [`- ${content}`] : [];
    }),
  );
}

function paragraphMarkdown(node: TiptapNode) {
  const markdown = serializeInline(node);
  return /^(?:## |- )/u.test(markdown) ? `\\${markdown}` : markdown;
}

function isFlatRestrictedDocument(document: TiptapNode) {
  const inlineContentIsSupported = (node: TiptapNode) =>
    (node.content ?? []).every((child) => child.type === "text");
  return (document.content ?? []).every((node) => {
    if (node.type === "paragraph" || node.type === "heading")
      return inlineContentIsSupported(node);
    if (node.type !== "bulletList") return false;
    return (node.content ?? []).every(
      (item) =>
        item.type === "listItem" &&
        item.content?.length === 1 &&
        item.content[0]?.type === "paragraph" &&
        inlineContentIsSupported(item.content[0]),
    );
  });
}

export function restrictedMarkdownFromEditorDocument(document: TiptapNode) {
  return (document.content ?? [])
    .map((node) => {
      if (node.type === "heading") return `## ${serializeInline(node)}`;
      if (node.type === "bulletList")
        return bulletListMarkdown(node).join("\n");
      return paragraphMarkdown(node);
    })
    .join("\n\n")
    .trim();
}

export function RestrictedMarkdownEditor({
  label,
  value,
  maximumLength,
  onChange,
}: {
  label: string;
  value: string;
  maximumLength: number;
  onChange(value: string): void;
}) {
  const initialDocument = useMemo(
    () => restrictedMarkdownEditorDocument(value),
    [value],
  );
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const pendingLocalValuesRef = useRef<string[]>([]);
  const linkSelectionRef = useRef<{ from: number; to: number } | null>(null);
  const linkInputRef = useRef<HTMLInputElement>(null);
  const editingExistingLinkRef = useRef(false);
  const [, refreshToolbar] = useReducer((revision: number) => revision + 1, 0);
  const [linkEditorOpen, setLinkEditorOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");
  const [linkError, setLinkError] = useState<string | null>(null);
  const descriptionId = useId();
  const linkInputId = useId();
  const linkErrorId = useId();
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        blockquote: false,
        code: false,
        codeBlock: false,
        hardBreak: false,
        heading: { levels: [2] },
        horizontalRule: false,
        italic: false,
        link: {
          autolink: false,
          enableClickSelection: true,
          isAllowedUri: (url) => safeRestrictedMarkdownLink(url) !== null,
          linkOnPaste: false,
          markdownLinks: true,
          openOnClick: false,
        },
        orderedList: false,
        strike: false,
        trailingNode: false,
        underline: false,
      }),
    ],
    content: initialDocument,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        "aria-describedby": descriptionId,
        "aria-label": label,
        "aria-multiline": "true",
        role: "textbox",
      },
    },
    onSelectionUpdate: () => refreshToolbar(),
    onUpdate: ({ editor: current }) => {
      const document = current.getJSON() as TiptapNode;
      const markdown = restrictedMarkdownFromEditorDocument(document);
      if (!isFlatRestrictedDocument(document))
        current.commands.setContent(
          restrictedMarkdownEditorDocument(markdown),
          {
            emitUpdate: false,
          },
        );
      const pendingValues = pendingLocalValuesRef.current;
      if (pendingValues.at(-1) !== markdown) pendingValues.push(markdown);
      onChangeRef.current(markdown);
      refreshToolbar();
    },
  });

  useEffect(() => {
    if (!editor) return;
    const nextMarkdown = restrictedMarkdownFromEditorDocument(initialDocument);
    const pendingValues = pendingLocalValuesRef.current;
    const acknowledgedIndex = pendingValues.indexOf(nextMarkdown);
    if (acknowledgedIndex >= 0) {
      pendingValues.splice(0, acknowledgedIndex + 1);
      return;
    }
    pendingValues.length = 0;
    if (
      restrictedMarkdownFromEditorDocument(editor.getJSON() as TiptapNode) !==
      nextMarkdown
    ) {
      editor.commands.setContent(initialDocument, { emitUpdate: false });
      refreshToolbar();
    }
  }, [editor, initialDocument]);

  useEffect(() => {
    if (!linkEditorOpen) return;
    linkInputRef.current?.focus();
    linkInputRef.current?.select();
  }, [linkEditorOpen]);

  if (!editor)
    return <div className="public-site-rich-text-loading">Loading editor…</div>;

  const tooLong = value.length > maximumLength;
  const preserveEditorSelection = (event: MouseEvent<HTMLButtonElement>) =>
    event.preventDefault();
  const runEditorCommand = (command: () => boolean) => {
    command();
    editor.view.focus();
  };
  const beginLinkEdit = () => {
    if (linkEditorOpen) {
      setLinkEditorOpen(false);
      setLinkError(null);
      linkSelectionRef.current = null;
      editingExistingLinkRef.current = false;
      editor.view.focus();
      return;
    }
    const href = String(editor.getAttributes("link").href ?? "");
    if (!href && editor.state.selection.empty) {
      setLinkError("Select text before adding a link.");
      setLinkEditorOpen(true);
      return;
    }
    linkSelectionRef.current = {
      from: editor.state.selection.from,
      to: editor.state.selection.to,
    };
    editingExistingLinkRef.current = Boolean(href);
    setLinkUrl(href);
    setLinkError(null);
    setLinkEditorOpen(true);
  };
  const applyLink = () => {
    const selection = linkSelectionRef.current;
    if (
      !selection ||
      (selection.from === selection.to && !editingExistingLinkRef.current)
    ) {
      setLinkError("Select text before adding a link.");
      return;
    }
    const href = safeRestrictedMarkdownLink(linkUrl.trim());
    if (!href) {
      setLinkError("Enter a credential-free HTTPS link.");
      return;
    }
    editor
      .chain()
      .setTextSelection(selection)
      .extendMarkRange("link")
      .setLink({ href })
      .run();
    editor.view.focus();
    setLinkEditorOpen(false);
    setLinkError(null);
    linkSelectionRef.current = null;
    editingExistingLinkRef.current = false;
  };
  const handleLinkKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyLink();
    }
    if (event.key === "Escape") {
      event.preventDefault();
      setLinkEditorOpen(false);
      linkSelectionRef.current = null;
      editingExistingLinkRef.current = false;
      editor.view.focus();
    }
  };

  return (
    <div className="public-site-rich-text-field">
      <span className="public-site-rich-text-label">{label}</span>
      <div
        className="public-site-rich-text-editor"
        data-invalid={tooLong || undefined}
      >
        <div
          className="public-site-rich-text-toolbar"
          role="toolbar"
          aria-label={`${label} formatting`}
        >
          <button
            type="button"
            aria-label="Bold"
            aria-pressed={editor.isActive("bold")}
            onMouseDown={preserveEditorSelection}
            onClick={() => runEditorCommand(() => editor.commands.toggleBold())}
          >
            <strong>B</strong>
          </button>
          <button
            type="button"
            aria-label="Subheading"
            aria-pressed={editor.isActive("heading", { level: 2 })}
            onMouseDown={preserveEditorSelection}
            onClick={() =>
              runEditorCommand(() =>
                editor.commands.toggleHeading({ level: 2 }),
              )
            }
          >
            H2
          </button>
          <button
            type="button"
            aria-label="Bulleted list"
            aria-pressed={editor.isActive("bulletList")}
            onMouseDown={preserveEditorSelection}
            onClick={() =>
              runEditorCommand(() => editor.commands.toggleBulletList())
            }
          >
            • List
          </button>
          <button
            type="button"
            aria-label="Link"
            aria-expanded={linkEditorOpen}
            aria-pressed={editor.isActive("link")}
            onMouseDown={preserveEditorSelection}
            onClick={beginLinkEdit}
          >
            Link
          </button>
          <span className="public-site-rich-text-toolbar-spacer" />
          <button
            type="button"
            disabled={!editor.can().undo()}
            onMouseDown={preserveEditorSelection}
            onClick={() => runEditorCommand(() => editor.commands.undo())}
          >
            Undo
          </button>
          <button
            type="button"
            disabled={!editor.can().redo()}
            onMouseDown={preserveEditorSelection}
            onClick={() => runEditorCommand(() => editor.commands.redo())}
          >
            Redo
          </button>
        </div>
        {linkEditorOpen ? (
          <fieldset className="public-site-rich-text-link-editor">
            <legend className="sr-only">Link settings</legend>
            <label htmlFor={linkInputId}>HTTPS link</label>
            <input
              ref={linkInputRef}
              id={linkInputId}
              className="field"
              type="text"
              inputMode="url"
              value={linkUrl}
              aria-describedby={linkError ? linkErrorId : undefined}
              aria-invalid={Boolean(linkError)}
              onChange={(event) => {
                setLinkUrl(event.target.value);
                setLinkError(null);
              }}
              onKeyDown={handleLinkKeyDown}
              placeholder="https://example.com"
            />
            <button type="button" className="btn small" onClick={applyLink}>
              Apply link
            </button>
            {editor.isActive("link") ? (
              <button
                type="button"
                className="btn small"
                onClick={() => {
                  const selection = linkSelectionRef.current;
                  if (!selection) return;
                  editor
                    .chain()
                    .setTextSelection(selection)
                    .extendMarkRange("link")
                    .unsetLink()
                    .run();
                  editor.view.focus();
                  setLinkEditorOpen(false);
                  linkSelectionRef.current = null;
                  editingExistingLinkRef.current = false;
                }}
              >
                Remove link
              </button>
            ) : null}
            {linkError ? (
              <span className="pc-field-error" id={linkErrorId} role="alert">
                {linkError}
              </span>
            ) : null}
          </fieldset>
        ) : null}
        <EditorContent editor={editor} />
      </div>
      <span className={tooLong ? "pc-field-error" : "help"} id={descriptionId}>
        {value.length.toLocaleString()} of {maximumLength.toLocaleString()}{" "}
        characters
        {tooLong ? " — shorten this content before saving." : ""}
      </span>
      <span className="sr-only" aria-atomic="true" aria-live="polite">
        {tooLong
          ? "Character limit exceeded. Shorten this content before saving."
          : ""}
      </span>
    </div>
  );
}
