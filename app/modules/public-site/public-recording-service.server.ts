import { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";
import { recordingDraftInputSchema, revisionInputSchema } from "./public-site";
import {
  parsePublicSiteCommandReplay,
  preparePublicSiteCommand,
  publicSiteCommandClaimStatements,
  publicSiteCommandCompletionStatement,
  publicSiteCommandGuard,
  resolvePublicSiteCommandRace,
} from "./public-site-command.server";
import {
  PublicSiteRevisionConflictError,
  PublicSiteValidationError,
} from "./public-site-errors";
import {
  publicSiteChangeSequence,
  publicSiteMutationEvidence,
} from "./public-site-mutation-evidence.server";

export type PublicRecordingWorkspaceItem = {
  id: string;
  sessionId: string;
  sessionTitle: string;
  draftTitle: string;
  draftRecordingUrl: string;
  draftCaptionsUrl: string | null;
  draftTranscriptUrl: string | null;
  draftRevision: number;
  publishedTitle: string | null;
  publishedRecordingUrl: string | null;
  publishedCaptionsUrl: string | null;
  publishedTranscriptUrl: string | null;
  publishedRevision: number | null;
  publishedAt: number | null;
  lastOperationId: string;
};

export type PublishedPublicRecording = {
  id: string;
  sessionId: string;
  title: string;
  recordingUrl: string;
  captionsUrl: string | null;
  transcriptUrl: string | null;
  sessionTitle: string;
  speakerNames: string[];
};

type PublishedRecordingRow = Omit<PublishedPublicRecording, "speakerNames"> & {
  speakerNames: string;
};

const speakerNamesSchema = z.array(z.string().trim().min(1).max(200));
const entityCommandResponseSchema = z.object({ id: z.string().min(1) });
const emptyCommandResponseSchema = z.object({});

export class PublicRecordingService {
  constructor(private readonly env: CloudflareEnvironment) {}

  async list(
    viewer: Pick<Viewer, "eventId" | "organisationId">,
  ): Promise<PublicRecordingWorkspaceItem[]> {
    const rows = await this.env.DB.prepare(
      `SELECT recording.id, recording.session_id AS sessionId,
              session.title AS sessionTitle,
              recording.draft_title AS draftTitle,
              recording.draft_recording_url AS draftRecordingUrl,
              recording.draft_captions_url AS draftCaptionsUrl,
              recording.draft_transcript_url AS draftTranscriptUrl,
              recording.draft_revision AS draftRevision,
              recording.published_title AS publishedTitle,
              recording.published_recording_url AS publishedRecordingUrl,
              recording.published_captions_url AS publishedCaptionsUrl,
              recording.published_transcript_url AS publishedTranscriptUrl,
              recording.published_revision AS publishedRevision,
              recording.published_at AS publishedAt,
              recording.last_operation_id AS lastOperationId
         FROM event_session_recordings recording
         JOIN sessions session
           ON session.id = recording.session_id
          AND session.event_id = recording.event_id
        WHERE recording.event_id = ? AND recording.organisation_id = ?
        ORDER BY session.title COLLATE NOCASE, recording.id`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .all<PublicRecordingWorkspaceItem>();
    return rows.results;
  }

  async saveDraft(viewer: Viewer, input: unknown) {
    const parsed = recordingDraftInputSchema.parse(input);
    const prepared = await preparePublicSiteCommand(
      this.env,
      viewer,
      "public_site.recording.save",
      parsed.commandId,
      {
        id: parsed.id,
        sessionId: parsed.sessionId,
        revision: parsed.revision,
        title: parsed.title,
        recordingUrl: parsed.recordingUrl,
        captionsUrl: parsed.captionsUrl,
        transcriptUrl: parsed.transcriptUrl,
      },
    );
    if (prepared.replay)
      return parsePublicSiteCommandReplay(
        prepared.replay,
        entityCommandResponseSchema,
      );
    const command = prepared.command;
    const session = await this.env.DB.prepare(
      `SELECT session.id
         FROM sessions session
         JOIN events event ON event.id = session.event_id
        WHERE session.id = ? AND session.event_id = ?
          AND event.organisation_id = ?`,
    )
      .bind(parsed.sessionId, viewer.eventId, viewer.organisationId)
      .first<{ id: string }>();
    if (!session)
      throw new PublicSiteValidationError(
        "The selected recording session does not belong to this event.",
      );
    const id = parsed.id ?? crypto.randomUUID();
    const operationId = command.id;
    const commandGuard = publicSiteCommandGuard(viewer, command);
    const mutation = parsed.id
      ? this.env.DB.prepare(
          `UPDATE event_session_recordings
              SET draft_title = ?, draft_recording_url = ?,
                  draft_captions_url = ?, draft_transcript_url = ?,
                  draft_revision = draft_revision + 1,
                  last_updated_by_person_id = ?, last_operation_id = ?,
                  updated_at = unixepoch()
            WHERE id = ? AND event_id = ? AND organisation_id = ?
              AND session_id = ? AND draft_revision = ?
              AND EXISTS (${commandGuard.sql})`,
        ).bind(
          parsed.title,
          parsed.recordingUrl,
          parsed.captionsUrl,
          parsed.transcriptUrl,
          viewer.personId,
          operationId,
          id,
          viewer.eventId,
          viewer.organisationId,
          parsed.sessionId,
          parsed.revision,
          ...commandGuard.bindings,
        )
      : this.env.DB.prepare(
          `INSERT INTO event_session_recordings (
             id, organisation_id, event_id, session_id, draft_title,
             draft_recording_url, draft_captions_url, draft_transcript_url,
             draft_revision, last_updated_by_person_id, last_operation_id,
             created_at, updated_at
           ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, unixepoch(), unixepoch()
              WHERE EXISTS (${commandGuard.sql})`,
        ).bind(
          id,
          viewer.organisationId,
          viewer.eventId,
          parsed.sessionId,
          parsed.title,
          parsed.recordingUrl,
          parsed.captionsUrl,
          parsed.transcriptUrl,
          viewer.personId,
          operationId,
          ...commandGuard.bindings,
        );
    const evidence = publicSiteMutationEvidence(
      this.env,
      viewer,
      operationId,
      "recording.draft_saved",
      "session_recording",
      id,
      parsed.id ? "updated" : "created",
      { sessionId: parsed.sessionId },
      {
        sql: `SELECT 1 FROM event_session_recordings
               WHERE id = ? AND event_id = ? AND organisation_id = ?
                 AND last_operation_id = ?`,
        bindings: [id, viewer.eventId, viewer.organisationId, operationId],
      },
    );
    const results = await this.env.DB.batch([
      ...publicSiteCommandClaimStatements(this.env, viewer, command),
      mutation,
      ...evidence,
      publicSiteCommandCompletionStatement(this.env, viewer, command, { id }),
    ]);
    if ((results[2]?.meta.changes ?? 0) !== 1) {
      const replay = await resolvePublicSiteCommandRace(
        this.env,
        viewer,
        command,
      );
      if (replay)
        return parsePublicSiteCommandReplay(
          replay,
          entityCommandResponseSchema,
        );
      throw new PublicSiteRevisionConflictError();
    }
    if ((results[5]?.meta.changes ?? 0) !== 1)
      throw new Error(
        "The recording draft committed without durable command completion.",
      );
    return { id, changeSequence: publicSiteChangeSequence(results[4]) };
  }

  async publish(viewer: Viewer, input: unknown) {
    const parsed = revisionInputSchema.parse(input);
    const prepared = await preparePublicSiteCommand(
      this.env,
      viewer,
      "public_site.recording.publish",
      parsed.commandId,
      { id: parsed.id, revision: parsed.revision, confirmed: parsed.confirmed },
    );
    if (prepared.replay)
      return parsePublicSiteCommandReplay(
        prepared.replay,
        emptyCommandResponseSchema,
      );
    const command = prepared.command;
    const operationId = command.id;
    const commandGuard = publicSiteCommandGuard(viewer, command);
    const evidence = publicSiteMutationEvidence(
      this.env,
      viewer,
      operationId,
      "recording.published",
      "session_recording",
      parsed.id,
      "published",
      { revision: parsed.revision },
      {
        sql: `SELECT 1 FROM event_session_recordings
               WHERE id = ? AND event_id = ? AND organisation_id = ?
                 AND published_revision = ? AND last_operation_id = ?`,
        bindings: [
          parsed.id,
          viewer.eventId,
          viewer.organisationId,
          parsed.revision,
          operationId,
        ],
      },
    );
    const results = await this.env.DB.batch([
      ...publicSiteCommandClaimStatements(this.env, viewer, command),
      this.env.DB.prepare(
        `UPDATE event_session_recordings
            SET published_title = draft_title,
                published_recording_url = draft_recording_url,
                published_captions_url = draft_captions_url,
                published_transcript_url = draft_transcript_url,
                published_revision = draft_revision, published_at = unixepoch(),
                last_updated_by_person_id = ?, last_operation_id = ?,
                updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND organisation_id = ?
            AND draft_revision = ?
            AND (published_revision IS NULL OR published_revision <> draft_revision)
            AND EXISTS (
              SELECT 1 FROM schedule_entries entry
              JOIN schedule_versions version
                ON version.id = entry.schedule_version_id
               AND version.event_id = entry.event_id
               AND version.status = 'published'
              JOIN sessions session
                ON session.id = entry.session_id
               AND session.event_id = entry.event_id
              JOIN schedule_session_contents content
                ON content.event_id = entry.event_id
               AND content.schedule_version_id = entry.schedule_version_id
               AND content.session_id = entry.session_id
              WHERE entry.event_id = event_session_recordings.event_id
                AND entry.session_id = event_session_recordings.session_id
                AND session.status = 'published'
                AND session.visibility = 'public'
                AND content.visibility = 'public'
                AND content.content_status = 'approved'
            )
            AND EXISTS (${commandGuard.sql})`,
      ).bind(
        viewer.personId,
        operationId,
        parsed.id,
        viewer.eventId,
        viewer.organisationId,
        parsed.revision,
        ...commandGuard.bindings,
      ),
      this.env.DB.prepare(
        `UPDATE events
            SET revision = revision + 1,
                public_projection_revision = public_projection_revision + 1,
                last_operation_id = ?, last_updated_by_person_id = ?,
                updated_at = unixepoch()
          WHERE id = ? AND organisation_id = ?
            AND EXISTS (
              SELECT 1 FROM event_session_recordings
               WHERE id = ? AND event_id = ? AND last_operation_id = ?
                 AND published_revision = ?
            )`,
      ).bind(
        operationId,
        viewer.personId,
        viewer.eventId,
        viewer.organisationId,
        parsed.id,
        viewer.eventId,
        operationId,
        parsed.revision,
      ),
      ...evidence,
      publicSiteCommandCompletionStatement(this.env, viewer, command, {}),
    ]);
    if ((results[2]?.meta.changes ?? 0) !== 1) {
      const replay = await resolvePublicSiteCommandRace(
        this.env,
        viewer,
        command,
      );
      if (replay)
        return parsePublicSiteCommandReplay(replay, emptyCommandResponseSchema);
      throw new PublicSiteValidationError(
        "The recording changed or its session is not in the published programme.",
      );
    }
    if ((results[6]?.meta.changes ?? 0) !== 1)
      throw new Error(
        "The recording publication committed without durable command completion.",
      );
    return { changeSequence: publicSiteChangeSequence(results[5]) };
  }

  async unpublish(viewer: Viewer, input: unknown) {
    const parsed = revisionInputSchema.parse(input);
    const prepared = await preparePublicSiteCommand(
      this.env,
      viewer,
      "public_site.recording.unpublish",
      parsed.commandId,
      { id: parsed.id, revision: parsed.revision, confirmed: parsed.confirmed },
    );
    if (prepared.replay)
      return parsePublicSiteCommandReplay(
        prepared.replay,
        emptyCommandResponseSchema,
      );
    const command = prepared.command;
    const operationId = command.id;
    const commandGuard = publicSiteCommandGuard(viewer, command);
    const evidence = publicSiteMutationEvidence(
      this.env,
      viewer,
      operationId,
      "recording.unpublished",
      "session_recording",
      parsed.id,
      "updated",
      { revision: parsed.revision },
      {
        sql: `SELECT 1 FROM event_session_recordings
               WHERE id = ? AND event_id = ? AND organisation_id = ?
                 AND published_at IS NULL AND last_operation_id = ?`,
        bindings: [
          parsed.id,
          viewer.eventId,
          viewer.organisationId,
          operationId,
        ],
      },
    );
    const results = await this.env.DB.batch([
      ...publicSiteCommandClaimStatements(this.env, viewer, command),
      this.env.DB.prepare(
        `UPDATE event_session_recordings
            SET published_title = NULL, published_recording_url = NULL,
                published_captions_url = NULL, published_transcript_url = NULL,
                published_revision = NULL, published_at = NULL,
                last_updated_by_person_id = ?, last_operation_id = ?,
                updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND organisation_id = ?
            AND draft_revision = ? AND published_at IS NOT NULL
            AND EXISTS (${commandGuard.sql})`,
      ).bind(
        viewer.personId,
        operationId,
        parsed.id,
        viewer.eventId,
        viewer.organisationId,
        parsed.revision,
        ...commandGuard.bindings,
      ),
      this.env.DB.prepare(
        `UPDATE events
            SET revision = revision + 1,
                public_projection_revision = public_projection_revision + 1,
                last_operation_id = ?, last_updated_by_person_id = ?,
                updated_at = unixepoch()
          WHERE id = ? AND organisation_id = ?
            AND EXISTS (
              SELECT 1 FROM event_session_recordings
               WHERE id = ? AND event_id = ? AND organisation_id = ?
                 AND published_at IS NULL AND last_operation_id = ?
            )`,
      ).bind(
        operationId,
        viewer.personId,
        viewer.eventId,
        viewer.organisationId,
        parsed.id,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      ...evidence,
      publicSiteCommandCompletionStatement(this.env, viewer, command, {}),
    ]);
    if ((results[2]?.meta.changes ?? 0) !== 1) {
      const replay = await resolvePublicSiteCommandRace(
        this.env,
        viewer,
        command,
      );
      if (replay)
        return parsePublicSiteCommandReplay(replay, emptyCommandResponseSchema);
      throw new PublicSiteRevisionConflictError();
    }
    if ((results[6]?.meta.changes ?? 0) !== 1)
      throw new Error(
        "The recording withdrawal committed without durable command completion.",
      );
    return { changeSequence: publicSiteChangeSequence(results[5]) };
  }

  async getPublishedForEvent(
    eventId: string,
    organisationId: string,
    now: number,
  ): Promise<PublishedPublicRecording[]> {
    const recordings = await this.env.DB.prepare(
      `SELECT recording.id, recording.session_id AS sessionId,
              recording.published_title AS title,
              recording.published_recording_url AS recordingUrl,
              recording.published_captions_url AS captionsUrl,
              recording.published_transcript_url AS transcriptUrl,
              content.title AS sessionTitle,
              (
                SELECT json_group_array(person.display_name)
                  FROM session_speakers relation
                  JOIN people person ON person.id = relation.person_id
                 WHERE relation.event_id = recording.event_id
                   AND relation.session_id = recording.session_id
                   AND relation.visibility = 'public'
                   AND relation.participation_status = 'confirmed'
                   AND person.profile_status = 'published'
              ) AS speakerNames
         FROM event_session_recordings recording
         JOIN schedule_versions version
           ON version.event_id = recording.event_id AND version.status = 'published'
         JOIN schedule_entries entry
           ON entry.event_id = recording.event_id
          AND entry.schedule_version_id = version.id
          AND entry.session_id = recording.session_id
         JOIN sessions session
           ON session.id = entry.session_id
          AND session.event_id = entry.event_id
         JOIN schedule_session_contents content
           ON content.event_id = entry.event_id
          AND content.schedule_version_id = entry.schedule_version_id
          AND content.session_id = entry.session_id
        WHERE recording.event_id = ? AND recording.organisation_id = ?
          AND recording.published_at IS NOT NULL
          AND entry.ends_at <= ?
          AND session.status = 'published'
          AND session.visibility = 'public'
          AND content.visibility = 'public'
          AND content.content_status = 'approved'
        ORDER BY entry.starts_at, content.title, recording.id`,
    )
      .bind(eventId, organisationId, now)
      .all<PublishedRecordingRow>();

    return recordings.results.map((recording) => ({
      ...recording,
      speakerNames: speakerNamesSchema.parse(
        JSON.parse(recording.speakerNames),
      ),
    }));
  }
}
