import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  useForm,
  useWatch,
  type FieldErrors,
  type Resolver,
} from "react-hook-form";
import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useNavigation,
  useSubmit,
} from "react-router";
import { ZodError } from "zod";

import type { Route } from "./+types/form-builder-preview";
import { Dialog } from "~/components/dialog";
import {
  DraftRecoveryFeedback,
  DraftRecoveryStatus,
} from "~/components/draft-recovery-feedback";
import FormJsVisualEditor, {
  type FormJsEditorStatus,
} from "~/components/form-js-visual-editor";
import {
  ApplicantPreviewPanel,
  FieldLibraryPanel,
  FieldSettingsPanel,
  FormStructurePanel,
  FormVersionHistory,
} from "~/components/form-builder-panels";
import { ensureDemoSubmissionForm } from "~/modules/submissions/demo-submissions.server";
import { SubmissionService } from "~/modules/submissions/submission-service.server";
import {
  SubmissionRevisionConflictError,
  SubmissionStateError,
} from "~/modules/submissions/submission-repository.server";
import {
  saveFormSchema,
  type SubmissionFormSchema,
  type FormField,
  type SaveFormInput,
} from "~/modules/submissions/submission-schema";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  clearDraftRecoveryScope,
  useDraftRecovery,
} from "~/platform/drafts/draft-recovery";

export const meta: Route.MetaFunction = () => [
  { title: "Form Builder · Program Cue" },
];

type ActionResult = {
  ok: boolean;
  message: string;
  errors?: Record<string, string[]>;
  conflict?: boolean;
};

