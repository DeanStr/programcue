import { ExternalLink } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  data,
  Link,
  useActionData,
  useNavigation,
  useSubmit,
} from "react-router";
import { ZodError } from "zod";
import { publicSiteSectionLabels } from "~/components/admin-public-site-constants";
import { AdminPublicSiteEditor } from "~/components/admin-public-site-editor";
import { AdminPublicSitePreview } from "~/components/admin-public-site-preview";
import { AdminPublicSiteRecordings } from "~/components/admin-public-site-recordings";
import { AdminPublicSiteSponsors } from "~/components/admin-public-site-sponsors";
import { useConfirm } from "~/components/ui/confirm-dialog";
import type { PublicRecordingWorkspaceItem } from "~/modules/public-site/public-recording-service.server";
import { PublicRecordingService } from "~/modules/public-site/public-recording-service.server";
import { PUBLIC_SITE_PAGE_TYPES } from "~/modules/public-site/public-site";
import {
  PublicSiteNotFoundError,
  PublicSiteRevisionConflictError,
  PublicSiteService,
  PublicSiteValidationError,
} from "~/modules/public-site/public-site-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { notifyRouteChange } from "~/platform/realtime/route-realtime.server";
import type { Route } from "./+types/admin-public-site";

export const meta: Route.MetaFunction = () => [
  { title: "Public site · Program Cue" },
];

