import { Copy, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { data, Form, Link, useActionData, useNavigation } from "react-router";
import { ZodError } from "zod";

import type { Route } from "./+types/admin-event-clone";
import { shortReference } from "~/lib/short-reference";
import { useConfirm } from "~/components/ui/confirm-dialog";
import { isAirtableRepositoryError } from "~/modules/airtable/airtable-room-repository.server";
import { EventRepositoryProvisioningError } from "~/modules/events/event-repository-provisioning.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  EventCloneConfigurationError,
  EventCloneService,
  EventCloneSlugConflictError,
} from "~/platform/operations/event-clone-service.server";

async function administrator(
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

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, viewer } = await administrator(request, context);
  return new EventCloneService(env).prepare(viewer);
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    throw new Response("Method not allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }
  const { env, viewer } = await administrator(request, context);
  const form = await request.formData();
  if (form.get("intent") !== "clone") {
    return data(
      {
        ok: false as const,
        message: "Unsupported event clone action.",
        result: null,
      },
      { status: 400 },
    );
  }
  try {
    const result = await new EventCloneService(env).clone(viewer, {
      name: form.get("name"),
      slug: form.get("slug"),
      timezone: form.get("timezone"),
      startDate: form.get("startDate"),
      endDate: form.get("endDate"),
      repositoryProvider: form.get("repositoryProvider"),
      personalAccessToken: form.get("personalAccessToken") ?? undefined,
      baseId: form.get("baseId") ?? undefined,
      tableName: form.get("tableName") ?? undefined,
    });
    return data({
      ok: true as const,
      message: `Event created from the current settings. ${result.repositoryProvider === "airtable" ? "Airtable" : "Program Cue"} holds its event data. People, submissions, schedules, credentials and published programmes were not copied.`,
      result,
    });
  } catch (error) {
    if (error instanceof EventCloneConfigurationError) {
      return data(
        { ok: false as const, message: error.message, result: null },
        { status: 422 },
      );
    }
    if (error instanceof EventRepositoryProvisioningError) {
      return data(
        {
          ok: false as const,
          committed: true as const,
          message: error.message,
          result: {
            eventId: error.eventId,
            operationId: error.operationId,
            repositoryProvider: "airtable" as const,
          },
        },
        { status: error.failureKind === "provider" ? 502 : 500 },
      );
    }
    if (error instanceof EventCloneSlugConflictError) {
      return data(
        { ok: false as const, message: error.message, result: null },
        { status: 409 },
      );
    }
    if (error instanceof ZodError) {
      return data(
        {
          ok: false as const,
          message: error.issues[0]?.message ?? "Review the clone settings.",
          result: null,
        },
        { status: 422 },
      );
    }
    if (isAirtableRepositoryError(error)) {
      return data(
        { ok: false as const, message: error.message, result: null },
        { status: 422 },
      );
    }
    throw error;
  }
}

export const meta = () => [{ title: "Clone event · Program Cue" }];

