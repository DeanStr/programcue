import { useEffect, useState } from "react";
import { data, Form, Link, redirect, useActionData } from "react-router";
import { ZodError } from "zod";
import { Dialog } from "~/components/dialog";
import {
  DraftRecoveryFeedback,
  DraftRecoveryStatus,
} from "~/components/draft-recovery-feedback";
import {
  type FormBuilderActionResult,
  useFormBuilderController,
} from "~/components/form-builder-controller";
import {
  ApplicantPreviewPanel,
  FieldSettingsPanel,
  FormStructurePanel,
  FormVersionHistory,
  PresentationSettingsPanel,
  PublicationSettingsFields,
} from "~/components/form-builder-panels";
import { FormBuilderVisualCanvas } from "~/components/form-builder-visual-canvas";
import { useConfirm } from "~/components/ui/confirm-dialog";
import { DerivedSlugField } from "~/components/ui/derived-slug-field";
import { ensureDemoSubmissionForm } from "~/modules/submissions/demo-submissions.server";
import {
  SubmissionRevisionConflictError,
  SubmissionStateError,
} from "~/modules/submissions/submission-repository.server";
import { closeDateFromEpoch } from "~/modules/submissions/submission-repository-shared";
import type { SaveFormInput } from "~/modules/submissions/submission-schema";
import { SubmissionService } from "~/modules/submissions/submission-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/form-builder-preview";

export const meta: Route.MetaFunction = () => [
  { title: "Form Builder · Program Cue" },
];

async function viewerFor(
  request: Request,
  context: Route.LoaderArgs["context"],
) {
  const { env } = getCloudflareContext(context);
  return {
    env,
    viewer: await requireCurrentEventRole(request, env, [
      "owner",
      "administrator",
    ]),
  };
}
export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, viewer } = await viewerFor(request, context);
  await ensureDemoSubmissionForm(env);
  const service = new SubmissionService(env);
  const url = new URL(request.url);
  const requestedFormId = url.searchParams.get("form");
  const creating = url.searchParams.get("new") === "1";
  const [workspace, forms, routingTeams, routingTracks, sessionFormats] =
    await Promise.all([
      creating
        ? Promise.resolve(null)
        : service.getAdminWorkspace(viewer, requestedFormId ?? undefined),
      service.listAdminForms(viewer),
      service.listRoutingTeams(viewer),
      service.listRoutingTracks(viewer),
      service.getConfiguredSessionFormats(viewer),
    ]);
  if (requestedFormId !== null && !workspace) {
    throw new Response("Form not found", { status: 404 });
  }
  const browserWorkspace = workspace
    ? {
        ...workspace,
        draftVersion: {
          ...workspace.draftVersion,
          routing: {
            ...workspace.draftVersion.routing,
            passwordHash: null,
          },
        },
        publishedVersion: workspace.publishedVersion
          ? {
              ...workspace.publishedVersion,
              routing: {
                ...workspace.publishedVersion.routing,
                passwordHash: null,
              },
            }
          : null,
      }
    : null;
  const storedInput = workspace
    ? SubmissionService.workspaceToInput(workspace)
    : null;
  const input = storedInput
    ? SubmissionService.synchronizeFormEventChoices(
        storedInput,
        routingTracks,
        sessionFormats,
      )
    : await service.getDefaultFormInput(viewer);
  return {
    workspace: browserWorkspace,
    forms,
    routingTeams,
    routingTracks,
    passwordConfigured: Boolean(workspace?.draftVersion.routing.passwordHash),
    recoveryScope: {
      eventId: viewer.eventId,
      personId: viewer.personId,
    },
    createdFromLocalDraft: url.searchParams.get("created") === "1",
    input,
    eventChoicesChanged:
      storedInput !== null &&
      JSON.stringify(storedInput) !== JSON.stringify(input),
  };
}

class InvalidFormPayloadError extends Error {}

