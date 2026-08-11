import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  AlertTriangle,
  BookOpenCheck,
  CheckCircle2,
  ExternalLink,
  Globe2,
  Plus,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useNavigation,
} from "react-router";
import { ZodError } from "zod";

import type { Route } from "./+types/admin-resources";
import {
  DirectMultipartUpload,
  DirectUploadCompletionConflictError,
} from "~/components/direct-multipart-upload";
import { Dialog } from "~/components/dialog";
import {
  DraftRecoveryFeedback,
  DraftRecoveryStatus,
} from "~/components/draft-recovery-feedback";
import {
  appendEmbeds,
  renderResourceDocument,
  ResourceContentError,
  type TiptapNode,
} from "~/modules/resources/resource-content";
import {
  ResourceAudienceError,
  ResourceRevisionConflictError,
  ResourceService,
  ResourceSlugConflictError,
  ResourceTaskDependencyError,
} from "~/modules/resources/resource-service.server";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  clearDraftRecoveryScope,
  useDraftRecovery,
} from "~/platform/drafts/draft-recovery";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";
import { maximumMegabytes } from "~/modules/files/file-policy";

export const meta = () => [{ title: "Speaker Resources · Program Cue" }];

type ResourceAttachmentCompletion = {
  ok?: boolean;
  committed?: boolean;
  error?: string;
  message?: string;
};

export async function readResourceAttachmentCompletion(response: Response) {
  const result = (await response.json()) as ResourceAttachmentCompletion;
  if (response.status === 409)
    throw new DirectUploadCompletionConflictError(
      result.error ??
        "The resource draft changed during upload. Reload the latest draft before choosing the file again.",
    );
  if (response.status === 207 && result.committed === true) {
    return {
      message:
        result.message ??
        "The attachment was saved, but live updates need attention. Reload other open views before continuing.",
    };
  }
  if (!response.ok || result.ok !== true)
    throw new Error(
      result.error ??
        result.message ??
        `Attachment request failed (${response.status}).`,
    );
  return { message: result.message };
}

const emptyDocument: TiptapNode = {
  type: "doc",
  content: [{ type: "paragraph" }],
};

class InvalidResourcePayloadError extends Error {}

async function administrator(
  request: Request,
  context: Route.LoaderArgs["context"],
) {
  const { env } = getCloudflareContext(context);
  await ensureDemoSpeakerData(env);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  return { env, viewer };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, viewer } = await administrator(request, context);
  const url = new URL(request.url);
  const workspace = await new ResourceService(env).getAdminWorkspace(
    viewer,
    url.searchParams.get("resource"),
  );
  return {
    ...workspace,
    recoveryScope: { eventId: viewer.eventId, personId: viewer.personId },
    createdFromLocalDraft: url.searchParams.get("created") === "1",
    liveUpdateDelayed: url.searchParams.get("liveUpdateDelayed") === "1",
  };
}