export default function AdminEventClone({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const { confirm, dialog } = useConfirm();
  const [repositoryProvider, setRepositoryProvider] = useState<
    "d1" | "airtable"
  >("d1");
  return (
    <>
      {dialog}
      <div className="page-head pc-page-header">
        <div>
          <span className="pc-page-eyebrow">Reusable event template</span>
          <h1>Clone {loaderData.source.name}</h1>
          <p>
            Create a clean event with the current branding, rooms, tracks,
            policies and reusable form, evaluation, task and email templates.
          </p>
        </div>
        <Link className="btn" to="/admin/event">
          Back to Event Setup
        </Link>
      </div>
      {actionData ? (
        <div
          className={`pc-status-notice ${actionData.ok ? "is-success" : "is-danger"} mb`}
          role={actionData.ok ? "status" : "alert"}
        >
          <Copy aria-hidden size={18} />
          <div className="pc-status-notice-copy">
            <strong>
              {actionData.ok
                ? "Clone complete"
                : actionData.result
                  ? "Airtable provisioning failed"
                  : "Clone blocked"}
            </strong>
            <div>{actionData.message}</div>
            {actionData.result ? (
              <>
                <p className="subtle">
                  Event reference{" "}
                  <code>{shortReference(actionData.result.eventId)}</code> ·{" "}
                  <Link
                    to={`/admin/operations?operation=${encodeURIComponent(actionData.result.operationId)}`}
                  >
                    View the clone record
                  </Link>
                </p>
                {actionData.ok ? (
                  <Form method="post" action="/events/select">
                    <input
                      type="hidden"
                      name="eventId"
                      value={actionData.result.eventId}
                    />
                    <input type="hidden" name="returnTo" value="/admin/event" />
                    <button className="btn small" type="submit">
                      Open cloned event
                    </button>
                  </Form>
                ) : (
                  <Link
                    className="btn small"
                    to={`/admin/events/${encodeURIComponent(actionData.result.eventId)}/repository-recovery`}
                  >
                    Recover incomplete event
                  </Link>
                )}
              </>
            ) : null}
          </div>
        </div>
      ) : null}
      <div className="grid grid-2">
        <section className="card pad">
          <div className="card-title">
            <h2>New event identity</h2>
            <Copy aria-hidden size={19} />
          </div>
          <Form method="post" className="stack">
            <input type="hidden" name="intent" value="clone" />
            <label className="label">
              Event name
              <input
                className="field"
                name="name"
                defaultValue={loaderData.defaults.name}
                required
                maxLength={160}
              />
            </label>
            <label className="label">
              Public slug
              <input
                className="field"
                name="slug"
                defaultValue={loaderData.defaults.slug}
                required
                pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                maxLength={120}
              />
            </label>
            <label className="label">
              IANA timezone
              <input
                className="field"
                name="timezone"
                defaultValue={loaderData.defaults.timezone}
                required
              />
            </label>
            <div className="grid grid-2">
              <label className="label">
                Start date
                <input
                  className="field"
                  type="date"
                  name="startDate"
                  defaultValue={loaderData.defaults.startDate}
                  required
                />
              </label>
              <label className="label">
                End date
                <input
                  className="field"
                  type="date"
                  name="endDate"
                  defaultValue={loaderData.defaults.endDate}
                  required
                />
              </label>
            </div>
            <fieldset className="card pad">
              <legend className="label">Event-data repository</legend>
              <label className="pc-repository-choice">
                <input
                  type="radio"
                  name="repositoryProvider"
                  value="d1"
                  checked={repositoryProvider === "d1"}
                  onChange={() => setRepositoryProvider("d1")}
                />
                <span>
                  <strong>Program Cue — recommended</strong>
                  <small>Copy all reusable settings in one step.</small>
                </span>
              </label>
              <label className="pc-repository-choice mt">
                <input
                  type="radio"
                  name="repositoryProvider"
                  value="airtable"
                  checked={repositoryProvider === "airtable"}
                  onChange={() => setRepositoryProvider("airtable")}
                />
                <span>
                  <strong>Airtable</strong>
                  <small>
                    Creates the copy here first, then checks your Airtable base,
                    copies the event into it and hands over.
                  </small>
                </span>
              </label>
            </fieldset>
            {repositoryProvider === "airtable" ? (
              <div className="card pad stack">
                <h3>Airtable connection</h3>
                <label className="label">
                  Personal access token
                  <input
                    className="field"
                    type="password"
                    name="personalAccessToken"
                    autoComplete="off"
                    minLength={20}
                    required
                  />
                </label>
                <label className="label">
                  Base ID
                  <input
                    className="field"
                    name="baseId"
                    placeholder="app…"
                    pattern="app[A-Za-z0-9]+"
                    required
                  />
                </label>
                <label className="label">
                  Rooms table
                  <input
                    className="field"
                    name="tableName"
                    defaultValue={loaderData.defaults.airtableTableName}
                    required
                    maxLength={100}
                  />
                </label>
              </div>
            ) : (
              <input
                type="hidden"
                name="tableName"
                value={loaderData.defaults.airtableTableName}
              />
            )}
            <button
              className="btn primary"
              type="button"
              disabled={navigation.state !== "idle"}
              onClick={(event) => {
                const form = event.currentTarget.form;
                if (!form?.reportValidity()) return;
                confirm(
                  {
                    title: "Create this clean clone?",
                    description: `A new event is created from ${loaderData.source.name}, with ${repositoryProvider === "airtable" ? "Airtable" : "Program Cue"} holding its event data. Branding, rooms, tracks, policies and reusable templates are copied; people, submissions, schedules, credentials and published programmes are not.`,
                    confirmLabel: "Create clean clone",
                    tone: "primary",
                  },
                  () => form.requestSubmit(),
                );
              }}
            >
              <Copy aria-hidden size={14} /> Create clean clone
            </button>
          </Form>
        </section>
        <section className="card pad">
          <div className="card-title">
            <h2>Copy boundary</h2>
            <ShieldCheck aria-hidden size={19} />
          </div>
          <h3>Copied as editable templates</h3>
          <p>
            Branding and access defaults, schedule conflict policy, rooms,
            tracks, form versions, evaluation rounds and criteria, task
            templates and dependencies, email templates and disabled triggers.
          </p>
          <h3>Intentionally excluded</h3>
          <p>
            People and memberships other than the creator, submissions, reviews
            and decisions, sessions and schedules, task instances, files,
            messages, calendar invitations, API keys, provider credentials,
            webhooks and publication state.
          </p>
          <p className="help">
            Fixed deadlines, form close dates and evaluation round windows are
            cleared so historical dates cannot silently carry into the new
            event.
          </p>
        </section>
      </div>
    </>
  );
}
