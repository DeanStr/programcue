import { data } from "react-router";
import { ZodError } from "zod";

import { fieldLabel } from "~/lib/record-labels";
import { PersonDuplicateService } from "~/modules/people/person-duplicate-service.server";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import { SpeakerInvitationDeliveryError } from "~/modules/speakers/speaker-invitation.server";
import {
  SpeakerRosterImportError,
  SpeakerRosterImportService,
} from "~/modules/speakers/speaker-roster-import.server";
import {
  SpeakerAdminStateError,
  SpeakerService,
  type AdminSpeakerFilters,
} from "~/modules/speakers/speaker-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  evaluatorEmailRoutingMessage,
  resolveEvaluatorEmailAlias,
} from "~/platform/evaluation/evaluator-email-alias.server";
import type { Route } from "./+types/admin-speakers";

export const meta = () => [{ title: "Speakers · Program Cue" }];

export type ActionResult = {
  ok: boolean;
  message: string;
  duplicateCheck?: {
    matches: Awaited<
      ReturnType<PersonDuplicateService["findLikelyDuplicates"]>
    >["matches"];
    truncated: boolean;
  };
  importPreview?: Awaited<ReturnType<SpeakerRosterImportService["preview"]>> & {
    idempotencyKey: string;
  };
};

function profileFilter(value: string): AdminSpeakerFilters["profileStatus"] {
  if (
    value === "" ||
    value === "draft" ||
    value === "published" ||
    value === "archived"
  ) {
    return value;
  }
  throw new Response("Invalid speaker profile filter", { status: 400 });
}

function readinessFilter(value: string): AdminSpeakerFilters["readiness"] {
  if (value === "" || value === "ready" || value === "needs_attention") {
    return value;
  }
  throw new Response("Invalid speaker readiness filter", { status: 400 });
}

