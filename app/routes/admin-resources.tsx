import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  AlertTriangle,
  BookOpenCheck,
  CheckCircle2,
  ExternalLink,
  FileUp,
  Globe2,
  Plus,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
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
import { Dialog } from "~/components/dialog";
import { FilePolicyError } from "~/modules/files/file-policy";
import { FileService } from "~/modules/files/file-service.server";
import {
  ResourceContentError,
  type TiptapNode,
} from "~/modules/resources/resource-content";
import {
  ResourceRevisionConflictError,
  ResourceService,
  ResourceSlugConflictError,
  ResourceTaskDependencyError,
} from "~/modules/resources/resource-service.server";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import { requireEventRole } from "~/platform/auth/authorize.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";

export const meta = () => [{ title: "Speaker Resources · Program Cue" }];

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
  if (!env.DEFAULT_EVENT_ID)
    throw new Response("DEFAULT_EVENT_ID is not configured", { status: 503 });
  await ensureDemoSpeakerData(env);
  const viewer = await requireEventRole(request, env, env.DEFAULT_EVENT_ID, [
    "owner",
    "administrator",
  ]);
  return { env, viewer };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, viewer } = await administrator(request, context);
  return new ResourceService(env).getAdminWorkspace(
    viewer,
    new URL(request.url).searchParams.get("resource"),
  );
}

