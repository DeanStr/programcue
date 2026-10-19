import { data, Form, useNavigation } from "react-router";
import { SponsorAssets } from "~/components/sponsor-assets";
import {
  SponsorProfileFields,
  SponsorSessionFields,
} from "~/components/sponsor-fields";
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
  sponsorSessionInput,
} from "~/modules/sponsors/sponsor-forms.server";
import { SponsorService } from "~/modules/sponsors/sponsor-service.server";
import { requireAuthenticatedPerson } from "~/platform/auth/authorize.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";
import type { Route } from "./+types/sponsor-portal";
import "~/styles/sponsor-portal.css";

export const meta = () => [{ title: "Company workspace · Program Cue" }];
export const headers = () => ({ "cache-control": "private, no-store" });
async function access(request: Request, context: Route.LoaderArgs["context"]) {
  const { env } = getCloudflareContext(context);
  await ensureDemoSpeakerData(env);
  const person = await requireAuthenticatedPerson(request, env);
  return { env, person, service: new SponsorService(env) };
}
export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env, person, service } = await access(request, context);
  const workspace = await service.portalWorkspace(
    person,
    params.eventId,
    params.sponsorId,
  );
  const assets = new SponsorAssetService(env);
  return {
    ...workspace,
    eventId: params.eventId,
    assets: workspace.ownContact.acceptedAt
      ? await assets.portalAssets(person, params.eventId, params.sponsorId)
      : [],
    filePolicy: await assets.filePolicy(params.eventId),
    key: crypto.randomUUID(),
    now: Math.floor(Date.now() / 1000),
  };
}
export async function action({ request, context, params }: Route.ActionArgs) {
  if (request.method !== "POST")
    throw new Response("Method not allowed", { status: 405 });
  const { env, person, service } = await access(request, context);
  const form = await request.formData();
  try {
    const key = sponsorKey(form);
    const { eventId, sponsorId } = params;
    const intent = form.get("intent");
    if (intent === "accept") {
      requireSponsorConfirmation(form);
      await service.accept(person, eventId, sponsorId, key);
    } else if (intent === "profile")
      await service.saveProfile(
        person,
        eventId,
        sponsorId,
        sponsorProfileInput(form),
        sponsorRevision(form),
        key,
      );
    else if (intent === "save-session") {
      const id = String(form.get("proposalId") ?? "");
      await service.saveProposal(
        person,
        eventId,
        sponsorId,
        sponsorSessionInput(form),
        key,
        id ? { id, revision: sponsorRevision(form) } : undefined,
      );
    } else if (intent === "submitted" || intent === "withdrawn") {
      requireSponsorConfirmation(form);
      await service.changeProposal(
        person,
        eventId,
        sponsorId,
        String(form.get("proposalId")),
        sponsorRevision(form),
        intent,
        key,
      );
    } else
      return data(
        { ok: false, message: "Unsupported sponsor action." },
        { status: 400 },
      );
    const workspace = await service.portalWorkspace(person, eventId, sponsorId);
    const event = await env.DB.prepare(
      "SELECT organisation_id AS organisationId FROM events WHERE id=?",
    )
      .bind(eventId)
      .first<{ organisationId: string }>();
    if (!event) throw new Error("Sponsor event disappeared after saving.");
    const warning = await recordRouteChange(
      env,
      { ...event, eventId },
      { entityType: "sponsorship", entityId: sponsorId, changeType: "updated" },
    );
    return data(
      warning ?? {
        ok: true,
        message:
          intent === "accept"
            ? `Sponsor invitation accepted for ${workspace.sponsor.name}.`
            : intent === "submitted"
              ? "Session submitted for organiser review."
              : intent === "withdrawn"
                ? "Session withdrawn. Its allowance is available again."
                : "Changes saved.",
      },
      { status: warning ? 207 : 200 },
    );
  } catch (error) {
    const message = sponsorFormError(error);
    if (message) return data({ ok: false, message }, { status: 422 });
    throw error;
  }
}
export default function SponsorPortal({
  loaderData: d,
  actionData,
}: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const closed = d.sponsor.closesAt !== null && d.sponsor.closesAt <= d.now;
  const hidden = (intent: string) => (
    <>
      <input type="hidden" name="intent" value={intent} />
      <input type="hidden" name="key" value={d.key} />
    </>
  );
  return (
    <main id="main" className="sponsor-portal stack" tabIndex={-1}>
      <div className="page-head pc-page-header">
        <div>
          <p>{d.event.name} · Sponsor portal</p>
          <h1>{d.sponsor.name}</h1>
        </div>
        <ButtonLink to="/sponsor">All sponsor invitations</ButtonLink>
      </div>
      {actionData && (
        <p role={actionData.ok ? "status" : "alert"}>{actionData.message}</p>
      )}
      {!d.ownContact.acceptedAt ? (
        <section className="card pad">
          <h2>Accept sponsor invitation</h2>
          <p>
            {d.ownContact.email} has been invited to manage this company’s
            profile and session proposals. Other company contacts can see and
            edit the same information.
          </p>
          <Form method="post">
            {hidden("accept")}
            <label className="label">
              <input type="checkbox" name="confirmed" value="yes" required />I
              accept sponsor access for {d.sponsor.name}.
            </label>
            <Button type="submit" disabled={busy}>
              Accept invitation
            </Button>
          </Form>
        </section>
      ) : (
        <>
          <section className="card pad">
            <h2>Session allowance</h2>
            <p>
              {d.sponsor.sessionsUsed} of {d.sponsor.sessionLimit} sessions used
              {d.sponsor.tier ? ` · ${d.sponsor.tier}` : ""}. Drafts, submitted
              proposals and accepted sessions count toward this limit.
            </p>
            <p>
              {d.sponsor.closesAt ? (
                <>
                  <strong>
                    {closed ? "Editing closed" : "Editing closes"}:{" "}
                  </strong>
                  <EventDateTime
                    epochSeconds={d.sponsor.closesAt}
                    timeZone={d.event.timezone}
                    showTimeZone
                  />
                </>
              ) : (
                "No editing deadline set."
              )}
            </p>
            <p>
              Submitting a proposal requests organiser review. Accepted sessions
              move to the speaker and organiser workspaces; programme
              publication is separate.
            </p>
          </section>
          <details className="card pad">
            <summary>Company profile and team</summary>
            <Form key={d.sponsor.revision} method="post" className="stack mt">
              {hidden("profile")}
              <input type="hidden" name="revision" value={d.sponsor.revision} />
              <SponsorProfileFields value={d.sponsor} />
              <Button type="submit" disabled={busy || closed}>
                Save company profile
              </Button>
            </Form>
            <h3>Company contacts</h3>
            <ul>
              {d.contacts.map((c) => (
                <li key={c.id}>
                  {c.name} · {c.email}
                </li>
              ))}
            </ul>
            <p>Ask the organiser to add or remove contacts.</p>
          </details>
          <SponsorAssets
            assets={d.assets}
            eventId={d.eventId}
            sponsorId={d.sponsor.id}
            companyProfile={d.sponsor}
            commandKey={d.key}
            closed={closed}
            busy={busy}
            filePolicy={d.filePolicy}
          />
          <section className="stack" aria-label="Your sponsored sessions">
            <h2>Your sessions</h2>
            {!d.proposals.length && (
              <p>No sessions yet. Add your first proposal below.</p>
            )}
            {d.proposals.map((p) => (
              <article className="card pad" key={p.id}>
                <h3>{p.details.title}</h3>
                <p>Status: {p.status}</p>
                <p>{p.details.description}</p>
                <ul>
                  {p.details.speakers.map((s) => (
                    <li key={s.email}>
                      {s.name} · {s.email}
                    </li>
                  ))}
                </ul>
                {p.status === "accepted" && (
                  <p>
                    Accepted by the organiser. Each speaker should use their
                    speaker portal to confirm participation and manage their
                    details. Contact the organiser for session changes.
                  </p>
                )}
                {!closed &&
                  (p.status === "draft" || p.status === "submitted") && (
                    <>
                      <details>
                        <summary>Edit session</summary>
                        <Form
                          key={p.revision}
                          method="post"
                          className="stack mt"
                        >
                          {hidden("save-session")}
                          <input type="hidden" name="proposalId" value={p.id} />
                          <input
                            type="hidden"
                            name="revision"
                            value={p.revision}
                          />
                          <SponsorSessionFields
                            value={p.details}
                            tracks={d.tracks}
                            formats={d.formats}
                          />
                          <Button type="submit" disabled={busy}>
                            Save session changes
                          </Button>
                        </Form>
                      </details>
                      {p.status === "draft" && (
                        <Form method="post" className="mt">
                          {hidden("submitted")}
                          <input type="hidden" name="proposalId" value={p.id} />
                          <input
                            type="hidden"
                            name="revision"
                            value={p.revision}
                          />
                          <label className="label">
                            <input
                              type="checkbox"
                              name="confirmed"
                              value="yes"
                              required
                            />
                            Submit “{p.details.title}” and the listed speaker
                            details to the organiser.
                          </label>
                          <Button
                            type="submit"
                            disabled={busy}
                            variant="primary"
                          >
                            Submit for review
                          </Button>
                        </Form>
                      )}
                      <details className="mt">
                        <summary>Withdraw proposal</summary>
                        <Form method="post">
                          {hidden("withdrawn")}
                          <input type="hidden" name="proposalId" value={p.id} />
                          <input
                            type="hidden"
                            name="revision"
                            value={p.revision}
                          />
                          <label className="label">
                            <input
                              type="checkbox"
                              name="confirmed"
                              value="yes"
                              required
                            />
                            Withdraw “{p.details.title}” and release its
                            allowance. This proposal will be kept as a record.
                          </label>
                          <Button type="submit" disabled={busy}>
                            Withdraw session
                          </Button>
                        </Form>
                      </details>
                    </>
                  )}
              </article>
            ))}
          </section>
          {!closed && d.sponsor.sessionsUsed < d.sponsor.sessionLimit && (
            <section className="card pad">
              <h2>Add sponsored session</h2>
              <Form
                key={d.sponsor.sessionsUsed}
                method="post"
                className="stack"
              >
                {hidden("save-session")}
                <SponsorSessionFields tracks={d.tracks} formats={d.formats} />
                <p>
                  Saving reserves one allowance slot. Submit the saved proposal
                  when it is ready for review.
                </p>
                <Button
                  type="submit"
                  disabled={busy || !d.tracks.length}
                  variant="primary"
                >
                  Save session draft
                </Button>
              </Form>
            </section>
          )}
          {!closed && d.sponsor.sessionsUsed >= d.sponsor.sessionLimit && (
            <p>
              Your session allowance is full. Withdraw a draft or submitted
              proposal, or ask the organiser to increase the allowance.
            </p>
          )}
        </>
      )}
    </main>
  );
}
