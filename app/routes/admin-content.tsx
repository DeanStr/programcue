import { ArchiveRestore, Download, ShieldCheck } from "lucide-react";
import { useEffect } from "react";
import {
  data,
  Form,
  Link,
  useActionData,
  useFetcher,
  useLocation,
  useNavigate,
  useNavigation,
} from "react-router";
import { ZodError, z } from "zod";
import {
  DomainStatusBadge,
  statusPresentation,
} from "~/components/ui/domain-status-badge";
import { EventDateTime } from "~/components/ui/event-date-time";
import {
  type ContentFileVersion,
  ContentManagementService,
  ContentManagementStateError,
} from "~/modules/content/content-management-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/admin-content";
import type { action as zipAction } from "./admin-content-zip";

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
  const search = new URL(request.url).searchParams;
  const rawPage = search.get("filesPage");
  if (
    rawPage !== null &&
    (!/^[1-9]\d*$/.test(rawPage) || !Number.isSafeInteger(Number(rawPage)))
  ) {
    throw new Response("filesPage must be a positive integer", { status: 400 });
  }
  const rawZipOperation = search.get("zipOperation");
  if (
    rawZipOperation !== null &&
    !z.uuid().safeParse(rawZipOperation).success
  ) {
    throw new Response("zipOperation must be a UUID", { status: 400 });
  }
  try {
    const service = new ContentManagementService(env);
    const dashboard = await service.getDashboard(
      viewer,
      rawPage === null ? 1 : Number(rawPage),
    );
    return {
      ...dashboard,
      zipOperation:
        rawZipOperation === null
          ? null
          : await service.zipOperationStatus(viewer, rawZipOperation),
    };
  } catch (error) {
    if (error instanceof ContentManagementStateError) {
      throw new Response(error.message, { status: error.status });
    }
    throw error;
  }
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

export const meta = () => [{ title: "Session content & files · Program Cue" }];

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function contentPulse(input: {
  sessionCount: number;
  statusCounts: Record<string, number>;
  version: { versionNumber: number; status: string } | null;
}) {
  const parts = [
    `${input.sessionCount} ${input.sessionCount === 1 ? "session" : "sessions"}`,
  ];
  for (const status of [
    "approved",
    "in_review",
    "changes_requested",
    "draft",
  ] as const) {
    const count = input.statusCounts[status] ?? 0;
    if (count === 0) continue;
    parts.push(
      `${count} ${statusPresentation("content", status).label.toLowerCase()}`,
    );
  }
  if (input.version) {
    parts.push(
      `Version ${input.version.versionNumber} ${statusPresentation("version", input.version.status).label.toLowerCase()}`,
    );
  }
  return parts.join(" · ");
}

type ZipOperationStatus = {
  operationId: string;
  status: "queued" | "processing" | "ready" | "failed";
  error: string | null;
  fileName: string | null;
  sizeBytes: number | null;
  downloadUrl: string | null;
};

