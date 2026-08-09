import type { Route } from "./+types/event-changes";
import { requireEventRole } from "~/platform/auth/authorize.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { EventRealtimeService } from "~/platform/realtime/event-realtime.server";

function cursorValue(url: URL) {
  const raw = url.searchParams.get("cursor") ?? "0";
  const cursor = Number(raw);
  if (!Number.isSafeInteger(cursor) || cursor < 0) throw new Response("cursor must be a non-negative integer", { status: 422 });
  return cursor;
}

function limitValue(url: URL) {
  const raw = url.searchParams.get("limit") ?? "100";
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Response("limit must be between 1 and 100", { status: 422 });
  return limit;
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  if (!params.eventId) throw new Response("Event not found", { status: 404 });
  const viewer = await requireEventRole(
    request,
    env,
    params.eventId,
    ["owner", "administrator"],
    "response",
  );
  const service = new EventRealtimeService(env);
  if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
    return service.connect(viewer, request);
  }
  const url = new URL(request.url);
  const page = await service.getChangesSince(viewer, cursorValue(url), limitValue(url));
  return Response.json(page, { headers: { "cache-control": "no-store" } });
}
