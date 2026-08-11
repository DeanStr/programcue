import { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";

const bulkActionSchema = z.enum([
  "add_tag",
  "remove_tag",
  "archive",
  "restore",
]);

export type SessionBulkAction = z.infer<typeof bulkActionSchema>;

const previewInputSchema = z
  .object({
    action: bulkActionSchema,
    sessionIds: z
      .array(z.string().trim().min(1).max(200))
      .min(1, "Select at least one session.")
      .max(100, "A bulk update is limited to 100 sessions."),
    tagId: z.string().trim().max(200).nullish(),
    tagName: z.string().trim().max(80).nullish(),
    colourToken: z
      .enum(["slate", "indigo", "emerald", "amber", "rose"])
      .nullish(),
  })
  .transform((value) => ({
    ...value,
    sessionIds: [...new Set(value.sessionIds)],
    tagId: value.tagId || null,
    tagName: value.tagName || null,
    colourToken: value.colourToken ?? "indigo",
  }))
  .superRefine((value, context) => {
    if (value.action === "add_tag" && !value.tagId && !value.tagName) {
      context.addIssue({
        code: "custom",
        path: ["tagName"],
        message: "Choose an existing tag or enter a new tag name.",
      });
    }
    if (value.action === "add_tag" && value.tagId && value.tagName) {
      context.addIssue({
        code: "custom",
        path: ["tagName"],
        message: "Choose an existing tag or create a new one, not both.",
      });
    }
    if (value.action === "remove_tag" && !value.tagId) {
      context.addIssue({
        code: "custom",
        path: ["tagId"],
        message: "Choose the tag to remove.",
      });
    }
    if (
      (value.action === "archive" || value.action === "restore") &&
      (value.tagId || value.tagName)
    ) {
      context.addIssue({
        code: "custom",
        message: "Archive and restore actions do not accept tag settings.",
      });
    }
  });

const storedItemSchema = z.object({
  sessionId: z.string().min(1),
  title: z.string().min(1),
  expectedRevision: z.number().int().positive(),
  archivePreviousStatus: z.enum(["unscheduled", "cancelled"]).nullable(),
  before: z.object({
    status: z.enum([
      "unscheduled",
      "scheduled",
      "published",
      "cancelled",
      "archived",
    ]),
    tags: z.array(z.string()),
  }),
  after: z.object({
    status: z.enum([
      "unscheduled",
      "scheduled",
      "published",
      "cancelled",
      "archived",
    ]),
    tags: z.array(z.string()),
  }),
});

const storedSummarySchema = z.object({
  action: bulkActionSchema,
  label: z.string(),
  tagId: z.string().nullable(),
  tagName: z.string().nullable(),
  colourToken: z.string().nullable(),
  createsTag: z.boolean(),
  changeCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  invalidCount: z.number().int().nonnegative(),
  undoOf: z.string().nullable(),
  undoDeadline: z.number().int().nullable(),
  deleteTagAfterRemoval: z.boolean(),
  undoExpiresAt: z.number().int().nullable().optional(),
  undoneBy: z.string().nullable().optional(),
});

type SessionRow = {
  id: string;
  title: string;
  status: "unscheduled" | "scheduled" | "published" | "cancelled" | "archived";
  revision: number;
  previousStatus: "unscheduled" | "cancelled" | null;
};

export type SessionBulkWorkspace = {
  sessions: Array<SessionRow & { tags: Array<{ id: string; name: string }> }>;
  tags: Array<{
    id: string;
    name: string;
    colourToken: string | null;
    count: number;
  }>;
};

export type SessionBulkOperation = {
  id: string;
  status: string;
  createdAt: number;
  completedAt: number | null;
  summary: z.infer<typeof storedSummarySchema>;
  items: Array<{
    id: string;
    status: string;
    errorMessage: string | null;
    result: z.infer<typeof storedItemSchema>;
  }>;
};

type PreviewOptions = {
  undoOf?: string;
  undoDeadline?: number;
  deleteTagAfterRemoval?: boolean;
  operationId?: string;
  idempotencyKey?: string;
};

const actionLabels: Record<SessionBulkAction, string> = {
  add_tag: "Add tag",
  remove_tag: "Remove tag",
  archive: "Archive sessions",
  restore: "Restore sessions",
};

function parseJson(value: string, context: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${context} contains invalid JSON.`);
  }
}

function sorted(values: string[]) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

export class SessionBulkStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionBulkStateError";
  }
}

export class SessionBulkService {
  constructor(private readonly env: CloudflareEnvironment) {}

  async workspace(viewer: Viewer): Promise<SessionBulkWorkspace> {
    await this.assertD1Authority(viewer);
    const [sessions, tags, assignments] = await Promise.all([
      this.env.DB.prepare(
        `SELECT s.id, s.title, s.status, s.revision,
                a.previous_status AS previousStatus
           FROM sessions s
           JOIN events e ON e.id = s.event_id AND e.organisation_id = ?
           LEFT JOIN session_archives a
             ON a.session_id = s.id AND a.event_id = s.event_id
          WHERE s.event_id = ?
          ORDER BY CASE s.status WHEN 'archived' THEN 1 ELSE 0 END,
                   s.title COLLATE NOCASE, s.id
          LIMIT 500`,
      )
        .bind(viewer.organisationId, viewer.eventId)
        .all<SessionRow>(),
      this.env.DB.prepare(
        `SELECT t.id, t.name, t.colour_token AS colourToken, COUNT(st.session_id) AS count
           FROM tags t
           JOIN events e ON e.id = t.event_id AND e.organisation_id = ?
           LEFT JOIN session_tags st
             ON st.tag_id = t.id AND st.event_id = t.event_id
          WHERE t.event_id = ?
          GROUP BY t.id, t.name, t.colour_token
          ORDER BY t.name COLLATE NOCASE, t.id`,
      )
        .bind(viewer.organisationId, viewer.eventId)
        .all<{
          id: string;
          name: string;
          colourToken: string | null;
          count: number;
        }>(),
      this.env.DB.prepare(
        `SELECT st.session_id AS sessionId, t.id, t.name
           FROM session_tags st
           JOIN tags t ON t.id = st.tag_id AND t.event_id = st.event_id
           JOIN events e ON e.id = st.event_id AND e.organisation_id = ?
          WHERE st.event_id = ?
          ORDER BY t.name COLLATE NOCASE, t.id`,
      )
        .bind(viewer.organisationId, viewer.eventId)
        .all<{ sessionId: string; id: string; name: string }>(),
    ]);
    const tagsBySession = new Map<
      string,
      Array<{ id: string; name: string }>
    >();
    for (const assignment of assignments.results) {
      const values = tagsBySession.get(assignment.sessionId) ?? [];
      values.push({ id: assignment.id, name: assignment.name });
      tagsBySession.set(assignment.sessionId, values);
    }
    return {
      sessions: sessions.results.map((session) => ({
        ...session,
        tags: tagsBySession.get(session.id) ?? [],
      })),
      tags: tags.results,
    };
  }

  async operation(
    viewer: Viewer,
    operationId: string,
  ): Promise<SessionBulkOperation> {
    const operation = await this.env.DB.prepare(
      `SELECT o.id, o.status, o.result_json AS resultJson,
              o.created_at AS createdAt, o.completed_at AS completedAt
         FROM operation_jobs o
         JOIN events e ON e.id = o.event_id AND e.organisation_id = ?
        WHERE o.id = ? AND o.event_id = ? AND o.type = 'session.bulk'
        LIMIT 1`,
    )
      .bind(viewer.organisationId, operationId, viewer.eventId)
      .first<{
        id: string;
        status: string;
        resultJson: string;
        createdAt: number;
        completedAt: number | null;
      }>();
    if (!operation) throw new SessionBulkStateError("Bulk preview not found.");
    const items = await this.env.DB.prepare(
      `SELECT id, status, error_message AS errorMessage, result_json AS resultJson
         FROM operation_items
        WHERE operation_id = ?
        ORDER BY item_key`,
    )
      .bind(operationId)
      .all<{
        id: string;
        status: string;
        errorMessage: string | null;
        resultJson: string;
      }>();
    return {
      id: operation.id,
      status: operation.status,
      createdAt: operation.createdAt,
      completedAt: operation.completedAt,
      summary: storedSummarySchema.parse(
        parseJson(operation.resultJson, `Bulk operation ${operation.id}`),
      ),
      items: items.results.map(({ resultJson, ...item }) => ({
        ...item,
        result: storedItemSchema.parse(
          parseJson(resultJson, `Bulk item ${item.id}`),
        ),
      })),
    };
  }

  async preview(
    viewer: Viewer,
    input: {
      action: unknown;
      sessionIds: unknown[];
      tagId?: unknown;
      tagName?: unknown;
      colourToken?: unknown;
    },
    options: PreviewOptions = {},
  ) {
    const parsed = previewInputSchema.parse(input);
    const workspace = await this.workspace(viewer);
    const sessionById = new Map(
      workspace.sessions.map((session) => [session.id, session]),
    );
    const sessions = parsed.sessionIds.map((sessionId) => {
      const session = sessionById.get(sessionId);
      if (!session) {
        throw new SessionBulkStateError(
          "The selected sessions do not all belong to the current event.",
        );
      }
      return session;
    });

    let tag: {
      id: string;
      name: string;
      colourToken: string | null;
      creates: boolean;
    } | null = null;
    if (parsed.action === "add_tag" || parsed.action === "remove_tag") {
      const selectedById = parsed.tagId
        ? workspace.tags.find((candidate) => candidate.id === parsed.tagId)
        : null;
      if (parsed.tagId && !selectedById) {
        throw new SessionBulkStateError(
          "The selected tag does not belong to the current event.",
        );
      }
      const selectedByName = parsed.tagName
        ? workspace.tags.find(
            (candidate) =>
              candidate.name.toLocaleLowerCase() ===
              parsed.tagName?.toLocaleLowerCase(),
          )
        : null;
      if (parsed.action === "remove_tag" && !selectedById) {
        throw new SessionBulkStateError("Choose an existing tag to remove.");
      }
      const selected = selectedById ?? selectedByName;
      tag = selected
        ? {
            id: selected.id,
            name: selected.name,
            colourToken: selected.colourToken,
            creates: false,
          }
        : {
            id: crypto.randomUUID(),
            name: parsed.tagName!,
            colourToken: parsed.colourToken,
            creates: true,
          };
    }

    const items = sessions.map((session) => {
      const tagNames = sorted(session.tags.map((item) => item.name));
      const hasTag = tag
        ? session.tags.some((item) => item.id === tag.id)
        : false;
      let status: "pending" | "skipped" | "failed" = "pending";
      let errorCode: string | null = null;
      let errorMessage: string | null = null;
      let afterStatus = session.status;
      let afterTags = tagNames;

      if (parsed.action === "add_tag") {
        if (hasTag) status = "skipped";
        else afterTags = sorted([...tagNames, tag!.name]);
      } else if (parsed.action === "remove_tag") {
        if (!hasTag) status = "skipped";
        else afterTags = tagNames.filter((name) => name !== tag!.name);
      } else if (parsed.action === "archive") {
        if (session.status === "archived" && session.previousStatus) {
          status = "skipped";
        } else if (
          session.status !== "unscheduled" &&
          session.status !== "cancelled"
        ) {
          status = "failed";
          errorCode = "SESSION_NOT_ARCHIVABLE";
          errorMessage =
            session.status === "archived"
              ? "This archived session is missing its restore marker."
              : "Only unscheduled or cancelled sessions can be archived; remove them from an active schedule first.";
        } else {
          afterStatus = "archived";
        }
      } else if (session.status !== "archived") {
        status = "skipped";
      } else if (!session.previousStatus) {
        status = "failed";
        errorCode = "RESTORE_MARKER_MISSING";
        errorMessage = "This archived session has no valid restore marker.";
      } else {
        afterStatus = session.previousStatus;
      }

      return {
        id: crypto.randomUUID(),
        itemKey: `session:${session.id}`,
        status,
        errorCode,
        errorMessage,
        result: {
          sessionId: session.id,
          title: session.title,
          expectedRevision: session.revision,
          archivePreviousStatus: session.previousStatus,
          before: { status: session.status, tags: tagNames },
          after: { status: afterStatus, tags: afterTags },
        },
      };
    });
    const changeCount = items.filter(
      (item) => item.status === "pending",
    ).length;
    const skippedCount = items.filter(
      (item) => item.status === "skipped",
    ).length;
    const invalidCount = items.filter(
      (item) => item.status === "failed",
    ).length;
    if (changeCount === 0 && invalidCount === 0) {
      throw new SessionBulkStateError(
        "The selected action would not change any sessions.",
      );
    }

    const operationId = options.operationId ?? crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const summary = {
      action: parsed.action,
      label: actionLabels[parsed.action],
      tagId: tag?.id ?? null,
      tagName: tag?.name ?? null,
      colourToken: tag?.colourToken ?? null,
      createsTag: tag?.creates ?? false,
      changeCount,
      skippedCount,
      invalidCount,
      undoOf: options.undoOf ?? null,
      undoDeadline: options.undoDeadline ?? null,
      deleteTagAfterRemoval: options.deleteTagAfterRemoval ?? false,
      undoExpiresAt: null,
      undoneBy: null,
    };
    const resultJson = JSON.stringify(summary);
    const [created] = await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO operation_jobs (
           id, organisation_id, event_id, requested_by_person_id, type,
           idempotency_key, correlation_id, status, payload_json, result_json,
           progress_total, progress_completed, progress_failed, cancellable,
           created_at, updated_at
         ) SELECT ?, ?, ?, ?, 'session.bulk', ?, ?, 'received', ?, ?, ?, ?, ?, 1,
                  unixepoch(), unixepoch()
             FROM events e
            WHERE e.id = ? AND e.organisation_id = ?
              AND e.repository_provider = 'd1'`,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        options.idempotencyKey ?? `session-bulk:${operationId}`,
        correlationId,
        JSON.stringify({
          type: "session.bulk",
          operationId,
          action: parsed.action,
        }),
        resultJson,
        items.length,
        skippedCount,
        invalidCount,
        viewer.eventId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO operation_items (
           id, operation_id, item_key, entity_type, entity_id, status,
           result_json, error_code, error_message, completed_at, updated_at
         )
         SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.itemKey'),
                'session', json_extract(value, '$.result.sessionId'),
                json_extract(value, '$.status'), json(json_extract(value, '$.result')),
                json_extract(value, '$.errorCode'),
                json_extract(value, '$.errorMessage'),
                CASE WHEN json_extract(value, '$.status') <> 'pending' THEN unixepoch() ELSE NULL END,
                unixepoch()
           FROM json_each(?)
          WHERE EXISTS (SELECT 1 FROM operation_jobs WHERE id = ?)`,
      ).bind(operationId, JSON.stringify(items), operationId),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         ) SELECT ?, ?, ?, ?, 'session_bulk.previewed', 'operation', ?, ?, ?, unixepoch()
            WHERE EXISTS (SELECT 1 FROM operation_jobs WHERE id = ?)`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        operationId,
        correlationId,
        resultJson,
        operationId,
      ),
    ]);
    if ((created.meta.changes ?? 0) !== 1) {
      await this.assertD1Authority(viewer);
      throw new Error("The bulk preview could not be recorded.");
    }
    return { operationId, ...summary };
  }

  async applyLifecycleCommand(
    viewer: Viewer,
    input: { action: "archive" | "restore"; sessionId: string },
    commandId: string,
  ) {
    const existing = await this.env.DB.prepare(
      `SELECT status, result_json AS resultJson
         FROM operation_jobs
        WHERE id = ? AND event_id = ? AND organisation_id = ?
          AND requested_by_person_id = ? AND type = 'session.bulk'`,
    )
      .bind(
        commandId,
        viewer.eventId,
        viewer.organisationId,
        viewer.personId,
      )
      .first<{ status: string; resultJson: string }>();
    if (existing) {
      const summary = storedSummarySchema.parse(
        parseJson(existing.resultJson, `Bulk operation ${commandId}`),
      );
      if (summary.action !== input.action) {
        throw new SessionBulkStateError(
          "The durable session command does not match this lifecycle action.",
        );
      }
      if (existing.status === "completed") {
        return {
          operationId: commandId,
          action: input.action,
          changedCount: summary.changeCount,
          undoExpiresAt: summary.undoExpiresAt ?? null,
        };
      }
      if (existing.status !== "received") {
        throw new SessionBulkStateError(
          "The durable session lifecycle command cannot be resumed from its current state.",
        );
      }
      return this.confirm(viewer, commandId);
    }

    await this.preview(
      viewer,
      { action: input.action, sessionIds: [input.sessionId] },
      {
        operationId: commandId,
        idempotencyKey: `api-session-lifecycle:${commandId}`,
      },
    );
    return this.confirm(viewer, commandId);
  }

  async confirm(viewer: Viewer, operationId: string) {
    await this.assertD1Authority(viewer);
    const operation = await this.operation(viewer, operationId);
    if (operation.status !== "received") {
      throw new SessionBulkStateError(
        "Only an uncommitted bulk preview can be confirmed.",
      );
    }
    if (operation.summary.invalidCount > 0) {
      throw new SessionBulkStateError(
        "Remove ineligible sessions before confirming this bulk action.",
      );
    }
    const pending = operation.items
      .filter((item) => item.status === "pending")
      .map((item) => item.result);
    if (
      pending.length === 0 ||
      pending.length !== operation.summary.changeCount
    ) {
      throw new Error(
        "The bulk preview item count no longer matches its durable summary.",
      );
    }

    const expectedJson = JSON.stringify(pending);
    const summary = operation.summary;
    let stateGuard = "";
    const claimBindings: unknown[] = [
      operationId,
      viewer.eventId,
      viewer.organisationId,
      expectedJson,
      viewer.eventId,
    ];
    if (summary.action === "add_tag") {
      stateGuard = `
        AND NOT EXISTS (
          SELECT 1 FROM json_each(?) expected
          JOIN session_tags st
            ON st.session_id = json_extract(expected.value, '$.sessionId')
           AND st.event_id = ? AND st.tag_id = ?
        )`;
      claimBindings.push(expectedJson, viewer.eventId, summary.tagId);
    } else if (summary.action === "remove_tag") {
      stateGuard = `
        AND NOT EXISTS (
          SELECT 1 FROM json_each(?) expected
          WHERE NOT EXISTS (
            SELECT 1 FROM session_tags st
             WHERE st.session_id = json_extract(expected.value, '$.sessionId')
               AND st.event_id = ? AND st.tag_id = ?
          )
        )`;
      claimBindings.push(expectedJson, viewer.eventId, summary.tagId);
    } else if (summary.action === "archive") {
      stateGuard = `
        AND NOT EXISTS (
          SELECT 1 FROM json_each(?) expected
          JOIN session_archives a
            ON a.session_id = json_extract(expected.value, '$.sessionId')
           AND a.event_id = ?
        )`;
      claimBindings.push(expectedJson, viewer.eventId);
    } else {
      stateGuard = `
        AND NOT EXISTS (
          SELECT 1 FROM json_each(?) expected
          WHERE NOT EXISTS (
            SELECT 1 FROM session_archives a
             WHERE a.session_id = json_extract(expected.value, '$.sessionId')
               AND a.event_id = ?
               AND a.previous_status = json_extract(expected.value, '$.archivePreviousStatus')
          )
        )`;
      claimBindings.push(expectedJson, viewer.eventId);
    }
    if (summary.tagId) {
      if (summary.createsTag) {
        stateGuard += `
          AND NOT EXISTS (
            SELECT 1 FROM tags
             WHERE event_id = ? AND (id = ? OR lower(name) = lower(?))
          )`;
        claimBindings.push(viewer.eventId, summary.tagId, summary.tagName);
      } else {
        stateGuard += `
          AND EXISTS (SELECT 1 FROM tags WHERE event_id = ? AND id = ?)`;
        claimBindings.push(viewer.eventId, summary.tagId);
      }
    }
    if (summary.undoOf) {
      stateGuard += `
        AND EXISTS (
          SELECT 1 FROM operation_jobs original
           WHERE original.id = ? AND original.event_id = ?
             AND original.organisation_id = ? AND original.type = 'session.bulk'
             AND original.status = 'completed'
             AND original.completed_at + 300 >= unixepoch()
             AND json_extract(original.result_json, '$.undoneBy') IS NULL
        )`;
      claimBindings.push(summary.undoOf, viewer.eventId, viewer.organisationId);
    }
    const claim = this.env.DB.prepare(
      `UPDATE operation_jobs
          SET status = 'running', started_at = unixepoch(),
              attempt_count = attempt_count + 1, updated_at = unixepoch()
        WHERE id = ? AND event_id = ? AND organisation_id = ?
          AND type = 'session.bulk' AND status = 'received'
          AND EXISTS (
            SELECT 1 FROM events e
             WHERE e.id = operation_jobs.event_id
               AND e.organisation_id = operation_jobs.organisation_id
               AND e.repository_provider = 'd1'
          )
          AND NOT EXISTS (
            SELECT 1 FROM json_each(?) expected
            LEFT JOIN sessions s
              ON s.id = json_extract(expected.value, '$.sessionId')
             AND s.event_id = ?
            WHERE s.id IS NULL
               OR s.revision <> json_extract(expected.value, '$.expectedRevision')
               OR s.status <> json_extract(expected.value, '$.before.status')
          )
          ${stateGuard}`,
    ).bind(...claimBindings);

    const operationGuard =
      "EXISTS (SELECT 1 FROM operation_jobs WHERE id = ? AND event_id = ? AND organisation_id = ? AND status = 'running')";
    const mutationStatements: D1PreparedStatement[] = [];
    if (summary.createsTag) {
      mutationStatements.push(
        this.env.DB.prepare(
          `INSERT INTO tags (
             id, event_id, name, colour_token, created_by_person_id,
             created_at, updated_at
           ) SELECT ?, ?, ?, ?, ?, unixepoch(), unixepoch()
              WHERE ${operationGuard}`,
        ).bind(
          summary.tagId,
          viewer.eventId,
          summary.tagName,
          summary.colourToken,
          viewer.personId,
          operationId,
          viewer.eventId,
          viewer.organisationId,
        ),
      );
    }
    if (summary.action === "add_tag") {
      mutationStatements.push(
        this.env.DB.prepare(
          `INSERT INTO session_tags (
             event_id, session_id, tag_id, created_by_person_id, created_at
           )
           SELECT ?, json_extract(value, '$.sessionId'), ?, ?, unixepoch()
             FROM json_each(?)
            WHERE ${operationGuard}`,
        ).bind(
          viewer.eventId,
          summary.tagId,
          viewer.personId,
          expectedJson,
          operationId,
          viewer.eventId,
          viewer.organisationId,
        ),
      );
    } else if (summary.action === "remove_tag") {
      mutationStatements.push(
        this.env.DB.prepare(
          `DELETE FROM session_tags
            WHERE event_id = ? AND tag_id = ?
              AND session_id IN (
                SELECT json_extract(value, '$.sessionId') FROM json_each(?)
              ) AND ${operationGuard}`,
        ).bind(
          viewer.eventId,
          summary.tagId,
          expectedJson,
          operationId,
          viewer.eventId,
          viewer.organisationId,
        ),
      );
      if (summary.deleteTagAfterRemoval) {
        mutationStatements.push(
          this.env.DB.prepare(
            `DELETE FROM tags
              WHERE id = ? AND event_id = ?
                AND NOT EXISTS (
                  SELECT 1 FROM session_tags st
                   WHERE st.tag_id = tags.id AND st.event_id = tags.event_id
                ) AND ${operationGuard}`,
          ).bind(
            summary.tagId,
            viewer.eventId,
            operationId,
            viewer.eventId,
            viewer.organisationId,
          ),
        );
      }
    } else if (summary.action === "archive") {
      mutationStatements.push(
        this.env.DB.prepare(
          `INSERT INTO session_archives (
             session_id, event_id, previous_status, archived_by_person_id,
             archive_operation_id, archived_at
           )
           SELECT s.id, s.event_id, s.status, ?, ?, unixepoch()
             FROM sessions s
             JOIN json_each(?) expected
               ON s.id = json_extract(expected.value, '$.sessionId')
            WHERE s.event_id = ? AND ${operationGuard}`,
        ).bind(
          viewer.personId,
          operationId,
          expectedJson,
          viewer.eventId,
          operationId,
          viewer.eventId,
          viewer.organisationId,
        ),
      );
    }

    if (summary.action === "restore") {
      mutationStatements.push(
        this.env.DB.prepare(
          `UPDATE sessions
              SET status = (
                    SELECT a.previous_status FROM session_archives a
                     WHERE a.session_id = sessions.id AND a.event_id = sessions.event_id
                  ),
                  revision = revision + 1, updated_at = unixepoch()
            WHERE event_id = ?
              AND id IN (
                SELECT json_extract(value, '$.sessionId') FROM json_each(?)
              ) AND ${operationGuard}`,
        ).bind(
          viewer.eventId,
          expectedJson,
          operationId,
          viewer.eventId,
          viewer.organisationId,
        ),
        this.env.DB.prepare(
          `DELETE FROM session_archives
            WHERE event_id = ?
              AND session_id IN (
                SELECT json_extract(value, '$.sessionId') FROM json_each(?)
              ) AND ${operationGuard}`,
        ).bind(
          viewer.eventId,
          expectedJson,
          operationId,
          viewer.eventId,
          viewer.organisationId,
        ),
      );
    } else {
      mutationStatements.push(
        this.env.DB.prepare(
          `UPDATE sessions
              SET status = CASE WHEN ? = 'archive' THEN 'archived' ELSE status END,
                  revision = revision + 1, updated_at = unixepoch()
            WHERE event_id = ?
              AND id IN (
                SELECT json_extract(value, '$.sessionId') FROM json_each(?)
              ) AND ${operationGuard}`,
        ).bind(
          summary.action,
          viewer.eventId,
          expectedJson,
          operationId,
          viewer.eventId,
          viewer.organisationId,
        ),
      );
    }

    const completedAt = Math.floor(Date.now() / 1_000);
    const completionSummary = JSON.stringify({
      ...summary,
      undoExpiresAt: completedAt + 300,
    });
    const results = await this.env.DB.batch([
      claim,
      ...mutationStatements,
      this.env.DB.prepare(
        `UPDATE operation_items
            SET status = 'completed', completed_at = unixepoch(), updated_at = unixepoch()
          WHERE operation_id = ? AND status = 'pending'
            AND EXISTS (SELECT 1 FROM operation_jobs WHERE id = ? AND status = 'running')`,
      ).bind(operationId, operationId),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT lower(hex(randomblob(16))), ?, ?, ?, 'session_bulk.record_updated',
                'session', json_extract(value, '$.sessionId'), o.correlation_id,
                json_object(
                  'operationId', ?, 'action', ?,
                  'before', json_extract(value, '$.before'),
                  'after', json_extract(value, '$.after')
                ), unixepoch()
           FROM json_each(?)
           JOIN operation_jobs o ON o.id = ? AND o.status = 'running'`,
      ).bind(
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        operationId,
        summary.action,
        expectedJson,
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO event_changes (
           event_id, entity_type, entity_id, change_type, correlation_id, created_at
         )
         SELECT ?, 'session', json_extract(value, '$.sessionId'), 'updated',
                o.correlation_id, unixepoch()
           FROM json_each(?)
           JOIN operation_jobs o ON o.id = ? AND o.status = 'running'`,
      ).bind(viewer.eventId, expectedJson, operationId),
      this.env.DB.prepare(
        `UPDATE operation_jobs
            SET status = 'completed', result_json = ?,
                progress_completed = progress_total, progress_failed = 0,
                cancellable = 0, completed_at = unixepoch(), updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND organisation_id = ? AND status = 'running'`,
      ).bind(
        completionSummary,
        operationId,
        viewer.eventId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         ) SELECT ?, ?, ?, ?, 'session_bulk.completed', 'operation', ?,
                  correlation_id, ?, unixepoch()
             FROM operation_jobs WHERE id = ? AND status = 'completed'`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        operationId,
        completionSummary,
        operationId,
      ),
      ...(summary.undoOf
        ? [
            this.env.DB.prepare(
              `UPDATE operation_jobs
                  SET result_json = json_set(result_json, '$.undoneBy', ?),
                      updated_at = unixepoch()
                WHERE id = ? AND event_id = ? AND organisation_id = ?
                  AND type = 'session.bulk' AND status = 'completed'
                  AND json_extract(result_json, '$.undoneBy') IS NULL
                  AND EXISTS (
                    SELECT 1 FROM operation_jobs inverse
                     WHERE inverse.id = ? AND inverse.status = 'completed'
                  )`,
            ).bind(
              operationId,
              summary.undoOf,
              viewer.eventId,
              viewer.organisationId,
              operationId,
            ),
          ]
        : []),
    ]);
    if ((results[0].meta.changes ?? 0) !== 1) {
      await this.assertD1Authority(viewer);
      await this.markStale(viewer, operationId);
      throw new SessionBulkStateError(
        summary.undoOf
          ? "This undo expired, was already used or the selected sessions changed."
          : "The selected sessions changed after preview. Create a new preview before applying the action.",
      );
    }
    const completionIndex = 4 + mutationStatements.length;
    if ((results[completionIndex]?.meta.changes ?? 0) !== 1) {
      throw new Error("The bulk action did not reach a completed state.");
    }
    return {
      operationId,
      action: summary.action,
      changedCount: pending.length,
      undoExpiresAt: completedAt + 300,
    };
  }

  private async assertD1Authority(viewer: Viewer) {
    const event = await this.env.DB.prepare(
      `SELECT repository_provider AS repositoryProvider
         FROM events
        WHERE id = ? AND organisation_id = ?`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{ repositoryProvider: string }>();
    if (!event) {
      throw new SessionBulkStateError(
        "The bulk-action event is unavailable in the authorised organisation.",
      );
    }
    if (event.repositoryProvider === "d1") return;
    if (event.repositoryProvider !== "airtable") {
      throw new Error("The event repository provider is invalid.");
    }
    throw new SessionBulkStateError(
      "Session bulk actions are unavailable while Airtable is authoritative. Make canonical session changes through the Airtable-aware programme screens.",
    );
  }

  async prepareUndo(viewer: Viewer, operationId: string) {
    const operation = await this.operation(viewer, operationId);
    if (operation.status !== "completed" || !operation.completedAt) {
      throw new SessionBulkStateError(
        "Only a completed bulk action can be undone.",
      );
    }
    const deadline = operation.completedAt + 300;
    if (deadline < Math.floor(Date.now() / 1_000)) {
      throw new SessionBulkStateError(
        "The five-minute undo window has expired.",
      );
    }
    if (operation.summary.undoneBy) {
      throw new SessionBulkStateError("This bulk action was already undone.");
    }
    const inverse: Record<SessionBulkAction, SessionBulkAction> = {
      add_tag: "remove_tag",
      remove_tag: "add_tag",
      archive: "restore",
      restore: "archive",
    };
    return this.preview(
      viewer,
      {
        action: inverse[operation.summary.action],
        sessionIds: operation.items
          .filter((item) => item.status === "completed")
          .map((item) => item.result.sessionId),
        tagId: operation.summary.tagId ?? undefined,
      },
      {
        undoOf: operationId,
        undoDeadline: deadline,
        deleteTagAfterRemoval:
          operation.summary.action === "add_tag" &&
          operation.summary.createsTag,
      },
    );
  }

  async cancel(viewer: Viewer, operationId: string) {
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE operation_jobs
            SET status = 'cancelled', cancellable = 0, completed_at = unixepoch(),
                last_error = NULL, updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND organisation_id = ?
            AND type = 'session.bulk' AND status = 'received' AND cancellable = 1`,
      ).bind(operationId, viewer.eventId, viewer.organisationId),
      this.env.DB.prepare(
        `UPDATE operation_items
            SET status = 'skipped', error_code = 'BULK_CANCELLED',
                error_message = 'The bulk preview was cancelled before commitment.',
                completed_at = unixepoch(), updated_at = unixepoch()
          WHERE operation_id = ? AND status = 'pending'
            AND EXISTS (SELECT 1 FROM operation_jobs WHERE id = ? AND status = 'cancelled')`,
      ).bind(operationId, operationId),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         ) SELECT ?, ?, ?, ?, 'session_bulk.cancelled', 'operation', ?, '{}', unixepoch()
            WHERE EXISTS (SELECT 1 FROM operation_jobs WHERE id = ? AND status = 'cancelled')`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        operationId,
        operationId,
      ),
    ]);
    if ((results[0].meta.changes ?? 0) !== 1) {
      throw new SessionBulkStateError(
        "Only an uncommitted bulk preview can be cancelled.",
      );
    }
  }

  private async markStale(viewer: Viewer, operationId: string) {
    await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE operation_jobs
            SET status = 'failed', cancellable = 0,
                last_error = 'The selected sessions changed after preview.',
                completed_at = unixepoch(), updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND organisation_id = ?
            AND type = 'session.bulk' AND status = 'received'`,
      ).bind(operationId, viewer.eventId, viewer.organisationId),
      this.env.DB.prepare(
        `UPDATE operation_items
            SET status = 'failed', error_code = 'STALE_PREVIEW',
                error_message = 'The session changed after this preview was created.',
                completed_at = unixepoch(), updated_at = unixepoch()
          WHERE operation_id = ? AND status = 'pending'
            AND EXISTS (SELECT 1 FROM operation_jobs WHERE id = ? AND status = 'failed')`,
      ).bind(operationId, operationId),
    ]);
  }
}
