import { ArrowLeft, Network, UserPlus } from "lucide-react";
import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useNavigation,
} from "react-router";
import { ZodError } from "zod";
import { Button, ButtonLink } from "~/components/ui/button";
import { statusPresentation } from "~/components/ui/domain-status-badge";
import { crmStages } from "~/modules/crm/crm-schema";
import { CrmService, CrmStateError } from "~/modules/crm/crm-service.server";
import { ensureDemoCrmData } from "~/modules/crm/demo.server";
import { requireOrganisationAdministrator } from "~/platform/auth/organisation.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/admin-crm-pipeline";

export const meta = () => [
  { title: "Speaker sourcing pipeline · Program Cue" },
];
type ActionResult = { ok: boolean; message: string };

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  await ensureDemoCrmData(env);
  const viewer = await requireOrganisationAdministrator(request, env);
  const service = new CrmService(env);
  const [columns, directory] = await Promise.all([
    service.listPipeline(viewer),
    service.listDirectory(
      viewer,
      { query: "", company: "", jobTitle: "", tag: "" },
      1,
    ),
  ]);
  const enrolled = new Set(
    columns.flatMap((column) => column.entries.map((entry) => entry.personId)),
  );
  return {
    columns,
    availableContacts: directory.contacts.filter(
      (contact) => !enrolled.has(contact.personId),
    ),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  await ensureDemoCrmData(env);
  const viewer = await requireOrganisationAdministrator(request, env);
  const service = new CrmService(env);
  const form = await request.formData();
  try {
    if (form.get("_intent") === "enroll") {
      await service.enrollPipeline(viewer, {
        personId: form.get("personId"),
        stage: form.get("stage"),
        score: form.get("score") ? form.get("score") : null,
        rationale: form.get("rationale"),
      });
      return redirect("/admin/crm/pipeline?enrolled=yes");
    }
    if (form.get("_intent") === "move") {
      await service.movePipelineEntry(viewer, {
        entryId: form.get("entryId"),
        stage: form.get("stage"),
        revision: form.get("revision"),
      });
      return redirect("/admin/crm/pipeline?moved=yes");
    }
    return data<ActionResult>(
      { ok: false, message: "Unsupported pipeline action." },
      { status: 400 },
    );
  } catch (error) {
    if (error instanceof ZodError || error instanceof CrmStateError)
      return data<ActionResult>(
        {
          ok: false,
          message:
            error instanceof CrmStateError
              ? error.message
              : (error.issues[0]?.message ?? "Review the pipeline action."),
        },
        { status: error instanceof CrmStateError ? error.status : 422 },
      );
    if (error instanceof Response) throw error;
    throw error;
  }
}

export default function AdminCrmPipeline({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<ActionResult>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  return (
    <div className="crm-workspace">
      <div className="page-head pc-page-header">
        <div>
          <h1>Speaker sourcing pipeline</h1>
          <p className="crm-caption">
            Move reusable contacts from identification through confirmed or
            declined outcomes. Every transition is timestamped.
          </p>
        </div>
        <ButtonLink to="/admin/crm">
          <ArrowLeft aria-hidden size={15} /> Speaker Network directory
        </ButtonLink>
      </div>
      {actionData ? (
        <div className="validation-item error crm-notice" role="alert">
          <strong>△</strong>
          <span>{actionData.message}</span>
        </div>
      ) : null}
      <details className="crm-disclosure">
        <summary>
          <span>
            <UserPlus aria-hidden size={16} /> Enroll a contact
          </span>
        </summary>
        {loaderData.availableContacts.length ? (
          <Form method="post" className="stack mt">
            <input type="hidden" name="_intent" value="enroll" />
            <label className="label">
              Contact
              <select className="select" name="personId">
                {loaderData.availableContacts.map((contact) => (
                  <option value={contact.personId} key={contact.personId}>
                    {contact.name} · {contact.email}
                  </option>
                ))}
              </select>
            </label>
            <label className="label">
              Starting stage
              <select className="select" name="stage">
                {crmStages.map((stage) => (
                  <option key={stage}>{stage}</option>
                ))}
              </select>
            </label>
            <div className="form-row">
              <label className="label">
                Speaker fit score (optional)
                <input
                  className="field"
                  name="score"
                  type="number"
                  min={0}
                  max={100}
                />
              </label>
              <label className="label">
                Fit rationale
                <input className="field" name="rationale" />
              </label>
            </div>
            <Button type="submit" variant="primary" disabled={busy}>
              Enroll contact
            </Button>
          </Form>
        ) : (
          <p className="subtle mt">
            Every organization contact is already enrolled.
          </p>
        )}
      </details>
      <section
        className="crm-pipeline-board"
        aria-label="Speaker sourcing stages"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data regions need keyboard focus so arrow keys can expose overflow content.
        tabIndex={0}
      >
        {loaderData.columns.map((column) => (
          <div className="crm-pipeline-column" key={column.stage}>
            <div className="card-title">
              <h2>{statusPresentation("crm", column.stage).label}</h2>
              <span className="subtle">{column.entries.length}</span>
            </div>
            <div className="stack mt">
              {column.entries.map((entry) => (
                <article className="crm-pipeline-entry" key={entry.id}>
                  <Link
                    to={`/admin/crm/contacts/${encodeURIComponent(entry.personId)}`}
                  >
                    <strong>{entry.name}</strong>
                  </Link>
                  <p className="subtle">
                    {[entry.jobTitle, entry.organisationName]
                      .filter(Boolean)
                      .join(" · ") || entry.email}
                  </p>
                  {entry.score !== null ? (
                    <span className="status info">Fit score {entry.score}</span>
                  ) : null}
                  {entry.rationale ? <p>{entry.rationale}</p> : null}
                  <Form method="post" className="stack mt">
                    <input type="hidden" name="_intent" value="move" />
                    <input type="hidden" name="entryId" value={entry.id} />
                    <input
                      type="hidden"
                      name="revision"
                      value={entry.revision}
                    />
                    <label className="label">
                      Move to
                      <select
                        className="select"
                        name="stage"
                        defaultValue={entry.stage}
                      >
                        {crmStages.map((stage) => (
                          <option key={stage} value={stage}>
                            {statusPresentation("crm", stage).label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <button
                      type="submit"
                      className="crm-text-action"
                      disabled={busy}
                    >
                      Move card
                    </button>
                  </Form>
                </article>
              ))}
              {!column.entries.length ? (
                <div className="pc-empty-state">
                  <Network aria-hidden className="pc-state-icon" />
                  <p>No contacts</p>
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}