type ActionResponse = {
  ok: boolean;
  message: string;
  warning?: boolean;
  committed?: boolean;
  draftRevision?: number;
};

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  return {
    ...(await new PublicSiteService(env).getWorkspace(viewer)),
    publicOrigin: new URL(request.url).origin,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST")
    throw new Response("Method not allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  const values = await request.formData();
  const intent = String(values.get("intent") ?? "");
  const service = new PublicSiteService(env);
  const recordingService = new PublicRecordingService(env);
  try {
    const result =
      intent === "save-site"
        ? await service.saveDraft(viewer, {
            revision: values.get("revision"),
            configurationJson: values.get("configurationJson"),
          })
        : intent === "publish-site"
          ? await service.publish(viewer, {
              revision: values.get("revision"),
              confirmed: values.get("confirmed"),
            })
          : intent === "save-sponsor"
            ? await service.saveSponsor(viewer, {
                id: values.get("id"),
                revision: values.get("revision"),
                name: values.get("name"),
                tier: values.get("tier"),
                websiteUrl: values.get("websiteUrl"),
                logoUrl: values.get("logoUrl"),
                description: values.get("description"),
                position: values.get("position"),
              })
            : intent === "delete-sponsor"
              ? await service.deleteSponsor(viewer, {
                  id: values.get("id"),
                  revision: values.get("revision"),
                  confirmed: values.get("confirmed"),
                })
              : intent === "save-recording"
                ? await recordingService.saveDraft(viewer, {
                    id: values.get("id"),
                    sessionId: values.get("sessionId"),
                    revision: values.get("revision"),
                    title: values.get("title"),
                    recordingUrl: values.get("recordingUrl"),
                    captionsUrl: values.get("captionsUrl"),
                    transcriptUrl: values.get("transcriptUrl"),
                  })
                : intent === "publish-recording"
                  ? await recordingService.publish(viewer, {
                      id: values.get("id"),
                      revision: values.get("revision"),
                      confirmed: values.get("confirmed"),
                    })
                  : intent === "unpublish-recording"
                    ? await recordingService.unpublish(viewer, {
                        id: values.get("id"),
                        revision: values.get("revision"),
                        confirmed: values.get("confirmed"),
                      })
                    : null;
    if (!result)
      return data<ActionResponse>(
        { ok: false, message: "Unsupported public-site action." },
        { status: 400 },
      );
    const realtimeFailure = await notifyRouteChange(
      env,
      viewer,
      result.changeSequence,
      viewer.eventId,
    );
    const labels: Record<string, string> = {
      "save-site": "Public-site draft saved. Public pages are unchanged.",
      "publish-site": "Public event site published.",
      "save-sponsor": "Sponsor saved to the site draft.",
      "delete-sponsor": "Sponsor removed from the site draft.",
      "save-recording": "Recording draft saved. It is not public.",
      "publish-recording":
        "Recording published. It appears only after its session and event have ended.",
      "unpublish-recording": "Recording withdrawn from the public site.",
    };
    return data<ActionResponse>(
      {
        ok: true,
        committed: true,
        warning: Boolean(realtimeFailure),
        draftRevision:
          intent === "save-site" &&
          "revision" in result &&
          typeof result.revision === "number"
            ? result.revision
            : undefined,
        message: realtimeFailure
          ? `${labels[intent]} ${realtimeFailure.message}`
          : labels[intent]!,
      },
      realtimeFailure ? { status: 207 } : undefined,
    );
  } catch (error) {
    if (error instanceof ZodError)
      return data<ActionResponse>(
        {
          ok: false,
          message: error.issues[0]?.message ?? "Review the public-site fields.",
        },
        { status: 422 },
      );
    if (error instanceof PublicSiteRevisionConflictError)
      return data<ActionResponse>(
        { ok: false, message: error.message },
        { status: 409 },
      );
    if (
      error instanceof PublicSiteValidationError ||
      error instanceof PublicSiteNotFoundError
    )
      return data<ActionResponse>(
        { ok: false, message: error.message },
        { status: error instanceof PublicSiteNotFoundError ? 404 : 422 },
      );
    throw error;
  }
}

function PublicationStatus({
  label,
  draft,
  published,
  publishedAt,
  current,
}: {
  label: string;
  draft?: number;
  published: number | null;
  publishedAt: number | null;
  current: boolean;
}) {
  return (
    <article className="public-site-publication-status">
      <span className="pc-page-eyebrow">{label}</span>
      <strong>
        {publishedAt === null
          ? "Not published"
          : current
            ? "Current"
            : "Changes waiting"}
      </strong>
      <small>
        {draft === undefined ? "" : `Draft ${draft} · `}
        {published === null ? "No public revision" : `Published ${published}`}
      </small>
    </article>
  );
}

export default function AdminPublicSite({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const { confirm, dialog } = useConfirm();
  const [configuration, setConfiguration] = useState(
    loaderData.draft.configuration,
  );
  const [draftBase, setDraftBase] = useState(loaderData.draft);
  const configurationRef = useRef(configuration);
  configurationRef.current = configuration;
  const draftBaseRef = useRef(draftBase);
  draftBaseRef.current = draftBase;
  const incomingDraft = loaderData.draft;
  useEffect(() => {
    const incoming = JSON.stringify(incomingDraft.configuration);
    const current = JSON.stringify(configurationRef.current);
    const base = JSON.stringify(draftBaseRef.current.configuration);
    if (current === base || current === incoming) {
      setDraftBase(incomingDraft);
      setConfiguration(incomingDraft.configuration);
    }
  }, [incomingDraft]);
  useEffect(() => {
    if (!actionData?.ok || actionData.draftRevision === undefined) return;
    setDraftBase({
      configuration: configurationRef.current,
      revision: actionData.draftRevision,
    });
  }, [actionData?.draftRevision, actionData?.ok]);
  const serialized = useMemo(
    () => JSON.stringify(configuration),
    [configuration],
  );
  const savedSerialized = useMemo(
    () => JSON.stringify(draftBase.configuration),
    [draftBase.configuration],
  );
  const unsaved = serialized !== savedSerialized;
  const newerDraftAvailable = loaderData.draft.revision !== draftBase.revision;
  const secondaryActionsBlocked = unsaved || newerDraftAvailable;
  const busy = navigation.state !== "idle";

  function blockSecondaryMutation(event: FormEvent<HTMLDivElement>) {
    const form = event.target as HTMLFormElement;
    if (!(form instanceof HTMLFormElement)) return;
    const intent = String(new FormData(form).get("intent") ?? "");
    if (intent !== "save-site" && secondaryActionsBlocked)
      event.preventDefault();
  }

  function publishSite() {
    confirm(
      {
        title: "Publish the public event site?",
        description:
          "The saved homepage, navigation, pages and sponsor snapshot will replace the current public site.",
        records: [
          ...configuration.sectionOrder
            .filter((section) => configuration.sectionVisibility[section])
            .map((section) => publicSiteSectionLabels[section]),
          ...PUBLIC_SITE_PAGE_TYPES.filter(
            (page) => configuration.pages[page].enabled,
          ).map((page) => configuration.pages[page].title),
          `${loaderData.sponsors.length} sponsor record${loaderData.sponsors.length === 1 ? "" : "s"}`,
        ],
        confirmLabel: "Publish public site",
        tone: "primary",
      },
      () =>
        submit(
          {
            intent: "publish-site",
            revision: String(draftBase.revision),
            confirmed: "true",
          },
          { method: "post" },
        ),
    );
  }

  function deleteSponsor(id: string, revision: number, name: string) {
    if (secondaryActionsBlocked) return;
    confirm(
      {
        title: `Remove ${name}?`,
        description:
          "The sponsor remains on the current public snapshot until the site is published again.",
        records: [name],
        confirmLabel: "Remove sponsor",
        tone: "danger",
      },
      () =>
        submit(
          {
            intent: "delete-sponsor",
            id,
            revision: String(revision),
            confirmed: "true",
          },
          { method: "post" },
        ),
    );
  }

  function publishRecording(recording: PublicRecordingWorkspaceItem) {
    if (secondaryActionsBlocked) return;
    confirm(
      {
        title: `Publish ${recording.draftTitle}?`,
        description:
          "The external recording becomes eligible for public display after its scheduled session ends.",
        records: [recording.draftTitle],
        confirmLabel: "Publish recording",
        tone: "primary",
      },
      () =>
        submit(
          {
            intent: "publish-recording",
            id: recording.id,
            revision: String(recording.draftRevision),
            confirmed: "true",
          },
          { method: "post" },
        ),
    );
  }

  function unpublishRecording(recording: PublicRecordingWorkspaceItem) {
    const title = recording.publishedTitle ?? recording.draftTitle;
    if (secondaryActionsBlocked) return;
    confirm(
      {
        title: `Withdraw ${title}?`,
        description:
          "The recording will stop appearing on public event pages immediately. Its editable draft will be retained.",
        records: [title],
        confirmLabel: "Withdraw recording",
        tone: "danger",
      },
      () =>
        submit(
          {
            intent: "unpublish-recording",
            id: recording.id,
            revision: String(recording.draftRevision),
            confirmed: "true",
          },
          { method: "post" },
        ),
    );
  }

  return (
    <>
      {dialog}
      <div className="page-head">
        <div>
          <span className="pc-page-eyebrow">Published experience</span>
          <h1>Public event site</h1>
          <p>
            Compose a bounded event homepage and pages from approved event and
            programme records.
          </p>
        </div>
        <div className="page-actions">
          {loaderData.published && loaderData.programme ? (
            <Link
              className="btn"
              to={`/public/programme/${loaderData.event.slug}`}
              target="_blank"
              rel="noreferrer"
            >
              Open public site <ExternalLink aria-hidden size={13} />
            </Link>
          ) : null}
          <span
            className={
              loaderData.hasUnpublishedChanges
                ? "status warning"
                : loaderData.published
                  ? "status ok"
                  : "status info"
            }
          >
            {loaderData.hasUnpublishedChanges
              ? "Changes waiting"
              : loaderData.published
                ? "Published"
                : "Not published"}
          </span>
        </div>
      </div>

      {actionData ? (
        <div
          className={`validation-item mb ${actionData.warning ? "warn" : actionData.ok ? "ok" : "error"}`}
          role={actionData.ok ? "status" : "alert"}
        >
          {actionData.message}
        </div>
      ) : null}

      {secondaryActionsBlocked ? (
        <div className="validation-item warn mb" role="status">
          {newerDraftAvailable
            ? "A newer saved site draft is available. Save will report a revision conflict; refresh before managing sponsors or recordings."
            : "Save the homepage and page edits before managing sponsors or recordings."}
        </div>
      ) : null}

      <section
        className="public-site-publication-grid mb"
        aria-label="Publication status"
      >
        <PublicationStatus
          label="Branding"
          draft={loaderData.publicationStatus.branding.draftRevision}
          published={loaderData.publicationStatus.branding.publishedRevision}
          publishedAt={loaderData.publicationStatus.branding.publishedAt}
          current={loaderData.publicationStatus.branding.current}
        />
        <PublicationStatus
          label="Public site"
          draft={loaderData.publicationStatus.site.draftRevision}
          published={loaderData.publicationStatus.site.publishedRevision}
          publishedAt={loaderData.publicationStatus.site.publishedAt}
          current={loaderData.publicationStatus.site.current}
        />
        <PublicationStatus
          label="Programme"
          published={loaderData.publicationStatus.programme.version}
          publishedAt={loaderData.publicationStatus.programme.publishedAt}
          current={loaderData.publicationStatus.programme.publishedAt !== null}
        />
      </section>

      <div
        className="public-site-admin-workspace"
        onSubmitCapture={blockSecondaryMutation}
      >
        <div className="public-site-editor-stack">
          <AdminPublicSiteEditor
            configuration={configuration}
            setConfiguration={setConfiguration}
            draftRevision={draftBase.revision}
            serializedConfiguration={serialized}
            programme={loaderData.programme}
            unsaved={unsaved}
            busy={busy}
            saving={busy && navigation.formData?.get("intent") === "save-site"}
          />
          <AdminPublicSiteSponsors
            sponsors={loaderData.sponsors}
            draftCreated={draftBase.revision > 0}
            blocked={secondaryActionsBlocked}
            busy={busy}
            onDelete={(sponsor) =>
              deleteSponsor(sponsor.id, sponsor.revision, sponsor.name)
            }
          />
          <AdminPublicSiteRecordings
            recordings={loaderData.recordings}
            programme={loaderData.programme}
            blocked={secondaryActionsBlocked}
            busy={busy}
            onPublish={publishRecording}
            onUnpublish={unpublishRecording}
          />
        </div>

        <AdminPublicSitePreview
          configuration={configuration}
          draftSponsors={loaderData.sponsors.map(
            ({ revision: _revision, ...sponsor }) => sponsor,
          )}
          programme={loaderData.programme}
          eventName={loaderData.event.name}
          publicOrigin={loaderData.publicOrigin}
          published={loaderData.published}
          canPublish={
            !unsaved &&
            !busy &&
            draftBase.revision > 0 &&
            !newerDraftAvailable &&
            loaderData.hasUnpublishedChanges
          }
          onPublish={publishSite}
        />
      </div>
    </>
  );
}
