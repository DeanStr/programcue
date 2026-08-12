import type { Route } from "./+types/api-resend-webhook";
import { ZodError } from "zod";
import { CommunicationService } from "~/modules/communications/communication-service.server";
import {
  verifyResendWebhook,
  WebhookConfigurationError,
  WebhookVerificationError,
} from "~/modules/communications/resend-webhook.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  readBoundedText,
  RequestBodyTooLargeError,
} from "~/platform/http/read-body";

function logWebhookConfigurationFailure(error: unknown) {
  console.error(
    JSON.stringify({
      level: "error",
      subsystem: "resend-webhook",
      event: "configuration-unavailable",
      errorName: error instanceof Error ? error.name : "UnknownError",
      message: "The Resend webhook configuration is unavailable.",
    }),
  );
}

function methodNotAllowed() {
  return new Response("Method not allowed", {
    status: 405,
    headers: { allow: "POST" },
  });
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") return methodNotAllowed();
  const { env } = getCloudflareContext(context);
  let raw: string;
  try {
    raw = await readBoundedText(request, 256_000);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json(
        { error: "Webhook payload exceeds 256 KB." },
        { status: 413 },
      );
    }
    throw error;
  }
  const webhookId = request.headers.get("svix-id");
  try {
    await verifyResendWebhook({
      body: raw,
      webhookId,
      timestamp: request.headers.get("svix-timestamp"),
      signature: request.headers.get("svix-signature"),
      secret: env.RESEND_WEBHOOK_SECRET,
    });
  } catch (error) {
    if (error instanceof WebhookConfigurationError) {
      logWebhookConfigurationFailure(error);
      return Response.json(
        { error: "Resend webhook configuration is unavailable." },
        { status: 503, headers: { "retry-after": "30" } },
      );
    }
    if (error instanceof WebhookVerificationError) {
      return Response.json(
        { error: "Webhook authentication failed." },
        { status: 401 },
      );
    }
    throw error;
  }
  const mediaType =
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() ?? "";
  if (mediaType !== "application/json") {
    return Response.json(
      { error: "Resend webhook Content-Type must be application/json." },
      { status: 415 },
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return Response.json(
      { error: "Webhook body is not valid JSON." },
      { status: 400 },
    );
  }
  let result;
  try {
    result = await new CommunicationService(env).reconcileResendEvent(
      payload,
      raw,
      webhookId!,
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json(
        { error: "Webhook payload does not match a supported Resend event." },
        { status: 400 },
      );
    }
    throw error;
  }
  if (!result.matched) {
    if (!result.retryable) {
      return Response.json({ matched: false, duplicate: false, ignored: true });
    }
    return Response.json(
      {
        error:
          "The delivery is not available for reconciliation yet; retry this webhook.",
      },
      { status: 503, headers: { "retry-after": "30" } },
    );
  }
  return Response.json(result);
}

export function loader() {
  throw methodNotAllowed();
}
