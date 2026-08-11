import { redirect } from "react-router";
import { z } from "zod";

import type { Route } from "./+types/demo-role";
import { currentEventCookie } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { DEMO_EVENT_ID } from "~/platform/demo/demo-identities";

const selectionSchema = z.enum([
  "owner",
  "administrator",
  "evaluator",
  "submitter",
  "speaker",
]);
const destinations: Record<z.infer<typeof selectionSchema>, string> = {
  owner: "/admin/files/retention",
  administrator: "/admin/command",
  evaluator: "/review/workbench",
  submitter: "/apply/form",
  speaker: "/speaker/dashboard",
};

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    throw new Response("Method not allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }
  const { env } = getCloudflareContext(context);
  if (
    String(env.DEMO_MODE) !== "true" ||
    env.APP_ENV === "production" ||
    env.DEFAULT_EVENT_ID !== DEMO_EVENT_ID
  ) {
    throw new Response("Demo role switching is disabled", { status: 404 });
  }
  const role = selectionSchema.safeParse((await request.formData()).get("role"));
  if (!role.success) {
    throw new Response("Demo role is invalid", { status: 400 });
  }
  const headers = new Headers();
  headers.append(
    "set-cookie",
    `program_cue_demo_role=${role.data}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
  );
  // Each demo identity starts from the canonical judged event. This prevents
  // an administrator's cloned-event selection leaking into another identity.
  headers.append("set-cookie", currentEventCookie(DEMO_EVENT_ID, env));
  return redirect(destinations[role.data], { headers });
}
