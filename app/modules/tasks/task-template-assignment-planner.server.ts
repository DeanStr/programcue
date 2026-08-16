import type { TemplateRow } from "./task-service-foundation.server";

export type TaskAssignmentSnapshot = {
  targetRevision: number;
  templateAssignments: Array<{ templateId: string; assigned: boolean }>;
  templates: TaskTemplateAssignmentSnapshot[];
};

type TaskTemplateAssignmentSnapshot = {
  id: string;
  name: string;
  description: string | null;
  targetType: TemplateRow["targetType"];
  taskType: TemplateRow["taskType"];
  impact: TemplateRow["impact"];
  evidenceMode: TemplateRow["evidenceMode"];
  dueAnchor: TemplateRow["dueAnchor"];
  dueOffsetMinutes: number | null;
  fixedDueAt: number | null;
  autoAssignOnAcceptance: number;
  configurationJson: string;
  updatedAt: number;
  dependencyIds: string[];
};

export function assignmentTemplateSnapshot(
  template: TemplateRow & { updatedAt: number },
  dependencyIds: string[] = [],
): TaskTemplateAssignmentSnapshot {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    targetType: template.targetType,
    taskType: template.taskType,
    impact: template.impact,
    evidenceMode: template.evidenceMode,
    dueAnchor: template.dueAnchor,
    dueOffsetMinutes: template.dueOffsetMinutes,
    fixedDueAt: template.fixedDueAt,
    autoAssignOnAcceptance: Number(template.autoAssignOnAcceptance),
    configurationJson: template.configurationJson,
    updatedAt: template.updatedAt,
    dependencyIds: [...dependencyIds].sort(),
  };
}

export function matchingActiveTaskDefinitionBindings(
  template: TemplateRow,
  dueAt: number | null,
) {
  return [
    template.id,
    template.name,
    template.description,
    template.taskType,
    template.impact,
    dueAt,
    template.evidenceMode,
    template.configurationJson,
  ];
}

export async function dependencyAssignmentOperationId(
  intentId: string,
  templateId: string,
) {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${intentId.length}:${intentId}:${templateId}`),
    ),
  );
  const boundedHash = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .slice(0, 40);
  return `dep:${boundedHash}`;
}
