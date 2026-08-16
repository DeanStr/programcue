import {
  AlertTriangle,
  BookOpenCheck,
  CheckCircle2,
  ExternalLink,
  Plus,
} from "lucide-react";
import { Form, Link } from "react-router";

import { BrandMark } from "~/components/brand-mark";
import { Dialog } from "~/components/dialog";
import {
  DirectMultipartUpload,
  DirectUploadCompletionConflictError,
} from "~/components/direct-multipart-upload";
import {
  DraftRecoveryFeedback,
  DraftRecoveryStatus,
} from "~/components/draft-recovery-feedback";
import { useConfirm } from "~/components/ui/confirm-dialog";
import { DerivedSlugField } from "~/components/ui/derived-slug-field";
import { maximumMegabytes } from "~/modules/files/file-policy";
import { emptyResourceExternalEmbedDraft } from "~/modules/resources/resource-recovery";
import { UserFacingError } from "~/platform/user-facing-error";
import {
  type AdminResourcesData,
  emptyResourceDocument as emptyDocument,
  ResourceAdminModelContext,
  useResourceAdminModel,
  useResourceAdminState,
} from "./admin-resources-model";
import { ResourceDocument } from "./resource-document";
import { ResourceExternalEmbedEditor } from "./resource-external-embed-editor";
import { RichResourceEditor } from "./rich-resource-editor";

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
        "The attachment was saved, but other open views could not be updated automatically. Reload them before continuing.",
    };
  }
  if (!response.ok || result.ok !== true)
    throw new UserFacingError(
      result.error ??
        result.message ??
        "The attachment could not be saved. Try again.",
    );
  return { message: result.message };
}

function statusClass(status: string) {
  return status === "published"
    ? "success"
    : status === "archived"
      ? "danger"
      : "warning";
}
function ResourceSaveIntent() {
  return <input type="hidden" name="intent" value="save" />;
}

function ResourceEditingIdentity() {
  const { editing } = useResourceAdminModel();
  return editing ? (
    <>
      <input type="hidden" name="id" value={editing.id} />
      <input type="hidden" name="revision" value={editing.revision} />
    </>
  ) : null;
}

function ResourceDocumentValue() {
  const { document } = useResourceAdminModel();
  return (
    <input type="hidden" name="documentJson" value={JSON.stringify(document)} />
  );
}

function ResourceEditorHeader() {
  const { editing } = useResourceAdminModel();
  return (
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
  );
}

function ResourceSettingsPanel() {
  const {
    audienceScope,
    setAudienceScope,
    title,
    setTitle,
    slug,
    setSlug,
    category,
    setCategory,
    setDirty,
    editing,
    editorKey,
  } = useResourceAdminModel();
  return (
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
      <DerivedSlugField
        source={title}
        value={slug}
        onChange={(value) => {
          setSlug(value);
          setDirty(true);
        }}
        initiallyDerived={!editing}
        resetKey={editorKey}
        maximumLength={100}
      />
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
  );
}

function ResourceCustomAudiencePanel() {
  const {
    loaderData,
    audienceScope,
    audiencePersonIds,
    setAudiencePersonIds,
    setDirty,
  } = useResourceAdminModel();
  return audienceScope === "custom" ? (
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
          Add speakers to sessions before creating a selected-speaker audience.
        </p>
      )}
    </fieldset>
  ) : null;
}

function ResourceAcknowledgementSetting() {
  const { acknowledgementRequired, setAcknowledgementRequired, setDirty } =
    useResourceAdminModel();
  return (
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
  );
}

function ResourceAuthoringPanel() {
  const {
    loaderData,
    document,
    setDocument,
    externalEmbedDraft,
    setExternalEmbedDraft,
    setDirty,
    editorKey,
  } = useResourceAdminModel();
  return (
    <div className="resource-authoring-grid">
      <div>
        <div className="label">Page content</div>
        <RichResourceEditor
          key={editorKey}
          document={document}
          onChange={(next) => {
            setDocument(next);
            setDirty(true);
          }}
        />
      </div>
      <ResourceExternalEmbedEditor
        document={document}
        configuration={loaderData.embedConfiguration}
        draft={externalEmbedDraft}
        onChange={(next) => {
          setDocument(next);
          setDirty(true);
        }}
        onDraftChange={(next) => {
          setExternalEmbedDraft(next);
          setDirty(true);
        }}
      />
    </div>
  );
}

