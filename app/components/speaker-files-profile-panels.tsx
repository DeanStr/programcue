import {
  Download,
  FileCheck2,
  LockKeyhole,
  Trash2,
  UserRound,
} from "lucide-react";
import { Form, Link, useSubmit } from "react-router";

import { DirectMultipartUpload } from "~/components/direct-multipart-upload";
import type { SpeakerPortal } from "~/components/speaker-dashboard-panel-shared";
import { useConfirm } from "~/components/ui/confirm-dialog";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { maximumMegabytes } from "~/modules/files/file-policy";

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
      <Form method="post" className="stack">
        <input type="hidden" name="intent" value="save-profile" />
        <input type="hidden" name="revision" value={portal.profile.revision} />
        <label className="label">
          Display name
          <input
            className="field"
            name="name"
            defaultValue={portal.profile.name}
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
            />
          </label>
          <label className="label">
            Organisation
            <input
              className="field"
              name="organisationName"
              defaultValue={portal.profile.organisationName ?? ""}
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
              defaultValue={portal.profile.linkedinUrl ?? ""}
              maxLength={500}
            />
          </label>
          <label className="label">
            X handle
            <input
              className="field"
              name="xHandle"
              placeholder="@your_handle"
              defaultValue={
                portal.profile.xHandle ? `@${portal.profile.xHandle}` : ""
              }
              maxLength={16}
            />
          </label>
        </div>
        <label className="label">
          Biography
          <textarea
            className="textarea"
            name="biography"
            defaultValue={portal.profile.biography ?? ""}
            minLength={40}
            maxLength={5_000}
            required
            rows={7}
          />
        </label>
        <label className="label">
          Travel and logistics preferences
          <textarea
            className="textarea"
            name="travelPreferences"
            defaultValue={portal.profile.travelPreferences ?? ""}
            maxLength={2_000}
            rows={4}
            placeholder="Arrival timing, accessibility, ground transport, dietary or other event logistics preferences"
          />
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
        <button className="btn primary" disabled={busy}>
          Save profile
        </button>
      </Form>
    </section>
  );
}
