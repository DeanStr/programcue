import { Download, FileCheck2, LockKeyhole, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Form, Link, useSubmit } from "react-router";
import { DirectMultipartUpload } from "~/components/direct-multipart-upload";
import type { SpeakerPortal } from "~/components/speaker-dashboard-panel-shared";
import { SpeakerProfileHistory } from "~/components/speaker-profile-history";
import { CharacterCount } from "~/components/ui/character-count";
import { ConfirmDialog, useConfirm } from "~/components/ui/confirm-dialog";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { useUnsavedChanges } from "~/components/ui/use-unsaved-changes";
import { requireValue } from "~/lib/required-value";
import { maximumMegabytes } from "~/modules/files/file-policy";
import {
  formatSpeakerXHandleInput,
  normalizeSpeakerLinkedinUrl,
} from "~/modules/speakers/speaker-schema";

function isPlaceholderLinkedin(value: string | null | undefined) {
  if (!value?.trim()) return true;
  return /linkedin\.com\/in\/your-name\/?$/iu.test(value.trim());
}

function isPlaceholderXHandle(value: string | null | undefined) {
  if (!value?.trim()) return true;
  return value.replace(/^@/u, "").trim().toLowerCase() === "your_handle";
}

function visibleLinkedinUrl(value: string | null | undefined) {
  return isPlaceholderLinkedin(value) ? "" : (value ?? "");
}

function visibleXHandle(value: string | null | undefined) {
  if (isPlaceholderXHandle(value)) return "";
  return value ? `@${value.replace(/^@/u, "")}` : "";
}

function formatUploadTimestamp(epoch: number, timezone: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(new Date(epoch * 1_000));
}

export function speakerFileDownloadHref(
  assetId: string,
  targetType: string,
  versionId: string,
) {
  const encodedAssetId = encodeURIComponent(assetId);
  return targetType === "task"
    ? `/participant/tasks/files/${encodedAssetId}/${encodeURIComponent(versionId)}`
    : `/participant/files/${encodedAssetId}`;
}

export function SpeakerFilesPanel({
  portal,
  busy,
}: {
  portal: SpeakerPortal;
  busy: boolean;
}) {
  const submit = useSubmit();
  const { confirm, dialog } = useConfirm();
  return (
    <section
      className="speaker-work speaker-files"
      id="files"
      aria-label="Private files"
    >
      {dialog}
      <div className="speaker-files-toolbar" id="headshot-upload">
        <DirectMultipartUpload
          target={{ targetType: "person", targetId: portal.profile.id }}
          kinds={[
            {
              value: "headshot",
              label: `Headshot (JPG, PNG, WebP · ${maximumMegabytes(portal.event.filePolicy.headshotMaximumBytes)} MB)`,
              accept: "image/jpeg,image/png,image/webp",
              maximumBytes: portal.event.filePolicy.headshotMaximumBytes,
            },
          ]}
          heading="Upload a headshot"
          description="Headshots are reusable profile media. Upload slides, handouts, posters and session videos from the corresponding task; completed uploads are also listed here."
        />
      </div>
      <div className="speaker-work-list">
        {portal.files.length ? (
          portal.files.map((file) => (
            <div className="file-version-row" key={file.id}>
              <FileCheck2 aria-hidden className="pc-index-icon" size={16} />
              <span className="speaker-file-copy">
                <strong className="pc-index-label">
                  {file.kind === "task_evidence"
                    ? "Task deliverable"
                    : file.kind.replaceAll("_", " ")}
                </strong>
                <small>
                  {file.filename} · version {file.versionNumber ?? "—"}
                </small>
                {file.taskTitle ? (
                  <small>
                    Requested by task: {file.taskTitle}
                    {file.sessionTitle ? ` · ${file.sessionTitle}` : ""}
                  </small>
                ) : null}
                {file.downloadFilename && file.downloadUploadedAt ? (
                  <small>
                    Current released file: {file.downloadFilename} · uploaded by{" "}
                    {file.downloadUploaderName} ·{" "}
                    {formatUploadTimestamp(
                      file.downloadUploadedAt,
                      portal.event.timezone,
                    )}
                  </small>
                ) : null}
              </span>
              <DomainStatusBadge
                domain="file"
                status={file.scanStatus ?? file.status}
              />
              <span className="speaker-file-actions">
                {file.currentVersionId && file.downloadReleasedAt ? (
                  <a
                    className="icon-btn"
                    href={speakerFileDownloadHref(
                      file.id,
                      file.targetType,
                      file.currentVersionId,
                    )}
                    aria-label={`Download ${file.downloadFilename}`}
                  >
                    <Download aria-hidden size={15} />
                  </a>
                ) : (
                  <LockKeyhole
                    aria-label="Download locked pending scan"
                    size={15}
                    className="subtle"
                  />
                )}
                {file.targetType !== "task" ? (
                  <Form
                    method="post"
                    onSubmit={(event) => {
                      event.preventDefault();
                      const form = event.currentTarget;
                      confirm(
                        {
                          title: `Permanently erase ${file.filename}?`,
                          description: `Every stored version of this ${file.kind.replaceAll("_", " ")} is erased from private storage. This cannot be undone.`,
                          records: file.versions.map(
                            (version) =>
                              `v${version.versionNumber} · ${version.filename}`,
                          ),
                          confirmLabel: "Erase all versions",
                        },
                        () => submit(form),
                      );
                    }}
                  >
                    <input type="hidden" name="intent" value="delete-file" />
                    <input type="hidden" name="assetId" value={file.id} />
                    <input
                      type="hidden"
                      name="confirm"
                      value="erase-all-versions"
                    />
                    <button
                      className="icon-btn danger"
                      type="submit"
                      disabled={busy}
                      aria-label={`Permanently delete ${file.filename} and all versions`}
                    >
                      <Trash2 aria-hidden size={15} />
                    </button>
                  </Form>
                ) : null}
              </span>
              {file.versions.length > 1 ? (
                <details className="file-history pc-disclosure">
                  <summary>{file.versions.length} versions</summary>
                  {file.versions.map((version) => (
                    <small key={version.id}>
                      v{version.versionNumber} · {version.filename} · scan{" "}
                      {version.scanStatus}
                    </small>
                  ))}
                </details>
              ) : null}
            </div>
          ))
        ) : (
          <p className="speaker-library-empty">No private files yet.</p>
        )}
      </div>
    </section>
  );
}

