import { useState } from "react";
import { data, Form, useActionData, useNavigation } from "react-router";
import { ZodError } from "zod";
import { SpeakerActionNotice } from "~/components/speaker-action-notice";
import { useSpeakerWorkspace } from "~/components/speaker-workspace-context";
import { Button } from "~/components/ui/button";
import { useConfirm } from "~/components/ui/confirm-dialog";
import { ScheduleRevisionConflictError } from "~/modules/schedule/schedule-errors";
import {
  eventBoundaryCalendarDate,
  formatEventLocalAvailabilityWindow,
} from "~/modules/schedule/schedule-time";
import {
  SpeakerAdminStateError,
  SpeakerService,
} from "~/modules/speakers/speaker-service.server";
import { requireSpeakerWorkspace } from "~/modules/speakers/speaker-workspace.server";
import { notifyRouteChange } from "~/platform/realtime/route-realtime.server";
import type { Route } from "./+types/speaker-availability";

export const meta = () => [{ title: "Availability · Program Cue" }];

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, viewer } = await requireSpeakerWorkspace(request, context);
  try {
    return await new SpeakerService(env).listOwnAvailability(viewer);
  } catch (error) {
    if (error instanceof SpeakerAdminStateError && error.status === 403) {
      throw new Response(error.message, { status: 403 });
    }
    throw error;
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env, viewer } = await requireSpeakerWorkspace(request, context);
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent !== "create-blackout" && intent !== "delete-blackout") {
    return data(
      { ok: false, message: "Unsupported availability action." },
      { status: 400 },
    );
  }
  try {
    const service = new SpeakerService(env);
    const result =
      intent === "create-blackout"
        ? await service.createOwnAvailability(viewer, {
            eventRevision: form.get("eventRevision"),
            startDate: form.get("startDate"),
            endDate: form.get("endDate"),
            startTime: form.get("startTime"),
            endTime: form.get("endTime"),
            allDay: form.get("allDay"),
            note: form.get("note"),
          })
        : await service.deleteOwnAvailability(viewer, {
            eventRevision: form.get("eventRevision"),
            windowId: form.get("windowId"),
            confirmation: form.get("confirmation"),
          });
    const realtimeFailure = await notifyRouteChange(
      env,
      viewer,
      result.changeSequence,
      result.personId,
    );
    if (realtimeFailure) return data(realtimeFailure, { status: 207 });
    return data({
      ok: true,
      message:
        intent === "create-blackout"
          ? `Saved unavailable period ${result.interval}.`
          : `Removed unavailable period ${result.interval}.`,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return data(
        {
          ok: false,
          message: error.issues[0]?.message ?? "Review the unavailable period.",
        },
        { status: 422 },
      );
    }
    if (error instanceof ScheduleRevisionConflictError) {
      return data({ ok: false, message: error.message }, { status: 409 });
    }
    if (error instanceof SpeakerAdminStateError) {
      return data(
        { ok: false, message: error.message },
        { status: error.status },
      );
    }
    if (error instanceof Response) throw error;
    throw error;
  }
}

export default function SpeakerAvailability({
  loaderData,
}: Route.ComponentProps) {
  const { portal } = useSpeakerWorkspace();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const { confirm, dialog } = useConfirm();
  const busy = navigation.state !== "idle";
  const [allDay, setAllDay] = useState(false);
  const minDate = eventBoundaryCalendarDate(loaderData.event.startsAt);
  const maxDate = eventBoundaryCalendarDate(loaderData.event.endsAt);
  return (
    <>
      {dialog}
      <div className="page-head">
        <div>
          <h1>Availability</h1>
          <p>
            Tell organisers when you cannot be scheduled. Times use the event
            timezone, {portal.event.timezone}.
          </p>
        </div>
        <p className="speaker-work-count">
          <b className="pc-num">{loaderData.windows.length}</b>
          <span>{loaderData.windows.length === 1 ? "period" : "periods"}</span>
        </p>
      </div>
      <SpeakerActionNotice notice={actionData} />
      <section className="stack">
        <h2>Add an unavailable period</h2>
        <Form method="post" className="stack">
          <input type="hidden" name="intent" value="create-blackout" />
          <input
            type="hidden"
            name="eventRevision"
            value={loaderData.event.revision}
          />
          <div className="form-row">
            <label className="label">
              Start date
              <input
                className="field"
                type="date"
                name="startDate"
                required
                min={minDate}
                max={maxDate}
                defaultValue={minDate}
              />
            </label>
            <label className="label">
              End date
              <input
                className="field"
                type="date"
                name="endDate"
                required
                min={minDate}
                max={maxDate}
                defaultValue={minDate}
              />
            </label>
          </div>
          <label className="label">
            <input
              type="checkbox"
              name="allDay"
              value="true"
              checked={allDay}
              onChange={(event) => setAllDay(event.currentTarget.checked)}
            />{" "}
            All day
          </label>
          {allDay ? null : (
            <div className="form-row">
              <label className="label">
                Start time ({portal.event.timezone})
                <input
                  className="field"
                  type="time"
                  name="startTime"
                  step="60"
                  required
                />
              </label>
              <label className="label">
                End time ({portal.event.timezone})
                <input
                  className="field"
                  type="time"
                  name="endTime"
                  step="60"
                  required
                />
              </label>
            </div>
          )}
          <label className="label">
            Private note
            <textarea
              className="textarea"
              name="note"
              maxLength={500}
              rows={3}
              placeholder="Optional. Only you can see this note."
            />
            <span className="help">
              Organisers see the unavailable times, not this note.
            </span>
          </label>
          <Button variant="primary" type="submit" disabled={busy}>
            {busy ? "Saving…" : "Add unavailable period"}
          </Button>
        </Form>
      </section>
      <section className="stack mt">
        <h2>Your unavailable periods</h2>
        {loaderData.windows.length === 0 ? (
          <p className="subtle">You have not recorded any unavailable times.</p>
        ) : (
          <ul className="stack">
            {loaderData.windows.map((window) => (
              <li key={window.id} className="stack">
                <p>
                  <strong>
                    {formatEventLocalAvailabilityWindow(
                      window.startsAt,
                      window.endsAt,
                      portal.event.timezone,
                    )}
                  </strong>
                </p>
                {window.note ? <p className="subtle">{window.note}</p> : null}
                <Form method="post">
                  <input type="hidden" name="intent" value="delete-blackout" />
                  <input
                    type="hidden"
                    name="eventRevision"
                    value={loaderData.event.revision}
                  />
                  <input type="hidden" name="windowId" value={window.id} />
                  <input type="hidden" name="confirmation" value="delete" />
                  <Button
                    type="button"
                    disabled={busy}
                    onClick={(clickEvent) => {
                      const form = clickEvent.currentTarget.form;
                      if (!form) return;
                      confirm(
                        {
                          title: "Remove this unavailable period?",
                          description:
                            "Organisers will be able to schedule you during this time again.",
                          records: [
                            formatEventLocalAvailabilityWindow(
                              window.startsAt,
                              window.endsAt,
                              portal.event.timezone,
                            ),
                          ],
                          confirmLabel: "Remove period",
                        },
                        () => {
                          form.requestSubmit();
                        },
                      );
                    }}
                  >
                    Remove
                  </Button>
                </Form>
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
