import { useState } from "react";
import { Form, Link } from "react-router";
import { Dialog } from "~/components/dialog";
import type { AutoPlacementPreview } from "~/modules/schedule/schedule-auto-placement";
import type { SchedulePublicationPreview } from "~/modules/schedule/schedule-publication-preview.server";
import type { ScheduleSession } from "~/modules/schedule/schedule-service.server";
import type {
  ScheduleFetcher,
  SchedulePlannerWorkspaceData,
} from "./schedule-planner-panel-types";
import {
  scheduleDateTimeLabel,
  serializeAutoPlacementPreview,
} from "./schedule-planner-workspace-helpers";

export function ScheduleDraftDialog({
  workspace,
  busy,
  close,
}: {
  workspace: SchedulePlannerWorkspaceData & {
    version: NonNullable<SchedulePlannerWorkspaceData["version"]>;
  };
  busy: boolean;
  close: () => void;
}) {
  return (
    <Dialog
      title="Create the next schedule draft?"
      description="Prepare a new draft from the current published schedule."
      onClose={close}
      footer={
        <>
          <button className="btn" type="button" onClick={close} disabled={busy}>
            Cancel
          </button>
          <Form method="post" onSubmit={close}>
            <input type="hidden" name="intent" value="create-draft" />
            <input type="hidden" name="intentId" value={workspace.intentId} />
            <button type="submit" className="btn primary" disabled={busy}>
              {busy ? "Creating draft…" : "Confirm new draft"}
            </button>
          </Form>
        </>
      }
    >
      <div className="stack">
        <p>
          The new draft will copy the current schedule notes and{" "}
          <strong>
            {workspace.entries.length} placement
            {workspace.entries.length === 1 ? "" : "s"}
          </strong>
          . The published programme will not change.
        </p>
        <div className="validation-item warn">
          <strong>The new version remains unpublished.</strong>
          <span>
            It will appear as an outstanding schedule draft until it is checked
            and published.
          </span>
        </div>
      </div>
    </Dialog>
  );
}