function ZipExportProgress({ operationId }: { operationId: string }) {
  const fetcher = useFetcher<ZipOperationStatus>();
  // The operation id is the polling scope; the fetcher object is stable for
  // this component and should not restart polling on each response.
  // biome-ignore lint/correctness/useExhaustiveDependencies: Polling is intentionally scoped to the durable operation id.
  useEffect(() => {
    void fetcher.load(
      `/admin/content/export.zip?operation=${encodeURIComponent(operationId)}`,
    );
  }, [operationId]);
  useEffect(() => {
    if (
      !fetcher.data ||
      fetcher.data.status === "ready" ||
      fetcher.data.status === "failed"
    )
      return;
    const timer = window.setTimeout(() => {
      void fetcher.load(
        `/admin/content/export.zip?operation=${encodeURIComponent(operationId)}`,
      );
    }, 1_000);
    return () => window.clearTimeout(timer);
  }, [fetcher.data, fetcher.load, operationId]);
  if (fetcher.state !== "idle" && !fetcher.data)
    return <p className="help">ZIP export queued. Checking its status…</p>;
  if (!fetcher.data) return null;
  if (fetcher.data.status === "failed")
    return (
      <p className="validation-item error" role="alert">
        {fetcher.data.error ?? "The ZIP export failed."}
      </p>
    );
  if (fetcher.data.status === "ready")
    return (
      <div className="validation-item ok" role="status">
        <strong>ZIP ready</strong>
        <span>
          {fetcher.data.fileName}
          {fetcher.data.sizeBytes !== null
            ? ` · ${formatBytes(fetcher.data.sizeBytes)}`
            : ""}
        </span>
        {fetcher.data.downloadUrl ? (
          <Link
            className="btn small"
            to={fetcher.data.downloadUrl}
            reloadDocument
          >
            <Download aria-hidden size={14} /> Download ZIP
          </Link>
        ) : null}
      </div>
    );
  return (
    <p className="validation-item info" role="status">
      <strong>
        {fetcher.data.status === "processing"
          ? "Processing ZIP…"
          : "ZIP queued…"}
      </strong>
      <span>
        The archive will become downloadable after its stored result is
        verified.
      </span>
    </p>
  );
}

type FileVersionPage =
  | {
      ok: true;
      versions: ContentFileVersion[];
      page: number;
      total: number;
      hasPrevious: boolean;
      hasNext: boolean;
    }
  | { ok: false; message: string };

function FileVersionHistory({
  assetId,
  versionCount,
  timeZone,
}: {
  assetId: string;
  versionCount: number;
  timeZone: string;
}) {
  const fetcher = useFetcher<FileVersionPage>();
  const page = fetcher.data?.ok ? fetcher.data.page : 1;

  function loadPage(nextPage: number) {
    void fetcher.load(
      `/admin/content/files/${encodeURIComponent(assetId)}/versions?page=${nextPage}`,
    );
  }

  return (
    <details
      onToggle={(event) => {
        if (
          event.currentTarget.open &&
          !fetcher.data &&
          fetcher.state === "idle"
        ) {
          loadPage(1);
        }
      }}
    >
      <summary>{versionCount} versions</summary>
      {fetcher.state !== "idle" && !fetcher.data ? (
        <p className="help">Loading version history…</p>
      ) : fetcher.data?.ok ? (
        <>
          <ol>
            {fetcher.data.versions.map((version) => (
              <li key={version.id}>
                <span>
                  v{version.versionNumber} · {version.scanStatus}
                  {version.latest ? " · latest" : ""}
                  {version.current ? " · current" : ""}
                  {version.uploadedAt === null ? (
                    " · upload incomplete"
                  ) : (
                    <>
                      {" · Uploaded "}
                      <EventDateTime
                        epochSeconds={version.uploadedAt}
                        timeZone={timeZone}
                      />
                    </>
                  )}
                </span>
                {version.uploadStatus === "uploaded" &&
                version.signatureStatus === "valid" &&
                version.scanStatus === "clean" &&
                version.releasedAt !== null ? (
                  <Link
                    className="btn small"
                    to={`/admin/content/files/${encodeURIComponent(assetId)}/versions/${encodeURIComponent(version.id)}`}
                    reloadDocument
                  >
                    <Download aria-hidden size={14} /> Download v
                    {version.versionNumber}
                  </Link>
                ) : (
                  <small className="subtle">Download unavailable</small>
                )}
              </li>
            ))}
          </ol>
          {fetcher.data.hasPrevious || fetcher.data.hasNext ? (
            <div className="page-actions">
              <button
                className="btn small"
                type="button"
                disabled={!fetcher.data.hasPrevious || fetcher.state !== "idle"}
                onClick={() => loadPage(page - 1)}
              >
                Previous versions
              </button>
              <span className="help">Page {page}</span>
              <button
                className="btn small"
                type="button"
                disabled={!fetcher.data.hasNext || fetcher.state !== "idle"}
                onClick={() => loadPage(page + 1)}
              >
                Next versions
              </button>
            </div>
          ) : null}
        </>
      ) : fetcher.data ? (
        <p className="validation-item error" role="alert">
          {fetcher.data.message}
        </p>
      ) : null}
    </details>
  );
}

