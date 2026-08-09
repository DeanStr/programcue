import { redirect } from "react-router";
import { z } from "zod";

import type { Route } from "./+types/demo-role";
import { getCloudflareContext } from "~/platform/cloudflare-context";

const selectionSchema = z.enum(["administrator", "evaluator", "submitter", "speaker"]);
const destinations: Record<z.infer<typeof selectionSchema>, string> = {
  administrator: "/admin/command",
  evaluator: "/review/workbench",
  submitter: "/apply/form",
  speaker: "/speaker/dashboard",
};

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  if (String(env.DEMO_MODE) !== "true") throw new Response("Demo role switching is disabled", { status: 404 });
  const role = selectionSchema.parse((await request.formData()).get("role"));
  return redirect(destinations[role], {
    headers: {
      "set-cookie": `program_cue_demo_role=${role}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
    },
  });
}
