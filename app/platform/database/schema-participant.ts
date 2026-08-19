import { desc, sql } from "drizzle-orm";
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

export const taskTemplates = sqliteTable(
  "task_templates",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").references(() => events.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    description: text("description"),
    targetType: text("target_type")
      .notNull()
      .$type<"speaker" | "session" | "event">(),
    taskType: text("task_type")
      .notNull()
      .default("checklist")
      .$type<
        | "checklist"
        | "acknowledgement"
        | "short_form"
        | "file_upload"
        | "link_visit"
        | "administrator_only"
      >(),
    impact: text("impact")
      .notNull()
      .$type<"critical" | "high" | "medium" | "low">(),
    evidenceMode: text("evidence_mode")
      .notNull()
      .default("none")
      .$type<
        "none" | "checkbox" | "file" | "text" | "link" | "admin_approval"
      >(),
    dueAnchor: text("due_anchor")
      .notNull()
      .default("none")
      .$type<"none" | "acceptance" | "session_start" | "fixed">(),
    dueOffsetMinutes: integer("due_offset_minutes"),
    fixedDueAt: integer("fixed_due_at"),
    autoAssignOnAcceptance: integer("auto_assign_on_acceptance", {
      mode: "boolean",
    }).notNull(),
    configurationJson: text("configuration_json").notNull().default("{}"),
    status: text("status")
      .notNull()
      .default("active")
      .$type<"active" | "archived">(),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    check(
      "task_templates_fixed_due_check",
      sql`${table.dueAnchor} <> 'fixed' OR ${table.fixedDueAt} IS NOT NULL`,
    ),
    check(
      "task_templates_relative_due_check",
      sql`${table.dueAnchor} NOT IN ('acceptance','session_start') OR ${table.dueOffsetMinutes} IS NOT NULL`,
    ),
    check(
      "task_templates_auto_assign_check",
      sql`${table.autoAssignOnAcceptance} = 0 OR ${table.dueAnchor} <> 'session_start'`,
    ),
  ],
);

export const taskTemplateDependencies = sqliteTable(
  "task_template_dependencies",
  {
    templateId: text("template_id")
      .notNull()
      .references(() => taskTemplates.id, { onDelete: "cascade" }),
    dependsOnTemplateId: text("depends_on_template_id")
      .notNull()
      .references(() => taskTemplates.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull().default(epochNow),
  },
  (table) => [
    primaryKey({ columns: [table.templateId, table.dependsOnTemplateId] }),
  ],
);

export const taskInstances = sqliteTable(
  "task_instances",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    templateId: text("template_id").references(() => taskTemplates.id),
    targetType: text("target_type")
      .notNull()
      .$type<"speaker" | "session" | "event">(),
    targetId: text("target_id").notNull(),
    ownerPersonId: text("owner_person_id").references(() => people.id),
    title: text("title").notNull(),
    description: text("description"),
    taskType: text("task_type")
      .notNull()
      .default("checklist")
      .$type<
        | "checklist"
        | "acknowledgement"
        | "short_form"
        | "file_upload"
        | "link_visit"
        | "administrator_only"
      >(),
    impact: text("impact")
      .notNull()
      .$type<"critical" | "high" | "medium" | "low">(),
    status: text("status")
      .notNull()
      .default("not_started")
      .$type<
        | "not_started"
        | "in_progress"
        | "blocked"
        | "submitted"
        | "completed"
        | "waived"
        | "overdue"
      >(),
    readinessState: text("readiness_state")
      .notNull()
      .default("on_track")
      .$type<"on_track" | "at_risk" | "overdue" | "blocked">(),
    readinessPercent: integer("readiness_percent").notNull().default(0),
    revision: integer("revision").notNull().default(1),
    lastOperationId: text("last_operation_id"),
    idempotencyKey: text("idempotency_key"),
    dueAt: integer("due_at"),
    evidenceJson: text("evidence_json"),
    waiverJson: text("waiver_json"),
    submittedAt: integer("submitted_at"),
    completedAt: integer("completed_at"),
    completedByPersonId: text("completed_by_person_id").references(
      () => people.id,
    ),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    index("idx_tasks_event_status_due").on(
      table.eventId,
      table.status,
      table.dueAt,
    ),
    index("idx_tasks_target").on(
      table.eventId,
      table.targetType,
      table.targetId,
      table.status,
    ),
    index("idx_tasks_owner_status").on(
      table.eventId,
      table.ownerPersonId,
      table.status,
    ),
    uniqueIndex("ux_task_instances_template_target")
      .on(table.eventId, table.templateId, table.targetType, table.targetId)
      .where(sql`${table.templateId} IS NOT NULL`),
    uniqueIndex("idx_task_idempotency")
      .on(table.eventId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
  ],
);

export const taskInstanceDependencies = sqliteTable(
  "task_instance_dependencies",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => taskInstances.id, { onDelete: "cascade" }),
    dependsOnTaskId: text("depends_on_task_id")
      .notNull()
      .references(() => taskInstances.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull().default(epochNow),
  },
  (table) => [primaryKey({ columns: [table.taskId, table.dependsOnTaskId] })],
);

