import { z } from "zod";

import type { OrganisationAdministrator } from "~/platform/auth/organisation.server";
import {
  crmPersonIdSchema,
  crmStageSchema,
  crmStages,
  type CrmStage,
} from "./crm-schema";
import { CrmStateError } from "./crm-errors";

export class CrmPipelineService {
  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly ensureContact: (
      viewer: OrganisationAdministrator,
      personId: string,
    ) => Promise<void>,
  ) {}

  async list(viewer: OrganisationAdministrator) {
    const rows = await this.env.DB.prepare(
      `SELECT entry.id, entry.person_id AS personId, entry.stage, entry.score,
              entry.rationale, entry.revision, entry.updated_at AS updatedAt,
              COALESCE(profile.display_name, person.display_name) AS name,
              person.email,
              COALESCE(profile.job_title, person.job_title) AS jobTitle,
              COALESCE(profile.organisation_name, person.organisation_name) AS organisationName
         FROM crm_pipeline_entries entry
         JOIN organisation_contacts contact
           ON contact.organisation_id = entry.organisation_id
          AND contact.person_id = entry.person_id AND contact.status = 'active'
         JOIN people person ON person.id = entry.person_id
         LEFT JOIN organisation_contact_profiles profile
           ON profile.organisation_id = entry.organisation_id
          AND profile.person_id = entry.person_id
        WHERE entry.organisation_id = ?
        ORDER BY entry.updated_at DESC,
                 COALESCE(profile.display_name, person.display_name) COLLATE NOCASE`,
    )
      .bind(viewer.organisationId)
      .all<{
        id: string;
        personId: string;
        stage: CrmStage;
        score: number | null;
        rationale: string | null;
        revision: number;
        updatedAt: number;
        name: string;
        email: string;
        jobTitle: string | null;
        organisationName: string | null;
      }>();
    // Stage wording belongs to the presentation layer, which labels the badge
    // on every card in the same column; returning a second copy here let the
    // two drift.
    return crmStages.map((stage) => ({
      stage,
      entries: rows.results.filter((entry) => entry.stage === stage),
    }));
  }

  async get(viewer: OrganisationAdministrator, rawPersonId: unknown) {
    const personId = crmPersonIdSchema.parse(rawPersonId);
    const entry = await this.env.DB.prepare(
      `SELECT id, stage, score, rationale, revision, created_at AS createdAt,
              updated_at AS updatedAt
         FROM crm_pipeline_entries
        WHERE organisation_id = ? AND person_id = ?`,
    )
      .bind(viewer.organisationId, personId)
      .first<{
        id: string;
        stage: CrmStage;
        score: number | null;
        rationale: string | null;
        revision: number;
        createdAt: number;
        updatedAt: number;
      }>();
    if (!entry) return null;
    const activity = await this.env.DB.prepare(
      `SELECT activity.id, activity.kind, activity.body,
              activity.from_stage AS fromStage, activity.to_stage AS toStage,
              activity.created_at AS createdAt,
              actor.display_name AS actorName
         FROM crm_pipeline_activity activity
         JOIN people actor ON actor.id = activity.actor_person_id
        WHERE activity.organisation_id = ? AND activity.pipeline_entry_id = ?
        ORDER BY activity.created_at DESC, activity.id DESC`,
    )
      .bind(viewer.organisationId, entry.id)
      .all<{
        id: string;
        kind: "note" | "stage_changed";
        body: string | null;
        fromStage: CrmStage | null;
        toStage: CrmStage | null;
        createdAt: number;
        actorName: string;
      }>();
    return { ...entry, activity: activity.results };
  }

  async enroll(viewer: OrganisationAdministrator, rawInput: unknown) {
    const input = z
      .object({
        personId: crmPersonIdSchema,
        stage: crmStageSchema.default("identified"),
        score: z.coerce.number().int().min(0).max(100).nullable().optional(),
        rationale: z.string().trim().max(2_000).default(""),
      })
      .parse(rawInput);
    await this.ensureContact(viewer, input.personId);
    const entryId = crypto.randomUUID();
    const [created] = await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO crm_pipeline_entries (
           id, organisation_id, person_id, stage, score, rationale, revision,
           created_by_person_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, unixepoch(), unixepoch())`,
      ).bind(
        entryId,
        viewer.organisationId,
        input.personId,
        input.stage,
        input.score ?? null,
        input.rationale || null,
        viewer.personId,
      ),
      this.env.DB.prepare(
        `INSERT INTO crm_pipeline_activity (
           id, organisation_id, pipeline_entry_id, actor_person_id,
           kind, from_stage, to_stage, created_at
         ) VALUES (?, ?, ?, ?, 'stage_changed', NULL, ?, unixepoch())`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        entryId,
        viewer.personId,
        input.stage,
      ),
    ]);
    if ((created.meta.changes ?? 0) !== 1) {
      throw new CrmStateError(
        "This contact is already enrolled in the pipeline.",
      );
    }
  }

  async move(viewer: OrganisationAdministrator, rawInput: unknown) {
    const input = z
      .object({
        entryId: z.string().trim().min(1).max(200),
        stage: crmStageSchema,
        revision: z.coerce.number().int().positive(),
      })
      .parse(rawInput);
    const current = await this.env.DB.prepare(
      `SELECT stage FROM crm_pipeline_entries
        WHERE id = ? AND organisation_id = ? AND revision = ?`,
    )
      .bind(input.entryId, viewer.organisationId, input.revision)
      .first<{ stage: CrmStage }>();
    if (!current) {
      throw new CrmStateError(
        "This pipeline card changed. Reload before moving it.",
      );
    }
    if (current.stage === input.stage) return;
    const [updated] = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE crm_pipeline_entries
            SET stage = ?, revision = revision + 1, updated_at = unixepoch()
          WHERE id = ? AND organisation_id = ? AND revision = ?`,
      ).bind(input.stage, input.entryId, viewer.organisationId, input.revision),
      this.env.DB.prepare(
        `INSERT INTO crm_pipeline_activity (
           id, organisation_id, pipeline_entry_id, actor_person_id,
           kind, from_stage, to_stage, created_at
         ) SELECT ?, ?, ?, ?, 'stage_changed', ?, ?, unixepoch()
            WHERE EXISTS (SELECT 1 FROM crm_pipeline_entries
              WHERE id = ? AND organisation_id = ? AND revision = ?)`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        input.entryId,
        viewer.personId,
        current.stage,
        input.stage,
        input.entryId,
        viewer.organisationId,
        input.revision + 1,
      ),
    ]);
    if ((updated.meta.changes ?? 0) !== 1) {
      throw new CrmStateError(
        "This pipeline card changed. Reload before moving it.",
      );
    }
  }

  async addNote(viewer: OrganisationAdministrator, rawInput: unknown) {
    const input = z
      .object({
        entryId: z.string().trim().min(1).max(200),
        body: z.string().trim().min(1).max(5_000),
      })
      .parse(rawInput);
    const result = await this.env.DB.prepare(
      `INSERT INTO crm_pipeline_activity (
         id, organisation_id, pipeline_entry_id, actor_person_id,
         kind, body, created_at
       ) SELECT ?, ?, entry.id, ?, 'note', ?, unixepoch()
           FROM crm_pipeline_entries entry
          WHERE entry.id = ? AND entry.organisation_id = ?`,
    )
      .bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.personId,
        input.body,
        input.entryId,
        viewer.organisationId,
      )
      .run();
    if ((result.meta.changes ?? 0) !== 1) {
      throw new Response("Pipeline card not found.", { status: 404 });
    }
  }
}
