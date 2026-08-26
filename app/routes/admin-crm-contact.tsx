import {
  ArrowLeft,
  History,
  Merge,
  MessageSquarePlus,
  Network,
} from "lucide-react";
import type { FormEvent } from "react";
import {
  data,
  Form,
  redirect,
  useActionData,
  useNavigation,
  useSubmit,
} from "react-router";
import { ZodError } from "zod";
import { Button, ButtonLink } from "~/components/ui/button";
import { useConfirm } from "~/components/ui/confirm-dialog";
import {
  DomainStatusBadge,
  statusPresentation,
} from "~/components/ui/domain-status-badge";
import { EmptyState } from "~/components/ui/states";
import { adminRecordBreadcrumbHandle } from "~/modules/administration/admin-route-breadcrumb";
import { crmStages } from "~/modules/crm/crm-schema";
import { CrmService, CrmStateError } from "~/modules/crm/crm-service.server";
import { ensureDemoCrmData } from "~/modules/crm/demo.server";
import { requireOrganisationAdministrator } from "~/platform/auth/organisation.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/admin-crm-contact";

export const handle = adminRecordBreadcrumbHandle(["contact", "name"]);

export const meta = ({ loaderData }: Route.MetaArgs) => [
  {
    title: `${loaderData?.contact.name ?? "Speaker contact"} · Speaker network · Program Cue`,
  },
];

type ActionResult = {
  ok: boolean;
  message: string;
  handoff?: { eventId: string; personId: string };
};

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  await ensureDemoCrmData(env);
  const viewer = await requireOrganisationAdministrator(request, env);
  const service = new CrmService(env);
  const [contact, events] = await Promise.all([
    service.getContact(viewer, params.personId),
    service.listEvents(viewer),
  ]);
  return { contact, events, addToEventIdempotencyKey: crypto.randomUUID() };
}

export async function action({ request, context, params }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  await ensureDemoCrmData(env);
  const viewer = await requireOrganisationAdministrator(request, env);
  const service = new CrmService(env);
  const form = await request.formData();
  const intent = String(form.get("_intent") ?? "");
  try {
    if (intent === "add_note") {
      await service.addNote(viewer, params.personId, form.get("body"));
      return redirect(
        `/admin/crm/contacts/${encodeURIComponent(params.personId ?? "")}?saved=note`,
      );
    }
    if (intent === "add_tag") {
      await service.addTag(viewer, params.personId, form.get("tag"));
      return redirect(
        `/admin/crm/contacts/${encodeURIComponent(params.personId ?? "")}?saved=tag`,
      );
    }
    if (intent === "remove_tag") {
      await service.removeTag(viewer, params.personId, form.get("tag"));
      return redirect(
        `/admin/crm/contacts/${encodeURIComponent(params.personId ?? "")}`,
      );
    }
    if (intent === "merge") {
      await service.mergeContacts(
        viewer,
        form.get("primaryId"),
        form.get("secondaryId"),
      );
      return redirect(
        `/admin/crm/contacts/${encodeURIComponent(String(form.get("primaryId") ?? ""))}?merged=yes`,
      );
    }
    if (intent === "enroll") {
      await service.enrollPipeline(viewer, {
        personId: params.personId,
        stage: form.get("stage"),
        score: form.get("score") ? form.get("score") : null,
        rationale: form.get("rationale"),
      });
      return redirect(
        `/admin/crm/contacts/${encodeURIComponent(params.personId ?? "")}?enrolled=yes`,
      );
    }
    if (intent === "pipeline_note") {
      await service.addPipelineNote(viewer, {
        entryId: form.get("entryId"),
        body: form.get("body"),
      });
      return redirect(
        `/admin/crm/contacts/${encodeURIComponent(params.personId ?? "")}?saved=pipeline-note`,
      );
    }
    if (intent === "add_to_event") {
      const added = await service.addContactToEvent(
        viewer,
        params.personId,
        form.get("eventId"),
        form.get("idempotencyKey"),
      );
      return {
        ok: true,
        message: added.created
          ? "Added this contact to the target event as a prospect. The current event was not changed."
          : "This contact is already in the target event. No duplicate was created and the current event was not changed.",
        handoff: { eventId: added.eventId, personId: added.personId },
      } satisfies ActionResult;
    }
    return data<ActionResult>(
      { ok: false, message: "Unsupported Speaker Network contact action." },
      { status: 400 },
    );
  } catch (error) {
    if (error instanceof ZodError || error instanceof CrmStateError) {
      return data<ActionResult>(
        {
          ok: false,
          message:
            error instanceof ZodError
              ? (error.issues[0]?.message ?? "Review the contact action.")
              : error.message,
        },
        {
          status: error instanceof CrmStateError ? error.status : 422,
        },
      );
    }
    if (error instanceof Response) throw error;
    throw error;
  }
}

