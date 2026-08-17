import { DndContext, DragOverlay, type DragStartEvent } from "@dnd-kit/core";
import { useState } from "react";
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
import { conflictTypeLabel } from "./schedule-planner-workspace-helpers";

import { useSchedulePlannerController } from "./use-schedule-planner-controller";

export {
  parseScheduleActionNotices,
  SCHEDULE_ACTION_INVALID_RESPONSE_MESSAGE,
} from "./schedule-planner-workspace-helpers";

export function SchedulePlannerWorkspace({
  workspace,
}: {
  workspace: SchedulePlannerWorkspaceData;
}) {
  const [draftOpen, setDraftOpen] = useState(false);
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
    publishOpen,
    quickDurationMinutes,
    quickEntry,
    quickRoomId,
    quickSession,
    quickSessionId,
    quickStartsAt,
    readOnlyPlacementMessage,
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
    trackGroups,
    unassign,
    undoAvailable,
    unscheduledSessions,
    view,
    visibleSessions,
  } = useSchedulePlannerController(workspace);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Schedule Planner</h1>
          <p>Build and publish a conflict-checked programme.</p>
        </div>
        <div className="page-actions">
          {workspace.event.programmePublishedAt ? (
            <Link
              className="btn"
              to={`/public/programme/${workspace.event.publicSlug}`}
              target="_blank"
              rel="noreferrer"
            >
              Open public programme
            </Link>
          ) : null}
          <Link className="btn" to="/admin/sessions/new">
            Create direct session
          </Link>
          <button
            className="btn"
            type="button"
            disabled={
              !placementAvailable ||
              unscheduledSessions.length === 0 ||
              autoPlacementFetcher.state !== "idle"
            }
            title={
              !workspace.version
                ? "Create a draft schedule before auto-placing sessions."
                : workspace.version.status !== "draft"
                  ? "Create the next draft before auto-placing sessions."
                  : unscheduledSessions.length === 0
                    ? "There are no unscheduled sessions to place."
                    : undefined
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
          {workspace.version ? (
            <span
              className={`status ${workspace.version.status === "published" ? "success" : "info"}`}
            >
              Version {workspace.version.versionNumber} ·{" "}
              {statusPresentation("version", workspace.version.status).label}
            </span>
          ) : null}
          {workspace.version?.status === "draft" ? (
            <button
              className="btn primary"
              type="button"
              onClick={() => setPublishOpen(true)}
            >
              Publish schedule
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
      <div className="schedule-summary card">
        <div>
          <strong className="pc-num">{workspace.sessions.length}</strong>
          <small>Sessions</small>
        </div>
        <div>
          <strong className="pc-num">{workspace.entries.length}</strong>
          <small>Scheduled</small>
        </div>
        <div>
          <strong className="pc-num">
            {workspace.sessions.length - scheduledSessionIds.size}
          </strong>
          <small>Unscheduled</small>
        </div>
        {workspace.conflicts.length ? (
          <button
            type="button"
            className="schedule-summary-jump"
            onClick={() => {
              const panel = document.getElementById("schedule-validation");
              panel?.scrollIntoView({ block: "center" });
              panel
                ?.querySelector<HTMLElement>(".validation-item button")
                ?.focus({ preventScroll: true });
            }}
          >
            <strong className="pc-num tone-bad">
              {workspace.conflicts.length}
            </strong>
            <small>Open conflicts · review</small>
          </button>
        ) : (
          <div>
            <strong className="pc-num tone-good">0</strong>
            <small>Open conflicts</small>
          </div>
        )}
      </div>
      <fieldset
        className="tabs mt pc-plain-fieldset"
        aria-label="Schedule view"
      >
        {(["room", "list", "day", "week", "track"] as const).map((name) => (
          <button
            key={name}
            type="button"
            aria-pressed={view === name}
            className={`tab${view === name ? " active" : ""}`}
            onClick={() => setView(name)}
          >
            {name[0].toUpperCase() + name.slice(1)}
          </button>
        ))}
      </fieldset>
      <DndContext
        id="schedule-planner-dnd-instructions"
        sensors={sensors}
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
        <div className="schedule-workspace mt">
          <ScheduleSourcePanel
            workspace={workspace}
            fetcher={fetcher}
            placementAvailable={placementAvailable}
            quickSessionId={quickSessionId}
            selectQuickSession={selectQuickSession}
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
          />
          <ScheduleCanvasPanel
            workspace={workspace}
            fetcher={fetcher}
            view={view}
            selectedDay={selectedDay}
            eventDays={eventDays}
            setSelectedDay={setSelectedDay}
            placementAvailable={placementAvailable}
            moveInStandardCalendar={moveInStandardCalendar}
            resize={resize}
            selectQuickSession={selectQuickSession}
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
        {/* Rendered in a portal above both panes. Without it the dragged card
            is clipped the moment it leaves the source list, which has
            overflow:auto, on its way to a board with overflow:hidden. */}
        <DragOverlay dropAnimation={null}>
          {draggingSessionId ? (
            <div className="session-card is-dragging">
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
        />
      ) : null}
      {draftOpen && workspace.version ? (
        <ScheduleDraftDialog
          workspace={{ ...workspace, version: workspace.version }}
          busy={navigation.state !== "idle"}
          close={() => setDraftOpen(false)}
        />
      ) : null}
    </>
  );
}
