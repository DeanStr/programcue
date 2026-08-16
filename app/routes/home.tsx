import { Form, redirect } from "react-router";
import { BrandMark } from "~/components/brand-mark";
import type { ViewerRole } from "~/platform/auth/authorize.server";
import {
  chooseInitialEvent,
  clearCurrentEventCookie,
  currentEventCookie,
  listAuthorisedEvents,
  selectedEventId,
} from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/home";

const landingPage: Record<ViewerRole, string> = {
  owner: "/admin/event",
  administrator: "/admin/event",
  committee_chair: "/admin/review",
  evaluator: "/review/workbench",
  speaker: "/participant/dashboard",
  submitter: "/participant/dashboard",
};

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const events = await listAuthorisedEvents(request, env);
  if (events.length === 0) return { hasWorkspaceAccess: false as const };
  const selected = selectedEventId(request, env);
  const eventId = selected ?? chooseInitialEvent(events, env.DEFAULT_EVENT_ID);
  if (!eventId) throw redirect("/events/select?returnTo=%2F");
  const event = events.find((candidate) => candidate.eventId === eventId);
  if (!event) {
    throw redirect("/events/select?returnTo=%2F", {
      headers: {
        "set-cookie": clearCurrentEventCookie(env),
        "cache-control": "private, no-store",
      },
    });
  }
  if (event.invitationPending) throw redirect("/events/select?returnTo=%2F");
  return redirect(landingPage[event.role], {
    headers: selected
      ? undefined
      : {
          "set-cookie": currentEventCookie(event.eventId, env),
          "cache-control": "private, no-store",
        },
  });
}

export const headers: Route.HeadersFunction = () => ({
  "cache-control": "private, no-store",
});

export default function Home({ loaderData }: Route.ComponentProps) {
  if (loaderData.hasWorkspaceAccess) return null;
  return (
    <main
      className="design-board"
      id="main"
      style={{ minHeight: "100vh", display: "grid", placeItems: "center" }}
    >
      <section
        className="card pad"
        style={{ width: "min(520px, calc(100vw - 32px))" }}
      >
        <div className="brand" style={{ color: "var(--ink)", padding: 0 }}>
          <BrandMark />
          <span>Program Cue</span>
        </div>
        <span className="pc-page-eyebrow">Account ready</span>
        <h1>No workspace access yet</h1>
        <p>
          Your account is signed in, but it has not been granted access to an
          organisation or event.
        </p>
        <p className="subtle">
          Open an event invitation or a published application link to join the
          relevant workspace. Signing up alone never grants private access.
        </p>
        <Form method="post" action="/sign-out">
          <input type="hidden" name="returnTo" value="/" />
          <button className="btn" type="submit">
            Sign out
          </button>
        </Form>
      </section>
    </main>
  );
}
