import {
  Image as ImageIcon,
  Mail,
  Monitor,
  PanelTop,
  Smartphone,
  UserRound,
} from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  data,
  Form,
  useActionData,
  useNavigation,
  useSubmit,
} from "react-router";
import { ZodError } from "zod";
import { BrandMark } from "~/components/brand-mark";
import { AdminWorkspaceTabs } from "~/components/ui/admin-workspace-tabs";
import { useConfirm } from "~/components/ui/confirm-dialog";
import { DEFAULT_EVENT_BRAND_ACCENT } from "~/lib/brand";
import {
  EVENT_BRAND_ASSET_DIMENSION_POLICY,
  EVENT_BRAND_ASSET_MAXIMUM_BYTES,
  type EventBrandAssetKind,
} from "~/modules/events/event-branding";
import {
  EventBrandingAssetError,
  EventBrandingAuditCommitError,
  EventBrandingChangeCommitError,
  EventBrandingCleanupIntegrityError,
  EventBrandingNotFoundError,
  EventBrandingProjectionCommitError,
  EventBrandingRevisionConflictError,
  EventBrandingService,
} from "~/modules/events/event-branding-service.server";
import { programmeAccentPalette } from "~/modules/programme/programme-presentation";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { notifyRouteChange } from "~/platform/realtime/route-realtime.server";
import type { Route } from "./+types/admin-branding";

export const meta: Route.MetaFunction = () => [
  { title: "Branding · Program Cue" },
];

type BrandingActionResponse = {
  ok: boolean;
  warning?: boolean;
  committed?: boolean;
  intent: "save_draft" | "upload_asset" | "publish";
  message: string;
  errors?: Record<string, string[]>;
};

const BRANDING_WORKSPACE_PANELS = [
  { id: "edit", label: "Edit branding" },
  { id: "preview", label: "Preview and publish" },
] as const;

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  return new EventBrandingService(env).getWorkspace(viewer);
}

function zodResponse(
  intent: BrandingActionResponse["intent"],
  error: ZodError,
) {
  const flattened = error.flatten();
  const errors = Object.fromEntries(
    Object.entries(flattened.fieldErrors).flatMap(([field, messages]) =>
      Array.isArray(messages) && messages.length
        ? [[field, messages.map(String)]]
        : [],
    ),
  );
  return data<BrandingActionResponse>(
    {
      ok: false,
      intent,
      message: error.issues[0]?.message ?? "Review the branding draft.",
      errors,
    },
    { status: 422 },
  );
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
  const formData = await request.formData();
  const rawIntent = String(formData.get("_intent") ?? "");
  if (
    rawIntent !== "save_draft" &&
    rawIntent !== "upload_asset" &&
    rawIntent !== "publish"
  )
    return data<BrandingActionResponse>(
      {
        ok: false,
        intent: "save_draft",
        message: "Unknown branding action.",
      },
      { status: 400 },
    );
  const intent: BrandingActionResponse["intent"] = rawIntent;
  const service = new EventBrandingService(env);
  try {
    const result =
      intent === "upload_asset"
        ? await service.uploadDraftAsset(viewer, {
            kind: formData.get("kind"),
            revision: formData.get("revision"),
            file: formData.get("file"),
          })
        : intent === "publish"
          ? await service.publish(viewer, {
              revision: formData.get("revision"),
              confirmed: formData.get("confirmed"),
            })
          : await service.saveDraft(viewer, {
              revision: formData.get("revision"),
              accent: formData.get("accent"),
              logoAssetId: formData.get("logoAssetId"),
              bannerAssetId: formData.get("bannerAssetId"),
              welcomeText: formData.get("welcomeText"),
              supportUrl: formData.get("supportUrl"),
            });
    const realtimeFailure =
      result.changeSequence === 0
        ? null
        : await notifyRouteChange(
            env,
            viewer,
            result.changeSequence,
            viewer.eventId,
          );
    const baseMessage =
      intent === "upload_asset"
        ? `${String(formData.get("kind")) === "banner" ? "Banner" : "Logo"} uploaded to the private branding draft.`
        : intent === "publish"
          ? "Branding published to the application, participant workspace, programme and email templates."
          : "Branding draft saved. Public surfaces are unchanged until you publish it.";
    return data<BrandingActionResponse>(
      {
        ok: true,
        warning: Boolean(realtimeFailure),
        committed: true,
        intent,
        message: realtimeFailure
          ? `${baseMessage} ${realtimeFailure.message}`
          : baseMessage,
      },
      realtimeFailure ? { status: 207 } : undefined,
    );
  } catch (error) {
    if (error instanceof ZodError) return zodResponse(intent, error);
    if (error instanceof EventBrandingRevisionConflictError)
      return data<BrandingActionResponse>(
        { ok: false, intent, message: error.message },
        { status: 409 },
      );
    if (error instanceof EventBrandingProjectionCommitError)
      return data<BrandingActionResponse>(
        {
          ok: true,
          warning: true,
          committed: error.committed,
          intent,
          message: error.message,
        },
        { status: 207 },
      );
    if (
      error instanceof EventBrandingAuditCommitError ||
      error instanceof EventBrandingChangeCommitError
    )
      return data<BrandingActionResponse>(
        {
          ok: true,
          warning: true,
          committed: error.committed,
          intent,
          message: error.message,
        },
        { status: 207 },
      );
    if (error instanceof EventBrandingCleanupIntegrityError)
      return data<BrandingActionResponse>(
        { ok: false, intent, message: error.message },
        { status: 503 },
      );
    if (
      error instanceof EventBrandingAssetError ||
      error instanceof EventBrandingNotFoundError
    )
      return data<BrandingActionResponse>(
        { ok: false, intent, message: error.message },
        { status: error instanceof EventBrandingNotFoundError ? 404 : 422 },
      );
    throw error;
  }
}

