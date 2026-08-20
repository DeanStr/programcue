import { requiresProductionSecurity } from "~/platform/runtime-environment.server";

export function submissionManagementPath(submissionId: string) {
  return `/applications/${encodeURIComponent(submissionId)}/manage`;
}

export function isSubmissionManagementUrl(
  value: string,
  submissionId: string,
  appEnvironment: unknown,
) {
  if (value !== value.trim() || value.length > 2_048) return false;
  try {
    const url = new URL(value);
    return (
      (url.protocol === "https:" ||
        (!requiresProductionSecurity(appEnvironment) &&
          url.protocol === "http:")) &&
      url.hostname.length > 0 &&
      !url.username &&
      !url.password &&
      url.pathname === submissionManagementPath(submissionId) &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}

export function submissionManagementUrl(
  env: CloudflareEnvironment,
  submissionId: string,
) {
  const configuredOrigin = env.BETTER_AUTH_URL?.trim();
  if (!configuredOrigin) {
    throw new Error(
      "BETTER_AUTH_URL is required to build submission confirmation links.",
    );
  }
  let url: URL;
  try {
    url = new URL(configuredOrigin);
  } catch {
    throw new Error(
      "BETTER_AUTH_URL must be an absolute URL before submission confirmations can be delivered.",
    );
  }
  if (url.username || url.password) {
    throw new Error("BETTER_AUTH_URL must not contain embedded credentials.");
  }
  if (
    url.protocol !== "https:" &&
    (requiresProductionSecurity(env.APP_ENV) || url.protocol !== "http:")
  ) {
    throw new Error(
      "BETTER_AUTH_URL must use HTTPS before submission confirmations can be delivered.",
    );
  }
  url.pathname = submissionManagementPath(submissionId);
  url.search = "";
  url.hash = "";
  return url.toString();
}