export const taskComments = sqliteTable(
  "task_comments",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => taskInstances.id, { onDelete: "cascade" }),
    authorPersonId: text("author_person_id")
      .notNull()
      .references(() => people.id),
    body: text("body").notNull(),
    visibility: text("visibility")
      .notNull()
      .default("participant")
      .$type<"participant" | "administrator">(),
    createdAt: integer("created_at").notNull().default(epochNow),
    editedAt: integer("edited_at"),
  },
  (table) => [
    index("idx_task_comments_task").on(table.taskId, table.createdAt),
  ],
);

export const fileAssets = sqliteTable(
  "file_assets",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    ownerPersonId: text("owner_person_id").references(() => people.id),
    targetType: text("target_type")
      .notNull()
      .$type<"person" | "submission" | "session" | "task" | "resource">(),
    targetId: text("target_id").notNull(),
    assetKind: text("asset_kind")
      .notNull()
      .$type<
        | "headshot"
        | "slides"
        | "video"
        | "supporting_document"
        | "resource_attachment"
        | "task_evidence"
        | "other"
      >(),
    currentVersionId: text("current_version_id"),
    status: text("status")
      .notNull()
      .default("pending")
      .$type<"pending" | "active" | "rejected" | "deleted">(),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    index("idx_files_target").on(
      table.eventId,
      table.targetType,
      table.targetId,
      table.status,
    ),
    index("idx_files_owner_status").on(
      table.eventId,
      table.ownerPersonId,
      table.status,
    ),
    index("idx_file_assets_event_updated").on(
      table.eventId,
      desc(table.updatedAt),
      table.id,
    ),
    uniqueIndex("ux_file_assets_logical_active")
      .on(
        table.eventId,
        table.ownerPersonId,
        table.targetType,
        table.targetId,
        table.assetKind,
      )
      .where(
        sql`${table.status} <> 'deleted' AND ${table.targetType} NOT IN ('task','resource')`,
      ),
    uniqueIndex("ux_file_assets_current_version")
      .on(table.currentVersionId)
      .where(sql`${table.currentVersionId} IS NOT NULL`),
  ],
);

export const fileVersions = sqliteTable(
  "file_versions",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    assetId: text("asset_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    objectKey: text("object_key").notNull(),
    multipartUploadId: text("multipart_upload_id"),
    originalFilename: text("original_filename").notNull(),
    declaredContentType: text("declared_content_type").notNull(),
    detectedContentType: text("detected_content_type"),
    sizeBytes: integer("size_bytes").notNull(),
    checksumSha256: text("checksum_sha256"),
    objectEtag: text("object_etag"),
    uploadStatus: text("upload_status")
      .notNull()
      .default("requested")
      .$type<"requested" | "uploading" | "uploaded" | "failed" | "aborted">(),
    signatureStatus: text("signature_status")
      .notNull()
      .default("pending")
      .$type<"pending" | "valid" | "invalid" | "failed">(),
    scanStatus: text("scan_status")
      .notNull()
      .default("pending")
      .$type<"pending" | "clean" | "infected" | "failed">(),
    scanProvider: text("scan_provider"),
    scanResultJson: text("scan_result_json"),
    scanError: text("scan_error"),
    createdByPersonId: text("created_by_person_id").references(() => people.id),
    createdAt: integer("created_at").notNull().default(epochNow),
    uploadedAt: integer("uploaded_at"),
    scannedAt: integer("scanned_at"),
    releasedAt: integer("released_at"),
    replacedAt: integer("replaced_at"),
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    foreignKey({
      columns: [table.assetId, table.eventId],
      foreignColumns: [fileAssets.id, fileAssets.eventId],
    }).onDelete("cascade"),
    uniqueIndex("file_versions_asset_version_unique").on(
      table.assetId,
      table.versionNumber,
    ),
    uniqueIndex("file_versions_id_event_asset_unique").on(
      table.id,
      table.eventId,
      table.assetId,
    ),
    uniqueIndex("file_versions_object_key_unique").on(table.objectKey),
    index("idx_file_versions_release").on(
      table.assetId,
      table.scanStatus,
      table.releasedAt,
      table.versionNumber,
    ),
  ],
);

export const fileMultipartUploads = sqliteTable(
  "file_multipart_uploads",
  {
    versionId: text("version_id").primaryKey(),
    eventId: text("event_id").notNull(),
    assetId: text("asset_id").notNull(),
    uploadId: text("upload_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status")
      .notNull()
      .default("requested")
      .$type<
        | "requested"
        | "initiated"
        | "completing"
        | "completed"
        | "aborted"
        | "failed"
      >(),
    partSizeBytes: integer("part_size_bytes").notNull(),
    manifestJson: text("manifest_json"),
    manifestHash: text("manifest_hash"),
    expiresAt: integer("expires_at").notNull(),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    foreignKey({
      columns: [table.versionId, table.eventId, table.assetId],
      foreignColumns: [
        fileVersions.id,
        fileVersions.eventId,
        fileVersions.assetId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.assetId, table.eventId],
      foreignColumns: [fileAssets.id, fileAssets.eventId],
    }).onDelete("cascade"),
    uniqueIndex("ux_file_multipart_upload_id").on(table.uploadId),
    uniqueIndex("ux_file_multipart_idempotency").on(
      table.eventId,
      table.idempotencyKey,
    ),
    index("idx_file_multipart_status_expiry").on(table.status, table.expiresAt),
  ],
);

