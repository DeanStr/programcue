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
import { ConfirmDialog, useConfirm } from "~/components/ui/confirm-dialog";
import { useUnsavedChanges } from "~/components/ui/use-unsaved-changes";
import { requireValue } from "~/lib/required-value";
import type { PublicRecordingWorkspaceItem } from "~/modules/public-site/public-recording-service.server";
import { PublicRecordingService } from "~/modules/public-site/public-recording-service.server";
import {
  PUBLIC_SITE_PAGE_TYPES,
  type PublicSiteDraft,
  type PublicSiteSponsor,
  type PublishedPublicSiteSnapshot,
} from "~/modules/public-site/public-site";
import { publicSiteCommandIdForIntent } from "~/modules/public-site/public-site-command.server";
import {
  PublicSiteCommandConflictError,
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

function changedList(label: string, before: string[], after: string[]) {
  const beforeSet = new Set(before);
  const afterSet = new Set(after);
  const added = after.filter((value) => !beforeSet.has(value));
  const removed = before.filter((value) => !afterSet.has(value));
  return [
    ...(added.length ? [`${label} added: ${added.join(", ")}`] : []),
    ...(removed.length ? [`${label} removed: ${removed.join(", ")}`] : []),
  ];
}

function publicationChangeSummary(input: {
  draft: PublicSiteDraft;
  sponsors: PublicSiteSponsor[];
  published: { configuration: PublishedPublicSiteSnapshot } | null;
  speakerNames: Map<string, string>;
  sessionNames: Map<string, string>;
}) {
  const enabledSections = (configuration: PublicSiteDraft) =>
    configuration.sectionOrder
      .filter((section) => configuration.sectionVisibility[section])
      .map((section) => publicSiteSectionLabels[section]);
  const enabledPages = (configuration: PublicSiteDraft) =>
    PUBLIC_SITE_PAGE_TYPES.filter(
      (page) => configuration.pages[page].enabled,
    ).map((page) => configuration.pages[page].title);
  const names = (ids: string[], labels: Map<string, string>) =>
    ids.map((id) => labels.get(id) ?? id);
  const nextSponsors = input.sponsors.map((sponsor) => sponsor.name);
  if (!input.published) {
    return [
      `Sections to publish: ${enabledSections(input.draft).join(", ") || "none"}`,
      `Pages to publish: ${enabledPages(input.draft).join(", ") || "none"}`,
      `Sponsors to publish: ${nextSponsors.join(", ") || "none"}`,
    ];
  }

  const before = input.published.configuration;
  const changes = [
    ...changedList(
      "Sections",
      enabledSections(before),
      enabledSections(input.draft),
    ),
    ...changedList("Pages", enabledPages(before), enabledPages(input.draft)),
    ...changedList(
      "Featured speakers",
      names(before.featuredSpeakerIds, input.speakerNames),
      names(input.draft.featuredSpeakerIds, input.speakerNames),
    ),
    ...changedList(
      "Featured sessions",
      names(before.featuredSessionIds, input.sessionNames),
      names(input.draft.featuredSessionIds, input.sessionNames),
    ),
    ...changedList(
      "Sponsors",
      before.sponsors.map((sponsor) => sponsor.name),
      nextSponsors,
    ),
  ];
  if (before.theme !== input.draft.theme)
    changes.push(`Theme: ${before.theme} → ${input.draft.theme}`);
  if (before.sectionOrder.join("\n") !== input.draft.sectionOrder.join("\n"))
    changes.push("Homepage section order changed.");
  const { sponsors: _sponsors, ...beforeEditorial } = before;
  if (JSON.stringify(beforeEditorial) !== JSON.stringify(input.draft))
    changes.push("Homepage or fixed-page editorial content changed.");
  const beforeSponsors = new Map(
    before.sponsors.map((sponsor) => [sponsor.id, sponsor]),
  );
  const updatedSponsors = input.sponsors
    .filter((sponsor) => {
      const prior = beforeSponsors.get(sponsor.id);
      if (!prior) return false;
      const { revision: _revision, ...next } = sponsor;
      return JSON.stringify(prior) !== JSON.stringify(next);
    })
    .map((sponsor) => sponsor.name);
  if (updatedSponsors.length)
    changes.push(`Sponsors updated: ${updatedSponsors.join(", ")}`);
  return changes.length ? changes : ["No public content changes detected."];
}

function sitePublishCommandKey(
  draftRevision: number,
  publishedRevision: number | null,
) {
  return `publish-site:${draftRevision}:${publishedRevision ?? "none"}`;
}

function sponsorDeleteCommandKey(id: string, revision: number) {
  return `delete-sponsor:${id}:${revision}`;
}

function recordingCommandKey(
  intent: "publish" | "unpublish",
  recording: PublicRecordingWorkspaceItem,
) {
  return `${intent}-recording:${recording.id}:${recording.draftRevision}:${recording.publishedRevision ?? "none"}:${recording.lastOperationId}`;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  const workspace = await new PublicSiteService(env).getWorkspace(viewer);
  const commandKeys = [
    sitePublishCommandKey(
      workspace.draft.revision,
      workspace.published?.revision ?? null,
    ),
    ...workspace.sponsors.map((sponsor) =>
      sponsorDeleteCommandKey(sponsor.id, sponsor.revision),
    ),
    ...workspace.recordings.flatMap((recording) => [
      recordingCommandKey("publish", recording),
      recordingCommandKey("unpublish", recording),
    ]),
  ];
  return {
    ...workspace,
    publicOrigin: new URL(request.url).origin,
    consequentialCommandIds: Object.fromEntries(
      await Promise.all(
        commandKeys.map(async (key) => [
          key,
          await publicSiteCommandIdForIntent(viewer, key),
        ]),
      ),
    ),
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
            commandId: values.get("commandId"),
            revision: values.get("revision"),
            configurationJson: values.get("configurationJson"),
          })
        : intent === "publish-site"
          ? await service.publish(viewer, {
              commandId: values.get("commandId"),
              revision: values.get("revision"),
              confirmed: values.get("confirmed"),
            })
          : intent === "save-sponsor"
            ? await service.saveSponsor(viewer, {
                commandId: values.get("commandId"),
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
                  commandId: values.get("commandId"),
                  id: values.get("id"),
                  revision: values.get("revision"),
                  confirmed: values.get("confirmed"),
                })
              : intent === "save-recording"
                ? await recordingService.saveDraft(viewer, {
                    commandId: values.get("commandId"),
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
                      commandId: values.get("commandId"),
                      id: values.get("id"),
                      revision: values.get("revision"),
                      confirmed: values.get("confirmed"),
                    })
                  : intent === "unpublish-recording"
                    ? await recordingService.unpublish(viewer, {
                        commandId: values.get("commandId"),
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
          : requireValue(
              labels[intent],
              "Required labels[intent] is unavailable.",
            ),
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
    if (
      error instanceof PublicSiteRevisionConflictError ||
      error instanceof PublicSiteCommandConflictError
    )
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
  const blocker = useUnsavedChanges(unsaved);

  function consequentialCommandId(key: string) {
    const id = loaderData.consequentialCommandIds[key];
    if (!id)
      throw new Error(
        "The public-site action identity is unavailable for this revision. Refresh before trying again.",
      );
    return id;
  }

  function blockSecondaryMutation(event: FormEvent<HTMLDivElement>) {
    const form = event.target as HTMLFormElement;
    if (!(form instanceof HTMLFormElement)) return;
    const intent = String(new FormData(form).get("intent") ?? "");
    if (
      intent !== "save-site" &&
      intent !== "unpublish-recording" &&
      secondaryActionsBlocked
    )
      event.preventDefault();
  }

  function publishSite() {
    const records = publicationChangeSummary({
      draft: configuration,
      sponsors: loaderData.sponsors,
      published: loaderData.published,
      speakerNames: new Map(
        loaderData.programme?.speakers.map((speaker) => [
          speaker.id,
          speaker.displayName,
        ]) ?? [],
      ),
      sessionNames: new Map(
        loaderData.programme?.sessions.map((session) => [
          session.id,
          session.title,
        ]) ?? [],
      ),
    });
    confirm(
      {
        title: "Publish the public event site?",
        description:
          "The saved homepage, navigation, pages and sponsor snapshot will replace the current public site.",
        records,
        confirmLabel: "Publish public site",
        tone: "primary",
      },
      () =>
        submit(
          {
            intent: "publish-site",
            commandId: consequentialCommandId(
              sitePublishCommandKey(
                draftBase.revision,
                loaderData.published?.revision ?? null,
              ),
            ),
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
            commandId: consequentialCommandId(
              sponsorDeleteCommandKey(id, revision),
            ),
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
            commandId: consequentialCommandId(
              recordingCommandKey("publish", recording),
            ),
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
            commandId: consequentialCommandId(
              recordingCommandKey("unpublish", recording),
            ),
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
      {blocker.state === "blocked" ? (
        <ConfirmDialog
          title="Leave without saving the public site?"
          description="The homepage, page, theme, ordering or featured-record changes on this page have not been saved."
          confirmLabel="Leave and discard"
          cancelLabel="Keep editing"
          onCancel={() => blocker.reset()}
          onConfirm={() => blocker.proceed()}
        />
      ) : null}
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
          {loaderData.published ? (
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
            : "Save the homepage and page edits before changing sponsors or recording drafts. Published recordings can still be withdrawn."}
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
          event={loaderData.publicEvent}
          eventContentRevision={loaderData.publicEventContentRevision}
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