export function SpeakerProfilePanel({
  portal,
  busy,
}: {
  portal: SpeakerPortal;
  busy: boolean;
}) {
  const [dirty, setDirty] = useState(false);
  const [linkedinUrl, setLinkedinUrl] = useState(
    visibleLinkedinUrl(portal.profile.linkedinUrl),
  );
  const [xHandle, setXHandle] = useState(
    visibleXHandle(portal.profile.xHandle),
  );
  const [biography, setBiography] = useState(portal.profile.biography ?? "");
  const [travelPreferences, setTravelPreferences] = useState(
    portal.profile.travelPreferences ?? "",
  );
  const blocker = useUnsavedChanges(dirty);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The persisted revision is the authoritative reset boundary even when a save normalizes to the same visible profile values.
  useEffect(() => {
    setLinkedinUrl(visibleLinkedinUrl(portal.profile.linkedinUrl));
    setXHandle(visibleXHandle(portal.profile.xHandle));
    setBiography(portal.profile.biography ?? "");
    setTravelPreferences(portal.profile.travelPreferences ?? "");
    setDirty(false);
  }, [
    portal.profile.biography,
    portal.profile.linkedinUrl,
    portal.profile.revision,
    portal.profile.travelPreferences,
    portal.profile.xHandle,
  ]);
  const headshot = portal.files.find(
    (file) =>
      file.kind === "headshot" &&
      file.targetType === "person" &&
      file.targetId === portal.profile.id &&
      file.currentVersionId &&
      file.downloadReleasedAt &&
      file.downloadUploadedAt &&
      file.downloadFilename &&
      file.downloadUploaderName,
  );
  return (
    <section className="mt speaker-work speaker-profile" id="profile">
      {blocker.state === "blocked" ? (
        <ConfirmDialog
          title="Leave without saving your profile?"
          description="Your profile changes have not been saved. Leaving discards them."
          confirmLabel="Leave and discard"
          cancelLabel="Keep editing"
          onCancel={() => blocker.reset()}
          onConfirm={() => blocker.proceed()}
        />
      ) : null}
      <div className="speaker-headshot-card">
        {headshot ? (
          <img
            className="speaker-headshot-image"
            src={`/participant/files/${headshot.id}?view=headshot`}
            alt={`${portal.profile.name} headshot`}
          />
        ) : portal.profile.programmePortraitUrl ? (
          <img
            className="speaker-headshot-image"
            src={portal.profile.programmePortraitUrl}
            alt={`${portal.profile.name} programme portrait`}
          />
        ) : (
          <span className="speaker-headshot-placeholder">
            <span>No portrait yet</span>
          </span>
        )}
        <div className="stack">
          <div>
            <strong>
              {headshot
                ? "Current headshot"
                : portal.profile.programmePortraitUrl
                  ? "Programme portrait in use"
                  : "Add your headshot"}
            </strong>
            <p className="subtle">
              {headshot
                ? `${headshot.downloadFilename} · uploaded ${formatUploadTimestamp(requireValue(headshot.downloadUploadedAt, "Required headshot.downloadUploadedAt is unavailable."), portal.event.timezone)}`
                : portal.profile.programmePortraitUrl
                  ? "Attendees already see this bundled programme portrait. Upload a headshot to replace it."
                  : "Upload a JPG, PNG or WebP file for organiser review and your published profile."}
            </p>
          </div>
          <Link className="btn" to="/participant/files#headshot-upload">
            {headshot ? "Replace headshot" : "Upload headshot"}
          </Link>
        </div>
      </div>
      <Form
        method="post"
        className="speaker-profile-form"
        key={portal.profile.revision}
        onChange={() => setDirty(true)}
      >
        <input type="hidden" name="intent" value="save-profile" />
        <input type="hidden" name="revision" value={portal.profile.revision} />
        <label className="label">
          <span className="pc-field-label">
            <span>Display name</span>
            <span className="pc-required" aria-hidden="true">
              Required
            </span>
          </span>
          <input
            className="field"
            name="name"
            defaultValue={portal.profile.name}
            autoComplete="name"
            required
          />
        </label>
        <div className="form-row">
          <label className="label">
            Job title
            <input
              className="field"
              name="jobTitle"
              defaultValue={portal.profile.jobTitle ?? ""}
              autoComplete="organization-title"
            />
          </label>
          <label className="label">
            Organisation
            <input
              className="field"
              name="organisationName"
              defaultValue={portal.profile.organisationName ?? ""}
              autoComplete="organization"
            />
          </label>
        </div>
        <label className="label">
          Name pronunciation
          <input
            className="field"
            name="pronunciation"
            defaultValue={portal.profile.pronunciation ?? ""}
          />
        </label>
        <div className="form-row">
          <label className="label">
            LinkedIn profile URL
            <input
              className="field"
              name="linkedinUrl"
              type="url"
              inputMode="url"
              value={linkedinUrl}
              onChange={(event) => setLinkedinUrl(event.currentTarget.value)}
              onBlur={() =>
                setLinkedinUrl(normalizeSpeakerLinkedinUrl(linkedinUrl))
              }
              maxLength={500}
            />
          </label>
          <label className="label">
            X handle
            <input
              className="field"
              name="xHandle"
              value={xHandle}
              onChange={(event) => setXHandle(event.currentTarget.value)}
              onBlur={() => setXHandle(formatSpeakerXHandleInput(xHandle))}
              maxLength={500}
            />
          </label>
        </div>
        <label className="label">
          <span className="pc-field-label">
            <span>Biography</span>
            <span className="pc-required" aria-hidden="true">
              Required
            </span>
          </span>
          <textarea
            className="textarea"
            name="biography"
            value={biography}
            onChange={(event) => setBiography(event.currentTarget.value)}
            minLength={40}
            maxLength={5_000}
            required
            rows={7}
          />
          <CharacterCount value={biography} maximum={5_000} />
        </label>
        <label className="label">
          Travel and logistics preferences
          <textarea
            className="textarea"
            name="travelPreferences"
            value={travelPreferences}
            onChange={(event) =>
              setTravelPreferences(event.currentTarget.value)
            }
            maxLength={2_000}
            rows={4}
          />
          <CharacterCount value={travelPreferences} maximum={2_000} />
          <span className="help">
            Private to you and authorised organisers; never shown on the public
            programme.
          </span>
        </label>
        <div className="speaker-profile-commit">
          <label className="speaker-confirm">
            <input
              type="checkbox"
              name="publish"
              defaultChecked={portal.profile.profileStatus === "published"}
            />{" "}
            Publish this profile when saved
          </label>
          <button type="submit" className="btn primary" disabled={busy}>
            Save profile
          </button>
          <span className={`status ${dirty ? "warning" : "success"}`}>
            {dirty ? "Unsaved changes" : "Saved"}
          </span>
        </div>
      </Form>
      <SpeakerProfileHistory
        revisions={portal.profileHistory}
        timeZone={portal.event.timezone}
      />
    </section>
  );
}