function jsonValue(formData: FormData, key: string) {
  try {
    return JSON.parse(String(formData.get(key) ?? ""));
  } catch {
    throw new InvalidFormPayloadError(
      `The ${key} you submitted could not be read. Reload the page and try again.`,
    );
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env, viewer } = await viewerFor(request, context);
  const service = new SubmissionService(env);
  const formData = await request.formData();
  const intent = String(formData.get("_intent") ?? "");
  if (intent !== "save" && intent !== "publish") {
    return data<FormBuilderActionResult>(
      { ok: false, message: "Unsupported form action." },
      { status: 400 },
    );
  }
  if (formData.get("_clientReady") !== "1") {
    return data<FormBuilderActionResult>(
      {
        ok: false,
        message: "The form builder requires JavaScript before it can save.",
      },
      { status: 400 },
    );
  }
  try {
    if (intent === "publish") {
      const id = String(formData.get("id") ?? "");
      if (!id) {
        return data<FormBuilderActionResult>(
          { ok: false, message: "Save the form before publishing it." },
          { status: 422 },
        );
      }
      await service.publishForm(
        viewer,
        id,
        formData.get("revision"),
        formData.get("draftRevision"),
      );
      return data<FormBuilderActionResult>({
        ok: true,
        message: "Published a new immutable form version.",
      });
    }

    const id = String(formData.get("id") ?? "") || undefined;
    const savedId = await service.saveForm(viewer, {
      id,
      revision: formData.get("revision"),
      draftRevision: formData.get("draftRevision"),
      name: formData.get("name"),
      kind: formData.get("kind"),
      publicSlug: formData.get("publicSlug"),
      closeDate: String(formData.get("closeDate") ?? "") || null,
      submissionLimit: formData.get("submissionLimit"),
      minSpeakers: formData.get("minSpeakers"),
      maxSpeakers: formData.get("maxSpeakers"),
      accessMode: formData.get("accessMode"),
      accessPassword: String(formData.get("accessPassword") ?? ""),
      schema: jsonValue(formData, "schema"),
      routing: jsonValue(formData, "routing"),
    });
    if (!id)
      return redirect(
        `/admin/submissions/form?form=${encodeURIComponent(savedId)}&created=1`,
      );
    return data<FormBuilderActionResult>({
      ok: true,
      message: "Draft form saved.",
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return data<FormBuilderActionResult>(
        {
          ok: false,
          message:
            error.issues[0]?.message ?? "Review the highlighted form settings.",
          errors: error.flatten().fieldErrors,
        },
        { status: 400 },
      );
    }
    if (error instanceof InvalidFormPayloadError) {
      return data<FormBuilderActionResult>(
        { ok: false, message: error.message },
        { status: 400 },
      );
    }
    if (
      error instanceof SubmissionRevisionConflictError ||
      error instanceof SubmissionStateError
    ) {
      return data<FormBuilderActionResult>(
        { ok: false, message: error.message, conflict: true },
        { status: 409 },
      );
    }
    if (error instanceof Response) throw error;
    throw error;
  }
}

export default function FormBuilder({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>() as
    | FormBuilderActionResult
    | undefined;
  const {
    categoryField,
    change,
    clientValidationLocation,
    clientValidationMessage,
    dirty,
    formRef,
    input,
    navigationState,
    patchField,
    pendingIntent,
    publishOpen,
    recovery,
    recoveryPayload,
    reportClientValidation,
    selected,
    setPublishOpen,
    setSelectedId,
    submitBuilder,
  } = useFormBuilderController(loaderData, actionData);
  const { confirm, dialog } = useConfirm();
  const [copyFeedback, setCopyFeedback] = useState<{
    ok: boolean;
    message: string;
  } | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [clientReady, setClientReady] = useState(false);
  useEffect(() => setClientReady(true), []);
  /* The dock carries one of two panes. Rendering the switch inside each pane's
     own header keeps the pane title and the control that replaces it on the
     same line, instead of stacking two rows of chrome above the content. */
  const dockSwitch = (
    <fieldset
      className="fb-dock-switch pc-plain-fieldset"
      aria-label="Inspector pane"
    >
      <button
        className="btn small"
        type="button"
        aria-pressed={!previewOpen}
        onClick={() => setPreviewOpen(false)}
      >
        Settings
      </button>
      <button
        className="btn small"
        type="button"
        aria-pressed={previewOpen}
        onClick={() => setPreviewOpen(true)}
      >
        Preview
      </button>
    </fieldset>
  );
  const publishedPublicSlug =
    loaderData.workspace?.publishedVersion?.settings.publicSlug;
  if (loaderData.workspace?.publishedVersion && !publishedPublicSlug) {
    throw new Error("The published form is missing its immutable public URL.");
  }
  const publicUrl = publishedPublicSlug
    ? `/apply/${publishedPublicSlug}`
    : null;
  const eventTimezone = loaderData.workspace?.eventTimezone ?? "UTC";
  const publishedCloseDate = loaderData.workspace?.publishedVersion
    ? closeDateFromEpoch(
        loaderData.workspace.publishedVersion.settings.closesAt ?? null,
        eventTimezone,
      )
    : null;
  const publishedClosingDateChanged = Boolean(
    loaderData.workspace?.publishedVersion &&
      input.closeDate !== publishedCloseDate,
  );
  return (
    <Form
      ref={formRef}
      id="form-builder"
      method="post"
      onSubmit={submitBuilder}
    >
      <input type="hidden" name="id" value={input.id ?? ""} />
      <input type="hidden" name="_clientReady" value={clientReady ? "1" : ""} />
      <input type="hidden" name="revision" value={input.revision ?? ""} />
      <input
        type="hidden"
        name="draftRevision"
        value={input.draftRevision ?? ""}
      />
      <input type="hidden" name="schema" value={JSON.stringify(input.schema)} />
      <input
        type="hidden"
        name="routing"
        value={JSON.stringify(input.routing)}
      />

      <div className="page-head">
        <div>
          <h1>Call for Speakers Form Builder</h1>
          <p>Design, test and publish immutable application versions.</p>
        </div>
        <div className="page-actions">
          <button
            className="btn"
            type="submit"
            name="_intent"
            value="save"
            disabled={!clientReady || navigationState !== "idle"}
          >
            {pendingIntent === "save" ? "Saving…" : "Save draft"}
          </button>
          <button
            className="btn primary"
            type="button"
            onClick={() => setPublishOpen(true)}
            disabled={
              !clientReady ||
              !input.id ||
              dirty ||
              loaderData.eventChoicesChanged ||
              navigationState !== "idle"
            }
          >
            {pendingIntent === "publish" ? "Publishing…" : "Publish version"}
          </button>
        </div>
      </div>

      {publishedClosingDateChanged ? (
        <div className="validation-item warn mb" role="status">
          <strong>The closing-date change is still a draft</strong>
          <span>
            The public application currently{" "}
            {publishedCloseDate
              ? `closes ${publishedCloseDate}`
              : "has no closing date"}
            . Save this draft, then publish the new version to make the{" "}
            {input.closeDate
              ? `${input.closeDate} closing date`
              : "removal of the closing date"}{" "}
            live.
          </span>
        </div>
      ) : null}

      {publishOpen ? (
        <Dialog
          title="Publish this application form version?"
          onClose={() => setPublishOpen(false)}
          footer={
            <>
              <button
                className="btn"
                type="button"
                onClick={() => setPublishOpen(false)}
              >
                Keep as draft
              </button>
              <button
                className="btn primary"
                type="submit"
                form="form-builder"
                name="_intent"
                value="publish"
                disabled={navigationState !== "idle"}
              >
                {pendingIntent === "publish"
                  ? "Publishing…"
                  : "Confirm publication"}
              </button>
            </>
          }
        >
          <p>
            <strong>{input.name}</strong> will immediately replace the current
            public application at <strong>{publicUrl}</strong>.
          </p>
          <ul>
            <li>{input.schema.fields.length} application fields.</li>
            <li>
              Speaker limits: {input.minSpeakers} minimum,{" "}
              {input.maxSpeakers ?? "no"} maximum.
            </li>
            <li>
              Access: {input.accessMode.replaceAll("_", " ")}
              {input.closeDate
                ? `; closes ${input.closeDate} (${eventTimezone})`
                : "; no close date"}
              .
            </li>
          </ul>
          <p className="help">
            The previous published version is retained in history. New
            applications will use this immutable version.
          </p>
        </Dialog>
      ) : null}

      {dialog}

      <DraftRecoveryFeedback recovery={recovery} />

      {clientValidationMessage && !clientValidationLocation ? (
        <div className="validation-item error card pad mb" role="alert">
          <strong>Form needs attention</strong>
          <span>{clientValidationMessage}</span>
        </div>
      ) : null}

      {loaderData.eventChoicesChanged ? (
        <div className="validation-item warn card pad mb" role="status">
          <strong>Event tracks or formats changed</strong>
          <span>
            This draft now shows the current event choices. Save the draft
            before publishing so the next immutable version carries them. If a
            condition used a removed choice, select that field and choose a
            current value or make it always visible before saving.
          </span>
        </div>
      ) : null}

      {actionData ? (
        <div
          className={`validation-item ${actionData.ok ? "ok" : "error"} card pad mb`}
          role={actionData.ok ? "status" : "alert"}
        >
          <strong>{actionData.ok ? "✓" : "△"}</strong>
          <span>{actionData.message}</span>
        </div>
      ) : null}
      {actionData?.conflict ? (
        <div className="validation-item error card pad mb" role="alert">
          <strong>Draft conflict</strong>
          <span>
            Your in-memory and browser recovery edits are intact. Export a copy
            before explicitly loading the newer server revision.
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
                const link = document.createElement("a");
                link.href = href;
                link.download = `${input.publicSlug || "form"}-recovery.json`;
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
                      "The editor contents and the browser recovery draft for this form are discarded and replaced by the newer server revision. Export your local edits first if you have not already.",
                    confirmLabel: "Discard and load server version",
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
      ) : null}
      {!input.id ? (
        <div className="validation-item warn card pad mb">
          <strong>Start here</strong>
          <span>Configure the form, then save it before publishing.</span>
        </div>
      ) : null}

      <div className="fb-toolbar">
        <label className="label fb-toolbar-form">
          Form
          <select
            className="select"
            value={input.id ?? "new"}
            onChange={(event) => {
              window.location.assign(
                event.target.value === "new"
                  ? "/admin/submissions/form?new=1"
                  : `/admin/submissions/form?form=${encodeURIComponent(event.target.value)}`,
              );
            }}
          >
            <option value="new">New form…</option>
            {loaderData.forms.map((form) => (
              <option key={form.id} value={form.id}>
                {form.name} · {form.kind.replace("_", " ")}
              </option>
            ))}
          </select>
        </label>
        <span className="fb-toolbar-state">
          {dirty ? (
            <span className="status warning">Unsaved changes</span>
          ) : input.id ? (
            <span className="status success">Draft saved</span>
          ) : (
            <span className="status warning">Not saved</span>
          )}
          <DraftRecoveryStatus state={recovery.state} />
        </span>
        {publicUrl ? (
          <span className="fb-toolbar-links">
            <Link
              className="btn small"
              to={publicUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open public form
              <span className="sr-only"> (opens in a new tab)</span>
            </Link>
            <button
              className="btn small"
              type="button"
              onClick={async () => {
                try {
                  if (!navigator.clipboard) {
                    throw new Error(
                      "Clipboard access is unavailable in this browser context.",
                    );
                  }
                  await navigator.clipboard.writeText(
                    new URL(publicUrl, window.location.origin).href,
                  );
                  setCopyFeedback({
                    ok: true,
                    message: "Public form link copied.",
                  });
                } catch (error) {
                  setCopyFeedback({
                    ok: false,
                    message:
                      error instanceof Error
                        ? error.message
                        : "The public form link could not be copied.",
                  });
                }
              }}
            >
              Copy public form link
            </button>
            {copyFeedback ? (
              <span
                className={copyFeedback.ok ? "help" : "field-error"}
                role={copyFeedback.ok ? "status" : "alert"}
              >
                {copyFeedback.message}
              </span>
            ) : null}
          </span>
        ) : null}
      </div>

      <div className={`fb-workbench${previewOpen ? " is-previewing" : ""}`}>
        <FormStructurePanel
          input={input}
          selectedId={selected?.id}
          draftVersionNumber={
            loaderData.workspace?.draftVersion.versionNumber ?? 1
          }
          change={change}
          onSelect={setSelectedId}
          operationMessage={
            clientValidationLocation === "structure"
              ? clientValidationMessage
              : null
          }
          onOperationBlocked={(message) =>
            reportClientValidation(message, "structure")
          }
        />

        <section className="card fb-pane fb-canvas">
          <div className="fb-pane-head">
            <h2>Form canvas</h2>
            <span className="help right">
              Changes update the draft immediately.
            </span>
          </div>
          <div className="fb-pane-body">
            <FormBuilderVisualCanvas
              input={input}
              selectedId={selected?.id}
              change={change}
              onSelect={setSelectedId}
              onOpenSettings={() => setPreviewOpen(false)}
              operationMessage={
                clientValidationLocation === "canvas"
                  ? clientValidationMessage
                  : null
              }
              onOperationBlocked={(message) =>
                reportClientValidation(message, "canvas")
              }
            />
            <p className="fb-pane-note mt">
              Drag fields from the palette into the form or drag existing fields
              to reorder them. Select a field to edit its settings; keyboard
              users can add from the palette and reorder in Form structure.
            </p>
            {!clientReady ? (
              <p className="fb-pane-note mt">
                JavaScript is required to edit or save this form.
              </p>
            ) : null}

            <h3 className="fb-subhead">Form settings</h3>
            <div className="fb-form-settings mb">
              <label className="label">
                <span className="pc-field-label">
                  <span>Form name</span>
                  <span className="pc-required" aria-hidden="true">Required</span>
                </span>
                <input
                  className="field"
                  name="name"
                  value={input.name}
                  onChange={(event) =>
                    change({ ...input, name: event.target.value })
                  }
                  required
                />
              </label>
              <DerivedSlugField
                source={input.name}
                value={input.publicSlug}
                onChange={(value) =>
                  change({ ...input, publicSlug: value })
                }
                name="publicSlug"
                label="Public URL slug"
                maximumLength={120}
                customMaximumLength={null}
                initiallyDerived={!input.id}
                resetKey={input.id ?? "new"}
                publicPathPrefix="/apply/"
              />
              <label className="label">
                Record type
                <select
                  className="select"
                  name="kind"
                  value={input.kind}
                  onChange={(event) => {
                    const kind = event.target.value as SaveFormInput["kind"];
                    change({
                      ...input,
                      kind,
                      schema: {
                        ...input.schema,
                        fields: input.schema.fields.map((field) =>
                          field.id === "category"
                            ? {
                                ...field,
                                type:
                                  kind === "direct_session"
                                    ? ("select" as const)
                                    : ("multi_select" as const),
                                help:
                                  kind === "direct_session"
                                    ? "Choose the programme track for this session."
                                    : "Choose every programme track this proposal should be reviewed for.",
                              }
                            : field,
                        ),
                      },
                    });
                  }}
                >
                  <option value="submission">Application for review</option>
                  <option value="direct_session">Direct session intake</option>
                </select>
              </label>
            </div>
            <PublicationSettingsFields
              input={input}
              passwordConfigured={loaderData.passwordConfigured}
              change={change}
              eventTimezone={eventTimezone}
            />
            <div className="mt">
              <PresentationSettingsPanel input={input} change={change} />
            </div>
          </div>
        </section>

        <div
          className={`card fb-pane fb-dock${previewOpen ? " is-previewing" : ""}`}
        >
          <FieldSettingsPanel
            input={input}
            selected={selected}
            categoryField={categoryField}
            change={change}
            patchField={patchField}
            setSelectedId={setSelectedId}
            routingTeams={loaderData.routingTeams}
            routingTracks={loaderData.routingTracks}
            paneSwitch={dockSwitch}
            hidden={previewOpen}
          />
          <ApplicantPreviewPanel
            input={input}
            brandAccent={loaderData.workspace?.brandAccent}
            eventName={loaderData.workspace?.eventName}
            paneSwitch={dockSwitch}
            hidden={!previewOpen}
            onClose={() => setPreviewOpen(false)}
          />
        </div>
      </div>

      {loaderData.workspace ? (
        <FormVersionHistory
          workspace={loaderData.workspace}
          eventTimezone={eventTimezone}
        />
      ) : null}
    </Form>
  );
}
