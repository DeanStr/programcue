import { ZodError, z } from "zod";
import { CommunicationStateError } from "~/modules/communications/communication-service.server";
import { EvaluationStateError } from "~/modules/evaluations/evaluation-errors";
import { SubmissionStateError } from "~/modules/submissions/submission-repository.server";
import { SponsorStateError } from "./sponsor-schema";

export function sponsorFormError(error: unknown) {
  if (error instanceof ZodError)
    return error.issues[0]?.message ?? "Review the form fields.";
  if (
    error instanceof SponsorStateError ||
    error instanceof EvaluationStateError ||
    error instanceof SubmissionStateError ||
    error instanceof CommunicationStateError
  )
    return error.message;
  return null;
}
export function sponsorProfileInput(form: FormData) {
  return {
    name: form.get("name"),
    description: form.get("description"),
    websiteUrl: form.get("websiteUrl"),
    logoUrl: form.get("logoUrl"),
  };
}
export function sponsorSessionInput(form: FormData) {
  const names = form.getAll("speakerName");
  const emails = form.getAll("speakerEmail");
  const biographies = form.getAll("speakerBiography");
  if (names.length !== emails.length || emails.length !== biographies.length)
    throw new SponsorStateError("Review the speaker details before saving.");
  return {
    title: form.get("title"),
    description: form.get("description"),
    trackId: form.get("trackId"),
    format: form.get("format"),
    durationMinutes: form.get("durationMinutes"),
    speakers: names.map((name, index) => ({
      name,
      email: emails[index],
      biography: biographies[index],
    })),
  };
}
export const sponsorRevision = (form: FormData) =>
  z.coerce.number().int().positive().parse(form.get("revision"));
export const sponsorKey = (form: FormData) => z.uuid().parse(form.get("key"));
export function requireSponsorConfirmation(form: FormData) {
  if (form.get("confirmed") !== "yes")
    throw new SponsorStateError(
      "Confirm the affected records before continuing.",
    );
}
