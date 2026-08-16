/**
 * Display names for the external services Program Cue talks to.
 *
 * Stored provider keys are lowercase identifiers (`accelevents`, `email_ics`).
 * Rendering them raw shows the reader a database value where they expect a
 * company or feature name, so every surface that names a provider resolves it
 * through here.
 */
const PROVIDER_LABELS: Record<string, string> = {
  accelevents: "Accelevents",
  airtable: "Airtable",
  sessionize: "Sessionize",
  resend: "Resend",
  mailpit: "Mailpit",
  google: "Google Calendar",
  microsoft: "Microsoft Outlook",
  email_ics: "Email invitation",
};

export function providerLabel(
  provider: string | null | undefined,
  fallback = "Not set",
) {
  if (!provider) return fallback;
  return (
    PROVIDER_LABELS[provider] ??
    provider
      .replaceAll("_", " ")
      .replace(/^./u, (letter) => letter.toUpperCase())
  );
}
