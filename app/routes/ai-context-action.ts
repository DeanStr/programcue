import {
  data,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import { ZodError } from "zod";

import {
  AiAssistantService,
  AiContextTooLargeError,
  AiPermissionError,
  AiProposalStateError,
} from "~/modules/ai/ai-assistant-service.server";
import { AiToolValidationError } from "~/modules/ai/ai-tools.server";
import {
  AiConfigurationError,
  AiProviderError,
} from "~/modules/ai/openai-responses-provider.server";
import { CommunicationStateError } from "~/modules/communications/communication-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

const headers = { "cache-control": "no-store" };

export function loader(_args: LoaderFunctionArgs) {
  throw new Response("Contextual AI actions require POST.", {
    status: 405,
    headers: { ...headers, allow: "POST" },
  });
}

export default function ContextualAiActionRoute() {
  return null;
}

function failure(error: unknown) {
  let status: number | null = null;
  if (error instanceof AiConfigurationError) status = 503;
  if (error instanceof AiProviderError) status = 502;
  if (error instanceof AiPermissionError) status = 403;
  if (
    error instanceof AiContextTooLargeError ||
    error instanceof AiProposalStateError ||
    error instanceof CommunicationStateError
  )
    status = 409;
  if (error instanceof AiToolValidationError || error instanceof ZodError)
    status = 422;
  if (status === null) return null;
  return data(
    {
      ok: false,
      error:
        error instanceof ZodError
          ? (error.issues[0]?.message ?? "Review the contextual AI request.")
          : error instanceof Error
            ? error.message
            : "The contextual AI action failed.",
    },
    { status, headers },
  );
}

export async function action({ request, context }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return data(
      { ok: false, error: "Contextual AI actions require POST." },
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
  const kind = String(form.get("kind") ?? "");
  const service = new AiAssistantService(env);
  try {
    if (kind === "reminder_send_preview") {
      const prepared = await service.draftReminderProposal(
        viewer,
        form.get("cohort"),
        form.get("objective"),
        form.get("baseTemplateVersionId"),
        form.get("deliveryKind"),
      );
      return data(
        { ok: true, result: prepared.result, proposal: prepared.proposal },
        { headers },
      );
    }
    const result =
      kind === "review_aid"
        ? await service.generateReviewAid(
            viewer,
            form.get("assignmentId"),
            form.get("focus") || null,
          )
        : kind === "readiness_summary"
          ? await service.summarizeReadiness(viewer, form.get("focus") || null)
          : kind === "schedule_conflict_explanation"
            ? await service.explainScheduleConflict(
                viewer,
                form.get("conflictId"),
              )
            : kind === "reminder_draft"
              ? await service.draftReminder(
                  viewer,
                  form.get("cohort"),
                  form.get("objective"),
                )
              : kind === "session_copy"
                ? await service.generateSessionCopy(
                    viewer,
                    form.get("sessionId"),
                  )
                : null;
    if (!result) {
      return data(
        { ok: false, error: "Unsupported contextual AI action." },
        { status: 400, headers },
      );
    }
    return data({ ok: true, result, proposal: null }, { headers });
  } catch (error) {
    const response = failure(error);
    if (response) return response;
    if (error instanceof Response) throw error;
    throw error;
  }
}
