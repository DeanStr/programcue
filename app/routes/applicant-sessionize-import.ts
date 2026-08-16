import { z, ZodError } from "zod";

import type { Route } from "./+types/applicant-sessionize-import";
import { ensureDemoSubmissionForm } from "~/modules/submissions/demo-submissions.server";
import {
  importSessionizeProfile,
  SessionizeProfileImportError,
} from "~/modules/submissions/sessionize-profile-import.server";
import { SubmissionService } from "~/modules/submissions/submission-service.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  AbuseProtectionConfigurationError,
  AbuseRateLimitError,
  enforcePublicRateLimit,
} from "~/platform/http/public-abuse-protection.server";
import {
  readBoundedText,
  RequestBodyTooLargeError,
} from "~/platform/http/read-body";

const inputSchema = z
  .object({ profile: z.string().trim().min(1).max(2_048) })
  .strict();

function response(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
}

export async function action({ request, params, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return new Response("Method not allowed", {
      status: 405,
      headers: { allow: "POST", "cache-control": "no-store" },
    });
  }
  if (!params.slug)
    return response({ error: "Application form not found." }, 404);
  const { env } = getCloudflareContext(context);
  try {
    await ensureDemoSubmissionForm(env);
    const body = inputSchema.parse(
      JSON.parse(await readBoundedText(request, 8_192)),
    );
    const applicant = await new SubmissionService(
      env,
    ).authorizeApplicantProfileImport(request, params.slug);
    await enforcePublicRateLimit({
      env,
      request,
      action: "application_profile_import",
      tenantId: applicant.eventId,
      email: applicant.email,
    });
    return response({
      ok: true,
      profile: await importSessionizeProfile(body.profile),
    });
  } catch (error) {
    if (error instanceof Response) {
      const message = await error.text().catch(() => "");
      const denied = response(
        { error: message || "Profile import is not available." },
        error.status,
      );
      const retryAfter = error.headers.get("retry-after");
      if (retryAfter) denied.headers.set("retry-after", retryAfter);
      return denied;
    }
    if (error instanceof RequestBodyTooLargeError)
      return response({ error: "Profile import request exceeds 8 KB." }, 413);
    if (error instanceof SyntaxError)
      return response(
        {
          error:
            "That request could not be read. Reload the page and try again.",
        },
        400,
      );
    if (error instanceof ZodError)
      return response(
        { error: error.issues[0]?.message ?? "Invalid profile import." },
        422,
      );
    if (error instanceof AbuseRateLimitError) {
      const limited = response({ error: error.message }, 429);
      limited.headers.set("retry-after", String(error.retryAfterSeconds));
      return limited;
    }
    if (error instanceof AbuseProtectionConfigurationError) {
      console.error(
        JSON.stringify({
          level: "error",
          subsystem: "sessionize-profile-import",
          event: "abuse-protection-unavailable",
          errorName: error.name,
        }),
      );
      return response(
        { error: "Profile import is temporarily unavailable." },
        503,
      );
    }
    if (error instanceof SessionizeProfileImportError) {
      if (error.kind === "provider") {
        console.error(
          JSON.stringify({
            level: "error",
            subsystem: "sessionize-profile-import",
            event: "provider-response-rejected",
            errorName: error.name,
          }),
        );
      }
      return response(
        { error: error.message },
        error.kind === "input" ? 422 : 502,
      );
    }
    throw error;
  }
}