function workflowFilter(value: string): AdminSpeakerFilters["workflowStatus"] {
  if (
    value === "" ||
    value === "prospect" ||
    value === "invited" ||
    value === "confirmed" ||
    value === "declined" ||
    value === "withdrawn"
  ) {
    return value;
  }
  throw new Response("Invalid speaker workflow filter", { status: 400 });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  await ensureDemoSpeakerData(env);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  const url = new URL(request.url);
  const filters = {
    personId: url.searchParams.get("person")?.trim() ?? "",
    query: url.searchParams.get("query") ?? "",
    profileStatus: profileFilter(url.searchParams.get("profileStatus") ?? ""),
    readiness: readinessFilter(url.searchParams.get("readiness") ?? ""),
    workflowStatus: workflowFilter(
      url.searchParams.get("workflowStatus") ?? "",
    ),
  };
  const requestedPage = filters.personId
    ? 1
    : Number(url.searchParams.get("page") ?? "1");
  const workspace = await new SpeakerService(env).listAdminSpeakerPage(
    viewer,
    filters,
    requestedPage,
  );
  if (filters.personId && !workspace.speakers.length)
    throw new Response("Speaker not found in this event", { status: 404 });
  return {
    ...workspace,
    filters,
    focusedPersonId: filters.personId || null,
    manualSpeakerIdempotencyKey: crypto.randomUUID(),
    workflowIdempotencyKeys: Object.fromEntries(
      workspace.speakers.map((speaker) => [speaker.id, crypto.randomUUID()]),
    ),
    invitationIdempotencyKeys: Object.fromEntries(
      workspace.speakers.map((speaker) => [speaker.id, crypto.randomUUID()]),
    ),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  const form = await request.formData();
  const intent = String(form.get("_intent") ?? "");
  const rosterImport = new SpeakerRosterImportService(env);
  if (intent === "preview_roster_import") {
    try {
      const file = form.get("file");
      if (!(file instanceof File) || file.size === 0) {
        throw new SpeakerRosterImportError("Choose a CSV file to preview.");
      }
      if (file.size > 512_000) {
        throw new SpeakerRosterImportError(
          "Event speaker CSV files cannot exceed 512 KB.",
        );
      }
      const preview = await rosterImport.preview(viewer, await file.text());
      return data<ActionResult>({
        ok: preview.invalid.length === 0,
        message: `${preview.valid.length} valid speaker${preview.valid.length === 1 ? "" : "s"}; ${preview.invalid.length} invalid row${preview.invalid.length === 1 ? "" : "s"}. Nothing has been imported yet.`,
        importPreview: { ...preview, idempotencyKey: crypto.randomUUID() },
      });
    } catch (error) {
      if (error instanceof SpeakerRosterImportError) {
        return data<ActionResult>(
          { ok: false, message: error.message },
          { status: error.status },
        );
      }
      throw error;
    }
  }
  if (intent === "confirm_roster_import") {
    try {
      const result = await rosterImport.confirm(
        viewer,
        String(form.get("csv") ?? ""),
        form.get("idempotencyKey"),
        form.get("previewFingerprint"),
      );
      const routingDisclosure = (result.evaluatorEmailRoutings ?? [])
        .map(evaluatorEmailRoutingMessage)
        .join(" ");
      return data<ActionResult>({
        ok: true,
        message: `${result.imported} speaker${result.imported === 1 ? "" : "s"} imported to this event roster. No invitation email was sent.${routingDisclosure ? ` ${routingDisclosure}` : ""}`,
      });
    } catch (error) {
      if (error instanceof SpeakerRosterImportError) {
        return data<ActionResult>(
          { ok: false, message: error.message },
          { status: error.status },
        );
      }
      if (error instanceof ZodError) {
        return data<ActionResult>(
          {
            ok: false,
            message: error.issues[0]?.message ?? "Review the import.",
          },
          { status: 422 },
        );
      }
      throw error;
    }
  }
  if (intent === "update_workflow_status") {
    try {
      const result = await new SpeakerService(env).updateSpeakerWorkflowStatus(
        viewer,
        String(form.get("personId") ?? ""),
        {
          idempotencyKey: form.get("idempotencyKey"),
          status: form.get("status"),
        },
      );
      return data<ActionResult>({
        ok: true,
        message: `Speaker marked as ${fieldLabel(result.status).toLowerCase()}.`,
      });
    } catch (error) {
      if (error instanceof ZodError) {
        return data<ActionResult>(
          {
            ok: false,
            message:
              error.issues[0]?.message ?? "Choose a valid workflow status.",
          },
          { status: 422 },
        );
      }
      if (error instanceof SpeakerAdminStateError) {
        return data<ActionResult>(
          { ok: false, message: error.message },
          { status: error.status },
        );
      }
      if (error instanceof Response) throw error;
      throw error;
    }
  }
  if (intent === "send_speaker_invitation") {
    try {
      const result = await new SpeakerService(env).inviteSpeakerRecord(viewer, {
        idempotencyKey: form.get("idempotencyKey"),
        personId: form.get("personId"),
        confirmation: form.get("confirmation"),
      });
      return data<ActionResult>({
        ok: true,
        message: result.accepted
          ? "This speaker already has accepted portal access."
          : result.delivery === "demo_not_sent"
            ? "The portal invitation was saved. Demonstration mode does not send its sign-in email."
            : "The portal invitation and durable email operation were saved.",
      });
    } catch (error) {
      if (error instanceof ZodError) {
        return data<ActionResult>(
          {
            ok: false,
            message:
              error.issues[0]?.message ?? "Confirm the speaker invitation.",
          },
          { status: 422 },
        );
      }
      if (error instanceof SpeakerAdminStateError) {
        return data<ActionResult>(
          { ok: false, message: error.message },
          { status: error.status },
        );
      }
      if (error instanceof SpeakerInvitationDeliveryError) {
        return data<ActionResult>(
          { ok: false, message: error.message },
          { status: 207 },
        );
      }
      if (error instanceof Response) throw error;
      throw error;
    }
  }
  if (intent !== "add_manual_speaker") {
    return data<ActionResult>(
      { ok: false, message: "Unsupported speaker action." },
      { status: 400 },
    );
  }
  const input = {
    idempotencyKey: form.get("idempotencyKey"),
    name: form.get("name"),
    email: form.get("email"),
    jobTitle: String(form.get("jobTitle") ?? ""),
    organisationName: String(form.get("organisationName") ?? ""),
    biography: String(form.get("biography") ?? ""),
  };
  try {
    const emailResolution = await resolveEvaluatorEmailAlias(
      env,
      viewer,
      String(input.email ?? ""),
    );
    const duplicateCheck = emailResolution.routing
      ? { matches: [], truncated: false }
      : await new PersonDuplicateService(env).findLikelyDuplicates(viewer, [
          { name: input.name, email: emailResolution.email },
        ]);
    if (
      duplicateCheck.matches.length &&
      form.get("confirmDuplicatePeople") !== "yes"
    ) {
      return data<ActionResult>(
        {
          ok: false,
          message:
            "Review the likely existing person before adding this speaker.",
          duplicateCheck: {
            matches: duplicateCheck.matches,
            truncated: duplicateCheck.truncated,
          },
        },
        { status: 409 },
      );
    }
    const result = await new SpeakerService(env).addManualSpeakerRecord(
      viewer,
      input,
    );
    const routingDisclosure = evaluatorEmailRoutingMessage(result.routing);
    return data<ActionResult>({
      ok: true,
      message: `${
        !result.createdRosterAssociation
          ? "This identity is already on this event roster. Nothing was changed and no invitation email was sent."
          : result.createdIdentity
            ? "The speaker record was added to this event roster. No invitation email was sent."
            : "The existing identity was added or restored on this event roster. Its participant-owned profile was left unchanged and no invitation email was sent."
      }${routingDisclosure ? ` ${routingDisclosure}` : ""}`,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return data<ActionResult>(
        {
          ok: false,
          message: error.issues[0]?.message ?? "Review the speaker details.",
        },
        { status: 422 },
      );
    }
    if (error instanceof SpeakerAdminStateError) {
      return data<ActionResult>(
        { ok: false, message: error.message },
        { status: error.status },
      );
    }
    if (error instanceof Response) throw error;
    throw error;
  }
}