export const taskEvidence = sqliteTable(
  "task_evidence",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => taskInstances.id, { onDelete: "cascade" }),
    submittedByPersonId: text("submitted_by_person_id")
      .notNull()
      .references(() => people.id),
    fileAssetId: text("file_asset_id").references(() => fileAssets.id),
    evidenceJson: text("evidence_json").notNull().default("{}"),
    status: text("status")
      .notNull()
      .default("submitted")
      .$type<"submitted" | "approved" | "rejected" | "superseded">(),
    reviewedByPersonId: text("reviewed_by_person_id").references(
      () => people.id,
    ),
    createdAt: integer("created_at").notNull().default(epochNow),
    reviewedAt: integer("reviewed_at"),
  },
  (table) => [
    index("idx_task_evidence_task").on(
      table.taskId,
      table.status,
      table.createdAt,
    ),
  ],
);

export const resourcePages = sqliteTable(
  "resource_pages",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    category: text("category"),
    status: text("status")
      .notNull()
      .default("draft")
      .$type<"draft" | "published" | "archived">(),
    audienceScope: text("audience_scope")
      .notNull()
      .default("all_speakers")
      .$type<
        "all_speakers" | "accepted_speakers" | "confirmed_speakers" | "custom"
      >(),
    acknowledgementRequired: integer("acknowledgement_required", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    revision: integer("revision").notNull().default(1),
    lastOperationId: text("last_operation_id"),
    createdByPersonId: text("created_by_person_id").references(() => people.id),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
    archivedAt: integer("archived_at"),
  },
  (table) => [
    uniqueIndex("resource_pages_event_slug_unique").on(
      table.eventId,
      table.slug,
    ),
    index("idx_resource_pages_audience").on(
      table.eventId,
      table.status,
      table.audienceScope,
    ),
  ],
);

export const resourcePageVersions = sqliteTable(
  "resource_page_versions",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    resourcePageId: text("resource_page_id")
      .notNull()
      .references(() => resourcePages.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    category: text("category"),
    audienceScope: text("audience_scope")
      .notNull()
      .default("all_speakers")
      .$type<
        "all_speakers" | "accepted_speakers" | "confirmed_speakers" | "custom"
      >(),
    acknowledgementRequired: integer("acknowledgement_required", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    documentJson: text("document_json").notNull(),
    renderedHtml: text("rendered_html").notNull(),
    status: text("status")
      .notNull()
      .default("draft")
      .$type<"draft" | "published" | "retired">(),
    createdByPersonId: text("created_by_person_id").references(() => people.id),
    createdAt: integer("created_at").notNull().default(epochNow),
    publishedAt: integer("published_at"),
  },
  (table) => [
    uniqueIndex("resource_page_versions_number_unique").on(
      table.resourcePageId,
      table.versionNumber,
    ),
    uniqueIndex("ux_resource_versions_one_published")
      .on(table.resourcePageId)
      .where(sql`${table.status} = 'published'`),
  ],
);

export const resourceAudiences = sqliteTable(
  "resource_audiences",
  {
    resourcePageVersionId: text("resource_page_version_id")
      .notNull()
      .references(() => resourcePageVersions.id, { onDelete: "cascade" }),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    targetType: text("target_type")
      .notNull()
      .$type<"role" | "team" | "person" | "session" | "track">(),
    targetId: text("target_id").notNull(),
    createdAt: integer("created_at").notNull().default(epochNow),
  },
  (table) => [
    primaryKey({
      columns: [table.resourcePageVersionId, table.targetType, table.targetId],
    }),
  ],
);

export const resourceAttachments = sqliteTable(
  "resource_attachments",
  {
    resourcePageVersionId: text("resource_page_version_id")
      .notNull()
      .references(() => resourcePageVersions.id, { onDelete: "cascade" }),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    fileAssetId: text("file_asset_id")
      .notNull()
      .references(() => fileAssets.id),
    position: integer("position").notNull().default(0),
    label: text("label"),
  },
  (table) => [
    primaryKey({ columns: [table.resourcePageVersionId, table.fileAssetId] }),
  ],
);

export const resourceAcknowledgements = sqliteTable(
  "resource_acknowledgements",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    resourcePageId: text("resource_page_id")
      .notNull()
      .references(() => resourcePages.id, { onDelete: "cascade" }),
    resourcePageVersionId: text("resource_page_version_id")
      .notNull()
      .references(() => resourcePageVersions.id),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    acknowledgedAt: integer("acknowledged_at").notNull().default(epochNow),
    userAgent: text("user_agent"),
  },
  (table) => [
    uniqueIndex("resource_acknowledgements_person_unique").on(
      table.resourcePageVersionId,
      table.personId,
    ),
    index("idx_resource_ack_person").on(
      table.eventId,
      table.personId,
      table.acknowledgedAt,
    ),
  ],
);
