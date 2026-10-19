import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { communicationTemplateVersions } from "./schema-communications";
import { events, people } from "./schema-core";
import { epochNow } from "./schema-helpers";
import { fileVersions } from "./schema-participant";
import { sessions } from "./schema-schedule";

export const eventSponsorships = sqliteTable(
  "event_sponsorships",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull(),
    eventId: text("event_id").notNull(),
    name: text("name").notNull(),
    tier: text("tier").notNull().default(""),
    description: text("description").notNull().default(""),
    websiteUrl: text("website_url").notNull().default(""),
    logoUrl: text("logo_url").notNull().default(""),
    sessionLimit: integer("session_limit").notNull(),
    closesAt: integer("closes_at"),
    status: text("status")
      .notNull()
      .default("active")
      .$type<"active" | "archived">(),
    revision: integer("revision").notNull().default(1),
    invitationTemplateVersionId: text(
      "invitation_template_version_id",
    ).references(() => communicationTemplateVersions.id),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    foreignKey({
      columns: [table.eventId, table.organisationId],
      foreignColumns: [events.id, events.organisationId],
    }).onDelete("cascade"),
    uniqueIndex("sponsorships_id_event_unique").on(table.id, table.eventId),
    uniqueIndex("sponsorships_event_name_unique").on(table.eventId, table.name),
    index("idx_sponsorships_event").on(table.eventId, table.status, table.name),
    check(
      "sponsorship_name",
      sql`length(trim(${table.name})) BETWEEN 1 AND 160`,
    ),
    check("sponsorship_tier", sql`length(${table.tier}) <= 80`),
    check("sponsorship_description", sql`length(${table.description}) <= 3000`),
    check("sponsorship_limit", sql`${table.sessionLimit} BETWEEN 0 AND 100`),
    check("sponsorship_status", sql`${table.status} IN ('active','archived')`),
    check("sponsorship_revision", sql`${table.revision} > 0`),
  ],
);

export const sponsorContacts = sqliteTable(
  "sponsor_contacts",
  {
    id: text("id").primaryKey(),
    sponsorId: text("sponsor_id").notNull(),
    eventId: text("event_id").notNull(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    acceptedAt: integer("accepted_at"),
    revokedAt: integer("revoked_at"),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at").notNull().default(epochNow),
  },
  (table) => [
    foreignKey({
      columns: [table.sponsorId, table.eventId],
      foreignColumns: [eventSponsorships.id, eventSponsorships.eventId],
    }).onDelete("cascade"),
    uniqueIndex("sponsor_contacts_email_unique").on(
      table.sponsorId,
      sql`${table.email} COLLATE NOCASE`,
    ),
    index("idx_sponsor_contacts_email").on(table.email, table.revokedAt),
    check(
      "sponsor_contact_email",
      sql`length(${table.email}) BETWEEN 3 AND 254`,
    ),
    check(
      "sponsor_contact_name",
      sql`length(trim(${table.name})) BETWEEN 1 AND 120`,
    ),
    check("sponsor_contact_revision", sql`${table.revision} > 0`),
  ],
);

export const sponsoredSessionProposals = sqliteTable(
  "sponsored_session_proposals",
  {
    id: text("id").primaryKey(),
    sponsorId: text("sponsor_id").notNull(),
    eventId: text("event_id").notNull(),
    detailsJson: text("details_json").notNull(),
    status: text("status")
      .notNull()
      .default("draft")
      .$type<"draft" | "submitted" | "accepted" | "withdrawn">(),
    revision: integer("revision").notNull().default(1),
    sessionId: text("session_id"),
    createdByPersonId: text("created_by_person_id")
      .notNull()
      .references(() => people.id),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    foreignKey({
      columns: [table.sponsorId, table.eventId],
      foreignColumns: [eventSponsorships.id, eventSponsorships.eventId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.sessionId, table.eventId],
      foreignColumns: [sessions.id, sessions.eventId],
    }),
    uniqueIndex("sponsored_proposals_session_unique").on(table.sessionId),
    index("idx_sponsored_sessions_company").on(table.sponsorId, table.status),
    check(
      "sponsored_proposal_details",
      sql`json_valid(${table.detailsJson}) AND json_type(${table.detailsJson})='object' AND length(${table.detailsJson}) <= 150000`,
    ),
    check(
      "sponsored_proposal_status",
      sql`${table.status} IN ('draft','submitted','accepted','withdrawn')`,
    ),
    check("sponsored_proposal_revision", sql`${table.revision}>0`),
    check(
      "sponsored_proposal_acceptance",
      sql`(${table.status}='accepted' AND ${table.sessionId} IS NOT NULL) OR (${table.status}<>'accepted' AND ${table.sessionId} IS NULL)`,
    ),
  ],
);

export const sponsorAssetRequests = sqliteTable(
  "sponsor_asset_requests",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    sponsorId: text("sponsor_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull().$type<"logo" | "document">(),
    required: integer("required").notNull().default(1),
    reviewStatus: text("review_status")
      .notNull()
      .default("pending")
      .$type<"pending" | "approved" | "changes_requested">(),
    reviewedVersionId: text("reviewed_version_id"),
    reviewNote: text("review_note").notNull().default(""),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("sponsor_asset_requests_id_event_unique").on(
      table.id,
      table.eventId,
    ),
    index("sponsor_asset_requests_company").on(table.eventId, table.sponsorId),
    foreignKey({
      columns: [table.sponsorId, table.eventId],
      foreignColumns: [eventSponsorships.id, eventSponsorships.eventId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.reviewedVersionId, table.eventId],
      foreignColumns: [fileVersions.id, fileVersions.eventId],
    }),
    check("sponsor_asset_request_id", sql`${table.id} GLOB 'sponsor-asset-*'`),
    check("sponsor_asset_kind", sql`${table.kind} IN ('logo','document')`),
    check("sponsor_asset_required", sql`${table.required} IN (0,1)`),
    check(
      "sponsor_asset_review",
      sql`${table.reviewStatus} IN ('pending','approved','changes_requested')`,
    ),
  ],
);
