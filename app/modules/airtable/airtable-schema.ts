import { z } from "zod";

export const AIRTABLE_ROOMS_TABLE = "Program Cue Rooms";
export const AIRTABLE_SPEAKERS_TABLE = "Program Cue Published Speakers";
export const AIRTABLE_SESSIONS_TABLE = "Program Cue Published Sessions";
export const AIRTABLE_SCHEDULE_TABLE = "Program Cue Published Schedule";
export const AIRTABLE_SCHEMA_VERSION = 3;
export const AIRTABLE_CACHE_TTL_SECONDS = 15;

export const AIRTABLE_EVENT_DATA_TABLE_NAMES = {
  eventConfiguration: "Program Cue Event Configuration",
  tracks: "Program Cue Tracks",
  forms: "Program Cue Forms",
  formVersions: "Program Cue Form Versions",
  submissions: "Program Cue Submissions",
  submissionRevisions: "Program Cue Submission Revisions",
  submissionSpeakers: "Program Cue Submission Speakers",
  evaluationPlans: "Program Cue Evaluation Plans",
  evaluationTeams: "Program Cue Evaluation Teams",
  evaluationTeamMembers: "Program Cue Evaluation Team Members",
  evaluationRounds: "Program Cue Evaluation Rounds",
  evaluationCriteria: "Program Cue Evaluation Criteria",
  evaluatorAssignments: "Program Cue Evaluator Assignments",
  evaluatorConflicts: "Program Cue Evaluator Conflicts",
  reviews: "Program Cue Reviews",
  reviewRevisions: "Program Cue Review Revisions",
  reviewModerations: "Program Cue Review Moderations",
  decisions: "Program Cue Decisions",
  sourceSessions: "Program Cue Sessions",
  sessionSpeakers: "Program Cue Session Speakers",
  programmePeople: "Program Cue Programme People",
  scheduleVersions: "Program Cue Schedule Versions",
  scheduleSessionContents: "Program Cue Schedule Session Contents",
  scheduleEntries: "Program Cue Schedule Entries",
  schedulePolicies: "Program Cue Schedule Policies",
  scheduleConflicts: "Program Cue Schedule Conflicts",
  taskTemplates: "Program Cue Task Templates",
  taskTemplateDependencies: "Program Cue Task Template Dependencies",
  taskInstances: "Program Cue Task Instances",
  taskInstanceDependencies: "Program Cue Task Instance Dependencies",
  taskEvidence: "Program Cue Task Evidence",
  taskComments: "Program Cue Task Comments",
} as const;

export type AirtableEventDataTableKey =
  keyof typeof AIRTABLE_EVENT_DATA_TABLE_NAMES;

export const airtableConnectionInputSchema = z.object({
  personalAccessToken: z
    .string()
    .trim()
    .min(20, "Enter a valid Airtable personal access token."),
  baseId: z
    .string()
    .trim()
    .regex(
      /^app[A-Za-z0-9]+$/,
      "Enter an Airtable base ID beginning with app.",
    ),
  tableName: z
    .string()
    .trim()
    .min(1, "Airtable table name is required.")
    .max(100)
    .default(AIRTABLE_ROOMS_TABLE),
});

export const airtableCredentialsSchema = airtableConnectionInputSchema.pick({
  personalAccessToken: true,
  baseId: true,
});

export const airtableConnectionConfigurationSchema = z.object({
  baseId: z.string().min(1),
  schemaVersion: z.literal(AIRTABLE_SCHEMA_VERSION),
  tables: z.object({
    rooms: z.object({ id: z.string().min(1), name: z.string().min(1) }),
    speakers: z.object({ id: z.string().min(1), name: z.string().min(1) }),
    sessions: z.object({ id: z.string().min(1), name: z.string().min(1) }),
    schedule: z.object({ id: z.string().min(1), name: z.string().min(1) }),
    ...(Object.fromEntries(
      Object.keys(AIRTABLE_EVENT_DATA_TABLE_NAMES).map((key) => [
        key,
        z.object({ id: z.string().min(1), name: z.string().min(1) }),
      ]),
    ) as Record<
      AirtableEventDataTableKey,
      z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
      }>
    >),
  }),
  authoritativeEntities: z.tuple([
    z.literal("rooms"),
    z.literal("event_configuration"),
    z.literal("forms"),
    z.literal("submissions"),
    z.literal("evaluations"),
    z.literal("sessions"),
    z.literal("tasks"),
    z.literal("published_programme"),
  ]),
});

const airtableRoomResourceSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9]+(?:[ -][a-z0-9]+)*$/);

export const airtableRoomSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .regex(/^[a-z0-9][a-z0-9-]*$/),
  eventId: z.string().min(1),
  name: z.string().trim().min(1).max(120),
  capacity: z.number().int().min(1).max(100_000),
  position: z.number().int().min(0),
  status: z.enum(["active", "retired"]),
  revision: z.number().int().positive(),
  building: z.string().nullable().default(null),
  level: z.string().nullable().default(null),
  resources: z
    .array(airtableRoomResourceSchema)
    .max(50)
    .refine((resources) => new Set(resources).size === resources.length, {
      message: "Room resources must be unique canonical lowercase values.",
    })
    .default([]),
});

export type AirtableConnectionInput = z.infer<
  typeof airtableConnectionInputSchema
>;
export type AirtableCredentials = z.infer<typeof airtableCredentialsSchema>;
export type AirtableConnectionConfiguration = z.infer<
  typeof airtableConnectionConfigurationSchema
>;
export type AirtableRoom = z.infer<typeof airtableRoomSchema>;

export type AirtableFieldDefinition = {
  name: string;
  type: "singleLineText" | "number";
  options?: { precision: number };
};

export const AIRTABLE_ROOM_FIELDS: readonly AirtableFieldDefinition[] = [
  { name: "Program Cue ID", type: "singleLineText" },
  { name: "Event ID", type: "singleLineText" },
  { name: "Name", type: "singleLineText" },
  { name: "Capacity", type: "number", options: { precision: 0 } },
  { name: "Position", type: "number", options: { precision: 0 } },
  { name: "Status", type: "singleLineText" },
  { name: "Revision", type: "number", options: { precision: 0 } },
  { name: "Building", type: "singleLineText" },
  { name: "Level", type: "singleLineText" },
  { name: "Resources JSON", type: "singleLineText" },
] as const;

export const AIRTABLE_SPEAKER_FIELDS: readonly AirtableFieldDefinition[] = [
  { name: "Program Cue Key", type: "singleLineText" },
  { name: "Event ID", type: "singleLineText" },
  { name: "Version ID", type: "singleLineText" },
  { name: "Person ID", type: "singleLineText" },
  { name: "Display Name", type: "singleLineText" },
  { name: "Image URL", type: "singleLineText" },
  { name: "Biography", type: "singleLineText" },
  { name: "Pronunciation", type: "singleLineText" },
  { name: "Organisation", type: "singleLineText" },
  { name: "Job Title", type: "singleLineText" },
  { name: "Session IDs JSON", type: "singleLineText" },
  { name: "Status", type: "singleLineText" },
] as const;

export const AIRTABLE_SESSION_FIELDS: readonly AirtableFieldDefinition[] = [
  { name: "Program Cue Key", type: "singleLineText" },
  { name: "Event ID", type: "singleLineText" },
  { name: "Version ID", type: "singleLineText" },
  { name: "Session ID", type: "singleLineText" },
  { name: "Slug", type: "singleLineText" },
  { name: "Title", type: "singleLineText" },
  { name: "Description", type: "singleLineText" },
  { name: "Format", type: "singleLineText" },
  { name: "Track", type: "singleLineText" },
  { name: "Speaker IDs JSON", type: "singleLineText" },
  { name: "Speaker Names JSON", type: "singleLineText" },
  { name: "Status", type: "singleLineText" },
] as const;

export const AIRTABLE_SCHEDULE_FIELDS: readonly AirtableFieldDefinition[] = [
  { name: "Program Cue Key", type: "singleLineText" },
  { name: "Event ID", type: "singleLineText" },
  { name: "Version ID", type: "singleLineText" },
  { name: "Entry ID", type: "singleLineText" },
  { name: "Session ID", type: "singleLineText" },
  { name: "Room ID", type: "singleLineText" },
  { name: "Starts At", type: "number", options: { precision: 0 } },
  { name: "Ends At", type: "number", options: { precision: 0 } },
  { name: "Status", type: "singleLineText" },
] as const;

export const AIRTABLE_EVENT_DATA_FIELDS: readonly AirtableFieldDefinition[] = [
  { name: "Program Cue Key", type: "singleLineText" },
  { name: "Event ID", type: "singleLineText" },
  { name: "Entity ID", type: "singleLineText" },
  { name: "Payload JSON", type: "singleLineText" },
  { name: "Revision", type: "number", options: { precision: 0 } },
  { name: "Status", type: "singleLineText" },
] as const;
