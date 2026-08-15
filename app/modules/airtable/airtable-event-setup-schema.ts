import { z } from "zod";
import type { AirtableEventTableSpec } from "./airtable-event-data-schema-shared";
import {
  booleanInteger,
  eventRecord,
  id,
  integer,
  jsonText,
  nullableText,
  text,
} from "./airtable-event-data-schema-shared";

export const AIRTABLE_EVENT_SETUP_TABLE_SPECS: readonly AirtableEventTableSpec[] =
  [
    {
      key: "eventConfiguration",
      domain: "event_setup",
      entityType: "event_configuration",
      query: `SELECT id, id AS event_id, name, slug, timezone, starts_at,
                   ends_at, venue_name, venue_address, venue_map_url,
                   programme_hero_image_url, city, description, brand_accent,
                   participant_logo_url, participant_welcome_text,
                   participant_support_url,
                   session_formats_json, file_policy_json,
                   submission_access_mode,
                   allow_anonymous_drafts, duplicate_person_warnings
              FROM events WHERE id = ?`,
      schema: z
        .object({
          ...eventRecord,
          name: text.min(1),
          slug: text.min(1),
          timezone: text.min(1),
          starts_at: integer,
          ends_at: integer,
          venue_name: nullableText,
          venue_address: nullableText,
          venue_map_url: nullableText,
          programme_hero_image_url: nullableText,
          city: nullableText,
          description: nullableText,
          brand_accent: text.regex(/^#[0-9a-fA-F]{6}$/),
          participant_logo_url: nullableText,
          participant_welcome_text: nullableText,
          participant_support_url: nullableText,
          session_formats_json: jsonText,
          file_policy_json: jsonText,
          submission_access_mode: z.enum([
            "email_verified",
            "account_required",
            "password_protected",
          ]),
          allow_anonymous_drafts: booleanInteger,
          duplicate_person_warnings: booleanInteger,
        })
        .strict(),
      entityId: id,
      revision: () => 1,
    },
    {
      key: "tracks",
      domain: "event_setup",
      entityType: "track",
      query: `SELECT id, event_id, name, slug, colour_token, position,
                   exclusive, is_public
              FROM tracks WHERE event_id = ? ORDER BY id`,
      schema: z
        .object({
          ...eventRecord,
          name: text.min(1),
          slug: text.min(1),
          colour_token: nullableText,
          position: integer.nonnegative(),
          exclusive: booleanInteger,
          is_public: booleanInteger,
        })
        .strict(),
      entityId: id,
      revision: () => 1,
    },
  ] as const;
