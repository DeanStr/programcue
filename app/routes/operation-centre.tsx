import type { Route } from "./+types/operation-centre";
import {
  OperationCentreWorkspace,
  taskImportTransitionSummary,
} from "~/components/operation-centre-workspace";

export { action, loader } from "./operation-centre.server";
export { taskImportTransitionSummary };

export const meta = () => [{ title: "Operation Centre · Program Cue" }];

export default function OperationCentre({ loaderData }: Route.ComponentProps) {
  return <OperationCentreWorkspace loaderData={loaderData} />;
}
