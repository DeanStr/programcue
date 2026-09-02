import type { ShouldRevalidateFunctionArgs } from "react-router";
import { SchedulePlannerWorkspace } from "~/components/schedule-planner-workspace";
import {
  onlyClientSearchParametersChanged,
  SCHEDULE_SOURCE_CLIENT_SEARCH_PARAMETERS,
} from "~/lib/client-search-revalidation";
import type { Route } from "./+types/schedule-planner";

export { action, loader } from "./schedule-planner.server";

export const meta = () => [{ title: "Schedule planner · Program Cue" }];

export function shouldRevalidateScheduleMutation(
  actionResult: unknown,
  defaultShouldRevalidate: boolean,
) {
  const reconciledPlacement =
    actionResult &&
    typeof actionResult === "object" &&
    "intent" in actionResult &&
    actionResult.intent === "place" &&
    "skipRevalidation" in actionResult &&
    actionResult.skipRevalidation === true;
  return reconciledPlacement ? false : defaultShouldRevalidate;
}

export function shouldRevalidate({
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
  formMethod,
  actionResult,
}: ShouldRevalidateFunctionArgs) {
  if (formMethod && formMethod.toUpperCase() !== "GET") {
    return shouldRevalidateScheduleMutation(
      actionResult,
      defaultShouldRevalidate,
    );
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
