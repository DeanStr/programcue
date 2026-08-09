import {
  formSchemaSchema,
  routingSchema,
  type DraftPayload,
  type FormRouting,
  type SaveFormInput,
  type SubmissionFormSchema,
} from "./submission-schema";
import { eventLocalTimeEpoch } from "~/modules/schedule/schedule-time";
import { materializePublishedResourceAcknowledgementsForClaimedSpeaker } from "~/modules/resources/resource-service.server";

export type FormSummary = {
  id: string;
  revision: number;
  eventId: string;
  eventName: string;
  eventSlug: string;
  eventTimezone: string;
  brandAccent: string;
  name: string;
  kind: "submission" | "direct_session";
  status: "draft" | "published" | "closed" | "archived";
  publicSlug: string;
  closesAt: number | null;
  submissionLimit: number | null;
  minSpeakers: number;
  maxSpeakers: number | null;
  accessMode: "email_verified" | "account_required" | "password_protected";
  accessPasswordHash: string | null;
  submittedCount: number;
};

export type FormVersion = {
  id: string;
  revision: number;
  versionNumber: number;
  status: "draft" | "published" | "retired";
  publishedAt: number | null;
  schema: SubmissionFormSchema;
  routing: FormRouting;
  settings: {
    name?: string;
    kind?: FormSummary["kind"];
    publicSlug?: string;
    closesAt?: number | null;
    submissionLimit?: number | null;
    minSpeakers?: number;
    maxSpeakers?: number | null;
    accessMode?: FormSummary["accessMode"];
  };
};

export type FormWorkspace = FormSummary & {
  draftVersion: FormVersion;
  publishedVersion: FormVersion | null;
  versions: Array<
    Pick<FormVersion, "id" | "versionNumber" | "status" | "publishedAt">
  >;
};

export type Applicant = {
  personId: string;
  email: string;
  name: string;
};

export type ApplicantDraft = {
  id: string;
  title: string;
  category: string;
  format: string;
  status: string;
  answers: Record<string, string | string[]>;
  revision: number;
  formVersionId: string;
  versionNumber: number;
  submittedAt: number | null;
  speakers: Array<{
    personId: string | null;
    name: string;
    email: string;
    position: number;
    isPrimary: boolean;
    invitationStatus: string;
  }>;
};

export type CoSpeakerInvitation = {
  id: string;
  submissionId: string;
  submissionTitle: string;
  displayName: string;
  status: string;
};

export type AdminSubmission = {
  id: string;
  publicReference: string;
  title: string;
  category: string;
  format: string;
  status: string;
  submitterName: string;
  submitterEmail: string;
  speakerCount: number;
  versionNumber: number | null;
  submittedAt: number | null;
  updatedAt: number;
  routedTo: string;
};

function parseJson<T>(value: string, parser: { parse(input: unknown): T }): T {
  return parser.parse(JSON.parse(value));
}

function closeDateFromEpoch(value: number | null, timezone: string) {
  if (value === null) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      calendar: "iso8601",
      numberingSystem: "latn",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(new Date(value * 1_000))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function closeDateToEpoch(value: string | null, timezone: string) {
  if (value === null) return null;
  const endMarker = Math.floor(Date.parse(`${value}T23:59:59Z`) / 1_000);
  return eventLocalTimeEpoch(endMarker + 1, timezone, 0) - 1;
}

function settingsSnapshot(input: SaveFormInput, timezone: string) {
  return {
    name: input.name,
    kind: input.kind,
    publicSlug: input.publicSlug,
    closesAt: closeDateToEpoch(input.closeDate, timezone),
    submissionLimit: input.submissionLimit,
    minSpeakers: input.minSpeakers,
    maxSpeakers: input.maxSpeakers,
    accessMode: input.accessMode,
  };
}

type FormRow = {
  id: string;
  revision: number;
  eventId: string;
  eventName: string;
  eventSlug: string;
  eventTimezone: string;
  brandAccent: string;
  name: string;
  kind: FormSummary["kind"];
  status: FormSummary["status"];
  publicSlug: string;
  closesAt: number | null;
  submissionLimit: number | null;
  minSpeakers: number;
  maxSpeakers: number | null;
  accessMode: FormSummary["accessMode"];
  accessPasswordHash: string | null;
  submittedCount: number;
};

type VersionRow = {
  id: string;
  revision: number;
  versionNumber: number;
  schemaJson: string;
  routingJson: string;
  settingsSnapshotJson: string;
  status: FormVersion["status"];
  publishedAt: number | null;
};

function mapForm(row: FormRow): FormSummary {
  return {
    id: row.id,
    revision: row.revision,
    eventId: row.eventId,
    eventName: row.eventName,
    eventSlug: row.eventSlug,
    eventTimezone: row.eventTimezone,
    brandAccent: row.brandAccent,
    name: row.name,
    kind: row.kind,
    status: row.status,
    publicSlug: row.publicSlug,
    closesAt: row.closesAt,
    submissionLimit: row.submissionLimit,
    minSpeakers: row.minSpeakers,
    maxSpeakers: row.maxSpeakers,
    accessMode: row.accessMode,
    accessPasswordHash: row.accessPasswordHash,
    submittedCount: Number(row.submittedCount),
  };
}

function mapVersion(row: VersionRow): FormVersion {
  return {
    id: row.id,
    revision: row.revision,
    versionNumber: row.versionNumber,
    status: row.status,
    publishedAt: row.publishedAt,
    schema: parseJson(row.schemaJson, formSchemaSchema),
    routing: parseJson(row.routingJson, routingSchema),
    settings: JSON.parse(row.settingsSnapshotJson) as FormVersion["settings"],
  };
}

export class SubmissionRevisionConflictError extends Error {
  constructor() {
    super(
      "This draft changed after the page loaded. Refresh before saving again.",
    );
    this.name = "SubmissionRevisionConflictError";
  }
}

export class SubmissionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SubmissionStateError";
  }
}