export default function AdminContent({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const zipFetcher = useFetcher<typeof zipAction>();
  const location = useLocation();
  const navigate = useNavigate();
  const navigation = useNavigation();
  const zipPreviewManifest =
    actionData?.ok && "preview" in actionData
      ? actionData.preview.manifest
      : null;
  useEffect(() => {
    if (zipPreviewManifest === null) return;
    zipFetcher.reset();
  }, [zipFetcher.reset, zipPreviewManifest]);
  const zipOperationId =
    zipFetcher.data && "operationId" in zipFetcher.data
      ? zipFetcher.data.operationId
      : loaderData.zipOperation?.operationId;
  useEffect(() => {
    if (!zipOperationId) return;
    const search = new URLSearchParams(location.search);
    if (search.get("zipOperation") === zipOperationId) return;
    search.set("zipOperation", zipOperationId);
    void navigate(
      { pathname: location.pathname, search: `?${search.toString()}` },
      { replace: true, preventScrollReset: true },
    );
  }, [location.pathname, location.search, navigate, zipOperationId]);
  const statusCounts = Object.fromEntries(
    ["draft", "in_review", "approved", "changes_requested"].map((status) => [
      status,
      loaderData.sessions.filter((session) => session.contentStatus === status)
        .length,
    ]),
  );
  return (
    <div className="content-library">
      <div className="page-head pc-page-header">
        <div>
          <h1>Session content &amp; files</h1>
          <p>
            Review session copy, restore attributed revisions and collect
            released speaker files.
          </p>
        </div>
        <div className="page-actions">
          <Link className="content-text-action" to="/admin/tasks">
            Deliverable tasks
          </Link>
          <Link className="btn primary" to="/admin/schedule">
            Open schedule
          </Link>
        </div>
      </div>

      {actionData && !actionData.ok ? (
        <div className="validation-item error card pad mb" role="alert">
          <strong>File export blocked</strong>
          <span>{actionData.message}</span>
        </div>
      ) : null}

      <p className="content-pulse">
        {contentPulse({
          sessionCount: loaderData.sessions.length,
          statusCounts,
          version: loaderData.version,
        })}
      </p>

      <section
        className="content-review"
        aria-labelledby="content-review-title"
      >
        <div className="content-section-head">
          <h2 id="content-review-title">Session content review</h2>
        </div>
        {loaderData.sessions.length ? (
          <ul className="content-review-list">
            {loaderData.sessions.map((session) => {
              const needsReview = session.contentStatus !== "approved";
              const sessionHref = `/admin/content/sessions/${encodeURIComponent(session.sessionId)}`;
              return (
                <li
                  className={
                    needsReview
                      ? "content-review-row"
                      : "content-review-row is-settled"
                  }
                  key={session.sessionId}
                >
                  <div className="content-review-identity">
                    <Link className="content-review-title" to={sessionHref}>
                      {session.title}
                    </Link>
                    <span className="content-review-speaker">
                      {session.speakerNames.filter(Boolean).join(", ") ||
                        "No linked speaker"}
                    </span>
                  </div>
                  <DomainStatusBadge
                    domain="content"
                    status={session.contentStatus}
                  />
                  {needsReview ? (
                    <Link className="content-text-action" to={sessionHref}>
                      Review
                    </Link>
                  ) : null}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="pc-empty-state">
            <ShieldCheck aria-hidden className="pc-state-icon" />
            <h3 className="pc-empty-state-title">No session content yet</h3>
            <p>
              Create sessions and a schedule version before reviewing content.
            </p>
          </div>
        )}
      </section>

      <section className="content-files" aria-labelledby="content-files-title">
        <div className="content-section-head">
          <h2 id="content-files-title">Central files library</h2>
          <span className="content-files-count">
            {loaderData.filesPagination.total}{" "}
            {loaderData.filesPagination.total === 1 ? "asset" : "assets"}
          </span>
        </div>
        {loaderData.files.length ? (
          <>
            <p className="content-files-note">
              Quarantined and historical metadata remains visible. Library and
              ZIP export actions use only current released, signature-valid and
              clean versions; retained clean and released versions remain
              individually downloadable from version history.
            </p>
            <Form method="post" className="stack">
              <input type="hidden" name="intent" value="preview-zip" />
              <section
                className="table-wrap"
                aria-label="Private file inventory"
                // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data regions need keyboard focus so arrow keys can expose overflow content.
                tabIndex={0}
              >
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
                            {current ? (
                              <small className="subtle">
                                {current.uploadedAt === null ? (
                                  "Upload incomplete"
                                ) : (
                                  <>
                                    Uploaded{" "}
                                    <EventDateTime
                                      epochSeconds={current.uploadedAt}
                                      timeZone={loaderData.eventTimezone}
                                    />
                                  </>
                                )}
                              </small>
                            ) : null}
                          </td>
                          <td>
                            {asset.sessionName}
                            <small className="subtle">
                              {asset.speakerName}
                            </small>
                            {asset.targetType === "task" ? (
                              <Link
                                className="btn small"
                                to={`/admin/tasks?task=${encodeURIComponent(asset.targetId)}`}
                              >
                                Open task thread
                              </Link>
                            ) : null}
                          </td>
                          <td>
                            <FileVersionHistory
                              assetId={asset.id}
                              versionCount={asset.versionCount}
                              timeZone={loaderData.eventTimezone}
                            />
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
              </section>
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
                  type="submit"
                  className="btn primary"
                  disabled={navigation.state !== "idle"}
                >
                  <ArchiveRestore aria-hidden size={15} /> Preview ZIP export
                </button>
              </div>
              {loaderData.filesPagination.hasPrevious ||
              loaderData.filesPagination.hasNext ? (
                <nav className="page-actions" aria-label="Files pages">
                  {loaderData.filesPagination.hasPrevious ? (
                    <Link
                      className="btn"
                      to={`?filesPage=${loaderData.filesPagination.page - 1}#content-files-title`}
                    >
                      Previous files
                    </Link>
                  ) : null}
                  <span className="help">
                    Page {loaderData.filesPagination.page} · up to{" "}
                    {loaderData.filesPagination.pageSize} assets per page
                  </span>
                  {loaderData.filesPagination.hasNext ? (
                    <Link
                      className="btn"
                      to={`?filesPage=${loaderData.filesPagination.page + 1}#content-files-title`}
                    >
                      Next files
                    </Link>
                  ) : null}
                </nav>
              ) : null}
            </Form>
          </>
        ) : (
          <p className="content-files-empty">No uploaded files.</p>
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
          <zipFetcher.Form
            method="post"
            action="/admin/content/export.zip"
            className="stack mt"
          >
            <input type="hidden" name="intent" value="queue-zip" />
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
            <button
              type="submit"
              className="btn primary"
              disabled={zipFetcher.state !== "idle"}
            >
              <Download aria-hidden size={15} /> Generate ZIP
            </button>
            {zipFetcher.data &&
            "message" in zipFetcher.data &&
            !zipFetcher.data.ok ? (
              <p className="validation-item error" role="alert">
                {zipFetcher.data.message}
              </p>
            ) : null}
          </zipFetcher.Form>
        </section>
      ) : null}
      {zipOperationId ? (
        <section className="card pad mt" aria-labelledby="zip-progress-title">
          <div className="card-title">
            <div>
              <span className="pc-section-kicker">Stored archive</span>
              <h2 id="zip-progress-title">ZIP export</h2>
            </div>
          </div>
          <ZipExportProgress operationId={zipOperationId} />
        </section>
      ) : null}
    </div>
  );
}
