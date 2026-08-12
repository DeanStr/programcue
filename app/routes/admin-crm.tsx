import {
  BarChart3,
  FilterX,
  ListFilter,
  Mail,
  Network,
  Search,
  Upload,
  UserPlus,
  UsersRound,
} from "lucide-react";
import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useNavigation,
} from "react-router";
import { ZodError } from "zod";

import type { Route } from "./+types/admin-crm";
import { EmptyState } from "~/components/ui/states";
import { ensureDemoCrmData } from "~/modules/crm/demo.server";
import {
  CrmService,
  CrmStateError,
  type CrmFilters,
} from "~/modules/crm/crm-service.server";
import { requireOrganisationAdministrator } from "~/platform/auth/organisation.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

export const meta = () => [{ title: "Speaker Network · Program Cue" }];

type ActionResult = {
  ok: boolean;
  message: string;
  importPreview?: Awaited<ReturnType<CrmService["previewImport"]>>;
};

function filtersFrom(search: URLSearchParams): CrmFilters {
  return {
    query: search.get("query") ?? "",
    company: search.get("company") ?? "",
    jobTitle: search.get("jobTitle") ?? "",
    tag: search.get("tag") ?? "",
  };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  await ensureDemoCrmData(env);
  const viewer = await requireOrganisationAdministrator(request, env);
  const service = new CrmService(env);
  const search = new URL(request.url).searchParams;
  const segmentId = search.get("segment");
  const segment = segmentId
    ? await service.getSegment(viewer, segmentId)
    : null;
  const filters = segment?.filters ?? filtersFrom(search);
  const page = Number(search.get("page") ?? "1");
  const [directory, dashboard] = await Promise.all([
    service.listDirectory(viewer, filters, page),
    service.dashboard(viewer),
  ]);
  return {
    directory,
    dashboard,
    segment,
    organisationId: viewer.organisationId,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  await ensureDemoCrmData(env);
  const viewer = await requireOrganisationAdministrator(request, env);
  const service = new CrmService(env);
  const form = await request.formData();
  const intent = String(form.get("_intent") ?? "");
  try {
    if (intent === "create_contact") {
      const created = await service.createContact(viewer, {
        name: form.get("name"),
        email: form.get("email"),
        jobTitle: form.get("jobTitle"),
        organisationName: form.get("organisationName"),
        biography: form.get("biography"),
      });
      return redirect(
        `/admin/crm/contacts/${encodeURIComponent(created.personId)}`,
      );
    }
    if (intent === "preview_import") {
      const file = form.get("file");
      if (!(file instanceof File) || file.size === 0) {
        return data<ActionResult>(
          { ok: false, message: "Choose a CSV file to preview." },
          { status: 422 },
        );
      }
      if (file.size > 512_000) {
        return data<ActionResult>(
          {
            ok: false,
            message: "Speaker Network CSV files cannot exceed 512 KB.",
          },
          { status: 422 },
        );
      }
      const importPreview = await service.previewImport(
        viewer,
        await file.text(),
      );
      return data<ActionResult>({
        ok: importPreview.invalid.length === 0,
        message: `${importPreview.valid.length} valid contact${importPreview.valid.length === 1 ? "" : "s"}; ${importPreview.invalid.length} invalid row${importPreview.invalid.length === 1 ? "" : "s"}. Nothing has been imported yet.`,
        importPreview,
      });
    }
    if (intent === "confirm_import") {
      const result = await service.confirmImport(
        viewer,
        String(form.get("csv") ?? ""),
      );
      return redirect(`/admin/crm?imported=${result.imported}`);
    }
    if (intent === "save_segment") {
      await service.saveSegment(viewer, form.get("name"), {
        query: form.get("query"),
        company: form.get("company"),
        jobTitle: form.get("jobTitle"),
        tag: form.get("tag"),
      });
      return redirect("/admin/crm?segmentSaved=yes");
    }
    return data<ActionResult>(
      { ok: false, message: "Unsupported Speaker Network action." },
      { status: 400 },
    );
  } catch (error) {
    if (error instanceof ZodError || error instanceof CrmStateError) {
      return data<ActionResult>(
        {
          ok: false,
          message:
            error instanceof CrmStateError
              ? error.message
              : (error.issues[0]?.message ??
                "Review the Speaker Network fields."),
        },
        { status: error instanceof CrmStateError ? error.status : 422 },
      );
    }
    if (error instanceof Response) throw error;
    throw error;
  }
}

function filtersQuery(
  filters: CrmFilters,
  overrides: Partial<CrmFilters> = {},
) {
  const next = { ...filters, ...overrides };
  const search = new URLSearchParams();
  Object.entries(next).forEach(([key, value]) => {
    if (value) search.set(key, value);
  });
  return search.toString();
}

function directoryPageQuery(
  filters: CrmFilters,
  page: number,
  segmentId?: string,
) {
  const search = new URLSearchParams(filtersQuery(filters));
  if (segmentId) search.set("segment", segmentId);
  if (page > 1) search.set("page", String(page));
  return search.toString();
}

export default function AdminCrm({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<ActionResult>();
  const navigation = useNavigation();
  const { directory, dashboard, segment } = loaderData;
  const filtersActive = Object.values(directory.filters).some(Boolean);
  const busy = navigation.state !== "idle";
  return (
    <>
      <div className="page-head pc-page-header">
        <div>
          <span className="pc-page-eyebrow">
            Organization workspace · all events
          </span>
          <h1>Speaker Network</h1>
          <p>
            A cross-event speaker CRM for reusable profiles, private
            relationship context and sourcing prospects into events without
            re-entering data.
          </p>
        </div>
        <div className="page-actions">
          <Link className="btn" to="/admin/crm/pipeline">
            <Network aria-hidden size={16} /> Sourcing pipeline
          </Link>
          <Link className="btn primary" to="/admin/crm/outreach">
            <Mail aria-hidden size={16} /> Speaker invitations
          </Link>
        </div>
      </div>

      <div className="grid grid-4 mb" aria-label="Speaker Network overview">
        <section className="card metric">
          <div className="label">Total contacts</div>
          <div className="value">{dashboard.totalContacts}</div>
        </section>
        <section className="card metric">
          <div className="label">Organization events</div>
          <div className="value">{dashboard.eventCount}</div>
        </section>
        <section className="card metric">
          <div className="label">Returning speakers</div>
          <div className="value">{dashboard.returningSpeakers}</div>
        </section>
        <section className="card metric">
          <div className="label">Top companies tracked</div>
          <div className="value">{dashboard.companies.length}</div>
        </section>
      </div>

      <section className="card pad mb" aria-labelledby="crm-companies-heading">
        <div className="card-title">
          <div>
            <span className="pc-section-kicker">Organization analytics</span>
            <h2 id="crm-companies-heading">Top companies</h2>
          </div>
          <BarChart3 aria-hidden className="subtle" />
        </div>
        {dashboard.companies.length ? (
          <div className="crm-chip-row mt">
            {dashboard.companies.map((company) => (
              <Link
                className="crm-chip"
                key={company.name}
                to={`/admin/crm?${new URLSearchParams({ company: company.name })}`}
              >
                {company.name} · {company.contacts}
              </Link>
            ))}
          </div>
        ) : (
          <EmptyState
            icon={BarChart3}
            title="No company analytics yet"
            description="Companies are counted once contacts record an employer on their profile."
          />
        )}
      </section>

      {actionData ? (
        <div
          className={`validation-item ${actionData.ok ? "ok" : "error"} card pad mb`}
          role={actionData.ok ? "status" : "alert"}
        >
          <strong>{actionData.ok ? "✓" : "△"}</strong>
          <span>{actionData.message}</span>
        </div>
      ) : null}

      <section className="card pad mb" aria-labelledby="crm-directory-heading">
        <div className="card-title">
          <div>
            <span className="pc-section-kicker">Cross-event directory</span>
            <h2 id="crm-directory-heading">
              {segment ? `${segment.name} segment` : "Organization contacts"}
            </h2>
          </div>
          <UsersRound aria-hidden className="subtle" />
        </div>
        <Form method="get" className="stack mt">
          <div className="form-row">
            <label className="label">
              Search contacts
              <span className="crm-field-with-icon">
                <Search aria-hidden size={15} />
                <input
                  className="field"
                  name="query"
                  defaultValue={directory.filters.query}
                  placeholder="Name, email, company, or title"
                />
              </span>
            </label>
            <label className="label">
              Company
              <select
                className="select"
                name="company"
                defaultValue={directory.filters.company}
              >
                <option value="">All companies</option>
                {directory.facets.companies.map((company) => (
                  <option key={company}>{company}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="form-row">
            <label className="label">
              Job title
              <select
                className="select"
                name="jobTitle"
                defaultValue={directory.filters.jobTitle}
              >
                <option value="">All job titles</option>
                {directory.facets.jobTitles.map((title) => (
                  <option key={title}>{title}</option>
                ))}
              </select>
            </label>
            <label className="label">
              Tag
              <select
                className="select"
                name="tag"
                defaultValue={directory.filters.tag}
              >
                <option value="">All tags</option>
                {directory.facets.tags.map((tag) => (
                  <option key={tag}>{tag}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="row-actions">
            <button className="btn primary" type="submit">
              <ListFilter aria-hidden size={15} /> Apply filters
            </button>
            <Link className="btn" to="/admin/crm">
              <FilterX aria-hidden size={15} /> Clear filters
            </Link>
          </div>
        </Form>
        {filtersActive ? (
          <div
            className="crm-chip-row mt"
            aria-label="Active directory filters"
          >
            {Object.entries(directory.filters)
              .filter(([, value]) => value)
              .map(([key, value]) => (
                <span className="crm-chip" key={key}>
                  {key.replace(/([A-Z])/g, " $1")}: {value}
                </span>
              ))}
          </div>
        ) : null}

        <Form method="get" action="/admin/crm/outreach" className="mt">
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">
                    <span className="sr-only">Select</span>
                  </th>
                  <th scope="col">Contact</th>
                  <th scope="col">Company and title</th>
                  <th scope="col">Tags</th>
                  <th scope="col">History</th>
                </tr>
              </thead>
              <tbody>
                {directory.contacts.map((contact) => (
                  <tr key={contact.personId}>
                    <td>
                      <input
                        type="checkbox"
                        name="person"
                        value={contact.personId}
                        aria-label={`Select ${contact.name}`}
                      />
                    </td>
                    <td data-label="Contact">
                      <Link
                        to={`/admin/crm/contacts/${encodeURIComponent(contact.personId)}`}
                      >
                        <strong>{contact.name}</strong>
                      </Link>
                      <small className="subtle" style={{ display: "block" }}>
                        {contact.email}
                      </small>
                      {contact.duplicateCount ? (
                        <span className="status warning">
                          Possible duplicate
                        </span>
                      ) : null}
                    </td>
                    <td data-label="Company and title">
                      {contact.jobTitle ?? "Title not recorded"}
                      <small className="subtle" style={{ display: "block" }}>
                        {contact.organisationName ?? "Company not recorded"}
                      </small>
                    </td>
                    <td data-label="Tags">
                      {contact.tags.length ? (
                        contact.tags.join(" · ")
                      ) : (
                        <span className="subtle">No tags</span>
                      )}
                    </td>
                    <td data-label="History">
                      {contact.eventCount} event
                      {contact.eventCount === 1 ? "" : "s"} ·{" "}
                      {contact.sessionCount} session
                      {contact.sessionCount === 1 ? "" : "s"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {directory.contacts.length ? (
            <button className="btn primary mt" type="submit">
              <Mail aria-hidden size={15} /> Email selected contacts
            </button>
          ) : (
            <EmptyState
              className="mt"
              icon={UsersRound}
              title="No matching contacts"
              description="Clear the filters or add a reusable speaker contact below."
              action={
                filtersActive ? (
                  <Link className="btn" to="/admin/crm">
                    <FilterX aria-hidden size={15} /> Clear filters
                  </Link>
                ) : undefined
              }
            />
          )}
        </Form>
        <p className="help mt" role="status">
          Showing {directory.contacts.length} organization contact
          {directory.contacts.length === 1 ? "" : "s"}.
        </p>
        {directory.page > 1 || directory.hasNext ? (
          <nav
            className="row-actions mt"
            aria-label="Speaker Network directory pages"
          >
            {directory.page > 1 ? (
              <Link
                className="btn"
                to={`/admin/crm?${directoryPageQuery(
                  directory.filters,
                  directory.page - 1,
                  segment?.id,
                )}`}
              >
                Previous page
              </Link>
            ) : null}
            {directory.hasNext ? (
              <Link
                className="btn"
                to={`/admin/crm?${directoryPageQuery(
                  directory.filters,
                  directory.page + 1,
                  segment?.id,
                )}`}
              >
                Next page
              </Link>
            ) : null}
          </nav>
        ) : null}
      </section>

      <div className="grid grid-2 mb">
        <details className="card pad pc-disclosure">
          <summary>
            <strong>
              <UserPlus aria-hidden size={16} /> Add speaker contact manually
            </strong>
          </summary>
          <Form method="post" className="stack mt">
            <input type="hidden" name="_intent" value="create_contact" />
            <div className="form-row">
              <label className="label">
                Name
                <input className="field" name="name" required />
              </label>
              <label className="label">
                Email
                <input className="field" type="email" name="email" required />
              </label>
            </div>
            <div className="form-row">
              <label className="label">
                Job title
                <input className="field" name="jobTitle" />
              </label>
              <label className="label">
                Company
                <input className="field" name="organisationName" />
              </label>
            </div>
            <label className="label">
              Biography
              <textarea className="textarea" name="biography" />
            </label>
            <button className="btn primary" disabled={busy}>
              Create speaker contact
            </button>
          </Form>
        </details>
        <details
          className="card pad pc-disclosure"
          open={Boolean(actionData?.importPreview)}
        >
          <summary>
            <strong>
              <Upload aria-hidden size={16} /> Import speaker contacts from CSV
            </strong>
          </summary>
          <Form
            method="post"
            encType="multipart/form-data"
            className="stack mt"
          >
            <input type="hidden" name="_intent" value="preview_import" />
            <label className="label">
              CSV file
              <input
                className="field"
                type="file"
                name="file"
                accept=".csv,text/csv"
                required
              />
            </label>
            <p className="help">
              Accepted columns: name, email, title, company and bio. Import is
              previewed before it writes.
            </p>
            <button className="btn" disabled={busy}>
              Preview import
            </button>
          </Form>
          {actionData?.importPreview ? (
            <div className="stack mt">
              <h3>Column mapping</h3>
              <div className="crm-chip-row">
                {Object.entries(actionData.importPreview.mapping).map(
                  ([field, column]) => (
                    <span className="crm-chip" key={field}>
                      {column ?? "not supplied"} → {field}
                    </span>
                  ),
                )}
              </div>
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th scope="col">Row</th>
                      <th scope="col">Name</th>
                      <th scope="col">Email</th>
                      <th scope="col">Company</th>
                      <th scope="col">Validation</th>
                    </tr>
                  </thead>
                  <tbody>
                    {actionData.importPreview.valid.map((row) => (
                      <tr key={row.rowNumber}>
                        <td>{row.rowNumber}</td>
                        <td>{row.name}</td>
                        <td>{row.email}</td>
                        <td>{row.organisationName || "—"}</td>
                        <td>
                          <span className="status success">Valid</span>
                        </td>
                      </tr>
                    ))}
                    {actionData.importPreview.invalid.map((row) => (
                      <tr key={row.rowNumber}>
                        <td>{row.rowNumber}</td>
                        <td colSpan={3}>Invalid row</td>
                        <td>
                          <span className="status danger">
                            {row.errors.join("; ")}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {actionData.importPreview.valid.length &&
              !actionData.importPreview.invalid.length ? (
                <Form method="post">
                  <input type="hidden" name="_intent" value="confirm_import" />
                  <input
                    type="hidden"
                    name="csv"
                    value={actionData.importPreview.csv}
                  />
                  <button className="btn primary" disabled={busy}>
                    Confirm import
                  </button>
                </Form>
              ) : null}
            </div>
          ) : null}
        </details>
      </div>

      <section className="card pad" aria-labelledby="crm-segments-heading">
        <div className="card-title">
          <div>
            <span className="pc-section-kicker">Reusable lists</span>
            <h2 id="crm-segments-heading">Dynamic segments</h2>
          </div>
          <ListFilter aria-hidden className="subtle" />
        </div>
        {filtersActive ? (
          <Form method="post" className="form-row mt">
            <input type="hidden" name="_intent" value="save_segment" />
            {Object.entries(directory.filters).map(([key, value]) => (
              <input type="hidden" name={key} value={value} key={key} />
            ))}
            <label className="label">
              Segment name
              <input
                className="field"
                name="name"
                placeholder="AI Experts"
                required
              />
            </label>
            <button className="btn primary" disabled={busy}>
              Save dynamic segment
            </button>
          </Form>
        ) : (
          <p className="subtle">
            Apply a directory filter to save it as a dynamic segment.
          </p>
        )}
        {directory.segments.length ? (
          <div className="crm-chip-row mt">
            {directory.segments.map((saved) => (
              <Link
                className="crm-chip"
                key={saved.id}
                to={`/admin/crm?segment=${encodeURIComponent(saved.id)}`}
              >
                {saved.name}
              </Link>
            ))}
          </div>
        ) : null}
      </section>
    </>
  );
}