function actionError(error: unknown) {
  if (error instanceof ZodError)
    return error.issues[0]?.message ?? "Review the resource fields.";
  if (
    error instanceof ResourceContentError ||
    error instanceof ResourceAudienceError ||
    error instanceof ResourceRevisionConflictError ||
    error instanceof ResourceSlugConflictError ||
    error instanceof ResourceTaskDependencyError ||
    error instanceof InvalidResourcePayloadError
  )
    return error.message;
  return null;
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env, viewer } = await administrator(request, context);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent !== "save" && intent !== "publish") {
    return data(
      { ok: false, message: "Unsupported resource action." },
      { status: 400 },
    );
  }
  const service = new ResourceService(env);
  try {
    if (intent === "publish") {
      const pageId = String(form.get("id") ?? "");
      await service.publish(viewer, pageId, Number(form.get("revision")));
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "resource_page",
        entityId: pageId,
        changeType: "published",
      });
      if (realtimeFailure)
        return data({ ...realtimeFailure, intent }, { status: 207 });
      return data({
        ok: true,
        intent,
        message:
          "Resource version published and acknowledgement tasks synchronised.",
      });
    }
    let rawDocument: unknown;
    try {
      rawDocument = JSON.parse(String(form.get("documentJson") ?? ""));
    } catch {
      throw new InvalidResourcePayloadError(
        "Resource content is invalid. Refresh before trying again.",
      );
    }
    const existingId = String(form.get("id") ?? "");
    const id = await service.save(viewer, {
      id: existingId || undefined,
      revision: String(form.get("revision") ?? "") || undefined,
      title: form.get("title"),
      slug: form.get("slug"),
      category: form.get("category"),
      audienceScope: form.get("audienceScope"),
      audiencePersonIds: form.getAll("audiencePersonIds"),
      acknowledgementRequired: form.get("acknowledgementRequired")
        ? "true"
        : "false",
      document: rawDocument,
      embedUrls: String(form.get("embedUrls") ?? "")
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean),
    });
    const realtimeFailure = await recordRouteChange(env, viewer, {
      entityType: "resource_page",
      entityId: id,
      changeType: existingId ? "updated" : "created",
    });
    if (realtimeFailure) {
      if (!existingId)
        return redirect(
          `/admin/resources?resource=${encodeURIComponent(id)}&created=1&liveUpdateDelayed=1`,
        );
      return data({ ...realtimeFailure, intent }, { status: 207 });
    }
    if (!existingId)
      return redirect(`/admin/resources?resource=${id}&created=1`);
    return data({
      ok: true,
      intent,
      message: "A new immutable draft version was saved.",
    });
  } catch (error) {
    const message = actionError(error);
    if (message) {
      return data(
        {
          ok: false,
          intent,
          message,
          conflict: error instanceof ResourceRevisionConflictError,
        },
        {
          status:
            error instanceof ResourceRevisionConflictError ||
            error instanceof ResourceSlugConflictError ||
            error instanceof ResourceTaskDependencyError
              ? 409
              : 422,
        },
      );
    }
    if (error instanceof Response) throw error;
    throw error;
  }
}

function editorDocument(document: TiptapNode) {
  return {
    ...document,
    content: (document.content ?? []).filter((node) => node.type !== "embed"),
  };
}

function embeddedUrls(document: TiptapNode) {
  return (document.content ?? [])
    .filter((node) => node.type === "embed")
    .map((node) => String(node.attrs?.src ?? ""))
    .filter(Boolean)
    .join("\n");
}

function RichResourceEditor({
  document,
  onChange,
}: {
  document: TiptapNode;
  onChange: (value: TiptapNode) => void;
}) {
  const initial = useMemo(() => editorDocument(document), [document]);
  const editor = useEditor({
    extensions: [StarterKit],
    content: initial,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        "aria-label": "Page content",
        "aria-multiline": "true",
      },
    },
    onUpdate: ({ editor: current }) =>
      onChange(current.getJSON() as TiptapNode),
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
        <span
          className="resource-editor-toolbar-group"
          role="group"
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
        </span>
        <span
          className="resource-editor-toolbar-group"
          role="group"
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
        </span>
        <span
          className="resource-editor-toolbar-group"
          role="group"
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
        </span>
      </div>
      <EditorContent editor={editor} />
    </div>
  );
}

function statusClass(status: string) {
  return status === "published"
    ? "success"
    : status === "archived"
      ? "danger"
      : "warning";
}

