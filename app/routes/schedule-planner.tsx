import type { ShouldRevalidateFunctionArgs } from "react-router";

import type { Route } from "./+types/schedule-planner";
import { SchedulePlannerWorkspace } from "~/components/schedule-planner-workspace";
import {
  onlyClientSearchParametersChanged,
  SCHEDULE_SOURCE_CLIENT_SEARCH_PARAMETERS,
} from "~/lib/client-search-revalidation";

export { action, loader } from "./schedule-planner.server";

export const meta = () => [{ title: "Schedule Planner · Program Cue" }];

export function shouldRevalidate({
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
  formMethod,
}: ShouldRevalidateFunctionArgs) {
  if (formMethod && formMethod.toUpperCase() !== "GET") {
    return defaultShouldRevalidate;
  }

  return onlyClientSearchParametersChanged(
    currentUrl,
    nextUrl,
    SCHEDULE_SOURCE_CLIENT_SEARCH_PARAMETERS,
  )
    ? false
    : defaultShouldRevalidate;
}

export default function SchedulePlanner({ loaderData }: Route.ComponentProps) {
  return <SchedulePlannerWorkspace workspace={loaderData} />;
}
