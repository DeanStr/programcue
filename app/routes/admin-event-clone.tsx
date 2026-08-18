import { Copy, ShieldCheck } from "lucide-react";
import { useState } from "react";
import { data, Form, Link, useActionData, useNavigation } from "react-router";
import { ZodError } from "zod";
import { useConfirm } from "~/components/ui/confirm-dialog";
import { DerivedSlugField } from "~/components/ui/derived-slug-field";
import { ErrorSummary } from "~/components/ui/error-summary";
import { EventDateRangeFields } from "~/components/ui/event-date-range-fields";
import { Field } from "~/components/ui/field";
import { PageHeader } from "~/components/ui/page-header";
import { TimezoneField } from "~/components/ui/timezone-field";
import { zodFieldErrors } from "~/lib/form-errors";
import { shortReference } from "~/lib/short-reference";
import { slugify } from "~/lib/slug";
import { isAirtableRepositoryError } from "~/modules/airtable/airtable-room-repository.server";
import { EventRepositoryProvisioningError } from "~/modules/events/event-repository-provisioning.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  EventCloneConfigurationError,
  EventCloneService,
  EventCloneSlugConflictError,
} from "~/platform/operations/event-clone-service.server";
import "~/styles/workspace-remaining.css";
import type { Route } from "./+types/admin-event-clone";

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
      reusedSenderProfileId:
        String(form.get("reusedSenderProfileId") ?? "").trim() || undefined,
    });
    return data({
      ok: true as const,
      message: `Event created from the current settings. ${result.repositoryProvider === "airtable" ? "Airtable" : "Program Cue"} holds its event data.${result.copied.senders ? " The selected verified sender was copied; provider credentials were not." : ""} People, submissions, schedules, credentials and published programmes were not copied.`,
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
        {
          ok: false as const,
          message: error.message,
          result: null,
          fieldErrors: { slug: [error.message] },
        },
        { status: 409 },
      );
    }
    if (error instanceof ZodError) {
      return data(
        {
          ok: false as const,
          message: error.issues[0]?.message ?? "Review the clone settings.",
          result: null,
          fieldErrors: zodFieldErrors(error),
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
  const [name, setName] = useState(loaderData.defaults.name);
  const [slug, setSlug] = useState(loaderData.defaults.slug);
  const [timezone, setTimezone] = useState(loaderData.defaults.timezone);
  const fieldErrors: Record<string, string[]> =
    actionData && "fieldErrors" in actionData && actionData.fieldErrors
      ? (actionData.fieldErrors as Record<string, string[]>)
      : {};
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
        href: linkedFieldIds.has(field) ? `#event-clone-${field}` : undefined,
      })),
  );
  return (
    <div className="pc-event-create">
      {dialog}
      <PageHeader
        eyebrow="Reusable event template"
        title={`Clone ${loaderData.source.name}`}
        description="Create a clean event with the published branding settings, rooms, tracks, policies and reusable form, evaluation, task and email templates."
        actions={
          <Link className="btn" to="/admin/event">
            Back to Event settings
          </Link>
        }
      />
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
      <div className="event-setup-create">
        <section className="card pad event-setup-surface event-setup-create-form">
          <header className="event-setup-surface-head">
            <h3>New event identity</h3>
            <p>A clean event from the current published settings.</p>
          </header>
          <Form method="post" className="stack">
            <input type="hidden" name="intent" value="clone" />
            <ErrorSummary errors={summaryErrors} />
            <Field label="Event name" required error={fieldErrors.name?.[0]}>
              <input
                id="event-clone-name"
                className="field"
                name="name"
                value={name}
                onChange={(event) => setName(event.currentTarget.value)}
                required
                maxLength={160}
              />
            </Field>
            <DerivedSlugField
              id="event-clone-slug"
              source={name}
              value={slug}
              onChange={setSlug}
              name="slug"
              label="Public slug"
              maximumLength={120}
              initiallyDerived={
                loaderData.defaults.slug ===
                slugify(loaderData.defaults.name, { maximumLength: 120 })
              }
              publicPathPrefix="/public/programme/"
              availabilityUrl="/admin/events/slug-availability"
              error={fieldErrors.slug?.[0]}
            />
            <TimezoneField
              id="event-clone-timezone"
              value={timezone}
              onChange={setTimezone}
              error={fieldErrors.timezone?.[0]}
            />
            <EventDateRangeFields
              idPrefix="event-clone"
              initialStartDate={loaderData.defaults.startDate}
              initialEndDate={loaderData.defaults.endDate}
              error={fieldErrors.endDate?.[0] ?? fieldErrors.startDate?.[0]}
            />
            <fieldset className="event-setup-create-choices pc-plain-fieldset">
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
            <fieldset className="event-setup-create-choices pc-plain-fieldset stack">
              <legend className="label">Email sender</legend>
              <label className="label">
                Reuse verified sender
                <select className="field" name="reusedSenderProfileId">
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
                  ? `Sender reuse is unavailable: ${loaderData.emailProviderIssue}`
                  : loaderData.reusableSenderProfiles.length > 0
                    ? "Copies the selected verified sender into the cloned event. Choose None to configure it later in Communications."
                    : "No verified sender is available in an active event in this organisation."}
              </p>
            </fieldset>
            {repositoryProvider === "airtable" ? (
              <div className="event-setup-create-choices stack">
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
                const senderField = form.elements.namedItem(
                  "reusedSenderProfileId",
                );
                const selectedSenderId =
                  senderField instanceof HTMLSelectElement
                    ? senderField.value
                    : "";
                const selectedSender =
                  loaderData.reusableSenderProfiles.find(
                    (profile) => profile.id === selectedSenderId,
                  ) ?? null;
                const senderCopy = selectedSender
                  ? ` The verified sender ${selectedSender.fromName} <${selectedSender.fromEmail}> is copied into the new event. Provider credentials are not copied.`
                  : "";
                confirm(
                  {
                    title: "Create this clean clone?",
                    description: `A new event is created from ${loaderData.source.name}, with ${repositoryProvider === "airtable" ? "Airtable" : "Program Cue"} holding its event data.${senderCopy} Published branding settings, rooms, tracks, policies and reusable templates are copied; brand images, people, submissions, schedules, credentials and published programmes are not. Events with brand images are blocked until those images are removed.`,
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
        <aside className="event-setup-create-aside">
          <h2>Copy boundary</h2>
          <h3>Copied as editable templates</h3>
          <p>
            Published branding text, colour and access defaults, schedule
            conflict policy, rooms, tracks, form versions, evaluation rounds and
            criteria, task templates and dependencies, email templates and
            disabled triggers.
          </p>
          <h3>Intentionally excluded</h3>
          <p>
            Brand images, people and memberships other than the creator,
            submissions, reviews and decisions, sessions and schedules, task
            instances, files, messages, calendar invitations, API keys, provider
            credentials, webhooks and publication state. Cloning is blocked
            while brand images or unpublished branding changes exist.
          </p>
          <div className="pc-status-notice mt">
            <ShieldCheck aria-hidden size={18} />
            <div className="pc-status-notice-copy">
              <strong>Historical dates stay behind</strong>
              <div>
                Fixed deadlines, form close dates and evaluation round windows
                are cleared so they cannot silently carry into the new event.
              </div>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
