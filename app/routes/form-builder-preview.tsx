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

import type { Route } from "./+types/form-builder-preview";
import { Dialog } from "~/components/dialog";
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
import type {
  FormField,
  SaveFormInput,
} from "~/modules/submissions/submission-schema";
import { requireEventRole } from "~/platform/auth/authorize.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

export const meta: Route.MetaFunction = () => [
  { title: "Form Builder · Program Cue" },
];

type ActionResult = {
  ok: boolean;
  message: string;
  errors?: Record<string, string[]>;
};

async function viewerFor(
  request: Request,
  context: Route.LoaderArgs["context"],
) {
  const { env } = getCloudflareContext(context);
  if (!env.DEFAULT_EVENT_ID)
    throw new Response("DEFAULT_EVENT_ID is not configured", { status: 503 });
  return {
    env,
    viewer: await requireEventRole(request, env, env.DEFAULT_EVENT_ID, [
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
  const workspace = await service.getAdminWorkspace(
    viewer,
    requestedFormId ?? undefined,
  );
  if (requestedFormId !== null && !workspace) {
    throw new Response("Form not found", { status: 404 });
  }
  return {
    workspace,
    input: workspace
      ? SubmissionService.workspaceToInput(workspace)
      : await service.getDefaultFormInput(viewer),
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
        `/admin/submissions/form?form=${encodeURIComponent(savedId)}`,
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
        { ok: false, message: error.message },
        { status: 409 },
      );
    }
    if (error instanceof Response) throw error;
    throw error;
  }
}

export default function FormBuilder({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>() as ActionResult | undefined;
  const navigation = useNavigation();
  const [input, setInput] = useState<SaveFormInput>(loaderData.input);
  const [selectedId, setSelectedId] = useState(
    input.schema.fields[0]?.id ?? "",
  );
  const [dirty, setDirty] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const selected =
    input.schema.fields.find((field) => field.id === selectedId) ??
    input.schema.fields[0];
  const categoryField = input.schema.fields.find(
    (field) => field.id === "category",
  );

  useEffect(() => {
    setInput(loaderData.input);
    setSelectedId(loaderData.input.schema.fields[0]?.id ?? "");
    setDirty(false);
  }, [loaderData.input]);
  useEffect(() => {
    if (actionData?.ok) {
      setDirty(false);
      setPublishOpen(false);
    }
  }, [actionData]);

  const publicUrl = useMemo(
    () => `/apply/${input.publicSlug}`,
    [input.publicSlug],
  );
  const eventTimezone = loaderData.workspace?.eventTimezone ?? "UTC";
  const pendingIntent = navigation.formData?.get("_intent");

  function change(next: SaveFormInput) {
    setInput(next);
    setDirty(true);
  }

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
    <Form id="form-builder" method="post" onChange={() => setDirty(true)}>
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
          {dirty ? (
            <span className="status warning">Unsaved changes</span>
          ) : input.id ? (
            <span className="status success">Draft saved</span>
          ) : (
            <span className="status warning">Not saved</span>
          )}
          {loaderData.workspace?.publishedVersion ? (
            <Link
              className="btn"
              to={publicUrl}
              target="_blank"
              rel="noreferrer"
            >
              Open public form
            </Link>
          ) : null}
          <button
            className="btn"
            type="submit"
            name="_intent"
            value="save"
            disabled={navigation.state !== "idle"}
          >
            {pendingIntent === "save" ? "Saving…" : "Save draft"}
          </button>
          <button
            className="btn primary"
            type="button"
            onClick={() => setPublishOpen(true)}
            disabled={!input.id || dirty || navigation.state !== "idle"}
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
                disabled={navigation.state !== "idle"}
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

      {actionData ? (
        <div
          className={`validation-item ${actionData.ok ? "ok" : "error"} card pad mb`}
          role={actionData.ok ? "status" : "alert"}
        >
          <strong>{actionData.ok ? "✓" : "△"}</strong>
          <span>{actionData.message}</span>
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

      <div className="builder-layout">
        <FieldLibraryPanel
          input={input}
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
