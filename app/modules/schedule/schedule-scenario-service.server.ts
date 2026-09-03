import type { Viewer } from "~/platform/auth/authorize.server";
import {
  type AutoPlacementPreview,
  canonicalAutoPlacementPlan,
  canonicalAutoPlacementSessionRevisions,
  computeAutoPlacements,
} from "./schedule-auto-placement";
import {
  ScheduleConfigurationError,
  ScheduleNotFoundError,
} from "./schedule-errors";
import {
  scheduleAutoPlacementConfirmSchema,
  scheduleScenarioCreateSchema,
  scheduleScenarioDiscardSchema,
} from "./schedule-schema";
import type {
  ScheduleEventScope,
  ScheduleWorkspace,
} from "./schedule-service.server";

export const MAX_ACTIVE_SCHEDULE_SCENARIOS = 10;

export type ScheduleScenario = {
  id: string;
  name: string;
  createdAt: number;
  createdByPersonId: string;
  preview: AutoPlacementPreview;
  stale: boolean;
  staleReason: string | null;
};

type ScenarioRow = {
  id: string;
  name: string;
  createdAt: number;
  createdByPersonId: string;
  previewJson: string;
};

function parseStoredPreview(serialized: string): AutoPlacementPreview {
  let decoded: unknown;
  try {
    decoded = JSON.parse(serialized);
  } catch (error) {
    throw new Error("A saved schedule scenario contains invalid JSON.", {
      cause: error,
    });
  }
  const parsed = scheduleAutoPlacementConfirmSchema.parse(decoded);
  return {
    ...parsed,
    placements: parsed.placements.map((placement) => ({
      ...placement,
      warnings: [],
    })),
  };
}

function scenarioStaleness(
  workspace: ScheduleWorkspace,
  preview: AutoPlacementPreview,
  currentComputation?: ReturnType<typeof computeAutoPlacements>,
) {
  if (
    workspace.version?.status !== "draft" ||
    workspace.version.id !== preview.scheduleVersionId
  ) {
    return "The active draft has changed.";
  }
  if (workspace.version.revision !== preview.scheduleRevision) {
    return "The draft schedule changed after this scenario was saved.";
  }
  if (workspace.event.revision !== preview.eventRevision) {
    return "Event configuration changed after this scenario was saved.";
  }
  if (workspace.policyRevision !== preview.policyRevision) {
    return "Conflict policy changed after this scenario was saved.";
  }
  const current = currentComputation ?? computeAutoPlacements(workspace);
  if (
    JSON.stringify(
      canonicalAutoPlacementSessionRevisions(current.sessionRevisions),
    ) !==
      JSON.stringify(
        canonicalAutoPlacementSessionRevisions(preview.sessionRevisions),
      ) ||
    JSON.stringify(canonicalAutoPlacementPlan(current)) !==
      JSON.stringify(canonicalAutoPlacementPlan(preview))
  ) {
    return "Session details or placement eligibility changed after this scenario was saved.";
  }
  return null;
}

function hydrateScenario(
  row: ScenarioRow,
  workspace: ScheduleWorkspace,
  currentComputation?: ReturnType<typeof computeAutoPlacements>,
) {
  const storedPreview = parseStoredPreview(row.previewJson);
  const current =
    currentComputation ??
    (workspace.version?.status === "draft"
      ? computeAutoPlacements(workspace)
      : undefined);
  const staleReason = scenarioStaleness(workspace, storedPreview, current);
  /* Warnings are rule output rather than user intent. Reattach them from the
     current authoritative computation only while the stored proposal is
     current; stale warning evidence must not be presented as if it still
     applied. */
  const currentPlacementBySessionId =
    staleReason === null && current
      ? new Map(
          current.placements.map((placement) => [
            placement.sessionId,
            placement,
          ]),
        )
      : null;
  const preview = {
    ...storedPreview,
    placements: storedPreview.placements.map((placement) => ({
      ...placement,
      warnings:
        currentPlacementBySessionId?.get(placement.sessionId)?.warnings ?? [],
    })),
  };
  return {
    id: row.id,
    name: row.name,
    createdAt: row.createdAt,
    createdByPersonId: row.createdByPersonId,
    preview,
    stale: staleReason !== null,
    staleReason,
  } satisfies ScheduleScenario;
}

