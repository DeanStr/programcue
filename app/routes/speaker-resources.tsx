import {
  BookOpenCheck,
  CheckCircle2,
  Download,
  FileText,
  LockKeyhole,
} from "lucide-react";
import { data, Form, Link, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/speaker-resources";
import { useSpeakerWorkspace } from "~/components/speaker-workspace-context";
import {
  ResourceRevisionConflictError,
  ResourceService,
} from "~/modules/resources/resource-service.server";
import { requireSpeakerWorkspace } from "~/modules/speakers/speaker-workspace.server";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";

export const meta = () => [{ title: "Participant Resources · Program Cue" }];

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, viewer } = await requireSpeakerWorkspace(request, context);
  const slug = new URL(request.url).searchParams.get("resource");
  return {
    workspace: await new ResourceService(env).getParticipantWorkspace(
      viewer,
      slug,
    ),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env, viewer } = await requireSpeakerWorkspace(request, context);
  const form = await request.formData();
  if (form.get("confirmed") !== "on") {
    return data(
      {
        ok: false,
        message: "Confirm that you read the resource before acknowledging it.",
      },
      { status: 422 },
    );
  }
  try {
    const pageId = String(form.get("pageId") ?? "");
    const acknowledged = await new ResourceService(env).acknowledge(
      viewer,
      pageId,
      String(form.get("versionId") ?? ""),
      request.headers.get("user-agent"),
    );
    if (acknowledged) {
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "resource_acknowledgement",
        entityId: pageId,
        changeType: "progress",
      });
      if (realtimeFailure) return data(realtimeFailure, { status: 207 });
    }
    return data({
      ok: true,
      message: acknowledged
        ? "Acknowledgement recorded for this exact published version."
        : "This published version was already acknowledged.",
    });
  } catch (error) {
    if (error instanceof ResourceRevisionConflictError) {
      return data({ ok: false, message: error.message }, { status: 409 });
    }
    if (error instanceof Response) throw error;
    throw error;
  }
}

function fileSize(bytes: number) {
  return bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1_024))} KB`;
}

export default function SpeakerResources({ loaderData }: Route.ComponentProps) {
  const { workspace } = loaderData;
  const { portal } = useSpeakerWorkspace();
  const timezone = portal.event.timezone;
  const selected = workspace.selected;
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  return (
    <>
      <div className="page-head">
        <div>
          <span className="pc-page-eyebrow">Knowledge library</span>
          <h1>Participant resources</h1>
          <p>
            Published guidance selected for your participant identity and
            sessions.
          </p>
        </div>
        <Link className="btn" to="/participant/dashboard">
          Back to dashboard
        </Link>
      </div>
      {actionData ? (
        <div
          className={`pc-status-notice ${actionData.ok ? "is-success" : "is-danger"}`}
          role={actionData.ok ? "status" : "alert"}
        >
          <CheckCircle2 aria-hidden size={18} />
          <div className="pc-status-notice-copy">
            <strong>{actionData.ok ? "Recorded" : "Could not save"}</strong>
            <div>{actionData.message}</div>
          </div>
        </div>
      ) : null}
      <div className="speaker-resource-layout mt">
        <aside className="card pad resource-index">
          <div className="card-title">
            <h2>Resource library</h2>
            <span className="pill right">{workspace.pages.length}</span>
          </div>
          {workspace.pages.map((page) => (
            <Link
              to={`/participant/resources?resource=${page.slug}`}
              className={`resource-link${selected?.id === page.id ? " active" : ""}`}
              key={page.id}
            >
              <strong>{page.title}</strong>
              <small>
                {page.category ?? "General"} · v{page.versionNumber}
              </small>
              {page.acknowledgementRequired ? (
                <span
                  className={`status ${page.acknowledged ? "success" : "warning"}`}
                >
                  {page.acknowledged
                    ? "Acknowledged"
                    : "Acknowledgement required"}
                </span>
              ) : null}
            </Link>
          ))}
        </aside>
        {selected ? (
          <article className="card pad speaker-resource-content">
            <div className="card-title">
              <div>
                <span className="status info">
                  {selected.category ?? "General"}
                </span>
                <h2>{selected.title}</h2>
              </div>
              {selected.acknowledgementRequired ? (
                <span
                  className={`status ${selected.acknowledged ? "success" : "warning"}`}
                >
                  {selected.acknowledged ? "Acknowledged" : "Outstanding"}
                </span>
              ) : null}
            </div>
            <p className="subtle">
              Published{" "}
              {new Intl.DateTimeFormat("en", {
                dateStyle: "medium",
                timeZone: timezone,
              }).format(new Date(selected.publishedAt * 1_000))}{" "}
              ({timezone}) · version {selected.versionNumber}
            </p>
            <div
              className="resource-rendered"
              dangerouslySetInnerHTML={{ __html: selected.renderedHtml }}
            />
            {selected.attachments.length ? (
              <section className="card pad mt resource-attachments">
                <strong>Attachments</strong>
                {selected.attachments.map((attachment) => (
                  <a
                    className="file-version-row"
                    href={`/participant/resources/files/${attachment.id}`}
                    key={attachment.id}
                  >
                    <span className="file-kind-icon">
                      <FileText aria-hidden size={17} />
                    </span>
                    <span>
                      <strong>{attachment.filename}</strong>
                      <small>
                        {fileSize(attachment.sizeBytes)} · private expiring
                        session access
                      </small>
                    </span>
                    <Download aria-hidden className="right" size={16} />
                  </a>
                ))}
              </section>
            ) : (
              <div className="validation-item ok mt">
                <LockKeyhole aria-hidden size={16} />
                <span>
                  No downloadable attachments are released for this version.
                </span>
              </div>
            )}
            {selected.acknowledgementRequired && !selected.acknowledged ? (
              <Form method="post" className="resource-acknowledge mt">
                <input type="hidden" name="pageId" value={selected.id} />
                <input
                  type="hidden"
                  name="versionId"
                  value={selected.versionId}
                />
                <label className="speaker-confirm">
                  <input name="confirmed" type="checkbox" required /> I have
                  read and understood this published resource
                </label>
                <button
                  className="btn primary"
                  disabled={navigation.state !== "idle"}
                >
                  <BookOpenCheck aria-hidden size={16} />{" "}
                  {navigation.state === "submitting"
                    ? "Recording…"
                    : "Acknowledge version"}
                </button>
              </Form>
            ) : selected.acknowledged ? (
              <div className="validation-item ok mt">
                <CheckCircle2 aria-hidden size={16} />
                <span>You acknowledged this exact published version.</span>
              </div>
            ) : null}
          </article>
        ) : (
          <section className="pc-empty-state card">
            <BookOpenCheck aria-hidden className="pc-state-icon" />
            <h2>No resources published</h2>
            <p className="subtle">
              The event team has not published anything for your audience yet.
            </p>
          </section>
        )}
      </div>
    </>
  );
}