function actionError(error: unknown) {
  if (error instanceof ZodError)
    return error.issues[0]?.message ?? "Review the resource fields.";
  if (
    error instanceof ResourceContentError ||
    error instanceof ResourceRevisionConflictError ||
    error instanceof ResourceSlugConflictError ||
    error instanceof ResourceTaskDependencyError ||
    error instanceof FilePolicyError ||
    error instanceof InvalidResourcePayloadError
  )
    return error.message;
  return null;
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env, viewer } = await administrator(request, context);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (
    intent !== "save" &&
    intent !== "publish" &&
    intent !== "upload-attachment"
  ) {
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
      if (realtimeFailure) return data(realtimeFailure, { status: 207 });
      return data({
        ok: true,
        message:
          "Resource version published and acknowledgement tasks synchronised.",
      });
    }
    if (intent === "upload-attachment") {
      const pageId = String(form.get("id") ?? "");
      const versionId = String(form.get("versionId") ?? "");
      const revision = Number(form.get("revision"));
      const file = form.get("file");
      if (!(file instanceof File))
        throw new FilePolicyError("Choose an attachment.");
      const fileService = new FileService(env);
      const upload = await fileService.uploadAdminFile(
        viewer,
        {
          targetType: "resource",
          targetId: pageId,
          assetKind: "resource_attachment",
        },
        file,
      );
      try {
        await service.attachToDraft(
          viewer,
          pageId,
          versionId,
          revision,
          upload.assetId,
        );
      } catch (error) {
        await fileService.discardUnattachedResourceUpload(viewer, upload);
        throw error;
      }
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "resource_page",
        entityId: pageId,
        changeType: "updated",
      });
      if (realtimeFailure) return data(realtimeFailure, { status: 207 });
      return data({
        ok: true,
        message:
          "Attachment stored in R2 quarantine. It will remain hidden from speakers until a scanner reports it clean.",
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
    if (realtimeFailure) return data(realtimeFailure, { status: 207 });
    if (!existingId) return redirect(`/admin/resources?resource=${id}`);
    return data({
      ok: true,
      message: "A new immutable draft version was saved.",
    });
  } catch (error) {
    const message = actionError(error);
    if (message) {
      return data(
        { ok: false, message },
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
        <button
          type="button"
          className={editor.isActive("bold") ? "active" : ""}
          aria-label="Bold"
          aria-pressed={editor.isActive("bold")}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <strong>B</strong>
        </button>
        <button
          type="button"
          className={editor.isActive("italic") ? "active" : ""}
          aria-label="Italic"
          aria-pressed={editor.isActive("italic")}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <em>I</em>
        </button>
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
        <button
          type="button"
          className={editor.isActive("bulletList") ? "active" : ""}
          aria-label="Bulleted list"
          aria-pressed={editor.isActive("bulletList")}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          • List
        </button>
        <button
          type="button"
          className={editor.isActive("blockquote") ? "active" : ""}
          aria-label="Block quote"
          aria-pressed={editor.isActive("blockquote")}
          onClick={() => editor.chain().focus().toggleBlockquote().run()}
        >
          Quote
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().undo().run()}
          disabled={!editor.can().undo()}
        >
          Undo
        </button>
        <button
          type="button"
          onClick={() => editor.chain().focus().redo().run()}
          disabled={!editor.can().redo()}
        >
          Redo
        </button>
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
  const [publishConfirmationOpen, setPublishConfirmationOpen] = useState(false);
  useEffect(() => {
    setDocument(selected?.document ?? emptyDocument);
    setCreating(!selected);
    setPublishConfirmationOpen(false);
  }, [selected?.id, selected?.versionId]);
  const editing = creating ? null : selected;
  const editorKey = editing?.versionId ?? "new";
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
            rel="noreferrer"
          >
            <ExternalLink aria-hidden size={15} /> Speaker view
          </Link>
          <button
            className="btn primary"
            type="button"
            onClick={() => {
              setCreating(true);
              setDocument(emptyDocument);
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
                  defaultValue={editing?.title ?? ""}
                  required
                  maxLength={180}
                />
              </label>
              <label className="label">
                URL slug
                <input
                  className="field"
                  name="slug"
                  defaultValue={editing?.slug ?? ""}
                  required
                  pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                />
              </label>
              <label className="label">
                Category
                <input
                  className="field"
                  name="category"
                  defaultValue={editing?.category ?? ""}
                />
              </label>
              <label className="label">
                Audience
                <select
                  className="select"
                  name="audienceScope"
                  defaultValue={editing?.audienceScope ?? "all_speakers"}
                >
                  <option value="all_speakers">All speakers</option>
                  <option value="accepted_speakers">
                    Speakers with accepted sessions
                  </option>
                  {editing?.audienceScope === "custom" ? (
                    <option value="custom">Existing custom audience</option>
                  ) : null}
                </select>
              </label>
            </div>
            <label className="speaker-confirm">
              <input
                type="checkbox"
                name="acknowledgementRequired"
                defaultChecked={editing?.acknowledgementRequired ?? false}
              />{" "}
              Create and track an acknowledgement task for this resource
            </label>
            <div className="resource-authoring-grid">
              <div>
                <label className="label">Page content</label>
                <RichResourceEditor
                  key={editorKey}
                  document={editing?.document ?? emptyDocument}
                  onChange={setDocument}
                />
              </div>
              <aside>
                <label className="label">
                  Safe HTTPS embeds
                  <textarea
                    className="textarea"
                    name="embedUrls"
                    defaultValue={editing ? embeddedUrls(editing.document) : ""}
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
            <div className="sticky-actions">
              <span className="subtle">
                Saving creates a new immutable draft version.
              </span>
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
                  navigation.state !== "idle"
                }
              >
                <BookOpenCheck aria-hidden size={15} /> Publish current draft
              </button>
              <Form
                method="post"
                encType="multipart/form-data"
                className="resource-attachment-upload"
              >
                <input type="hidden" name="intent" value="upload-attachment" />
                <input type="hidden" name="id" value={editing.id} />
                <input
                  type="hidden"
                  name="versionId"
                  value={editing.versionId ?? ""}
                />
                <input type="hidden" name="revision" value={editing.revision} />
                <label className="label">
                  Private attachment
                  <input className="field" type="file" name="file" required />
                </label>
                <button
                  className="btn"
                  disabled={
                    editing.versionStatus !== "draft" ||
                    navigation.state !== "idle"
                  }
                >
                  <FileUp aria-hidden size={15} />{" "}
                  {navigation.state === "submitting" &&
                  pendingIntent === "upload-attachment"
                    ? "Uploading…"
                    : "Upload to quarantine"}
                </button>
              </Form>
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
