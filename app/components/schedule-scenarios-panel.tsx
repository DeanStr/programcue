import { GitCompareArrows } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { Button } from "~/components/ui/button";
import type { AutoPlacementPreview } from "~/modules/schedule/schedule-auto-placement";
import type { action as schedulePlannerAction } from "~/routes/schedule-planner.server";
import { AutoPlacementPreviewDialog } from "./schedule-planner-dialogs";
import type {
  ScheduleFetcher,
  SchedulePlannerWorkspaceData,
} from "./schedule-planner-panel-types";
import {
  isAutoPlacementPreview,
  isRecord,
} from "./schedule-planner-workspace-helpers";

function actionMessage(value: unknown) {
  if (!isRecord(value)) return null;
  if (typeof value.error === "string") {
    return { tone: "error" as const, text: value.error };
  }
  if (typeof value.message === "string") {
    return {
      tone: value.warning ? ("warn" as const) : ("ok" as const),
      text: value.warning
        ? `${value.message} ${String(value.warning)}`
        : value.message,
    };
  }
  return null;
}

export function ScheduleScenariosPanel({
  workspace,
  autoPlacementFetcher,
  clearAutoError,
  autoError,
}: {
  workspace: SchedulePlannerWorkspaceData;
  autoPlacementFetcher: ScheduleFetcher;
  clearAutoError: () => void;
  autoError: string | null;
}) {
  const fetcher = useFetcher<typeof schedulePlannerAction>();
  const [scenarioName, setScenarioName] = useState("");
  const [preparedPreview, setPreparedPreview] =
    useState<AutoPlacementPreview | null>(null);
  const handledScenarioResult = useRef<unknown>(undefined);
  const [selectedScenarioId, setSelectedScenarioId] = useState<string | null>(
    null,
  );
  const scenarioApplyStarted = useRef(false);
  const scenarioApplyBecameBusy = useRef(false);
  useEffect(() => {
    if (!scenarioApplyStarted.current) return;
    if (autoPlacementFetcher.state !== "idle") {
      scenarioApplyBecameBusy.current = true;
      return;
    }
    if (!scenarioApplyBecameBusy.current) return;
    scenarioApplyStarted.current = false;
    scenarioApplyBecameBusy.current = false;
    const result: unknown = autoPlacementFetcher.data;
    if (
      isRecord(result) &&
      result.intent === "auto-place-confirm" &&
      result.committed === true
    ) {
      setSelectedScenarioId(null);
    }
  }, [autoPlacementFetcher.data, autoPlacementFetcher.state]);
  useEffect(() => {
    const result: unknown = fetcher.data;
    if (
      fetcher.state !== "idle" ||
      result === undefined ||
      result === handledScenarioResult.current
    ) {
      return;
    }
    handledScenarioResult.current = result;
    if (
      isRecord(result) &&
      result.intent === "auto-place-preview" &&
      isAutoPlacementPreview(result.autoPreview)
    ) {
      setPreparedPreview(result.autoPreview);
      return;
    }
    if (
      isRecord(result) &&
      result.intent === "scenario-create" &&
      result.committed === true
    ) {
      setPreparedPreview(null);
      setScenarioName("");
    }
  }, [fetcher.data, fetcher.state]);
  const selectedScenario =
    workspace.scenarios.find(
      (scenario) => scenario.id === selectedScenarioId,
    ) ?? null;
  const notice = actionMessage(fetcher.data);
  const scenarioCapacityAvailable =
    workspace.scenarios.length < workspace.scenarioLimit;
  const scenarioCreationAvailable =
    workspace.version?.status === "draft" &&
    workspace.autoPlacementReadiness.canPreview &&
    scenarioCapacityAvailable;
  return (
    <section
      className="schedule-scenarios"
      aria-labelledby="schedule-scenarios-title"
    >
      <div className="schedule-scenarios-head">
        <div>
          <p className="eyebrow">Scenario Lab</p>
          <h2 id="schedule-scenarios-title">
            Compare before changing the draft
          </h2>
          <p className="help">
            Prepare the deterministic placement proposal, choose the moves that
            define an alternative, then save it privately for comparison.
            Scenarios never replace or publish the active schedule.
          </p>
          {!scenarioCapacityAvailable ? (
            <p className="schedule-scenario-stale">
              The {workspace.scenarioLimit}-scenario limit is reached. Discard
              one before saving another.
            </p>
          ) : null}
        </div>
        {scenarioCreationAvailable ? (
          <fetcher.Form method="post" className="schedule-scenario-create">
            <input type="hidden" name="intent" value="auto-place-preview" />
            <label className="label">
              Scenario name
              <input
                className="field"
                name="name"
                required
                minLength={1}
                maxLength={80}
                placeholder="e.g. First-fit baseline"
                value={scenarioName}
                onChange={(event) => setScenarioName(event.target.value)}
              />
            </label>
            <Button
              type="submit"
              variant="primary"
              disabled={fetcher.state !== "idle"}
            >
              {fetcher.state === "idle"
                ? "Review proposed plan"
                : "Preparing proposal…"}
            </Button>
          </fetcher.Form>
        ) : null}
      </div>
      {notice ? (
        <div
          className={`validation-item schedule-notice ${notice.tone} mb`}
          role={notice.tone === "error" ? "alert" : "status"}
        >
          <span>{notice.text}</span>
        </div>
      ) : null}
      {workspace.scenarios.length ? (
        <div className="schedule-scenario-list">
          {workspace.scenarios.map((scenario) => (
            <article className="schedule-scenario-card" key={scenario.id}>
              <div className="schedule-scenario-title">
                <GitCompareArrows aria-hidden size={18} />
                <div>
                  <h3>{scenario.name}</h3>
                  <p>
                    Draft revision {scenario.preview.scheduleRevision} ·{" "}
                    {scenario.stale ? "Needs refresh" : "Ready to compare"}
                  </p>
                </div>
              </div>
              <dl className="schedule-scenario-metrics">
                <div>
                  <dt>Selected moves</dt>
                  <dd>{scenario.preview.selectedSessionIds.length}</dd>
                </div>
                <div>
                  <dt>Warnings</dt>
                  <dd>
                    {scenario.preview.placements.reduce(
                      (count, placement) =>
                        count +
                        (scenario.preview.selectedSessionIds.includes(
                          placement.sessionId,
                        )
                          ? placement.warnings.length
                          : 0),
                      0,
                    )}
                  </dd>
                </div>
                <div>
                  <dt>Unplaced</dt>
                  <dd>{scenario.preview.unplaced.length}</dd>
                </div>
              </dl>
              {scenario.stale ? (
                <p className="schedule-scenario-stale">
                  {scenario.staleReason}
                </p>
              ) : null}
              <div className="schedule-scenario-actions">
                <Button
                  type="button"
                  size="small"
                  onClick={() => {
                    clearAutoError();
                    setSelectedScenarioId(scenario.id);
                  }}
                >
                  Review saved plan
                </Button>
                <fetcher.Form
                  method="post"
                  onSubmit={(event) => {
                    if (
                      !window.confirm(
                        `Discard the private scenario “${scenario.name}”? The draft schedule will not change.`,
                      )
                    ) {
                      event.preventDefault();
                    }
                  }}
                >
                  <input type="hidden" name="intent" value="scenario-discard" />
                  <input type="hidden" name="scenarioId" value={scenario.id} />
                  <Button
                    type="submit"
                    variant="ghost"
                    size="small"
                    disabled={fetcher.state !== "idle"}
                  >
                    Discard
                  </Button>
                </fetcher.Form>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <p className="schedule-scenario-empty">
          {scenarioCreationAvailable
            ? "No saved scenarios yet. Prepare the current deterministic proposal, then choose which moves to preserve as an alternative."
            : "No saved scenarios. Create an editable draft with eligible unscheduled sessions to prepare one."}
        </p>
      )}
      {preparedPreview ? (
        <AutoPlacementPreviewDialog
          title={`Save scenario · ${scenarioName}`}
          intro="Choose the proposed moves that define this named alternative. Saving keeps the active draft unchanged."
          preview={preparedPreview}
          workspace={workspace}
          sessionById={
            new Map(workspace.sessions.map((session) => [session.id, session]))
          }
          fetcher={fetcher}
          dismiss={() => setPreparedPreview(null)}
          clearError={() => undefined}
          error={notice?.tone === "error" ? notice.text : null}
          saveScenario={{
            scenarioId: workspace.scenarioCreateIntentId,
            name: scenarioName,
          }}
        />
      ) : null}
      {selectedScenario ? (
        <AutoPlacementPreviewDialog
          title={`Scenario · ${selectedScenario.name}`}
          intro="Compare this saved proposal with the active draft. Applying selected placements changes only the draft and never publishes it."
          preview={selectedScenario.preview}
          workspace={workspace}
          sessionById={
            new Map(workspace.sessions.map((session) => [session.id, session]))
          }
          fetcher={autoPlacementFetcher}
          dismiss={() => {
            clearAutoError();
            setSelectedScenarioId(null);
          }}
          clearError={clearAutoError}
          error={autoError}
          applyDisabledReason={selectedScenario.staleReason}
          onApplySubmit={() => {
            scenarioApplyStarted.current = true;
            scenarioApplyBecameBusy.current = false;
          }}
        />
      ) : null}
    </section>
  );
}
