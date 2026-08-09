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

const FIELD_TYPES: Array<{ value: FormField["type"]; label: string }> = [
  { value: "short_text", label: "Short text" },
  { value: "long_text", label: "Long text" },
  { value: "select", label: "Dropdown" },
  { value: "multi_select", label: "Multiple choice" },
  { value: "url", label: "URL" },
];

function newField(type: FormField["type"], index: number): FormField {
  return {
    id: `field_${index + 1}`,
    label: FIELD_TYPES.find((item) => item.value === type)?.label ?? "Question",
    type,
    required: false,
    help: "",
    options:
      type === "select" || type === "multi_select"
        ? ["Option 1", "Option 2"]
        : [],
    reviewVisibility: "administrators_only",
    condition: null,
  };
}

function nextFieldIndex(fields: FormField[]) {
  const ids = new Set(fields.map((field) => field.id));
  let index = fields.length + 1;
  while (ids.has(`field_${index}`)) index += 1;
  return index - 1;
}

function publishedLabel(epoch: number, timezone: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(new Date(epoch * 1_000));
}

function FieldPreview({ field }: { field: FormField }) {
  if (field.type === "long_text")
    return <textarea className="textarea" disabled />;
  if (field.type === "select")
    return (
      <select className="select" disabled>
        <option>{field.options[0] ?? "Choose…"}</option>
      </select>
    );
  if (field.type === "multi_select")
    return (
      <div className="stack">
        {field.options.slice(0, 3).map((option) => (
          <label key={option}>
            <input type="checkbox" disabled /> {option}
          </label>
        ))}
      </div>
    );
  return (
    <input
      className="field"
      type={field.type === "url" ? "url" : "text"}
      disabled
    />
  );
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
        <section className="card builder-panel">
          <div className="card-title">
            <h2>Field library</h2>
          </div>
          <div className="field-library">
            {FIELD_TYPES.map((fieldType) => (
              <button
                className="field-option"
                type="button"
                key={fieldType.value}
                onClick={() => {
                  const field = newField(
                    fieldType.value,
                    nextFieldIndex(input.schema.fields),
                  );
                  change({
                    ...input,
                    schema: {
                      ...input.schema,
                      fields: [...input.schema.fields, field],
                    },
                  });
                  setSelectedId(field.id);
                }}
              >
                <span>＋</span>
                {fieldType.label}
              </button>
            ))}
          </div>
          <div className="divider" />
          <h3>Publication settings</h3>
          <label className="label mt">
            Closing date
            <input
              className="field"
              name="closeDate"
              type="date"
              value={input.closeDate ?? ""}
              onChange={(event) =>
                change({ ...input, closeDate: event.target.value || null })
              }
            />
          </label>
          <label className="label mt">
            Overall limit
            <input
              className="field"
              name="submissionLimit"
              type="number"
              min={1}
              value={input.submissionLimit ?? ""}
              onChange={(event) =>
                change({
                  ...input,
                  submissionLimit: event.target.value
                    ? Number(event.target.value)
                    : null,
                })
              }
              placeholder="No limit"
            />
          </label>
          <div className="form-row mt">
            <label className="label">
              Min speakers
              <input
                className="field"
                name="minSpeakers"
                type="number"
                min={1}
                max={20}
                value={input.minSpeakers}
                onChange={(event) =>
                  change({ ...input, minSpeakers: Number(event.target.value) })
                }
              />
            </label>
            <label className="label">
              Max speakers
              <input
                className="field"
                name="maxSpeakers"
                type="number"
                min={1}
                max={20}
                value={input.maxSpeakers ?? ""}
                onChange={(event) =>
                  change({
                    ...input,
                    maxSpeakers: event.target.value
                      ? Number(event.target.value)
                      : null,
                  })
                }
              />
            </label>
          </div>
          <label className="label mt">
            Applicant access
            <select
              className="select"
              name="accessMode"
              value={input.accessMode}
              onChange={(event) =>
                change({
                  ...input,
                  accessMode: event.target.value as SaveFormInput["accessMode"],
                })
              }
            >
              <option value="email_verified">Verified email</option>
              <option value="account_required">Program Cue account</option>
              <option value="password_protected">
                Form password + verified email
              </option>
            </select>
          </label>
          {input.accessMode === "password_protected" ? (
            <label className="label mt">
              {input.routing.passwordHash
                ? "Replace form password"
                : "Form password"}
              <input
                className="field"
                name="accessPassword"
                type="password"
                minLength={8}
                placeholder={
                  input.routing.passwordHash
                    ? "Leave blank to keep current"
                    : "At least 8 characters"
                }
              />
            </label>
          ) : (
            <input type="hidden" name="accessPassword" value="" />
          )}
        </section>

        <section className="card builder-panel">
          <div className="card-title">
            <h2>Form structure</h2>
            <span className="status info right">
              Draft v{loaderData.workspace?.draftVersion.versionNumber ?? 1}
            </span>
          </div>
          <label className="label mb">
            Introduction
            <textarea
              className="textarea"
              value={input.schema.introduction}
              onChange={(event) =>
                change({
                  ...input,
                  schema: { ...input.schema, introduction: event.target.value },
                })
              }
            />
          </label>
          <div className="form-canvas">
            {input.schema.fields.map((field, index) => (
              <button
                className={`form-field-card${field.id === selected?.id ? " selected" : ""}`}
                type="button"
                key={field.id}
                onClick={() => setSelectedId(field.id)}
                style={{ width: "100%", textAlign: "left" }}
              >
                <span className="drag-handle">⠿</span>
                <span>
                  <strong>{field.label}</strong>
                  {field.required ? " *" : ""}
                  <small className="subtle" style={{ display: "block" }}>
                    {
                      FIELD_TYPES.find((type) => type.value === field.type)
                        ?.label
                    }
                  </small>
                  {field.condition ? (
                    <span className="conditional-note">
                      Shown when {field.condition.fieldId} ={" "}
                      {field.condition.equals}
                    </span>
                  ) : null}
                </span>
                <span>{index + 1}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="card builder-panel settings-panel">
          <div className="card-title">
            <h2>Field settings</h2>
            {selected ? (
              <span className="pill right">
                {selected.type.replace("_", " ")}
              </span>
            ) : null}
          </div>
          {selected ? (
            <>
              <label className="label">
                Stable field ID
                <input
                  className="field"
                  value={selected.id}
                  onChange={(event) => {
                    const oldId = selected.id;
                    const nextId = event.target.value;
                    setSelectedId(nextId);
                    change({
                      ...input,
                      schema: {
                        ...input.schema,
                        fields: input.schema.fields.map((field) => ({
                          ...field,
                          id: field.id === oldId ? nextId : field.id,
                          condition:
                            field.condition?.fieldId === oldId
                              ? { ...field.condition, fieldId: nextId }
                              : field.condition,
                        })),
                      },
                    });
                  }}
                />
              </label>
              <label className="label mt">
                Label
                <input
                  className="field"
                  value={selected.label}
                  onChange={(event) =>
                    patchField({ label: event.target.value })
                  }
                />
              </label>
              <label className="label mt">
                Help text
                <textarea
                  className="textarea"
                  value={selected.help}
                  onChange={(event) => patchField({ help: event.target.value })}
                />
              </label>
              {selected.type === "select" ||
              selected.type === "multi_select" ? (
                <label className="label mt">
                  Options, one per line
                  <textarea
                    className="textarea"
                    value={selected.options.join("\n")}
                    onChange={(event) =>
                      patchField({
                        options: event.target.value
                          .split("\n")
                          .map((value) => value.trim())
                          .filter(Boolean),
                      })
                    }
                  />
                </label>
              ) : null}
              <label className="label mt">
                Blinded-review visibility
                <select
                  className="select"
                  value={selected.reviewVisibility ?? "administrators_only"}
                  onChange={(event) =>
                    patchField({
                      reviewVisibility: event.target
                        .value as FormField["reviewVisibility"],
                    })
                  }
                >
                  <option value="reviewers">Show answer to reviewers</option>
                  <option value="administrators_only">
                    Hide answer from reviewers
                  </option>
                </select>
                <span className="help">
                  Keep identity and biography answers hidden. This setting
                  applies only when blinded reviewing is enabled.
                </span>
              </label>
              <label className="toggle mt">
                <input
                  type="checkbox"
                  checked={selected.required}
                  onChange={(event) =>
                    patchField({ required: event.target.checked })
                  }
                />{" "}
                Required when visible
              </label>
              <div className="divider" />
              <h3>Conditional logic</h3>
              <label className="label mt">
                Show this field when
                <select
                  className="select"
                  value={selected.condition?.fieldId ?? ""}
                  onChange={(event) =>
                    patchField({
                      condition: event.target.value
                        ? { fieldId: event.target.value, equals: "" }
                        : null,
                    })
                  }
                >
                  <option value="">Always visible</option>
                  {input.schema.fields
                    .slice(
                      0,
                      input.schema.fields.findIndex(
                        (field) => field.id === selected.id,
                      ),
                    )
                    .filter((field) => field.type === "select")
                    .map((field) => (
                      <option value={field.id} key={field.id}>
                        {field.label}
                      </option>
                    ))}
                </select>
              </label>
              {selected.condition ? (
                <label className="label mt">
                  Equals
                  <select
                    className="select"
                    value={selected.condition.equals}
                    onChange={(event) =>
                      patchField({
                        condition: {
                          ...selected.condition!,
                          equals: event.target.value,
                        },
                      })
                    }
                  >
                    <option value="">Choose…</option>
                    {input.schema.fields
                      .find((field) => field.id === selected.condition?.fieldId)
                      ?.options.map((option) => (
                        <option key={option}>{option}</option>
                      ))}
                  </select>
                </label>
              ) : null}
              <div className="page-actions mt">
                <button
                  className="btn small"
                  type="button"
                  onClick={() => moveField(-1)}
                >
                  Move up
                </button>
                <button
                  className="btn small"
                  type="button"
                  onClick={() => moveField(1)}
                >
                  Move down
                </button>
                {!["title", "category", "format"].includes(selected.id) ? (
                  <button
                    className="btn small danger"
                    type="button"
                    onClick={() => {
                      const fields = input.schema.fields
                        .filter((field) => field.id !== selected.id)
                        .map((field) =>
                          field.condition?.fieldId === selected.id
                            ? { ...field, condition: null }
                            : field,
                        );
                      change({ ...input, schema: { ...input.schema, fields } });
                      setSelectedId(fields[0]?.id ?? "");
                    }}
                  >
                    Remove
                  </button>
                ) : null}
              </div>
            </>
          ) : (
            <p className="subtle">Select a field to configure it.</p>
          )}
          <div className="divider" />
          <h3>Category routing</h3>
          {categoryField?.options.map((category) => (
            <label className="label mt" key={category}>
              {category}
              <input
                className="field"
                value={input.routing.categories[category] ?? ""}
                onChange={(event) =>
                  change({
                    ...input,
                    routing: {
                      ...input.routing,
                      categories: {
                        ...input.routing.categories,
                        [category]: event.target.value,
                      },
                    },
                  })
                }
                placeholder="Committee or owner"
              />
            </label>
          ))}
        </section>

        <section className="card builder-panel preview-panel">
          <div className="card-title">
            <h2>Live applicant preview</h2>
            <span className="status info right">Structure preview</span>
          </div>
          <div className="phone">
            <div
              className="phone-head"
              style={{
                background: `linear-gradient(135deg,#111b3f,${loaderData.workspace?.brandAccent ?? "#4f46e5"})`,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="brand-mark small">P</span>
                <strong>Program Cue</strong>
              </div>
              <h3>{input.name}</h3>
              <small>{loaderData.workspace?.eventName ?? "Your event"}</small>
            </div>
            <div className="phone-body">
              <p className="tiny subtle">{input.schema.introduction}</p>
              {input.schema.fields.slice(0, 6).map((field) => (
                <label className="label" key={field.id}>
                  {field.label}
                  {field.required ? " *" : ""}
                  {field.help ? (
                    <span className="help">{field.help}</span>
                  ) : null}
                  <FieldPreview field={field} />
                </label>
              ))}
              <button className="btn primary" type="button" disabled>
                Preview only
              </button>
            </div>
          </div>
        </section>
      </div>

      {loaderData.workspace ? (
        <section className="card pad mt">
          <div className="card-title">
            <h2>Version history</h2>
            <span className="subtle right">
              Published submissions retain their original form version.
            </span>
          </div>
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Status</th>
                  <th>Published ({eventTimezone})</th>
                </tr>
              </thead>
              <tbody>
                {loaderData.workspace.versions.map((version) => (
                  <tr key={version.id}>
                    <td>
                      <strong>v{version.versionNumber}</strong>
                    </td>
                    <td>
                      <span
                        className={`status ${version.status === "published" ? "success" : version.status === "draft" ? "info" : "neutral"}`}
                      >
                        {version.status}
                      </span>
                    </td>
                    <td>
                      {version.publishedAt
                        ? publishedLabel(version.publishedAt, eventTimezone)
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}
    </Form>
  );
}
