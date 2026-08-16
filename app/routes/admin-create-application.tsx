import { data, Link, redirect, useActionData } from "react-router";
import { SubmissionService } from "~/modules/submissions/submission-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/admin-create-application";
import {
  adminCreationFailure,
  adminCreationSpeakers,
  duplicateCreationWarning,
  manualApplicationWebhookWarning,
} from "./admin-record-creation.server";
import { ActionNotice, AdminCreationForm } from "./submissions-admin-panels";
import type { SubmissionsAdminActionResult } from "./submissions-admin-types";

export const meta: Route.MetaFunction = () => [
  { title: "Create application record · Program Cue" },
];

async function viewerFor(
  request: Request,
  context: Route.LoaderArgs["context"],
) {
  const { env } = getCloudflareContext(context);
  return {
    env,
    viewer: await requireCurrentEventRole(request, env, [
      "owner",
      "administrator",
    ]),
  };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, viewer } = await viewerFor(request, context);
  const service = new SubmissionService(env);
  const [routingTeams, routingTracks, sessionFormats] = await Promise.all([
    service.listRoutingTeams(viewer),
    service.listRoutingTracks(viewer),
    service.getConfiguredSessionFormats(viewer),
  ]);
  return {
    routingTeams,
    routingTracks,
    sessionFormats,
    idempotencyKey: crypto.randomUUID(),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    throw new Response("Method not allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }
  const { env, viewer } = await viewerFor(request, context);
  const formData = await request.formData();
  if (formData.get("_intent") !== "create_manual_application") {
    throw new Response("Unsupported application-record action", {
      status: 400,
    });
  }
  try {
    const speakers = adminCreationSpeakers(formData);
    const duplicateWarning = await duplicateCreationWarning(
      env,
      viewer,
      formData,
      [
        {
          name: formData.get("submitterName"),
          email: formData.get("submitterEmail"),
        },
        ...speakers,
      ],
      "create_manual_application",
    );
    if (duplicateWarning) {
      return data<SubmissionsAdminActionResult>(duplicateWarning, {
        status: 409,
      });
    }
    const routedTeamIds = formData.getAll("routedTeamIds").map(String);
    const submissionId = await new SubmissionService(
      env,
    ).createManualApplication(viewer, {
      idempotencyKey: formData.get("idempotencyKey"),
      title: formData.get("title"),
      description: formData.get("description"),
      trackIds: formData.getAll("trackIds").map(String),
      format: formData.get("format"),
      submitterName: formData.get("submitterName"),
      submitterEmail: formData.get("submitterEmail"),
      routedTeamIds,
      speakers,
    });
    const webhookWarning = await manualApplicationWebhookWarning(
      env,
      viewer,
      submissionId,
      routedTeamIds,
    );
    const search = new URLSearchParams({ created: "1" });
    if (webhookWarning) search.set("attention", "1");
    return redirect(
      `/admin/submissions/${encodeURIComponent(submissionId)}?${search}`,
      303,
    );
  } catch (error) {
    if (error instanceof Response) throw error;
    const failure = adminCreationFailure(error);
    if (failure) {
      return data<SubmissionsAdminActionResult>(failure.result, {
        status: failure.status,
      });
    }
    throw error;
  }
}

export default function AdminCreateApplication({
  loaderData,
}: Route.ComponentProps) {
  const actionData = useActionData<typeof action>() as
    | SubmissionsAdminActionResult
    | undefined;
  return (
    <>
      <div className="page-head">
        <div>
          <Link className="subtle" to="/admin/submissions">
            ← Back to applications
          </Link>
          <h1>Create application record</h1>
          <p>
            Preserve an application for participants who have already accepted
            their event invitations.
          </p>
        </div>
      </div>
      <ActionNotice result={actionData} />
      <AdminCreationForm
        kind="application"
        routingTeams={loaderData.routingTeams}
        routingTracks={loaderData.routingTracks}
        sessionFormats={loaderData.sessionFormats}
        idempotencyKey={loaderData.idempotencyKey}
        actionResult={actionData}
      />
    </>
  );
}
