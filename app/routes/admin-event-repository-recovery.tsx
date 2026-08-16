import { AlertTriangle, Database, RotateCcw, Trash2 } from "lucide-react";
import { data, Form, Link, useActionData, useNavigation } from "react-router";
import { ZodError } from "zod";
import { useConfirm } from "~/components/ui/confirm-dialog";
import { fieldLabel } from "~/lib/record-labels";
import { EventRepositoryProvisioningError } from "~/modules/events/event-repository-provisioning.server";
import {
  EventRepositoryRecoveryService,
  EventRepositoryRecoveryStateError,
} from "~/modules/events/event-repository-recovery.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/admin-event-repository-recovery";

async function organisationAdministrator(
  request: Request,
  context: Route.LoaderArgs["context"],
) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  return { env, viewer };
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env, viewer } = await organisationAdministrator(request, context);
  return new EventRepositoryRecoveryService(env).inspect(
    viewer,
    params.eventId,
  );
}

export async function action({ request, context, params }: Route.ActionArgs) {
  if (request.method !== "POST")
    throw new Response("Method not allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  const { env, viewer } = await organisationAdministrator(request, context);
  const form = await request.formData();
  const service = new EventRepositoryRecoveryService(env);
  try {
    switch (form.get("intent")) {
      case "retry_airtable": {
        const result = await service.retryAirtable(viewer, params.eventId, {
          personalAccessToken: form.get("personalAccessToken"),
          baseId: form.get("baseId"),
          tableName: form.get("tableName"),
        });
        return data({
          ok: true as const,
          message:
            "Airtable provisioning completed and the event is now active.",
          result,
        });
      }
      case "fail_stalled_creation": {
        const result = await service.failStalledCreation(
          viewer,
          params.eventId,
        );
        return data({
          ok: true as const,
          pendingRecovery: true as const,
          message:
            "The stalled creation was moved to explicit repository recovery. No Airtable request was made.",
          result,
        });
      }
      case "keep_d1": {
        const result = await service.keepOnD1(viewer, params.eventId);
        return data({
          ok: true as const,
          message: "The event is active, with Program Cue holding its data.",
          result,
        });
      }
      case "discard": {
        const result = await service.discard(viewer, params.eventId);
        return data({
          ok: true as const,
          message:
            "The incomplete event was discarded and its public slug was released. Program Cue did not claim deletion of any provider-side schema or partial records.",
          result,
        });
      }
      default:
        return data(
          {
            ok: false as const,
            message: "Unsupported recovery action.",
            result: null,
          },
          { status: 400 },
        );
    }
  } catch (error) {
    if (error instanceof EventRepositoryProvisioningError)
      return data(
        {
          ok: false as const,
          message: error.message,
          result: {
            eventId: error.eventId,
            operationId: error.operationId,
            activationStatus: "provisioning_failed" as const,
          },
        },
        { status: error.failureKind === "provider" ? 502 : 500 },
      );
    if (error instanceof EventRepositoryRecoveryStateError)
      return data(
        { ok: false as const, message: error.message, result: null },
        { status: 409 },
      );
    if (error instanceof ZodError)
      return data(
        {
          ok: false as const,
          message: error.issues[0]?.message ?? "Review the Airtable settings.",
          result: null,
        },
        { status: 422 },
      );
    throw error;
  }
}

export const meta = () => [{ title: "Recover event repository · Program Cue" }];

export default function AdminEventRepositoryRecovery({
  loaderData,
}: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const { confirm, dialog } = useConfirm();
  const busy = navigation.state !== "idle";
  const pendingRecovery = Boolean(
    actionData && "pendingRecovery" in actionData && actionData.pendingRecovery,
  );
  const active = loaderData.activationStatus === "active";
  const discarded = loaderData.activationStatus === "discarded";
  const failed = loaderData.activationStatus === "provisioning_failed";
  const retryFenced =
    failed &&
    loaderData.operationFailureCode === "event_creation_lease_expired";
  const stalledCreation =
    loaderData.activationStatus === "provisioning" &&
    loaderData.operationType === "event.create" &&
    loaderData.operationStatus === "running" &&
    loaderData.operationLeaseExpired === 1;
  return (
    <>
      {dialog}
      <div className="page-head pc-page-header">
        <div>
          <span className="pc-page-eyebrow">Incomplete event setup</span>
          <h1>{loaderData.name}</h1>
          <p>
            {active
              ? "This event is fully set up and available for normal use."
              : discarded
                ? "This event was discarded. Only its history remains, and it cannot be opened."
                : "This event cannot be opened until its Airtable connection is completed, or you choose to keep it in Program Cue instead."}
          </p>
        </div>
        <Link className="btn" to="/admin/event">
          Back to Event settings
        </Link>
      </div>

      {actionData ? (
        <div
          className={`pc-status-notice ${actionData.ok && !pendingRecovery ? "is-success" : actionData.ok ? "" : "is-danger"} mb`}
          role={actionData.ok ? "status" : "alert"}
        >
          <AlertTriangle aria-hidden size={18} />
          <div className="pc-status-notice-copy">
            <strong>
              {pendingRecovery
                ? "Recovery decision required"
                : actionData.ok
                  ? "Recovery complete"
                  : "Recovery failed"}
            </strong>
            <div>{actionData.message}</div>
            {actionData.result?.activationStatus === "active" ? (
              <Form method="post" action="/events/select">
                <input
                  type="hidden"
                  name="eventId"
                  value={actionData.result.eventId}
                />
                <input type="hidden" name="returnTo" value="/admin/event" />
                <button className="btn small" type="submit">
                  Open recovered event
                </button>
              </Form>
            ) : null}
          </div>
        </div>
      ) : null}

      <section className="card pad stack">
        <div>
          <strong>Event data held by</strong>
          <div>
            {loaderData.repositoryProvider === "airtable"
              ? "Airtable"
              : "Program Cue"}
          </div>
        </div>
        <div>
          <strong>Activation state</strong>
          <div>{fieldLabel(loaderData.activationStatus)}</div>
        </div>
        <div>
          <strong>Last operation</strong>
          <div>
            <code>{loaderData.lastOperationId ?? "Unavailable"}</code>
            {loaderData.operationStatus
              ? ` · ${loaderData.operationStatus}`
              : ""}
          </div>
        </div>
        {loaderData.lastError ? (
          <div>
            <strong>Provider error</strong>
            <div>{loaderData.lastError}</div>
          </div>
        ) : null}
      </section>

      {stalledCreation ? (
        <section className="card pad stack mt">
          <div className="card-title">
            <h2>Creation stalled</h2>
            <AlertTriangle aria-hidden size={19} />
          </div>
          <p>
            Setup ran out of time without finishing. Move this event to recovery
            before retrying Airtable, keeping it in Program Cue or discarding
            it. This action does not contact Airtable.
          </p>
          <Form method="post">
            <input type="hidden" name="intent" value="fail_stalled_creation" />
            <button
              className="btn danger"
              type="button"
              disabled={busy}
              onClick={(event) => {
                const form = event.currentTarget.form;
                confirm(
                  {
                    title: "Move this stalled creation to recovery?",
                    description:
                      "The timed-out setup cannot resume after this change. You then choose between retrying Airtable, keeping the event in Program Cue, or discarding it. Airtable is not contacted.",
                    records: [`${loaderData.name} · ${loaderData.slug}`],
                    confirmLabel: "Move to recovery",
                  },
                  () => form?.requestSubmit(),
                );
              }}
            >
              Move stalled creation to recovery
            </button>
          </Form>
        </section>
      ) : null}

      {failed ? (
        <div className="grid grid-2 mt">
          <section className="card pad">
            <div className="card-title">
              <h2>
                {retryFenced ? "Airtable retry unavailable" : "Retry Airtable"}
              </h2>
              {retryFenced ? (
                <AlertTriangle aria-hidden size={19} />
              ) : (
                <RotateCcw aria-hidden size={19} />
              )}
            </div>
            {retryFenced ? (
              <p>
                The timed-out attempt may still be running against Airtable, so
                starting another one is unsafe. Keep this event in Program Cue
                or discard it; Program Cue will not assume the earlier attempt
                has stopped.
              </p>
            ) : (
              <>
                <p>
                  Credentials and repository identifiers are required again.
                  Program Cue does not substitute a stored, stale, or different
                  repository configuration.
                </p>
                <Form method="post" className="stack">
                  <input type="hidden" name="intent" value="retry_airtable" />
                  <label className="label">
                    Personal access token
                    <input
                      className="field"
                      type="password"
                      name="personalAccessToken"
                      autoComplete="off"
                      required
                    />
                  </label>
                  <label className="label">
                    Base ID
                    <input className="field" name="baseId" required />
                  </label>
                  <label className="label">
                    Rooms table
                    <input className="field" name="tableName" required />
                  </label>
                  <button className="btn primary" type="submit" disabled={busy}>
                    Retry Airtable
                  </button>
                </Form>
              </>
            )}
          </section>

          <section className="card pad stack">
            <div className="card-title">
              <h2>Choose another outcome</h2>
              <Database aria-hidden size={19} />
            </div>
            <Form method="post">
              <input type="hidden" name="intent" value="keep_d1" />
              <button
                className="btn"
                type="button"
                disabled={busy}
                onClick={(event) => {
                  const form = event.currentTarget.form;
                  confirm(
                    {
                      title: "Keep this event in Program Cue?",
                      description:
                        "Program Cue takes over this event's data and the incomplete Airtable connection is removed. Airtable cannot be retried for this event afterwards.",
                      records: [`${loaderData.name} · ${loaderData.slug}`],
                      confirmLabel: "Keep in Program Cue",
                      tone: "primary",
                    },
                    () => form?.requestSubmit(),
                  );
                }}
              >
                Keep this event in Program Cue
              </button>
            </Form>
            <p>
              This activates the event with Program Cue holding its data, and
              removes the incomplete Airtable connection.
            </p>
            <Form method="post">
              <input type="hidden" name="intent" value="discard" />
              <button
                className="btn danger"
                type="button"
                disabled={busy}
                onClick={(event) => {
                  const form = event.currentTarget.form;
                  confirm(
                    {
                      title: "Discard this incomplete event?",
                      description:
                        "Its Program Cue data remains only as an inaccessible audit tombstone and the public slug is released. Provider-side schema or partial records are not deleted.",
                      records: [`${loaderData.name} · ${loaderData.slug}`],
                      confirmLabel: "Discard event",
                    },
                    () => form?.requestSubmit(),
                  );
                }}
              >
                <Trash2 aria-hidden size={16} /> Discard incomplete event
              </button>
            </Form>
          </section>
        </div>
      ) : null}
    </>
  );
}
