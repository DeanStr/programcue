import { data, Form, Link, redirect, useNavigation } from "react-router";
import { z } from "zod";
import { SponsorAssets } from "~/components/sponsor-assets";
import { SponsorProfileFields } from "~/components/sponsor-fields";
import { Button, ButtonLink } from "~/components/ui/button";
import { EventDateTime } from "~/components/ui/event-date-time";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import { SponsorAssetService } from "~/modules/sponsors/sponsor-assets.server";
import {
  requireSponsorConfirmation,
  sponsorFormError,
  sponsorKey,
  sponsorProfileInput,
  sponsorRevision,
} from "~/modules/sponsors/sponsor-forms.server";
import { SponsorReadinessService } from "~/modules/sponsors/sponsor-readiness.server";
import { SponsorService } from "~/modules/sponsors/sponsor-service.server";
import { fixedDateEndEpoch } from "~/modules/tasks/task-service-foundation.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";
import type { Route } from "./+types/admin-sponsors";

export const meta = () => [{ title: "Sponsors · Program Cue" }];
async function administrator(
  request: Request,
  context: Route.LoaderArgs["context"],
) {
  const { env } = getCloudflareContext(context);
  await ensureDemoSpeakerData(env);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  return { env, viewer, service: new SponsorService(env) };
}
export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, viewer, service } = await administrator(request, context);
  const sponsorId = new URL(request.url).searchParams.get("sponsor");
  const event = await env.DB.prepare(
    "SELECT timezone FROM events WHERE id=? AND organisation_id=?",
  )
    .bind(viewer.eventId, viewer.organisationId)
    .first<{ timezone: string }>();
  if (!event) throw new Response("Event not found", { status: 404 });
  const workspace = sponsorId
    ? await service.adminWorkspace(viewer, sponsorId)
    : null;
  const closesDate = workspace?.sponsor.closesAt
    ? new Intl.DateTimeFormat("en-CA", {
        timeZone: event.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).format(workspace.sponsor.closesAt * 1000)
    : "";
  const assets = new SponsorAssetService(env);
  return {
    readiness: await new SponsorReadinessService(env).workspace(
      viewer,
      Object.fromEntries(new URL(request.url).searchParams),
    ),
    assets: sponsorId ? await assets.adminAssets(viewer, sponsorId) : [],
    filePolicy: await assets.filePolicy(viewer.eventId),
    eventId: viewer.eventId,
    sponsors: await service.listAdmin(viewer),
    workspace,
    timezone: event.timezone,
    closesDate,
    key: crypto.randomUUID(),
  };
}
export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST")
    throw new Response("Method not allowed", { status: 405 });
  const { env, viewer, service } = await administrator(request, context);
  const form = await request.formData();
  const intent = form.get("intent");
  const sponsorId = String(form.get("sponsorId") ?? "");
  try {
    const key = sponsorKey(form);
    const assets = new SponsorAssetService(env);
    if (intent === "remind-sponsors") {
      const draft = await new SponsorReadinessService(env).reminder(
        viewer,
        Object.fromEntries(new URL(request.url).searchParams),
        String(form.get("templateVersionId")),
        key,
      );
      return redirect(`/admin/communications/compose/${draft.id}`);
    }
    if (intent === "request-asset") {
      await assets.request(
        viewer,
        sponsorId,
        {
          name: form.get("assetName"),
          kind: form.get("kind"),
          required: form.get("required") === "yes",
        },
        key,
      );
      const warning = await recordRouteChange(env, viewer, {
        entityType: "sponsorship",
        entityId: sponsorId,
        changeType: "updated",
      });
      if (warning) return data(warning, { status: 207 });
      return data({ ok: true, message: "Sponsor asset requested." });
    }
    if (intent === "review-asset") {
      requireSponsorConfirmation(form);
      await assets.review(
        viewer,
        sponsorId,
        {
          id: form.get("requestId"),
          versionId: form.get("versionId"),
          revision: sponsorRevision(form),
          decision: form.get("decision"),
          note: form.get("note"),
        },
        key,
      );
      const warning = await recordRouteChange(env, viewer, {
        entityType: "sponsorship",
        entityId: sponsorId,
        changeType: "updated",
      });
      if (warning) return data(warning, { status: 207 });
      return data({ ok: true, message: "Asset review saved." });
    }
    if (intent === "stage-logo") {
      requireSponsorConfirmation(form);
      await assets.stageLogo(
        viewer,
        sponsorId,
        String(form.get("requestId")),
        String(form.get("versionId")),
        {
          name: form.get("name"),
          tier: form.get("tier"),
          description: form.get("description"),
          websiteUrl: form.get("websiteUrl"),
        },
        key,
      );
      const warning = await recordRouteChange(env, viewer, {
        entityType: "public_site",
        entityId: viewer.eventId,
        changeType: "updated",
      });
      if (warning) return data(warning, { status: 207 });
      return data({
        ok: true,
        message:
          "Approved logo copied to the website draft. Review and publish the website separately.",
      });
    }
    if (intent === "save") {
      const event = await env.DB.prepare(
        "SELECT timezone FROM events WHERE id=? AND organisation_id=?",
      )
        .bind(viewer.eventId, viewer.organisationId)
        .first<{ timezone: string }>();
      if (!event) throw new Response("Event not found", { status: 404 });
      const date = form.get("closesDate");
      const id = await service.save(
        viewer,
        {
          ...sponsorProfileInput(form),
          tier: form.get("tier"),
          sessionLimit: form.get("sessionLimit"),
          closesAt: date
            ? fixedDateEndEpoch(z.iso.date().parse(date), event.timezone)
            : null,
        },
        key,
        sponsorId
          ? { id: sponsorId, revision: sponsorRevision(form) }
          : undefined,
      );
      const warning = await recordRouteChange(env, viewer, {
        entityType: "sponsorship",
        entityId: id,
        changeType: "updated",
      });
      if (warning) return data(warning, { status: 207 });
      return redirect(`/admin/sponsors?sponsor=${id}`);
    }
    if (intent === "add-contact")
      await service.addContact(
        viewer,
        sponsorId,
        { name: form.get("contactName"), email: form.get("email") },
        key,
      );
    else if (intent === "revoke-contact" || intent === "restore-contact") {
      requireSponsorConfirmation(form);
      await service[
        intent === "revoke-contact" ? "revokeContact" : "restoreContact"
      ](
        viewer,
        sponsorId,
        String(form.get("contactId")),
        sponsorRevision(form),
        key,
      );
    } else if (intent === "invite") {
      const draft = await service.prepareInvitation(viewer, sponsorId, key);
      return redirect(`/admin/communications/compose/${draft.id}`);
    } else if (intent === "approve") {
      requireSponsorConfirmation(form);
      const result = await service.approve(
        viewer,
        sponsorId,
        String(form.get("proposalId")),
        sponsorRevision(form),
      );
      const warning = await recordRouteChange(env, viewer, {
        entityType: "session",
        entityId: result.sessionId,
        changeType: "created",
      });
      return data({
        ok: !result.invitationWarning && !result.webhookWarning && !warning,
        message: [
          "Session accepted. Manage its content, speaker participation and publication in the organiser workspace.",
          result.invitationWarning,
          result.webhookWarning,
          warning?.message,
        ]
          .filter(Boolean)
          .join(" "),
      });
    } else
      return data(
        { ok: false, message: "Unsupported sponsor action." },
        { status: 400 },
      );
    const warning = await recordRouteChange(env, viewer, {
      entityType: "sponsorship",
      entityId: sponsorId,
      changeType: "updated",
    });
    return data(warning ?? { ok: true, message: "Sponsor contact updated." }, {
      status: warning ? 207 : 200,
    });
  } catch (error) {
    const message = sponsorFormError(error);
    if (message) return data({ ok: false, message }, { status: 422 });
    throw error;
  }
}
export default function Sponsors({
  loaderData: d,
  actionData,
}: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const w = d.workspace;
  const hidden = (intent: string) => (
    <>
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="key" value={d.key} />
      <input type="hidden" name="sponsorId" value={w?.sponsor.id ?? ""} />
    </>
  );
  return (
    <>
      <div className="page-head pc-page-header">
        <div>
          <h1>Sponsors</h1>
          <p>
            Company contacts, session allowances and sponsored session review.
          </p>
        </div>
        <ButtonLink to="/admin/sponsors">Add sponsor</ButtonLink>
        <ButtonLink to="/sponsor">Sponsor portal</ButtonLink>
      </div>
      {actionData && (
        <p role={actionData.ok ? "status" : "alert"}>{actionData.message}</p>
      )}
      <section className="card pad mb stack" aria-label="Sponsor readiness">
        <h2>Sponsor readiness</h2>
        <Form
          key={JSON.stringify(d.readiness.filters)}
          method="get"
          className="row-actions"
        >
          <label className="label">
            Company
            <input
              className="field"
              name="q"
              defaultValue={d.readiness.filters.q}
            />
          </label>
          <label className="label">
            Readiness
            <select
              className="select"
              name="state"
              defaultValue={d.readiness.filters.state}
            >
              <option value="all">All sponsors</option>
              <option value="invitation">Invitation not accepted</option>
              <option value="sessions">Sessions to submit</option>
              <option value="assets">Assets needing sponsor action</option>
              <option value="review">Awaiting organiser review</option>
              <option value="due">Deadline within 7 days or overdue</option>
              <option value="ready">Ready</option>
            </select>
          </label>
          <Button type="submit" disabled={busy}>
            Filter sponsors
          </Button>
          <ButtonLink to="/admin/sponsors">Clear</ButtonLink>
        </Form>
        <section
          className="table-wrap"
          aria-label="Sponsor requirements table"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll the requirements table.
          tabIndex={0}
        >
          <table className="data-table">
            <caption>Sponsor requirements and next steps</caption>
            <thead>
              <tr>
                <th>Company</th>
                <th>Access</th>
                <th>Sessions</th>
                <th>Assets</th>
                <th>Deadline</th>
              </tr>
            </thead>
            <tbody>
              {d.readiness.rows.map((s) => (
                <tr key={s.id}>
                  <td>
                    <Link to={`?sponsor=${s.id}`}>{s.name}</Link>
                    {s.readiness.ready && <p>Ready</p>}
                  </td>
                  <td>
                    {s.readiness.acceptedContacts}/{s.readiness.contacts}{" "}
                    contacts accepted
                  </td>
                  <td>
                    {s.readiness.submitted}/{s.sessionLimit} submitted ·{" "}
                    {s.readiness.approved} approved
                  </td>
                  <td>
                    {s.readiness.actionableAssets} need sponsor action ·{" "}
                    {s.readiness.assetReview} awaiting review ·{" "}
                    {s.readiness.outstandingAssets} required outstanding
                  </td>
                  <td>
                    {s.closesAt ? (
                      <>
                        <EventDateTime
                          epochSeconds={s.closesAt}
                          timeZone={d.timezone}
                          showTimeZone
                        />
                        {s.readiness.closed && <p>Editing closed</p>}
                      </>
                    ) : (
                      "No deadline"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        {!d.readiness.rows.length && <p>No sponsors match these filters.</p>}
        <p>
          {d.readiness.recipients.length} contacts have outstanding sponsor
          work. Work awaiting checks or organiser review and closed editing
          periods are excluded.
        </p>
        {d.readiness.templates.length ? (
          <Form method="post" className="row-actions">
            {hidden("remind-sponsors")}
            <label className="label">
              Sponsor reminder template
              <select className="select" name="templateVersionId">
                {d.readiness.templates.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
            </label>
            <Button
              type="submit"
              disabled={busy || !d.readiness.recipients.length}
            >
              Prepare sponsor reminder
            </Button>
            <p>
              Creates an editable draft for matching contacts. Nothing is sent
              until you preview and confirm delivery.
            </p>
          </Form>
        ) : (
          <p>
            Publish an ad hoc or reminder template in{" "}
            <Link to="/admin/communications">Communications</Link> to prepare
            reminders.
          </p>
        )}
      </section>
      {w && (
        <SponsorAssets
          assets={d.assets}
          eventId={d.eventId}
          sponsorId={w.sponsor.id}
          companyProfile={w.sponsor}
          commandKey={d.key}
          admin
          busy={busy}
          filePolicy={d.filePolicy}
        />
      )}
      <nav className="page-actions mb" aria-label="Event sponsors">
        {d.sponsors.map((s) => (
          <ButtonLink
            key={s.id}
            to={`?sponsor=${s.id}`}
            aria-current={w?.sponsor.id === s.id ? "page" : undefined}
          >
            {s.name} · {s.sessionsUsed}/{s.sessionLimit}
          </ButtonLink>
        ))}
      </nav>
      <div className="grid grid-2">
        <section className="card pad">
          <h2>{w ? w.sponsor.name : "Add sponsor"}</h2>
          <Form
            key={`${w?.sponsor.id ?? "new"}:${w?.sponsor.revision ?? 0}`}
            method="post"
            className="stack"
          >
            {hidden("save")}
            <input
              type="hidden"
              name="revision"
              value={w?.sponsor.revision ?? 1}
            />
            <SponsorProfileFields value={w?.sponsor} />
            <label className="label">
              Tier
              <input
                className="field"
                name="tier"
                maxLength={80}
                defaultValue={w?.sponsor.tier}
              />
            </label>
            <label className="label">
              Session allowance
              <input
                className="field"
                name="sessionLimit"
                type="number"
                min={w?.sponsor.sessionsUsed ?? 0}
                max={100}
                required
                defaultValue={w?.sponsor.sessionLimit ?? 1}
              />
            </label>
            <label className="label">
              Editing deadline
              <input
                className="field"
                name="closesDate"
                type="date"
                defaultValue={d.closesDate}
              />
              <span className="help">
                End of this date in {d.timezone}. Leave blank for no deadline.
                Draft, submitted and accepted sessions count toward the
                allowance.
              </span>
            </label>
            <Button type="submit" disabled={busy} variant="primary">
              {w ? "Save sponsor" : "Create sponsor"}
            </Button>
          </Form>
        </section>
        {w && (
          <section className="card pad">
            <h2>Portal contacts</h2>
            <p>
              Contacts share this company’s profile and proposals. Access
              requires signing in with the invited address and accepting the
              invitation.
            </p>
            <ul>
              {w.contacts.map((c) => (
                <li key={c.id}>
                  <strong>{c.name}</strong> · {c.email} ·{" "}
                  {c.revokedAt
                    ? "Revoked"
                    : c.acceptedAt
                      ? "Accepted"
                      : "Invited"}
                  <details>
                    <summary>
                      {c.revokedAt ? "Restore access" : "Revoke access"}
                    </summary>
                    <Form method="post">
                      {hidden(
                        c.revokedAt ? "restore-contact" : "revoke-contact",
                      )}
                      <input type="hidden" name="contactId" value={c.id} />
                      <input type="hidden" name="revision" value={c.revision} />
                      <label className="label">
                        <input
                          type="checkbox"
                          name="confirmed"
                          value="yes"
                          required
                        />
                        Confirm {c.revokedAt ? "restoring" : "revoking"} sponsor
                        access for {c.email}.
                      </label>
                      <Button type="submit" disabled={busy}>
                        {c.revokedAt ? "Restore contact" : "Revoke contact"}
                      </Button>
                    </Form>
                  </details>
                </li>
              ))}
            </ul>
            <Form method="post" className="stack">
              {hidden("add-contact")}
              <label className="label">
                Contact name
                <input
                  className="field"
                  name="contactName"
                  required
                  maxLength={120}
                />
              </label>
              <label className="label">
                Contact email
                <input
                  className="field"
                  name="email"
                  type="email"
                  required
                  maxLength={254}
                />
              </label>
              <Button type="submit" disabled={busy}>
                Add contact
              </Button>
            </Form>
            <Form method="post" className="mt">
              {hidden("invite")}
              <p>
                Prepare an invitation for all active contacts above, then review
                recipients and confirm sending in Communications.
              </p>
              <Button
                type="submit"
                disabled={busy || !w.contacts.some((c) => !c.revokedAt)}
              >
                Prepare invitation
              </Button>
            </Form>
          </section>
        )}
      </div>
      {w && (
        <section className="stack mt" aria-label="Sponsored sessions">
          <h2>
            Sponsored sessions · {w.sponsor.sessionsUsed}/
            {w.sponsor.sessionLimit}
          </h2>
          {w.sponsor.closesAt && (
            <p>
              Portal deadline:{" "}
              <EventDateTime
                epochSeconds={w.sponsor.closesAt}
                timeZone={d.timezone}
              />
            </p>
          )}
          {!w.proposals.length && <p>No sessions proposed yet.</p>}
          {w.proposals.map((p) => (
            <article className="card pad" key={p.id}>
              <h3>{p.details.title}</h3>
              <p>Status: {p.status}</p>
              <p>{p.details.description}</p>
              <p>
                {w.tracks.find((t) => t.id === p.details.trackId)?.name ??
                  "Track unavailable"}{" "}
                ·{" "}
                {w.formats.find((f) => f.key === p.details.format)?.label ??
                  p.details.format}{" "}
                · {p.details.durationMinutes ?? "Default"} minutes
              </p>
              <ul>
                {p.details.speakers.map((s) => (
                  <li key={s.email}>
                    {s.name} · {s.email}
                    {s.biography && <p>{s.biography}</p>}
                  </li>
                ))}
              </ul>
              {p.sessionId && (
                <Link to={`/admin/content/sessions/${p.sessionId}`}>
                  Manage accepted session
                </Link>
              )}
              {p.status === "submitted" && (
                <Form method="post">
                  {hidden("approve")}
                  <input type="hidden" name="proposalId" value={p.id} />
                  <input type="hidden" name="revision" value={p.revision} />
                  <label className="label">
                    <input
                      type="checkbox"
                      name="confirmed"
                      value="yes"
                      required
                    />
                    Create “{p.details.title}” and prepare speaker portal
                    invitations for the listed speakers. Participation
                    confirmation and programme publication remain separate.
                  </label>
                  <Button type="submit" disabled={busy} variant="primary">
                    Accept session and invite speakers
                  </Button>
                </Form>
              )}
            </article>
          ))}
        </section>
      )}
    </>
  );
}
