import type { ActionFunctionArgs } from "react-router";

import { getProgramCueEventAgent } from "~/modules/ai/program-cue-agent-client.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { rejectCrossOriginBrowserMutation } from "~/platform/http/mutation-origin.server";

const privateNoStoreHeaders = { "cache-control": "private, no-store" };

export function loader() {
  return new Response("Assistant streaming requires POST.", {
    status: 405,
    headers: { ...privateNoStoreHeaders, allow: "POST" },
  });
}

export async function action({ request, context }: ActionFunctionArgs) {
  if (request.method !== "POST") return loader();
  const rejectedOrigin = rejectCrossOriginBrowserMutation(request);
  if (rejectedOrigin) return rejectedOrigin;

  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  const form = await request.formData();
  if (form.get("intent") !== "ask") {
    return Response.json(
      { message: "Unsupported assistant streaming action." },
      { status: 400, headers: privateNoStoreHeaders },
    );
  }

  const agent = await getProgramCueEventAgent(env, viewer);
  const stream = await agent.streamAsk(viewer, form.get("prompt"));
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "private, no-cache, no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}