export class ScheduleScenarioService {
  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly dependencies: {
      getWorkspace: (viewer: ScheduleEventScope) => Promise<ScheduleWorkspace>;
      previewAutoPlacement: (
        viewer: ScheduleEventScope,
      ) => Promise<AutoPlacementPreview>;
    },
  ) {}

  async list(
    viewer: ScheduleEventScope,
    existingWorkspace?: ScheduleWorkspace,
  ): Promise<ScheduleScenario[]> {
    const workspace =
      existingWorkspace ?? (await this.dependencies.getWorkspace(viewer));
    const rows = await this.env.DB.prepare(
      `SELECT scenario.id, scenario.name,
              scenario.created_at AS createdAt,
              scenario.created_by_person_id AS createdByPersonId,
              scenario.preview_json AS previewJson
         FROM schedule_scenarios scenario
         JOIN events event
           ON event.id = scenario.event_id
          AND event.organisation_id = scenario.organisation_id
        WHERE scenario.event_id = ? AND scenario.organisation_id = ?
          AND scenario.discarded_at IS NULL
        ORDER BY scenario.created_at DESC, scenario.id DESC
        LIMIT ?`,
    )
      .bind(
        viewer.eventId,
        viewer.organisationId,
        MAX_ACTIVE_SCHEDULE_SCENARIOS,
      )
      .all<ScenarioRow>();
    const currentComputation =
      rows.results.length > 0 && workspace.version?.status === "draft"
        ? computeAutoPlacements(workspace)
        : undefined;
    return rows.results.map((row) =>
      hydrateScenario(row, workspace, currentComputation),
    );
  }

  async create(viewer: Viewer, input: unknown): Promise<ScheduleScenario> {
    const parsed = scheduleScenarioCreateSchema.parse(input);
    const replay = await this.env.DB.prepare(
      `SELECT id, name, created_at AS createdAt,
              created_by_person_id AS createdByPersonId,
              preview_json AS previewJson
         FROM schedule_scenarios
        WHERE id = ? AND event_id = ? AND organisation_id = ?
          AND created_by_person_id = ? AND discarded_at IS NULL`,
    )
      .bind(
        parsed.scenarioId,
        viewer.eventId,
        viewer.organisationId,
        viewer.personId,
      )
      .first<ScenarioRow>();
    const workspace = await this.dependencies.getWorkspace(viewer);
    if (replay) {
      const saved = hydrateScenario(replay, workspace);
      const selectedIdsMatch =
        saved.preview.selectedSessionIds.length ===
          parsed.selectedSessionIds.length &&
        parsed.selectedSessionIds.every((sessionId) =>
          saved.preview.selectedSessionIds.includes(sessionId),
        );
      if (replay.name !== parsed.name || !selectedIdsMatch) {
        throw new ScheduleConfigurationError(
          "This scenario creation identifier was already used with different details.",
        );
      }
      return saved;
    }
    if (workspace.version?.status !== "draft") {
      throw new ScheduleNotFoundError(
        "Schedule scenarios require an active draft schedule.",
      );
    }
    const preview = await this.dependencies.previewAutoPlacement(viewer);
    if (!preview.placements.length) {
      throw new ScheduleConfigurationError(
        "There are no eligible unscheduled sessions to include in a scenario.",
      );
    }
    const proposedSessionIds = new Set(
      preview.placements.map((placement) => placement.sessionId),
    );
    if (
      parsed.selectedSessionIds.some(
        (sessionId) => !proposedSessionIds.has(sessionId),
      )
    ) {
      throw new ScheduleConfigurationError(
        "The selected scenario placements are no longer available. Prepare a fresh proposal.",
      );
    }
    const selectedIds = new Set(parsed.selectedSessionIds);
    const selectedSessionIds = preview.placements
      .map((placement) => placement.sessionId)
      .filter((sessionId) => selectedIds.has(sessionId));
    const savedPreview = { ...preview, selectedSessionIds };
    const operationId = crypto.randomUUID();
    const previewJson = JSON.stringify(savedPreview);
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO schedule_scenarios (
           id, organisation_id, event_id, schedule_version_id,
           created_by_person_id, name, base_schedule_revision,
           event_revision, policy_revision, preview_json,
           creation_operation_id, created_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM events
             WHERE id = ? AND organisation_id = ? AND revision = ?
          )
            AND EXISTS (
              SELECT 1 FROM schedule_versions
               WHERE id = ? AND event_id = ? AND status = 'draft'
                 AND revision = ?
            )
            AND (
              SELECT COUNT(*) FROM schedule_scenarios
               WHERE event_id = ? AND organisation_id = ?
                 AND discarded_at IS NULL
            ) < ?`,
      ).bind(
        parsed.scenarioId,
        viewer.organisationId,
        viewer.eventId,
        preview.scheduleVersionId,
        viewer.personId,
        parsed.name,
        preview.scheduleRevision,
        preview.eventRevision,
        preview.policyRevision,
        previewJson,
        operationId,
        viewer.eventId,
        viewer.organisationId,
        preview.eventRevision,
        preview.scheduleVersionId,
        viewer.eventId,
        preview.scheduleRevision,
        viewer.eventId,
        viewer.organisationId,
        MAX_ACTIVE_SCHEDULE_SCENARIOS,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id,
           event_id, actor_person_id, action, entity_type, entity_id,
           correlation_id, metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, organisation_id, event_id, ?,
                'schedule.scenario.created', 'schedule_scenario', id, ?, ?,
                unixepoch()
           FROM schedule_scenarios
          WHERE id = ? AND event_id = ? AND organisation_id = ?
            AND created_by_person_id = ? AND creation_operation_id = ?`,
      ).bind(
        operationId,
        viewer.personId,
        operationId,
        JSON.stringify({
          name: parsed.name,
          scheduleVersionId: preview.scheduleVersionId,
          scheduleRevision: preview.scheduleRevision,
          placementCount: preview.placements.length,
          selectedPlacementCount: selectedSessionIds.length,
          unplacedCount: preview.unplaced.length,
        }),
        parsed.scenarioId,
        viewer.eventId,
        viewer.organisationId,
        viewer.personId,
        operationId,
      ),
    ]);
    if (
      (results[0]?.meta.changes ?? 0) !== 1 ||
      (results[1]?.meta.changes ?? 0) !== 1
    ) {
      throw new ScheduleConfigurationError(
        `The scenario could not be saved. Use a unique name, keep fewer than ${MAX_ACTIVE_SCHEDULE_SCENARIOS} active scenarios, and refresh the draft before retrying.`,
      );
    }
    return {
      id: parsed.scenarioId,
      name: parsed.name,
      createdAt: Math.floor(Date.now() / 1_000),
      createdByPersonId: viewer.personId,
      preview: savedPreview,
      stale: false,
      staleReason: null,
    };
  }

  async discard(viewer: Viewer, input: unknown) {
    const parsed = scheduleScenarioDiscardSchema.parse(input);
    const operationId = crypto.randomUUID();
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE schedule_scenarios
            SET discarded_at = unixepoch(), discard_operation_id = ?
          WHERE id = ? AND event_id = ? AND organisation_id = ?
            AND discarded_at IS NULL
            AND EXISTS (
              SELECT 1 FROM events
               WHERE id = ? AND organisation_id = ?
            )`,
      ).bind(
        operationId,
        parsed.scenarioId,
        viewer.eventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id,
           event_id, actor_person_id, action, entity_type, entity_id,
           correlation_id, metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, organisation_id, event_id, ?,
                'schedule.scenario.discarded', 'schedule_scenario', id, ?,
                json_object('name', name), unixepoch()
           FROM schedule_scenarios
          WHERE id = ? AND event_id = ? AND organisation_id = ?
            AND discarded_at IS NOT NULL AND discard_operation_id = ?`,
      ).bind(
        operationId,
        viewer.personId,
        operationId,
        parsed.scenarioId,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
    ]);
    if (
      (results[0]?.meta.changes ?? 0) !== 1 ||
      (results[1]?.meta.changes ?? 0) !== 1
    ) {
      throw new ScheduleNotFoundError("That schedule scenario was not found.");
    }
    return { scenarioId: parsed.scenarioId };
  }
}