type PreviewSurface = "application" | "participant" | "programme" | "email";

function BrandingPreview({
  eventName,
  accent,
  logoUrl,
  bannerUrl,
  welcomeText,
  compact,
  onViewportChange,
  publicationStatus,
  footer,
}: {
  eventName: string;
  accent: string;
  logoUrl: string | null;
  bannerUrl: string | null;
  welcomeText: string;
  compact: boolean;
  onViewportChange(mobile: boolean): void;
  publicationStatus: "published" | "unpublished";
  footer: ReactNode;
}) {
  const [surface, setSurface] = useState<PreviewSurface>("programme");
  const palette = programmeAccentPalette(accent);
  const surfaces: Array<{
    id: PreviewSurface;
    label: string;
    icon: typeof PanelTop;
  }> = [
    { id: "application", label: "Application", icon: ImageIcon },
    { id: "participant", label: "Participant", icon: UserRound },
    { id: "programme", label: "Programme", icon: PanelTop },
    { id: "email", label: "Email", icon: Mail },
  ];
  const brand = logoUrl ? (
    <img src={logoUrl} alt="" className="branding-preview-logo" />
  ) : (
    <BrandMark />
  );
  return (
    <section className="branding-preview">
      <div className="branding-preview-chrome">
        <div className="branding-preview-chrome-bar">
          <div className="branding-preview-chrome-title">
            <div>
              <h2>Draft preview</h2>
              <p className="help">Uses only saved assets.</p>
            </div>
            <span
              className={
                publicationStatus === "unpublished"
                  ? "status warning"
                  : "status ok"
              }
            >
              {publicationStatus === "unpublished"
                ? "Unpublished changes"
                : "Published"}
            </span>
          </div>
          <fieldset
            className="branding-preview-devices pc-plain-fieldset"
            aria-label="Preview viewport"
          >
            <button
              className={!compact ? "is-active" : undefined}
              type="button"
              aria-pressed={!compact}
              onClick={() => onViewportChange(false)}
            >
              <Monitor aria-hidden size={15} />
              Desktop
            </button>
            <button
              className={compact ? "is-active" : undefined}
              type="button"
              aria-pressed={compact}
              onClick={() => onViewportChange(true)}
            >
              <Smartphone aria-hidden size={15} />
              Mobile
            </button>
          </fieldset>
        </div>
        <fieldset
          className="branding-preview-surfaces pc-plain-fieldset"
          aria-label="Brand preview surface"
        >
          {surfaces.map((item) => (
            <button
              className={surface === item.id ? "is-active" : undefined}
              key={item.id}
              type="button"
              aria-pressed={surface === item.id}
              onClick={() => setSurface(item.id)}
            >
              <item.icon aria-hidden size={14} /> {item.label}
            </button>
          ))}
        </fieldset>
      </div>
      <div className="branding-preview-stage">
        <div
          className={`branding-preview-frame${compact ? " is-mobile" : ""}`}
          style={
            {
              "--event-accent": palette.accent,
              "--accent-ink": palette.ink,
              "--accent-on-solid": palette.onAccent,
            } as CSSProperties
          }
        >
          {surface === "email" ? (
            <div className="branding-email-preview">
              <div className="branding-email-card">
                <div className="branding-preview-identity">
                  {brand}
                  <strong>{eventName}</strong>
                </div>
                <h3>Your event update</h3>
                <p>Here is the latest information from {eventName}.</p>
                <span className="branding-preview-action">View details</span>
                <small>Sent with Program Cue</small>
              </div>
            </div>
          ) : (
            <div className={`branding-surface-preview is-${surface}`}>
              <header>
                <div className="branding-preview-identity">
                  {brand}
                  <strong>{eventName}</strong>
                </div>
                <span>
                  {surface === "participant" ? "Program Cue" : "Programme"}
                </span>
              </header>
              {bannerUrl && surface === "programme" ? (
                <img
                  className="branding-preview-banner"
                  src={bannerUrl}
                  alt=""
                />
              ) : null}
              <div className="branding-preview-content">
                <p className="branding-preview-kicker">
                  {surface === "application"
                    ? "Call for speakers"
                    : surface === "participant"
                      ? "Participant workspace"
                      : "Published programme"}
                </p>
                <h3>
                  {surface === "application"
                    ? "Share your session"
                    : surface === "participant"
                      ? `Welcome to ${eventName}`
                      : eventName}
                </h3>
                <p>
                  {welcomeText ||
                    "Event information and next steps appear here."}
                </p>
                <span className="branding-preview-action">
                  {surface === "application"
                    ? "Start application"
                    : "View details"}
                </span>
              </div>
              <footer>Powered by Program Cue</footer>
            </div>
          )}
        </div>
      </div>
      {footer}
    </section>
  );
}

