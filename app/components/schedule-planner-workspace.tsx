import { DndContext, DragOverlay, type DragStartEvent } from "@dnd-kit/core";
import { useEffect, useRef, useState } from "react";
import { Form, Link } from "react-router";
import { ScheduleContentWorkflows } from "~/components/schedule-content-workflows";
import { statusPresentation } from "~/components/ui/domain-status-badge";
import { ScheduleCanvasPanel } from "./schedule-planner-canvas-panel";
import {
  AutoPlacementPreviewDialog,
  ScheduleDraftDialog,
  SchedulePublicationDialog,
} from "./schedule-planner-dialogs";
import type { SchedulePlannerWorkspaceData } from "./schedule-planner-panel-types";
import { ScheduleSourcePanel } from "./schedule-planner-source-panel";
import { ScheduleValidationPanel } from "./schedule-planner-validation-panel";
import {
  conflictTypeLabel,
  sessionFormatLabel,
} from "./schedule-planner-workspace-helpers";

import { useSchedulePlannerController } from "./use-schedule-planner-controller";

export {
  parseScheduleActionNotices,
  SCHEDULE_ACTION_INVALID_RESPONSE_MESSAGE,
} from "./schedule-planner-workspace-helpers";

export function SchedulePlannerWorkspace({
  workspace: loadedWorkspace,
}: {
  workspace: SchedulePlannerWorkspaceData;
}) {
  const [draftOpen, setDraftOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const inspectorToggleRef = useRef<HTMLButtonElement>(null);
  const inspectorTitleRef = useRef<HTMLHeadingElement>(null);
  const inspectorFocusAfterToggle = useRef(false);
  useEffect(() => {
    if (loadedWorkspace.createdSessionId || loadedWorkspace.focusedSessionId) {
      setInspectorOpen(true);
    }
  }, [loadedWorkspace.createdSessionId, loadedWorkspace.focusedSessionId]);
  useEffect(() => {
    if (!inspectorFocusAfterToggle.current) return;
    inspectorFocusAfterToggle.current = false;
    const target = inspectorOpen
      ? inspectorTitleRef.current
      : inspectorToggleRef.current;
    target?.focus({ preventScroll: true });
  }, [inspectorOpen]);
  const {
    actionNotices,
    actionResult,
    allPlacementSlots,
    autoError,
    autoPlacementFetcher,
    autoPreview,
    autoResult,
    clearAutoError,
    clearAutoFeedback,
    conflictSeverityByEntryId,
    dismissAutoPreview,
    draggingSessionId,
    entriesBySlot,
    eventDays,
    fetcher,
    moveInStandardCalendar,
    navigation,
    place,
    placementAvailable,
    placementBusy,
    publishOpen,
    publishRefreshing,
    quickDurationMinutes,
    quickEntry,
    quickRoomId,
    quickSession,
    quickSessionId,
    quickStartsAt,
    readOnlyPlacementMessage,
    requestPublish,
    resize,
    resourceInventory,
    revealConflictEntries,
    revealedEntryIds,
    roomScrollRef,
    scheduledSessionIds,
    selectQuickSession,
    selectedDay,
    sensors,
    sessionById,
    sessionLabel,
    setDraggingSessionId,
    setPublishOpen,
    setQuickDurationMinutes,
    setQuickRoomId,
    setQuickStartsAt,
    setSelectedDay,
    setView,
    slotLabel,
    slots,
    submitQuickPlacement,
    trackGroups,
    unassign,
    undoAvailable,
    view,
    visibleSessions,
    workspace,
  } = useSchedulePlannerController(loadedWorkspace);
  function inspectSession(sessionId: string) {
    selectQuickSession(sessionId);
    setInspectorOpen(true);
  }
  function toggleInspector(open: boolean) {
    inspectorFocusAfterToggle.current = true;
    setInspectorOpen(open);
  }
  const unscheduledCount = workspace.sessions.length - scheduledSessionIds.size;
  const showAutoPlaceButton =
    workspace.version?.status === "draft" ||
    workspace.autoPlacementReadiness.canPreview;
  const showAutoPlaceReadiness =
    workspace.version?.status === "draft" &&
    !workspace.autoPlacementReadiness.canPreview;

  return (
    <div className="schedule-page">
      <div className="page-head schedule-page-head">
        <div>
          <h1>Schedule Planner</h1>
          <p className="schedule-page-stats">
            {workspace.entries.length} placed · {unscheduledCount} to place ·{" "}
            {workspace.conflicts.length ? (
              <button
                type="button"
                className="schedule-page-stats-jump"
                onClick={() => {
                  const panel = document.getElementById("schedule-validation");
                  panel?.scrollIntoView({ block: "nearest" });
                  panel
                    ?.querySelector<HTMLElement>(".validation-item button")
                    ?.focus({ preventScroll: true });
                }}
              >
                {workspace.conflicts.length} conflict
                {workspace.conflicts.length === 1 ? "" : "s"}
              </button>
            ) : (
              "0 conflicts"
            )}
          </p>
        </div>
        <div className="page-actions schedule-page-actions">
          {workspace.event.programmePublishedAt ? (
            <Link
              className="btn ghost"
              to={`/public/programme/${workspace.event.publicSlug}`}
              target="_blank"
              rel="noreferrer"
            >
              Open public programme
            </Link>
          ) : null}
          <Link className="btn ghost" to="/admin/sessions/new">
            Create direct session
          </Link>
          {showAutoPlaceButton ? (
            <button
              className="btn ghost"
              type="button"
              disabled={
                !workspace.autoPlacementReadiness.canPreview ||
                autoPlacementFetcher.state !== "idle"
              }
              title={
                workspace.autoPlacementReadiness.disabledReason ?? undefined
              }
              onClick={() => {
                clearAutoFeedback();
                autoPlacementFetcher.submit(
                  { intent: "auto-place-preview" },
                  { method: "post" },
                );
              }}
            >
              {autoPlacementFetcher.state === "idle"
                ? "Auto-place unscheduled sessions"
                : "Preparing auto-place preview…"}
            </button>
          ) : null}
          {workspace.version ? (
            <span className="schedule-page-version">
              Version {workspace.version.versionNumber} ·{" "}
              {statusPresentation("version", workspace.version.status).label}
            </span>
          ) : null}
          {workspace.version?.status === "draft" ? (
            <button
              className="btn primary"
              type="button"
              disabled={publishRefreshing || placementBusy}
              onClick={requestPublish}
            >
              {publishRefreshing ? "Refreshing preview…" : "Publish schedule"}
            </button>
          ) : workspace.version ? (
            <button
              className="btn primary"
              type="button"
              disabled={navigation.state !== "idle"}
              onClick={() => setDraftOpen(true)}
            >
              Create next draft
            </button>
          ) : (
            <Form method="post">
              <input type="hidden" name="intent" value="create-draft" />
              <input type="hidden" name="intentId" value={workspace.intentId} />
              <button
                type="submit"
                className="btn primary"
                disabled={navigation.state !== "idle"}
              >
                Create schedule
              </button>
            </Form>
          )}
        </div>
      </div>
      {workspace.createdSessionId ? (
        <div
          className={`validation-item schedule-notice ${workspace.createdSessionNeedsAttention ? "warn" : "ok"} mb`}
          role="status"
        >
          <strong>Direct session created</strong>
          <span>
            The new session is selected for placement and marked in the session
            source. Speaker participation must still be confirmed before
            publication.
          </span>
          {workspace.createdSessionNeedsAttention ? (
            <span>
              One or more invitation or webhook operations need attention.
              Review Speakers and Operations before publication.
            </span>
          ) : null}
        </div>
      ) : null}
      {autoError ? (
        <div className="validation-item schedule-notice error mb" role="alert">
          <strong>Auto-place blocked</strong>
          <span>{autoError}</span>
        </div>
      ) : null}
      {showAutoPlaceReadiness ? (
        <section
          className="schedule-readiness"
          aria-labelledby="auto-placement-readiness-heading"
          data-testid="auto-placement-readiness"
        >
          <strong id="auto-placement-readiness-heading">
            Auto-place unavailable
          </strong>
          <span>{workspace.autoPlacementReadiness.disabledReason}</span>
          {workspace.autoPlacementReadiness.blocked.length ? (
            <div className="stack">
              {workspace.autoPlacementReadiness.blocked.map((item) => (
                <span key={item.sessionId}>
                  {sessionById.get(item.sessionId)?.title ?? item.sessionId}:{" "}
                  {item.reason}
                </span>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}
      {autoResult ? (
        <div
          className={`validation-item schedule-notice ${autoResult.warning || autoResult.unplacedCount || autoResult.excludedCount ? "warn" : "ok"} mb`}
          role="status"
        >
          <strong>
            Auto-place applied {autoResult.appliedCount} placement
            {autoResult.appliedCount === 1 ? "" : "s"}.
          </strong>
          <span>The draft schedule was refreshed and was not published.</span>
          {autoResult.warning ? <span>{autoResult.warning}</span> : null}
          {autoResult.excludedCount ? (
            <span>
              {autoResult.excludedCount} deselected proposal
              {autoResult.excludedCount === 1 ? " remains" : "s remain"}{" "}
              unscheduled.
            </span>
          ) : null}
          {autoResult.unplacedCount ? (
            <>
              <span>
                {autoResult.unplacedCount} session
                {autoResult.unplacedCount === 1 ? " remains" : "s remain"} in
                the source list.
              </span>
              {autoResult.unplaced.length ? (
                <div
                  className="stack"
                  data-testid="auto-placement-confirmed-unplaced"
                >
                  <strong>Unplaced reasons</strong>
                  {autoResult.unplaced.map((item) => (
                    <span key={item.sessionId}>
                      {sessionById.get(item.sessionId)?.title ?? item.sessionId}
                      : {item.reason}
                    </span>
                  ))}
                </div>
              ) : (
                <span>
                  Prepare a fresh preview to review the blocking reasons.
                </span>
              )}
            </>
          ) : null}
        </div>
      ) : null}
      {workspace.activeFilter ? (
        <div className="validation-item schedule-notice info mb" role="status">
          <strong>Filtered view</strong>
          <span>
            {visibleSessions.length} session
            {visibleSessions.length === 1 ? "" : "s"} match{" "}
            {workspace.activeFilter.replaceAll("_", " ")}.
          </span>
          <Link className="btn small" to="/admin/schedule">
            Clear filter
          </Link>
        </div>
      ) : null}
      {workspace.focusedSessionId ? (
        <div className="validation-item schedule-notice info mb" role="status">
          <strong>Focused session</strong>
          <span>
            {sessionById.get(workspace.focusedSessionId)?.title ??
              "Named session"}
          </span>
          <Link className="btn small" to="/admin/schedule">
            Clear focus
          </Link>
        </div>
      ) : null}
      {placementBusy ? (
        <div className="validation-item schedule-notice info mb" role="status">
          <span>Saving schedule change…</span>
        </div>
      ) : null}
      {actionNotices.error ? (
        <div className="validation-item schedule-notice error mb" role="alert">
          <span>{actionNotices.error}</span>
        </div>
      ) : actionResult && "error" in actionResult ? (
        <div className="validation-item schedule-notice error mb" role="alert">
          <span>{actionResult.error}</span>
          {actionNotices.conflicts.map((conflict, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: Duplicate stateless conflict notices are valid and have no persisted identity.
            <span key={`${conflict.type}-${index}`}>
              <strong>{conflictTypeLabel(conflict.type)}:</strong>{" "}
              {conflict.message}
            </span>
          ))}
          {undoAvailable && workspace.version?.status === "draft" ? (
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="undo" />
              <input
                type="hidden"
                name="scheduleVersionId"
                value={workspace.version.id}
              />
              <input
                type="hidden"
                name="scheduleRevision"
                value={undoAvailable.scheduleRevision}
              />
              <input
                type="hidden"
                name="undoToken"
                value={undoAvailable.token}
              />
              <button
                className="btn small"
                type="submit"
                disabled={fetcher.state !== "idle"}
              >
                Undo
              </button>
            </fetcher.Form>
          ) : null}
        </div>
      ) : actionResult?.message ? (
        <div
          className={`validation-item schedule-notice ${actionNotices.warnings.length ? "warn" : "ok"} mb`}
          role="status"
        >
          <span>{actionResult.message}</span>
          {actionNotices.warnings.map((warning, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: Duplicate stateless warning notices are valid and have no persisted identity.
            <span key={`${warning.type}-${index}`}>
              <strong>{conflictTypeLabel(warning.type)}:</strong>{" "}
              {warning.message}
            </span>
          ))}
          {undoAvailable && workspace.version?.status === "draft" ? (
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="undo" />
              <input
                type="hidden"
                name="scheduleVersionId"
                value={workspace.version.id}
              />
              <input
                type="hidden"
                name="scheduleRevision"
                value={undoAvailable.scheduleRevision}
              />
              <input
                type="hidden"
                name="undoToken"
                value={undoAvailable.token}
              />
              <button
                className="btn small"
                type="submit"
                disabled={fetcher.state !== "idle"}
              >
                Undo
              </button>
            </fetcher.Form>
          ) : null}
        </div>
      ) : null}
      <DndContext
        id="schedule-planner-dnd-instructions"
        sensors={placementBusy ? [] : sensors}
        accessibility={{
          screenReaderInstructions: {
            draggable:
              "Press space or enter to pick up this session. Use the arrow keys to move it between rooms and times, space or enter to place it, and escape to cancel.",
          },
          /* dnd-kit's defaults read the raw identifiers aloud, so a keyboard
             user heard "slot:room-301a:1747742400" rather than a room and a
             time. */
          announcements: {
            onDragStart: ({ active }) => `Picked up ${sessionLabel(active)}.`,
            onDragOver: ({ over }) =>
              over ? `Over ${slotLabel(over)}.` : "Not over a placement slot.",
            onDragEnd: ({ active, over }) =>
              over
                ? `Placed ${sessionLabel(active)} in ${slotLabel(over)}.`
                : `${sessionLabel(active)} was not placed.`,
            onDragCancel: ({ active }) =>
              `Cancelled. ${sessionLabel(active)} was not moved.`,
          },
        }}
        onDragStart={(event: DragStartEvent) =>
          setDraggingSessionId(
            String(event.active.data.current?.sessionId ?? ""),
          )
        }
        onDragCancel={() => setDraggingSessionId(null)}
        onDragEnd={(event) => {
          setDraggingSessionId(null);
          place(event);
        }}
      >
        <div
          className={`schedule-workspace${inspectorOpen ? " is-inspecting" : ""}`}
        >
          <ScheduleSourcePanel
            workspace={workspace}
            fetcher={fetcher}
            placementAvailable={placementAvailable}
            quickSessionId={quickSessionId}
            selectQuickSession={inspectSession}
            allPlacementSlots={allPlacementSlots}
            quickStartsAt={quickStartsAt}
            setQuickStartsAt={setQuickStartsAt}
            quickRoomId={quickRoomId}
            setQuickRoomId={setQuickRoomId}
            quickDurationMinutes={quickDurationMinutes}
            setQuickDurationMinutes={setQuickDurationMinutes}
            quickSession={quickSession}
            resourceInventory={resourceInventory}
            visibleSessions={visibleSessions}
            scheduledSessionIds={scheduledSessionIds}
            readOnlyPlacementMessage={readOnlyPlacementMessage}
            quickEntry={quickEntry}
            unassign={unassign}
            submitQuickPlacement={submitQuickPlacement}
          />
          <div className="schedule-stage">
            <ScheduleCanvasPanel
              workspace={workspace}
              fetcher={fetcher}
              view={view}
              setView={setView}
              selectedDay={selectedDay}
              eventDays={eventDays}
              setSelectedDay={setSelectedDay}
              placementAvailable={placementAvailable}
              placementBusy={placementBusy}
              moveInStandardCalendar={moveInStandardCalendar}
              resize={resize}
              selectQuickSession={inspectSession}
              trackGroups={trackGroups}
              sessionById={sessionById}
              roomScrollRef={roomScrollRef}
              slots={slots}
              entriesBySlot={entriesBySlot}
              conflictSeverityByEntryId={conflictSeverityByEntryId}
              revealedEntryIds={revealedEntryIds}
            />
            <ScheduleValidationPanel
              workspace={workspace}
              latestPlacementConflicts={actionNotices.conflicts}
              fetcher={fetcher}
              revealConflictEntries={revealConflictEntries}
            />
          </div>
          <button
            ref={inspectorToggleRef}
            type="button"
            className="schedule-inspector-toggle"
            hidden={inspectorOpen}
            aria-expanded={inspectorOpen}
            aria-controls="schedule-inspector"
            onClick={() => toggleInspector(true)}
          >
            <strong>Notes and session content</strong>
            <span className="help">
              {quickSession ? quickSession.title : "Schedule notes"}
            </span>
          </button>
          <aside
            id="schedule-inspector"
            className="schedule-inspector"
            hidden={!inspectorOpen}
            aria-labelledby="schedule-inspector-title"
            data-testid="schedule-inspector"
          >
            <div className="schedule-inspector-head">
              <div>
                <h2
                  id="schedule-inspector-title"
                  ref={inspectorTitleRef}
                  tabIndex={-1}
                >
                  Notes and session content
                </h2>
                <p className="help">
                  {quickSession
                    ? quickSession.title
                    : "Schedule notes and the selected session"}
                </p>
              </div>
              <button
                type="button"
                className="btn small"
                aria-expanded={inspectorOpen}
                aria-controls="schedule-inspector"
                onClick={() => toggleInspector(false)}
              >
                Hide panel
              </button>
            </div>
            <div className="schedule-inspector-body">
              <ScheduleContentWorkflows
                workspace={workspace}
                session={quickSession ?? null}
                recoveryScope={workspace.recoveryScope}
                calendarPreview={
                  quickSession
                    ? (workspace.calendarPreviews[quickSession.id] ?? null)
                    : null
                }
              />
            </div>
          </aside>
        </div>
        {/* Rendered in a portal above both panes. Without it the dragged card
            is clipped the moment it leaves the source list, which has
            overflow:auto, on its way to a board with overflow:hidden. */}
        <DragOverlay dropAnimation={null}>
          {draggingSessionId ? (
            <div
              className={`session-card is-dragging ${sessionById.get(draggingSessionId)?.format ?? ""}`}
            >
              <span className="session-card-format">
                {sessionFormatLabel(
                  workspace.sessionFormats,
                  sessionById.get(draggingSessionId)?.format ?? "",
                )}
              </span>
              <strong>
                {sessionById.get(draggingSessionId)?.title ?? "Session"}
              </strong>
              <small>
                {sessionById.get(draggingSessionId)?.durationMinutes ?? 0} min
              </small>
            </div>
          ) : null}
        </DragOverlay>
      </DndContext>
      {autoPreview ? (
        <AutoPlacementPreviewDialog
          preview={autoPreview}
          workspace={workspace}
          sessionById={sessionById}
          fetcher={autoPlacementFetcher}
          dismiss={dismissAutoPreview}
          clearError={clearAutoError}
        />
      ) : null}
      {publishOpen && workspace.version && workspace.publicationPreview ? (
        <SchedulePublicationDialog
          workspace={{ ...workspace, version: workspace.version }}
          fetcher={fetcher}
          preview={workspace.publicationPreview}
          close={() => setPublishOpen(false)}
          revealConflictEntries={revealConflictEntries}
        />
      ) : null}
      {draftOpen && workspace.version ? (
        <ScheduleDraftDialog
          workspace={{ ...workspace, version: workspace.version }}
          close={() => setDraftOpen(false)}
        />
      ) : null}
    </div>
  );
}
