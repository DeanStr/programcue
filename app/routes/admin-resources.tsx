import { data, redirect } from "react-router";
import { ZodError } from "zod";
import { AdminResourcesWorkspace } from "~/components/admin-resources-workspace";
import { ResourceContentError } from "~/modules/resources/resource-content";
import {
  ResourceEmbedConfigurationError,
  ResourceEmbedInputError,
} from "~/modules/resources/resource-embed-policy";
import {
  ResourceAudienceError,
  ResourceRevisionConflictError,
  ResourceService,
  ResourceSlugConflictError,
  ResourceTaskDependencyError,
} from "~/modules/resources/resource-service.server";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";
import "~/styles/workspace-remaining.css";
import type { Route } from "./+types/admin-resources";

export const meta = () => [{ title: "Speaker Resources · Program Cue" }];

class InvalidResourcePayloadError extends Error {}

async function administrator(
  request: Request,
  context: Route.LoaderArgs["context"],
) {
  const { env } = getCloudflareContext(context);
  await ensureDemoSpeakerData(env);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  return { env, viewer };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, viewer } = await administrator(request, context);
  const url = new URL(request.url);
  const workspace = await new ResourceService(env).getAdminWorkspace(
    viewer,
    url.searchParams.get("resource"),
  );
  return {
    ...workspace,
    recoveryScope: { eventId: viewer.eventId, personId: viewer.personId },
    createdFromLocalDraft: url.searchParams.get("created") === "1",
    liveUpdateDelayed: url.searchParams.get("liveUpdateDelayed") === "1",
  };
}

function actionError(error: unknown) {
  if (error instanceof ZodError)
    return error.issues[0]?.message ?? "Review the resource fields.";
  if (
    error instanceof ResourceContentError ||
    error instanceof ResourceEmbedInputError ||
    error instanceof ResourceEmbedConfigurationError ||
    error instanceof ResourceAudienceError ||
    error instanceof ResourceRevisionConflictError ||
    error instanceof ResourceSlugConflictError ||
    error instanceof ResourceTaskDependencyError ||
    error instanceof InvalidResourcePayloadError
  )
    return error.message;
  return null;
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env, viewer } = await administrator(request, context);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  if (intent !== "save" && intent !== "publish") {
    return data(
      { ok: false, message: "Unsupported resource action." },
      { status: 400 },
    );
  }
  const service = new ResourceService(env);
  try {
    if (intent === "publish") {
      const pageId = String(form.get("id") ?? "");
      await service.publish(viewer, pageId, Number(form.get("revision")));
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "resource_page",
        entityId: pageId,
        changeType: "published",
      });
      if (realtimeFailure)
        return data({ ...realtimeFailure, intent }, { status: 207 });
      return data({
        ok: true,
        intent,
        message:
          "Resource version published and acknowledgement tasks synchronised.",
      });
    }
    if (String(form.get("externalEmbedDraft") ?? "").trim()) {
      throw new InvalidResourcePayloadError(
        "Add or clear the unfinished video or map before saving.",
      );
    }
    let rawDocument: unknown;
    try {
      rawDocument = JSON.parse(String(form.get("documentJson") ?? ""));
    } catch {
      throw new InvalidResourcePayloadError(
        "Resource content is invalid. Refresh before trying again.",
      );
    }
    const existingId = String(form.get("id") ?? "");
    const id = await service.save(viewer, {
      id: existingId || undefined,
      revision: String(form.get("revision") ?? "") || undefined,
      title: form.get("title"),
      slug: form.get("slug"),
      category: form.get("category"),
      audienceScope: form.get("audienceScope"),
      audiencePersonIds: form.getAll("audiencePersonIds"),
      acknowledgementRequired: form.get("acknowledgementRequired")
        ? "true"
        : "false",
      document: rawDocument,
    });
    const realtimeFailure = await recordRouteChange(env, viewer, {
      entityType: "resource_page",
      entityId: id,
      changeType: existingId ? "updated" : "created",
    });
    if (realtimeFailure) {
      if (!existingId)
        return redirect(
          `/admin/resources?resource=${encodeURIComponent(id)}&created=1&liveUpdateDelayed=1`,
        );
      return data({ ...realtimeFailure, intent }, { status: 207 });
    }
    if (!existingId)
      return redirect(`/admin/resources?resource=${id}&created=1`);
    return data({
      ok: true,
      intent,
      message: "A new immutable draft version was saved.",
    });
  } catch (error) {
    const message = actionError(error);
    if (message) {
      return data(
        {
          ok: false,
          intent,
          message,
          conflict: error instanceof ResourceRevisionConflictError,
        },
        {
          status:
            error instanceof ResourceRevisionConflictError ||
            error instanceof ResourceSlugConflictError ||
            error instanceof ResourceTaskDependencyError
              ? 409
              : 422,
        },
      );
    }
    if (error instanceof Response) throw error;
    throw error;
  }
}

export { readResourceAttachmentCompletion } from "~/components/admin-resources-workspace";

export default function AdminResources({ loaderData }: Route.ComponentProps) {
  return <AdminResourcesWorkspace loaderData={loaderData} />;
}
