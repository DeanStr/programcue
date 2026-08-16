import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import { useEffect, useMemo, useRef } from "react";
import type { TiptapNode } from "~/modules/resources/resource-content";

function editorDocument(document: TiptapNode) {
  return {
    ...document,
    content: (document.content ?? []).filter((node) => node.type !== "embed"),
  };
}

export function RichResourceEditor({
  document,
  onChange,
}: {
  document: TiptapNode;
  onChange: (value: TiptapNode) => void;
}) {
  const initial = useMemo(() => editorDocument(document), [document]);
  const documentRef = useRef(document);
  documentRef.current = document;
  const editor = useEditor({
    extensions: [StarterKit],
    content: initial,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        role: "textbox",
        "aria-label": "Page content",
        "aria-multiline": "true",
      },
    },
    onUpdate: ({ editor: current }) => {
      const nextDocument = current.getJSON() as TiptapNode;
      onChange({
        ...nextDocument,
        content: [
          ...(nextDocument.content ?? []),
          ...(documentRef.current.content ?? []).filter(
            (node) => node.type === "embed",
          ),
        ],
      });
    },
  });
  useEffect(() => {
    if (editor && JSON.stringify(editor.getJSON()) !== JSON.stringify(initial))
      editor.commands.setContent(initial);
  }, [editor, initial]);
  if (!editor)
    return <div className="resource-editor-loading">Loading editor…</div>;
  return (
    <div className="resource-editor">
      <div
        className="resource-editor-toolbar"
        role="toolbar"
        aria-label="Resource formatting"
      >
        <fieldset
          className="resource-editor-toolbar-group pc-plain-fieldset"
          aria-label="Text styles"
        >
          <button
            type="button"
            className={editor.isActive("bold") ? "active" : ""}
            aria-label="Bold"
            aria-pressed={editor.isActive("bold")}
            onClick={() => editor.chain().focus().toggleBold().run()}
          >
            <strong>B</strong>
          </button>{" "}
          <button
            type="button"
            className={editor.isActive("italic") ? "active" : ""}
            aria-label="Italic"
            aria-pressed={editor.isActive("italic")}
            onClick={() => editor.chain().focus().toggleItalic().run()}
          >
            <em>I</em>
          </button>{" "}
          <button
            type="button"
            className={editor.isActive("heading", { level: 2 }) ? "active" : ""}
            aria-label="Heading level 2"
            aria-pressed={editor.isActive("heading", { level: 2 })}
            onClick={() =>
              editor.chain().focus().toggleHeading({ level: 2 }).run()
            }
          >
            H2
          </button>
        </fieldset>
        <fieldset
          className="resource-editor-toolbar-group pc-plain-fieldset"
          aria-label="Block styles"
        >
          <button
            type="button"
            className={editor.isActive("bulletList") ? "active" : ""}
            aria-label="Bulleted list"
            aria-pressed={editor.isActive("bulletList")}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
          >
            • List
          </button>{" "}
          <button
            type="button"
            className={editor.isActive("blockquote") ? "active" : ""}
            aria-label="Block quote"
            aria-pressed={editor.isActive("blockquote")}
            onClick={() => editor.chain().focus().toggleBlockquote().run()}
          >
            Quote
          </button>
        </fieldset>
        <fieldset
          className="resource-editor-toolbar-group pc-plain-fieldset"
          aria-label="Edit history"
        >
          <button
            type="button"
            onClick={() => editor.chain().focus().undo().run()}
            disabled={!editor.can().undo()}
          >
            Undo
          </button>{" "}
          <button
            type="button"
            onClick={() => editor.chain().focus().redo().run()}
            disabled={!editor.can().redo()}
          >
            Redo
          </button>
        </fieldset>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}
