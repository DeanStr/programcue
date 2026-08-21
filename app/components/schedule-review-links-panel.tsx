import { useEffect, useId, useRef, useState } from "react";
import { useFetcher } from "react-router";
import { Dialog } from "~/components/dialog";
import { SCHEDULE_REVIEW_LINK_ACKNOWLEDGEMENT } from "~/modules/schedule/schedule-schema";
import type { action as schedulePlannerAction } from "~/routes/schedule-planner.server";
import type { SchedulePlannerWorkspaceData } from "./schedule-planner-panel-types";
import { isRecord } from "./schedule-planner-workspace-helpers";

function actionError(value: unknown) {
  if (!isRecord(value) || value.ok !== false || !("error" in value))
    return null;
  return typeof value.error === "string" ? value.error : null;
}

function isReviewUrlResult(
  value: unknown,
): value is { ok: true; reviewUrl: string; expiresAt: number } {
  return (
    isRecord(value) &&
    value.ok === true &&
    typeof value.reviewUrl === "string" &&
    value.reviewUrl.length > 0 &&
    typeof value.expiresAt === "number"
  );
}

function expiryLabel(epoch: number, timezone: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(new Date(epoch * 1_000));
}

function statusLabel(status: "active" | "expired" | "revoked") {
  if (status === "active") return "Active";
  if (status === "expired") return "Expired";
  return "Revoked";
}

