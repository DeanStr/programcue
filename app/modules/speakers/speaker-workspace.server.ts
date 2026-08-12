import type { RouterContextProvider } from "react-router";

import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import { requireEventRole } from "~/platform/auth/authorize.server";
import { resolveCurrentEventId } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

export async function requireSpeakerWorkspace(
  request: Request,
  context: Readonly<RouterContextProvider>,
) {
  const { env } = getCloudflareContext(context);
  await ensureDemoSpeakerData(env);
  const eventId = await resolveCurrentEventId(request, env, [
    "speaker",
    "submitter",
  ]);
  const viewer = await requireEventRole(request, env, eventId, [
    "speaker",
    "submitter",
  ]);
  return { env, viewer };
}

export function formatSpeakerEvent(event: {
  startsAt: number;
  endsAt: number;
  venue: string | null;
  city: string | null;
}) {
  const format = new Intl.DateTimeFormat("en", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
  return {
    dateLabel: `${format.format(new Date(event.startsAt * 1_000))}–${format.format(new Date(event.endsAt * 1_000))}`,
    locationLabel: [event.venue, event.city].filter(Boolean).join(", "),
  };
}