function ResourcePreviewPanel() {
  const {
    loaderData,
    document,
    title,
    category,
    previewViewport,
    setPreviewViewport,
    resourcePreview,
  } = useResourceAdminModel();
  return (
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
            <BrandMark size="small" />
            <span>
              <strong>{loaderData.previewEvent.name}</strong>
              <small>Speaker resources</small>
            </span>
          </header>
          <div className="speaker-resource-content">
            <span className="pill">{category.trim() || "General"}</span>
            <h2>{title.trim() || "Untitled resource"}</h2>
            <ResourceDocument
              document={document}
              configuration={loaderData.embedConfiguration}
            />
          </div>
        </article>
      )}
      <p className="help">
        This preview is local to your browser. Saving creates the draft version
        of record; publishing controls what speakers can see.
      </p>
    </section>
  );
}

function ResourceEditorActions() {
  const { navigation, pendingIntent, recovery } = useResourceAdminModel();
  return (
    <div className="sticky-actions">
      <span className="subtle">
        Saving creates a new immutable draft version.
      </span>
      <DraftRecoveryStatus state={recovery.state} />
      <span className="spacer" />
      <button
        type="submit"
        className="btn primary"
        disabled={navigation.state !== "idle"}
      >
        {navigation.state === "submitting" && pendingIntent === "save"
          ? "Saving…"
          : "Save draft version"}
      </button>
    </div>
  );
}

function ResourceEditorPanel() {
  const {
    loaderData,
    navigation,
    dirty,
    publishConfirmationOpen,
    setPublishConfirmationOpen,
    editing,
    editorKey,
  } = useResourceAdminModel();
  return (
    <section className="card resource-admin-editor">
      <Form key={editorKey} method="post" className="resource-edit-form">
        <ResourceSaveIntent />
        <ResourceEditingIdentity />
        <ResourceDocumentValue />
        <ResourceEditorHeader />
        <ResourceSettingsPanel />
        <ResourceCustomAudiencePanel />
        <ResourceAcknowledgementSetting />
        <ResourceAuthoringPanel />
        <ResourcePreviewPanel />
        <ResourceEditorActions />
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
              description={`PDF, Office document or ZIP attachments upload straight from this browser to private storage (maximum ${maximumMegabytes(loaderData.previewEvent.filePolicy.supportingDocumentMaximumBytes)} MB). Save page edits first; the completed file is linked only to this exact draft version and stays quarantined until scanning passes.`}
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
              This resource has no current draft version. Save a draft before
              uploading an attachment.
            </div>
          )}
          {editing.attachments.length ? (
            <div className="stack resource-admin-attachments">
              {editing.attachments.map((attachment) => (
                <div className="file-version-row" key={attachment.id}>
                  <span>
                    <strong>{attachment.filename}</strong>
                    <small>
                      {attachment.uploadStatus} · scan {attachment.scanStatus}
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
                <input type="hidden" name="revision" value={editing.revision} />
                <button
                  className="btn primary"
                  type="submit"
                  disabled={
                    (editing.publicationImpact?.blockingDependentTasks ?? 0) > 0
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
                {editing.publicationImpact?.tasksCreatedOrReset ?? 0} eligible
                speaker
                {(editing.publicationImpact?.eligibleSpeakerCount ?? 0) === 1
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
                {editing.publicationImpact!.templateDependenciesRemoved} active
                task template
                {editing.publicationImpact!.templateDependenciesRemoved === 1
                  ? ""
                  : "s"}
                .
              </li>
            ) : null}
          </ul>
          {(editing.publicationImpact?.blockingDependentTasks ?? 0) > 0 ? (
            <div className="validation-item error" role="alert">
              Reopen the submitted or completed dependent task before publishing
              this acknowledgement reset.
            </div>
          ) : null}
        </Dialog>
      ) : null}
    </section>
  );
}

function ResourceLibraryPanel() {
  const { loaderData, selected, creating } = useResourceAdminModel();
  return (
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
              {page.category ?? "General"} · version {page.versionNumber ?? "—"}
            </small>
            <span className={`status ${statusClass(page.status)}`}>
              {page.status}
            </span>
          </Link>
        ))}
      </div>
    </aside>
  );
}

