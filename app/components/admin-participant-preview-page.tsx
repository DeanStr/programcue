import {
  ArrowLeft,
  BookOpen,
  CalendarClock,
  ClipboardList,
  Eye,
  FileStack,
  ListChecks,
  Mic2,
  UserRound,
} from "lucide-react";
import { ButtonLink } from "~/components/ui/button";
import type { getAdminParticipantPreview } from "~/modules/speakers/admin-participant-preview.server";

type Preview = Awaited<ReturnType<typeof getAdminParticipantPreview>>;

function label(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/^./u, (letter) => letter.toUpperCase());
}

function dateTime(epoch: number, timezone: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(new Date(epoch * 1_000));
}

function PreviewCount({ value, label }: { value: number; label: string }) {
  return (
    <span className="participant-preview-count">
      <b>{value}</b> {label}
    </span>
  );
}

export function AdminParticipantPreviewPage({ preview }: { preview: Preview }) {
  const backHref =
    preview.available && preview.participantRole === "submitter"
      ? "/admin/speakers"
      : `/admin/speakers/${encodeURIComponent(
          preview.available ? preview.portal.profile.id : preview.person.id,
        )}`;
  const backLabel =
    preview.available && preview.participantRole === "submitter"
      ? "Back to speakers"
      : "Back to speaker";
  if (!preview.available) {
    return (
      <div className="stack">
        <div className="page-head pc-page-header">
          <div>
            <p className="eyebrow">Participant support preview</p>
            <h1>{preview.person.name}</h1>
          </div>
          <ButtonLink to={backHref}>
            <ArrowLeft aria-hidden size={15} /> {backLabel}
          </ButtonLink>
        </div>
        <div className="empty-state">
          <UserRound aria-hidden size={24} />
          <h2>No participant workspace yet</h2>
          <p>
            {preview.person.name} does not have accepted speaker or submitter
            access for {preview.event.name}. Invite or accept the participant
            before previewing their workspace.
          </p>
        </div>
      </div>
    );
  }

  const { portal } = preview;
  const participantName = portal.profile.name ?? "Participant";
  return (
    <div className="participant-preview stack">
      <div className="page-head pc-page-header">
        <div>
          <p className="eyebrow">Participant support preview</p>
          <h1>{participantName}</h1>
          <p>
            Read-only view of the data this participant can currently access.
          </p>
        </div>
        <ButtonLink to={backHref}>
          <ArrowLeft aria-hidden size={15} /> {backLabel}
        </ButtonLink>
      </div>

      <div className="validation-item info" role="status">
        <Eye aria-hidden size={18} />
        <span>
          <strong>Preview only</strong>
          <br />
          You remain signed in as an organiser. Editing, downloads,
          acknowledgements and task actions are disabled here.
        </span>
      </div>

      <section
        className="participant-preview-frame"
        aria-label="Participant workspace preview"
      >
        <header className="participant-preview-identity">
          <div>
            <p className="eyebrow">{portal.event.name}</p>
            <h2>{participantName}</h2>
            <p className="subtle">{portal.profile.email}</p>
          </div>
          <span className="status info">{label(preview.participantRole)}</span>
        </header>

        <nav
          className="participant-preview-nav"
          aria-label="Previewed participant sections"
        >
          <span>
            <UserRound aria-hidden size={15} /> Overview
          </span>
          <span>
            <ClipboardList aria-hidden size={15} /> Applications
          </span>
          <span>
            <Mic2 aria-hidden size={15} /> My sessions
          </span>
          {preview.canManageAvailability ? (
            <span>
              <CalendarClock aria-hidden size={15} /> Availability
            </span>
          ) : null}
          <span>
            <ListChecks aria-hidden size={15} /> Tasks
          </span>
          <span>
            <FileStack aria-hidden size={15} /> Files
          </span>
          <span>
            <BookOpen aria-hidden size={15} /> Resources
          </span>
        </nav>

        <div className="participant-preview-summary">
          <PreviewCount
            value={preview.applications.length}
            label="applications"
          />
          <PreviewCount value={portal.sessions.length} label="sessions" />
          <PreviewCount value={preview.tasks.length} label="tasks" />
          <PreviewCount value={portal.files.length} label="files" />
          <PreviewCount value={preview.resources.length} label="resources" />
          {preview.availabilityCount !== null ? (
            <PreviewCount
              value={preview.availabilityCount}
              label="unavailable periods"
            />
          ) : null}
        </div>

        <div className="participant-preview-grid">
          <section className="card pad stack">
            <h3>My sessions</h3>
            {portal.sessions.length ? (
              <ul className="list-clean">
                {portal.sessions.map((session) => (
                  <li key={session.id}>
                    <span>
                      <strong>{session.title}</strong>
                      <small className="subtle">
                        {session.roleLabel ?? "Speaker"}
                        {session.startsAt
                          ? ` · ${dateTime(session.startsAt, portal.event.timezone)}`
                          : " · Not scheduled"}
                      </small>
                    </span>
                    <span className="status">
                      {label(session.participationStatus)}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="help">No participant-visible sessions.</p>
            )}
          </section>

          <section className="card pad stack">
            <h3>Tasks</h3>
            {preview.tasks.length ? (
              <ul className="list-clean">
                {preview.tasks.map((task) => (
                  <li key={task.id}>
                    <span>
                      <strong>{task.title}</strong>
                      <small className="subtle">
                        {task.targetLabel ?? label(task.targetType)}
                      </small>
                    </span>
                    <span className="status">{label(task.status)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="help">No participant-visible tasks.</p>
            )}
          </section>

          <section className="card pad stack">
            <h3>Applications</h3>
            {preview.applications.length ? (
              <ul className="list-clean">
                {preview.applications.map((application) => (
                  <li key={application.id}>
                    <span>
                      <strong>{application.title}</strong>
                      <small className="subtle">{application.formName}</small>
                    </span>
                    <span className="status">{label(application.status)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="help">No participant-visible applications.</p>
            )}
          </section>

          <section className="card pad stack">
            <h3>Files and resources</h3>
            <p className="help">
              {portal.files.length} private file
              {portal.files.length === 1 ? "" : "s"} and{" "}
              {preview.resources.length} published resource
              {preview.resources.length === 1 ? "" : "s"} are visible. File
              contents and download controls are omitted from preview.
            </p>
            {preview.resources.length ? (
              <ul className="list-clean">
                {preview.resources.map((resource) => (
                  <li key={resource.id}>
                    <span>
                      <strong>{resource.title}</strong>
                      <small className="subtle">
                        {resource.category ?? "General"}
                      </small>
                    </span>
                    {resource.acknowledgementRequired ? (
                      <span className="status">
                        {resource.acknowledged ? "Acknowledged" : "Outstanding"}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </section>
        </div>
      </section>
    </div>
  );
}
