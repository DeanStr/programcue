import { Outlet } from "react-router";

import type { Route } from "./+types/speaker-layout";
import { SpeakerShell } from "~/components/speaker-shell";
import { SpeakerService } from "~/modules/speakers/speaker-service.server";
import {
  formatSpeakerEvent,
  requireSpeakerWorkspace,
} from "~/modules/speakers/speaker-workspace.server";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, viewer } = await requireSpeakerWorkspace(request, context);
  const portal = await new SpeakerService(env).getPortal(viewer);
  return {
    portal,
    event: {
      name: portal.event.name,
      brandAccent: portal.event.brandAccent,
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
    <SpeakerShell event={loaderData.event} viewer={viewer}>
      <Outlet context={{ portal, viewer }} />
    </SpeakerShell>
  );
}