export default function AdminResources({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const pendingIntent = navigation.formData?.get("intent");
  const selected = loaderData.selected;
  const [document, setDocument] = useState<TiptapNode>(
    selected?.document ?? emptyDocument,
  );
  const [creating, setCreating] = useState(!selected);
  const [audienceScope, setAudienceScope] = useState(
    selected?.audienceScope ?? "all_speakers",
  );
  const [title, setTitle] = useState(selected?.title ?? "");
  const [slug, setSlug] = useState(selected?.slug ?? "");
  const [category, setCategory] = useState(selected?.category ?? "");
  const [embedUrls, setEmbedUrls] = useState(
    selected ? embeddedUrls(selected.document) : "",
  );
  const [audiencePersonIds, setAudiencePersonIds] = useState<string[]>(
    selected?.audiencePersonIds ?? [],
  );
  const [acknowledgementRequired, setAcknowledgementRequired] = useState(
    selected?.acknowledgementRequired ?? false,
  );
  const [dirty, setDirty] = useState(false);
  const [publishConfirmationOpen, setPublishConfirmationOpen] = useState(false);
  const [previewViewport, setPreviewViewport] = useState<"mobile" | "desktop">(
    "desktop",
  );
  const recoveryPayload = useMemo(
    () => ({
      title,
      slug,
      category,
      audienceScope,
      audiencePersonIds,
      acknowledgementRequired,
      document,
      embedUrls,
    }),
    [
      acknowledgementRequired,
      audiencePersonIds,
      audienceScope,
      category,
      document,
      embedUrls,
      slug,
      title,
    ],
  );
  const resourcePreview = useMemo(() => {
    try {
      const urls = embedUrls
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean);
      return {
        html: renderResourceDocument(appendEmbeds(document, urls)),
        error: null,
      };
    } catch (error) {
      return {
        html: "",
        error:
          error instanceof Error
            ? error.message
            : "The resource preview could not be rendered.",
      };
    }
  }, [document, embedUrls]);
  const restoreDraft = useCallback((payload: typeof recoveryPayload) => {
    setTitle(payload.title);
    setSlug(payload.slug);
    setCategory(payload.category);
    setAudienceScope(payload.audienceScope);
    setAudiencePersonIds(payload.audiencePersonIds);
    setAcknowledgementRequired(payload.acknowledgementRequired);
    setDocument(payload.document);
    setEmbedUrls(payload.embedUrls);
    setDirty(true);
  }, []);
  const editing = creating ? null : selected;
  const editorKey = editing?.versionId ?? "new";
  const recovery = useDraftRecovery({
    scope: {
      ...loaderData.recoveryScope,
      recordType: "resource_page",
      recordId: editing?.id ?? "new",
    },
    serverRevision: `${editing?.revision ?? 0}:${editing?.versionId ?? "new"}`,
    payload: recoveryPayload,
    dirty,
    onRestore: restoreDraft,
  });
  useEffect(() => {
    setDocument(selected?.document ?? emptyDocument);
    setCreating(!selected);
    setAudienceScope(selected?.audienceScope ?? "all_speakers");
    setTitle(selected?.title ?? "");
    setSlug(selected?.slug ?? "");
    setCategory(selected?.category ?? "");
    setEmbedUrls(selected ? embeddedUrls(selected.document) : "");
    setAudiencePersonIds(selected?.audiencePersonIds ?? []);
    setAcknowledgementRequired(selected?.acknowledgementRequired ?? false);
    setDirty(false);
    setPublishConfirmationOpen(false);
  }, [selected?.id, selected?.versionId]);
  useEffect(() => {
    const committed = Boolean(
      actionData && "committed" in actionData && actionData.committed === true,
    );
    if (
      actionData &&
      (actionData.ok || committed) &&
      "intent" in actionData &&
      (actionData.intent === "save" || actionData.intent === "publish")
    ) {
      setDirty(false);
      void recovery.markServerSaved();
    }
  }, [actionData, recovery.markServerSaved]);
  useEffect(() => {
    if (!loaderData.createdFromLocalDraft) return;
    void clearDraftRecoveryScope({
      ...loaderData.recoveryScope,
      recordType: "resource_page",
      recordId: "new",
    });
  }, [loaderData.createdFromLocalDraft, loaderData.recoveryScope]);
  return (
    <>
      <div className="page-head pc-page-header">
        <div>
          <span className="pc-page-eyebrow">Speaker knowledge</span>
          <h1>Resource pages</h1>
          <p>
            Author versioned guidance with a constrained Tiptap editor, safe
            HTTPS embeds and audience-scoped publication.
          </p>
        </div>
        <div className="page-actions">
          <Link
            className="btn"
            to="/speaker/resources"
            target="_blank"
            rel="noopener noreferrer"
          >
            <ExternalLink aria-hidden size={15} /> Speaker view
            <span className="sr-only"> (opens in a new tab)</span>
          </Link>
          <button
            className="btn primary"
            type="button"
            onClick={() => {
              setCreating(true);
              setDocument(emptyDocument);
              setAudienceScope("all_speakers");
              setTitle("");
              setSlug("");
              setCategory("");
              setEmbedUrls("");
              setAudiencePersonIds([]);
              setAcknowledgementRequired(false);
              setDirty(false);
            }}
          >
            <Plus aria-hidden size={15} /> New resource
          </button>
        </div>
      </div>
      {actionData ? (
        <div
          className={`pc-status-notice ${actionData.ok ? "is-success" : "is-danger"} mb`}
          role={actionData.ok ? "status" : "alert"}
        >
          {actionData.ok ? (
            <CheckCircle2 aria-hidden size={18} />
          ) : (
            <AlertTriangle aria-hidden size={18} />
          )}
          <div className="pc-status-notice-copy">
            <strong>{actionData.ok ? "Saved" : "Action needed"}</strong>
            <div>{actionData.message}</div>
          </div>
        </div>
      ) : null}
      {loaderData.liveUpdateDelayed ? (
        <div className="pc-status-notice is-warning mb" role="status">
          <AlertTriangle aria-hidden size={18} />
          <div className="pc-status-notice-copy">
            <strong>Draft saved · live update delayed</strong>
            <div>
              The new resource draft is authoritative in D1. Refresh other open
              views before continuing.
            </div>
          </div>
        </div>
      ) : null}
      <DraftRecoveryFeedback recovery={recovery} />
      {actionData && "conflict" in actionData && actionData.conflict ? (
        <div className="validation-item error card pad mb" role="alert">
          <strong>Draft conflict</strong>
          <span>
            The editor and browser recovery copy remain intact. Export them or
            explicitly load the latest server version.
          </span>
          <span className="row-actions right">
            <button
              className="btn small"
              type="button"
              onClick={() => {
                const blob = new Blob(
                  [JSON.stringify(recoveryPayload, null, 2)],
                  {
                    type: "application/json",
                  },
                );
                const href = URL.createObjectURL(blob);
                const link = window.document.createElement("a");
                link.href = href;
                link.download = `${slug || "resource"}-recovery.json`;
                link.click();
                URL.revokeObjectURL(href);
              }}
            >
              Export local edits
            </button>
            <button
              className="btn small"
              type="button"
              onClick={() => {
                if (
                  window.confirm(
                    "Discard the current editor contents and load the latest server version?",
                  )
                ) {
                  void recovery.clear().then(() => window.location.reload());
                }
              }}
            >
              Load server version
            </button>
          </span>
        </div>
      ) : null}
      <div className="resource-admin-layout">
        <aside className="card pad resource-admin-index">
          <div className="card-title">
            <h2>Library</h2>
            <span className="pill right">{loaderData.pages.length}</span>
          </div>
          <div className="stack">
            {loaderData.pages.map((page) => (
              <Link
                className={`resource-link${!creating && selected?.id === page.id ? " active" : ""}`}
                to={`/admin/resources?resource=${page.id}`}
                key={page.id}
              >
                <strong>{page.title}</strong>
                <small>
                  {page.category ?? "General"} · version{" "}
                  {page.versionNumber ?? "—"}
                </small>
                <span className={`status ${statusClass(page.status)}`}>
                  {page.status}
                </span>
              </Link>
            ))}
          </div>
        </aside>
        <section className="card resource-admin-editor">
          <Form key={editorKey} method="post" className="resource-edit-form">
            <input type="hidden" name="intent" value="save" />
            {editing ? (
              <>
                <input type="hidden" name="id" value={editing.id} />
                <input type="hidden" name="revision" value={editing.revision} />
              </>
            ) : null}
            <input
              type="hidden"
              name="documentJson"
              value={JSON.stringify(document)}
            />
            <div className="resource-editor-head">
              <div>
                <span className="pc-section-kicker">
                  {editing
                    ? `Version ${editing.versionNumber ?? 1} · ${editing.versionStatus}`
                    : "New draft"}
                </span>
                <h2>{editing?.title ?? "Untitled resource"}</h2>
              </div>
              {editing ? (
                <span className={`status ${statusClass(editing.status)}`}>
                  {editing.status}
                </span>
              ) : null}
            </div>
            <div className="resource-settings-grid">
              <label className="label">
                Title
                <input
                  className="field"
                  name="title"
                  value={title}
                  onChange={(event) => {
                    setTitle(event.target.value);
                    setDirty(true);
                  }}
                  required
                  maxLength={180}
                />
              </label>
              <label className="label">
                URL slug
                <input
                  className="field"
                  name="slug"
                  value={slug}
                  onChange={(event) => {
                    setSlug(event.target.value);
                    setDirty(true);
                  }}
                  required
                  pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                />
              </label>
              <label className="label">
                Category
                <input
                  className="field"
                  name="category"
                  value={category}
                  onChange={(event) => {
                    setCategory(event.target.value);
                    setDirty(true);
                  }}
                />
              </label>
              <label className="label">
                Audience
                <select
                  className="select"
                  name="audienceScope"
                  value={audienceScope}
                  onChange={(event) => {
                    const value = event.target.value;
                    if (
                      value === "all_speakers" ||
                      value === "accepted_speakers" ||
                      value === "custom"
                    ) {
                      setAudienceScope(value);
                      setDirty(true);
                    }
                  }}
                >
                  <option value="all_speakers">All speakers</option>
                  <option value="accepted_speakers">
                    Speakers with accepted sessions
                  </option>
                  <option value="custom">Selected speakers</option>
                </select>
              </label>
            </div>
            {audienceScope === "custom" ? (
              <fieldset className="card pad mt">
                <legend>Selected speakers</legend>
                {loaderData.audienceCandidates.length ? (
                  <div className="stack">
                    {loaderData.audienceCandidates.map((person) => (
                      <label className="toggle" key={person.id}>
                        <input
                          type="checkbox"
                          name="audiencePersonIds"
                          value={person.id}
                          checked={audiencePersonIds.includes(person.id)}
                          onChange={(event) => {
                            setAudiencePersonIds((current) =>
                              event.target.checked
                                ? [...new Set([...current, person.id])]
                                : current.filter((id) => id !== person.id),
                            );
                            setDirty(true);
                          }}
                        />{" "}
                        <span>
                          <strong>{person.displayName}</strong>
                          <small>{person.email}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                ) : (
                  <p className="help">
                    Add speakers to sessions before creating a selected-speaker
                    audience.
                  </p>
                )}
              </fieldset>
            ) : null}
            <label className="speaker-confirm">
              <input
                type="checkbox"
                name="acknowledgementRequired"
                checked={acknowledgementRequired}
                onChange={(event) => {
                  setAcknowledgementRequired(event.target.checked);
                  setDirty(true);
                }}
              />{" "}
              Create and track an acknowledgement task for this resource
            </label>
            <div className="resource-authoring-grid">
              <div>
                <label className="label">Page content</label>
                <RichResourceEditor
                  key={editorKey}
                  document={document}
                  onChange={(next) => {
                    setDocument(next);
                    setDirty(true);
                  }}
                />
              </div>
              <aside>
                <label className="label">
                  Safe HTTPS embeds
                  <textarea
                    className="textarea"
                    name="embedUrls"
                    value={embedUrls}
                    onChange={(event) => {
                      setEmbedUrls(event.target.value);
                      setDirty(true);
                    }}
                    placeholder="One HTTPS URL per line"
                    rows={6}
                  />
                </label>
                <p className="help">
                  <Globe2 aria-hidden size={13} /> Embeds render in a sandbox
                  without scripts or parent navigation privileges.
                </p>
              </aside>
            </div>
            <section
              className="resource-live-preview mt"
              aria-label="Live speaker resource preview"
            >
              <div className="card-title">
                <div>
                  <span className="pc-section-kicker">Live speaker view</span>
                  <h3>Resource preview</h3>
                </div>
                <span
                  className="preview-viewport-controls right"
                  role="group"
                  aria-label="Resource preview size"
                >
                  <button
                    className="btn small"
                    type="button"
                    aria-pressed={previewViewport === "mobile"}
                    onClick={() => setPreviewViewport("mobile")}
                  >
                    Mobile
                  </button>
                  <button
                    className="btn small"
                    type="button"
                    aria-pressed={previewViewport === "desktop"}
                    onClick={() => setPreviewViewport("desktop")}
                  >
                    Desktop
                  </button>
                </span>
              </div>
              {resourcePreview.error ? (
                <div className="validation-item error" role="alert">
                  <strong>Preview unavailable</strong>
                  <span>{resourcePreview.error}</span>
                </div>
              ) : (
                <article
                  className={`resource-preview-device event-branded is-${previewViewport}`}
                  style={
                    {
                      "--event-accent": loaderData.previewEvent.brandAccent,
                    } as React.CSSProperties
                  }
                >
                  <header>
                    <span className="brand-mark small">P</span>
                    <span>
                      <strong>{loaderData.previewEvent.name}</strong>
                      <small>Speaker resources</small>
                    </span>
                  </header>
                  <div className="speaker-resource-content">
                    <span className="pill">{category.trim() || "General"}</span>
                    <h2>{title.trim() || "Untitled resource"}</h2>
                    <div
                      className="resource-rendered"
                      dangerouslySetInnerHTML={{ __html: resourcePreview.html }}
                    />
                  </div>
                </article>
              )}
              <p className="help">
                Preview content stays local. Saving creates the authoritative D1
                draft version; publishing controls what speakers can see.
              </p>
            </section>
            <div className="sticky-actions">
              <span className="subtle">
                Saving creates a new immutable draft version.
              </span>
              <DraftRecoveryStatus state={recovery.state} />
              <span className="spacer" />
              <button
                className="btn primary"
                disabled={navigation.state !== "idle"}
              >
                {navigation.state === "submitting" && pendingIntent === "save"
                  ? "Saving…"
                  : "Save draft version"}
              </button>
            </div>
          </Form>
          {editing ? (
            <div className="resource-secondary-actions">
              <button
                className="btn primary"
                type="button"
                onClick={() => setPublishConfirmationOpen(true)}
                disabled={
                  editing.versionStatus !== "draft" ||
                  dirty ||
                  navigation.state !== "idle"
                }
              >
                <BookOpenCheck aria-hidden size={15} /> Publish current draft
              </button>
              {editing.versionId ? (
                <DirectMultipartUpload
                  key={`${editing.versionId}:${editing.revision}`}
                  target={{ targetType: "resource", targetId: editing.id }}
                  kinds={[
                    {
                      value: "resource_attachment",
                      label: "Resource attachment",
                      accept:
                        ".pdf,.doc,.docx,.xls,.xlsx,.zip,application/pdf,application/zip",
                      maximumBytes:
                        loaderData.previewEvent.filePolicy
                          .supportingDocumentMaximumBytes,
                    },
                  ]}
                  heading="Private resource attachment"
                  description={`The browser uploads PDF, Office document or ZIP attachments directly to private R2 (maximum ${maximumMegabytes(loaderData.previewEvent.filePolicy.supportingDocumentMaximumBytes)} MB). Save page edits first; the completed file is linked only to this exact draft revision and remains quarantined until scanning passes.`}
                  disabled={
                    editing.versionStatus !== "draft" ||
                    dirty ||
                    navigation.state !== "idle"
                  }
                  onCompleted={async ({ assetId, versionId }) => {
                    const response = await fetch("/files/resource-attachment", {
                      method: "POST",
                      headers: { "content-type": "application/json" },
                      body: JSON.stringify({
                        pageId: editing.id,
                        pageVersionId: editing.versionId,
                        revision: editing.revision,
                        assetId,
                        fileVersionId: versionId,
                      }),
                    });
                    return readResourceAttachmentCompletion(response);
                  }}
                />
              ) : (
                <div className="validation-item error" role="alert">
                  This resource has no current draft version. Save a draft
                  before uploading an attachment.
                </div>
              )}
              {editing.attachments.length ? (
                <div className="stack resource-admin-attachments">
                  {editing.attachments.map((attachment) => (
                    <div className="file-version-row" key={attachment.id}>
                      <span>
                        <strong>{attachment.filename}</strong>
                        <small>
                          {attachment.uploadStatus} · scan{" "}
                          {attachment.scanStatus}
                        </small>
                      </span>
                      <span
                        className={`status ${attachment.scanStatus === "clean" ? "success" : "warning"}`}
                      >
                        {attachment.scanStatus === "pending"
                          ? "Quarantined"
                          : attachment.scanStatus}
                      </span>
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {publishConfirmationOpen && editing ? (
            <Dialog
              title="Publish this resource version?"
              onClose={() => setPublishConfirmationOpen(false)}
              footer={
                <>
                  <button
                    className="btn"
                    type="button"
                    onClick={() => setPublishConfirmationOpen(false)}
                  >
                    Keep as draft
                  </button>
                  <Form
                    method="post"
                    onSubmit={() => setPublishConfirmationOpen(false)}
                  >
                    <input type="hidden" name="intent" value="publish" />
                    <input type="hidden" name="id" value={editing.id} />
                    <input
                      type="hidden"
                      name="revision"
                      value={editing.revision}
                    />
                    <button
                      className="btn primary"
                      type="submit"
                      disabled={
                        (editing.publicationImpact?.blockingDependentTasks ??
                          0) > 0
                      }
                    >
                      Publish version {editing.versionNumber}
                    </button>
                  </Form>
                </>
              }
            >
              <p>
                <strong>{editing.title}</strong> will immediately replace the
                current public resource for its audience.
              </p>
              <ul>
                <li>Audience: {editing.audienceScope.replaceAll("_", " ")}.</li>
                {editing.acknowledgementRequired ? (
                  <li>
                    Create or reset acknowledgement tasks for{" "}
                    {editing.publicationImpact?.tasksCreatedOrReset ?? 0}{" "}
                    eligible speaker
                    {(editing.publicationImpact?.eligibleSpeakerCount ?? 0) ===
                    1
                      ? ""
                      : "s"}
                    .
                  </li>
                ) : (
                  <li>No acknowledgement will be required for this version.</li>
                )}
                {(editing.publicationImpact?.tasksWaived ?? 0) > 0 ? (
                  <li>
                    Waive {editing.publicationImpact!.tasksWaived} existing
                    acknowledgement task
                    {editing.publicationImpact!.tasksWaived === 1 ? "" : "s"}.
                  </li>
                ) : null}
                {(editing.publicationImpact?.templateDependenciesRemoved ?? 0) >
                0 ? (
                  <li>
                    Remove acknowledgement as a prerequisite from{" "}
                    {editing.publicationImpact!.templateDependenciesRemoved}{" "}
                    active task template
                    {editing.publicationImpact!.templateDependenciesRemoved ===
                    1
                      ? ""
                      : "s"}
                    .
                  </li>
                ) : null}
              </ul>
              {(editing.publicationImpact?.blockingDependentTasks ?? 0) > 0 ? (
                <div className="validation-item error" role="alert">
                  Reopen the submitted or completed dependent task before
                  publishing this acknowledgement reset.
                </div>
              ) : null}
            </Dialog>
          ) : null}
        </section>
      </div>
    </>
  );
}
