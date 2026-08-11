import type { Route } from "./+types/evaluation-admin";
import {
  EvaluationAdminModelContext,
  useEvaluationAdminState,
} from "~/components/evaluation-admin-model";
import { EvaluationAdminPage } from "~/components/evaluation-admin-layout";

export {
  canReleaseEvaluationDecisions,
  decisionActionOutcome,
} from "./evaluation-admin-outcomes";
export { action, loader } from "./evaluation-admin.server";

export const meta = () => [{ title: "Evaluation · Program Cue" }];

export default function EvaluationAdmin({ loaderData }: Route.ComponentProps) {
  const model = useEvaluationAdminState(loaderData);
  return (
    <EvaluationAdminModelContext.Provider value={model}>
      <EvaluationAdminPage />
    </EvaluationAdminModelContext.Provider>
  );
}
