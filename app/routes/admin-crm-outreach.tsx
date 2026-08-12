import { ArrowLeft, Mail, UsersRound } from "lucide-react";
import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useNavigation,
} from "react-router";
import { ZodError } from "zod";

import type { Route } from "./+types/admin-crm-outreach";
import {
  CommunicationNotFoundError,
  CommunicationStateError,
} from "~/modules/communications/communication-service-shared";
import { UnknownMergeVariableError } from "~/modules/communications/merge-template";
import { ensureDemoCrmData } from "~/modules/crm/demo.server";
import { CrmService, CrmStateError } from "~/modules/crm/crm-service.server";
import { currentEventCookie } from "~/platform/auth/current-event.server";
import { requireOrganisationAdministrator } from "~/platform/auth/organisation.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

export const meta = () => [{ title: "CRM bulk outreach · Program Cue" }];
type ActionResult = { ok: boolean; message: string };

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  await ensureDemoCrmData(env);
  const viewer = await requireOrganisationAdministrator(request, env);
  const service = new CrmService(env);
  const search = new URL(request.url).searchParams;
  const requested = [...new Set(search.getAll("person").filter(Boolean))].slice(
    0,
    500,
  );
  const [directory, selected, events] = await Promise.all([
    service.listDirectory(
      viewer,
      { query: "", company: "", jobTitle: "", tag: "" },
      1,
    ),
    service.listContactsById(viewer, requested),
    service.listEvents(viewer),
  ]);
  const selectedIds = new Set(selected.map((contact) => contact.personId));
  const contacts = [
    ...selected,
    ...directory.contacts.filter(
      (contact) => !selectedIds.has(contact.personId),
    ),
  ];
  return {
    contacts,
    selected,
    events,
    currentEventId: viewer.currentEventId,
    idempotencyKey: crypto.randomUUID(),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  await ensureDemoCrmData(env);
  const viewer = await requireOrganisationAdministrator(request, env);
  const form = await request.formData();
  try {
    const result = await new CrmService(env).createOutreachDraft(viewer, {
      personIds: form.getAll("personId"),
      idempotencyKey: form.get("idempotencyKey"),
      eventId: form.get("eventId"),
      subject: form.get("subject"),
      body: form.get("body"),
      physicalAddress: form.get("physicalAddress"),
    });
    return redirect(`/admin/communications/compose/${result.draftId}`, {
      headers: { "set-cookie": currentEventCookie(result.eventId, env) },
    });
  } catch (error) {
    if (
      error instanceof ZodError ||
      error instanceof CrmStateError ||
      error instanceof CommunicationNotFoundError ||
      error instanceof CommunicationStateError ||
      error instanceof UnknownMergeVariableError
    )
      return data<ActionResult>(
        {
          ok: false,
          message:
            error instanceof ZodError
              ? (error.issues[0]?.message ?? "Review the outreach fields.")
              : error.message,
        },
        {
          status:
            error instanceof CommunicationNotFoundError
              ? 404
              : error instanceof CommunicationStateError
                ? 409
                : error instanceof CrmStateError
                  ? error.status
                  : 422,
        },
      );
    if (error instanceof Response) throw error;
    throw error;
  }
}

export default function AdminCrmOutreach({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<ActionResult>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  return (
    <>
      <div className="page-head pc-page-header">
        <div>
          <span className="pc-page-eyebrow">Organization Speaker CRM</span>
          <h1>Bulk speaker outreach</h1>
          <p>
            Select at least two contacts, write an ad-hoc message, then use the
            existing authoritative preview and confirmation workflow.
          </p>
        </div>
        <Link className="btn" to="/admin/crm">
          <ArrowLeft aria-hidden size={15} /> CRM directory
        </Link>
      </div>
      {actionData ? (
        <div className="validation-item error card pad mb" role="alert">
          <strong>△</strong>
          <span>{actionData.message}</span>
        </div>
      ) : null}
      <Form method="post" className="stack">
        <input
          type="hidden"
          name="idempotencyKey"
          value={loaderData.idempotencyKey}
        />
        <section className="card pad">
          <div className="card-title">
            <div>
              <span className="pc-section-kicker">Recipients</span>
              <h2>Selected contacts</h2>
            </div>
            <UsersRound aria-hidden className="subtle" />
          </div>
          <div className="stack mt">
            {loaderData.contacts.map((contact) => {
              const checked = loaderData.selected.some(
                (selected) => selected.personId === contact.personId,
              );
              return (
                <label className="validation-item" key={contact.personId}>
                  <input
                    type="checkbox"
                    name="personId"
                    value={contact.personId}
                    defaultChecked={checked}
                  />
                  <span>
                    <strong>{contact.name}</strong>
                    <small className="subtle" style={{ display: "block" }}>
                      {contact.email} ·{" "}
                      {contact.organisationName ?? "Company not recorded"}
                    </small>
                  </span>
                </label>
              );
            })}
          </div>
        </section>
        <section className="card pad">
          <div className="card-title">
            <div>
              <span className="pc-section-kicker">Ad-hoc campaign</span>
              <h2>Compose email</h2>
            </div>
            <Mail aria-hidden className="subtle" />
          </div>
          <label className="label mt">
            Related event
            <select
              className="select"
              name="eventId"
              defaultValue={loaderData.currentEventId}
            >
              {loaderData.events.map((event) => (
                <option value={event.id} key={event.id}>
                  {event.name}
                </option>
              ))}
            </select>
          </label>
          <label className="label">
            Subject
            <input
              className="field"
              name="subject"
              required
              placeholder="Speak at DevFlow Conf 2027?"
            />
          </label>
          <label className="label">
            Message body
            <textarea
              className="textarea"
              name="body"
              required
              rows={8}
              defaultValue={
                "Hello {{recipient.firstName}},\n\nWe would love to invite you to speak at {{event.name}}. Please reply if you are interested."
              }
            />
          </label>
          <label className="label">
            Email footer physical address
            <input
              className="field"
              name="physicalAddress"
              required
              placeholder="100 Programme Way, Toronto"
            />
          </label>
          <p className="help">
            Supported personalization includes {"{{recipient.firstName}}"},{" "}
            {"{{recipient.name}}"}, {"{{event.name}}"} and {"{{event.dates}}"}.
            The next screen resolves the exact per-recipient preview before
            anything is queued.
          </p>
          <button className="btn primary" disabled={busy}>
            {busy
              ? "Creating durable draft…"
              : "Create draft and preview recipients"}
          </button>
        </section>
      </Form>
    </>
  );
}
