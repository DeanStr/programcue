import { createAuth } from "~/platform/auth/auth.server";
import {
  consumeMicrosoftCallbackRelay,
  isMicrosoftFormPostCallback,
  MICROSOFT_AUTH_CALLBACK_PATH,
  MicrosoftCallbackRelayConfigurationError,
  MicrosoftCallbackRelayError,
  stageMicrosoftFormPostCallback,
} from "~/platform/auth/microsoft-auth-callback.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/auth-api";

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

function microsoftCallbackFailure(error: unknown) {
  const configurationFailure =
    error instanceof MicrosoftCallbackRelayConfigurationError;
  return new Response(
    configurationFailure
      ? "Microsoft sign-in callback security is unavailable."
      : "The Microsoft sign-in response is invalid or expired. Start again.",
    {
      status: configurationFailure ? 503 : 400,
      headers: {
        "cache-control": "no-store",
        "content-type": "text/plain; charset=utf-8",
        "referrer-policy": "no-referrer",
      },
    },
  );
}

function isExactMicrosoftCallback(request: Request) {
  return new URL(request.url).pathname === MICROSOFT_AUTH_CALLBACK_PATH;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  if (String(env.DEMO_MODE) === "true") return handle(request, context);
  try {
    const internalCallback = await consumeMicrosoftCallbackRelay(env, request);
    if (internalCallback) return handle(internalCallback, context);
    if (isExactMicrosoftCallback(request)) {
      throw new MicrosoftCallbackRelayError();
    }
    return handle(request, context);
  } catch (error) {
    if (
      error instanceof MicrosoftCallbackRelayError ||
      error instanceof MicrosoftCallbackRelayConfigurationError
    ) {
      return microsoftCallbackFailure(error);
    }
    throw error;
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  if (String(env.DEMO_MODE) === "true") return handle(request, context);
  if (isMicrosoftFormPostCallback(request)) {
    try {
      return await stageMicrosoftFormPostCallback(env, request);
    } catch (error) {
      if (
        error instanceof MicrosoftCallbackRelayError ||
        error instanceof MicrosoftCallbackRelayConfigurationError
      ) {
        return microsoftCallbackFailure(error);
      }
      throw error;
    }
  }
  if (isProtectedSignInMutation(request)) {
    return new Response(
      "Start authentication from the protected sign-in form.",
      { status: 404 },
    );
  }
  return handle(request, context);
}