const formBuilderResolver: Resolver<SaveFormInput> = async (values) => {
  const parsed = saveFormSchema.safeParse(values);
  if (parsed.success) return { values: parsed.data, errors: {} };

  const errors: FieldErrors<SaveFormInput> = {};
  for (const issue of parsed.error.issues) {
    const field = issue.path[0];
    if (typeof field !== "string" || field in errors) continue;
    Object.assign(errors, {
      [field]: { type: "zod", message: issue.message },
    });
  }
  return { values: {}, errors };
};

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
  const [workspace, forms, routingTeams, routingTracks] = await Promise.all([
    creating
      ? Promise.resolve(null)
      : service.getAdminWorkspace(viewer, requestedFormId ?? undefined),
    service.listAdminForms(viewer),
    service.listRoutingTeams(viewer),
    service.listRoutingTracks(viewer),
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
  const input = workspace
    ? SubmissionService.synchronizeFormTrackChoices(
        SubmissionService.workspaceToInput(workspace),
        routingTracks,
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
  };
}

class InvalidFormPayloadError extends Error {}

function jsonValue(formData: FormData, key: string) {
  try {
    return JSON.parse(String(formData.get(key) ?? ""));
  } catch {
    throw new InvalidFormPayloadError(`${key} contains invalid JSON`);
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env, viewer } = await viewerFor(request, context);
  const service = new SubmissionService(env);
  const formData = await request.formData();
  const intent = String(formData.get("_intent") ?? "");
  if (intent !== "save" && intent !== "publish") {
    return data<ActionResult>(
      { ok: false, message: "Unsupported form action." },
      { status: 400 },
    );
  }
  try {
    if (intent === "publish") {
      const id = String(formData.get("id") ?? "");
      if (!id) {
        return data<ActionResult>(
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
      return data<ActionResult>({
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
    return data<ActionResult>({ ok: true, message: "Draft form saved to D1." });
  } catch (error) {
    if (error instanceof ZodError) {
      return data<ActionResult>(
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
      return data<ActionResult>(
        { ok: false, message: error.message },
        { status: 400 },
      );
    }
    if (
      error instanceof SubmissionRevisionConflictError ||
      error instanceof SubmissionStateError
    ) {
      return data<ActionResult>(
        { ok: false, message: error.message, conflict: true },
        { status: 409 },
      );
    }
    if (error instanceof Response) throw error;
    throw error;
  }
}

export default function FormBuilder({ loaderData }: Route.ComponentProps) {
  const formRef = useRef<HTMLFormElement>(null);
  const actionData = useActionData<typeof action>() as ActionResult | undefined;
  const navigation = useNavigation();
  const submit = useSubmit();
  const {
    control,
    getValues,
    handleSubmit,
    reset,
    setValue,
    formState: { isDirty: dirty },
  } = useForm<SaveFormInput>({
    defaultValues: loaderData.input,
    resolver: formBuilderResolver,
    mode: "onChange",
  });
  const input = useWatch({
    control,
    defaultValue: loaderData.input,
  }) as SaveFormInput;
  const [selectedId, setSelectedId] = useState(
    loaderData.input.schema.fields[0]?.id ?? "",
  );
  const [publishOpen, setPublishOpen] = useState(false);
  const [clientValidationMessage, setClientValidationMessage] = useState<
    string | null
  >(null);
  const [editorStatus, setEditorStatus] = useState<FormJsEditorStatus>({
    state: "loading",
    message: "Loading the visual form editor…",
  });
  const recoveryPayload = useMemo(() => {
    const { accessPassword: _sensitivePassword, ...recoverable } = input;
    return recoverable;
  }, [input]);
  const restoreDraft = useCallback(
    (recoverable: typeof recoveryPayload) => {
      const restored = { ...recoverable, accessPassword: "" } as SaveFormInput;
      reset(restored, { keepDefaultValues: true });
      setSelectedId(restored.schema.fields[0]?.id ?? "");
    },
    [reset],
  );
  const recovery = useDraftRecovery({
    scope: {
      ...loaderData.recoveryScope,
      recordType: "submission_form",
      recordId: input.id ?? "new",
    },
    serverRevision: `${input.revision ?? 0}:${input.draftRevision ?? 0}`,
    payload: recoveryPayload,
    dirty,
    onRestore: restoreDraft,
  });
  const selected =
    input.schema.fields.find((field) => field.id === selectedId) ??
    input.schema.fields[0];
  const categoryField = input.schema.fields.find(
    (field) => field.id === "category",
  );

  useEffect(() => {
    reset(loaderData.input);
    setSelectedId(loaderData.input.schema.fields[0]?.id ?? "");
    setClientValidationMessage(null);
  }, [loaderData.input, reset]);
  useEffect(() => {
    if (actionData?.ok) {
      reset(getValues());
      setPublishOpen(false);
      setClientValidationMessage(null);
      void recovery.markServerSaved();
    }
  }, [actionData, getValues, recovery.markServerSaved, reset]);
  useEffect(() => {
    if (!loaderData.createdFromLocalDraft) return;
    void clearDraftRecoveryScope({
      ...loaderData.recoveryScope,
      recordType: "submission_form",
      recordId: "new",
    });
  }, [loaderData.createdFromLocalDraft, loaderData.recoveryScope]);

  const publicUrl = useMemo(
    () => `/apply/${input.publicSlug}`,
    [input.publicSlug],
  );
  const eventTimezone = loaderData.workspace?.eventTimezone ?? "UTC";
  const pendingIntent = navigation.formData?.get("_intent");
  const editorReady = editorStatus.state === "ready";

  function change(next: SaveFormInput) {
    const options = { shouldDirty: true, shouldValidate: false } as const;
    if (next.id !== input.id) setValue("id", next.id, options);
    if (next.revision !== input.revision)
      setValue("revision", next.revision, options);
    if (next.draftRevision !== input.draftRevision)
      setValue("draftRevision", next.draftRevision, options);
    if (next.name !== input.name) setValue("name", next.name, options);
    if (next.kind !== input.kind) setValue("kind", next.kind, options);
    if (next.publicSlug !== input.publicSlug)
      setValue("publicSlug", next.publicSlug, options);
    if (next.closeDate !== input.closeDate)
      setValue("closeDate", next.closeDate, options);
    if (next.submissionLimit !== input.submissionLimit)
      setValue("submissionLimit", next.submissionLimit, options);
    if (next.minSpeakers !== input.minSpeakers)
      setValue("minSpeakers", next.minSpeakers, options);
    if (next.maxSpeakers !== input.maxSpeakers)
      setValue("maxSpeakers", next.maxSpeakers, options);
    if (next.accessMode !== input.accessMode)
      setValue("accessMode", next.accessMode, options);
    if (next.accessPassword !== input.accessPassword)
      setValue("accessPassword", next.accessPassword, options);
    if (next.schema !== input.schema) setValue("schema", next.schema, options);
    if (next.routing !== input.routing)
      setValue("routing", next.routing, options);
    setClientValidationMessage(null);
  }

  function changeVisualSchema(schema: SubmissionFormSchema) {
    change({ ...input, schema });
    if (!schema.fields.some((field) => field.id === selectedId)) {
      setSelectedId(schema.fields[0]?.id ?? "");
    }
  }

  const submitBuilder = handleSubmit(
    (_values, event) => {
      if (!editorReady) {
        setClientValidationMessage(
          "The visual editor must be ready and valid before this draft can be saved or published.",
        );
        return;
      }
      const form = formRef.current;
      if (!form) {
        setClientValidationMessage(
          "The form submission target is unavailable.",
        );
        return;
      }
      const formData = new FormData(form);
      const submitter = (event?.nativeEvent as SubmitEvent | undefined)
        ?.submitter;
      if (
        submitter instanceof HTMLButtonElement &&
        submitter.name &&
        submitter.value
      ) {
        formData.set(submitter.name, submitter.value);
      }
      submit(formData, { method: "post" });
    },
    () => {
      const parsed = saveFormSchema.safeParse(input);
      setClientValidationMessage(
        parsed.success
          ? "Review the form settings before continuing."
          : (parsed.error.issues[0]?.message ??
              "Review the form settings before continuing."),
      );
    },
  );

  function patchField(patch: Partial<FormField>) {
    if (!selected) return;
    change({
      ...input,
      schema: {
        ...input.schema,
        fields: input.schema.fields.map((field) =>
          field.id === selected.id ? { ...field, ...patch } : field,
        ),
      },
    });
  }

  function moveField(direction: -1 | 1) {
    if (!selected) return;
    const index = input.schema.fields.findIndex(
      (field) => field.id === selected.id,
    );
    const target = index + direction;
    if (target < 0 || target >= input.schema.fields.length) return;
    const fields = [...input.schema.fields];
    [fields[index], fields[target]] = [fields[target], fields[index]];
    change({ ...input, schema: { ...input.schema, fields } });
  }

  return (
    <Form
      ref={formRef}
      id="form-builder"
      method="post"
      onSubmit={submitBuilder}
    >
      <input type="hidden" name="id" value={input.id ?? ""} />
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
          <label className="label" style={{ minWidth: 220 }}>
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
          {dirty ? (
            <span className="status warning">Unsaved changes</span>
          ) : input.id ? (
            <span className="status success">Draft saved</span>
          ) : (
            <span className="status warning">Not saved</span>
          )}
          <DraftRecoveryStatus state={recovery.state} />
          {loaderData.workspace?.publishedVersion ? (
            <Link
              className="btn"
              to={publicUrl}
              target="_blank"
              rel="noopener noreferrer"
            >
              Open public form
              <span className="sr-only"> (opens in a new tab)</span>
            </Link>
          ) : null}
          <button
            className="btn"
            type="submit"
            name="_intent"
            value="save"
            disabled={navigation.state !== "idle" || !editorReady}
          >
            {pendingIntent === "save" ? "Saving…" : "Save draft"}
          </button>
          <button
            className="btn primary"
            type="button"
            onClick={() => setPublishOpen(true)}
            disabled={
              !input.id || dirty || navigation.state !== "idle" || !editorReady
            }
          >
            {pendingIntent === "publish" ? "Publishing…" : "Publish version"}
          </button>
        </div>
      </div>

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
                disabled={navigation.state !== "idle" || !editorReady}
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

      <DraftRecoveryFeedback recovery={recovery} />

      {clientValidationMessage ? (
        <div className="validation-item error card pad mb" role="alert">
          <strong>Form not ready</strong>
          <span>{clientValidationMessage}</span>
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
      {!input.id ? (
        <div className="validation-item warn card pad mb">
          <strong>Start here</strong>
          <span>Configure the form, then save it before publishing.</span>
        </div>
      ) : null}

      <div className="grid grid-3 mb">
        <label className="label">
          Form name
          <input
            className="field"
            name="name"
            value={input.name}
            onChange={(event) => change({ ...input, name: event.target.value })}
            required
          />
        </label>
        <label className="label">
          Public URL
          <div style={{ display: "flex", alignItems: "center" }}>
            <span
              className="field"
              style={{
                borderRight: 0,
                borderRadius: "8px 0 0 8px",
                color: "var(--muted)",
              }}
            >
              /apply/
            </span>
            <input
              className="field"
              name="publicSlug"
              value={input.publicSlug}
              onChange={(event) =>
                change({ ...input, publicSlug: event.target.value })
              }
              style={{ borderRadius: "0 8px 8px 0" }}
              required
            />
          </div>
        </label>
        <label className="label">
          Record type
          <select
            className="select"
            name="kind"
            value={input.kind}
            onChange={(event) =>
              change({
                ...input,
                kind: event.target.value as SaveFormInput["kind"],
              })
            }
          >
            <option value="submission">Application for review</option>
            <option value="direct_session">Direct session intake</option>
          </select>
        </label>
      </div>

      <section className="card pad mb form-js-editor-card">
        <div className="card-title">
          <div>
            <h2>Visual form editor</h2>
            <p className="help">
              Drag and edit supported fields here. Program Cue maps this canvas
              to its normalized, versioned schema; D1 remains authoritative.
            </p>
          </div>
          <span className="pill right">Powered by bpmn.io</span>
        </div>
        {editorStatus.state === "error" ? (
          <div className="validation-item error mb" role="alert">
            <strong>Visual adapter blocked</strong>
            <span>{editorStatus.message}</span>
          </div>
        ) : (
          <p className="help" aria-live="polite">
            {editorStatus.message}
          </p>
        )}
        <p className="help">
          Supported visual fields are short text, long text, static single or
          multiple choice, conference URL and conference video. Conditions must
          use the Program Cue equality form shown in Field settings. Unsupported
          FEEL, dynamic options and multi-column layouts block saving instead of
          being discarded.
        </p>
        <p
          className="help form-js-scroll-hint"
          id="visual-form-editor-scroll-help"
        >
          On a narrow screen, swipe horizontally within the editor to reach the
          form canvas and field settings.
        </p>
        <FormJsVisualEditor
          schema={input.schema}
          onChange={changeVisualSchema}
          onStatus={setEditorStatus}
          ariaDescribedBy="visual-form-editor-scroll-help"
        />
        <noscript>
          The visual form editor requires JavaScript. Saving is unavailable
          until the adapter can validate the visual schema.
        </noscript>
      </section>

      <div className="builder-layout">
        <FieldLibraryPanel
          input={input}
          passwordConfigured={loaderData.passwordConfigured}
          change={change}
          onSelect={setSelectedId}
        />
        <FormStructurePanel
          input={input}
          selectedId={selected?.id}
          draftVersionNumber={
            loaderData.workspace?.draftVersion.versionNumber ?? 1
          }
          change={change}
          onSelect={setSelectedId}
        />
        <FieldSettingsPanel
          input={input}
          selected={selected}
          categoryField={categoryField}
          change={change}
          patchField={patchField}
          moveField={moveField}
          setSelectedId={setSelectedId}
          routingTeams={loaderData.routingTeams}
          routingTracks={loaderData.routingTracks}
        />
        <ApplicantPreviewPanel
          input={input}
          brandAccent={loaderData.workspace?.brandAccent}
          eventName={loaderData.workspace?.eventName}
        />
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
