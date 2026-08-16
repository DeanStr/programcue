import type { Viewer } from "~/platform/auth/authorize.server";
import { eventLocalCalendarDate } from "~/modules/schedule/schedule-time";
import {
  parsePersistedProgrammeEmbedConfiguration,
  type ProgrammeEmbedConfiguration,
} from "./programme-embed-configuration";
import { PublicProgrammeService } from "./public-programme-service.server";

export type ProgrammeEmbedStatus = "draft" | "active" | "paused" | "revoked";

export type ManagedProgrammeEmbed = {
  id: string;
  name: string;
  slug: string;
  status: ProgrammeEmbedStatus;
  configuration: ProgrammeEmbedConfiguration;
  installationNote: string | null;
  revision: number;
  createdByName: string;
  updatedByName: string;
  createdAt: number;
  updatedAt: number;
  revokedAt: number | null;
};

type EmbedRow = Omit<ManagedProgrammeEmbed, "configuration"> & {
  configurationJson: string;
};

type PublicEmbedRow = {
  id: string;
  slug: string;
  status: ProgrammeEmbedStatus;
  configurationJson: string;
  revision: number;
  eventName: string;
  eventAccent: string;
};

export class ProgrammeEmbedStateError extends Error {
  constructor(
    message: string,
    readonly status = 422,
  ) {
    super(message);
    this.name = "ProgrammeEmbedStateError";
  }
}

export class ProgrammeEmbedRevisionConflictError extends ProgrammeEmbedStateError {
  constructor() {
    super(
      "This managed embed changed since the page loaded. Refresh and try again.",
      409,
    );
    this.name = "ProgrammeEmbedRevisionConflictError";
  }
}

function requiredText(value: unknown, label: string, maximum: number) {
  if (typeof value !== "string") {
    throw new ProgrammeEmbedStateError(`${label} must be text.`);
  }
  const parsed = value.trim();
  if (!parsed || parsed.length > maximum) {
    throw new ProgrammeEmbedStateError(
      `${label} must contain between 1 and ${maximum} characters.`,
    );
  }
  return parsed;
}

function optionalNote(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw new ProgrammeEmbedStateError("Installation note must be text.");
  }
  const parsed = value.trim();
  if (!parsed) return null;
  if (parsed.length > 500) {
    throw new ProgrammeEmbedStateError(
      "Installation note must contain at most 500 characters.",
    );
  }
  return parsed;
}

function embedSlug(value: unknown) {
  const parsed = requiredText(value, "Stable slug", 80);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(parsed)) {
    throw new ProgrammeEmbedStateError(
      "Stable slug must use lowercase letters, numbers and single hyphens.",
    );
  }
  return parsed;
}

function positiveRevision(value: unknown) {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+$/u.test(value)
        ? Number(value)
        : Number.NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ProgrammeEmbedRevisionConflictError();
  }
  return parsed;
}

function parseConfigurationJson(value: unknown) {
  if (typeof value !== "string") {
    throw new ProgrammeEmbedStateError(
      "Managed embed configuration must be JSON text. Refresh and try again.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new ProgrammeEmbedStateError(
      "Managed embed configuration is invalid. Refresh and try again.",
    );
  }
  return parsePersistedProgrammeEmbedConfiguration(parsed);
}

function parseRow(row: EmbedRow): ManagedProgrammeEmbed {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.configurationJson);
  } catch {
    throw new ProgrammeEmbedStateError(
      `Managed embed ${row.id} has corrupt persisted configuration.`,
      500,
    );
  }
  return {
    ...row,
    configuration: parsePersistedProgrammeEmbedConfiguration(parsed),
  };
}

function auditMetadata<T extends { status: string; revision: number }>(
  before: unknown,
  after: T,
) {
  return JSON.stringify({
    before,
    after,
    status: after.status,
    revision: after.revision,
  });
}

function auditSnapshot(embed: ManagedProgrammeEmbed) {
  return {
    name: embed.name,
    slug: embed.slug,
    status: embed.status,
    configuration: embed.configuration,
    installationNote: embed.installationNote,
    revision: embed.revision,
  };
}

export class ProgrammeEmbedService {
  constructor(private readonly env: CloudflareEnvironment) {}

  async list(viewer: Viewer) {
    const rows = await this.env.DB.prepare(
      `SELECT embed.id, embed.name, embed.slug, embed.status,
              embed.configuration_json AS configurationJson,
              embed.installation_note AS installationNote,
              embed.revision, creator.display_name AS createdByName,
              updater.display_name AS updatedByName,
              embed.created_at AS createdAt, embed.updated_at AS updatedAt,
              embed.revoked_at AS revokedAt
         FROM programme_embeds embed
         JOIN events event
           ON event.id = embed.event_id AND event.organisation_id = ?
         JOIN people creator ON creator.id = embed.created_by_person_id
         JOIN people updater ON updater.id = embed.updated_by_person_id
        WHERE embed.event_id = ?
        ORDER BY CASE embed.status
                   WHEN 'active' THEN 0 WHEN 'paused' THEN 1
                   WHEN 'draft' THEN 2 ELSE 3 END,
                 embed.updated_at DESC, embed.id`,
    )
      .bind(viewer.organisationId, viewer.eventId)
      .all<EmbedRow>();
    return rows.results.map(parseRow);
  }

