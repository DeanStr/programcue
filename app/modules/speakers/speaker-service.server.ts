import { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";
import {
  AirtableProviderBoundary,
  airtableCommandKey,
  airtableIntentCommand,
} from "~/modules/airtable/airtable-provider-boundary.server";
import { ApiPersonIdempotencyService } from "~/platform/api/api-person-idempotency.server";
import { ApiError } from "~/platform/api/api.server";
import { parseEventFilePolicy } from "~/modules/files/file-policy";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import { speakerProfileSchema } from "./speaker-schema";

export class SpeakerProfileConflictError extends Error {
  constructor() {
    super(
      "Your profile changed after this page loaded. Refresh before saving again.",
    );
    this.name = "SpeakerProfileConflictError";
  }
}

export class SpeakerAdminStateError extends Error {
  readonly status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.name = "SpeakerAdminStateError";
    this.status = status;
  }
}

const manualSpeakerSchema = z.object({
  idempotencyKey: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._:-]{8,128}$/, "Refresh before adding this speaker."),
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  biography: z.string().trim().max(5_000).default(""),
  organisationName: z.string().trim().max(160).default(""),
  jobTitle: z.string().trim().max(160).default(""),
});

type ProfileRow = {
  id: string;
  email: string;
  name: string;
  biography: string | null;
  pronunciation: string | null;
  organisationName: string | null;
  jobTitle: string | null;
  profileStatus: "draft" | "published" | "archived";
  revision: number;
};

type SessionRow = {
  id: string;
  title: string;
  description: string | null;
  format: string;
  durationMinutes: number;
  status: string;
  roleLabel: string | null;
  startsAt: number | null;
  endsAt: number | null;
  roomName: string | null;
};

type FileRow = {
  id: string;
  kind: string;
  status: string;
  currentVersionId: string | null;
  filename: string | null;
  sizeBytes: number | null;
  uploadStatus: string | null;
  signatureStatus: string | null;
  scanStatus: string | null;
  versionNumber: number | null;
  releasedAt: number | null;
  downloadFilename: string | null;
  downloadReleasedAt: number | null;
};

export type AdminSpeakerFilters = {
  personId?: string;
  query?: string;
  profileStatus?: "" | "draft" | "published" | "archived";
  readiness?: "" | "ready" | "needs_attention";
};

export type AdminSpeakerListItem = {
  id: string;
  name: string;
  email: string;
  jobTitle: string | null;
  organisationName: string | null;
  profileStatus: string;
  sessionCount: number;
  outstandingTasks: number;
  completedTasks: number;
  quarantinedFiles: number;
};

