import { z } from "zod";

import { isCredentialFreeHttpsUrl } from "~/modules/events/https-url";
import type { UploadReference } from "./submission-application-schema";
import type { FieldErrors } from "./submission-form-display";
import { visibleFields } from "./submission-form-display";
import type { StoredSubmissionFormSchema } from "./submission-form-schema";
import { MAX_SUBMISSION_SPEAKERS } from "./submission-form-schema";

export function validateFinalAnswers(
  schema: StoredSubmissionFormSchema,
  answers: Record<string, string | string[]>,
  speakers: Array<{ name: string; email: string }>,
  minSpeakers: number,
  maxSpeakers: number | null,
  uploads: Record<string, UploadReference> = {},
) {
  const errors: FieldErrors = {};
  for (const field of visibleFields(schema, answers)) {
    const answer = answers[field.id];
    const missing = Array.isArray(answer)
      ? answer.length === 0
      : !String(answer ?? "").trim();
    if (field.required && missing && !uploads[field.id])
      errors[field.id] = [`${field.label} is required`];
    if (
      !missing &&
      (field.type === "select" || field.type === "multi_select")
    ) {
      const values = Array.isArray(answer) ? answer : [answer];
      if (new Set(values).size !== values.length) {
        errors[field.id] = [
          `${field.label} must not contain duplicate choices`,
        ];
      } else if (values.some((value) => !field.options.includes(value))) {
        errors[field.id] = [`${field.label} contains an invalid choice`];
      }
    }
    if (!missing && (field.type === "url" || field.type === "video")) {
      if (!isCredentialFreeHttpsUrl(String(answer))) {
        errors[field.id] = ["Enter a valid URL beginning with https://"];
      }
    }
  }

  if (speakers.length < minSpeakers)
    errors.speakers = [
      `Add at least ${minSpeakers} speaker${minSpeakers === 1 ? "" : "s"}`,
    ];
  const effectiveMaximum = Math.min(
    maxSpeakers ?? MAX_SUBMISSION_SPEAKERS,
    MAX_SUBMISSION_SPEAKERS,
  );
  if (speakers.length > effectiveMaximum)
    errors.speakers = [`This form allows at most ${effectiveMaximum} speakers`];
  if (
    speakers.some((speaker) => !speaker.name.trim() || !speaker.email.trim())
  ) {
    errors.speakers = ["Every speaker needs a name and email address"];
  } else if (
    speakers.some(
      (speaker) => !z.email().safeParse(speaker.email.trim()).success,
    )
  ) {
    errors.speakers = ["Every speaker needs a valid email address"];
  } else {
    const emails = speakers.map((speaker) =>
      speaker.email.trim().toLowerCase(),
    );
    if (new Set(emails).size !== emails.length)
      errors.speakers = ["Each speaker must use a different email address"];
  }
  return errors;
}