function ResourceAdministrationLayout() {
  return (
    <div className="resource-admin-layout">
      <ResourceLibraryPanel />
      <ResourceEditorPanel />
    </div>
  );
}

function ResourceAdminHeader() {
  const {
    setDocument,
    setExternalEmbedDraft,
    setCreating,
    setAudienceScope,
    setTitle,
    setSlug,
    setCategory,
    setAudiencePersonIds,
    setAcknowledgementRequired,
    setDirty,
  } = useResourceAdminModel();
  return (
    <div className="page-head pc-page-header">
      <div>
        <span className="pc-page-eyebrow">Speaker knowledge</span>
        <h1>Resource pages</h1>
        <p>
          Author versioned guidance with a constrained editor, private
          attachments, optional video or map blocks and audience-scoped
          publication.
        </p>
      </div>
      <div className="page-actions">
        <Link
          className="btn"
          to="/participant/resources"
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
            setExternalEmbedDraft(emptyResourceExternalEmbedDraft);
            setAudienceScope("all_speakers");
            setTitle("");
            setSlug("");
            setCategory("");
            setAudiencePersonIds([]);
            setAcknowledgementRequired(false);
            setDirty(false);
          }}
        >
          <Plus aria-hidden size={15} /> New resource
        </button>
      </div>
    </div>
  );
}

function ResourceActionNotice() {
  const { actionData } = useResourceAdminModel();
  return actionData ? (
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
  ) : null;
}

function ResourceLiveUpdateNotice() {
  const { loaderData } = useResourceAdminModel();
  return loaderData.liveUpdateDelayed ? (
    <div className="pc-status-notice is-warning mb" role="status">
      <AlertTriangle aria-hidden size={18} />
      <div className="pc-status-notice-copy">
        <strong>Draft saved · live update delayed</strong>
        <div>
          Your draft is saved. Refresh other open views before continuing.
        </div>
      </div>
    </div>
  ) : null;
}

function ResourceDraftRecoveryNotice() {
  const { recovery } = useResourceAdminModel();
  return <DraftRecoveryFeedback recovery={recovery} />;
}

function ResourceDraftConflictNotice() {
  const { actionData, slug, recoveryPayload, recovery } =
    useResourceAdminModel();
  const { confirm, dialog } = useConfirm();
  return actionData && "conflict" in actionData && actionData.conflict ? (
    <div className="validation-item error card pad mb" role="alert">
      {dialog}
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
            const blob = new Blob([JSON.stringify(recoveryPayload, null, 2)], {
              type: "application/json",
            });
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
          onClick={() =>
            confirm(
              {
                title: "Load the latest server version?",
                description:
                  "Your unsaved edits and the copy kept in this browser are discarded, then the page reloads the latest saved draft. Export your local edits first if you still need them.",
                confirmLabel: "Discard and reload",
              },
              () => {
                void recovery.clear().then(() => window.location.reload());
              },
            )
          }
        >
          Load server version
        </button>
      </span>
    </div>
  ) : null;
}

function ResourceAdministrationPage() {
  return (
    <>
      <ResourceAdminHeader />
      <ResourceActionNotice />
      <ResourceLiveUpdateNotice />
      <ResourceDraftRecoveryNotice />
      <ResourceDraftConflictNotice />
      <ResourceAdministrationLayout />
    </>
  );
}

export function AdminResourcesWorkspace({
  loaderData,
}: {
  loaderData: AdminResourcesData;
}) {
  const model = useResourceAdminState(loaderData);
  return (
    <ResourceAdminModelContext.Provider value={model}>
      <ResourceAdministrationPage />
    </ResourceAdminModelContext.Provider>
  );
}
