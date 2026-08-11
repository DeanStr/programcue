import { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";

export const savedViewAreas = [
  "submissions",
  "evaluations",
  "speakers",
  "sessions",
  "tasks",
  "operations",
] as const;

const savedViewAreaSchema = z.enum(savedViewAreas);
const savedViewVisibilitySchema = z.enum(["private", "event"]);
const adminPathSchema = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .refine((value) => value.startsWith("/admin/"), {
    message: "Saved views must point to an administrator page.",
  })
  .refine((value) => !value.startsWith("//"), {
    message: "Saved views must use a local administrator path.",
  });

const createSavedViewSchema = z
  .object({
    area: savedViewAreaSchema,
    name: z.string().trim().min(2).max(80),
    href: adminPathSchema,
    visibility: savedViewVisibilitySchema.default("private"),
  })
  .strict()
  .superRefine((value, context) => {
    const prefixes: Record<z.infer<typeof savedViewAreaSchema>, string[]> = {
      submissions: ["/admin/submissions"],
      evaluations: ["/admin/review"],
      speakers: ["/admin/speakers"],
      sessions: ["/admin/schedule", "/admin/programme", "/admin/sessions"],
      tasks: ["/admin/tasks", "/admin/command"],
      operations: ["/admin/operations"],
    };
    if (
      !prefixes[value.area].some(
        (prefix) =>
          value.href === prefix ||
          value.href.startsWith(`${prefix}?`) ||
          value.href.startsWith(`${prefix}/`),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["href"],
        message: `The saved URL does not belong to the ${value.area} area.`,
      });
    }
  });

export type SavedViewArea = z.infer<typeof savedViewAreaSchema>;

export type SavedViewListItem = {
  id: string;
  area: SavedViewArea;
  name: string;
  href: string;
  visibility: "private" | "event";
  ownerPersonId: string;
  ownerName: string;
  canDelete: boolean;
  updatedAt: number;
};

export class SavedViewNameConflictError extends Error {
  constructor() {
    super("You already have a saved view with that name in this area.");
    this.name = "SavedViewNameConflictError";
  }
}

export class SavedViewService {
  constructor(private readonly env: CloudflareEnvironment) {}

  async list(viewer: Viewer): Promise<SavedViewListItem[]> {
    const rows = await this.env.DB.prepare(
      `
      SELECT sv.id, sv.area, sv.name, sv.query_json AS queryJson,
             sv.visibility, sv.owner_person_id AS ownerPersonId,
             p.display_name AS ownerName, sv.updated_at AS updatedAt
        FROM saved_views sv
        JOIN events e ON e.id = sv.event_id AND e.organisation_id = ?
        JOIN people p ON p.id = sv.owner_person_id
       WHERE sv.event_id = ?
         AND (sv.owner_person_id = ? OR sv.visibility = 'event')
       ORDER BY sv.owner_person_id = ? DESC, sv.updated_at DESC, sv.name
    `,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        viewer.personId,
      )
      .all<{
        id: string;
        area: SavedViewArea;
        name: string;
        queryJson: string;
        visibility: "private" | "event";
        ownerPersonId: string;
        ownerName: string;
        updatedAt: number;
      }>();

    return rows.results.map(({ queryJson, ...row }) => {
      const query = z
        .object({ href: adminPathSchema })
        .strict()
        .safeParse(JSON.parse(queryJson));
      if (!query.success) {
        throw new Error(`Saved view ${row.id} contains invalid query data.`);
      }
      return {
        ...row,
        href: query.data.href,
        canDelete: row.ownerPersonId === viewer.personId,
      };
    }).filter((view) => viewer.role !== "committee_chair" || view.area === "evaluations");
  }

  async create(viewer: Viewer, rawInput: unknown) {
    const input = createSavedViewSchema.parse(rawInput);
    const id = crypto.randomUUID();
    try {
      const [created] = await this.env.DB.batch([
        this.env.DB.prepare(
          `
          INSERT INTO saved_views (
            id, event_id, owner_person_id, area, name, query_json,
            visibility, created_at, updated_at
          )
          SELECT ?, e.id, ?, ?, ?, ?, ?, unixepoch(), unixepoch()
            FROM events e
           WHERE e.id = ? AND e.organisation_id = ?
        `,
        ).bind(
          id,
          viewer.personId,
          input.area,
          input.name,
          JSON.stringify({ href: input.href }),
          input.visibility,
          viewer.eventId,
          viewer.organisationId,
        ),
        this.env.DB.prepare(
          `
          INSERT INTO audit_events (
            id, organisation_id, event_id, actor_person_id, action,
            entity_type, entity_id, metadata_json, created_at
          )
          SELECT ?, ?, ?, ?, 'saved_view.created', 'saved_view', ?, ?, unixepoch()
           WHERE EXISTS (SELECT 1 FROM saved_views WHERE id = ?)
        `,
        ).bind(
          crypto.randomUUID(),
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          id,
          JSON.stringify({
            area: input.area,
            name: input.name,
            href: input.href,
            visibility: input.visibility,
          }),
          id,
        ),
      ]);
      if ((created.meta.changes ?? 0) !== 1) {
        throw new Error("The saved view could not be created in this event.");
      }
    } catch (error) {
      if (
        error instanceof Error &&
        /UNIQUE constraint failed: saved_views\.event_id, saved_views\.owner_person_id, saved_views\.area, saved_views\.name/i.test(
          error.message,
        )
      ) {
        throw new SavedViewNameConflictError();
      }
      throw error;
    }
    return id;
  }

  async remove(viewer: Viewer, viewId: string) {
    const id = z.string().trim().min(1).max(200).parse(viewId);
    const [removed] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, 'saved_view.deleted', 'saved_view', sv.id,
               json_object('area', sv.area, 'name', sv.name), unixepoch()
          FROM saved_views sv
          JOIN events e ON e.id = sv.event_id AND e.organisation_id = ?
         WHERE sv.id = ? AND sv.event_id = ? AND sv.owner_person_id = ?
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        viewer.organisationId,
        id,
        viewer.eventId,
        viewer.personId,
      ),
      this.env.DB.prepare(
        `
        DELETE FROM saved_views
         WHERE id = ? AND event_id = ? AND owner_person_id = ?
           AND EXISTS (
             SELECT 1 FROM events e
              WHERE e.id = saved_views.event_id AND e.organisation_id = ?
           )
      `,
      ).bind(
        id,
        viewer.eventId,
        viewer.personId,
        viewer.organisationId,
      ),
    ]);
    if ((removed.meta.changes ?? 0) !== 1) {
      throw new Response("Saved view not found", { status: 404 });
    }
  }
}
