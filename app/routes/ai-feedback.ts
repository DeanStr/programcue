import {
  type ActionFunctionArgs,
  data,
  type LoaderFunctionArgs,
} from "react-router";
import { ZodError } from "zod";
import {
  AiFeedbackService,
  AiFeedbackTargetError,
} from "~/modules/ai/ai-feedback-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

const headers = { "cache-control": "no-store" };

export function loader(_args: LoaderFunctionArgs) {
  throw new Response("AI feedback requires POST.", {
    status: 405,
    headers: { ...headers, allow: "POST" },
  });
}

export async function action({ request, context }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return data(
      { ok: false, error: "AI feedback requires POST." },
      { status: 405, headers: { ...headers, allow: "POST" } },
    );
  }
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
    "committee_chair",
    "evaluator",
  ]);
  const form = await request.formData();
  try {
    const result = await new AiFeedbackService(env).save(viewer, {
      operationId: form.get("operationId"),
      rating: form.get("rating"),
      reason: form.get("reason") || null,
      detail: form.get("detail") || null,
    });
    return data({ ok: true, ...result }, { headers });
  } catch (error) {
    if (error instanceof ZodError) {
      return data(
        {
          ok: false,
          error: error.issues[0]?.message ?? "Review the feedback fields.",
        },
        { status: 422, headers },
      );
    }
    if (error instanceof AiFeedbackTargetError) {
      return data(
        { ok: false, error: error.message },
        { status: 404, headers },
      );
    }
    throw error;
  }
}

export default function AiFeedbackRoute() {
  return null;
}
