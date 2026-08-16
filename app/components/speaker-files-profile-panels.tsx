import {
  Download,
  FileCheck2,
  LockKeyhole,
  Trash2,
  UserRound,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Form, Link, useSubmit } from "react-router";

import { DirectMultipartUpload } from "~/components/direct-multipart-upload";
import type { SpeakerPortal } from "~/components/speaker-dashboard-panel-shared";
import { SpeakerProfileHistory } from "~/components/speaker-profile-history";
import { CharacterCount } from "~/components/ui/character-count";
import { ConfirmDialog, useConfirm } from "~/components/ui/confirm-dialog";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { useUnsavedChanges } from "~/components/ui/use-unsaved-changes";
import { maximumMegabytes } from "~/modules/files/file-policy";
import {
  formatSpeakerXHandleInput,
  normalizeSpeakerLinkedinUrl,
} from "~/modules/speakers/speaker-schema";

function formatUploadTimestamp(epoch: number, timezone: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(new Date(epoch * 1_000));
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
    <section className="card pad mt" id="files">
      {dialog}
      <div className="card-title">
        <div>
          <span className="pc-section-kicker">Your private files</span>
          <h2>Files and versions</h2>
        </div>
        <FileCheck2 aria-hidden className="subtle" />
      </div>
      <p className="subtle">
        Every upload is checked and held privately. Downloads become available
        once the malware scan reports a clean result.
      </p>
      <div id="headshot-upload">
        <DirectMultipartUpload
          target={{ targetType: "person", targetId: portal.profile.id }}
          kinds={[
            {
              value: "headshot",
              label: `Headshot (JPG, PNG, WebP · ${maximumMegabytes(portal.event.filePolicy.headshotMaximumBytes)} MB)`,
              accept: "image/jpeg,image/png,image/webp",
              maximumBytes: portal.event.filePolicy.headshotMaximumBytes,
            },
            {
              value: "slides",
              label: `Presentation slides (PDF, PPT, PPTX · ${maximumMegabytes(portal.event.filePolicy.slidesMaximumBytes)} MB)`,
              accept:
                "application/pdf,application/vnd.ms-powerpoint,application/vnd.openxmlformats-officedocument.presentationml.presentation",
              maximumBytes: portal.event.filePolicy.slidesMaximumBytes,
            },
            {
              value: "supporting_document",
              label: `Supporting document (${maximumMegabytes(portal.event.filePolicy.supportingDocumentMaximumBytes)} MB)`,
              accept:
                ".pdf,.doc,.docx,.xls,.xlsx,.zip,application/pdf,application/zip",
              maximumBytes:
                portal.event.filePolicy.supportingDocumentMaximumBytes,
            },
            {
              value: "video",
              label: `Video (MP4, WebM · ${maximumMegabytes(portal.event.filePolicy.videoMaximumBytes)} MB)`,
              accept: "video/mp4,video/webm",
              maximumBytes: portal.event.filePolicy.videoMaximumBytes,
            },
          ]}
        />
      </div>
      <div className="stack mt">
        {portal.files.map((file) => (
          <div className="file-version-row" key={file.id}>
            <span className="file-kind-icon">
              <FileCheck2 aria-hidden size={17} />
            </span>
            <span>
              <strong>{file.kind.replaceAll("_", " ")}</strong>
              <small>
                {file.filename} · version {file.versionNumber ?? "—"}
              </small>
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
            {file.currentVersionId && file.downloadReleasedAt ? (
              <a
                className="icon-btn"
                href={`/participant/files/${file.id}`}
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
              <input type="hidden" name="confirm" value="erase-all-versions" />
              <button
                className="icon-btn danger"
                type="submit"
                disabled={busy}
                aria-label={`Permanently delete ${file.filename} and all versions`}
              >
                <Trash2 aria-hidden size={15} />
              </button>
            </Form>
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
        ))}
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
    portal.profile.linkedinUrl ?? "",
  );
  const [xHandle, setXHandle] = useState(
    portal.profile.xHandle ? `@${portal.profile.xHandle}` : "",
  );
  const [biography, setBiography] = useState(portal.profile.biography ?? "");
  const [travelPreferences, setTravelPreferences] = useState(
    portal.profile.travelPreferences ?? "",
  );
  const blocker = useUnsavedChanges(dirty);
  // biome-ignore lint/correctness/useExhaustiveDependencies: The persisted revision is the authoritative reset boundary even when a save normalizes to the same visible profile values.
  useEffect(() => {
    setLinkedinUrl(portal.profile.linkedinUrl ?? "");
    setXHandle(portal.profile.xHandle ? `@${portal.profile.xHandle}` : "");
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
    <section className="card pad mt" id="profile">
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
      <div className="card-title">
        <div>
          <span className="pc-section-kicker">Public identity</span>
          <h2>Profile</h2>
        </div>
        <UserRound aria-hidden className="subtle" />
      </div>
      <div className="speaker-headshot-card mb">
        {headshot ? (
          <img
            className="speaker-headshot-image"
            src={`/participant/files/${headshot.id}?view=headshot`}
            alt={`${portal.profile.name} headshot`}
          />
        ) : (
          <span className="speaker-headshot-placeholder">
            <UserRound aria-hidden size={38} />
          </span>
        )}
        <div className="stack">
          <div>
            <strong>
              {headshot ? "Current headshot" : "Add your headshot"}
            </strong>
            <p className="subtle">
              {headshot
                ? `${headshot.downloadFilename} · uploaded ${formatUploadTimestamp(headshot.downloadUploadedAt!, portal.event.timezone)}`
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
        className="stack"
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
              placeholder="https://www.linkedin.com/in/your-name"
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
              placeholder="@your_handle"
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
            placeholder="Arrival timing, accessibility, ground transport, dietary or other event logistics preferences"
          />
          <CharacterCount value={travelPreferences} maximum={2_000} />
          <span className="help">
            Private to you and authorised organisers; never shown on the public
            programme.
          </span>
        </label>
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
      </Form>
      <SpeakerProfileHistory
        revisions={portal.profileHistory}
        timeZone={portal.event.timezone}
      />
    </section>
  );
}
