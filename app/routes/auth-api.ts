import type { Route } from "./+types/auth-api";
import { createAuth } from "~/platform/auth/auth.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

function handle(request: Request, context: Route.LoaderArgs["context"]) {
  const { env } = getCloudflareContext(context);
  if (String(env.DEMO_MODE) === "true") {
    return new Response(
      "Authentication API is disabled in evaluator demo mode",
      { status: 404 },
    );
  }
  return createAuth(env).handler(request);
}

function isProtectedSignInMutation(request: Request) {
  const rawPathname = new URL(request.url).pathname;
  let pathname: string;
  try {
    pathname = decodeURIComponent(rawPathname);
  } catch {
    return true;
  }
  pathname = pathname.replace(/\/{2,}/gu, "/").replace(/\/+$/u, "");
  return (
    pathname === "/api/auth/sign-in" ||
    pathname.startsWith("/api/auth/sign-in/") ||
    pathname === "/api/auth/sign-up" ||
    pathname.startsWith("/api/auth/sign-up/") ||
    pathname === "/api/auth/link-social"
  );
}

export function loader({ request, context }: Route.LoaderArgs) {
  return handle(request, context);
}

export function action({ request, context }: Route.ActionArgs) {
  if (isProtectedSignInMutation(request)) {
    return new Response(
      "Start authentication from the protected sign-in form.",
      { status: 404 },
    );
  }
  return handle(request, context);
}
