import { type LoaderFunctionArgs, redirect } from "react-router";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
    "committee_chair",
  ]);
  throw redirect(
    viewer.role === "committee_chair" ? "/admin/review" : "/admin/command",
  );
}
