import { useEffect } from "react";
import { useFetcher } from "react-router";
import { Dialog } from "~/components/dialog";
import { Button } from "~/components/ui/button";
import { StatusNotice } from "~/components/ui/status-notice";
import type { action } from "~/routes/schedule-planner.server";
import { isRecord } from "./schedule-planner-workspace-helpers";

export function ScheduleBreakDialog({
  resources,
  onClose,
  onCreated,
}: {
  resources: string[];
  onClose(): void;
  onCreated(notice: { message: string; warning: boolean }): void;
}) {
  const fetcher = useFetcher<typeof action>();
  const busy = fetcher.state !== "idle";
  const result = fetcher.data;
  const invalidResponse =
    result !== undefined &&
    (!isRecord(result) ||
      (result.ok !== true && result.ok !== false) ||
      (result.ok === true
        ? !("message" in result) ||
          typeof result.message !== "string" ||
          !result.message.trim()
        : !("error" in result) ||
          typeof result.error !== "string" ||
          !result.error.trim()));
  const committed =
    isRecord(result) &&
    (result.ok === true ||
      ("committed" in result && result.committed === true));
  const error = invalidResponse
    ? "Break creation returned an invalid response. Close and refresh the schedule to check whether the break was created before trying again."
    : result && "error" in result
      ? result.error
      : null;
  const message =
    !invalidResponse && result && "message" in result ? result.message : null;
  useEffect(() => {
    if (!busy && result?.ok === true && message)
      onCreated({ message, warning: false });
  }, [busy, result, message, onCreated]);

  return (
    <Dialog
      title="Create break"
      description="Add a break to the unscheduled sessions, then choose its slot."
      dismissible={!busy}
      onClose={() => {
        if (committed && error) onCreated({ message: error, warning: true });
        else onClose();
      }}
      footer={
        (committed || invalidResponse) && error ? (
          <Button
            disabled={busy}
            type="button"
            onClick={() => {
              if (committed) onCreated({ message: error, warning: true });
              else onClose();
            }}
          >
            Close
          </Button>
        ) : undefined
      }
    >
      {error ? (
        <StatusNotice
          tone={committed ? "warning" : "danger"}
          title={
            invalidResponse
              ? "Check break creation"
              : committed
                ? "Break created; follow-up needed"
                : "Break could not be created"
          }
        >
          {error}
        </StatusNotice>
      ) : null}
      {!committed && !invalidResponse ? (
        <fetcher.Form method="post" className="stack mt">
          <input type="hidden" name="intent" value="create-break" />
          <fieldset disabled={busy} className="stack pc-plain-fieldset">
            <label className="label">
              Label
              <input
                className="field"
                name="title"
                defaultValue="Refreshment break"
                maxLength={160}
                required
              />
            </label>
            <label className="label">
              Duration (minutes)
              <input
                className="field"
                name="durationMinutes"
                type="number"
                min={5}
                max={480}
                defaultValue={30}
                required
              />
            </label>
            {resources.length ? (
              <fieldset className="stack pc-plain-fieldset">
                <legend className="label">Exclusive resources</legend>
                {resources.map((resource) => (
                  <label className="toggle" key={resource}>
                    <input
                      type="checkbox"
                      name="requiredResource"
                      value={resource}
                    />{" "}
                    {resource}
                  </label>
                ))}
              </fieldset>
            ) : (
              <p className="help">
                No room resources are configured; this break will not reserve
                one.
              </p>
            )}
            <Button type="submit" pending={busy} pendingLabel="Creating break…">
              Create unscheduled break
            </Button>
          </fieldset>
        </fetcher.Form>
      ) : null}
    </Dialog>
  );
}
