import type { SaveFormInput } from "./submission-schema";
import {
  closeDateToEpoch,
  mapForm,
  mapVersion,
  settingsSnapshot,
  SubmissionRevisionConflictError,
  SubmissionStateError,
  type FormRow,
  type FormSummary,
  type FormVersion,
  type FormWorkspace,
  type VersionRow,
} from "./submission-repository-shared";

export class SubmissionFormRepository {
  constructor(private readonly env: CloudflareEnvironment) {}

  async getAdminWorkspace(
    organisationId: string,
    eventId: string,
    formId?: string,
  ): Promise<FormWorkspace | null> {
    const form = await this.env.DB.prepare(
      `
      SELECT f.id, f.revision, f.event_id AS eventId, e.name AS eventName, e.slug AS eventSlug,
             e.timezone AS eventTimezone, e.allow_anonymous_drafts AS allowAnonymousDrafts,
             e.brand_accent AS brandAccent, e.file_policy_json AS filePolicyJson,
             f.name, f.kind, f.status,
             f.public_slug AS publicSlug, f.closes_at AS closesAt,
             f.submission_limit AS submissionLimit, f.min_speakers AS minSpeakers,
             f.max_speakers AS maxSpeakers, f.access_mode AS accessMode,
             f.access_password_hash AS accessPasswordHash,
             (SELECT COUNT(*) FROM submissions s
               JOIN form_versions submitted_version
                 ON submitted_version.id = s.form_version_id
                AND submitted_version.event_id = s.event_id
              WHERE submitted_version.form_id = f.id
                AND s.event_id = f.event_id AND s.status <> 'draft') AS submittedCount
        FROM form_definitions f
        JOIN events e ON e.id = f.event_id AND e.organisation_id = ?
       WHERE f.event_id = ? AND (? IS NULL OR f.id = ?)
       ORDER BY CASE f.status WHEN 'published' THEN 0 WHEN 'draft' THEN 1 ELSE 2 END, f.created_at
       LIMIT 1
    `,
    )
      .bind(organisationId, eventId, formId ?? null, formId ?? null)
      .first<FormRow>();
    if (!form) return null;

    const versionsResult = await this.env.DB.prepare(
      `
      SELECT id, revision, version_number AS versionNumber, schema_json AS schemaJson,
             routing_json AS routingJson, settings_snapshot_json AS settingsSnapshotJson,
             status, published_at AS publishedAt
        FROM form_versions
       WHERE form_id = ?
       ORDER BY version_number DESC
    `,
    )
      .bind(form.id)
      .all<VersionRow>();
    const versions = versionsResult.results.map(mapVersion);
    const draftVersion = versions.find((version) => version.status === "draft");
    if (!draftVersion)
      throw new Error("The form has no editable draft version");
    const summary = mapForm(form);
    return {
      ...summary,
      name: draftVersion.settings.name ?? summary.name,
      kind: draftVersion.settings.kind ?? summary.kind,
      publicSlug: draftVersion.settings.publicSlug ?? summary.publicSlug,
      closesAt: draftVersion.settings.closesAt ?? null,
      submissionLimit: draftVersion.settings.submissionLimit ?? null,
      minSpeakers: draftVersion.settings.minSpeakers ?? summary.minSpeakers,
      maxSpeakers: draftVersion.settings.maxSpeakers ?? null,
      accessMode: draftVersion.settings.accessMode ?? summary.accessMode,
      accessPasswordHash: draftVersion.routing.passwordHash,
      draftVersion,
      publishedVersion:
        versions.find((version) => version.status === "published") ?? null,
      versions: versions.map(({ id, versionNumber, status, publishedAt }) => ({
        id,
        versionNumber,
        status,
        publishedAt,
      })),
    };
  }

