import { data, Form, Link, useActionData, useNavigation } from "react-router";
import { ZodError } from "zod";

import type { Route } from "./+types/submissions-admin";
import { SubmissionService } from "~/modules/submissions/submission-service.server";
import { requireEventRole } from "~/platform/auth/authorize.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

export const meta: Route.MetaFunction = () => [{ title: "Submissions · Program Cue" }];

async function getViewer(request: Request, context: Route.LoaderArgs["context"]) {
  const { env } = getCloudflareContext(context);
  if (!env.DEFAULT_EVENT_ID) throw new Response("DEFAULT_EVENT_ID is not configured", { status: 503 });
  return { env, viewer: await requireEventRole(request, env, env.DEFAULT_EVENT_ID, ["owner", "administrator"]) };
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env, viewer } = await getViewer(request, context);
  const service = new SubmissionService(env);
  if (params.submissionId) {
    const submission = await service.getAdminSubmission(viewer, params.submissionId);
    if (!submission) throw new Response("Submission not found", { status: 404 });
    return { mode: "detail" as const, submission };
  }
  const url = new URL(request.url);
  const filters = {
    status: url.searchParams.get("status") ?? "",
    category: url.searchParams.get("category") ?? "",
    query: url.searchParams.get("query") ?? "",
  };
  return { mode: "list" as const, submissions: await service.listAdminSubmissions(viewer, filters), filters };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env, viewer } = await getViewer(request, context);
  const formData = await request.formData();
  try {
    await new SubmissionService(env).createDirectSession(viewer, {
      title: formData.get("title"), description: formData.get("description"), format: formData.get("format"),
      durationMinutes: formData.get("durationMinutes"), speakerName: formData.get("speakerName"), speakerEmail: formData.get("speakerEmail"),
    });
    return data({ ok: true, message: "Direct session created in the unscheduled programme." });
  } catch (error) {
    if (error instanceof ZodError) {
      return data({ ok: false, message: error.issues[0]?.message ?? "Review the session details." }, { status: 422 });
    }
    if (error instanceof Response) throw error;
    throw error;
  }
}

type SubmissionDetail = NonNullable<Awaited<ReturnType<SubmissionService["getAdminSubmission"]>>>;

function utcDateTime(epoch: number) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(epoch * 1_000));
}

function Detail({ submission }: { submission: SubmissionDetail }) {
  const labels = new Map(submission.schema?.fields.map((field) => [field.id, field.label]) ?? []);
  return <><div className="page-head"><div><Link className="subtle" to="/admin/submissions">← All submissions</Link><h1>{submission.title}</h1><p>{submission.submitterName} · {submission.submitterEmail}</p></div><div className="page-actions"><span className={`status ${submission.status === "submitted" ? "success" : "info"}`}>{submission.status}</span><span className="pill">Form v{submission.versionNumber ?? "—"}</span></div></div><div className="grid grid-2"><section className="card pad"><div className="card-title"><h2>Application snapshot</h2><span className="subtle right">Immutable source answers</span></div><dl className="stack">{Object.entries(submission.answers).map(([key, value]) => <div key={key}><dt className="label">{labels.get(key) ?? key}</dt><dd style={{ margin: "4px 0 0", whiteSpace: "pre-wrap" }}>{Array.isArray(value) ? value.join(", ") : value || "—"}</dd></div>)}</dl></section><aside className="stack"><section className="card pad"><h2>Routing</h2><p><span className="label">Category</span><br />{submission.category ?? "Uncategorised"}</p><p><span className="label">Assigned route</span><br />{submission.routedTo}</p><p><span className="label">Format</span><br />{submission.format ?? "Not set"}</p><p><span className="label">Submitted (UTC)</span><br />{submission.submittedAt ? utcDateTime(submission.submittedAt) : "Draft"}</p></section><section className="card pad"><div className="card-title"><h2>Speakers</h2><span className="pill right">{submission.speakers.length}</span></div>{submission.speakers.map((speaker) => <div className="row-main mt" key={speaker.id}><span className="avatar sm">{speaker.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join("")}</span><span><strong>{speaker.name}{speaker.isPrimary ? " · Primary" : ""}</strong><small>{speaker.email} · {speaker.invitationStatus}</small></span></div>)}</section></aside></div></>;
}