function AssetUpload({
  kind,
  revision,
  asset,
  disabled,
  onRemove,
  removeDisabled,
}: {
  kind: EventBrandAssetKind;
  revision: number;
  asset: {
    filename: string;
    sizeBytes: number;
    width: number;
    height: number;
    url: string;
  } | null;
  disabled: boolean;
  onRemove?: () => void;
  removeDisabled?: boolean;
}) {
  const title = kind === "logo" ? "Logo" : "Banner";
  const inputId = `branding-${kind}-upload`;
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const prompt = selectedName
    ? selectedName
    : asset
      ? `Replace ${kind}`
      : `Add ${kind}`;
  return (
    <div className={`branding-asset is-${kind}`}>
      <div className="branding-asset-heading">
        <h3>{title}</h3>
        <p className="help">
          JPEG, PNG or WebP · up to{" "}
          {EVENT_BRAND_ASSET_MAXIMUM_BYTES[kind] / 1_048_576} MB · maximum{" "}
          {EVENT_BRAND_ASSET_DIMENSION_POLICY[kind].maximumWidth} ×{" "}
          {EVENT_BRAND_ASSET_DIMENSION_POLICY[kind].maximumHeight} px
        </p>
      </div>
      <Form
        method="post"
        encType="multipart/form-data"
        className="branding-upload-form"
      >
        <input type="hidden" name="_intent" value="upload_asset" />
        <input type="hidden" name="kind" value={kind} />
        <input type="hidden" name="revision" value={revision} />
        <div
          className={`branding-dropzone is-${kind}${asset ? " has-asset" : ""}${selectedName ? " has-selection" : ""}`}
        >
          <div className="branding-dropzone-target">
            <input
              id={inputId}
              className="branding-file-input"
              type="file"
              name="file"
              accept="image/jpeg,image/png,image/webp"
              required
              disabled={disabled}
              aria-label={`Choose ${kind} image`}
              onChange={(event) =>
                setSelectedName(event.currentTarget.files?.[0]?.name ?? null)
              }
            />
            {selectedName ? null : asset ? (
              <img src={asset.url} alt={`Current draft ${kind}`} />
            ) : (
              <span className="branding-dropzone-mark" aria-hidden="true" />
            )}
            <p className="branding-dropzone-prompt">{prompt}</p>
          </div>
          <button
            className={selectedName ? "btn small" : "sr-only"}
            type="submit"
            disabled={disabled || !selectedName}
          >
            {asset ? `Replace ${kind}` : `Upload ${kind}`}
          </button>
          {asset && onRemove && !selectedName ? (
            <button
              className="btn small"
              type="button"
              onClick={onRemove}
              disabled={removeDisabled}
            >
              Remove {kind} from draft
            </button>
          ) : null}
        </div>
        {asset ? (
          <p className="branding-asset-current">
            {asset.filename} · {asset.width} × {asset.height} px ·{" "}
            {(asset.sizeBytes / 1_048_576).toFixed(1)} MB
          </p>
        ) : null}
      </Form>
    </div>
  );
}

