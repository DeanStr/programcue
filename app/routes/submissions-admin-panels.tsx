import { useState } from "react";
import { Form, Link, useNavigation } from "react-router";

import { PersonDuplicateWarning } from "~/components/person-duplicate-warning";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { EventDateTime } from "~/components/ui/event-date-time";
import type { SubmissionService } from "~/modules/submissions/submission-service.server";
import type {
  SubmissionAdminDetail,
  SubmissionAdminSpeakerInput,
  SubmissionsAdminActionResult,
} from "./submissions-admin-types";

export function ActionNotice({
  result,
}: {
  result?: SubmissionsAdminActionResult;
}) {
  if (!result) return null;
  return (
    <div
      className={`validation-item ${result.ok ? "ok" : result.partial ? "warn" : "error"} card pad mb`}
      role={result.ok || result.partial ? "status" : "alert"}
    >
      <strong>{result.ok ? "✓" : "△"}</strong>
      <span>
        {result.message}{" "}
        {result.operationId ? (
          <Link to={`/admin/operations?operation=${result.operationId}`}>
            Open operation
          </Link>
        ) : null}
      </span>
    </div>
  );
}

export function SubmissionAdminDetailPanel({
  submission,
  actionResult,
}: {
  submission: SubmissionAdminDetail;
  actionResult?: SubmissionsAdminActionResult;
}) {
  const navigation = useNavigation();
  const labels = new Map(
    submission.schema?.fields.map((field) => [field.id, field.label]) ?? [],
  );
  return (
    <>
      <div className="page-head">
        <div>
          <Link className="subtle" to="/admin/submissions">
            ← All submissions
          </Link>
          <h1>{submission.title}</h1>
          <p>
            {submission.submitterName} · {submission.submitterEmail}
          </p>
        </div>
        <div className="page-actions">
          <DomainStatusBadge domain="submission" status={submission.status} />
          <span className="pill">
            {submission.versionNumber
              ? `Form v${submission.versionNumber}`
              : "Manual entry"}
          </span>
        </div>
      </div>
      <ActionNotice result={actionResult} />
      <div className="grid grid-2">
        <section className="card pad">
          <div className="card-title">
            <h2>Application snapshot</h2>
            <span className="subtle right">Immutable source answers</span>
          </div>
          <dl className="stack">
            {Object.entries(submission.answers).map(([key, value]) => (
              <div key={key}>
                <dt className="label">{labels.get(key) ?? key}</dt>
                <dd style={{ margin: "4px 0 0", whiteSpace: "pre-wrap" }}>
                  {Array.isArray(value) ? value.join(", ") : value || "—"}
                </dd>
              </div>
            ))}
            {Object.entries(submission.uploads).map(([fieldId, reference]) => (
              <div key={fieldId}>
                <dt className="label">
                  {labels.get(fieldId) ?? fieldId} · private file
                </dt>
                <dd style={{ margin: "4px 0 0" }}>
                  <Link to={`/review/files/${reference.assetId}`}>
                    Download scanned video
                  </Link>
                </dd>
              </div>
            ))}
          </dl>
        </section>
        <aside className="stack">
          <section className="card pad">
            <h2>Routing</h2>
            <p>
              <span className="label">Tracks</span>
              <br />
              {submission.category ?? "Uncategorised"}
            </p>
            <p>
              <span className="label">Assigned teams</span>
              <br />
              {submission.routedTo}
            </p>
            <p>
              <span className="label">Format</span>
              <br />
              {submission.format ?? "Not set"}
            </p>
            <p>
              <span className="label">Submitted</span>
              <br />
              {submission.submittedAt ? (
                <EventDateTime
                  epochSeconds={submission.submittedAt}
                  timeZone={submission.eventTimezone}
                  showTimeZone
                />
              ) : (
                "Draft"
              )}
            </p>
          </section>
          <section className="card pad">
            <div className="card-title">
              <h2>Speakers</h2>
              <span className="pill right">{submission.speakers.length}</span>
            </div>
            {submission.speakers.map((speaker) => (
              <div className="row-main mt" key={speaker.id}>
                <span className="avatar sm">
                  {speaker.name
                    .split(/\s+/)
                    .map((part) => part[0])
                    .slice(0, 2)
                    .join("")}
                </span>
                <span>
                  <strong>
                    {speaker.name}
                    {speaker.isPrimary ? " · Primary" : ""}
                  </strong>
                  <small>
                    {speaker.email} · {speaker.invitationStatus}
                  </small>
                  {speaker.biography ? (
                    <small>Current biography: {speaker.biography}</small>
                  ) : null}
                  {speaker.submittedBiography &&
                  speaker.submittedBiography !== speaker.biography ? (
                    <small>
                      Submitted biography: {speaker.submittedBiography}
                    </small>
                  ) : null}
                </span>
                {!speaker.isPrimary &&
                ["pending", "sent", "expired"].includes(
                  speaker.invitationStatus,
                ) ? (
                  <Form method="post" className="right">
                    <input
                      type="hidden"
                      name="_intent"
                      value="resend_co_speaker"
                    />
                    <input
                      type="hidden"
                      name="invitationId"
                      value={speaker.id}
                    />
                    <button
                      className="btn small"
                      type="submit"
                      disabled={navigation.state !== "idle"}
                    >
                      Resend
                    </button>
                  </Form>
                ) : null}
              </div>
            ))}
          </section>
        </aside>
      </div>
    </>
  );
}