export default function SubmissionsAdmin({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  if (loaderData.mode === "detail") return <Detail submission={loaderData.submission} />;
  const { submissions, filters } = loaderData;
  const submitted = submissions.filter((submission) => submission.status === "submitted").length;
  const drafts = submissions.filter((submission) => submission.status === "draft").length;
  const categories = [...new Set(submissions.map((submission) => submission.category).filter(Boolean))].sort();
  return <>
    <div className="page-head"><div><h1>Submissions</h1><p>Track real applications from private draft through programme decision.</p></div><div className="page-actions"><Link className="btn" to="/admin/submissions/form">Form Builder</Link></div></div>
    {actionData ? <div className={`validation-item ${actionData.ok ? "ok" : "error"} card pad mb`} role={actionData.ok ? "status" : "alert"}><strong>{actionData.ok ? "✓" : "△"}</strong><span>{actionData.message}</span></div> : null}
    <div className="grid grid-4 mb"><section className="card metric"><div className="label">Visible records</div><div className="value">{submissions.length}</div></section><section className="card metric"><div className="label">Submitted</div><div className="value">{submitted}</div></section><section className="card metric"><div className="label">Private drafts</div><div className="value">{drafts}</div></section><section className="card metric"><div className="label">Category routes</div><div className="value">{new Set(submissions.map((submission) => submission.routedTo).filter((route) => route !== "Unassigned")).size}</div></section></div>
    <section className="card pad mb"><Form method="get" className="form-row" role="search"><label className="label">Search<input className="field" name="query" defaultValue={filters.query} placeholder="Title, submitter or email" /></label><label className="label">Status<select className="select" name="status" defaultValue={filters.status}><option value="">All statuses</option>{["draft", "submitted", "assigned", "in_review", "decision_ready", "accepted", "rejected", "withdrawn"].map((status) => <option key={status}>{status}</option>)}</select></label><label className="label">Category<select className="select" name="category" defaultValue={filters.category}><option value="">All categories</option>{categories.map((category) => <option key={category}>{category}</option>)}</select></label><div className="page-actions" style={{ alignSelf: "end" }}><button className="btn primary" type="submit">Apply filters</button><Link className="btn" to="/admin/submissions">Clear</Link></div></Form></section>
    <section className="card pad mb">
      <div className="card-title"><h2>Application queue</h2><span className="help right">D1 · tenant scoped · newest first</span></div>
      <div className="table-wrap pc-responsive-table-wrap">
        <table className="data-table pc-responsive-table">
          <thead><tr><th scope="col">Application</th><th scope="col">Submitter</th><th scope="col">Category route</th><th scope="col">Speakers</th><th scope="col">Status</th><th scope="col">Action</th></tr></thead>
          <tbody>{submissions.length ? submissions.map((submission) => <tr key={submission.id}>
            <td className="pc-record-primary-cell" data-label="Application"><div className="pc-record-stack"><Link to={`/admin/submissions/${submission.id}`}><strong>{submission.title}</strong></Link><small className="subtle">Reference {submission.publicReference}</small><small className="subtle">Form v{submission.versionNumber ?? "—"}</small></div></td>
            <td data-label="Submitter"><div className="pc-record-stack"><strong>{submission.submitterName}</strong><small className="subtle pc-record-email">{submission.submitterEmail}</small></div></td>
            <td data-label="Category route"><div className="pc-record-stack"><span>{submission.category || "Uncategorised"}</span><small className="subtle">{submission.routedTo}</small></div></td>
            <td data-label="Speakers">{submission.speakerCount}</td>
            <td data-label="Status"><span className={`status ${submission.status === "submitted" || submission.status === "accepted" ? "success" : submission.status === "draft" ? "info" : "warning"}`}>{submission.status.replaceAll("_", " ")}</span></td>
            <td data-label="Action" className="pc-record-action-cell"><Link className="btn small" to={`/admin/submissions/${submission.id}`}>Open</Link></td>
          </tr>) : <tr className="pc-table-empty-row"><td className="pc-table-empty-cell" colSpan={6}><div className="pc-empty-state"><h2>No matching applications</h2><p className="subtle">Publish a form and submit an application, or clear the filters.</p></div></td></tr>}</tbody>
        </table>
      </div>
    </section>
    <details className="card pad"><summary><strong>Create a guaranteed direct session</strong> <span className="subtle">for sponsors, invited speakers or manually confirmed programme items</span></summary><Form method="post" className="stack mt"><div className="form-row"><label className="label">Session title<input className="field" name="title" required /></label><label className="label">Format<select className="select" name="format" defaultValue="presentation"><option value="keynote">Keynote</option><option value="presentation">Presentation</option><option value="panel">Panel</option><option value="workshop">Workshop</option><option value="breakout">Breakout</option><option value="other">Other</option></select></label><label className="label">Duration (minutes)<input className="field" name="durationMinutes" type="number" min={5} defaultValue={30} required /></label></div><label className="label">Description<textarea className="textarea" name="description" /></label><div className="form-row"><label className="label">Speaker name<input className="field" name="speakerName" required /></label><label className="label">Speaker email<input className="field" name="speakerEmail" type="email" required /></label></div><button className="btn primary" type="submit" disabled={navigation.state !== "idle"}>{navigation.state === "submitting" ? "Creating…" : "Create unscheduled session"}</button></Form></details>
  </>;
}
