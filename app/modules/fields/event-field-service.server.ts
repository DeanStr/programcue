import { z } from "zod";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  type EventFieldDefinitionValue,
  type EventFieldOwnerType,
  type FixedParticipantProfileFieldKey,
  fixedParticipantProfileFields,
  type ParticipantFieldAccess,
} from "./event-field-types";

export type {
  EventFieldDefinitionValue,
  EventFieldOwnerType,
  EventFieldType,
  FixedParticipantProfileFieldKey,
  ParticipantFieldAccess,
} from "./event-field-types";

const accessSchema = z.enum(["hidden", "read_only", "editable"]);
const ownerTypeSchema = z.enum(["person", "session"]);
const fieldTypeSchema = z.enum([
  "short_text",
  "long_text",
  "number",
  "boolean",
  "date",
  "single_choice",
  "multiple_choice",
]);

const createDefinitionSchema = z
  .object({
    ownerType: ownerTypeSchema,
    fieldKey: z
      .string()
      .trim()
      .regex(/^[a-z][a-z0-9_]{1,39}$/u, "Use a stable lowercase field key."),
    label: z.string().trim().min(1).max(120),
    fieldType: fieldTypeSchema,
    options: z.array(z.string().trim().min(1).max(120)).max(50),
    participantAccess: accessSchema,
    required: z.boolean(),
  })
  .superRefine((input, context) => {
    const choice = ["single_choice", "multiple_choice"].includes(
      input.fieldType,
    );
    if (choice && input.options.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "Choice fields need at least one option.",
      });
    }
    if (!choice && input.options.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "Only choice fields can define options.",
      });
    }
    if (
      new Set(input.options.map((option) => option.toLocaleLowerCase()))
        .size !== input.options.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "Choice options must be unique.",
      });
    }
    if (
      input.ownerType === "session" &&
      input.participantAccess === "editable"
    ) {
      context.addIssue({
        code: "custom",
        path: ["participantAccess"],
        message: "Session fields can be hidden or read-only for participants.",
      });
    }
  });

type DefinitionRow = Omit<
  EventFieldDefinitionValue,
  "options" | "required" | "value"
> & {
  optionsJson: string;
  required: number;
  valueJson: string | null;
};

type ParticipantSessionDefinitionRow = DefinitionRow & {
  sessionId: string;
};

function mapDefinition(row: DefinitionRow): EventFieldDefinitionValue {
  return {
    ...row,
    options: z.array(z.string()).parse(JSON.parse(row.optionsJson)),
    required: row.required === 1,
    valueRevision: row.valueRevision,
    value:
      row.valueJson === null
        ? null
        : (JSON.parse(row.valueJson) as EventFieldDefinitionValue["value"]),
  };
}

function assertAdministrator(viewer: Viewer) {
  if (viewer.role !== "owner" && viewer.role !== "administrator") {
    throw new Response("Event administrator access is required.", {
      status: 403,
    });
  }
}

type ParticipantProfileScope = Pick<Viewer, "eventId" | "organisationId">;

type ParticipantProfileRecord = {
  [fieldName: string]: unknown;
};

export type ParticipantProfilePolicies = Record<
  FixedParticipantProfileFieldKey,
  ParticipantFieldAccess
>;

export function participantVisibleProfile<T extends object>(
  profile: T,
  policies: ParticipantProfilePolicies,
): Partial<T> {
  const visible = { ...profile } as T & ParticipantProfileRecord;
  for (const field of fixedParticipantProfileFields) {
    if (policies[field.key] === "hidden") {
      delete visible[field.formName];
    }
  }
  return visible;
}

function valueForDefinition(
  definition: EventFieldDefinitionValue,
  form: FormData,
) {
  const name = `field:${definition.id}`;
  const raw = form.get(name);
  let value: EventFieldDefinitionValue["value"];
  switch (definition.fieldType) {
    case "boolean": {
      const text = String(raw ?? "").trim();
      value = text ? z.enum(["true", "false"]).parse(text) === "true" : null;
      break;
    }
    case "number": {
      const text = String(raw ?? "").trim();
      value = text ? z.coerce.number().finite().parse(text) : null;
      break;
    }
    case "multiple_choice":
      value = form.getAll(name).map(String);
      if (
        value.some((option) => !definition.options.includes(option)) ||
        new Set(value).size !== value.length
      ) {
        throw new EventFieldStateError(
          `Choose valid ${definition.label.toLocaleLowerCase()} options.`,
          422,
        );
      }
      break;
    case "single_choice": {
      const text = String(raw ?? "").trim();
      value = text
        ? z.enum(definition.options as [string, ...string[]]).parse(text)
        : null;
      break;
    }
    case "date": {
      const text = String(raw ?? "").trim();
      value = text ? z.iso.date().parse(text) : null;
      break;
    }
    case "short_text": {
      const text = String(raw ?? "").trim();
      value = text ? z.string().max(500).parse(text) : null;
      break;
    }
    case "long_text": {
      const text = String(raw ?? "").trim();
      value = text ? z.string().max(10_000).parse(text) : null;
      break;
    }
  }
  const empty = value === null || (Array.isArray(value) && value.length === 0);
  if (definition.required && empty) {
    throw new EventFieldStateError(`${definition.label} is required.`, 422);
  }
  return value;
}

