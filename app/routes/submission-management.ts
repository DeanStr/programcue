import { redirect } from "react-router";
import { z } from "zod";
import { ensureDemoSubmissionForm } from "~/modules/submissions/demo-submissions.server";
import { SubmissionService } from "~/modules/submissions/submission-service.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/submission-management";

function applicationNotFound() {
  return new Response("Application not found", {
    status: 404,
    headers: { "cache-control": "private, no-store" },
  });
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const parsedSubmissionId = z
    .string()
    .min(1)
    .max(100)
    .safeParse(params.submissionId);
  if (!parsedSubmissionId.success) {
    throw applicationNotFound();
  }
  const submissionId = parsedSubmissionId.data;
  const { env } = getCloudflareContext(context);
  await ensureDemoSubmissionForm(env);
  const currentForm = await env.DB.prepare(
    `SELECT form.public_slug AS publicSlug
       FROM submissions submission
       JOIN form_versions version
         ON version.id = submission.form_version_id
        AND version.event_id = submission.event_id
       JOIN form_definitions form
         ON form.id = version.form_id AND form.event_id = submission.event_id
       JOIN events event
         ON event.id = submission.event_id AND event.activation_status = 'active'
      WHERE submission.id = ? AND form.status = 'published'
      LIMIT 1`,
  )
    .bind(submissionId)
    .first<{ publicSlug: string }>();
  if (!currentForm) {
    throw applicationNotFound();
  }

  let portal: Awaited<ReturnType<SubmissionService["getApplicantPortal"]>>;
  try {
    portal = await new SubmissionService(env).getApplicantPortal(
      currentForm.publicSlug,
      request,
      submissionId,
    );
  } catch (error) {
    if (error instanceof Response && error.status === 404) {
      throw applicationNotFound();
    }
    throw error;
  }
  if (!portal.applicant || portal.selected?.id !== submissionId) {
    throw applicationNotFound();
  }

  return redirect(
    `/apply/${encodeURIComponent(currentForm.publicSlug)}?${new URLSearchParams(
      {
        draft: submissionId,
      },
    )}#submitted-application`,
    { headers: { "cache-control": "private, no-store" } },
  );
}
