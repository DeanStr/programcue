import { ArchiveRestore, Download, Files, ShieldCheck } from "lucide-react";
import { data, Form, Link, useActionData, useNavigation } from "react-router";
import { ZodError } from "zod";

import type { Route } from "./+types/admin-content";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import {
  ContentManagementService,
  ContentManagementStateError,
} from "~/modules/content/content-management-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

async function administrator(
  request: Request,
  context: Route.LoaderArgs["context"],
) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  return { env, viewer };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, viewer } = await administrator(request, context);
  return new ContentManagementService(env).getDashboard(viewer);
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    throw new Response("Method not allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }
  const { env, viewer } = await administrator(request, context);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const service = new ContentManagementService(env);
  try {
    if (intent === "preview-zip") {
      const preview = await service.previewZip(viewer, {
        assetIds: form.getAll("assetId"),
        groupBy: form.get("groupBy"),
      });
      return data({ ok: true as const, preview });
    }
    if (intent === "download-zip") {
      return service.downloadZip(viewer, {
        manifest: form.get("manifest"),
        groupBy: form.get("groupBy"),
        confirmed: form.get("confirmed"),
      });
    }
    return data(
      { ok: false as const, message: "Unsupported content-library action." },
      { status: 400 },
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return data(
        {
          ok: false as const,
          message:
            error.issues[0]?.message ?? "Review the selected file export.",
        },
        { status: 422 },
      );
    }
    if (error instanceof ContentManagementStateError) {
      return data(
        { ok: false as const, message: error.message },
        { status: error.status },
      );
    }
    throw error;
  }
}