export class EventFieldStateError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "EventFieldStateError";
  }
}

export class EventFieldService {
  constructor(private readonly env: CloudflareEnvironment) {}

  async configuration(viewer: Viewer) {
    assertAdministrator(viewer);
    const [policies, definitions] = await Promise.all([
      this.profilePolicies(viewer),
      this.env.DB.prepare(
        `SELECT definition.id, definition.owner_type AS ownerType,
                definition.field_key AS fieldKey, definition.label,
                definition.field_type AS fieldType,
                definition.options_json AS optionsJson,
                definition.participant_access AS participantAccess,
                definition.required, definition.position, definition.status,
                definition.revision, 0 AS valueRevision, NULL AS valueJson
           FROM event_field_definitions definition
           JOIN events event
             ON event.id = definition.event_id AND event.organisation_id = ?
          WHERE definition.event_id = ?
          ORDER BY definition.owner_type, definition.position, definition.label`,
      )
        .bind(viewer.organisationId, viewer.eventId)
        .all<DefinitionRow>(),
    ]);
    return { policies, definitions: definitions.results.map(mapDefinition) };
  }

  async profilePolicies(viewer: ParticipantProfileScope) {
    const rows = await this.env.DB.prepare(
      `SELECT policy.field_key AS fieldKey,
              policy.participant_access AS participantAccess
         FROM event_participant_field_policies policy
         JOIN events event
           ON event.id = policy.event_id AND event.organisation_id = ?
        WHERE policy.event_id = ?`,
    )
      .bind(viewer.organisationId, viewer.eventId)
      .all<{
        fieldKey: FixedParticipantProfileFieldKey;
        participantAccess: ParticipantFieldAccess;
      }>();
    const saved = new Map(
      rows.results.map((row) => [row.fieldKey, row.participantAccess]),
    );
    return Object.fromEntries(
      fixedParticipantProfileFields.map((field) => [
        field.key,
        saved.get(field.key) ?? "editable",
      ]),
    ) as ParticipantProfilePolicies;
  }

  async protectParticipantProfilePatch<T extends object>(
    viewer: ParticipantProfileScope,
    personId: string,
    patch: T,
  ): Promise<T> {
    const [policies, current] = await Promise.all([
      this.profilePolicies(viewer),
      this.env.DB.prepare(
        `SELECT person.id
           FROM people person
          WHERE person.id = ?`,
      )
        .bind(personId)
        .first<ParticipantProfileRecord>(),
    ]);
    if (!current) {
      throw new Response("Participant profile not found.", { status: 404 });
    }
    const protectedPatch = { ...patch } as ParticipantProfileRecord;
    for (const field of fixedParticipantProfileFields) {
      if (policies[field.key] !== "editable") {
        delete protectedPatch[field.formName];
      }
    }
    return protectedPatch as T;
  }

  async participantVisibleProfile<T extends object>(
    viewer: ParticipantProfileScope,
    profile: T,
  ): Promise<Partial<T>> {
    const policies = await this.profilePolicies(viewer);
    return participantVisibleProfile(profile, policies);
  }

  async saveProfilePolicies(viewer: Viewer, form: FormData) {
    assertAdministrator(viewer);
    const statements = fixedParticipantProfileFields.map((field) => {
      const access = accessSchema.parse(form.get(`policy:${field.key}`));
      return this.env.DB.prepare(
        `INSERT INTO event_participant_field_policies (
           event_id, field_key, participant_access,
           updated_by_person_id, updated_at
         )
         SELECT event.id, ?, ?, ?, unixepoch()
           FROM events event
          WHERE event.id = ? AND event.organisation_id = ?
         ON CONFLICT(event_id, field_key) DO UPDATE SET
           participant_access = excluded.participant_access,
           updated_by_person_id = excluded.updated_by_person_id,
           updated_at = excluded.updated_at`,
      ).bind(
        field.key,
        access,
        viewer.personId,
        viewer.eventId,
        viewer.organisationId,
      );
    });
    await this.env.DB.batch(statements);
  }

