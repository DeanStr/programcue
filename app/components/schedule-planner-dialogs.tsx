import { useState } from "react";
import { Form, Link } from "react-router";
import { Dialog } from "~/components/dialog";
import type { AutoPlacementPreview } from "~/modules/schedule/schedule-auto-placement";
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
  contentApprovalBlockers,
  publicContentVisibilityBlockers,
  close,
}: {
  workspace: SchedulePlannerWorkspaceData & {
    version: NonNullable<SchedulePlannerWorkspaceData["version"]>;
  };
  fetcher: ScheduleFetcher;
  contentApprovalBlockers: ScheduleSession[];
  publicContentVisibilityBlockers: ScheduleSession[];
  close: () => void;
}) {
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
              disabled={
                publicContentVisibilityBlockers.length > 0 ||
                contentApprovalBlockers.length > 0
              }
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
      {publicContentVisibilityBlockers.length ? (
        <div className="validation-item error">
          <strong>
            {publicContentVisibilityBlockers.length} scheduled public content
            record
            {publicContentVisibilityBlockers.length === 1 ? " is" : "s are"}{" "}
            private or hidden.
          </strong>{" "}
          Public sessions require public content snapshots. Correct each listed
          session before publishing.
          <ul>
            {publicContentVisibilityBlockers.slice(0, 5).map((session) => (
              <li key={session.id}>
                {session.title} · {session.visibility}
              </li>
            ))}
            {publicContentVisibilityBlockers.length > 5 ? (
              <li>{publicContentVisibilityBlockers.length - 5} more</li>
            ) : null}
          </ul>
        </div>
      ) : (
        <div className="validation-item ok">
          Every scheduled public session has a public content snapshot.
        </div>
      )}
      {contentApprovalBlockers.length ? (
        <div className="validation-item error">
          <strong>
            {contentApprovalBlockers.length} scheduled public content record
            {contentApprovalBlockers.length === 1 ? " is" : "s are"} not marked
            Approved.
          </strong>{" "}
          Publication is blocked until each exact content revision is approved
          or the session is removed from the public schedule.
          <ul>
            {contentApprovalBlockers.slice(0, 5).map((session) => (
              <li key={session.id}>
                <Link
                  to={`/admin/content/sessions/${encodeURIComponent(session.id)}`}
                  onClick={close}
                >
                  {session.title}
                </Link>{" "}
                · {session.contentStatus.replaceAll("_", " ")}
              </li>
            ))}
            {contentApprovalBlockers.length > 5 ? (
              <li>{contentApprovalBlockers.length - 5} more</li>
            ) : null}
          </ul>
        </div>
      ) : (
        <div className="validation-item ok">
          Every scheduled public content record is marked Approved.
        </div>
      )}
      <div
        className={`validation-item ${workspace.publicationConflicts.some((conflict) => conflict.severity === "blocking") ? "error" : workspace.publicationConflicts.length ? "warn" : "ok"}`}
      >
        {workspace.publicationConflicts.length
          ? `${workspace.publicationConflicts.length} current conflict${workspace.publicationConflicts.length === 1 ? "" : "s"} will be revalidated before publication.`
          : "No current conflicts. All placements will be revalidated before publication."}
        {workspace.publicationConflicts.length ? (
          <ul>
            {workspace.publicationConflicts.map((conflict, index) => (
              <li
                key={`${conflict.type}:${conflict.conflictingEntryId ?? "entry"}:${index}`}
              >
                {conflict.severity === "blocking" ? "Blocking" : "Warning"}:{" "}
                {conflict.message}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      <p className="help">
        The current public version remains available in history. Calendar
        updates are queued separately.
      </p>
    </Dialog>
  );
}