export class SubmissionDraftSavedError extends SubmissionStateError {
  constructor(
    message: string,
    readonly submissionId: string,
    readonly draftRevision: number,
  ) {
    super(message);
    this.name = "SubmissionDraftSavedError";
  }
}

export class D1SubmissionRepository {
  constructor(private readonly env: CloudflareEnvironment) {}

  async getAdminWorkspace(
    organisationId: string,
    eventId: string,
    formId?: string,
  ): Promise<FormWorkspace | null> {
    const form = await this.env.DB.prepare(
      `
      SELECT f.id, f.revision, f.event_id AS eventId, e.name AS eventName, e.slug AS eventSlug,
             e.timezone AS eventTimezone,
             e.brand_accent AS brandAccent, f.name, f.kind, f.status,
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
  ) {
    const formId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    const auditId = crypto.randomUUID();
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
          created_at, updated_at
        )
        SELECT ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch()
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
        input.publicSlug,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO form_versions (
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
        INSERT INTO audit_events (
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
  ) {
    const workspace = await this.getAdminWorkspace(
      organisationId,
      eventId,
      formId,
    );
    if (!workspace) throw new Response("Form not found", { status: 404 });
    const auditId = crypto.randomUUID();
    const saveId = crypto.randomUUID();
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
        INSERT INTO audit_events (
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
  ) {
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
    const nextVersionId = crypto.randomUUID();
    const auditId = crypto.randomUUID();
    const publicationId = crypto.randomUUID();
    const version = workspace.draftVersion;
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
        INSERT INTO form_versions (
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
        INSERT INTO audit_events (
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
      throw new SubmissionRevisionConflictError();
    }
  }

  async getPublicForm(
    publicSlug: string,
  ): Promise<(FormSummary & { version: FormVersion }) | null> {
    const form = await this.env.DB.prepare(
      `
      SELECT f.id, f.revision, f.event_id AS eventId, e.name AS eventName, e.slug AS eventSlug,
             e.timezone AS eventTimezone,
             e.brand_accent AS brandAccent, f.name, f.kind, f.status,
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

  async getApplicantDrafts(
    formId: string,
    applicant: Applicant,
  ): Promise<ApplicantDraft[]> {
    const rows = await this.env.DB.prepare(
      `
      SELECT s.id, s.title, COALESCE(s.category, '') AS category, COALESCE(s.format, '') AS format,
             s.status, s.answers_json AS answersJson, s.revision,
             s.form_version_id AS formVersionId, fv.version_number AS versionNumber,
             s.submitted_at AS submittedAt
        FROM submissions s
        JOIN form_versions fv ON fv.id = s.form_version_id AND fv.form_id = ?
       WHERE s.submitter_person_id = ?
       ORDER BY s.updated_at DESC
    `,
    )
      .bind(formId, applicant.personId)
      .all<{
        id: string;
        title: string;
        category: string;
        format: string;
        status: string;
        answersJson: string;
        revision: number;
        formVersionId: string;
        versionNumber: number;
        submittedAt: number | null;
      }>();

    return Promise.all(
      rows.results.map(async (row) => {
        const speakerRows = await this.env.DB.prepare(
          `
        SELECT ss.person_id AS personId, ss.display_name AS name, ss.email, ss.position,
               ss.is_primary AS isPrimary, ss.invitation_status AS invitationStatus
          FROM submission_speakers ss
         WHERE ss.submission_id = ?
         ORDER BY ss.position
      `,
        )
          .bind(row.id)
          .all<{
            personId: string | null;
            name: string;
            email: string;
            position: number;
            isPrimary: number;
            invitationStatus: string;
          }>();
        return {
          ...row,
          answers: JSON.parse(row.answersJson) as Record<
            string,
            string | string[]
          >,
          speakers: speakerRows.results.map((speaker) => ({
            ...speaker,
            isPrimary: Boolean(speaker.isPrimary),
          })),
        };
      }),
    );
  }

  async getCoSpeakerInvitations(
    formId: string,
    applicant: Applicant,
  ): Promise<CoSpeakerInvitation[]> {
    const rows = await this.env.DB.prepare(
      `
      SELECT ss.id, ss.submission_id AS submissionId, s.title AS submissionTitle,
             ss.display_name AS displayName, ss.invitation_status AS status
        FROM submission_speakers ss
        JOIN submissions s ON s.id = ss.submission_id AND s.event_id = ss.event_id
        JOIN form_versions fv ON fv.id = s.form_version_id AND fv.form_id = ?
       WHERE ss.email = ? COLLATE NOCASE
         AND ss.person_id IS NULL
         AND ss.invitation_status IN ('pending', 'sent')
       ORDER BY s.updated_at DESC
    `,
    )
      .bind(formId, applicant.email)
      .all<CoSpeakerInvitation>();
    return rows.results;
  }

  async claimCoSpeaker(
    formId: string,
    applicant: Applicant,
    invitationId: string,
  ) {
    const invitation = await this.env.DB.prepare(
      `
      SELECT speaker.event_id AS eventId
        FROM submission_speakers speaker
        JOIN submissions submission
          ON submission.id = speaker.submission_id
         AND submission.event_id = speaker.event_id
        JOIN form_versions version
          ON version.id = submission.form_version_id
         AND version.event_id = submission.event_id
       WHERE speaker.id = ? AND speaker.email = ? COLLATE NOCASE
         AND version.form_id = ?
    `,
    )
      .bind(invitationId, applicant.email, formId)
      .first<{ eventId: string }>();
    if (!invitation) {
      throw new SubmissionStateError(
        "This co-speaker invitation is no longer available.",
      );
    }
    const operationId = crypto.randomUUID();
    const [eventClaimed, speakerClaimed] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE events
           SET revision = revision + 1, last_operation_id = ?, updated_at = unixepoch()
         WHERE EXISTS (
           SELECT 1
             FROM submission_speakers speaker
             JOIN submissions submission
               ON submission.id = speaker.submission_id
              AND submission.event_id = speaker.event_id
             JOIN form_versions version
               ON version.id = submission.form_version_id
              AND version.event_id = submission.event_id
            WHERE speaker.id = ? AND speaker.event_id = events.id
              AND speaker.email = ? COLLATE NOCASE
              AND speaker.invitation_status IN ('pending', 'sent')
              AND version.form_id = ?
         )
           AND NOT EXISTS (
             SELECT 1
               FROM submission_speakers speaker
               JOIN sessions session
                 ON session.source_submission_id = speaker.submission_id
                AND session.event_id = speaker.event_id
              WHERE speaker.id = ? AND speaker.event_id = events.id
                AND session.status = 'published'
           )
      `,
      ).bind(operationId, invitationId, applicant.email, formId, invitationId),
      this.env.DB.prepare(
        `
        UPDATE submission_speakers
           SET person_id = ?, invitation_status = 'claimed', claimed_at = unixepoch(), updated_at = unixepoch()
         WHERE id = ? AND email = ? COLLATE NOCASE AND invitation_status IN ('pending', 'sent')
           AND EXISTS (
             SELECT 1 FROM submissions s JOIN form_versions fv ON fv.id = s.form_version_id
              WHERE s.id = submission_speakers.submission_id AND fv.form_id = ?
           )
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = submission_speakers.event_id
                AND last_operation_id = ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM sessions
              WHERE source_submission_id = submission_speakers.submission_id
                AND event_id = submission_speakers.event_id
                AND status = 'published'
           )
      `,
      ).bind(
        applicant.personId,
        invitationId,
        applicant.email,
        formId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action, entity_type,
          entity_id, correlation_id, metadata_json, created_at
        )
        SELECT ?, event.organisation_id, speaker.event_id, ?,
               'submission.speaker.claimed', 'submission_speaker', ?, ?, '{}', unixepoch()
          FROM submission_speakers speaker
          JOIN events event ON event.id = speaker.event_id
         WHERE speaker.id = ? AND speaker.person_id = ?
           AND speaker.invitation_status = 'claimed'
           AND event.last_operation_id = ?
      `,
      ).bind(
        crypto.randomUUID(),
        applicant.personId,
        invitationId,
        operationId,
        invitationId,
        applicant.personId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO session_speakers (
          session_id, event_id, person_id, position, role_label, visibility
        )
        SELECT session.id, session.event_id, speaker.person_id,
               COALESCE((
                 SELECT MAX(existing.position) + 1
                   FROM session_speakers existing
                  WHERE existing.session_id = session.id
               ), 0),
               CASE WHEN speaker.is_primary = 1 THEN 'Primary speaker' ELSE 'Co-speaker' END,
               'public'
          FROM submission_speakers speaker
          JOIN sessions session
            ON session.source_submission_id = speaker.submission_id
           AND session.event_id = speaker.event_id
         WHERE speaker.id = ? AND speaker.person_id = ?
           AND speaker.invitation_status = 'claimed'
           AND session.status <> 'published'
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = speaker.event_id AND last_operation_id = ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM session_speakers existing
              WHERE existing.session_id = session.id
                AND existing.person_id = speaker.person_id
           )
      `,
      ).bind(invitationId, applicant.personId, operationId),
      ...materializePublishedResourceAcknowledgementsForClaimedSpeaker(
        this.env,
        invitation.eventId,
        invitationId,
        applicant.personId,
        operationId,
      ),
    ]);
    if (
      (eventClaimed.meta.changes ?? 0) !== 1 ||
      (speakerClaimed.meta.changes ?? 0) !== 1
    ) {
      const publishedSession = await this.env.DB.prepare(
        `
        SELECT session.id
          FROM submission_speakers speaker
          JOIN submissions submission
            ON submission.id = speaker.submission_id
           AND submission.event_id = speaker.event_id
          JOIN form_versions version
            ON version.id = submission.form_version_id
           AND version.event_id = submission.event_id
          JOIN sessions session
            ON session.source_submission_id = speaker.submission_id
           AND session.event_id = speaker.event_id
         WHERE speaker.id = ? AND speaker.email = ? COLLATE NOCASE
           AND version.form_id = ? AND session.status = 'published'
         LIMIT 1
      `,
      )
        .bind(invitationId, applicant.email, formId)
        .first();
      if (publishedSession) {
        throw new SubmissionStateError(
          "This accepted session is already published, so its speaker list is locked. Contact an administrator to resolve this invitation.",
        );
      }
      throw new SubmissionStateError(
        "This co-speaker invitation is no longer available.",
      );
    }
  }

  async getApplicantDraftForm(
    publicForm: FormSummary & { version: FormVersion },
    applicant: Applicant,
    submissionId: string,
  ) {
    const version = await this.env.DB.prepare(
      `
      SELECT fv.id, fv.revision, fv.version_number AS versionNumber, fv.schema_json AS schemaJson,
             fv.routing_json AS routingJson, fv.settings_snapshot_json AS settingsSnapshotJson,
             fv.status, fv.published_at AS publishedAt
        FROM submissions s
        JOIN form_versions fv ON fv.id = s.form_version_id AND fv.form_id = ?
       WHERE s.id = ? AND s.event_id = ? AND s.submitter_person_id = ?
       LIMIT 1
    `,
    )
      .bind(publicForm.id, submissionId, publicForm.eventId, applicant.personId)
      .first<VersionRow>();
    if (!version)
      throw new Response("Application draft not found", { status: 404 });
    const mapped = mapVersion(version);
    return {
      ...publicForm,
      ...mapped.settings,
      accessPasswordHash: mapped.routing.passwordHash,
      version: mapped,
    };
  }

  async createDraft(
    form: FormSummary & { version: FormVersion },
    applicant: Applicant,
  ) {
    const id = crypto.randomUUID();
    const publicReference = `PC-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    await this.env.DB.batch([
      this.env.DB.prepare(
        `
        INSERT INTO submissions (
          id, event_id, form_version_id, submitter_person_id, submitter_email,
          public_reference, title, status, answers_json, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'Untitled application', 'draft', '{}', 1, unixepoch(), unixepoch())
      `,
      ).bind(
        id,
        form.eventId,
        form.version.id,
        applicant.personId,
        applicant.email,
        publicReference,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO submission_speakers (
          id, event_id, submission_id, person_id, email, display_name, position,
          invitation_status, is_primary, claimed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 0, 'claimed', 1, unixepoch(), unixepoch(), unixepoch())
      `,
      ).bind(
        crypto.randomUUID(),
        form.eventId,
        id,
        applicant.personId,
        applicant.email,
        applicant.name,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO submission_revisions (
          id, event_id, submission_id, form_version_id, revision_number, answers_json,
          speaker_snapshot_json, save_kind, saved_by_person_id, created_at
        ) VALUES (?, ?, ?, ?, 1, '{}', ?, 'manual', ?, unixepoch())
      `,
      ).bind(
        crypto.randomUUID(),
        form.eventId,
        id,
        form.version.id,
        JSON.stringify([
          { name: applicant.name, email: applicant.email, isPrimary: true },
        ]),
        applicant.personId,
      ),
    ]);
    return id;
  }

