import type { Route } from "./+types/auth-api";
import { createAuth } from "~/platform/auth/auth.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

function handle(request: Request, context: Route.LoaderArgs["context"]) {
  const { env } = getCloudflareContext(context);
  if (String(env.DEMO_MODE) === "true") {
    return new Response("Authentication API is disabled in evaluator demo mode", { status: 404 });
  }
  return createAuth(env).handler(request);
}

export function loader({ request, context }: Route.LoaderArgs) {
  return handle(request, context);
}

export function action({ request, context }: Route.ActionArgs) {
  return handle(request, context);
}
