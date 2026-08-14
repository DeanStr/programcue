import { z } from "zod";

import type { AirtableEventDataTableKey } from "./airtable-schema";

export const text = z.string();
export const nullableText = z.string().nullable();
export const integer = z.number().int();
export const nullableInteger = z.number().int().nullable();
export const booleanInteger = z.union([z.literal(0), z.literal(1)]);
export const jsonText = z.string().refine((value) => {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}, "must contain valid JSON");
export const jsonArrayText = jsonText.refine((value) => {
  try {
    return Array.isArray(JSON.parse(value));
  } catch {
    return false;
  }
}, "must contain a JSON array");
export const nullableJsonText = z
  .string()
  .nullable()
  .refine((value) => value === null || jsonText.safeParse(value).success, {
    message: "must be null or valid JSON",
  });

export const eventRecord = { id: text.min(1), event_id: text.min(1) } as const;
export const timestamps = { created_at: integer, updated_at: integer } as const;

export type AirtableEventDataDomain =
  | "event_setup"
  | "forms"
  | "submissions"
  | "evaluations"
  | "sessions"
  | "tasks";

export type AirtableEventTableSpec = {
  key: AirtableEventDataTableKey;
  domain: AirtableEventDataDomain;
  entityType: string;
  query: string;
  schema: z.ZodType<Record<string, unknown>>;
  entityId: (row: Record<string, unknown>) => string;
  revision: (row: Record<string, unknown>) => number;
};

export function id(value: Record<string, unknown>) {
  return String(value.id);
}

export function revision(value: Record<string, unknown>) {
  return typeof value.revision === "number" ? value.revision : 1;
}
