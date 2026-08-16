import { Database, Plus, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { data, Form, Link, useActionData, useNavigation } from "react-router";
import { ZodError } from "zod";

import type { Route } from "./+types/admin-event-new";
import { shortReference } from "~/lib/short-reference";
import { zodFieldErrors } from "~/lib/form-errors";
import { DerivedSlugField } from "~/components/ui/derived-slug-field";
import { ErrorSummary } from "~/components/ui/error-summary";
import { EventDateRangeFields } from "~/components/ui/event-date-range-fields";
import { Field } from "~/components/ui/field";
import { TimezoneField } from "~/components/ui/timezone-field";
import { useConfirm } from "~/components/ui/confirm-dialog";
import {
  EventCreationInProgressError,
  EventCreationIntentConflictError,
  EventCreationSenderReuseError,
  EventCreationService,
  EventCreationSlugConflictError,
} from "~/modules/events/event-creation-service.server";
import { EventRepositoryProvisioningError } from "~/modules/events/event-repository-provisioning.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

type ActionResponse = {
  ok: boolean;
  committed: boolean;
  inProgress?: boolean;
  message: string;
  result: {
    eventId: string;
    operationId: string;
    repositoryProvider: "d1" | "airtable";
  } | null;
  fieldErrors?: Record<string, string[]>;
};

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

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, viewer } = await organisationAdministrator(request, context);
  return new EventCreationService(env).prepare(viewer);
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST")
    throw new Response("Method not allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  const { env, viewer } = await organisationAdministrator(request, context);
  const form = await request.formData();
  if (form.get("intent") !== "create")
    return data<ActionResponse>(
      {
        ok: false,
        committed: false,
        message: "Unsupported event creation action.",
        result: null,
      },
      { status: 400 },
    );
  try {
    const rawReuseSenderProfileId = form.get("reuseSenderProfileId");
    const reuseSenderProfileId =
      typeof rawReuseSenderProfileId === "string" && rawReuseSenderProfileId
        ? rawReuseSenderProfileId
        : undefined;
    const result = await new EventCreationService(env).create(viewer, {
      creationIntentId: form.get("creationIntentId"),
      name: form.get("name"),
      slug: form.get("slug"),
      timezone: form.get("timezone"),
      startDate: form.get("startDate"),
      endDate: form.get("endDate"),
      repositoryProvider: form.get("repositoryProvider"),
      reuseSenderProfileId,
      personalAccessToken: form.get("personalAccessToken") ?? undefined,
      baseId: form.get("baseId") ?? undefined,
      tableName: form.get("tableName") ?? undefined,
    });
    const senderOutcome = reuseSenderProfileId
      ? " The selected verified sender is ready for this event."
      : " Configure a sender in Communications before sending email.";
    return data<ActionResponse>({
      ok: true,
      committed: true,
      message: `Blank event created. ${result.repositoryProvider === "airtable" ? "Airtable" : "Program Cue"} holds its event data.${senderOutcome}`,
      result,
    });
  } catch (error) {
    if (error instanceof EventRepositoryProvisioningError)
      return data<ActionResponse>(
        {
          ok: false,
          committed: true,
          message: error.message,
          result: {
            eventId: error.eventId,
            operationId: error.operationId,
            repositoryProvider: "airtable",
          },
        },
        { status: error.failureKind === "provider" ? 502 : 500 },
      );
    if (error instanceof EventCreationInProgressError)
      return data<ActionResponse>(
        {
          ok: false,
          committed: true,
          inProgress: true,
          message: error.message,
          result: error.result,
        },
        { status: 409 },
      );
    if (
      error instanceof EventCreationSlugConflictError ||
      error instanceof EventCreationIntentConflictError ||
      error instanceof EventCreationSenderReuseError
    )
      return data<ActionResponse>(
        {
          ok: false,
          committed: false,
          message: error.message,
          result: null,
          fieldErrors:
            error instanceof EventCreationSlugConflictError
              ? { slug: [error.message] }
              : undefined,
        },
        { status: 409 },
      );
    if (error instanceof ZodError)
      return data<ActionResponse>(
        {
          ok: false,
          committed: false,
          message: error.issues[0]?.message ?? "Review the event settings.",
          result: null,
          fieldErrors: zodFieldErrors(error),
        },
        { status: 422 },
      );
    throw error;
  }
}

export const meta = () => [{ title: "New event · Program Cue" }];