export class SpeakerService {
  private readonly airtable;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
  }

  private async assertSpeaker(viewer: Viewer) {
    const membership = await this.env.DB.prepare(
      `
      SELECT 1 AS allowed
        FROM memberships
       WHERE event_id = ? AND person_id = ? AND role = 'speaker'
         AND accepted_at IS NOT NULL AND revoked_at IS NULL
       LIMIT 1
    `,
    )
      .bind(viewer.eventId, viewer.personId)
      .first();
    if (!membership)
      throw new Response("A current speaker membership is required.", {
        status: 403,
      });
  }

  async getPortal(viewer: Viewer) {
    await this.airtable.assertReadable(viewer);
    await this.assertSpeaker(viewer);
    const [profile, event, sessions, files] = await Promise.all([
      this.env.DB.prepare(
        `
        SELECT id, email, display_name AS name, biography, pronunciation,
               organisation_name AS organisationName, job_title AS jobTitle,
               profile_status AS profileStatus, profile_revision AS revision
          FROM people WHERE id = ?
      `,
      )
        .bind(viewer.personId)
        .first<ProfileRow>(),
      this.env.DB.prepare(
        `
        SELECT name, timezone, starts_at AS startsAt, ends_at AS endsAt,
               venue_name AS venue, city, brand_accent AS brandAccent,
               file_policy_json AS filePolicyJson
          FROM events WHERE id = ? AND organisation_id = ?
      `,
      )
        .bind(viewer.eventId, viewer.organisationId)
        .first<{
          name: string;
          timezone: string;
          startsAt: number;
          endsAt: number;
          venue: string | null;
          city: string | null;
          brandAccent: string;
          filePolicyJson: string;
        }>(),
      this.env.DB.prepare(
        `
        SELECT s.id, s.title, s.description, s.format, s.duration_minutes AS durationMinutes,
               s.status, ss.role_label AS roleLabel, se.starts_at AS startsAt,
               se.ends_at AS endsAt, r.name AS roomName
          FROM session_speakers ss
          JOIN sessions s ON s.id = ss.session_id AND s.event_id = ss.event_id
          LEFT JOIN schedule_versions sv ON sv.event_id = s.event_id AND sv.status = 'published'
          LEFT JOIN schedule_entries se ON se.schedule_version_id = sv.id AND se.session_id = s.id
          LEFT JOIN rooms r ON r.id = se.room_id AND r.event_id = s.event_id
         WHERE ss.event_id = ? AND ss.person_id = ? AND s.status <> 'archived'
         ORDER BY se.starts_at IS NULL, se.starts_at, s.title
      `,
      )
        .bind(viewer.eventId, viewer.personId)
        .all<SessionRow>(),
      this.env.DB.prepare(
        `
        SELECT fa.id, fa.asset_kind AS kind, fa.status,
               fv.original_filename AS filename, fv.size_bytes AS sizeBytes,
               fv.upload_status AS uploadStatus, fv.signature_status AS signatureStatus,
               fv.scan_status AS scanStatus, fv.version_number AS versionNumber,
               fv.released_at AS releasedAt, fa.current_version_id AS currentVersionId,
               current.original_filename AS downloadFilename,
               current.released_at AS downloadReleasedAt
          FROM file_assets fa
          LEFT JOIN file_versions fv ON fv.id = (
            SELECT id FROM file_versions candidate
             WHERE candidate.asset_id = fa.id AND candidate.deleted_at IS NULL
	             ORDER BY candidate.version_number DESC LIMIT 1
	          )
          LEFT JOIN file_versions current
            ON current.id = fa.current_version_id
           AND current.event_id = fa.event_id
           AND current.deleted_at IS NULL
         WHERE fa.event_id = ? AND fa.owner_person_id = ? AND fa.status <> 'deleted'
         ORDER BY fa.updated_at DESC
      `,
      )
        .bind(viewer.eventId, viewer.personId)
        .all<FileRow>(),
    ]);
    if (!profile || !event)
      throw new Response("Speaker workspace not found.", { status: 404 });
    const assetIds = files.results.map((file) => file.id);
    const versionRows = assetIds.length
      ? await this.env.DB.prepare(
          `
          SELECT id, asset_id AS assetId, version_number AS versionNumber,
                 original_filename AS filename, size_bytes AS sizeBytes,
                 upload_status AS uploadStatus, signature_status AS signatureStatus,
                 scan_status AS scanStatus, created_at AS createdAt, released_at AS releasedAt
            FROM file_versions
           WHERE asset_id IN (${assetIds.map(() => "?").join(",")}) AND deleted_at IS NULL
           ORDER BY asset_id, version_number DESC
        `,
        )
          .bind(...assetIds)
          .all<{
            id: string;
            assetId: string;
            versionNumber: number;
            filename: string;
            sizeBytes: number;
            uploadStatus: string;
            signatureStatus: string;
            scanStatus: string;
            createdAt: number;
            releasedAt: number | null;
          }>()
      : { results: [] };
    const { filePolicyJson, ...eventSummary } = event;
    return {
      profile,
      event: {
        ...eventSummary,
        filePolicy: parseEventFilePolicy(filePolicyJson),
      },
      sessions: sessions.results,
      files: files.results.map((file) => ({
        ...file,
        versions: versionRows.results.filter(
          (version) => version.assetId === file.id,
        ),
      })),
    };
  }

  async updateProfile(viewer: Viewer, rawInput: unknown) {
    const idempotencyKey = await airtableCommandKey(
      "speaker.profile.update",
      viewer,
      rawInput,
    );
    return this.airtable.executeIdempotent(
      viewer,
      { idempotencyKey, operation: "speaker.profile.update" },
      () => this.updateProfileD1(viewer, rawInput),
    );
  }

  async createManualSpeaker(viewer: Viewer, rawInput: unknown) {
    const parsed = manualSpeakerSchema.parse(rawInput);
    const { idempotencyKey, ...input } = parsed;
    const command = await airtableIntentCommand(
      "speaker.admin.create",
      viewer,
      idempotencyKey,
      input,
    );
    return this.airtable.executeIdempotent(viewer, command, async () => {
      try {
        const { result } = await new ApiPersonIdempotencyService(this.env).run({
          viewer,
          scope: "speaker.admin.create",
          idempotencyKey,
          input,
          execute: (commandId) =>
            this.createManualSpeakerD1(viewer, input, commandId),
          recover: (commandId) => this.recoverManualSpeaker(viewer, commandId),
        });
        return result;
      } catch (error) {
        if (error instanceof ApiError) {
          throw new SpeakerAdminStateError(error.message, error.status);
        }
        throw error;
      }
    });
  }

  private async createManualSpeakerD1(
    viewer: Viewer,
    input: Omit<z.infer<typeof manualSpeakerSchema>, "idempotencyKey">,
    commandId: string,
  ) {
    const event = await this.env.DB.prepare(
      "SELECT 1 FROM events WHERE id = ? AND organisation_id = ?",
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first();
    if (!event) throw new Response("Event not found.", { status: 404 });

    const personId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, email_verified, biography,
           organisation_name, job_title, profile_status, created_at, updated_at
         ) VALUES (?, ?, ?, 0, ?, ?, ?, 'draft', unixepoch(), unixepoch())
         ON CONFLICT(email) DO NOTHING`,
      ).bind(
        personId,
        input.email,
        input.name,
        input.biography || null,
        input.organisationName || null,
        input.jobTitle || null,
      ),
      this.env.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role,
           invited_at, invitation_expires_at, accepted_at, revoked_at,
           last_operation_id, created_at
         )
         SELECT ?, ?, ?, person.id, 'speaker', unixepoch(), NULL, unixepoch(),
                NULL, ?, unixepoch()
           FROM people person
          WHERE person.email = ? COLLATE NOCASE
            AND EXISTS (
              SELECT 1 FROM events
               WHERE id = ? AND organisation_id = ?
            )
         ON CONFLICT(event_id, person_id, role) WHERE event_id IS NOT NULL
         DO UPDATE SET invited_at = unixepoch(), invitation_expires_at = NULL,
                       accepted_at = unixepoch(), revoked_at = NULL,
                       last_operation_id = excluded.last_operation_id
          WHERE memberships.organisation_id = excluded.organisation_id
            AND (memberships.revoked_at IS NOT NULL
                 OR memberships.accepted_at IS NULL)`,
      ).bind(
        membershipId,
        viewer.organisationId,
        viewer.eventId,
        commandId,
        input.email,
        viewer.eventId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, ?, 'speaker.admin.created', 'person', person.id, ?, ?, unixepoch()
           FROM people person
          WHERE person.email = ? COLLATE NOCASE
            AND EXISTS (
              SELECT 1 FROM memberships membership
               WHERE membership.organisation_id = ?
                 AND membership.event_id = ?
                 AND membership.person_id = person.id
                 AND membership.role = 'speaker'
                 AND membership.accepted_at IS NOT NULL
                 AND membership.revoked_at IS NULL
            )`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        commandId,
        JSON.stringify({ enteredEmail: input.email }),
        input.email,
        viewer.organisationId,
        viewer.eventId,
      ),
    ]);
    const created = await this.recoverManualSpeaker(viewer, commandId);
    if (!created) {
      throw new Error(
        "The speaker identity was not linked to the authorised event.",
      );
    }
    return created;
  }

  private async recoverManualSpeaker(viewer: Viewer, commandId: string) {
    return this.env.DB.prepare(
      `SELECT audit.entity_id AS personId
         FROM audit_events audit
         JOIN memberships membership
           ON membership.person_id = audit.entity_id
          AND membership.organisation_id = audit.organisation_id
          AND membership.event_id = audit.event_id
          AND membership.role = 'speaker'
          AND membership.accepted_at IS NOT NULL
          AND membership.revoked_at IS NULL
        WHERE audit.organisation_id = ? AND audit.event_id = ?
          AND audit.actor_person_id = ?
          AND audit.action = 'speaker.admin.created'
          AND audit.entity_type = 'person'
          AND audit.correlation_id = ?
        LIMIT 1`,
    )
      .bind(viewer.organisationId, viewer.eventId, viewer.personId, commandId)
      .first<{ personId: string }>();
  }

  private async updateProfileD1(viewer: Viewer, rawInput: unknown) {
    await this.assertSpeaker(viewer);
    const input = speakerProfileSchema.parse(rawInput);
    const operationId = crypto.randomUUID();
    const auditEventId = crypto.randomUUID();
    const webhookService = new WebhookService(this.env);
    const webhook = await webhookService.prepareEventForAudit(
      viewer,
      {
        eventType: "speaker.updated",
        entityType: "speaker",
        entityId: viewer.personId,
        idempotencyKey: `speaker.updated:${viewer.personId}:${operationId}`,
        correlationId: operationId,
        data: {
          revision: input.revision + 1,
          status: input.publish ? "published" : "draft",
        },
      },
      auditEventId,
    );
    const [updated] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE people
           SET display_name = ?, biography = ?, pronunciation = ?, organisation_name = ?, job_title = ?,
               profile_status = ?, profile_revision = profile_revision + 1,
               last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND profile_revision = ?
           AND EXISTS (
             SELECT 1 FROM memberships
              WHERE event_id = ? AND person_id = people.id AND role = 'speaker'
                AND accepted_at IS NOT NULL AND revoked_at IS NULL
           )
      `,
      ).bind(
        input.name,
        input.biography,
        input.pronunciation || null,
        input.organisationName || null,
        input.jobTitle || null,
        input.publish ? "published" : "draft",
        operationId,
        viewer.personId,
        input.revision,
        viewer.eventId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, correlation_id, metadata_json, created_at
        ) SELECT ?, ?, ?, ?, 'speaker.profile.updated', 'person', ?, ?, ?, unixepoch()
           WHERE EXISTS (
             SELECT 1 FROM people
              WHERE id = ? AND profile_revision = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        auditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        viewer.personId,
        operationId,
        JSON.stringify({
          published: input.publish,
          revision: input.revision + 1,
        }),
        viewer.personId,
        input.revision + 1,
        operationId,
      ),
      ...webhook.statements,
    ]);
    if ((updated.meta.changes ?? 0) !== 1)
      throw new SpeakerProfileConflictError();

    const deliveries = await webhookService.dispatchPreparedEvent(webhook);
    return {
      webhookWarning: deliveries.some(
        (delivery) => delivery.status === "queue_failed",
      )
        ? "The profile was saved, but one or more outbound webhooks need a queue retry."
        : null,
    };
  }

  async listAdminSpeakerPage(
    viewer: Viewer,
    filters: AdminSpeakerFilters,
    page: number,
  ) {
    await this.airtable.assertReadable(viewer);
    if (!Number.isInteger(page) || page < 1) {
      throw new Response("Invalid speakers page", { status: 400 });
    }
    const queryValue = filters.query?.trim() ?? "";
    const personId = filters.personId?.trim() ?? "";
    if (personId.length > 200)
      throw new Response("Invalid speaker focus", { status: 400 });
    if (queryValue.length > 120) {
      throw new Response("Speaker search is limited to 120 characters.", {
        status: 400,
      });
    }
    const profileStatus = filters.profileStatus ?? "";
    if (
      profileStatus !== "" &&
      profileStatus !== "draft" &&
      profileStatus !== "published" &&
      profileStatus !== "archived"
    ) {
      throw new Response("Invalid speaker profile filter", { status: 400 });
    }
    const readiness = filters.readiness ?? "";
    if (
      readiness !== "" &&
      readiness !== "ready" &&
      readiness !== "needs_attention"
    ) {
      throw new Response("Invalid speaker readiness filter", { status: 400 });
    }
    const event = await this.env.DB.prepare(
      "SELECT 1 FROM events WHERE id = ? AND organisation_id = ?",
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first();
    if (!event) throw new Response("Event not found.", { status: 404 });
    const pageSize = 50;
    const query = `%${queryValue}%`;
    const speakers = await this.env.DB.prepare(
      `
      WITH event_speaker_ids(person_id) AS (
        SELECT person_id
          FROM session_speakers
         WHERE event_id = ?
        UNION
        SELECT person_id
          FROM memberships
         WHERE event_id = ? AND role = 'speaker'
           AND accepted_at IS NOT NULL AND revoked_at IS NULL
      ), page_people AS (
        SELECT p.id, p.display_name AS name, p.email, p.job_title AS jobTitle,
               p.organisation_name AS organisationName,
               p.profile_status AS profileStatus
          FROM event_speaker_ids speaker
          JOIN people p ON p.id = speaker.person_id
         WHERE (? = '' OR p.profile_status = ?)
           AND (? = '%%' OR p.display_name LIKE ? OR p.email LIKE ?)
           AND (? = '' OR p.id = ?)
           AND (
             ? = ''
             OR (
               ? = 'ready'
               AND NOT (
                 EXISTS (
                   SELECT 1 FROM task_instances task
                    WHERE task.event_id = ?
                      AND task.target_type = 'speaker'
                      AND task.target_id = p.id
                      AND task.status NOT IN ('completed','waived')
                 )
                 OR EXISTS (
                   SELECT 1 FROM task_instances task
                    WHERE task.event_id = ?
                      AND task.owner_person_id = p.id
                      AND task.status NOT IN ('completed','waived')
                 )
               )
             )
             OR (
               ? = 'needs_attention'
               AND (
                 EXISTS (
                   SELECT 1 FROM task_instances task
                    WHERE task.event_id = ?
                      AND task.target_type = 'speaker'
                      AND task.target_id = p.id
                      AND task.status NOT IN ('completed','waived')
                 )
                 OR EXISTS (
                   SELECT 1 FROM task_instances task
                    WHERE task.event_id = ?
                      AND task.owner_person_id = p.id
                      AND task.status NOT IN ('completed','waived')
                 )
               )
             )
           )
         ORDER BY p.display_name, p.id
         LIMIT ? OFFSET ?
      )
      SELECT person.*,
             (SELECT COUNT(*) FROM session_speakers speaker
               WHERE speaker.event_id = ? AND speaker.person_id = person.id) AS sessionCount,
             (SELECT COUNT(*) FROM task_instances task
               WHERE task.event_id = ?
                 AND task.status NOT IN ('completed','waived')
                 AND (
                   (task.target_type = 'speaker' AND task.target_id = person.id)
                   OR task.owner_person_id = person.id
                 )) AS outstandingTasks,
             (SELECT COUNT(*) FROM task_instances task
               WHERE task.event_id = ?
                 AND task.status IN ('completed','waived')
                 AND (
                   (task.target_type = 'speaker' AND task.target_id = person.id)
                   OR task.owner_person_id = person.id
                 )) AS completedTasks,
             (SELECT COUNT(*)
                FROM file_assets asset
                JOIN file_versions version ON version.id = (
                  SELECT latest.id FROM file_versions latest
                   WHERE latest.asset_id = asset.id AND latest.deleted_at IS NULL
                   ORDER BY latest.version_number DESC LIMIT 1
                )
               WHERE asset.event_id = ? AND asset.owner_person_id = person.id
                 AND asset.status <> 'deleted'
                 AND version.upload_status = 'uploaded'
                 AND version.signature_status = 'valid'
                 AND version.scan_status = 'pending') AS quarantinedFiles
        FROM page_people person
       ORDER BY person.name, person.id
    `,
    )
      .bind(
        viewer.eventId,
        viewer.eventId,
        profileStatus,
        profileStatus,
        query,
        query,
        query,
        personId,
        personId,
        readiness,
        readiness,
        viewer.eventId,
        viewer.eventId,
        readiness,
        viewer.eventId,
        viewer.eventId,
        pageSize + 1,
        (page - 1) * pageSize,
        viewer.eventId,
        viewer.eventId,
        viewer.eventId,
        viewer.eventId,
      )
      .all<AdminSpeakerListItem>();
    const summary = await this.env.DB.prepare(
      `
      WITH event_speaker_ids(person_id) AS (
        SELECT person_id FROM session_speakers WHERE event_id = ?
        UNION
        SELECT person_id FROM memberships
         WHERE event_id = ? AND role = 'speaker'
           AND accepted_at IS NOT NULL AND revoked_at IS NULL
      )
      SELECT COUNT(*) AS knownSpeakers,
             SUM(CASE WHEN NOT (
               EXISTS (
                 SELECT 1 FROM task_instances task
                  WHERE task.event_id = ?
                    AND task.target_type = 'speaker'
                    AND task.target_id = speaker.person_id
                    AND task.status NOT IN ('completed','waived')
               )
               OR EXISTS (
                 SELECT 1 FROM task_instances task
                  WHERE task.event_id = ?
                    AND task.owner_person_id = speaker.person_id
                    AND task.status NOT IN ('completed','waived')
               )
             ) THEN 1 ELSE 0 END) AS readySpeakers,
             (SELECT COUNT(DISTINCT task.id)
                FROM task_instances task
               WHERE task.event_id = ?
                 AND task.status NOT IN ('completed','waived')
                 AND (
                   (task.target_type = 'speaker' AND task.target_id IN (SELECT person_id FROM event_speaker_ids))
                   OR task.owner_person_id IN (SELECT person_id FROM event_speaker_ids)
                 )) AS outstandingTasks,
             (SELECT COUNT(*)
                FROM file_assets asset
                JOIN file_versions version ON version.id = (
                  SELECT latest.id FROM file_versions latest
                   WHERE latest.asset_id = asset.id AND latest.deleted_at IS NULL
                   ORDER BY latest.version_number DESC LIMIT 1
                )
               WHERE asset.event_id = ?
                 AND asset.owner_person_id IN (SELECT person_id FROM event_speaker_ids)
                 AND asset.status <> 'deleted'
                 AND version.upload_status = 'uploaded'
                 AND version.signature_status = 'valid'
                 AND version.scan_status = 'pending') AS quarantinedFiles
        FROM event_speaker_ids speaker
    `,
    )
      .bind(
        viewer.eventId,
        viewer.eventId,
        viewer.eventId,
        viewer.eventId,
        viewer.eventId,
        viewer.eventId,
      )
      .first<{
        knownSpeakers: number;
        readySpeakers: number;
        outstandingTasks: number;
        quarantinedFiles: number;
      }>();
    if (!summary) {
      throw new Error("Speaker readiness summary could not be read.");
    }
    return {
      speakers: speakers.results.slice(0, pageSize),
      page,
      hasNext: speakers.results.length > pageSize,
      summary: {
        knownSpeakers: Number(summary.knownSpeakers),
        readySpeakers: Number(summary.readySpeakers),
        outstandingTasks: Number(summary.outstandingTasks),
        quarantinedFiles: Number(summary.quarantinedFiles),
      },
    };
  }

  static parseProfileForm(form: FormData) {
    return z
      .object({
        revision: z.coerce.number(),
        name: z.string(),
        biography: z.string(),
        pronunciation: z.string(),
        organisationName: z.string(),
        jobTitle: z.string(),
        publish: z.string(),
      })
      .parse(Object.fromEntries(form));
  }
}
