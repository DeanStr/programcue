import { EvaluationAdminPage } from "~/components/evaluation-admin-layout";
import {
  EvaluationAdminModelContext,
  useEvaluationAdminState,
} from "~/components/evaluation-admin-model";
import type { Route } from "./+types/evaluation-admin";

export { action, loader } from "./evaluation-admin.server";
export {
  canReleaseEvaluationDecisions,
  decisionActionOutcome,
} from "./evaluation-admin-outcomes";

export const meta = () => [{ title: "Evaluation · Program Cue" }];

export default function EvaluationAdmin({ loaderData }: Route.ComponentProps) {
  const model = useEvaluationAdminState(loaderData);
  return (
    <EvaluationAdminModelContext.Provider value={model}>
      <EvaluationAdminPage />
    </EvaluationAdminModelContext.Provider>
  );
}