export default function AdminEventNew({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const { confirm, dialog } = useConfirm();
  const [repositoryProvider, setRepositoryProvider] = useState<
    "d1" | "airtable"
  >("d1");
  const [reuseSenderProfileId, setReuseSenderProfileId] = useState("");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [timezone, setTimezone] = useState(loaderData.timezone);
  const fieldErrors = actionData?.fieldErrors ?? {};
  const linkedFieldIds = new Set([
    "name",
    "slug",
    "timezone",
    "startDate",
    "endDate",
  ]);
  const summaryErrors = Object.entries(fieldErrors).flatMap(
    ([field, messages]) =>
      messages.map((message) => ({
        message,
        href: linkedFieldIds.has(field) ? `#event-new-${field}` : undefined,
      })),
  );
  const selectedSender = loaderData.reusableSenderProfiles.find(
    (profile) => profile.id === reuseSenderProfileId,
  );
  const emailProviderLabel =
    loaderData.emailProvider === "resend"
      ? "Resend"
      : loaderData.emailProvider === "mailpit"
        ? "Mailpit"
        : "email provider";
  return (
    <>
      {dialog}
      <div className="page-head pc-page-header">
        <div>
          <span className="pc-page-eyebrow">Blank event workspace</span>
          <h1>New event</h1>
          <p>
            Start with Program Cue defaults and no rooms, tracks, forms,
            submissions, schedules or reusable templates.
          </p>
        </div>
        <Link className="btn" to="/admin/event">
          Back to Event Setup
        </Link>
      </div>
      {actionData ? (
        <div
          className={`pc-status-notice ${actionData.ok ? "is-success" : actionData.inProgress ? "" : "is-danger"} mb`}
          role={actionData.ok || actionData.inProgress ? "status" : "alert"}
        >
          <Plus aria-hidden size={18} />
          <div className="pc-status-notice-copy">
            <strong>
              {actionData.ok
                ? "Event created"
                : actionData.inProgress
                  ? "Event creation in progress"
                  : actionData.committed
                    ? "Airtable provisioning failed"
                    : "Event creation blocked"}
            </strong>
            <div>{actionData.message}</div>
            {actionData.result ? (
              <>
                <p className="subtle">
                  Event reference{" "}
                  <code>{shortReference(actionData.result.eventId)}</code>
                </p>
                {actionData.ok ? (
                  <>
                    <Form method="post" action="/events/select">
                      <input
                        type="hidden"
                        name="eventId"
                        value={actionData.result.eventId}
                      />
                      <input
                        type="hidden"
                        name="returnTo"
                        value={`/admin/operations?operation=${encodeURIComponent(actionData.result.operationId)}`}
                      />
                      <button className="btn small" type="submit">
                        View creation operation
                      </button>
                    </Form>
                    <Form method="post" action="/events/select">
                      <input
                        type="hidden"
                        name="eventId"
                        value={actionData.result.eventId}
                      />
                      <input
                        type="hidden"
                        name="returnTo"
                        value="/admin/event"
                      />
                      <button className="btn small" type="submit">
                        Open new event
                      </button>
                    </Form>
                  </>
                ) : (
                  <Link
                    className="btn small"
                    to={`/admin/events/${encodeURIComponent(actionData.result.eventId)}/repository-recovery`}
                  >
                    {actionData.inProgress
                      ? "View provisioning status"
                      : "Recover incomplete event"}
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
            <h2>Event identity</h2>
            <Plus aria-hidden size={19} />
          </div>
          <Form method="post" className="stack">
            <input type="hidden" name="intent" value="create" />
            <input
              type="hidden"
              name="creationIntentId"
              value={loaderData.creationIntentId}
            />
            <ErrorSummary errors={summaryErrors} />
            <Field
              label="Event name"
              required
              error={fieldErrors.name?.[0]}
            >
              <input
                id="event-new-name"
                className="field"
                name="name"
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                required
                maxLength={160}
              />
            </Field>
            <DerivedSlugField
              id="event-new-slug"
              source={name}
              value={slug}
              onChange={setSlug}
              name="slug"
              label="Public slug"
              maximumLength={120}
              publicPathPrefix="/public/programme/"
              availabilityUrl="/admin/events/slug-availability"
              error={fieldErrors.slug?.[0]}
            />
            <TimezoneField
              id="event-new-timezone"
              value={timezone}
              onChange={setTimezone}
              error={fieldErrors.timezone?.[0]}
            />
            <EventDateRangeFields
              idPrefix="event-new"
              initialStartDate={loaderData.startDate}
              initialEndDate={loaderData.endDate}
              error={fieldErrors.endDate?.[0] ?? fieldErrors.startDate?.[0]}
            />
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
                  <small>Keep event data here. Nothing else to set up.</small>
                </span>
              </label>
              <label className="pc-repository-choice mt">
                <input
                  type="radio"
                  name="repositoryProvider"
                  value="airtable"
                  checked={repositoryProvider === "airtable"}
                  onChange={() => {
                    setRepositoryProvider("airtable");
                    setReuseSenderProfileId("");
                  }}
                />
                <span>
                  <strong>Airtable</strong>
                  <small>
                    Creates the event here first, then checks your Airtable
                    base, copies the event into it and hands over.
                  </small>
                </span>
              </label>
            </fieldset>
            {repositoryProvider === "d1" ? (
              <fieldset className="card pad stack">
                <legend className="label">Email sender</legend>
                <label className="label">
                  Reuse verified sender
                  <select
                    className="field"
                    name="reuseSenderProfileId"
                    value={reuseSenderProfileId}
                    onChange={(event) =>
                      setReuseSenderProfileId(event.currentTarget.value)
                    }
                  >
                    <option value="">None — configure later</option>
                    {loaderData.reusableSenderProfiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profile.fromName} &lt;{profile.fromEmail}&gt; ·{" "}
                        {profile.sourceEventName}
                      </option>
                    ))}
                  </select>
                </label>
                <p className="help">
                  {loaderData.emailProviderIssue
                    ? `Sender reuse is unavailable: ${loaderData.emailProviderIssue} You can create this event without a sender, but email sends fail until the provider and a verified sender are configured.`
                    : loaderData.reusableSenderProfiles.length > 0
                      ? `Copies the exact verified ${emailProviderLabel} sender and reply-to identity into the new event. Choose None to configure it later in Communications.`
                      : `No verified ${emailProviderLabel} sender is available in an active event in this organisation. Configure one later in Communications.`}
                </p>
                {selectedSender ? (
                  <p className="help">
                    Reply-to:{" "}
                    {selectedSender.replyToEmail ?? selectedSender.fromEmail}.
                    Source profile: {selectedSender.name}.
                  </p>
                ) : null}
              </fieldset>
            ) : null}
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
                    defaultValue={loaderData.airtableTableName}
                    required
                    maxLength={100}
                  />
                </label>
              </div>
            ) : (
              <input
                type="hidden"
                name="tableName"
                value={loaderData.airtableTableName}
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
                    title: "Create this blank event?",
                    description: `${repositoryProvider === "airtable" ? "Airtable" : "Program Cue"} will hold this event's data.${selectedSender ? ` The verified sender ${selectedSender.fromName} <${selectedSender.fromEmail}> is copied from ${selectedSender.sourceEventName}.` : " No sender is copied, so email sending stays blocked until you configure one."} Changing this later means reviewing and confirming a full list of changes.`,
                    confirmLabel: "Create blank event",
                    tone: "primary",
                  },
                  () => form.requestSubmit(),
                );
              }}
            >
              <Plus aria-hidden size={14} /> Create blank event
            </button>
          </Form>
        </section>
        <section className="card pad">
          <div className="card-title">
            <h2>Starting state</h2>
            <ShieldCheck aria-hidden size={19} />
          </div>
          <h3>Included</h3>
          <p>
            Canonical session formats, private-file limits, schedule conflict
            policy, secure submission defaults and complete creation audit.
          </p>
          <h3>Empty by design</h3>
          <p>
            Rooms, tracks, forms, evaluation plans, task templates,
            communication templates, people, submissions, sessions, files and
            publication state. Sender profiles also begin empty unless you
            explicitly reuse the verified identity selected above.
          </p>
          <div className="pc-status-notice mt">
            <Database aria-hidden size={18} />
            <div className="pc-status-notice-copy">
              <strong>Repository choice is consequential</strong>
              <div>
                Changing it later requires the existing preview, reconciliation
                and confirmation workflow.
              </div>
            </div>
          </div>
          <p className="help">
            To reuse configuration instead, return to the event menu and choose
            Clone current event.
          </p>
        </section>
      </div>
    </>
  );
}
