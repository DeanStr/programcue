import type { Route } from "./+types/schedule-planner";
import { SchedulePlannerWorkspace } from "~/components/schedule-planner-workspace";

export { action, loader } from "./schedule-planner.server";

export const meta = () => [{ title: "Schedule Planner · Program Cue" }];

export default function SchedulePlanner({ loaderData }: Route.ComponentProps) {
  return <SchedulePlannerWorkspace workspace={loaderData} />;
}