  async createDefinition(viewer: Viewer, rawInput: unknown) {
    assertAdministrator(viewer);
    const input = createDefinitionSchema.parse(rawInput);
    const id = crypto.randomUUID();
    const result = await this.env.DB.prepare(
      `INSERT INTO event_field_definitions (
         id, event_id, owner_type, field_key, label, field_type,
         options_json, participant_access, required, position, status,
         created_by_person_id, updated_by_person_id, created_at, updated_at
       )
       SELECT ?, event.id, ?, ?, ?, ?, ?, ?, ?,
              COALESCE((
                SELECT MAX(position) + 1 FROM event_field_definitions
                 WHERE event_id = event.id AND owner_type = ?
              ), 0),
              'active', ?, ?, unixepoch(), unixepoch()
         FROM events event
        WHERE event.id = ? AND event.organisation_id = ?
       ON CONFLICT(event_id, owner_type, field_key) DO NOTHING`,
    )
      .bind(
        id,
        input.ownerType,
        input.fieldKey,
        input.label,
        input.fieldType,
        JSON.stringify(input.options),
        input.participantAccess,
        input.required ? 1 : 0,
        input.ownerType,
        viewer.personId,
        viewer.personId,
        viewer.eventId,
        viewer.organisationId,
      )
      .run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new EventFieldStateError(
        "A field with that key already exists for this record type.",
      );
    }
    return { id };
  }

  async archiveDefinition(viewer: Viewer, definitionId: string) {
    assertAdministrator(viewer);
    const id = z.uuid().parse(definitionId);
    const result = await this.env.DB.prepare(
      `UPDATE event_field_definitions
          SET status = 'archived', revision = revision + 1,
              updated_by_person_id = ?, updated_at = unixepoch()
        WHERE id = ? AND event_id = ? AND status = 'active'
          AND EXISTS (
            SELECT 1 FROM events
             WHERE id = event_field_definitions.event_id
               AND organisation_id = ?
          )`,
    )
      .bind(viewer.personId, id, viewer.eventId, viewer.organisationId)
      .run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new EventFieldStateError("That active field was not found.", 404);
    }
  }

  async values(
    viewer: Viewer,
    ownerType: EventFieldOwnerType,
    ownerId: string,
    participant = false,
  ) {
    if (
      participant &&
      (ownerType !== "person" || ownerId !== viewer.personId)
    ) {
      throw new Response("Participants can only read their own fields.", {
        status: 403,
      });
    }
    const ownerTable = ownerType === "person" ? "people" : "sessions";
    const ownerColumn = ownerType === "person" ? "person_id" : "session_id";
    const ownerScope =
      ownerType === "person"
        ? `EXISTS (
            SELECT 1 FROM event_speaker_workflows workflow
             WHERE workflow.event_id = definition.event_id
               AND workflow.person_id = ?
            UNION ALL
            SELECT 1 FROM session_speakers relationship
             WHERE relationship.event_id = definition.event_id
               AND relationship.person_id = ?
            UNION ALL
            SELECT 1 FROM submissions submission
             WHERE submission.event_id = definition.event_id
               AND submission.submitter_person_id = ?
            UNION ALL
            SELECT 1 FROM memberships membership
             WHERE membership.event_id = definition.event_id
               AND membership.person_id = ?
               AND membership.role IN ('speaker', 'submitter')
               AND membership.accepted_at IS NOT NULL
               AND membership.revoked_at IS NULL
          )`
        : `EXISTS (
            SELECT 1 FROM ${ownerTable} owner
             WHERE owner.id = ? AND owner.event_id = definition.event_id
          )`;
    const ownerBindings =
      ownerType === "person" ? [ownerId, ownerId, ownerId, ownerId] : [ownerId];
    const result = await this.env.DB.prepare(
      `SELECT definition.id, definition.owner_type AS ownerType,
              definition.field_key AS fieldKey, definition.label,
              definition.field_type AS fieldType,
              definition.options_json AS optionsJson,
              definition.participant_access AS participantAccess,
              definition.required, definition.position, definition.status,
              definition.revision,
              COALESCE(value.revision, 0) AS valueRevision,
              value.value_json AS valueJson
         FROM event_field_definitions definition
         JOIN events event
           ON event.id = definition.event_id AND event.organisation_id = ?
         LEFT JOIN event_field_values value
           ON value.definition_id = definition.id
          AND value.event_id = definition.event_id
          AND value.${ownerColumn} = ?
        WHERE definition.event_id = ? AND definition.owner_type = ?
          AND definition.status = 'active'
          AND ${ownerScope}
          ${participant ? "AND definition.participant_access <> 'hidden'" : ""}
        ORDER BY definition.position, definition.label`,
    )
      .bind(
        viewer.organisationId,
        ownerId,
        viewer.eventId,
        ownerType,
        ...ownerBindings,
      )
      .all<DefinitionRow>();
    return result.results.map(mapDefinition);
  }

  async participantSessionValues(viewer: Viewer) {
    const result = await this.env.DB.prepare(
      `SELECT relationship.session_id AS sessionId,
              definition.id, definition.owner_type AS ownerType,
              definition.field_key AS fieldKey, definition.label,
              definition.field_type AS fieldType,
              definition.options_json AS optionsJson,
              definition.participant_access AS participantAccess,
              definition.required, definition.position, definition.status,
              definition.revision,
              COALESCE(value.revision, 0) AS valueRevision,
              value.value_json AS valueJson
         FROM session_speakers relationship
         JOIN sessions session
           ON session.id = relationship.session_id
          AND session.event_id = relationship.event_id
         JOIN events event
           ON event.id = relationship.event_id
          AND event.organisation_id = ?
         JOIN event_field_definitions definition
           ON definition.event_id = relationship.event_id
          AND definition.owner_type = 'session'
          AND definition.status = 'active'
          AND definition.participant_access <> 'hidden'
         LEFT JOIN event_field_values value
           ON value.definition_id = definition.id
          AND value.event_id = definition.event_id
          AND value.session_id = relationship.session_id
        WHERE relationship.event_id = ? AND relationship.person_id = ?
          AND session.status <> 'archived'
        ORDER BY relationship.session_id, definition.position,
                 definition.label`,
    )
      .bind(viewer.organisationId, viewer.eventId, viewer.personId)
      .all<ParticipantSessionDefinitionRow>();
    return result.results.map(({ sessionId, ...definition }) => ({
      sessionId,
      ...mapDefinition(definition),
    }));
  }

  async saveValues(
    viewer: Viewer,
    ownerType: EventFieldOwnerType,
    ownerId: string,
    form: FormData,
    participant = false,
  ) {
    if (participant) {
      if (ownerType !== "person" || ownerId !== viewer.personId) {
        throw new Response("Participants can only edit their own fields.", {
          status: 403,
        });
      }
    } else {
      assertAdministrator(viewer);
    }
    const definitions = await this.values(
      viewer,
      ownerType,
      ownerId,
      participant,
    );
    const editable = participant
      ? definitions.filter(
          (definition) => definition.participantAccess === "editable",
        )
      : definitions;
    const ownerColumn = ownerType === "person" ? "person_id" : "session_id";
    const statements = editable.map((definition) => {
      const value = valueForDefinition(definition, form);
      const expectedRevision = z.coerce
        .number()
        .int()
        .nonnegative()
        .parse(form.get(`fieldRevision:${definition.id}`));
      const storedValue =
        value === null || (Array.isArray(value) && value.length === 0)
          ? null
          : value;
      // The migration's conflict trigger reads the expected revision from the
      // incoming updated_at value, then restores a real timestamp after the
      // atomic insert/update succeeds.
      return this.env.DB.prepare(
        `INSERT INTO event_field_values (
             definition_id, event_id, ${ownerColumn}, value_json,
             revision, updated_by_person_id, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(definition_id, ${ownerColumn})
             WHERE ${ownerColumn} IS NOT NULL
           DO UPDATE SET value_json = excluded.value_json,
                         revision = event_field_values.revision + 1,
                         updated_by_person_id = excluded.updated_by_person_id,
                         updated_at = excluded.updated_at
           WHERE event_field_values.event_id = excluded.event_id`,
      ).bind(
        definition.id,
        viewer.eventId,
        ownerId,
        JSON.stringify(storedValue),
        1,
        viewer.personId,
        expectedRevision,
      );
    });
    try {
      if (statements.length) await this.env.DB.batch(statements);
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.includes("event field value revision conflict")
      ) {
        throw new EventFieldStateError(
          "These event fields changed after this page loaded. Refresh before saving again.",
        );
      }
      throw error;
    }
  }

  async participantProfileInput(viewer: Viewer, form: FormData) {
    return this.protectParticipantProfilePatch(
      viewer,
      viewer.personId,
      Object.fromEntries(
        fixedParticipantProfileFields
          .filter((field) => form.has(field.formName))
          .map((field) => [field.formName, form.get(field.formName)]),
      ),
    );
  }
}
