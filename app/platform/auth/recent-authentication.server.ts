import { redirect } from "react-router";

import type { Viewer } from "./authorize.server";

export const PRIVILEGED_AUTHENTICATION_MAX_AGE_SECONDS = 15 * 60;

export function hasRecentAuthentication(viewer: Viewer, now = Date.now()) {
  if (viewer.demo || viewer.evaluation) return true;
  const createdAt = viewer.authenticationCreatedAt;
  if (!(createdAt instanceof Date) || !Number.isFinite(createdAt.getTime())) {
    return false;
  }
  const age = now - createdAt.getTime();
  return age >= 0 && age <= PRIVILEGED_AUTHENTICATION_MAX_AGE_SECONDS * 1_000;
}

export function recentAuthenticationLocation(returnTo: string) {
  return `/sign-in?${new URLSearchParams({ returnTo, reauthenticate: "true" })}`;
}

export function requireRecentAuthentication(
  request: Request,
  viewer: Viewer,
  now = Date.now(),
) {
  if (hasRecentAuthentication(viewer, now)) return;
  const url = new URL(request.url);
  const returnTo = `${url.pathname}${url.search}`;
  throw redirect(recentAuthenticationLocation(returnTo), 303);
}
