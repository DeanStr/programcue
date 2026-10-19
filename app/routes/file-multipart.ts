import {
  handleMultipart,
  multipartMethodNotAllowed,
} from "~/modules/files/multipart-request.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/file-multipart";

export async function action({ request, params, context }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  return handleMultipart(request, env, params.operation, () =>
    requireCurrentEventRole(
      request,
      env,
      [
        "owner",
        "administrator",
        "committee_chair",
        "evaluator",
        "submitter",
        "speaker",
      ],
      "response",
    ),
  );
}

export function loader() {
  return multipartMethodNotAllowed();
}
