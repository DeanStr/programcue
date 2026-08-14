import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { events, organisations, people } from "./schema-core";
import { epochNow } from "./schema-helpers";

export const authSessions = sqliteTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
  },
  (table) => [
    uniqueIndex("auth_sessions_token_unique").on(table.token),
    index("idx_auth_sessions_person_expiry").on(table.userId, table.expiresAt),
  ],
);

export const authAccounts = sqliteTable(
  "auth_accounts",
  {
    id: text("id").primaryKey(),
    userId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    accountId: text("account_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", {
      mode: "timestamp",
    }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", {
      mode: "timestamp",
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    uniqueIndex("auth_accounts_provider_account_unique").on(
      table.providerId,
      table.accountId,
    ),
  ],
);

export const verificationTokens = sqliteTable(
  "verification_tokens",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("idx_verification_identifier_expiry").on(
      table.identifier,
      table.expiresAt,
    ),
  ],
);

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    eventId: text("event_id").references(() => events.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at"),
    revokedAt: integer("revoked_at"),
    createdByPersonId: text("created_by_person_id").references(() => people.id),
    createdAt: integer("created_at").notNull().default(epochNow),
    lastUsedAt: integer("last_used_at"),
  },
  (table) => [
    uniqueIndex("api_keys_hash_unique").on(table.keyHash),
    uniqueIndex("ux_api_keys_event_active_name")
      .on(table.eventId, table.name)
      .where(sql`${table.revokedAt} IS NULL`),
    index("idx_api_keys_event").on(
      table.eventId,
      table.revokedAt,
      table.expiresAt,
    ),
  ],
);

export const authSchema = {
  user: people,
  session: authSessions,
  account: authAccounts,
  verification: verificationTokens,
};