function SpeakerFields({
  speakers,
  setSpeakers,
}: {
  speakers: SubmissionAdminSpeakerInput[];
  setSpeakers(speakers: SubmissionAdminSpeakerInput[]): void;
}) {
  return (
    <fieldset className="card pad">
      <legend>
        <strong>Speakers</strong>
      </legend>
      {speakers.map((speaker, index) => (
        <div className="grid grid-3 mb" key={index}>
          <label className="label">
            Speaker {index + 1} name
            <input
              className="field"
              required
              value={speaker.name}
              onChange={(event) => {
                const next = [...speakers];
                next[index] = { ...speaker, name: event.target.value };
                setSpeakers(next);
              }}
            />
          </label>
          <label className="label">
            Email
            <input
              className="field"
              type="email"
              required
              value={speaker.email}
              onChange={(event) => {
                const next = [...speakers];
                next[index] = { ...speaker, email: event.target.value };
                setSpeakers(next);
              }}
            />
          </label>
          <label className="label">
            Biography
            <textarea
              className="textarea"
              maxLength={5_000}
              value={speaker.biography}
              onChange={(event) => {
                const next = [...speakers];
                next[index] = { ...speaker, biography: event.target.value };
                setSpeakers(next);
              }}
            />
          </label>
          {index > 0 ? (
            <button
              className="btn small danger"
              type="button"
              onClick={() =>
                setSpeakers(
                  speakers.filter((_, speakerIndex) => speakerIndex !== index),
                )
              }
            >
              Remove speaker
            </button>
          ) : null}
        </div>
      ))}
      <button
        className="btn small"
        type="button"
        onClick={() =>
          setSpeakers([...speakers, { name: "", email: "", biography: "" }])
        }
      >
        + Add co-speaker
      </button>
    </fieldset>
  );
}

function DuplicatePersonWarning({
  result,
  intent,
}: {
  result?: SubmissionsAdminActionResult;
  intent: "create_direct_session" | "create_manual_application";
}) {
  const check = result?.duplicateCheck;
  if (!check || check.intent !== intent) return null;
  return (
    <PersonDuplicateWarning
      id={`${intent}-duplicate`}
      matches={check.matches}
      truncated={check.truncated}
    />
  );
}