export const meta = () => [{ title: "Content & files · Program Cue" }];

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function AdminContent({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const statusCounts = Object.fromEntries(
    ["draft", "in_review", "approved", "changes_requested"].map((status) => [
      status,
      loaderData.sessions.filter((session) => session.contentStatus === status)
        .length,
    ]),
  );
  return (
    <>
      <div className="page-head pc-page-header">
        <div>
          <span className="pc-page-eyebrow">Review · approve · deliver</span>
          <h1>Content &amp; files</h1>
          <p>
            Review session copy, restore attributed revisions and collect
            released speaker deliverables without duplicating private storage.
          </p>
        </div>
        <div className="page-actions">
          <Link className="btn" to="/admin/schedule">
            Schedule editor
          </Link>
          <Link className="btn" to="/admin/tasks">
            Deliverable tasks
          </Link>
        </div>
      </div>

      {actionData && !actionData.ok ? (
        <div className="validation-item error card pad mb" role="alert">
          <strong>File export blocked</strong>
          <span>{actionData.message}</span>
        </div>
      ) : null}

      <section className="card pad mb" aria-labelledby="content-review-title">
        <div className="card-title">
          <div>
            <span className="pc-section-kicker">Current schedule version</span>
            <h2 id="content-review-title">Session content review</h2>
          </div>
          {loaderData.version ? (
            <span className="pill">
              Version {loaderData.version.versionNumber} ·{" "}
              {loaderData.version.status}
            </span>
          ) : null}
        </div>
        <div className="summary-grid mb">
          <article className="metric-card">
            <strong>{statusCounts.approved}</strong>
            <span>Approved</span>
          </article>
          <article className="metric-card">
            <strong>{statusCounts.in_review}</strong>
            <span>In review</span>
          </article>
          <article className="metric-card">
            <strong>{statusCounts.changes_requested}</strong>
            <span>Changes requested</span>
          </article>
          <article className="metric-card">
            <strong>{statusCounts.draft}</strong>
            <span>Draft</span>
          </article>
        </div>
        {loaderData.sessions.length ? (
          <div className="stack">
            {loaderData.sessions.map((session) => (
              <article className="list-row" key={session.sessionId}>
                <div>
                  <strong>{session.title}</strong>
                  <small className="subtle">
                    {session.speakerNames.join(", ") || "No linked speaker"} ·{" "}
                    {session.scheduled ? "Scheduled" : "Unscheduled"} · revision{" "}
                    {session.contentRevision}
                  </small>
                </div>
                <span className="row-actions right">
                  <DomainStatusBadge
                    domain="content"
                    status={session.contentStatus}
                  />
                  <Link
                    className="btn small"
                    to={`/admin/content/sessions/${encodeURIComponent(session.sessionId)}`}
                  >
                    Review history
                  </Link>
                </span>
              </article>
            ))}
          </div>
        ) : (
          <div className="pc-empty-state">
            <ShieldCheck aria-hidden className="pc-state-icon" />
            <h3>No session content yet</h3>
            <p className="subtle">
              Create sessions and a schedule version before reviewing content.
            </p>
          </div>
        )}
      </section>

      <section className="card pad" aria-labelledby="content-files-title">
        <div className="card-title">
          <div>
            <span className="pc-section-kicker">Private R2 inventory</span>
            <h2 id="content-files-title">Central files library</h2>
          </div>
          <span className="pill">{loaderData.files.length} assets</span>
        </div>
        <p className="help mb">
          Quarantined and historical metadata remains visible. Downloads and ZIP
          exports include only current released, signature-valid and clean
          versions.
        </p>
        {loaderData.files.length ? (
          <Form method="post" className="stack">
            <input type="hidden" name="intent" value="preview-zip" />
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Select</th>
                    <th scope="col">File</th>
                    <th scope="col">Session / speaker</th>
                    <th scope="col">Versions</th>
                    <th scope="col">State</th>
                    <th scope="col">Download</th>
                  </tr>
                </thead>
                <tbody>
                  {loaderData.files.map((asset) => {
                    const current = asset.versions.find(
                      (version) => version.current,
                    );
                    const eligible =
                      asset.status === "active" &&
                      current?.uploadStatus === "uploaded" &&
                      current.signatureStatus === "valid" &&
                      current.scanStatus === "clean" &&
                      current.releasedAt !== null;
                    return (
                      <tr key={asset.id}>
                        <td>
                          <input
                            type="checkbox"
                            name="assetId"
                            value={asset.id}
                            disabled={!eligible}
                            aria-label={`Select ${current?.filename ?? asset.assetKind}`}
                          />
                        </td>
                        <td>
                          <strong>
                            {current?.filename ?? asset.assetKind}
                          </strong>
                          <small className="subtle">
                            {asset.assetKind.replaceAll("_", " ")}
                            {current
                              ? ` · ${formatBytes(current.sizeBytes)}`
                              : ""}
                          </small>
                        </td>
                        <td>
                          {asset.sessionName}
                          <small className="subtle">{asset.speakerName}</small>
                        </td>
                        <td>
                          <details>
                            <summary>{asset.versions.length} versions</summary>
                            <ol>
                              {asset.versions.map((version) => (
                                <li key={version.id}>
                                  v{version.versionNumber} ·{" "}
                                  {version.scanStatus}
                                  {version.current ? " · current" : ""}
                                </li>
                              ))}
                            </ol>
                          </details>
                        </td>
                        <td>
                          <DomainStatusBadge
                            domain="file"
                            status={current?.scanStatus ?? asset.status}
                          />
                        </td>
                        <td>
                          {eligible ? (
                            <Link
                              className="btn small"
                              to={`/admin/content/files/${encodeURIComponent(asset.id)}`}
                              reloadDocument
                            >
                              <Download aria-hidden size={14} /> Current
                            </Link>
                          ) : (
                            <span className="help">Unavailable</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="page-actions">
              <label className="label">
                ZIP grouping
                <select
                  className="select"
                  name="groupBy"
                  defaultValue="session"
                >
                  <option value="session">Group by session</option>
                  <option value="speaker">Group by speaker</option>
                </select>
              </label>
              <button
                className="btn primary"
                disabled={navigation.state !== "idle"}
              >
                <ArchiveRestore aria-hidden size={15} /> Preview ZIP export
              </button>
            </div>
          </Form>
        ) : (
          <div className="pc-empty-state">
            <Files aria-hidden className="pc-state-icon" />
            <h3>No uploaded files</h3>
            <p className="subtle">
              Speaker uploads will appear here with every retained version.
            </p>
          </div>
        )}
      </section>

      {actionData?.ok && "preview" in actionData ? (
        <section className="card pad mt" aria-labelledby="zip-preview-title">
          <div className="card-title">
            <div>
              <span className="pc-section-kicker">Exact current versions</span>
              <h2 id="zip-preview-title">Confirm ZIP export</h2>
            </div>
            <span className="pill">
              {actionData.preview.entries.length} files ·{" "}
              {formatBytes(actionData.preview.totalBytes)}
            </span>
          </div>
          <ul>
            {actionData.preview.entries.map((entry) => (
              <li key={entry.assetId}>
                {entry.filename} · {entry.sessionName} · {entry.speakerName} ·{" "}
                {formatBytes(entry.sizeBytes)}
              </li>
            ))}
          </ul>
          <Form method="post" className="stack mt" reloadDocument>
            <input type="hidden" name="intent" value="download-zip" />
            <input
              type="hidden"
              name="manifest"
              value={actionData.preview.manifest}
            />
            <input
              type="hidden"
              name="groupBy"
              value={actionData.preview.groupBy}
            />
            <label className="toggle">
              <input type="checkbox" name="confirmed" value="true" required />
              Download exactly these current released versions
            </label>
            <button className="btn primary">
              <Download aria-hidden size={15} /> Generate ZIP
            </button>
          </Form>
        </section>
      ) : null}
    </>
  );
}
