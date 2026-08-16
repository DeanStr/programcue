import type { ZodError } from "zod";

export function zodFieldErrors(error: ZodError) {
  const errors: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const field = String(issue.path[0] ?? "form");
    const messages = errors[field];
    if (messages) messages.push(issue.message);
    else errors[field] = [issue.message];
  }
  return errors;
}
