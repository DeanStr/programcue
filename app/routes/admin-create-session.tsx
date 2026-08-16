import { data, Link, redirect, useActionData } from "react-router";
import { SubmissionService } from "~/modules/submissions/submission-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/admin-create-session";
import {
  adminCreationFailure,
  adminCreationSpeakers,
  duplicateCreationWarning,
} from "./admin-record-creation.server";
import { ActionNotice, AdminCreationForm } from "./submissions-admin-panels";
import type { SubmissionsAdminActionResult } from "./submissions-admin-types";

const creationOrigins = ["schedule", "programme", "global"] as const;
type CreationOrigin = (typeof creationOrigins)[number];

export const meta: Route.MetaFunction = () => [
  { title: "Create direct session · Program Cue" },
];

export function directSessionCreationOrigin(url: URL): CreationOrigin {
  const values = url.searchParams.getAll("from");
  if (
    values.length !== 1 ||
    !creationOrigins.includes(values[0] as CreationOrigin)
  ) {
    throw new Response("Invalid direct-session origin", { status: 400 });
  }
  return values[0] as CreationOrigin;
}

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
  const origin = directSessionCreationOrigin(new URL(request.url));
  const { env, viewer } = await viewerFor(request, context);
  const service = new SubmissionService(env);
  const [routingTracks, sessionFormats] = await Promise.all([
    service.listRoutingTracks(viewer),
    service.getConfiguredSessionFormats(viewer),
  ]);
  return {
    origin,
    routingTracks,
    sessionFormats,
    idempotencyKey: crypto.randomUUID(),
  };
}

export function directSessionSuccessDestination(
  origin: CreationOrigin,
  sessionId: string,
  attention: boolean,
) {
  if (origin === "programme") {
    const search = new URLSearchParams({ createdSession: sessionId });
    if (attention) search.set("attention", "1");
    return `/admin/programme?${search}`;
  }
  const search = new URLSearchParams({ session: sessionId, created: "1" });
  if (attention) search.set("attention", "1");
  return `/admin/schedule?${search}`;
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    throw new Response("Method not allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }
  const origin = directSessionCreationOrigin(new URL(request.url));
  const { env, viewer } = await viewerFor(request, context);
  const formData = await request.formData();
  if (formData.get("_intent") !== "create_direct_session") {
    throw new Response("Unsupported direct-session action", { status: 400 });
  }
  try {
    const speakers = adminCreationSpeakers(formData);
    const duplicateWarning = await duplicateCreationWarning(
      env,
      viewer,
      formData,
      speakers,
      "create_direct_session",
    );
    if (duplicateWarning) {
      return data<SubmissionsAdminActionResult>(duplicateWarning, {
        status: 409,
      });
    }
    const created = await new SubmissionService(env).createDirectSession(
      viewer,
      {
        idempotencyKey: formData.get("idempotencyKey"),
        title: formData.get("title"),
        description: formData.get("description"),
        trackId: formData.get("trackId"),
        format: formData.get("format"),
        durationMinutes: formData.get("durationMinutes"),
        speakers,
      },
    );
    return redirect(
      directSessionSuccessDestination(
        origin,
        created.sessionId,
        Boolean(created.invitationWarning || created.webhookWarning),
      ),
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

export default function AdminCreateSession({
  loaderData,
}: Route.ComponentProps) {
  const actionData = useActionData<typeof action>() as
    | SubmissionsAdminActionResult
    | undefined;
  const backHref =
    loaderData.origin === "programme" ? "/admin/programme" : "/admin/schedule";
  return (
    <>
      <div className="page-head">
        <div>
          <Link className="subtle" to={backHref}>
            ← Back to{" "}
            {loaderData.origin === "programme"
              ? "publish and embed"
              : "schedule"}
          </Link>
          <h1>Create direct session</h1>
          <p>
            Add an invited, sponsored or guaranteed session directly to the
            unscheduled programme.
          </p>
        </div>
      </div>
      <ActionNotice result={actionData} />
      <AdminCreationForm
        kind="session"
        routingTracks={loaderData.routingTracks}
        sessionFormats={loaderData.sessionFormats}
        idempotencyKey={loaderData.idempotencyKey}
        actionResult={actionData}
      />
    </>
  );
}
