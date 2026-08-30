import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { events, people } from "./schema-core";
import { epochNow } from "./schema-helpers";
import { sessions } from "./schema-schedule";

export const eventParticipantFieldPolicies = sqliteTable(
  "event_participant_field_policies",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    fieldKey: text("field_key")
      .notNull()
      .$type<
        | "name"
        | "biography"
        | "pronunciation"
        | "organisation_name"
        | "job_title"
        | "linkedin_url"
        | "x_handle"
        | "travel_preferences"
      >(),
    participantAccess: text("participant_access")
      .notNull()
      .default("editable")
      .$type<"hidden" | "read_only" | "editable">(),
    updatedByPersonId: text("updated_by_person_id")
      .notNull()
      .references(() => people.id),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [primaryKey({ columns: [table.eventId, table.fieldKey] })],
);

export const eventFieldDefinitions = sqliteTable(
  "event_field_definitions",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    ownerType: text("owner_type").notNull().$type<"person" | "session">(),
    fieldKey: text("field_key").notNull(),
    label: text("label").notNull(),
    fieldType: text("field_type")
      .notNull()
      .$type<
        | "short_text"
        | "long_text"
        | "number"
        | "boolean"
        | "date"
        | "single_choice"
        | "multiple_choice"
      >(),
    optionsJson: text("options_json").notNull().default("[]"),
    participantAccess: text("participant_access")
      .notNull()
      .default("read_only")
      .$type<"hidden" | "read_only" | "editable">(),
    required: integer("required", { mode: "boolean" }).notNull().default(false),
    position: integer("position").notNull().default(0),
    status: text("status")
      .notNull()
      .default("active")
      .$type<"active" | "archived">(),
    revision: integer("revision").notNull().default(1),
    createdByPersonId: text("created_by_person_id")
      .notNull()
      .references(() => people.id),
    updatedByPersonId: text("updated_by_person_id")
      .notNull()
      .references(() => people.id),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("event_field_definitions_scope_key_unique").on(
      table.eventId,
      table.ownerType,
      table.fieldKey,
    ),
    uniqueIndex("event_field_definitions_id_event_unique").on(
      table.id,
      table.eventId,
    ),
    index("idx_event_field_definitions_owner").on(
      table.eventId,
      table.ownerType,
      table.status,
      table.position,
      table.label,
    ),
    check(
      "event_field_definitions_options_json_check",
      sql`json_valid(${table.optionsJson})`,
    ),
  ],
);

export const eventFieldValues = sqliteTable(
  "event_field_values",
  {
    definitionId: text("definition_id").notNull(),
    eventId: text("event_id").notNull(),
    personId: text("person_id").references(() => people.id),
    sessionId: text("session_id").references(() => sessions.id, {
      onDelete: "cascade",
    }),
    valueJson: text("value_json").notNull(),
    revision: integer("revision").notNull().default(1),
    updatedByPersonId: text("updated_by_person_id")
      .notNull()
      .references(() => people.id),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    foreignKey({
      columns: [table.definitionId, table.eventId],
      foreignColumns: [eventFieldDefinitions.id, eventFieldDefinitions.eventId],
    }).onDelete("cascade"),
    uniqueIndex("ux_event_field_values_person")
      .on(table.definitionId, table.personId)
      .where(sql`${table.personId} IS NOT NULL`),
    uniqueIndex("ux_event_field_values_session")
      .on(table.definitionId, table.sessionId)
      .where(sql`${table.sessionId} IS NOT NULL`),
    index("idx_event_field_values_event_person")
      .on(table.eventId, table.personId, table.definitionId)
      .where(sql`${table.personId} IS NOT NULL`),
    index("idx_event_field_values_event_session")
      .on(table.eventId, table.sessionId, table.definitionId)
      .where(sql`${table.sessionId} IS NOT NULL`),
    check("event_field_values_json_check", sql`json_valid(${table.valueJson})`),
    check("event_field_values_revision_check", sql`${table.revision} > 0`),
    check(
      "event_field_values_owner_check",
      sql`(${table.personId} IS NOT NULL) <> (${table.sessionId} IS NOT NULL)`,
    ),
  ],
);