export function ScheduleReviewLinksPanel({
  workspace,
}: {
  workspace: SchedulePlannerWorkspaceData;
}) {
  const createFetcher = useFetcher<typeof schedulePlannerAction>();
  const revokeFetcher = useFetcher<typeof schedulePlannerAction>();
  const [createOpen, setCreateOpen] = useState(false);
  const [urlDismissed, setUrlDismissed] = useState(false);
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const urlFieldId = useId();
  const urlInputRef = useRef<HTMLInputElement>(null);
  const created = isReviewUrlResult(createFetcher.data)
    ? createFetcher.data
    : null;
  const createError = actionError(createFetcher.data);
  const revokeError = actionError(revokeFetcher.data);
  const showCreatedUrl = Boolean(created) && !urlDismissed;
  const creating = createFetcher.state !== "idle";
  const revoking = revokeFetcher.state !== "idle";
  const draft =
    workspace.version?.status === "draft" ? workspace.version : null;
  const [revokeSubmitted, setRevokeSubmitted] = useState(false);

  function closeCreate() {
    if (created) setUrlDismissed(true);
    setCreateOpen(false);
  }

  useEffect(() => {
    if (revokeFetcher.state !== "idle") {
      setRevokeSubmitted(true);
      return;
    }
    if (
      revokeSubmitted &&
      isRecord(revokeFetcher.data) &&
      revokeFetcher.data.ok === true
    ) {
      setRevokeId(null);
      setRevokeSubmitted(false);
    }
  }, [revokeFetcher.data, revokeFetcher.state, revokeSubmitted]);

  useEffect(() => {
    if (createFetcher.state !== "idle") return;
    if (isReviewUrlResult(createFetcher.data)) setUrlDismissed(false);
  }, [createFetcher.data, createFetcher.state]);

  useEffect(() => {
    if (showCreatedUrl) urlInputRef.current?.select();
  }, [showCreatedUrl]);

  return (
    <section
      className="card pad schedule-review-links"
      aria-labelledby="draft-review-links-heading"
    >
      <div className="schedule-review-links-head">
        <div>
          <h2 id="draft-review-links-heading">Draft review links</h2>
          <p className="subtle">
            Share a frozen unpublished timetable. The secret URL is shown once.
            {workspace.reviewLinks.length === 0
              ? " No review links have been created for this event."
              : null}
          </p>
        </div>
        <button
          className="btn ghost"
          type="button"
          disabled={!draft || !workspace.reviewLinkSummary.canCreate}
          title={
            workspace.reviewLinkSummary.blockedReason ??
            (!draft ? "Create a draft schedule first." : undefined)
          }
          onClick={() => {
            setUrlDismissed(true);
            setCreateOpen(true);
          }}
        >
          Create review link
        </button>
      </div>
      {draft && workspace.reviewLinkSummary.blockedReason ? (
        <div className="validation-item warn mt" role="status">
          <strong>Cannot create a review link</strong>
          <span>{workspace.reviewLinkSummary.blockedReason}</span>
        </div>
      ) : null}
      {workspace.reviewLinks.length === 0 ? null : (
        <ul className="schedule-review-link-list">
          {workspace.reviewLinks.map((link) => (
            <li key={link.id}>
              <div>
                <strong>{statusLabel(link.status)}</strong>
                <span>
                  Version {link.versionNumber ?? "—"} · revision{" "}
                  {link.scheduleRevision}
                </span>
                <span>
                  Created{" "}
                  {expiryLabel(link.createdAt, workspace.event.timezone)}
                  {link.createdByName ? ` · ${link.createdByName}` : ""}
                </span>
                <span>
                  Expires{" "}
                  {expiryLabel(link.expiresAt, workspace.event.timezone)}
                </span>
                {link.revocationReason ? (
                  <span>
                    {link.revocationReason === "published"
                      ? "Revoked on publication"
                      : "Manually revoked"}
                  </span>
                ) : null}
              </div>
              {link.status === "active" ? (
                <button
                  className="btn ghost"
                  type="button"
                  onClick={() => {
                    setRevokeSubmitted(false);
                    setRevokeId(link.id);
                  }}
                >
                  Revoke
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {createOpen ? (
        <Dialog
          title="Create a confidential draft review link?"
          description="Anyone with the URL can open a frozen unpublished timetable."
          tone="warning"
          onClose={closeCreate}
          dismissible={!creating}
          footer={
            <>
              <button
                className="btn"
                type="button"
                onClick={closeCreate}
                disabled={creating}
              >
                {showCreatedUrl ? "Close" : "Cancel"}
              </button>
              {showCreatedUrl || !draft ? null : (
                <createFetcher.Form method="post">
                  <input
                    type="hidden"
                    name="intent"
                    value="create-review-link"
                  />
                  <input
                    type="hidden"
                    name="scheduleVersionId"
                    value={draft.id}
                  />
                  <input
                    type="hidden"
                    name="scheduleRevision"
                    value={String(draft.revision)}
                  />
                  <input
                    type="hidden"
                    name="acknowledgement"
                    value={SCHEDULE_REVIEW_LINK_ACKNOWLEDGEMENT}
                  />
                  <input
                    type="hidden"
                    name="projectionHash"
                    value={workspace.reviewLinkSummary.projectionHash ?? ""}
                  />
                  <button
                    className="btn primary"
                    type="submit"
                    disabled={
                      creating || !workspace.reviewLinkSummary.projectionHash
                    }
                  >
                    {creating ? "Creating link…" : "Create confidential link"}
                  </button>
                </createFetcher.Form>
              )}
            </>
          }
        >
          <div className="stack">
            {showCreatedUrl && created ? (
              <>
                <p>
                  Copy this URL now. It cannot be recovered from the list after
                  you close this dialog.
                </p>
                <label htmlFor={urlFieldId}>Confidential preview URL</label>
                <input
                  ref={urlInputRef}
                  id={urlFieldId}
                  readOnly
                  value={created.reviewUrl}
                  onFocus={(event) => event.currentTarget.select()}
                />
                <p className="subtle">
                  Expires{" "}
                  {expiryLabel(created.expiresAt, workspace.event.timezone)}.
                </p>
              </>
            ) : (
              <>
                <p>
                  This snapshot includes{" "}
                  <strong>
                    {workspace.reviewLinkSummary.entryCount} scheduled public
                    session
                    {workspace.reviewLinkSummary.entryCount === 1 ? "" : "s"}
                  </strong>{" "}
                  and{" "}
                  <strong>
                    {workspace.reviewLinkSummary.speakerNameCount} speaker name
                    {workspace.reviewLinkSummary.speakerNameCount === 1
                      ? ""
                      : "s"}
                  </strong>
                  , including unpublished profiles and pending confirmations.
                  Declined speakers are omitted.
                </p>
                <div className="validation-item warn">
                  <strong>This URL is a secret.</strong>
                  <span>
                    Chat unfurlers will fetch a notice page without programme
                    data. Anyone who clicks through can read unpublished speaker
                    names until the link expires, is revoked, the schedule is
                    published, or retention runs.
                  </span>
                </div>
              </>
            )}
            {createError ? (
              <div className="validation-item error" role="alert">
                <strong>Could not create the link</strong>
                <span>{createError}</span>
              </div>
            ) : null}
          </div>
        </Dialog>
      ) : null}
      {revokeId ? (
        <Dialog
          title="Revoke this confidential review link?"
          description="The unpublished snapshot will immediately return a generic not-found page."
          tone="danger"
          onClose={() => {
            setRevokeSubmitted(false);
            setRevokeId(null);
          }}
          dismissible={!revoking}
          footer={
            <>
              <button
                className="btn"
                type="button"
                onClick={() => {
                  setRevokeSubmitted(false);
                  setRevokeId(null);
                }}
                disabled={revoking}
              >
                Cancel
              </button>
              <revokeFetcher.Form method="post">
                <input type="hidden" name="intent" value="revoke-review-link" />
                <input type="hidden" name="linkId" value={revokeId} />
                <input
                  type="hidden"
                  name="confirmation"
                  value="revoke-draft-review-link"
                />
                <button
                  className="btn primary"
                  type="submit"
                  disabled={revoking}
                >
                  {revoking ? "Revoking…" : "Revoke link"}
                </button>
              </revokeFetcher.Form>
            </>
          }
        >
          {revokeError ? (
            <div className="validation-item error" role="alert">
              <strong>Could not revoke the link</strong>
              <span>{revokeError}</span>
            </div>
          ) : (
            <p>
              This cannot be undone. Create a new link if you still need to
              share.
            </p>
          )}
        </Dialog>
      ) : null}
    </section>
  );
}
