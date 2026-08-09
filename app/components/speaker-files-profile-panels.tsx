import {
  Download,
  FileCheck2,
  LockKeyhole,
  UploadCloud,
  UserRound,
} from "lucide-react";
import { Form } from "react-router";

import {
  speakerStatusClass,
  type SpeakerPortal,
} from "~/components/speaker-dashboard-panel-shared";

export function SpeakerFilesAndProfilePanels({
  portal,
  busy,
}: {
  portal: SpeakerPortal;
  busy: boolean;
}) {
  return (
    <div className="grid grid-2 mt">
      <section className="card pad" id="files">
        <div className="card-title">
          <div>
            <span className="pc-section-kicker">Private R2 files</span>
            <h2>Files and versions</h2>
          </div>
          <FileCheck2 aria-hidden className="subtle" />
        </div>
        <p className="subtle">
          Every upload is signature-checked and quarantined. Downloads appear
          only after an external malware scanner reports a clean result.
        </p>
        <Form
          method="post"
          encType="multipart/form-data"
          className="stack speaker-upload-form"
        >
          <input type="hidden" name="intent" value="upload-file" />
          <label className="label">
            File purpose
            <select className="select" name="assetKind" defaultValue="headshot">
              <option value="headshot">
                Headshot (JPG, PNG, WebP · 10 MB)
              </option>
              <option value="slides">
                Presentation slides (PDF, PPT, PPTX · 90 MB)
              </option>
              <option value="supporting_document">
                Supporting document (90 MB)
              </option>
            </select>
          </label>
          <label className="label">
            Choose file
            <input className="field" name="file" type="file" required />
          </label>
          <button className="btn primary" disabled={busy}>
            <UploadCloud aria-hidden size={15} /> Upload privately
          </button>
        </Form>
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
              <span
                className={`status ${speakerStatusClass(file.scanStatus ?? file.status)}`}
              >
                {file.scanStatus === "pending"
                  ? "Quarantined"
                  : (file.scanStatus ?? file.status)}
              </span>
              {file.currentVersionId && file.downloadReleasedAt ? (
                <a
                  className="icon-btn"
                  href={`/speaker/files/${file.id}`}
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

      <section className="card pad" id="profile">
        <div className="card-title">
          <div>
            <span className="pc-section-kicker">Public identity</span>
            <h2>Speaker profile</h2>
          </div>
          <UserRound aria-hidden className="subtle" />
        </div>
        <Form method="post" className="stack">
          <input type="hidden" name="intent" value="save-profile" />
          <input
            type="hidden"
            name="revision"
            value={portal.profile.revision}
          />
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
    </div>
  );
}
