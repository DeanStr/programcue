import type { ShouldRevalidateFunctionArgs } from "react-router";
import { ReviewWorkbenchWorkspace } from "~/components/review-workbench-workspace";
import type { Route } from "./+types/review-workbench";

export {
  reviewCanAdoptServerPayload,
  reviewSaveCoversCurrentEdits,
} from "~/components/review-workbench-workspace";
export { action, loader } from "./review-workbench.server";

export const meta = () => [{ title: "Review Workbench · Program Cue" }];

export function shouldRevalidate({
  actionResult,
  defaultShouldRevalidate,
}: ShouldRevalidateFunctionArgs) {
  return actionResult &&
    typeof actionResult === "object" &&
    "clearedAssignmentId" in actionResult
    ? false
    : defaultShouldRevalidate;
}

export default function ReviewWorkbench({ loaderData }: Route.ComponentProps) {
  return <ReviewWorkbenchWorkspace loaderData={loaderData} />;
}