export function ManualEntryPanels({
  routingTeams,
  routingTracks,
  sessionFormats,
  manualApplicationIdempotencyKey,
  directSessionIdempotencyKey,
  actionResult,
}: {
  routingTeams: Array<{ id: string; name: string }>;
  routingTracks: Array<{ id: string; name: string }>;
  sessionFormats: Awaited<
    ReturnType<SubmissionService["getConfiguredSessionFormats"]>
  >;
  manualApplicationIdempotencyKey: string;
  directSessionIdempotencyKey: string;
  actionResult?: SubmissionsAdminActionResult;
}) {
  const navigation = useNavigation();
  const [directSpeakers, setDirectSpeakers] = useState<
    SubmissionAdminSpeakerInput[]
  >([{ name: "", email: "", biography: "" }]);
  const [applicationSpeakers, setApplicationSpeakers] = useState<
    SubmissionAdminSpeakerInput[]
  >([{ name: "", email: "", biography: "" }]);
  const [directFormat, setDirectFormat] = useState(sessionFormats[0]!.key);
  const [directDuration, setDirectDuration] = useState(
    sessionFormats[0]!.defaultDurationMinutes,
  );
  return (
    <div className="stack">
      <details className="card pad">
        <summary>
          <strong>Enter an application manually</strong>{" "}
          <span className="subtle">
            preserve an abstract for participants who already accepted their
            event invitations
          </span>
        </summary>
        <Form method="post" className="stack mt">
          <input
            type="hidden"
            name="_intent"
            value="create_manual_application"
          />
          <input
            type="hidden"
            name="idempotencyKey"
            value={manualApplicationIdempotencyKey}
          />
          <input
            type="hidden"
            name="speakers"
            value={JSON.stringify(applicationSpeakers)}
          />
          <div className="grid grid-2">
            <label className="label">
              Session title
              <input className="field" name="title" required />
            </label>
            <label className="label">
              Tracks
              <select
                className="select"
                name="trackIds"
                required
                multiple
                size={Math.min(Math.max(routingTracks.length, 2), 6)}
              >
                {routingTracks.map((track) => (
                  <option key={track.id} value={track.id}>
                    {track.name}
                  </option>
                ))}
              </select>
              <span className="help">
                Select every review track that applies.
              </span>
            </label>
            <label className="label">
              Format
              <select
                className="select"
                name="format"
                defaultValue={sessionFormats[0]!.key}
              >
                {sessionFormats.map((format) => (
                  <option key={format.key} value={format.key}>
                    {format.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="label">
              Review teams (optional administrator override)
              <select
                className="select"
                name="routedTeamIds"
                multiple
                size={Math.min(Math.max(routingTeams.length, 2), 6)}
              >
                {routingTeams.map((team) => (
                  <option key={team.id} value={team.id}>
                    {team.name}
                  </option>
                ))}
              </select>
              <span className="help">
                Routing is recorded now; evaluator assignments are created
                separately in Review administration.
              </span>
            </label>
          </div>
          <label className="label">
            Abstract or description
            <textarea className="textarea" name="description" required />
          </label>
          <div className="grid grid-2">
            <label className="label">
              Submitter name
              <input className="field" name="submitterName" required />
            </label>
            <label className="label">
              Submitter email
              <input
                className="field"
                name="submitterEmail"
                type="email"
                required
              />
            </label>
          </div>
          <SpeakerFields
            speakers={applicationSpeakers}
            setSpeakers={setApplicationSpeakers}
          />
          <DuplicatePersonWarning
            result={actionResult}
            intent="create_manual_application"
          />
          <button
            className="btn primary"
            type="submit"
            disabled={navigation.state !== "idle"}
          >
            {navigation.formData?.get("_intent") === "create_manual_application"
              ? "Creating…"
              : "Create manual application"}
          </button>
        </Form>
      </details>

      <details className="card pad">
        <summary>
          <strong>Create a guaranteed direct session</strong>{" "}
          <span className="subtle">
            for sponsors, invited speakers or confirmed programme items
          </span>
        </summary>
        <Form method="post" className="stack mt">
          <input type="hidden" name="_intent" value="create_direct_session" />
          <input
            type="hidden"
            name="idempotencyKey"
            value={directSessionIdempotencyKey}
          />
          <input
            type="hidden"
            name="speakers"
            value={JSON.stringify(directSpeakers)}
          />
          <div className="form-row">
            <label className="label">
              Session title
              <input className="field" name="title" required />
            </label>
            <label className="label">
              Track
              <select
                className="select"
                name="trackId"
                required
                defaultValue=""
              >
                <option value="" disabled>
                  Choose a current event track
                </option>
                {routingTracks.map((track) => (
                  <option key={track.id} value={track.id}>
                    {track.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="label">
              Format
              <select
                className="select"
                name="format"
                value={directFormat}
                onChange={(changeEvent) => {
                  const next = sessionFormats.find(
                    (format) => format.key === changeEvent.target.value,
                  );
                  if (!next) return;
                  setDirectFormat(next.key);
                  setDirectDuration(next.defaultDurationMinutes);
                }}
              >
                {sessionFormats.map((format) => (
                  <option key={format.key} value={format.key}>
                    {format.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="label">
              Duration (minutes)
              <input
                className="field"
                name="durationMinutes"
                type="number"
                min={5}
                max={480}
                value={directDuration}
                onChange={(changeEvent) =>
                  setDirectDuration(Number(changeEvent.target.value))
                }
                required
              />
            </label>
          </div>
          <label className="label">
            Description
            <textarea className="textarea" name="description" />
          </label>
          <SpeakerFields
            speakers={directSpeakers}
            setSpeakers={setDirectSpeakers}
          />
          <DuplicatePersonWarning
            result={actionResult}
            intent="create_direct_session"
          />
          <button
            className="btn primary"
            type="submit"
            disabled={navigation.state !== "idle"}
          >
            {navigation.formData?.get("_intent") === "create_direct_session"
              ? "Creating…"
              : "Create unscheduled session"}
          </button>
        </Form>
      </details>
    </div>
  );
}
