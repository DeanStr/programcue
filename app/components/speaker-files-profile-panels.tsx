import {
  Download,
  FileCheck2,
  LockKeyhole,
  Trash2,
  UserRound,
} from "lucide-react";
import { Form } from "react-router";

import { DirectMultipartUpload } from "~/components/direct-multipart-upload";
import type { SpeakerPortal } from "~/components/speaker-dashboard-panel-shared";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { maximumMegabytes } from "~/modules/files/file-policy";

export function SpeakerFilesPanel({
  portal,
  busy,
}: {
  portal: SpeakerPortal;
  busy: boolean;
}) {
  return (
    <section className="card pad mt" id="files">
      <div className="card-title">
        <div>
          <span className="pc-section-kicker">Private R2 files</span>
          <h2>Files and versions</h2>
        </div>
        <FileCheck2 aria-hidden className="subtle" />
      </div>
      <p className="subtle">
        Every upload is signature-checked and quarantined. Downloads appear only
        after an external malware scanner reports a clean result.
      </p>
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
                if (
                  !window.confirm(
                    `Permanently erase ${file.filename} and all ${file.versions.length} stored version${file.versions.length === 1 ? "" : "s"}? This cannot be undone.`,
                  )
                ) {
                  event.preventDefault();
                }
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
              <details className="file-history">
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
  return (
    <section className="card pad mt" id="profile">
      <div className="card-title">
        <div>
          <span className="pc-section-kicker">Public identity</span>
          <h2>Profile</h2>
        </div>
        <UserRound aria-hidden className="subtle" />
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
        <label className="label">
          Biography
          <textarea
            className="textarea"
            name="biography"
            defaultValue={portal.profile.biography ?? ""}
            minLength={40}
            required
            rows={7}
          />
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