function formatTimestamp(value: number) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value * 1_000));
}

export default function AdminCrmContact({ loaderData }: Route.ComponentProps) {
  const { contact, events, addToEventIdempotencyKey } = loaderData;
  const actionData = useActionData<ActionResult>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const { confirm, dialog } = useConfirm();
  const busy = navigation.state !== "idle";
  const confirmMerge = (
    event: FormEvent<HTMLFormElement>,
    keptEmail: string,
    mergedEmail: string,
  ) => {
    event.preventDefault();
    const form = event.currentTarget;
    confirm(
      {
        title: "Merge these Speaker Network contacts?",
        description: `${keptEmail} stays in the organization directory. Notes, tags and pipeline history move across, and the secondary contact stops appearing.`,
        records: [mergedEmail],
        confirmLabel: `Keep ${keptEmail}`,
      },
      () => submit(form),
    );
  };
  return (
    <>
      {dialog}
      <div className="crm-workspace">
        <div className="page-head pc-page-header">
          <div>
            <h1>{contact.name}</h1>
            <p className="crm-caption">
              {[contact.jobTitle, contact.organisationName]
                .filter(Boolean)
                .join(" · ") || "No title or company recorded"}{" "}
              · {contact.email}
            </p>
          </div>
          <div className="page-actions">
            <ButtonLink to="/admin/crm">
              <ArrowLeft aria-hidden size={15} /> Speaker Network directory
            </ButtonLink>
            <ButtonLink to="/admin/crm/pipeline">
              <Network aria-hidden size={15} /> Pipeline
            </ButtonLink>
          </div>
        </div>
        <div className="crm-pulse">
          {`${contact.connections.length} ${contact.connections.length === 1 ? "event" : "events"}`}
          {contact.tags.length ? ` · ${contact.tags.join(" · ")}` : ""}
          {contact.pipeline
            ? ` · ${statusPresentation("crm", contact.pipeline.stage).label}`
            : ""}
        </div>
        {actionData ? (
          <div
            className={`validation-item ${actionData.ok ? "ok" : "error"} card pad mb`}
            role={actionData.ok ? "status" : "alert"}
          >
            <strong>{actionData.ok ? "✓" : "△"}</strong>
            <div className="stack">
              <span>{actionData.message}</span>
              {actionData.ok && actionData.handoff ? (
                <Form method="post" action="/events/select">
                  <input
                    type="hidden"
                    name="eventId"
                    value={actionData.handoff.eventId}
                  />
                  <input
                    type="hidden"
                    name="returnTo"
                    value={`/admin/speakers?person=${encodeURIComponent(actionData.handoff.personId)}`}
                  />
                  <Button size="small" type="submit">
                    Switch to target event and open prospect
                  </Button>
                </Form>
              ) : null}
            </div>
          </div>
        ) : null}

        {contact.duplicates.length ? (
          <section className="card pad mb" aria-labelledby="duplicate-heading">
            <div className="card-title">
              <div>
                <span className="pc-section-kicker">Identity safety</span>
                <h2 id="duplicate-heading">Possible duplicate contacts</h2>
              </div>
              <Merge aria-hidden className="subtle" />
            </div>
            <p>
              These contacts have the same normalized name. Choose which record
              remains visible as the primary Speaker Network contact. Linked
              identities are refused rather than merged unsafely.
            </p>
            <div className="stack mt">
              {contact.duplicates.map((duplicate) => (
                <div className="card pad" key={duplicate.personId}>
                  <strong>{contact.name}</strong>
                  <p>
                    {contact.email} ↔ {duplicate.email}
                  </p>
                  <div className="row-actions">
                    <Form
                      method="post"
                      onSubmit={(event) =>
                        confirmMerge(event, contact.email, duplicate.email)
                      }
                    >
                      <input type="hidden" name="_intent" value="merge" />
                      <input
                        type="hidden"
                        name="primaryId"
                        value={contact.personId}
                      />
                      <input
                        type="hidden"
                        name="secondaryId"
                        value={duplicate.personId}
                      />
                      <Button type="submit" variant="danger" disabled={busy}>
                        Keep {contact.email} as primary
                      </Button>
                    </Form>
                    <Form
                      method="post"
                      onSubmit={(event) =>
                        confirmMerge(event, duplicate.email, contact.email)
                      }
                    >
                      <input type="hidden" name="_intent" value="merge" />
                      <input
                        type="hidden"
                        name="primaryId"
                        value={duplicate.personId}
                      />
                      <input
                        type="hidden"
                        name="secondaryId"
                        value={contact.personId}
                      />
                      <Button type="submit" variant="danger" disabled={busy}>
                        Keep {duplicate.email} as primary
                      </Button>
                    </Form>
                  </div>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <div className="crm-record-grid">
          <section className="crm-record-section">
            <h2>Profile</h2>
            <dl className="crm-detail-list mt">
              <div>
                <dt>Email</dt>
                <dd>{contact.email}</dd>
              </div>
              <div>
                <dt>Job title</dt>
                <dd>{contact.jobTitle ?? "Not recorded"}</dd>
              </div>
              <div>
                <dt>Company</dt>
                <dd>{contact.organisationName ?? "Not recorded"}</dd>
              </div>
              <div>
                <dt>Profile status</dt>
                <dd>{contact.profileStatus}</dd>
              </div>
            </dl>
            <h3 className="mt">Biography</h3>
            <p>{contact.biography ?? "No biography recorded."}</p>
          </section>
          <section className="crm-record-section">
            <h2>Tags</h2>
            <div className="crm-chip-row mt">
              {contact.tags.map((tag) => (
                <Form method="post" key={tag}>
                  <input type="hidden" name="_intent" value="remove_tag" />
                  <input type="hidden" name="tag" value={tag} />
                  <button
                    type="submit"
                    className="crm-chip"
                    aria-label={`Remove ${tag} tag`}
                  >
                    {tag} ×
                  </button>
                </Form>
              ))}
              {!contact.tags.length ? (
                <span className="subtle">No tags yet</span>
              ) : null}
            </div>
            <Form method="post" className="form-row mt">
              <input type="hidden" name="_intent" value="add_tag" />
              <label className="label">
                Add tag
                <input className="field" name="tag" placeholder="AI" required />
              </label>
              <Button type="submit" disabled={busy}>
                Add tag
              </Button>
            </Form>
          </section>
        </div>

        <section className="crm-record-section" aria-labelledby="notes-heading">
          <h2 id="notes-heading">Internal notes</h2>
          <Form method="post" className="stack mt">
            <input type="hidden" name="_intent" value="add_note" />
            <label className="label">
              New internal note
              <textarea
                className="textarea"
                name="body"
                required
                placeholder="Met at DevFlow 2026…"
              />
            </label>
            <Button type="submit" variant="primary" disabled={busy}>
              Save note
            </Button>
          </Form>
          <div className="stack mt">
            {contact.notes.map((note) => (
              <article className="card pad" key={note.id}>
                <p>{note.body}</p>
                <small className="subtle">
                  {note.authorName} · {formatTimestamp(note.createdAt)}
                </small>
              </article>
            ))}
            {!contact.notes.length ? (
              <EmptyState
                icon={MessageSquarePlus}
                title="No internal notes"
                description="Notes stay private to organisers and are never shown to the contact."
              />
            ) : null}
          </div>
        </section>

        <section
          className="crm-record-section"
          aria-labelledby="history-heading"
        >
          <h2 id="history-heading">Events and sessions</h2>
          {contact.connections.length ? (
            <section
              className="table-wrap mt"
              aria-label="Contact event and session history"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data regions need keyboard focus so arrow keys can expose overflow content.
              tabIndex={0}
            >
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Event</th>
                    <th scope="col">Sessions</th>
                    <th scope="col">Example session</th>
                  </tr>
                </thead>
                <tbody>
                  {contact.connections.map((connection) => (
                    <tr key={connection.eventId}>
                      <td>{connection.eventName}</td>
                      <td>{connection.sessionCount}</td>
                      <td>
                        {connection.firstSessionTitle ?? "Speaker access only"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ) : (
            <EmptyState
              icon={History}
              title="No event history yet"
              description="Sessions appear here once this contact is added to an event below."
            />
          )}
        </section>

        <div className="crm-record-grid">
          <section
            className="crm-record-section"
            aria-labelledby="event-handoff-heading"
          >
            <h2 id="event-handoff-heading">Add to event</h2>
            <p className="subtle">
              Adds this contact to the event roster as a prospect without
              creating account access or sending email. Their
              organisation-scoped Network profile remains visible in the
              Speakers workspace, where invitations are sent explicitly.
            </p>
            <Form method="post" className="stack mt">
              <input type="hidden" name="_intent" value="add_to_event" />
              <input
                type="hidden"
                name="idempotencyKey"
                value={addToEventIdempotencyKey}
              />
              <label className="label">
                Target event
                <select className="select" name="eventId" required>
                  {events.map((event) => (
                    <option value={event.id} key={event.id}>
                      {event.name}
                    </option>
                  ))}
                </select>
              </label>
              <Button type="submit" variant="primary" disabled={busy}>
                Add prospect to event
              </Button>
            </Form>
          </section>
          <section
            className="crm-record-section"
            aria-labelledby="pipeline-contact-heading"
          >
            <h2 id="pipeline-contact-heading">Pipeline</h2>
            {contact.pipeline ? (
              <div className="stack mt">
                <p>
                  <DomainStatusBadge
                    domain="crm"
                    status={contact.pipeline.stage}
                  />
                  {contact.pipeline.score !== null
                    ? ` · fit score ${contact.pipeline.score}`
                    : ""}
                </p>
                {contact.pipeline.rationale ? (
                  <p>{contact.pipeline.rationale}</p>
                ) : null}
                <Form method="post" className="stack">
                  <input type="hidden" name="_intent" value="pipeline_note" />
                  <input
                    type="hidden"
                    name="entryId"
                    value={contact.pipeline.id}
                  />
                  <label className="label">
                    Pipeline note
                    <textarea className="textarea" name="body" required />
                  </label>
                  <Button type="submit" disabled={busy}>
                    Save pipeline note
                  </Button>
                </Form>
                <div className="stack">
                  {contact.pipeline.activity.map((activity) => (
                    <div className="validation-item" key={activity.id}>
                      <strong>
                        {activity.kind === "note" ? "Note" : "Stage"}
                      </strong>
                      <span>
                        {activity.kind === "note"
                          ? activity.body
                          : `${activity.fromStage ?? "New"} → ${activity.toStage}`}
                        <small className="subtle" style={{ display: "block" }}>
                          {activity.actorName} ·{" "}
                          {formatTimestamp(activity.createdAt)}
                        </small>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <Form method="post" className="stack mt">
                <input type="hidden" name="_intent" value="enroll" />
                <label className="label">
                  Starting stage
                  <select className="select" name="stage">
                    {crmStages.map((stage) => (
                      <option value={stage} key={stage}>
                        {statusPresentation("crm", stage).label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="label">
                  Speaker fit score (optional)
                  <input
                    className="field"
                    type="number"
                    name="score"
                    min={0}
                    max={100}
                  />
                </label>
                <label className="label">
                  Fit rationale
                  <textarea className="textarea" name="rationale" />
                </label>
                <Button type="submit" variant="primary" disabled={busy}>
                  Enroll contact
                </Button>
              </Form>
            )}
          </section>
        </div>
      </div>
    </>
  );
}
