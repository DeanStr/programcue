import { z } from "zod";

import { isCredentialFreeHttpsUrl } from "~/modules/events/https-url";
import type { UploadReference } from "./submission-application-schema";
import type { FieldErrors } from "./submission-form-display";
import { visibleFields } from "./submission-form-display";
import {
  CHECKBOX_TICKED_ANSWER,
  MAX_SUBMISSION_SPEAKERS,
  type StoredFormField,
  type StoredSubmissionFormSchema,
} from "./submission-form-schema";

const NUMBER_ANSWER = /^-?(?:\d+(?:\.\d+)?|\.\d+)$/u;
const PHONE_ANSWER = /^\+?[\d\s().-]+$/u;

function answerFormatIssue(field: StoredFormField, value: string) {
  const answer = value.trim();
  switch (field.type) {
    case "url":
    case "video":
      return isCredentialFreeHttpsUrl(value)
        ? null
        : "Enter a valid URL beginning with https://";
    case "email":
      return z.email().safeParse(answer).success
        ? null
        : "Enter a valid email address";
    case "number":
      return NUMBER_ANSWER.test(answer) && answer.length <= 32
        ? null
        : "Enter a number, such as 12 or 4.5";
    case "date":
      // Exact, untrimmed: a padded value passes a trimmed check but a native
      // date input cannot display it.
      return z.iso.date().safeParse(value).success
        ? null
        : "Enter a valid date";
    case "phone": {
      const digits = answer.replace(/\D/gu, "").length;
      return PHONE_ANSWER.test(answer) && digits >= 6 && digits <= 15
        ? null
        : "Enter a phone number using digits, spaces and an optional leading +";
    }
    case "checkbox":
      return value === CHECKBOX_TICKED_ANSWER
        ? null
        : `${field.label} must be ticked or left unticked`;
    default:
      return null;
  }
}

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
      errors[field.id] = [
        field.type === "checkbox"
          ? `Tick “${field.label}” to continue`
          : `${field.label} is required`,
      ];
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
    if (!missing && !Array.isArray(answer)) {
      const issue = answerFormatIssue(field, String(answer));
      if (issue) errors[field.id] = [issue];
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