export default function AdminBranding({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>() as
    | BrandingActionResponse
    | undefined;
  const navigation = useNavigation();
  const submit = useSubmit();
  const { confirm, dialog } = useConfirm();
  const { draft, published } = loaderData;
  const [accent, setAccent] = useState(draft.accent);
  const [welcomeText, setWelcomeText] = useState(draft.welcomeText ?? "");
  const [supportUrl, setSupportUrl] = useState(draft.supportUrl ?? "");
  const [logoAssetId, setLogoAssetId] = useState(draft.logoAssetId ?? "");
  const [bannerAssetId, setBannerAssetId] = useState(draft.bannerAssetId ?? "");
  const [mobilePreview, setMobilePreview] = useState(false);
  const [workspacePanel, setWorkspacePanel] = useState<"edit" | "preview">(
    "edit",
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: Event identity and persisted revision deliberately reset local branding edits even when the saved field values match.
  useEffect(() => {
    setAccent(draft.accent);
    setWelcomeText(draft.welcomeText ?? "");
    setSupportUrl(draft.supportUrl ?? "");
    setLogoAssetId(draft.logoAssetId ?? "");
    setBannerAssetId(draft.bannerAssetId ?? "");
  }, [
    draft.accent,
    draft.bannerAssetId,
    draft.logoAssetId,
    draft.revision,
    draft.supportUrl,
    draft.welcomeText,
    loaderData.event.slug,
  ]);
  const unsaved = useMemo(
    () =>
      accent !== draft.accent ||
      welcomeText !== (draft.welcomeText ?? "") ||
      supportUrl !== (draft.supportUrl ?? "") ||
      logoAssetId !== (draft.logoAssetId ?? "") ||
      bannerAssetId !== (draft.bannerAssetId ?? ""),
    [accent, bannerAssetId, draft, logoAssetId, supportUrl, welcomeText],
  );
  const busy = navigation.state !== "idle";
  const logoUrl =
    logoAssetId === draft.logoAssetId ? (draft.logo?.url ?? null) : null;
  const bannerUrl =
    bannerAssetId === draft.bannerAssetId ? (draft.banner?.url ?? null) : null;

  function publish() {
    confirm(
      {
        title: "Publish event branding?",
        description:
          "The saved draft will immediately replace the branding on every public and participant surface.",
        records: [
          "Public application",
          "Participant workspace",
          "Published programme and embeds",
          "Communication email templates",
        ],
        confirmLabel: "Publish branding",
      },
      () =>
        submit(
          {
            _intent: "publish",
            revision: String(draft.revision),
            confirmed: "true",
          },
          { method: "post" },
        ),
    );
  }

  return (
    <>
      {dialog}
      <div className="page-head branding-page-head">
        <div>
          <h1>Branding</h1>
          <p>
            Preview one event identity, save it as a draft, then publish it to
            every participant-facing surface.
          </p>
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

      <AdminWorkspaceTabs<"edit" | "preview">
        className="branding-mobile-surfaces"
        label="Branding workspace view"
        panels={BRANDING_WORKSPACE_PANELS}
        activePanel={workspacePanel}
        onChange={setWorkspacePanel}
      />

      <div className={`branding-workspace is-${workspacePanel}`}>
        <div className="branding-editor-stack">
          <Form method="post" className="card pad branding-identity">
            <input type="hidden" name="_intent" value="save_draft" />
            <input type="hidden" name="revision" value={draft.revision} />
            <input type="hidden" name="logoAssetId" value={logoAssetId} />
            <input type="hidden" name="bannerAssetId" value={bannerAssetId} />
            <header className="branding-editor-head">
              <div>
                <h2>Identity draft</h2>
                <p className="help">
                  Draft {draft.revision} · published {published.revision}
                </p>
              </div>
            </header>
            <div className="branding-accent-field">
              <label className="label" htmlFor="branding-accent">
                Brand accent
              </label>
              <div className="branding-accent-control">
                <span
                  className="branding-accent-swatch"
                  style={{
                    background: /^#[0-9a-f]{6}$/i.test(accent)
                      ? accent
                      : DEFAULT_EVENT_BRAND_ACCENT,
                  }}
                >
                  <input
                    type="color"
                    aria-label="Brand accent colour picker"
                    value={
                      /^#[0-9a-f]{6}$/i.test(accent)
                        ? accent
                        : DEFAULT_EVENT_BRAND_ACCENT
                    }
                    onChange={(event) => setAccent(event.target.value)}
                  />
                </span>
                <input
                  id="branding-accent"
                  className="branding-accent-hex"
                  name="accent"
                  value={accent}
                  pattern="#[0-9a-fA-F]{6}"
                  maxLength={7}
                  spellCheck={false}
                  autoComplete="off"
                  required
                  onChange={(event) => setAccent(event.target.value)}
                />
              </div>
            </div>
            <label className="label">
              Welcome message
              <textarea
                className="textarea"
                name="welcomeText"
                maxLength={500}
                value={welcomeText}
                onChange={(event) => setWelcomeText(event.target.value)}
                placeholder="Welcome. Use this workspace to manage your application and event preparation."
              />
            </label>
            <label className="label">
              Support URL
              <input
                className="field"
                name="supportUrl"
                type="url"
                maxLength={2048}
                placeholder="https://example.org/help"
                value={supportUrl}
                onChange={(event) => setSupportUrl(event.target.value)}
              />
            </label>
            <div className="branding-identity-actions">
              <p className="help">
                {unsaved
                  ? "Unsaved draft changes"
                  : "Draft matches the last save"}
              </p>
              <button
                className="btn primary"
                type="submit"
                disabled={!unsaved || busy}
              >
                {busy && navigation.formData?.get("_intent") === "save_draft"
                  ? "Saving…"
                  : "Save draft"}
              </button>
            </div>
          </Form>

          <section className="card pad branding-images">
            <header className="branding-editor-head">
              <div>
                <h2>Brand images</h2>
                <p className="help">
                  Image bytes are validated and kept in private file storage.
                  Only published selections are available publicly.
                </p>
              </div>
            </header>
            {unsaved ? (
              <p className="validation-item warning">
                Save the text and colour draft before uploading an image.
              </p>
            ) : null}
            <AssetUpload
              kind="logo"
              revision={draft.revision}
              asset={draft.logo}
              disabled={unsaved || busy}
              onRemove={draft.logo ? () => setLogoAssetId("") : undefined}
              removeDisabled={busy}
            />
            <AssetUpload
              kind="banner"
              revision={draft.revision}
              asset={draft.banner}
              disabled={unsaved || busy}
              onRemove={draft.banner ? () => setBannerAssetId("") : undefined}
              removeDisabled={busy}
            />
          </section>
        </div>

        <div className="branding-preview-stack">
          <BrandingPreview
            eventName={loaderData.event.name}
            accent={accent}
            logoUrl={logoUrl}
            bannerUrl={bannerUrl}
            welcomeText={welcomeText}
            compact={mobilePreview}
            onViewportChange={setMobilePreview}
            publicationStatus={
              loaderData.hasUnpublishedChanges ? "unpublished" : "published"
            }
            footer={
              <div className="branding-preview-commit">
                <p className="help">Publishing is explicit and audited.</p>
                <button
                  className="btn primary"
                  type="button"
                  disabled={
                    unsaved || busy || !loaderData.hasUnpublishedChanges
                  }
                  onClick={publish}
                >
                  Publish branding
                </button>
              </div>
            }
          />
        </div>
      </div>
    </>
  );
}
