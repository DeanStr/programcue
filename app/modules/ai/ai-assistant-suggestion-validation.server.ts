import type { FixedAssistantToolPlan } from "./ai-assistant-suggestions";
import { taskProposalArgumentsSchema } from "./ai-tool-contracts.server";

export function fixedAssistantToolArgumentsMatch(
  plan: FixedAssistantToolPlan,
  toolName: string,
  encodedArguments: string,
  eventId: string,
) {
  if (plan.kind !== "readiness_task" || toolName !== "propose_task") {
    return true;
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(encodedArguments);
  } catch {
    return false;
  }
  const parsed = taskProposalArgumentsSchema.safeParse(decoded);
  return (
    parsed.success &&
    parsed.data.targetType === "event" &&
    parsed.data.targetId === eventId &&
    parsed.data.ownerPersonId === null &&
    parsed.data.taskType === "administrator_only" &&
    parsed.data.dueAt === null &&
    parsed.data.dependencyIds.length === 0
  );
}
