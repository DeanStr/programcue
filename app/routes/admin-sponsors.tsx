import { data, Form, Link, redirect, useNavigation } from "react-router";
import { z } from "zod";
import { SponsorProfileFields } from "~/components/sponsor-fields";
import { Button, ButtonLink } from "~/components/ui/button";
import { EventDateTime } from "~/components/ui/event-date-time";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import {
  requireSponsorConfirmation,
  sponsorFormError,
  sponsorKey,
  sponsorProfileInput,
  sponsorRevision,
} from "~/modules/sponsors/sponsor-forms.server";
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
  return {
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
