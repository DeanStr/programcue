import { Outlet } from "react-router";
import { SpeakerShell } from "~/components/speaker-shell";
import { SpeakerService } from "~/modules/speakers/speaker-service.server";
import {
  formatSpeakerEvent,
  requireSpeakerWorkspace,
} from "~/modules/speakers/speaker-workspace.server";
import type { Route } from "./+types/speaker-layout";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, viewer } = await requireSpeakerWorkspace(request, context);
  const service = new SpeakerService(env);
  const [portal, canManageAvailability] = await Promise.all([
    service.getPortal(viewer),
    service.canManageAvailability(viewer),
  ]);
  return {
    portal,
    canManageAvailability,
    event: {
      name: portal.event.name,
      brandAccent: portal.event.brandAccent,
      participantLogoUrl: portal.event.participantLogoUrl,
      participantSupportUrl: portal.event.participantSupportUrl,
      ...formatSpeakerEvent(portal.event),
    },
    viewer: {
      name: viewer.name,
      email: viewer.email,
      demo: viewer.demo,
    },
  };
}

export default function SpeakerLayout({ loaderData }: Route.ComponentProps) {
  const { portal, viewer } = loaderData;
  return (
    <SpeakerShell
      event={loaderData.event}
      viewer={viewer}
      canManageAvailability={loaderData.canManageAvailability}
    >
      <Outlet context={{ portal, viewer }} />
    </SpeakerShell>
  );
}
