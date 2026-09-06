import {
  Download,
  FileCheck2,
  ListChecks,
  LockKeyhole,
  UserRound,
} from "lucide-react";
import { DirectMultipartUpload } from "~/components/direct-multipart-upload";
import { ButtonAnchor, ButtonLink } from "~/components/ui/button";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { EmptyState } from "~/components/ui/states";
import { requireValue } from "~/lib/required-value";
import { maximumMegabytes } from "~/modules/files/file-policy";

import {
  type AdminSpeakerDetailLoaderData,
  formatBytes,
  formatTimestamp,
} from "./admin-speaker-detail-presentation";

export function AdminSpeakerHeadshotPanel({
  detail,
  headshot,
}: {
  detail: AdminSpeakerDetailLoaderData["detail"];
  headshot: AdminSpeakerDetailLoaderData["detail"]["files"][number] | undefined;
}) {
  const { profile, event } = detail;
  return (
    <section className="crm-record-section" id="headshot">
      <h2>Headshot</h2>
      <div className="speaker-headshot-card">
        {headshot ? (
          <img
            className="speaker-headshot-image"
            src={`/admin/speakers/${profile.id}/files/${headshot.id}?view=headshot`}
            alt={`${profile.name} headshot`}
          />
        ) : (
          <span className="speaker-headshot-placeholder">
            <UserRound aria-hidden size={38} />
          </span>
        )}
        <div className="stack">
          <div>
            <strong>
              {headshot ? "Current released headshot" : "No released headshot"}
            </strong>
            {headshot ? (
              <p className="subtle">
                {headshot.downloadFilename} · uploaded by{" "}
                {headshot.downloadUploaderName} ·{" "}
                {formatTimestamp(
                  requireValue(
                    headshot.downloadUploadedAt,
                    "Required headshot.downloadUploadedAt is unavailable.",
                  ),
                  event.timezone,
                )}
              </p>
            ) : (
              <p className="subtle">
                Upload a JPG, PNG or WebP replacement below. It remains private
                until signature validation and malware scanning pass.
              </p>
            )}
          </div>
          {headshot ? (
            <ButtonAnchor
              href={`/admin/speakers/${profile.id}/files/${headshot.id}`}
            >
              <Download aria-hidden size={14} /> Download headshot
            </ButtonAnchor>
          ) : null}
        </div>
      </div>
      <DirectMultipartUpload
        target={{ targetType: "person", targetId: profile.id }}
        kinds={[
          {
            value: "headshot",
            label: `Headshot (JPG, PNG, WebP · ${maximumMegabytes(event.filePolicy.headshotMaximumBytes)} MB)`,
            accept: "image/jpeg,image/png,image/webp",
            maximumBytes: event.filePolicy.headshotMaximumBytes,
          },
        ]}
        heading={
          headshot ? "Replace speaker headshot" : "Upload speaker headshot"
        }
        description="Uploads stay private until format and malware checks pass."
      />
    </section>
  );
}

export function AdminSpeakerFilesPanel({
  detail,
}: {
  detail: AdminSpeakerDetailLoaderData["detail"];
}) {
  const { profile, event, files } = detail;
  return (
    <section className="crm-record-section" id="files">
      <h2>Uploaded files and versions</h2>
      <p className="subtle">
        Speaker uploads stay private to the speaker workspace. Organisers see
        the scan and release state of every stored version here and can download
        only the current released version.
      </p>
      {files.length ? (
        <div className="stack mt">
          {files.map((file) => (
            <div className="file-version-row" key={file.id}>
              <span className="file-kind-icon">
                <FileCheck2 aria-hidden size={17} />
              </span>
              <span>
                <strong>{file.kind.replaceAll("_", " ")}</strong>
                <small>
                  {file.filename ?? "No stored version"} · version{" "}
                  {file.versionNumber ?? "—"} · {formatBytes(file.sizeBytes)}
                </small>
                {file.downloadFilename && file.downloadUploadedAt ? (
                  <small>
                    Current released file: {file.downloadFilename} · uploaded by{" "}
                    {file.downloadUploaderName} ·{" "}
                    {formatTimestamp(file.downloadUploadedAt, event.timezone)}
                  </small>
                ) : null}
              </span>
              {file.scanStatus ? (
                <DomainStatusBadge domain="file" status={file.scanStatus} />
              ) : (
                <span className="status warning">No scan result</span>
              )}
              {file.currentVersionId && file.downloadReleasedAt ? (
                <ButtonAnchor
                  size="small"
                  href={`/admin/speakers/${profile.id}/files/${file.id}`}
                  aria-label={`Download released ${file.downloadFilename}`}
                >
                  <Download aria-hidden size={14} /> Download
                </ButtonAnchor>
              ) : (
                <span className="status warning">
                  <LockKeyhole aria-hidden size={13} /> Not released
                </span>
              )}
              {file.versions.length ? (
                <details className="file-history pc-disclosure">
                  <summary>
                    {file.versions.length} version
                    {file.versions.length === 1 ? "" : "s"}
                  </summary>
                  {file.versions.map((version) => (
                    <small key={version.id}>
                      v{version.versionNumber} · {version.filename} ·{" "}
                      {formatBytes(version.sizeBytes)} · scan{" "}
                      {version.scanStatus} ·{" "}
                      {version.releasedAt
                        ? `released ${formatTimestamp(version.releasedAt, event.timezone)}`
                        : "not released"}
                    </small>
                  ))}
                </details>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={FileCheck2}
          title="No uploaded files"
          description="Assign an upload task so this speaker can share headshots or slides."
          action={
            <ButtonLink to="/admin/tasks">
              <ListChecks aria-hidden size={15} /> Manage tasks
            </ButtonLink>
          }
        />
      )}
    </section>
  );
}