  async createForm(
    organisationId: string,
    eventId: string,
    actorPersonId: string,
    input: SaveFormInput,
    operation?: {
      operationId: string;
      formId: string;
      versionId: string;
      auditId: string;
    },
  ) {
    if (operation) {
      const recovered = await this.env.DB.prepare(
        `SELECT form.id
           FROM form_definitions form
           JOIN events event
             ON event.id = form.event_id AND event.organisation_id = ?
          WHERE form.event_id = ? AND form.last_operation_id = ?
            AND form.id = ?
            AND EXISTS (
              SELECT 1 FROM form_versions version
               WHERE version.id = ? AND version.form_id = form.id
                 AND version.event_id = form.event_id
            )`,
      )
        .bind(
          organisationId,
          eventId,
          operation.operationId,
          operation.formId,
          operation.versionId,
        )
        .first<{ id: string }>();
      if (recovered) return recovered.id;
    }
    const formId = operation?.formId ?? crypto.randomUUID();
    const versionId = operation?.versionId ?? crypto.randomUUID();
    const auditId = operation?.auditId ?? crypto.randomUUID();
    const operationId = operation?.operationId ?? crypto.randomUUID();
    const eventExists = await this.env.DB.prepare(
      "SELECT id, timezone FROM events WHERE id = ? AND organisation_id = ?",
    )
      .bind(eventId, organisationId)
      .first<{ id: string; timezone: string }>();
    if (!eventExists) throw new Response("Event not found", { status: 404 });

    const [created, versionCreated] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        INSERT INTO form_definitions (
          id, event_id, name, kind, status, public_slug, closes_at, submission_limit,
          min_speakers, max_speakers, access_mode, access_password_hash, created_by_person_id,
          last_operation_id, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch()
         WHERE NOT EXISTS (
           SELECT 1 FROM form_definitions WHERE public_slug = ?
         )
        ON CONFLICT(public_slug) DO NOTHING
      `,
      ).bind(
        formId,
        eventId,
        input.name,
        input.kind,
        input.publicSlug,
        closeDateToEpoch(input.closeDate, eventExists.timezone),
        input.submissionLimit,
        input.minSpeakers,
        input.maxSpeakers,
        input.accessMode,
        input.routing.passwordHash,
        actorPersonId,
        operationId,
        input.publicSlug,
      ),
      this.env.DB.prepare(
        `
        INSERT OR IGNORE INTO form_versions (
          id, event_id, form_id, version_number, schema_json, routing_json, settings_snapshot_json,
          status, created_by_person_id, created_at, updated_at
        )
        SELECT ?, ?, ?, 1, ?, ?, ?, 'draft', ?, unixepoch(), unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM form_definitions
            WHERE id = ? AND event_id = ? AND public_slug = ?
         )
      `,
      ).bind(
        versionId,
        eventId,
        formId,
        JSON.stringify(input.schema),
        JSON.stringify(input.routing),
        JSON.stringify(settingsSnapshot(input, eventExists.timezone)),
        actorPersonId,
        formId,
        eventId,
        input.publicSlug,
      ),
      this.env.DB.prepare(
        `
        INSERT OR IGNORE INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, 'form.created', 'form_definition', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM form_definitions
            WHERE id = ? AND event_id = ? AND public_slug = ?
         )
      `,
      ).bind(
        auditId,
        organisationId,
        eventId,
        actorPersonId,
        formId,
        JSON.stringify({ name: input.name, version: 1 }),
        formId,
        eventId,
        input.publicSlug,
      ),
    ]);
    if (
      (created.meta.changes ?? 0) !== 1 ||
      (versionCreated.meta.changes ?? 0) !== 1
    ) {
      if (operation) {
        const recovered = await this.env.DB.prepare(
          `SELECT form.id
             FROM form_definitions form
             JOIN events event
               ON event.id = form.event_id AND event.organisation_id = ?
            WHERE form.event_id = ? AND form.last_operation_id = ?
              AND form.id = ?
              AND EXISTS (
                SELECT 1 FROM form_versions version
                 WHERE version.id = ? AND version.form_id = form.id
                   AND version.event_id = form.event_id
              )`,
        )
          .bind(
            organisationId,
            eventId,
            operation.operationId,
            operation.formId,
            operation.versionId,
          )
          .first<{ id: string }>();
        if (recovered) return recovered.id;
      }
      throw new SubmissionStateError(
        "That public form URL is already in use. Choose a different slug.",
      );
    }
    return formId;
  }

  async saveForm(
    organisationId: string,
    eventId: string,
    actorPersonId: string,
    formId: string,
    input: SaveFormInput,
    operation?: { operationId: string; auditId: string },
  ) {
    if (operation) {
      const recovered = await this.env.DB.prepare(
        `SELECT form.id
           FROM form_definitions form
           JOIN events event
             ON event.id = form.event_id AND event.organisation_id = ?
           JOIN form_versions version
             ON version.form_id = form.id AND version.event_id = form.event_id
            AND version.status = 'draft'
          WHERE form.id = ? AND form.event_id = ?
            AND form.last_operation_id = ?
            AND form.revision = ? AND version.revision = ?`,
      )
        .bind(
          organisationId,
          formId,
          eventId,
          operation.operationId,
          input.revision! + 1,
          input.draftRevision! + 1,
        )
        .first();
      if (recovered) return;
    }
    const workspace = await this.getAdminWorkspace(
      organisationId,
      eventId,
      formId,
    );
    if (!workspace) throw new Response("Form not found", { status: 404 });
    const auditId = operation?.auditId ?? crypto.randomUUID();
    const saveId = operation?.operationId ?? crypto.randomUUID();
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE form_definitions
           SET revision = revision + 1, last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND event_id = ?
           AND revision = ?
           AND EXISTS (SELECT 1 FROM events WHERE id = ? AND organisation_id = ?)
           AND EXISTS (
             SELECT 1 FROM form_versions
              WHERE id = ? AND form_id = ? AND status = 'draft' AND revision = ?
           )
      `,
      ).bind(
        saveId,
        formId,
        eventId,
        input.revision,
        eventId,
        organisationId,
        workspace.draftVersion.id,
        formId,
        input.draftRevision,
      ),
      this.env.DB.prepare(
        `
        UPDATE form_versions
           SET schema_json = ?, routing_json = ?, settings_snapshot_json = ?,
               revision = revision + 1, updated_at = unixepoch()
         WHERE id = ? AND form_id = ? AND status = 'draft' AND revision = ?
           AND EXISTS (
             SELECT 1 FROM form_definitions
              WHERE id = ? AND event_id = ? AND revision = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        JSON.stringify(input.schema),
        JSON.stringify(input.routing),
        JSON.stringify(settingsSnapshot(input, workspace.eventTimezone)),
        workspace.draftVersion.id,
        formId,
        input.draftRevision,
        formId,
        eventId,
        input.revision! + 1,
        saveId,
      ),
      this.env.DB.prepare(
        `
        INSERT OR IGNORE INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
        ) SELECT ?, ?, ?, ?, 'form.draft.saved', 'form_version', ?, ?, unixepoch()
           WHERE EXISTS (
             SELECT 1 FROM form_definitions f
             JOIN form_versions v ON v.form_id = f.id AND v.event_id = f.event_id
              WHERE f.id = ? AND f.event_id = ? AND f.revision = ?
                AND f.last_operation_id = ?
                AND v.id = ? AND v.revision = ?
           )
      `,
      ).bind(
        auditId,
        organisationId,
        eventId,
        actorPersonId,
        workspace.draftVersion.id,
        JSON.stringify({ version: workspace.draftVersion.versionNumber }),
        formId,
        eventId,
        input.revision! + 1,
        saveId,
        workspace.draftVersion.id,
        input.draftRevision! + 1,
      ),
    ]);
    if (
      (results[0].meta.changes ?? 0) !== 1 ||
      (results[1].meta.changes ?? 0) !== 1
    ) {
      if (operation) {
        const recovered = await this.env.DB.prepare(
          `SELECT 1
             FROM form_definitions form
             JOIN events event
               ON event.id = form.event_id AND event.organisation_id = ?
             JOIN form_versions version
               ON version.form_id = form.id AND version.event_id = form.event_id
              AND version.status = 'draft'
            WHERE form.id = ? AND form.event_id = ?
              AND form.last_operation_id = ?
              AND form.revision = ? AND version.revision = ?`,
        )
          .bind(
            organisationId,
            formId,
            eventId,
            operation.operationId,
            input.revision! + 1,
            input.draftRevision! + 1,
          )
          .first();
        if (recovered) return;
      }
      throw new SubmissionRevisionConflictError();
    }
  }

  async publishForm(
    organisationId: string,
    eventId: string,
    actorPersonId: string,
    formId: string,
    formRevision: number,
    draftRevision: number,
    operation?: {
      operationId: string;
      nextVersionId: string;
      auditId: string;
    },
    expectedSessionFormatsJson: string | null = null,
  ) {
    if (operation) {
      const recovered = await this.env.DB.prepare(
        `SELECT form.id
           FROM form_definitions form
           JOIN events event
             ON event.id = form.event_id AND event.organisation_id = ?
          WHERE form.id = ? AND form.event_id = ?
            AND form.status = 'published' AND form.last_operation_id = ?
            AND EXISTS (
              SELECT 1 FROM form_versions next_draft
               WHERE next_draft.id = ? AND next_draft.form_id = form.id
                 AND next_draft.event_id = form.event_id
                 AND next_draft.status = 'draft'
            )`,
      )
        .bind(
          organisationId,
          formId,
          eventId,
          operation.operationId,
          operation.nextVersionId,
        )
        .first();
      if (recovered) return;
    }
    const workspace = await this.getAdminWorkspace(
      organisationId,
      eventId,
      formId,
    );
    if (!workspace) throw new Response("Form not found", { status: 404 });
    if (
      workspace.revision !== formRevision ||
      workspace.draftVersion.revision !== draftRevision
    ) {
      throw new SubmissionRevisionConflictError();
    }
    const nextVersionId = operation?.nextVersionId ?? crypto.randomUUID();
    const auditId = operation?.auditId ?? crypto.randomUUID();
    const publicationId = operation?.operationId ?? crypto.randomUUID();
    const version = workspace.draftVersion;
    const routedTrackBindings = Object.entries(
      version.routing.trackIds,
    ).flatMap(([trackName, trackId]) => {
      if (version.routing.trackNames[trackId] !== trackName) {
        throw new SubmissionStateError(
          "A track route is missing its saved event-track identity. Save the form again before publishing.",
        );
      }
      return [trackId, trackName];
    });
    const routedTrackPredicates = Object.keys(version.routing.trackIds)
      .map(
        () => `AND EXISTS (
          SELECT 1 FROM tracks routed_track
           WHERE routed_track.id = ? AND routed_track.name = ?
             AND routed_track.event_id = form_definitions.event_id
        )`,
      )
      .join("\n");
    const routedTeamIds = [
      ...new Set(Object.values(version.routing.categories)),
    ];
    const routedTeamBindings = routedTeamIds.flatMap((teamId) => {
      const teamName = version.routing.teamNames[teamId];
      if (!teamName) {
        throw new SubmissionStateError(
          "A category route is missing its saved evaluation-team identity. Save the form again before publishing.",
        );
      }
      return [teamId, teamName];
    });
    const routedTeamPredicates = routedTeamIds
      .map(
        () => `AND EXISTS (
          SELECT 1 FROM evaluation_teams routed_team
           WHERE routed_team.id = ? AND routed_team.name = ?
             AND routed_team.event_id = form_definitions.event_id
             AND routed_team.status = 'active'
        )`,
      )
      .join("\n");
    const slugOwner = await this.env.DB.prepare(
      `
      SELECT id FROM form_definitions
       WHERE public_slug = ? AND id <> ?
       LIMIT 1
    `,
    )
      .bind(workspace.publicSlug, formId)
      .first();
    if (slugOwner) {
      throw new SubmissionStateError(
        "That public form URL is already in use. Choose a different slug.",
      );
    }
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE form_definitions
           SET name = ?, kind = ?, public_slug = ?, closes_at = ?, submission_limit = ?,
               min_speakers = ?, max_speakers = ?, access_mode = ?, access_password_hash = ?,
               status = 'published', revision = revision + 1, last_operation_id = ?,
               updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND revision = ?
           AND EXISTS (
             SELECT 1 FROM form_versions
              WHERE id = ? AND form_id = ? AND status = 'draft' AND revision = ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM form_definitions slug_owner
              WHERE slug_owner.public_slug = ? AND slug_owner.id <> ?
           )
           AND (
             ? IS NULL OR EXISTS (
               SELECT 1 FROM events configured_event
                WHERE configured_event.id = form_definitions.event_id
                  AND configured_event.organisation_id = ?
                  AND configured_event.session_formats_json = ?
             )
           )
           ${routedTeamPredicates}
           ${routedTrackPredicates}
      `,
      ).bind(
        workspace.name,
        workspace.kind,
        workspace.publicSlug,
        workspace.closesAt,
        workspace.submissionLimit,
        workspace.minSpeakers,
        workspace.maxSpeakers,
        workspace.accessMode,
        version.routing.passwordHash,
        publicationId,
        formId,
        eventId,
        formRevision,
        version.id,
        formId,
        draftRevision,
        workspace.publicSlug,
        formId,
        expectedSessionFormatsJson,
        organisationId,
        expectedSessionFormatsJson,
        ...routedTeamBindings,
        ...routedTrackBindings,
      ),
      this.env.DB.prepare(
        `
        UPDATE form_versions SET status = 'retired', retired_at = unixepoch(), updated_at = unixepoch()
         WHERE form_id = ? AND status = 'published'
           AND EXISTS (
             SELECT 1 FROM form_definitions f JOIN events e ON e.id = f.event_id
              WHERE f.id = ? AND f.event_id = ? AND f.revision = ?
                AND f.last_operation_id = ? AND e.organisation_id = ?
           )
      `,
      ).bind(
        formId,
        formId,
        eventId,
        formRevision + 1,
        publicationId,
        organisationId,
      ),
      this.env.DB.prepare(
        `
        UPDATE form_versions SET status = 'published', revision = revision + 1,
               published_at = unixepoch(), updated_at = unixepoch()
         WHERE id = ? AND form_id = ? AND status = 'draft' AND revision = ?
           AND EXISTS (
             SELECT 1 FROM form_definitions
              WHERE id = ? AND event_id = ? AND revision = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        version.id,
        formId,
        draftRevision,
        formId,
        eventId,
        formRevision + 1,
        publicationId,
      ),
      this.env.DB.prepare(
        `
        INSERT OR IGNORE INTO form_versions (
          id, event_id, form_id, version_number, schema_json, routing_json, settings_snapshot_json,
          status, created_by_person_id, created_at, updated_at
        ) SELECT ?, ?, ?, ?, ?, ?, ?, 'draft', ?, unixepoch(), unixepoch()
           WHERE EXISTS (
             SELECT 1 FROM form_versions published
             JOIN form_definitions f ON f.id = published.form_id AND f.event_id = published.event_id
              WHERE published.id = ? AND published.form_id = ?
                AND published.status = 'published' AND published.revision = ?
                AND f.last_operation_id = ?
           )
      `,
      ).bind(
        nextVersionId,
        eventId,
        formId,
        version.versionNumber + 1,
        JSON.stringify(version.schema),
        JSON.stringify(version.routing),
        JSON.stringify(version.settings),
        actorPersonId,
        version.id,
        formId,
        draftRevision + 1,
        publicationId,
      ),
      this.env.DB.prepare(
        `
        INSERT OR IGNORE INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
        ) SELECT ?, ?, ?, ?, 'form.published', 'form_version', ?, ?, unixepoch()
           WHERE EXISTS (
             SELECT 1 FROM form_versions published
             JOIN form_definitions f ON f.id = published.form_id AND f.event_id = published.event_id
              WHERE published.id = ? AND published.form_id = ?
                AND published.status = 'published' AND published.revision = ?
                AND f.last_operation_id = ?
           )
      `,
      ).bind(
        auditId,
        organisationId,
        eventId,
        actorPersonId,
        version.id,
        JSON.stringify({
          version: version.versionNumber,
          publicSlug: workspace.publicSlug,
        }),
        version.id,
        formId,
        draftRevision + 1,
        publicationId,
      ),
    ]);
    if (
      (results[0].meta.changes ?? 0) !== 1 ||
      (results[2].meta.changes ?? 0) !== 1
    ) {
      if (operation) {
        const recovered = await this.env.DB.prepare(
          `SELECT form.id
             FROM form_definitions form
             JOIN events event
               ON event.id = form.event_id AND event.organisation_id = ?
            WHERE form.id = ? AND form.event_id = ?
              AND form.status = 'published' AND form.last_operation_id = ?
              AND EXISTS (
                SELECT 1 FROM form_versions next_draft
                 WHERE next_draft.id = ? AND next_draft.form_id = form.id
                   AND next_draft.event_id = form.event_id
                   AND next_draft.status = 'draft'
              )`,
        )
          .bind(
            organisationId,
            formId,
            eventId,
            operation.operationId,
            operation.nextVersionId,
          )
          .first();
        if (recovered) return;
      }
      const conflictingSlug = await this.env.DB.prepare(
        `
        SELECT id FROM form_definitions
         WHERE public_slug = ? AND id <> ?
         LIMIT 1
      `,
      )
        .bind(workspace.publicSlug, formId)
        .first();
      if (conflictingSlug) {
        throw new SubmissionStateError(
          "That public form URL is already in use. Choose a different slug.",
        );
      }
      if (expectedSessionFormatsJson !== null) {
        const currentFormatConfiguration = await this.env.DB.prepare(
          `SELECT session_formats_json AS sessionFormatsJson
             FROM events WHERE id = ? AND organisation_id = ?`,
        )
          .bind(eventId, organisationId)
          .first<{ sessionFormatsJson: string }>();
        if (
          !currentFormatConfiguration ||
          currentFormatConfiguration.sessionFormatsJson !==
            expectedSessionFormatsJson
        ) {
          throw new SubmissionStateError(
            "The event session-format configuration changed before publication. Refresh the form before publishing it.",
          );
        }
      }
      throw new SubmissionRevisionConflictError();
    }
  }

  async getPublicForm(
    publicSlug: string,
  ): Promise<(FormSummary & { version: FormVersion }) | null> {
    const form = await this.env.DB.prepare(
      `
      SELECT f.id, f.revision, f.event_id AS eventId, e.name AS eventName, e.slug AS eventSlug,
             e.timezone AS eventTimezone, e.allow_anonymous_drafts AS allowAnonymousDrafts,
             e.brand_accent AS brandAccent, e.file_policy_json AS filePolicyJson,
             f.name, f.kind, f.status,
             f.public_slug AS publicSlug, f.closes_at AS closesAt,
             f.submission_limit AS submissionLimit, f.min_speakers AS minSpeakers,
             f.max_speakers AS maxSpeakers, f.access_mode AS accessMode,
             f.access_password_hash AS accessPasswordHash,
             (SELECT COUNT(*) FROM submissions s JOIN form_versions sv ON sv.id = s.form_version_id WHERE sv.form_id = f.id AND s.status <> 'draft') AS submittedCount,
             v.id AS versionId, v.revision AS versionRevision, v.version_number AS versionNumber, v.schema_json AS schemaJson,
             v.routing_json AS routingJson, v.settings_snapshot_json AS settingsSnapshotJson,
             v.status AS versionStatus, v.published_at AS publishedAt
        FROM form_definitions f
        JOIN events e ON e.id = f.event_id
        JOIN form_versions v ON v.form_id = f.id AND v.status = 'published'
       WHERE f.public_slug = ? AND f.status = 'published'
       LIMIT 1
    `,
    )
      .bind(publicSlug)
      .first<
        FormRow & {
          versionId: string;
          versionRevision: number;
          versionNumber: number;
          schemaJson: string;
          routingJson: string;
          settingsSnapshotJson: string;
          versionStatus: FormVersion["status"];
          publishedAt: number | null;
        }
      >();
    if (!form) return null;
    const version = mapVersion({
      id: form.versionId,
      revision: form.versionRevision,
      versionNumber: form.versionNumber,
      schemaJson: form.schemaJson,
      routingJson: form.routingJson,
      settingsSnapshotJson: form.settingsSnapshotJson,
      status: form.versionStatus,
      publishedAt: form.publishedAt,
    });
    return {
      ...mapForm(form),
      ...version.settings,
      accessPasswordHash: version.routing.passwordHash,
      version,
    };
  }
}
