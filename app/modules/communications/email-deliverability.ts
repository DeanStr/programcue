import { z } from "zod";

const emailAddressSchema = z.email();
const RESERVED_OR_LOCAL_EMAIL_DOMAIN =
  /(?:^|\.)(?:example(?:\.(?:com|net|org))?|invalid|localhost|test)$/iu;

export type EmailDeliveryIssue =
  "Invalid email address" | "Reserved or local-only domain";

/**
 * Returns the concrete reason an address cannot be sent to. Reserved domains
 * remain useful fixture data outside production, but must never reach a real
 * production provider.
 */
export function emailDeliveryIssue(
  rawEmail: string,
  appEnvironment: unknown,
): EmailDeliveryIssue | null {
  const email = rawEmail.trim();
  if (!emailAddressSchema.safeParse(email).success) {
    return "Invalid email address";
  }
  if (
    String(appEnvironment) === "production" &&
    RESERVED_OR_LOCAL_EMAIL_DOMAIN.test(email.split("@")[1] ?? "")
  ) {
    return "Reserved or local-only domain";
  }
  return null;
}
