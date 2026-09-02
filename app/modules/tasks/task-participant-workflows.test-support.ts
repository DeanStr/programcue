import { requireValue } from "~/lib/required-value";
import type { Viewer } from "~/platform/auth/authorize.server";

import { TaskService } from "./task-service.server";

export const admin: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

export const speaker: Viewer = {
  personId: "person-demo-speaker",
  name: "Priya Shah",
  email: "priya.speaker@example.com",
  role: "speaker",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

export const submitter: Viewer = {
  personId: "person-demo-submitter",
  name: "Alex Morgan",
  email: "alex.submitter@example.com",
  role: "submitter",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

export async function createSessionCoSpeaker(testEnv: CloudflareEnvironment) {
  const suffix = crypto.randomUUID();
  const personId = `person-session-co-speaker-${suffix}`;
  const position = await testEnv.DB.prepare(
    `SELECT COALESCE(MAX(position), -1) + 1 AS value
       FROM session_speakers
      WHERE event_id = ? AND session_id = 'session-demo-speaker'`,
  )
    .bind(admin.eventId)
    .first<{ value: number }>();
  if (!position || !Number.isSafeInteger(position.value))
    throw new Error("Could not resolve the next session-speaker position.");
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO people (
         id, email, display_name, email_verified, created_at, updated_at
       ) VALUES (?, ?, 'Session co-speaker', 1, unixepoch(), unixepoch())`,
    ).bind(personId, `${personId}@example.test`),
    testEnv.DB.prepare(
      `INSERT INTO memberships (
         id, organisation_id, event_id, person_id, role, accepted_at, created_at
       ) VALUES (?, ?, ?, ?, 'speaker', unixepoch(), unixepoch())`,
    ).bind(
      `membership-session-co-speaker-${suffix}`,
      admin.organisationId,
      admin.eventId,
      personId,
    ),
    testEnv.DB.prepare(
      `INSERT INTO session_speakers (
         session_id, event_id, person_id, position, role_label,
         participation_status, participation_confirmed_at, visibility
       ) VALUES ('session-demo-speaker', ?, ?, ?, 'Co-speaker',
                 'confirmed', unixepoch(), 'public')`,
    ).bind(admin.eventId, personId, position.value),
  ]);
  return {
    personId,
    name: "Session co-speaker",
    email: `${personId}@example.test`,
    role: "speaker",
    organisationId: admin.organisationId,
    eventId: admin.eventId,
    demo: true,
  } satisfies Viewer;
}

export async function createFileTask(
  testEnv: CloudflareEnvironment,
  name: string,
) {
  const tasks = new TaskService(testEnv);
  const templateId = await tasks.createTemplate(admin, {
    name,
    description: "Upload test evidence.",
    targetType: "speaker",
    taskType: "file_upload",
    impact: "high",
    evidenceMode: "file",
    dueAnchor: "none",
    dueOffsetDays: null,
    fixedDueDate: null,
    autoAssignOnAcceptance: false,
    dependencyIds: [],
    configuration: {
      fileScope: "participant_document",
      fileKind: "supporting_document",
    },
  });
  return (await tasks.assignTemplate(admin, templateId, speaker.personId))
    .taskId;
}

export async function createSessionFileTask(
  testEnv: CloudflareEnvironment,
  name: string,
) {
  const tasks = new TaskService(testEnv);
  const templateId = await tasks.createTemplate(admin, {
    name,
    description: "Upload shared session evidence.",
    targetType: "session",
    taskType: "file_upload",
    impact: "high",
    evidenceMode: "file",
    dueAnchor: "none",
    dueOffsetDays: null,
    fixedDueDate: null,
    autoAssignOnAcceptance: false,
    dependencyIds: [],
    configuration: { fileScope: "session_deliverable", fileKind: "slides" },
  });
  return (await tasks.assignTemplate(admin, templateId, "session-demo-speaker"))
    .taskId;
}

export function testPdfFile(name: string, marker = 0) {
  return new File(
    [new TextEncoder().encode(`%PDF-1.7\nTask evidence ${marker}`)],
    name,
    { type: "application/pdf" },
  );
}

export async function createChecklistTask(
  testEnv: CloudflareEnvironment,
  name: string,
) {
  const tasks = new TaskService(testEnv);
  const templateId = await tasks.createTemplate(admin, {
    name,
    description: "Confirm the test requirement.",
    targetType: "speaker",
    taskType: "checklist",
    impact: "high",
    evidenceMode: "checkbox",
    dueAnchor: "none",
    dueOffsetDays: null,
    fixedDueDate: null,
    autoAssignOnAcceptance: false,
    dependencyIds: [],
  });
  return (await tasks.assignTemplate(admin, templateId, speaker.personId))
    .taskId;
}

export function withBatchRace(
  testEnv: CloudflareEnvironment,
  race: () => Promise<void>,
) {
  let injectRace = true;
  const racingDb = new Proxy(testEnv.DB, {
    get(target, property) {
      if (property === "batch")
        return async (statements: D1PreparedStatement[]) => {
          if (injectRace) {
            injectRace = false;
            await race();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(testEnv, {
    get(target, property) {
      return property === "DB" ? racingDb : Reflect.get(target, property);
    },
  });
}

export async function createDependencyPair(
  testEnv: CloudflareEnvironment,
  dependentName: string,
  dependent: {
    taskType: "checklist" | "file_upload";
    evidenceMode: "checkbox" | "file";
  },
) {
  const tasks = new TaskService(testEnv);
  const prerequisiteTemplateId = await tasks.createTemplate(admin, {
    name: `${dependentName} prerequisite`,
    description: "Complete this first.",
    targetType: "speaker",
    taskType: "checklist",
    impact: "high",
    evidenceMode: "checkbox",
    dueAnchor: "none",
    dueOffsetDays: null,
    fixedDueDate: null,
    autoAssignOnAcceptance: false,
    dependencyIds: [],
  });
  const dependentTemplateId = await tasks.createTemplate(admin, {
    name: dependentName,
    description: "Depends on the prerequisite.",
    targetType: "speaker",
    taskType: dependent.taskType,
    impact: "high",
    evidenceMode: dependent.evidenceMode,
    dueAnchor: "none",
    dueOffsetDays: null,
    fixedDueDate: null,
    autoAssignOnAcceptance: false,
    dependencyIds: [prerequisiteTemplateId],
    ...(dependent.taskType === "file_upload"
      ? {
          configuration: {
            fileScope: "participant_document" as const,
            fileKind: "supporting_document" as const,
          },
        }
      : {}),
  });
  const { taskId: dependentTaskId } = await tasks.assignTemplate(
    admin,
    dependentTemplateId,
    speaker.personId,
  );
  let assigned = await tasks.listParticipantTasks(speaker);
  const prerequisite = requireValue(
    assigned.find((task) => task.templateId === prerequisiteTemplateId),
    "Expected prerequisite task fixture.",
  );
  await tasks.completeParticipant(speaker, {
    taskId: prerequisite.id,
    revision: prerequisite.revision,
    confirmed: true,
  });
  assigned = await tasks.listParticipantTasks(speaker);
  return {
    prerequisite: requireValue(
      assigned.find((task) => task.id === prerequisite.id),
      "Expected refreshed prerequisite task fixture.",
    ),
    dependent: requireValue(
      assigned.find((task) => task.id === dependentTaskId),
      "Expected dependent task fixture.",
    ),
  };
}