  async create(
    viewer: Viewer,
    input: {
      name: unknown;
      slug: unknown;
      installationNote: unknown;
      configurationJson: unknown;
    },
  ) {
    const id = crypto.randomUUID();
    const name = requiredText(input.name, "Embed name", 120);
    const slug = embedSlug(input.slug);
    const installationNote = optionalNote(input.installationNote);
    const configuration = parseConfigurationJson(input.configurationJson);
    const configurationJson = JSON.stringify(configuration);
    const auditId = crypto.randomUUID();
    let audited: D1Result;
    let created: D1Result;
    try {
      [audited, created] = await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id,
           actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, event.organisation_id, event.id, ?,
                'programme_embed.created',
                'programme_embed', ?, ?, unixepoch()
           FROM events event
          WHERE event.id = ? AND event.organisation_id = ?`,
        ).bind(
          auditId,
          viewer.personId,
          id,
          auditMetadata(null, {
            name,
            slug,
            status: "draft",
            configuration,
            installationNote,
            revision: 1,
          }),
          viewer.eventId,
          viewer.organisationId,
        ),
        this.env.DB.prepare(
          `INSERT INTO programme_embeds (
             id, event_id, organisation_id, name, slug, status,
             configuration_json, installation_note, revision,
             created_by_person_id, updated_by_person_id, created_at, updated_at
           )
           SELECT ?, event.id, event.organisation_id, ?, ?, 'draft', ?, ?, 1,
                  ?, ?, unixepoch(), unixepoch()
             FROM events event
            WHERE event.id = ? AND event.organisation_id = ?
              AND EXISTS (
                SELECT 1 FROM audit_events audit
                 WHERE audit.id = ?
                   AND audit.organisation_id = event.organisation_id
                   AND audit.event_id = event.id
                   AND audit.action = 'programme_embed.created'
                   AND audit.entity_type = 'programme_embed'
                   AND audit.entity_id = ?
              )`,
        ).bind(
          id,
          name,
          slug,
          configurationJson,
          installationNote,
          viewer.personId,
          viewer.personId,
          viewer.eventId,
          viewer.organisationId,
          auditId,
          id,
        ),
      ]);
    } catch (error) {
      if (
        error instanceof Error &&
        /UNIQUE constraint failed: programme_embeds\.event_id, programme_embeds\.slug/iu.test(
          error.message,
        )
      ) {
        throw new ProgrammeEmbedStateError(
          "That stable slug is already reserved for this event.",
          409,
        );
      }
      throw error;
    }
    if (
      (audited.meta.changes ?? 0) !== 1 ||
      (created.meta.changes ?? 0) !== 1
    ) {
      throw new ProgrammeEmbedStateError(
        "The managed embed could not be created with its required audit history.",
        500,
      );
    }
    return id;
  }

  async update(
    viewer: Viewer,
    input: {
      id: unknown;
      revision: unknown;
      name: unknown;
      installationNote: unknown;
      configurationJson: unknown;
      confirmed: unknown;
    },
  ) {
    const id = requiredText(input.id, "Embed id", 200);
    const revision = positiveRevision(input.revision);
    const current = await this.current(viewer, id);
    if (current.status === "revoked") {
      throw new ProgrammeEmbedStateError(
        "A revoked embed is permanent and cannot be changed.",
        409,
      );
    }
    if (current.revision !== revision)
      throw new ProgrammeEmbedRevisionConflictError();
    const name = requiredText(input.name, "Embed name", 120);
    const installationNote = optionalNote(input.installationNote);
    const configuration = parseConfigurationJson(input.configurationJson);
    if (current.status === "active") {
      await this.requirePublishedConfiguration(viewer, configuration);
    }
    if (input.confirmed !== "yes") {
      throw new ProgrammeEmbedStateError(
        "Preview the configuration and confirm the update before saving.",
      );
    }
    const after = {
      name,
      slug: current.slug,
      status: current.status,
      configuration,
      installationNote,
      revision: revision + 1,
    };
    const auditId = crypto.randomUUID();
    const [audited, updated] = await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id,
           actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, embed.organisation_id,
                embed.event_id, ?,
                'programme_embed.updated', 'programme_embed', embed.id, ?, unixepoch()
           FROM programme_embeds embed
           JOIN events event
             ON event.id = embed.event_id
            AND event.organisation_id = embed.organisation_id
          WHERE embed.id = ? AND embed.event_id = ?
            AND embed.organisation_id = ? AND embed.revision = ?
            AND embed.status <> 'revoked'`,
      ).bind(
        auditId,
        viewer.personId,
        auditMetadata(auditSnapshot(current), after),
        id,
        viewer.eventId,
        viewer.organisationId,
        revision,
      ),
      this.env.DB.prepare(
        `UPDATE programme_embeds
            SET name = ?, configuration_json = ?, installation_note = ?,
                revision = revision + 1, updated_by_person_id = ?,
                updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND organisation_id = ?
            AND revision = ? AND status <> 'revoked'
            AND EXISTS (
              SELECT 1 FROM audit_events audit
               WHERE audit.id = ?
                 AND audit.organisation_id = programme_embeds.organisation_id
                 AND audit.event_id = programme_embeds.event_id
                 AND audit.action = 'programme_embed.updated'
                 AND audit.entity_type = 'programme_embed'
                 AND audit.entity_id = programme_embeds.id
            )`,
      ).bind(
        name,
        JSON.stringify(configuration),
        installationNote,
        viewer.personId,
        id,
        viewer.eventId,
        viewer.organisationId,
        revision,
        auditId,
      ),
    ]);
    if (
      (audited.meta.changes ?? 0) !== 1 ||
      (updated.meta.changes ?? 0) !== 1
    ) {
      await this.throwAuditBoundaryFailure(
        viewer,
        id,
        revision,
        current.status,
      );
    }
  }

  async transition(
    viewer: Viewer,
    input: {
      id: unknown;
      revision: unknown;
      nextStatus: unknown;
      confirmed: unknown;
    },
  ) {
    const id = requiredText(input.id, "Embed id", 200);
    const revision = positiveRevision(input.revision);
    if (typeof input.nextStatus !== "string") {
      throw new ProgrammeEmbedStateError(
        "That managed embed lifecycle change is not allowed.",
        409,
      );
    }
    const nextStatus = input.nextStatus as ProgrammeEmbedStatus;
    const current = await this.current(viewer, id);
    if (current.revision !== revision)
      throw new ProgrammeEmbedRevisionConflictError();
    const allowed: Record<ProgrammeEmbedStatus, ProgrammeEmbedStatus[]> = {
      draft: ["active", "revoked"],
      active: ["paused", "revoked"],
      paused: ["active", "revoked"],
      revoked: [],
    };
    if (!allowed[current.status].includes(nextStatus)) {
      throw new ProgrammeEmbedStateError(
        "That managed embed lifecycle change is not allowed.",
        409,
      );
    }
    if (input.confirmed !== "yes") {
      throw new ProgrammeEmbedStateError(
        nextStatus === "revoked"
          ? "Confirm permanent revocation before continuing."
          : "Preview and confirm the lifecycle change before continuing.",
      );
    }
    if (nextStatus === "active") {
      await this.requirePublishedConfiguration(viewer, current.configuration);
    }
    const after = {
      ...auditSnapshot(current),
      status: nextStatus,
      revision: revision + 1,
    };
    const action =
      nextStatus === "active"
        ? current.status === "paused"
          ? "programme_embed.resumed"
          : "programme_embed.activated"
        : nextStatus === "paused"
          ? "programme_embed.paused"
          : "programme_embed.revoked";
    const auditId = crypto.randomUUID();
    const [audited, updated] = await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id,
           actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, embed.organisation_id,
                embed.event_id, ?, ?,
                'programme_embed', embed.id, ?, unixepoch()
           FROM programme_embeds embed
           JOIN events event
             ON event.id = embed.event_id
            AND event.organisation_id = embed.organisation_id
          WHERE embed.id = ? AND embed.event_id = ?
            AND embed.organisation_id = ? AND embed.revision = ?
            AND embed.status = ?`,
      ).bind(
        auditId,
        viewer.personId,
        action,
        auditMetadata(auditSnapshot(current), after),
        id,
        viewer.eventId,
        viewer.organisationId,
        revision,
        current.status,
      ),
      this.env.DB.prepare(
        `UPDATE programme_embeds
            SET status = ?, revision = revision + 1,
                updated_by_person_id = ?, updated_at = unixepoch(),
                revoked_at = CASE WHEN ? = 'revoked' THEN unixepoch() ELSE NULL END
          WHERE id = ? AND event_id = ? AND organisation_id = ?
            AND revision = ? AND status = ?
            AND EXISTS (
              SELECT 1 FROM audit_events audit
               WHERE audit.id = ?
                 AND audit.organisation_id = programme_embeds.organisation_id
                 AND audit.event_id = programme_embeds.event_id
                 AND audit.action = ?
                 AND audit.entity_type = 'programme_embed'
                 AND audit.entity_id = programme_embeds.id
            )`,
      ).bind(
        nextStatus,
        viewer.personId,
        nextStatus,
        id,
        viewer.eventId,
        viewer.organisationId,
        revision,
        current.status,
        auditId,
        action,
      ),
    ]);
    if (
      (audited.meta.changes ?? 0) !== 1 ||
      (updated.meta.changes ?? 0) !== 1
    ) {
      await this.throwAuditBoundaryFailure(
        viewer,
        id,
        revision,
        current.status,
      );
    }
  }

  async getPublic(eventSlug: string, slug: string) {
    const row = await this.env.DB.prepare(
      `SELECT embed.id, embed.slug, embed.status,
              embed.configuration_json AS configurationJson,
              embed.revision,
              event.name AS eventName, event.brand_accent AS eventAccent
         FROM programme_embeds embed
         JOIN events event ON event.id = embed.event_id
        WHERE event.slug = ? AND event.activation_status = 'active'
          AND embed.slug = ?`,
    )
      .bind(eventSlug, slug)
      .first<PublicEmbedRow>();
    if (!row) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.configurationJson);
    } catch {
      throw new ProgrammeEmbedStateError(
        `Managed embed ${row.id} has corrupt persisted configuration.`,
        500,
      );
    }
    return {
      id: row.id,
      slug: row.slug,
      status: row.status,
      configuration: parsePersistedProgrammeEmbedConfiguration(parsed),
      revision: row.revision,
      eventName: row.eventName,
      eventAccent: row.eventAccent,
    };
  }

  private async current(viewer: Viewer, id: string) {
    const row = await this.env.DB.prepare(
      `SELECT embed.id, embed.name, embed.slug, embed.status,
              embed.configuration_json AS configurationJson,
              embed.installation_note AS installationNote,
              embed.revision, creator.display_name AS createdByName,
              updater.display_name AS updatedByName,
              embed.created_at AS createdAt, embed.updated_at AS updatedAt,
              embed.revoked_at AS revokedAt
         FROM programme_embeds embed
         JOIN events event
           ON event.id = embed.event_id AND event.organisation_id = ?
         JOIN people creator ON creator.id = embed.created_by_person_id
         JOIN people updater ON updater.id = embed.updated_by_person_id
        WHERE embed.id = ? AND embed.event_id = ?`,
    )
      .bind(viewer.organisationId, id, viewer.eventId)
      .first<EmbedRow>();
    if (!row)
      throw new ProgrammeEmbedStateError("Managed embed not found.", 404);
    return parseRow(row);
  }

  private async throwAuditBoundaryFailure(
    viewer: Viewer,
    id: string,
    expectedRevision: number,
    expectedStatus: ProgrammeEmbedStatus,
  ): Promise<never> {
    const latest = await this.current(viewer, id);
    if (
      latest.revision !== expectedRevision ||
      latest.status !== expectedStatus
    ) {
      throw new ProgrammeEmbedRevisionConflictError();
    }
    throw new ProgrammeEmbedStateError(
      "The managed embed change could not be saved with its required audit history.",
      500,
    );
  }

  private async requirePublishedConfiguration(
    viewer: Viewer,
    configuration: ProgrammeEmbedConfiguration,
  ) {
    const event = await this.env.DB.prepare(
      `SELECT slug
         FROM events
        WHERE id = ? AND organisation_id = ? AND activation_status = 'active'`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{ slug: string }>();
    if (!event) {
      throw new ProgrammeEmbedStateError("Managed embed event not found.", 404);
    }
    const programme = await new PublicProgrammeService(this.env).getPublished(
      event.slug,
    );
    if (!programme) {
      throw new ProgrammeEmbedStateError(
        "Publish the programme before saving or activating this embed.",
        409,
      );
    }
    if (
      configuration.day &&
      !programme.sessions.some(
        (session) =>
          eventLocalCalendarDate(session.startsAt, programme.event.timezone) ===
          configuration.day,
      )
    ) {
      throw new ProgrammeEmbedStateError(
        "Embed day must identify a published programme day.",
      );
    }
    if (
      configuration.track &&
      !programme.sessions.some(
        (session) => session.track === configuration.track,
      )
    ) {
      throw new ProgrammeEmbedStateError(
        "Embed track must identify a published track.",
      );
    }
    if (
      configuration.format &&
      !programme.sessions.some(
        (session) => session.format === configuration.format,
      )
    ) {
      throw new ProgrammeEmbedStateError(
        "Embed format must identify a published format.",
      );
    }
    if (
      configuration.room &&
      !programme.sessions.some((session) => session.room === configuration.room)
    ) {
      throw new ProgrammeEmbedStateError(
        "Embed room must identify a published room.",
      );
    }
  }
}