export function AutoPlacementPreviewDialog({
  preview,
  workspace,
  sessionById,
  fetcher,
  dismiss,
  clearError,
}: {
  preview: AutoPlacementPreview;
  workspace: SchedulePlannerWorkspaceData;
  sessionById: Map<string, ScheduleSession>;
  fetcher: ScheduleFetcher;
  dismiss: () => void;
  clearError: () => void;
}) {
  const [selectedSessionIds, setSelectedSessionIds] = useState(
    () => preview.selectedSessionIds,
  );
  const selectedIds = new Set(selectedSessionIds);
  const proposal = serializeAutoPlacementPreview(preview, selectedSessionIds);
  return (
    <Dialog
      title="Preview auto-placement"
      onClose={() => {
        if (fetcher.state === "idle") dismiss();
      }}
      footer={
        <>
          <button
            className="btn"
            type="button"
            disabled={fetcher.state !== "idle"}
            onClick={dismiss}
          >
            Cancel
          </button>
          <fetcher.Form method="post" onSubmit={clearError}>
            <input type="hidden" name="intent" value="auto-place-confirm" />
            <input type="hidden" name="proposal" value={proposal} />
            <button
              className="btn primary"
              type="submit"
              disabled={
                selectedSessionIds.length === 0 || fetcher.state !== "idle"
              }
            >
              {fetcher.state === "idle"
                ? `Apply ${selectedSessionIds.length} selected placement${selectedSessionIds.length === 1 ? "" : "s"}`
                : "Applying placements…"}
            </button>
          </fetcher.Form>
        </>
      }
    >
      <div className="stack" data-testid="auto-placement-preview">
        <p>
          Suggested placements for this draft schedule, based on what is already
          scheduled. Nothing is published by this action, and you can change any
          placement afterwards.
        </p>
        <div className="grid grid-3">
          <div className="metric">
            <span className="value">{preview.sessionRevisions.length}</span>
            <span className="label">Unscheduled inspected</span>
          </div>
          <div className="metric">
            <span className="value">{selectedSessionIds.length}</span>
            <span className="label">Selected to apply</span>
          </div>
          <div className="metric">
            <span className="value">{preview.unplaced.length}</span>
            <span className="label">Unplaced</span>
          </div>
        </div>
        <p className="help">
          Event configuration revision {preview.eventRevision}, conflict policy
          revision {preview.policyRevision}, and every listed session revision
          will be revalidated on confirmation.
        </p>
        <section aria-labelledby="auto-placement-proposed-heading">
          <div className="card-title">
            <h3 id="auto-placement-proposed-heading">Proposed placements</h3>
            {preview.placements.length ? (
              <button
                className="btn small right"
                type="button"
                onClick={() =>
                  setSelectedSessionIds(
                    selectedSessionIds.length === preview.placements.length
                      ? []
                      : preview.placements.map(
                          (placement) => placement.sessionId,
                        ),
                  )
                }
              >
                {selectedSessionIds.length === preview.placements.length
                  ? "Clear selection"
                  : "Select all"}
              </button>
            ) : null}
          </div>
          {preview.placements.length ? (
            <div className="stack">
              {preview.placements.map((placement) => {
                const session = sessionById.get(placement.sessionId);
                const room = workspace.rooms.find(
                  (candidate) => candidate.id === placement.roomId,
                );
                return (
                  <div
                    className={`validation-item ${placement.warnings.length ? "warn" : "ok"}`}
                    data-testid="auto-placement-proposal"
                    key={placement.sessionId}
                  >
                    <label>
                      <input
                        type="checkbox"
                        checked={selectedIds.has(placement.sessionId)}
                        onChange={(event) =>
                          setSelectedSessionIds((current) =>
                            event.target.checked
                              ? [...current, placement.sessionId]
                              : current.filter(
                                  (id) => id !== placement.sessionId,
                                ),
                          )
                        }
                      />{" "}
                      <strong>{session?.title ?? placement.sessionId}</strong>
                    </label>
                    <span>
                      {room?.name ?? placement.roomId} ·{" "}
                      {scheduleDateTimeLabel(
                        placement.startsAt,
                        workspace.event.timezone,
                      )}{" "}
                      –{" "}
                      {scheduleDateTimeLabel(
                        placement.endsAt,
                        workspace.event.timezone,
                      )}
                    </span>
                    {placement.warnings.length ? (
                      <small>
                        Warning:{" "}
                        {placement.warnings
                          .map((warning) => warning.message)
                          .join(" ")}
                      </small>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="validation-item warn">
              No valid placements were found. Confirmation is disabled.
            </div>
          )}
        </section>
        <section aria-labelledby="auto-placement-unplaced-heading">
          <h3 id="auto-placement-unplaced-heading">Unplaced sessions</h3>
          {preview.unplaced.length ? (
            <div className="stack">
              {preview.unplaced.map((item) => (
                <div
                  className="validation-item warn"
                  data-testid="auto-placement-unplaced"
                  key={item.sessionId}
                >
                  <strong>
                    {sessionById.get(item.sessionId)?.title ?? item.sessionId}
                  </strong>
                  <span>{item.reason}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="help">
              Every inspected unscheduled session has a proposal.
            </p>
          )}
        </section>
      </div>
    </Dialog>
  );
}

export function SchedulePublicationDialog({
  workspace,
  fetcher,
  preview,
  close,
}: {
  workspace: SchedulePlannerWorkspaceData & {
    version: NonNullable<SchedulePlannerWorkspaceData["version"]>;
  };
  fetcher: ScheduleFetcher;
  preview: SchedulePublicationPreview;
  close: () => void;
}) {
  const blockerCount =
    Number(preview.blockers.emptySchedule) +
    preview.blockers.conflicts.length +
    preview.blockers.contentVisibility.length +
    preview.blockers.contentApproval.length +
    preview.blockers.unconfirmedSpeakers.length +
    preview.blockers.publicDependencies.length;
  const changeCount =
    preview.changes.added.length +
    preview.changes.removed.length +
    preview.changes.moved.length +
    preview.changes.visibility.length;
  return (
    <Dialog
      title="Publish schedule"
      onClose={close}
      footer={
        <>
          <button className="btn" type="button" onClick={close}>
            Cancel
          </button>
          <fetcher.Form method="post" onSubmit={close}>
            <input type="hidden" name="intent" value="publish" />
            <input
              type="hidden"
              name="scheduleVersionId"
              value={workspace.version.id}
            />
            <input
              type="hidden"
              name="scheduleRevision"
              value={workspace.version.revision}
            />
            <button
              type="submit"
              className="btn primary"
              disabled={blockerCount > 0}
            >
              Confirm publication
            </button>
          </fetcher.Form>
        </>
      }
    >
      <p>
        Publish version {workspace.version.versionNumber} with{" "}
        <strong>{workspace.entries.length} scheduled sessions</strong>.
      </p>
      <p>
        This version will be available at{" "}
        <strong>/public/programme/{workspace.event.publicSlug}</strong>.
      </p>
      <p className="help">
        Confirming publication makes this exact schedule-version snapshot
        authoritative. If this draft is blocked, the currently published
        programme remains unchanged.
      </p>
      <section aria-labelledby="schedule-publication-changes">
        <h3 id="schedule-publication-changes">
          Changes since{" "}
          {preview.publishedVersionNumber
            ? `version ${preview.publishedVersionNumber}`
            : "the unpublished baseline"}
        </h3>
        <p className="help">
          {changeCount
            ? `${changeCount} material ${changeCount === 1 ? "change" : "changes"} will become public.`
            : "No session placement or visibility changes were found."}
        </p>
        {preview.changes.added.length ? (
          <div className="validation-item info">
            <strong>Added · {preview.changes.added.length}</strong>
            <ul>
              {preview.changes.added.map((item) => (
                <li key={item.sessionId}>{item.title}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {preview.changes.removed.length ? (
          <div className="validation-item warn">
            <strong>Removed · {preview.changes.removed.length}</strong>
            <ul>
              {preview.changes.removed.map((item) => (
                <li key={item.sessionId}>{item.title}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {preview.changes.moved.length ? (
          <div className="validation-item info">
            <strong>Moved or resized · {preview.changes.moved.length}</strong>
            <ul>
              {preview.changes.moved.map((item) => (
                <li key={item.sessionId}>
                  <strong>{item.title}</strong> · {item.from.room},{" "}
                  {scheduleDateTimeLabel(
                    item.from.startsAt,
                    workspace.event.timezone,
                  )}
                  –
                  {scheduleDateTimeLabel(
                    item.from.endsAt,
                    workspace.event.timezone,
                  )}{" "}
                  → {item.to.room},{" "}
                  {scheduleDateTimeLabel(
                    item.to.startsAt,
                    workspace.event.timezone,
                  )}
                  –
                  {scheduleDateTimeLabel(
                    item.to.endsAt,
                    workspace.event.timezone,
                  )}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {preview.changes.visibility.length ? (
          <div className="validation-item warn">
            <strong>
              Visibility changed · {preview.changes.visibility.length}
            </strong>
            <ul>
              {preview.changes.visibility.map((item) => (
                <li key={item.sessionId}>
                  {item.title} · {item.from} → {item.to}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="schedule-publication-readiness">
        <h3 id="schedule-publication-readiness">Publication readiness</h3>
        {blockerCount ? (
          <div className="validation-item error">
            <strong>
              {blockerCount} publication{" "}
              {blockerCount === 1 ? "blocker" : "blockers"}
            </strong>
            <span>
              Publication is blocked. Resolve every item below before
              publishing.
            </span>
          </div>
        ) : (
          <div className="validation-item ok">
            Every scheduled public session has a public content snapshot. No
            publication blockers found. Every invariant is revalidated before
            publication.
          </div>
        )}
        {preview.blockers.emptySchedule ? (
          <div className="validation-item error">
            Place at least one session before publishing.
          </div>
        ) : null}
        {preview.blockers.contentVisibility.length ? (
          <div className="validation-item error">
            <strong>Public content hidden or private</strong>
            <ul>
              {preview.blockers.contentVisibility.map((session) => (
                <li key={session.sessionId}>{session.title}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {preview.blockers.contentApproval.length ? (
          <div className="validation-item error">
            <strong>Content is not marked Approved</strong>
            <ul>
              {preview.blockers.contentApproval.map((session) => (
                <li key={session.sessionId}>
                  <Link
                    to={`/admin/content/sessions/${encodeURIComponent(session.sessionId)}`}
                    onClick={close}
                  >
                    {session.title}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {preview.blockers.unconfirmedSpeakers.length ? (
          <div className="validation-item error">
            <strong>Speaker confirmation required</strong>
            <ul>
              {preview.blockers.unconfirmedSpeakers.map((item) => (
                <li key={`${item.sessionId}:${item.speakerId}`}>
                  {item.title} · {item.speakerName}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {preview.blockers.publicDependencies.map((message) => (
          <div className="validation-item error" key={message}>
            {message}
          </div>
        ))}
        {preview.blockers.conflicts.length ? (
          <div className="validation-item error">
            <strong>Blocking schedule conflicts</strong>
            <ul>
              {preview.blockers.conflicts.map((conflict, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: Deterministic conflict messages have no persisted identifier in this projection.
                <li key={index}>{conflict.message}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {preview.warnings.length ? (
          <div className="validation-item warn">
            <strong>Warnings · {preview.warnings.length}</strong>
            <ul>
              {preview.warnings.map((warning, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: Deterministic conflict messages have no persisted identifier in this projection.
                <li key={index}>{warning.message}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
      <p className="help">
        The current public version remains available in history. Calendar
        updates are queued separately.
      </p>
    </Dialog>
  );
}
