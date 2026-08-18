import { FilterX, Mail, Upload, UserPlus, UsersRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useNavigation,
  useSubmit,
} from "react-router";
import { ZodError } from "zod";
import { EmptyState } from "~/components/ui/states";
import {
  type CrmFilters,
  CrmService,
  CrmStateError,
} from "~/modules/crm/crm-service.server";
import { ensureDemoCrmData } from "~/modules/crm/demo.server";
import { requireOrganisationAdministrator } from "~/platform/auth/organisation.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/admin-crm";

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
  const submit = useSubmit();
  const searchTimer = useRef<number | null>(null);
  const { directory, dashboard, segment } = loaderData;
  const [searchQuery, setSearchQuery] = useState(directory.filters.query);
  const [selectedCount, setSelectedCount] = useState(0);
  const filtersActive = Object.values(directory.filters).some(Boolean);
  const busy = navigation.state !== "idle";
  useEffect(() => {
    setSearchQuery(directory.filters.query);
  }, [directory.filters.query]);
  const selectionResetKey = [
    directory.filters.query,
    directory.filters.company,
    directory.filters.jobTitle,
    directory.filters.tag,
    directory.page,
    segment?.id ?? "",
  ].join(":");
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reset bulk selection when the directory query changes; the key is the trigger, not a value the effect reads.
  useEffect(() => {
    setSelectedCount(0);
  }, [selectionResetKey]);
  useEffect(
    () => () => {
      if (searchTimer.current) window.clearTimeout(searchTimer.current);
    },
    [],
  );
  function submitDirectoryFilters(form: HTMLFormElement | null) {
    if (!form) return;
    submit(form, { method: "get", replace: true });
  }
  function scheduleDirectorySearch(form: HTMLFormElement | null) {
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    searchTimer.current = window.setTimeout(
      () => submitDirectoryFilters(form),
      250,
    );
  }
  const pulseParts = [
    `${dashboard.totalContacts} ${dashboard.totalContacts === 1 ? "contact" : "contacts"}`,
    `${dashboard.eventCount} ${dashboard.eventCount === 1 ? "event" : "events"}`,
    dashboard.returningSpeakers
      ? `${dashboard.returningSpeakers} returning`
      : null,
  ].filter(Boolean);
  return (
    <div className="crm-workspace">
      <div className="page-head pc-page-header">
        <div>
          <span className="pc-page-eyebrow">
            Organization workspace · all events
          </span>
          <h1>Speaker Network</h1>
          <p className="crm-caption">
            Reusable profiles, private relationship context, and sourcing
            prospects into events without re-entering data.
          </p>
        </div>
        <div className="page-actions">
          <Link className="btn" to="/admin/crm/pipeline">
            Sourcing pipeline
          </Link>
          <Link className="btn primary" to="/admin/crm/outreach">
            Speaker invitations
          </Link>
        </div>
      </div>

      <div className="crm-pulse">
        {pulseParts.join(" · ")}
        {" · "}
        <h2 className="crm-pulse-heading">Top companies</h2>
        {dashboard.companies.length ? (
          <span className="crm-pulse-companies">
            {": "}
            {dashboard.companies.map((company, index) => (
              <span key={company.name}>
                {index ? ", " : ""}
                <Link
                  to={`/admin/crm?${new URLSearchParams({ company: company.name })}`}
                >
                  {company.name} · {company.contacts}
                </Link>
              </span>
            ))}
          </span>
        ) : (
          " not recorded yet"
        )}
      </div>

      {actionData ? (
        <div
          className={`validation-item ${actionData.ok ? "ok" : "error"} crm-notice`}
          role={actionData.ok ? "status" : "alert"}
        >
          <strong>{actionData.ok ? "✓" : "△"}</strong>
          <span>{actionData.message}</span>
        </div>
      ) : null}

      <section className="crm-board" aria-labelledby="crm-directory-heading">
        <div className="crm-board-head">
          <h2 id="crm-directory-heading">
            {segment ? `${segment.name} segment` : "Organization contacts"}
          </h2>
          <span className="crm-board-meta">
            Showing {directory.contacts.length}{" "}
            {directory.contacts.length === 1 ? "contact" : "contacts"}
          </span>
        </div>
        <Form
          method="get"
          className="crm-toolbar"
          key={`${directory.filters.company}:${directory.filters.jobTitle}:${directory.filters.tag}`}
        >
          <label className="crm-filter crm-filter-search">
            <span className="sr-only">Search contacts</span>
            <input
              className="field"
              name="query"
              value={searchQuery}
              onChange={(event) => {
                setSearchQuery(event.currentTarget.value);
                scheduleDirectorySearch(event.currentTarget.form);
              }}
              placeholder="Name or email"
            />
          </label>
          <label className="crm-filter">
            <span className="sr-only">Company</span>
            <select
              className="select"
              name="company"
              defaultValue={directory.filters.company}
              onChange={(event) =>
                submitDirectoryFilters(event.currentTarget.form)
              }
            >
              <option value="">All companies</option>
              {directory.facets.companies.map((company) => (
                <option key={company}>{company}</option>
              ))}
            </select>
          </label>
          <label className="crm-filter">
            <span className="sr-only">Job title</span>
            <select
              className="select"
              name="jobTitle"
              defaultValue={directory.filters.jobTitle}
              onChange={(event) =>
                submitDirectoryFilters(event.currentTarget.form)
              }
            >
              <option value="">All job titles</option>
              {directory.facets.jobTitles.map((title) => (
                <option key={title}>{title}</option>
              ))}
            </select>
          </label>
          <label className="crm-filter">
            <span className="sr-only">Tag</span>
            <select
              className="select"
              name="tag"
              defaultValue={directory.filters.tag}
              onChange={(event) =>
                submitDirectoryFilters(event.currentTarget.form)
              }
            >
              <option value="">All tags</option>
              {directory.facets.tags.map((tag) => (
                <option key={tag}>{tag}</option>
              ))}
            </select>
          </label>
          <div className="crm-filter-actions">
            <button className="sr-only" type="submit">
              Apply filters
            </button>
            {filtersActive ? (
              <Link className="crm-text-action" to="/admin/crm">
                <FilterX aria-hidden size={15} /> Clear filters
              </Link>
            ) : null}
          </div>
        </Form>
        {filtersActive ? (
          <fieldset
            className="crm-aux pc-plain-fieldset"
            aria-label="Active directory filters"
          >
            <div className="crm-chips">
              {Object.entries(directory.filters)
                .filter(([, value]) => value)
                .map(([key, value]) => (
                  <span className="crm-chip" key={key}>
                    {key.replace(/([A-Z])/g, " $1")}: {value}
                  </span>
                ))}
            </div>
            <Form method="post" className="crm-segment-save">
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
              <button type="submit" className="btn" disabled={busy}>
                Save dynamic segment
              </button>
            </Form>
          </fieldset>
        ) : null}
        {directory.segments.length ? (
          <div className="crm-aux">
            <div className="crm-chips">
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
          </div>
        ) : null}
        <div className="crm-aux">
          <details className="crm-disclosure">
            <summary>
              <span>
                <UserPlus aria-hidden size={14} /> Add speaker contact manually
              </span>
            </summary>
            <div className="crm-disclosure-body">
              <Form method="post" className="stack">
                <input type="hidden" name="_intent" value="create_contact" />
                <div className="form-row">
                  <label className="label">
                    Name
                    <input className="field" name="name" required />
                  </label>
                  <label className="label">
                    Email
                    <input
                      className="field"
                      type="email"
                      name="email"
                      required
                    />
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
                <button type="submit" className="btn primary" disabled={busy}>
                  Create speaker contact
                </button>
              </Form>
            </div>
          </details>
          <details
            className="crm-disclosure"
            open={Boolean(actionData?.importPreview)}
          >
            <summary>
              <span>
                <Upload aria-hidden size={14} /> Import speaker contacts from
                CSV
              </span>
            </summary>
            <div className="crm-disclosure-body">
              <Form
                method="post"
                encType="multipart/form-data"
                className="stack"
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
                  Accepted columns: name, email, title, company and bio. Import
                  is previewed before it writes.
                </p>
                <button type="submit" className="btn" disabled={busy}>
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
                  <section
                    className="table-wrap"
                    aria-label="CRM import preview"
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data regions need keyboard focus so arrow keys can expose overflow content.
                    tabIndex={0}
                  >
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
                  </section>
                  {actionData.importPreview.valid.length &&
                  !actionData.importPreview.invalid.length ? (
                    <Form method="post">
                      <input
                        type="hidden"
                        name="_intent"
                        value="confirm_import"
                      />
                      <input
                        type="hidden"
                        name="csv"
                        value={actionData.importPreview.csv}
                      />
                      <button
                        type="submit"
                        className="btn primary"
                        disabled={busy}
                      >
                        Confirm import
                      </button>
                    </Form>
                  ) : null}
                </div>
              ) : null}
            </div>
          </details>
        </div>

        <Form
          method="get"
          action="/admin/crm/outreach"
          onChange={(event) => {
            const form = event.currentTarget;
            setSelectedCount(
              form.querySelectorAll('input[name="person"]:checked').length,
            );
          }}
        >
          <section
            className="crm-table-scroll"
            aria-label="Speaker contact directory"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data regions need keyboard focus so arrow keys can expose overflow content.
            tabIndex={0}
          >
            <table className="crm-directory">
              <thead>
                <tr>
                  <th scope="col" className="crm-select-cell">
                    <span className="sr-only">Select</span>
                  </th>
                  <th scope="col">Contact</th>
                  <th scope="col">Company and title</th>
                  <th scope="col" className="crm-col-optional">
                    Tags
                  </th>
                  <th scope="col">History</th>
                </tr>
              </thead>
              <tbody>
                {directory.contacts.map((contact) => (
                  <tr key={contact.personId}>
                    <td className="crm-select-cell">
                      <input
                        type="checkbox"
                        name="person"
                        value={contact.personId}
                        aria-label={`Select ${contact.name}`}
                      />
                    </td>
                    <td data-label="Contact">
                      <div className="crm-person-copy">
                        <Link
                          to={`/admin/crm/contacts/${encodeURIComponent(contact.personId)}`}
                        >
                          {contact.name}
                        </Link>
                        <small>{contact.email}</small>
                        {contact.duplicateCount ? (
                          <span className="status warning">
                            Possible duplicate
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td data-label="Company and title">
                      <div className="crm-state">
                        <span>{contact.jobTitle ?? "Title not recorded"}</span>
                        <small className="subtle">
                          {contact.organisationName ?? "Company not recorded"}
                        </small>
                      </div>
                    </td>
                    <td className="crm-col-optional" data-label="Tags">
                      {contact.tags.length ? contact.tags.join(" · ") : null}
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
          </section>
          {directory.contacts.length ? (
            selectedCount > 0 ? (
              <div className="crm-board-foot">
                <button className="btn" type="submit">
                  <Mail aria-hidden size={15} /> Email selected contacts
                </button>
              </div>
            ) : null
          ) : (
            <EmptyState
              className="crm-empty"
              icon={UsersRound}
              title="No matching contacts"
              description="Clear the filters or add a reusable speaker contact."
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
        {directory.page > 1 || directory.hasNext ? (
          <nav
            className="crm-pager"
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
    </div>
  );
}
