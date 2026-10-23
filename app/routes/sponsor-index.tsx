import { Form, Link } from "react-router";
import { BrandMark } from "~/components/brand-mark";
import { Button, ButtonLink } from "~/components/ui/button";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import { SponsorService } from "~/modules/sponsors/sponsor-service.server";
import { requireAuthenticatedPerson } from "~/platform/auth/authorize.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/sponsor-index";
import "~/styles/sponsor-portal.css";

export const meta = () => [{ title: "Sponsor portal · Program Cue" }];
export const headers = () => ({ "cache-control": "private, no-store" });
export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  await ensureDemoSpeakerData(env);
  const person = await requireAuthenticatedPerson(request, env);
  return {
    email: person.email,
    sponsors: await new SponsorService(env).listPortal(person),
  };
}
export default function SponsorIndex({ loaderData: d }: Route.ComponentProps) {
  return (
    <main id="main" className="sponsor-portal stack" tabIndex={-1}>
      <div className="page-head">
        <BrandMark />
        <h1>Sponsor portal</h1>
        <ButtonLink to="/">My workspaces</ButtonLink>
      </div>
      <p>Signed in as {d.email}</p>
      {d.sponsors.length ? (
        <ul className="stack">
          {d.sponsors.map((s) => (
            <li className="card pad" key={s.id}>
              <Link to={`/sponsor/${s.eventId}/${s.id}`}>
                {s.name} · {s.eventName}
              </Link>
              {s.acceptedAt ? null : <p>Invitation awaiting your acceptance</p>}
            </li>
          ))}
        </ul>
      ) : (
        <p>
          No sponsor invitations for this address. Ask the organiser to invite
          the email address you use to sign in.
        </p>
      )}
      <Form method="post" action="/sign-out">
        <input type="hidden" name="returnTo" value="/sponsor" />
        <Button type="submit">Sign out</Button>
      </Form>
    </main>
  );
}