  async saveDraft(
    form: FormSummary & { version: FormVersion },
    applicant: Applicant,
    payload: DraftPayload,
  ) {
    const operationId = crypto.randomUUID();
    const nextRevision = payload.revision + 1;
    const title =
      String(payload.answers.title || "Untitled application").trim() ||
      "Untitled application";
    const category = String(payload.answers.category || "").trim() || null;
    const format = String(payload.answers.format || "").trim() || null;
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `
        UPDATE submissions
           SET title = ?, category = ?, format = ?, answers_json = ?, revision = revision + 1,
               last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND submitter_person_id = ? AND form_version_id = ?
           AND status = 'draft' AND revision = ?
      `,
      ).bind(
        title,
        category,
        format,
        JSON.stringify(payload.answers),
        operationId,
        payload.submissionId,
        form.eventId,
        applicant.personId,
        form.version.id,
        payload.revision,
      ),
    ];
    // Move existing positions out of the unique range before the email-keyed
    // upserts below. This preserves a co-speaker's claimed identity/status
    // across subsequent submitter saves, including case-only email changes.
    statements.push(
      this.env.DB.prepare(
        `
      UPDATE submission_speakers SET position = position + 10000, updated_at = unixepoch()
       WHERE submission_id = ?
         AND EXISTS (SELECT 1 FROM submissions WHERE id = ? AND last_operation_id = ?)
    `,
      ).bind(payload.submissionId, payload.submissionId, operationId),
    );
    payload.speakers.forEach((speaker, position) => {
      statements.push(
        this.env.DB.prepare(
          `
        INSERT INTO submission_speakers (
          id, event_id, submission_id, person_id, email, display_name, position,
          invitation_status, is_primary, invited_at, claimed_at, created_at, updated_at
        )
        SELECT ?, ?, ?, CASE WHEN ? = ? COLLATE NOCASE THEN ? ELSE NULL END, ?, ?, ?,
               CASE WHEN ? = ? COLLATE NOCASE THEN 'claimed' ELSE 'pending' END, ?,
               CASE WHEN ? = ? COLLATE NOCASE THEN NULL ELSE unixepoch() END,
               CASE WHEN ? = ? COLLATE NOCASE THEN unixepoch() ELSE NULL END,
               unixepoch(), unixepoch()
         WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ? AND last_operation_id = ?)
        ON CONFLICT(submission_id, email) DO UPDATE SET
          person_id = CASE
            WHEN submission_speakers.invitation_status = 'claimed' THEN submission_speakers.person_id
            ELSE excluded.person_id
          END,
          display_name = excluded.display_name,
          position = excluded.position,
          invitation_status = CASE
            WHEN submission_speakers.invitation_status = 'claimed' THEN 'claimed'
            ELSE excluded.invitation_status
          END,
          is_primary = excluded.is_primary,
          invited_at = CASE
            WHEN submission_speakers.invitation_status = 'claimed' THEN submission_speakers.invited_at
            ELSE COALESCE(submission_speakers.invited_at, excluded.invited_at)
          END,
          claimed_at = CASE
            WHEN submission_speakers.invitation_status = 'claimed' THEN submission_speakers.claimed_at
            ELSE excluded.claimed_at
          END,
          updated_at = unixepoch()
      `,
        ).bind(
          crypto.randomUUID(),
          form.eventId,
          payload.submissionId,
          speaker.email,
          applicant.email,
          applicant.personId,
          speaker.email,
          speaker.name,
          position,
          speaker.email,
          applicant.email,
          position === 0 ? 1 : 0,
          speaker.email,
          applicant.email,
          speaker.email,
          applicant.email,
          payload.submissionId,
          operationId,
        ),
      );
    });
    statements.push(
      this.env.DB.prepare(
        `
      DELETE FROM submission_speakers
       WHERE submission_id = ?
         AND lower(email) NOT IN (
           SELECT lower(json_extract(value, '$.email')) FROM json_each(?)
         )
         AND EXISTS (SELECT 1 FROM submissions WHERE id = ? AND last_operation_id = ?)
    `,
      ).bind(
        payload.submissionId,
        JSON.stringify(payload.speakers),
        payload.submissionId,
        operationId,
      ),
    );
    statements.push(
      this.env.DB.prepare(
        `
      INSERT INTO submission_revisions (
        id, event_id, submission_id, form_version_id, revision_number, answers_json,
        speaker_snapshot_json, save_kind, saved_by_person_id, idempotency_key, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, unixepoch()
       WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ? AND last_operation_id = ?)
    `,
      ).bind(
        crypto.randomUUID(),
        form.eventId,
        payload.submissionId,
        form.version.id,
        nextRevision,
        JSON.stringify(payload.answers),
        JSON.stringify(payload.speakers),
        applicant.personId,
        operationId,
        payload.submissionId,
        operationId,
      ),
    );
    statements.push(
      this.env.DB.prepare(
        `
      INSERT INTO audit_events (
        id, organisation_id, event_id, actor_person_id, action, entity_type,
        entity_id, metadata_json, created_at
      )
      SELECT ?, event.organisation_id, ?, ?, 'submission.draft.saved',
             'submission', ?, ?, unixepoch()
        FROM events event
       WHERE event.id = ?
         AND EXISTS (SELECT 1 FROM submissions WHERE id = ? AND last_operation_id = ?)
    `,
      ).bind(
        crypto.randomUUID(),
        form.eventId,
        applicant.personId,
        payload.submissionId,
        JSON.stringify({
          speakerCount: payload.speakers.length,
          revision: nextRevision,
        }),
        form.eventId,
        payload.submissionId,
        operationId,
      ),
    );

    const results = await this.env.DB.batch(statements);
    if ((results[0].meta.changes ?? 0) !== 1)
      throw new SubmissionRevisionConflictError();
    return nextRevision;
  }

  async submitDraft(
    form: FormSummary & { version: FormVersion },
    applicant: Applicant,
    payload: DraftPayload,
  ) {
    const revision = await this.saveDraft(form, applicant, payload);
    const operationId = crypto.randomUUID();
    const confirmationOperationId = crypto.randomUUID();
    const confirmationCommunicationId = crypto.randomUUID();
    const confirmationIdempotencyKey = `submission-confirmation:${payload.submissionId}`;
    const event = await this.env.DB.prepare(
      `
      SELECT organisation_id AS organisationId FROM events WHERE id = ?
    `,
    )
      .bind(form.eventId)
      .first<{ organisationId: string }>();
    if (!event)
      throw new SubmissionStateError("The submission event is unavailable.");
    const confirmationMessage = {
      type: "submission.notification" as const,
      operationId: confirmationOperationId,
      communicationId: confirmationCommunicationId,
      submissionId: payload.submissionId,
      eventId: form.eventId,
      organisationId: event.organisationId,
      idempotencyKey: confirmationIdempotencyKey,
    };
    const nextRevision = revision + 1;
    const submissionSnapshot = JSON.stringify({
      formVersionId: form.version.id,
      versionNumber: form.version.versionNumber,
      schema: form.version.schema,
      answers: payload.answers,
      speakers: payload.speakers,
    });
    const [result] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE submissions
           SET status = 'submitted', submitted_snapshot_json = ?, revision = revision + 1,
               last_operation_id = ?, submitted_at = unixepoch(), updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND submitter_person_id = ? AND form_version_id = ?
           AND status = 'draft' AND revision = ?
           AND EXISTS (
             SELECT 1 FROM form_definitions current_form
              WHERE current_form.id = ? AND current_form.event_id = ?
                AND current_form.status = 'published'
                AND (current_form.closes_at IS NULL OR current_form.closes_at >= unixepoch())
                AND (
                  current_form.submission_limit IS NULL OR (
                    SELECT COUNT(*) FROM submissions current
                    JOIN form_versions current_version
                      ON current_version.id = current.form_version_id
                   WHERE current_version.form_id = current_form.id
                     AND current.status <> 'draft'
                  ) < current_form.submission_limit
                )
           )
      `,
      ).bind(
        submissionSnapshot,
        operationId,
        payload.submissionId,
        form.eventId,
        applicant.personId,
        form.version.id,
        revision,
        form.id,
        form.eventId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO submission_revisions (
          id, event_id, submission_id, form_version_id, revision_number, answers_json,
          speaker_snapshot_json, save_kind, saved_by_person_id, idempotency_key, created_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, unixepoch()
         WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ? AND last_operation_id = ? AND status = 'submitted')
      `,
      ).bind(
        crypto.randomUUID(),
        form.eventId,
        payload.submissionId,
        form.version.id,
        nextRevision,
        JSON.stringify(payload.answers),
        JSON.stringify(payload.speakers),
        applicant.personId,
        operationId,
        payload.submissionId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action, entity_type,
          entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, 'submission.submitted', 'submission', ?, ?, unixepoch()
         WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ? AND last_operation_id = ? AND status = 'submitted')
      `,
      ).bind(
        crypto.randomUUID(),
        event.organisationId,
        form.eventId,
        applicant.personId,
        payload.submissionId,
        JSON.stringify({
          formVersionId: form.version.id,
          version: form.version.versionNumber,
        }),
        payload.submissionId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO communications (
          id, event_id, operation_id, idempotency_key, kind, channel, status, audience_json,
          content_snapshot_json, recipient_count, queued_at, created_by_person_id, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, 'transactional', 'email', 'queued', ?, ?, 1, unixepoch(), ?, unixepoch(), unixepoch()
         WHERE EXISTS (SELECT 1 FROM submissions WHERE id = ? AND last_operation_id = ? AND status = 'submitted')
      `,
      ).bind(
        confirmationCommunicationId,
        form.eventId,
        confirmationOperationId,
        confirmationIdempotencyKey,
        JSON.stringify({
          kind: "submission_confirmation",
          personIds: [applicant.personId],
          emails: [applicant.email],
        }),
        JSON.stringify({
          schemaVersion: 1,
          category: "submission_confirmation",
          pendingMaterialization: true,
          submissionId: payload.submissionId,
        }),
        applicant.personId,
        payload.submissionId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO operation_jobs (
          id, organisation_id, event_id, requested_by_person_id, type, idempotency_key,
          correlation_id, status, payload_json, progress_total, progress_completed,
          progress_failed, cancellable, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, 'submission.notification', ?, ?, 'queued', ?, 1, 0, 0, 0, unixepoch(), unixepoch()
         WHERE EXISTS (SELECT 1 FROM communications WHERE id = ? AND event_id = ?)
      `,
      ).bind(
        confirmationOperationId,
        event.organisationId,
        form.eventId,
        applicant.personId,
        confirmationIdempotencyKey,
        crypto.randomUUID(),
        JSON.stringify(confirmationMessage),
        confirmationCommunicationId,
        form.eventId,
      ),
    ]);
    if ((result.meta.changes ?? 0) !== 1) {
      throw new SubmissionDraftSavedError(
        "Applications closed or reached their limit before final submission. Your latest changes were saved as a draft.",
        payload.submissionId,
        revision,
      );
    }
    try {
      if (!this.env.OPERATIONS_QUEUE)
        throw new Error("Required OPERATIONS_QUEUE binding is unavailable.");
      await this.env.OPERATIONS_QUEUE.send(confirmationMessage);
      return {
        submissionId: payload.submissionId,
        eventId: form.eventId,
        organisationId: event.organisationId,
        confirmation: {
          status: "queued" as const,
          communicationId: confirmationCommunicationId,
          operationId: confirmationOperationId,
        },
      };
    } catch (error) {
      const message = (
        error instanceof Error ? error.message : String(error)
      ).slice(0, 2_000);
      await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE operation_jobs SET status = 'queue_failed', last_error = ?, updated_at = unixepoch()
          WHERE id = ? AND event_id = ?`,
        ).bind(message, confirmationOperationId, form.eventId),
        this.env.DB.prepare(
          `UPDATE communications SET status = 'failed', updated_at = unixepoch()
          WHERE id = ? AND event_id = ?`,
        ).bind(confirmationCommunicationId, form.eventId),
      ]);
      return {
        submissionId: payload.submissionId,
        eventId: form.eventId,
        organisationId: event.organisationId,
        confirmation: {
          status: "queue_failed" as const,
          communicationId: confirmationCommunicationId,
          operationId: confirmationOperationId,
          message,
        },
      };
    }
  }

  async listAdminSubmissions(
    organisationId: string,
    eventId: string,
    filters: { status?: string; category?: string; query?: string },
  ): Promise<AdminSubmission[]> {
    const query = `%${filters.query ?? ""}%`;
    const rows = await this.env.DB.prepare(
      `
      SELECT s.id, s.public_reference AS publicReference, s.title, COALESCE(s.category, '') AS category,
             COALESCE(s.format, '') AS format, s.status,
             COALESCE(p.display_name, s.submitter_email, 'Unknown') AS submitterName,
             COALESCE(p.email, s.submitter_email, '') AS submitterEmail,
             (SELECT COUNT(*) FROM submission_speakers ss WHERE ss.submission_id = s.id) AS speakerCount,
             fv.version_number AS versionNumber, s.submitted_at AS submittedAt, s.updated_at AS updatedAt,
             COALESCE(fv.routing_json, '{}') AS routingJson
        FROM submissions s
        JOIN events e ON e.id = s.event_id AND e.organisation_id = ?
        LEFT JOIN people p ON p.id = s.submitter_person_id
        LEFT JOIN form_versions fv ON fv.id = s.form_version_id
       WHERE s.event_id = ?
         AND (? = '' OR s.status = ?)
         AND (? = '' OR s.category = ?)
         AND (? = '%%' OR s.title LIKE ? OR p.display_name LIKE ? OR COALESCE(p.email, s.submitter_email) LIKE ?)
       ORDER BY COALESCE(s.submitted_at, s.updated_at) DESC
       LIMIT 200
    `,
    )
      .bind(
        organisationId,
        eventId,
        filters.status ?? "",
        filters.status ?? "",
        filters.category ?? "",
        filters.category ?? "",
        query,
        query,
        query,
        query,
      )
      .all<Omit<AdminSubmission, "routedTo"> & { routingJson: string }>();
    return rows.results.map(({ routingJson, ...row }) => ({
      ...row,
      speakerCount: Number(row.speakerCount),
      routedTo:
        routingSchema.parse(JSON.parse(routingJson)).categories[row.category] ||
        "Unassigned",
    }));
  }

  async getAdminSubmission(
    organisationId: string,
    eventId: string,
    submissionId: string,
  ) {
    const row = await this.env.DB.prepare(
      `
      SELECT s.id, s.title, s.category, s.format, s.status, s.answers_json AS answersJson,
             s.submitted_at AS submittedAt, s.updated_at AS updatedAt,
             COALESCE(p.display_name, s.submitter_email) AS submitterName,
             COALESCE(p.email, s.submitter_email) AS submitterEmail,
             fv.version_number AS versionNumber, fv.schema_json AS schemaJson,
             COALESCE(fv.routing_json, '{}') AS routingJson
        FROM submissions s
        JOIN events e ON e.id = s.event_id AND e.organisation_id = ?
        LEFT JOIN people p ON p.id = s.submitter_person_id
        LEFT JOIN form_versions fv ON fv.id = s.form_version_id
       WHERE s.event_id = ? AND s.id = ?
    `,
    )
      .bind(organisationId, eventId, submissionId)
      .first<{
        id: string;
        title: string;
        category: string | null;
        format: string | null;
        status: string;
        answersJson: string;
        submittedAt: number | null;
        updatedAt: number;
        submitterName: string | null;
        submitterEmail: string | null;
        versionNumber: number | null;
        schemaJson: string | null;
        routingJson: string;
      }>();
    if (!row) return null;
    const speakers = await this.env.DB.prepare(
      `
      SELECT ss.id, ss.display_name AS name, ss.email, ss.position,
             ss.invitation_status AS invitationStatus, ss.is_primary AS isPrimary
        FROM submission_speakers ss
       WHERE ss.submission_id = ? ORDER BY ss.position
    `,
    )
      .bind(submissionId)
      .all<{
        id: string;
        name: string;
        email: string;
        position: number;
        invitationStatus: string;
        isPrimary: number;
      }>();
    return {
      ...row,
      answers: JSON.parse(row.answersJson) as Record<string, string | string[]>,
      schema: row.schemaJson
        ? parseJson(row.schemaJson, formSchemaSchema)
        : null,
      routedTo:
        routingSchema.parse(JSON.parse(row.routingJson)).categories[
          row.category ?? ""
        ] || "Unassigned",
      speakers: speakers.results.map((speaker) => ({
        ...speaker,
        isPrimary: Boolean(speaker.isPrimary),
      })),
    };
  }

  static closeDateFromEpoch = closeDateFromEpoch;
}
