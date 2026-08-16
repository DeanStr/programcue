import { ScheduleConflictExplanationAction } from "~/modules/ai/contextual-ai-actions";
import type {
  ScheduleFetcher,
  SchedulePlannerWorkspaceData,
} from "./schedule-planner-panel-types";
import {
  conflictEntryIds,
  conflictTypeName,
  type ScheduleActionConflictNotice,
} from "./schedule-planner-workspace-helpers";

export function ScheduleValidationPanel({
  workspace,
  latestPlacementConflicts,
  fetcher,
  revealConflictEntries,
}: {
  workspace: SchedulePlannerWorkspaceData;
  latestPlacementConflicts: ScheduleActionConflictNotice[];
  fetcher: ScheduleFetcher;
  revealConflictEntries(entryIds: string[]): void;
}) {
  const latestPlacementWasBlocked =
    workspace.conflicts.length === 0 && latestPlacementConflicts.length > 0;
  return (
    <aside
      aria-labelledby="schedule-validation-heading"
      id="schedule-validation"
      className="card pad schedule-conflicts"
    >
      <div className="card-title">
        <h2 id="schedule-validation-heading">Validation</h2>
        <span
          className={`status ${workspace.conflicts.length || latestPlacementWasBlocked ? "danger" : "success"}`}
        >
          {workspace.conflicts.length
            ? `${workspace.conflicts.length} open`
            : latestPlacementWasBlocked
              ? "Placement blocked"
              : "Ready"}
        </span>
      </div>
      <details className="mb">
        <summary>
          <strong>Conflict policies</strong>
          <span className="help"> · Authoritative at publication</span>
        </summary>
        <fetcher.Form method="post" className="stack mt">
          <input type="hidden" name="intent" value="update-policies" />
          <input
            type="hidden"
            name="revision"
            value={workspace.policyRevision}
          />
          {(
            [
              ["roomAction", "Room overlap", workspace.policies.room],
              [
                "speakerAction",
                "Speaker overlap and turnaround",
                workspace.policies.speaker,
              ],
              [
                "resourceAction",
                "Required resource overlap",
                workspace.policies.resource,
              ],
              [
                "trackAction",
                "Exclusive track overlap",
                workspace.policies.track,
              ],
              [
                "boundaryAction",
                "Outside event dates",
                workspace.policies.boundary,
              ],
              ["capacityAction", "Room capacity", workspace.policies.capacity],
            ] as const
          ).map(([name, label, value]) => (
            <label className="label" key={name}>
              {label}
              <select
                className="select"
                name={name}
                defaultValue={value === "ignore" ? "allow" : value}
              >
                <option value="block">Block</option>
                <option value="warn">Warn</option>
                <option value="allow">Allow</option>
              </select>
            </label>
          ))}
          <label className="label">
            Minimum speaker turnaround (minutes)
            <input
              className="field"
              type="number"
              name="minimumTurnaroundMinutes"
              min={0}
              max={240}
              defaultValue={workspace.policies.minimumTurnaroundMinutes}
              required
            />
          </label>
          <button
            className="btn"
            type="submit"
            disabled={fetcher.state !== "idle"}
          >
            Save policies
          </button>
        </fetcher.Form>
      </details>
      {workspace.conflicts.map((conflict) => {
        const entryIds = conflictEntryIds(conflict);
        return (
          <div
            id={`schedule-conflict-${conflict.id}`}
            className={`validation-item schedule-conflict-item ${conflict.severity === "blocking" ? "error" : "warn"}`}
            key={conflict.id}
            tabIndex={
              conflict.id === workspace.focusedConflictId ? -1 : undefined
            }
          >
            <strong>
              {conflictTypeName(conflict.type)}
              <span className="help">
                {conflict.severity === "blocking"
                  ? " · Blocks publication"
                  : " · Warning"}
              </span>
            </strong>
            <p>{conflict.message}</p>
            <div className="schedule-conflict-actions">
              {entryIds.length ? (
                <button
                  className="btn small"
                  type="button"
                  onClick={() => revealConflictEntries(entryIds)}
                >
                  Show on board
                </button>
              ) : null}
              <ScheduleConflictExplanationAction conflictId={conflict.id} />
            </div>
          </div>
        );
      })}
      {latestPlacementWasBlocked ? (
        <div className="validation-item error" role="status">
          <strong>Latest placement was rejected</strong>
          <span>
            {latestPlacementConflicts.length} blocking conflict
            {latestPlacementConflicts.length === 1 ? "" : "s"} were found during
            preflight. No conflicting placement was saved; adjust the time or
            room and try again.
          </span>
        </div>
      ) : !workspace.conflicts.length ? (
        <div className="validation-item ok">No recorded conflicts.</div>
      ) : null}
    </aside>
  );
}
