import { ArrowLeft, Eye, ListChecks } from "lucide-react";

import { ButtonLink } from "~/components/ui/button";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import type { SpeakerService } from "~/modules/speakers/speaker-service.server";

type SpeakerDetail = Awaited<
  ReturnType<SpeakerService["getAdminSpeakerDetail"]>
>;

function initials(name: string) {
  return name
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join("");
}

export function AdminSpeakerDetailHeader({
  profile,
  headshot,
  sessionCount,
  outstandingTaskCount,
  fileCount,
}: {
  profile: SpeakerDetail["profile"];
  headshot: SpeakerDetail["files"][number] | undefined;
  sessionCount: number;
  outstandingTaskCount: number;
  fileCount: number;
}) {
  return (
    <div className="page-head pc-page-header">
      <div className="crm-record-hero">
        {headshot ? (
          <img
            className="crm-record-avatar"
            src={`/admin/speakers/${profile.id}/files/${headshot.id}?view=headshot`}
            alt=""
          />
        ) : (
          <span className="crm-record-avatar is-fallback">
            {initials(profile.name)}
          </span>
        )}
        <div>
          <h1>{profile.name}</h1>
          <p className="crm-caption">
            {[profile.jobTitle, profile.organisationName]
              .filter(Boolean)
              .join(" · ") || "No title or organisation recorded yet"}
          </p>
          <p className="crm-caption">{profile.email}</p>
          <div className="crm-status-line">
            <DomainStatusBadge
              domain="content"
              status={profile.profileStatus}
            />
            <span className="status">
              {sessionCount} {sessionCount === 1 ? "session" : "sessions"}
            </span>
            <span
              className={`status ${outstandingTaskCount ? "warning" : "success"}`}
            >
              {outstandingTaskCount
                ? `${outstandingTaskCount} outstanding`
                : "Ready"}
            </span>
            <span className="status">
              {fileCount} {fileCount === 1 ? "file" : "files"}
            </span>
          </div>
        </div>
      </div>
      <div className="page-actions">
        <ButtonLink to="/admin/speakers">
          <ArrowLeft aria-hidden size={15} /> Back to roster
        </ButtonLink>
        <ButtonLink to="/admin/tasks">
          <ListChecks aria-hidden size={15} /> Manage tasks
        </ButtonLink>
        <ButtonLink to={`/admin/speakers/${profile.id}/preview`}>
          <Eye aria-hidden size={15} /> Preview participant view
        </ButtonLink>
      </div>
    </div>
  );
}
