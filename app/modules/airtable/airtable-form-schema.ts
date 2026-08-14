import { z } from "zod";
import type { AirtableEventTableSpec } from "./airtable-event-data-schema-shared";
import {
  eventRecord,
  id,
  integer,
  jsonText,
  nullableInteger,
  nullableText,
  revision,
  text,
  timestamps,
} from "./airtable-event-data-schema-shared";

export const AIRTABLE_FORM_TABLE_SPECS: readonly AirtableEventTableSpec[] = [
  {
    key: "forms",
    domain: "forms",
    entityType: "form_definition",
    query: `SELECT id, event_id, name, description, kind, status, public_slug,
                   closes_at, submission_limit, min_speakers, max_speakers,
                   access_mode, confirmation_template_id, revision,
                   created_by_person_id, archived_at, created_at, updated_at
              FROM form_definitions WHERE event_id = ? ORDER BY id`,
    schema: z
      .object({
        ...eventRecord,
        name: text.min(1),
        description: nullableText,
        kind: z.enum(["submission", "direct_session"]),
        status: z.enum(["draft", "published", "closed", "archived"]),
        public_slug: text.min(1),
        closes_at: nullableInteger,
        submission_limit: nullableInteger,
        min_speakers: integer,
        max_speakers: nullableInteger,
        access_mode: z.enum([
          "email_verified",
          "account_required",
          "password_protected",
        ]),
        confirmation_template_id: nullableText,
        revision: integer.positive(),
        created_by_person_id: nullableText,
        archived_at: nullableInteger,
        ...timestamps,
      })
      .strict(),
    entityId: id,
    revision,
  },
  {
    key: "formVersions",
    domain: "forms",
    entityType: "form_version",
    query: `SELECT id, event_id, form_id, version_number, schema_json,
                   routing_json, settings_snapshot_json, status, revision,
                   published_at, retired_at, created_by_person_id,
                   created_at, updated_at
              FROM form_versions WHERE event_id = ? ORDER BY id`,
    schema: z
      .object({
        ...eventRecord,
        form_id: text.min(1),
        version_number: integer.positive(),
        schema_json: jsonText,
        routing_json: jsonText,
        settings_snapshot_json: jsonText,
        status: z.enum(["draft", "published", "retired"]),
        revision: integer.positive(),
        published_at: nullableInteger,
        retired_at: nullableInteger,
        created_by_person_id: nullableText,
        ...timestamps,
      })
      .strict(),
    entityId: id,
    revision,
  },
] as const;
