import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  ParticipantRetentionAccessError,
  ParticipantRetentionConfirmationError,
  ParticipantRetentionService,
  ParticipantRetentionStateError,
} from "./participant-retention-service.server";

import {
  id,
  organisationId,
  seedExpiredRetentionEvent,
} from "./participant-retention-test-fixture";

beforeEach(async () => {
  await ensureDemoData(env as unknown as CloudflareEnvironment);
});

describe("participant retention", () => {
  it("anonymises event-scoped PII, revokes exclusive credentials, and preserves shared identities plus immutable audit", async () => {
    const seeded = await seedExpiredRetentionEvent();
    const service = new ParticipantRetentionService(seeded.testEnv);
    const preview = await service.preview(seeded.owner);
    expect(preview).toMatchObject({
      name: "Expired privacy event",
      canRun: true,
      pendingParticipants: 3,
      completed: false,
      immutableAuditRecords: 3,
      retainedProgrammeRecords: 1,
      externalProviderErasureRequired: true,
    });

    const result = await service.anonymiseExpiredParticipants(seeded.owner, {
      confirmation: "Expired privacy event",
      acknowledged: true,
    });
    expect(result).toMatchObject({ complete: true, duplicate: false });
    expect(result.state).toMatchObject({
      completed: true,
      pendingParticipants: 0,
      anonymisedParticipants: 3,
      sharedIdentities: 2,
      sharedIdentityAuditLinks: 2,
    });
    expect(
      await seeded.testEnv.DB.prepare(
        `SELECT participant_retention_completed_at AS completedAt
           FROM events WHERE id = ?`,
      )
        .bind(seeded.eventId)
        .first(),
    ).toMatchObject({ completedAt: expect.any(Number) });

    const submissions = await seeded.testEnv.DB.prepare(
      `SELECT id, submitter_person_id AS personId, submitter_email AS email,
              answers_json AS answersJson, submitted_snapshot_json AS snapshotJson,
              title
         FROM submissions WHERE event_id = ? ORDER BY id`,
    )
      .bind(seeded.eventId)
      .all<{
        id: string;
        personId: string;
        email: string | null;
        answersJson: string;
        snapshotJson: string;
        title: string;
      }>();
    expect(submissions.results).toHaveLength(2);
    for (const submission of submissions.results) {
      expect(submission.personId).toMatch(/^retained-participant-/);
      expect(submission.email).toBeNull();
      expect(JSON.parse(submission.answersJson)).toEqual({
        redacted: true,
        reason: "event_retention_period_elapsed",
      });
      expect(JSON.parse(submission.snapshotJson)).toEqual({
        redacted: true,
        reason: "event_retention_period_elapsed",
      });
      expect(submission.title).toBe("Retained submission");
    }

    expect(
      await seeded.testEnv.DB.prepare(
        `SELECT email, display_name AS name, biography,
                linkedin_url AS linkedinUrl, x_handle AS xHandle
           FROM people WHERE id = ?`,
      )
        .bind(seeded.exclusiveId)
        .first(),
    ).toMatchObject({
      name: "Anonymised participant",
      biography: null,
      linkedinUrl: null,
      xHandle: null,
    });
    expect(
      await seeded.testEnv.DB.prepare(
        `SELECT email, display_name AS name, biography,
                linkedin_url AS linkedinUrl, x_handle AS xHandle
           FROM people WHERE id = ?`,
      )
        .bind(seeded.sharedId)
        .first(),
    ).toEqual({
      email: `${seeded.sharedId}@example.com`,
      name: "Shared Person",
      biography: "Shared biography",
      linkedinUrl: "https://www.linkedin.com/in/shared-person",
      xHandle: "shared_user",
    });
    const retainedEventProfiles = await seeded.testEnv.DB.prepare(
      `SELECT event_id AS eventId, organisation_id AS organisationId,
              person_id AS personId,
              travel_preferences AS travelPreferences
         FROM event_participant_profiles
        WHERE person_id IN (?, ?)
        ORDER BY event_id`,
    )
      .bind(seeded.exclusiveId, seeded.sharedId)
      .all();
    expect(retainedEventProfiles.results).toEqual([
      {
        eventId: seeded.otherEventId,
        organisationId,
        personId: seeded.sharedId,
        travelPreferences: "Other event travel preferences",
      },
    ]);
    expect(
      (
        await seeded.testEnv.DB.prepare(
          `SELECT event_id AS eventId, person_id AS personId, biography
             FROM speaker_profile_revisions
            WHERE person_id IN (?, ?)
            ORDER BY event_id`,
        )
          .bind(seeded.exclusiveId, seeded.sharedId)
          .all()
      ).results,
    ).toEqual([
      {
        eventId: seeded.otherEventId,
        personId: seeded.sharedId,
        biography: "Other event historical biography",
      },
    ]);
    expect(
      await seeded.testEnv.DB.prepare(
        `SELECT person.email, membership.revoked_at AS revokedAt
           FROM people person
           JOIN memberships membership ON membership.person_id = person.id
          WHERE person.id = 'person-demo-owner' AND membership.role = 'owner'`,
      ).first(),
    ).toEqual({ email: "morgan.owner@example.com", revokedAt: null });
    expect(
      await seeded.testEnv.DB.prepare(
        `SELECT COUNT(*) AS total FROM session_speakers
          WHERE event_id = ? AND person_id = 'person-demo-owner'`,
      )
        .bind(seeded.eventId)
        .first(),
    ).toEqual({ total: 0 });
    const retainedSessionSpeakers = await seeded.testEnv.DB.prepare(
      `SELECT person_id AS personId
         FROM session_speakers
        WHERE event_id = ?
        ORDER BY position`,
    )
      .bind(seeded.eventId)
      .all<{ personId: string }>();
    expect(retainedSessionSpeakers.results).toHaveLength(2);
    expect(
      retainedSessionSpeakers.results.every(({ personId }) =>
        personId.startsWith("retained-participant-"),
      ),
    ).toBe(true);
    expect(retainedSessionSpeakers.results).not.toEqual(
      expect.arrayContaining([
        { personId: seeded.exclusiveId },
        { personId: "person-demo-owner" },
      ]),
    );
    const workflowRows = await seeded.testEnv.DB.prepare(
      `SELECT person_id AS personId
         FROM event_speaker_workflows
        WHERE event_id = ?
        ORDER BY person_id`,
    )
      .bind(seeded.eventId)
      .all<{ personId: string }>();
    expect(workflowRows.results).toHaveLength(3);
    expect(
      workflowRows.results.every(({ personId }) =>
        personId.startsWith("retained-participant-"),
      ),
    ).toBe(true);
    expect(workflowRows.results).not.toEqual(
      expect.arrayContaining([
        { personId: seeded.exclusiveId },
        { personId: seeded.sharedId },
        { personId: "person-demo-owner" },
      ]),
    );
    expect(
      await seeded.testEnv.DB.prepare(
        `SELECT session.description AS sessionDescription,
                content.description AS snapshotDescription,
                revision.description AS revisionDescription
           FROM sessions session
           JOIN schedule_session_contents content
             ON content.session_id = session.id
            AND content.event_id = session.event_id
           JOIN session_content_revisions revision
             ON revision.session_id = session.id
            AND revision.event_id = session.event_id
            AND revision.schedule_version_id = content.schedule_version_id
          WHERE session.id = ? AND content.schedule_version_id = ?`,
      )
        .bind(seeded.sessionId, seeded.scheduleVersionId)
        .first(),
    ).toEqual({
      sessionDescription: null,
      snapshotDescription: null,
      revisionDescription: null,
    });
    expect(
      await seeded.testEnv.DB.prepare(
        `SELECT task.owner_person_id AS ownerPersonId, task.description,
                comment.author_person_id AS authorPersonId, comment.body,
                evidence.submitted_by_person_id AS submittedByPersonId,
                evidence.evidence_json AS evidenceJson
           FROM task_instances task
           JOIN task_comments comment ON comment.task_id = task.id
           JOIN task_evidence evidence ON evidence.task_id = task.id
          WHERE task.id = ? AND comment.id = ? AND evidence.id = ?`,
      )
        .bind(
          seeded.operationalTaskId,
          seeded.operationalTaskCommentId,
          seeded.operationalTaskEvidenceId,
        )
        .first(),
    ).toEqual({
      ownerPersonId: "person-demo-owner",
      description: "Retained staff instruction",
      authorPersonId: "person-demo-owner",
      body: "Retained staff note",
      submittedByPersonId: "person-demo-owner",
      evidenceJson: '{"operational":true}',
    });
    expect(
      await seeded.testEnv.DB.prepare(
        "SELECT COUNT(*) AS total FROM auth_sessions WHERE person_id = ?",
      )
        .bind(seeded.exclusiveId)
        .first(),
    ).toEqual({ total: 0 });
    expect(
      await seeded.testEnv.DB.prepare(
        "SELECT COUNT(*) AS total FROM auth_accounts WHERE person_id = ?",
      )
        .bind(seeded.exclusiveId)
        .first(),
    ).toEqual({ total: 0 });
    expect(
      await seeded.testEnv.DB.prepare(
        "SELECT COUNT(*) AS total FROM verification_tokens WHERE identifier LIKE ?",
      )
        .bind(`application-session:${seeded.formId}:%`)
        .first(),
    ).toEqual({ total: 0 });

    const delivery = await seeded.testEnv.DB.prepare(
      `SELECT recipient_address AS address, recipient_name AS name,
              provider, provider_message_id AS providerMessageId,
              source_values_json AS sourceValuesJson,
              rendered_subject AS renderedSubject,
              rendered_body_sha256 AS renderedBodySha256
         FROM communication_deliveries WHERE id = ?`,
    )
      .bind(seeded.deliveryId)
      .first();
    expect(delivery).toMatchObject({
      name: null,
      provider: null,
      providerMessageId: null,
      renderedSubject: "Retained message",
      renderedBodySha256: null,
    });
    expect(String((delivery as { address: string }).address)).toContain(
      "@privacy.invalid",
    );
    expect(
      JSON.parse((delivery as { sourceValuesJson: string }).sourceValuesJson),
    ).toMatchObject({ redacted: true });
    await expect(
      seeded.testEnv.DB.prepare(
        `SELECT communication.id AS communicationId,
                delivery.id AS deliveryId,
                json_extract(communication.audience_json, '$.decisionId')
                  AS audienceDecisionId,
                delivery.source_id AS deliverySourceId
           FROM operation_jobs operation
           JOIN communications communication
             ON communication.operation_id = operation.id
            AND communication.event_id = operation.event_id
           JOIN communication_deliveries delivery
             ON delivery.communication_id = communication.id
            AND delivery.event_id = communication.event_id
          WHERE operation.id = ? AND operation.event_id = ?`,
      )
        .bind(seeded.decisionOperationId, seeded.eventId)
        .first(),
    ).resolves.toEqual({
      communicationId: seeded.communicationId,
      deliveryId: seeded.deliveryId,
      audienceDecisionId: null,
      deliverySourceId: null,
    });
    expect(
      await seeded.testEnv.DB.prepare(
        `SELECT status, from_name AS fromName, from_email AS fromEmail,
                reply_to_email AS replyTo, provider_sender_id AS providerSenderId
           FROM sender_profiles WHERE id = ?`,
      )
        .bind(seeded.senderProfileId)
        .first(),
    ).toMatchObject({
      status: "disabled",
      fromName: "Retained sender",
      replyTo: null,
      providerSenderId: null,
    });
    expect(
      await seeded.testEnv.DB.prepare(
        `SELECT content_json AS contentJson, rendered_preview_html AS previewHtml
           FROM communication_template_versions WHERE id = ?`,
      )
        .bind(seeded.templateVersionId)
        .first(),
    ).toMatchObject({ previewHtml: null });
    expect(
      await seeded.testEnv.DB.prepare(
        `SELECT page.status, page.title, version.document_json AS documentJson,
                version.rendered_html AS renderedHtml
           FROM resource_pages page
           JOIN resource_page_versions version
             ON version.resource_page_id = page.id
          WHERE page.id = ? AND version.id = ?`,
      )
        .bind(seeded.resourceId, seeded.resourceVersionId)
        .first(),
    ).toMatchObject({
      status: "archived",
      title: "Retained resource",
      renderedHtml: "<p>Content removed under the event retention policy.</p>",
    });
    expect(
      await seeded.testEnv.DB.prepare(
        `SELECT original_filename AS filename, object_key AS objectKey,
                checksum_sha256 AS checksum, object_etag AS etag,
                scan_provider AS scanProvider, scan_result_json AS scanResult,
                scan_error AS scanError
           FROM file_versions WHERE id = ?`,
      )
        .bind(seeded.fileVersionId)
        .first(),
    ).toEqual({
      filename: "retained-file",
      objectKey: `retained/${seeded.fileVersionId}`,
      checksum: null,
      etag: null,
      scanProvider: null,
      scanResult: null,
      scanError: null,
    });
    expect(
      await seeded.testEnv.DB.prepare(
        `SELECT provider_event_id AS providerEventId, last_payload_hash AS payloadHash,
                connection_id AS connectionId, status
           FROM calendar_invitations WHERE id = ?`,
      )
        .bind(seeded.invitationId)
        .first(),
    ).toEqual({
      providerEventId: null,
      payloadHash: null,
      connectionId: null,
      status: "cancelled",
    });

    const immutableAudit = await seeded.testEnv.DB.prepare(
      `SELECT actor_person_id AS actorPersonId, metadata_json AS metadataJson
         FROM audit_events
        WHERE event_id = ? AND action = 'submission.created'
        ORDER BY actor_person_id`,
    )
      .bind(seeded.eventId)
      .all<{ actorPersonId: string; metadataJson: string }>();
    expect(immutableAudit.results.map((row) => row.actorPersonId)).toEqual([
      seeded.exclusiveId,
      seeded.sharedId,
    ]);
    expect(
      immutableAudit.results.every((row) =>
        row.metadataJson.includes("@example.com"),
      ),
    ).toBe(true);

    await expect(
      service.anonymiseExpiredParticipants(seeded.owner, {
        confirmation: "Expired privacy event",
        acknowledged: true,
      }),
    ).resolves.toMatchObject({ complete: true, duplicate: true });
  });

  it("redacts immutable session evaluation snapshots before completing retention", async () => {
    const seeded = await seedExpiredRetentionEvent();
    const planId = id("privacy-evaluation-plan");
    const roundId = id("privacy-evaluation-round");
    const assignmentId = id("privacy-session-assignment");
    await seeded.testEnv.DB.batch([
      seeded.testEnv.DB.prepare(
        `INSERT INTO evaluation_plans (
           id, event_id, name, status, created_by_person_id
         ) VALUES (?, ?, 'Retained session review', 'archived',
                   'person-demo-owner')`,
      ).bind(planId, seeded.eventId),
      seeded.testEnv.DB.prepare(
        `INSERT INTO evaluation_rounds (
           id, event_id, plan_id, round_number, name, status, scorecard_id
         ) VALUES (?, ?, ?, 1, 'Retained session review', 'archived', ?)`,
      ).bind(roundId, seeded.eventId, planId, roundId),
      seeded.testEnv.DB.prepare(
        `INSERT INTO evaluator_assignments (
           id, event_id, round_id, session_id, session_snapshot_json,
           evaluator_person_id, status
         ) VALUES (?, ?, ?, ?, ?, 'person-demo-owner', 'submitted')`,
      ).bind(
        assignmentId,
        seeded.eventId,
        roundId,
        seeded.sessionId,
        JSON.stringify({
          schemaVersion: 1,
          sessionId: seeded.sessionId,
          title: "Retained programme fact",
          description: "Private speaker description",
          speakers: [{ name: "Exclusive Person", roleLabel: "Presenter" }],
        }),
      ),
    ]);

    const service = new ParticipantRetentionService(seeded.testEnv);
    const result = await service.anonymiseExpiredParticipants(seeded.owner, {
      confirmation: "Expired privacy event",
      acknowledged: true,
    });
    expect(result).toMatchObject({
      complete: true,
      state: { integrityViolations: [] },
    });

    const assignment = await seeded.testEnv.DB.prepare(
      `SELECT session_snapshot_json AS snapshotJson
         FROM evaluator_assignments WHERE id = ? AND event_id = ?`,
    )
      .bind(assignmentId, seeded.eventId)
      .first<{ snapshotJson: string }>();
    expect(JSON.parse(assignment!.snapshotJson)).toEqual({
      redacted: true,
      reason: "event_retention_period_elapsed",
    });
  });

  it("redacts committee discussion content and blocks later discussion writes", async () => {
    const seeded = await seedExpiredRetentionEvent();
    const planId = id("privacy-discussion-plan");
    const roundId = id("privacy-discussion-round");
    const messageId = id("privacy-discussion-message");
    await seeded.testEnv.DB.batch([
      seeded.testEnv.DB.prepare(
        `INSERT INTO evaluation_plans (
           id, event_id, name, status, created_by_person_id
         ) VALUES (?, ?, 'Retained committee discussion', 'archived',
                   'person-demo-owner')`,
      ).bind(planId, seeded.eventId),
      seeded.testEnv.DB.prepare(
        `INSERT INTO evaluation_rounds (
           id, event_id, plan_id, round_number, name, status, scorecard_id
         ) VALUES (?, ?, ?, 1, 'Retained committee discussion', 'archived', ?)`,
      ).bind(roundId, seeded.eventId, planId, roundId),
      seeded.testEnv.DB.prepare(
        `INSERT INTO evaluation_discussion_messages (
           id, event_id, round_id, submission_id, author_person_id, body,
           idempotency_key
         ) VALUES (?, ?, ?, ?, ?,
                   'Private committee content that must be removed.', ?)`,
      ).bind(
        messageId,
        seeded.eventId,
        roundId,
        seeded.exclusiveSubmissionId,
        seeded.exclusiveId,
        id("privacy-discussion-intent"),
      ),
    ]);

    const service = new ParticipantRetentionService(seeded.testEnv);
    await service.anonymiseExpiredParticipants(seeded.owner, {
      confirmation: "Expired privacy event",
      acknowledged: true,
    });

    const retained = await seeded.testEnv.DB.prepare(
      `SELECT author_person_id AS authorPersonId, body, idempotency_key AS idempotencyKey
         FROM evaluation_discussion_messages
        WHERE id = ? AND event_id = ?`,
    )
      .bind(messageId, seeded.eventId)
      .first<{
        authorPersonId: string;
        body: string | null;
        idempotencyKey: string;
      }>();
    expect(retained).toMatchObject({
      authorPersonId: expect.stringMatching(/^retained-participant-/u),
      body: null,
      idempotencyKey: `retained-discussion-${messageId}`,
    });

    await expect(
      seeded.testEnv.DB.prepare(
        `INSERT INTO evaluation_discussion_messages (
           id, event_id, round_id, submission_id, author_person_id, body,
           idempotency_key
         ) VALUES (?, ?, ?, ?, 'person-demo-owner',
                   'Restored private committee content', ?)`,
      )
        .bind(
          id("post-retention-discussion"),
          seeded.eventId,
          roundId,
          seeded.exclusiveSubmissionId,
          id("post-retention-discussion-intent"),
        )
        .run(),
    ).rejects.toThrow(
      "event participant retention is complete; participant PII is read-only",
    );
  });

  it("deletes AI assessment content and rejects new assessments after retention", async () => {
    const seeded = await seedExpiredRetentionEvent();
    const planId = id("privacy-ai-plan");
    const roundId = id("privacy-ai-round");
    const assessmentId = id("privacy-ai-assessment");
    const formVersionId = id("privacy-ai-form-version");
    const submissionRevisionId = id("privacy-ai-submission-revision");
    const sourceSnapshotSha256 = "a".repeat(64);
    const modelInputSha256 = "b".repeat(64);
    await seeded.testEnv.DB.batch([
      seeded.testEnv.DB.prepare(
        `INSERT INTO form_versions (
           id, event_id, form_id, version_number, schema_json, status,
           published_at, created_by_person_id
         ) VALUES (?, ?, ?, 1, '{"fields":[]}', 'published', unixepoch(),
                   'person-demo-owner')`,
      ).bind(formVersionId, seeded.eventId, seeded.formId),
      seeded.testEnv.DB.prepare(
        `UPDATE submissions SET form_version_id = ?
          WHERE id = ? AND event_id = ?`,
      ).bind(formVersionId, seeded.exclusiveSubmissionId, seeded.eventId),
      seeded.testEnv.DB.prepare(
        `INSERT INTO submission_revisions (
           id, event_id, submission_id, form_version_id, revision_number,
           answers_json, speaker_snapshot_json, save_kind, saved_by_person_id
         )
         SELECT ?, event_id, id, form_version_id, 1, answers_json, '[]',
                'submitted', submitter_person_id
           FROM submissions WHERE id = ? AND event_id = ?`,
      ).bind(
        submissionRevisionId,
        seeded.exclusiveSubmissionId,
        seeded.eventId,
      ),
      seeded.testEnv.DB.prepare(
        `INSERT INTO evaluation_plans (
           id, event_id, name, status, created_by_person_id
         ) VALUES (?, ?, 'Retained AI review', 'active',
                   'person-demo-owner')`,
      ).bind(planId, seeded.eventId),
      seeded.testEnv.DB.prepare(
        `INSERT INTO evaluation_rounds (
           id, event_id, plan_id, round_number, name, status,
           scorecard_id, scorecard_version
         ) VALUES (?, ?, ?, 1, 'Retained AI review', 'active', ?, 1)`,
      ).bind(roundId, seeded.eventId, planId, roundId),
      seeded.testEnv.DB.prepare(
        `INSERT INTO ai_review_assessments (
           id, event_id, round_id, submission_id, scorecard_id,
           scorecard_version, round_revision, score, rationale, provider,
           model, provider_response_id, generated_by_person_id,
           submission_revision_id, source_snapshot_sha256,
           model_input_sha256, prompt_version, last_operation_id
         ) VALUES (?, ?, ?, ?, ?, 1, 1, 4,
                   'Private generated rationale that must be deleted when participant retention completes.',
                   'workers_ai', '@cf/deepseek-ai/deepseek-v4-flash-0731', ?,
                   'person-demo-owner', ?, ?, ?, 1, ?)`,
      ).bind(
        assessmentId,
        seeded.eventId,
        roundId,
        seeded.exclusiveSubmissionId,
        roundId,
        id("privacy-ai-provider-response"),
        submissionRevisionId,
        sourceSnapshotSha256,
        modelInputSha256,
        id("privacy-ai-operation"),
      ),
    ]);

    const service = new ParticipantRetentionService(seeded.testEnv);
    await service.anonymiseExpiredParticipants(seeded.owner, {
      confirmation: "Expired privacy event",
      acknowledged: true,
    });

    await expect(
      seeded.testEnv.DB.prepare(
        `SELECT COUNT(*) AS total FROM ai_review_assessments
          WHERE event_id = ?`,
      )
        .bind(seeded.eventId)
        .first(),
    ).resolves.toEqual({ total: 0 });

    await expect(
      seeded.testEnv.DB.prepare(
        `INSERT INTO ai_review_assessments (
           id, event_id, round_id, submission_id, scorecard_id,
           scorecard_version, round_revision, score, rationale, provider,
           model, provider_response_id, generated_by_person_id,
           submission_revision_id, source_snapshot_sha256,
           model_input_sha256, prompt_version, last_operation_id
         ) VALUES (?, ?, ?, ?, ?, 1, 1, 4,
                   'A new private rationale must not be written after participant retention has completed.',
                   'workers_ai', '@cf/deepseek-ai/deepseek-v4-flash-0731', ?,
                   'person-demo-owner', ?, ?, ?, 1, ?)`,
      )
        .bind(
          id("post-retention-ai-assessment"),
          seeded.eventId,
          roundId,
          seeded.exclusiveSubmissionId,
          roundId,
          id("post-retention-ai-provider-response"),
          submissionRevisionId,
          sourceSnapshotSha256,
          modelInputSha256,
          id("post-retention-ai-operation"),
        )
        .run(),
    ).rejects.toThrow(
      "event participant retention is complete; participant PII is read-only",
    );
  });

  it("rejects participant PII writes after the durable completion tombstone", async () => {
    const seeded = await seedExpiredRetentionEvent();
    const service = new ParticipantRetentionService(seeded.testEnv);
    await service.anonymiseExpiredParticipants(seeded.owner, {
      confirmation: "Expired privacy event",
      acknowledged: true,
    });
    const retained = await seeded.testEnv.DB.prepare(
      `SELECT submitter_person_id AS personId
         FROM submissions WHERE id = ?`,
    )
      .bind(seeded.exclusiveSubmissionId)
      .first<{ personId: string }>();
    expect(retained?.personId).toMatch(/^retained-participant-/);
    const lockMessage =
      "event participant retention is complete; participant PII is read-only";

    await expect(
      seeded.testEnv.DB.prepare(
        `UPDATE submissions SET submitter_email = 'restored@example.com'
          WHERE id = ?`,
      )
        .bind(seeded.exclusiveSubmissionId)
        .run(),
    ).rejects.toThrow(lockMessage);
    await expect(
      seeded.testEnv.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role, accepted_at
         ) VALUES (?, ?, ?, 'person-demo-owner', 'speaker', unixepoch())`,
      )
        .bind(id("post-retention-membership"), organisationId, seeded.eventId)
        .run(),
    ).rejects.toThrow(lockMessage);
    await expect(
      seeded.testEnv.DB.prepare(
        `INSERT INTO event_participant_profiles (
           event_id, organisation_id, person_id, travel_preferences,
           last_operation_id
         ) VALUES (?, ?, ?, 'Restored private travel details', ?)`,
      )
        .bind(
          seeded.eventId,
          organisationId,
          retained!.personId,
          id("post-retention-event-profile"),
        )
        .run(),
    ).rejects.toThrow(lockMessage);
    await expect(
      seeded.testEnv.DB.prepare(
        `INSERT INTO speaker_profile_revisions (
           id, organisation_id, event_id, person_id, source, profile_revision,
           display_name, biography, publication_status, correlation_id
         ) VALUES (?, ?, ?, ?, 'canonical_person', 2, 'Restored participant',
                   'Restored private biography', 'published', ?)`,
      )
        .bind(
          id("post-retention-profile-revision"),
          organisationId,
          seeded.eventId,
          retained!.personId,
          id("post-retention-profile-correlation"),
        )
        .run(),
    ).rejects.toThrow(lockMessage);
    await expect(
      seeded.testEnv.DB.prepare(
        `UPDATE people SET display_name = 'Restored participant'
          WHERE id = ?`,
      )
        .bind(retained!.personId)
        .run(),
    ).rejects.toThrow(lockMessage);
    await expect(
      seeded.testEnv.DB.prepare(
        `INSERT INTO verification_tokens (
           id, identifier, value, expires_at
         ) VALUES (?, ?, 'private-token', unixepoch() + 3600)`,
      )
        .bind(
          id("post-retention-token"),
          `application-session:${seeded.formId}:restored@example.com`,
        )
        .run(),
    ).rejects.toThrow(lockMessage);
    await expect(
      seeded.testEnv.DB.prepare(
        `INSERT INTO communication_deliveries (
           id, event_id, communication_id, recipient_address, channel,
           idempotency_key
         ) VALUES (?, ?, ?, 'restored@example.com', 'email', ?)`,
      )
        .bind(
          id("post-retention-delivery"),
          seeded.eventId,
          seeded.communicationId,
          id("post-retention-delivery-key"),
        )
        .run(),
    ).rejects.toThrow(lockMessage);
    await expect(
      seeded.testEnv.DB.prepare(
        `UPDATE communication_deliveries
            SET rendered_subject = 'Restored private decision subject'
          WHERE id = ?`,
      )
        .bind(seeded.deliveryId)
        .run(),
    ).rejects.toThrow(lockMessage);
    await expect(
      seeded.testEnv.DB.prepare(
        `INSERT INTO file_assets (
           id, event_id, owner_person_id, target_type, target_id, asset_kind,
           status
         ) VALUES (?, ?, ?, 'person', ?, 'headshot', 'pending')`,
      )
        .bind(
          id("post-retention-file"),
          seeded.eventId,
          retained!.personId,
          retained!.personId,
        )
        .run(),
    ).rejects.toThrow(lockMessage);
    await expect(
      seeded.testEnv.DB.prepare(
        `UPDATE schedule_session_contents
            SET description = 'Restored private speaker description'
          WHERE schedule_version_id = ? AND session_id = ?`,
      )
        .bind(seeded.scheduleVersionId, seeded.sessionId)
        .run(),
    ).rejects.toThrow(lockMessage);

    const operationalWebhookId = id("post-retention-webhook");
    await expect(
      seeded.testEnv.DB.batch([
        seeded.testEnv.DB.prepare(
          `INSERT INTO audit_events (
             id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
             entity_type, entity_id, metadata_json
           ) VALUES (?, 'person', 'internal', 1, ?, ?, 'person-demo-owner', 'retention.follow_up',
                     'event', ?, '{}')`,
        ).bind(
          id("post-retention-audit"),
          organisationId,
          seeded.eventId,
          seeded.eventId,
        ),
        seeded.testEnv.DB.prepare(
          `INSERT INTO operation_jobs (
             id, organisation_id, event_id, requested_by_person_id, type,
             idempotency_key, correlation_id, status, payload_json
           ) VALUES (?, ?, ?, 'person-demo-owner', 'retention_follow_up',
                     ?, ?, 'completed', '{"maintenance":true}')`,
        ).bind(
          id("post-retention-operation"),
          organisationId,
          seeded.eventId,
          id("post-retention-operation-key"),
          id("post-retention-correlation"),
        ),
        seeded.testEnv.DB.prepare(
          `INSERT INTO event_changes (
             event_id, entity_type, entity_id, change_type, correlation_id
           ) VALUES (?, 'event', ?, 'updated', ?)`,
        ).bind(
          seeded.eventId,
          seeded.eventId,
          id("post-retention-event-change"),
        ),
        seeded.testEnv.DB.prepare(
          `INSERT INTO webhook_endpoints (
             id, organisation_id, event_id, name, url, secret_ciphertext,
             event_types_json, status
           ) VALUES (?, ?, ?, 'Operational retention webhook',
                     'https://operations.invalid/hook', 'encrypted-secret',
                     '["retention.follow_up"]', 'active')`,
        ).bind(operationalWebhookId, organisationId, seeded.eventId),
        seeded.testEnv.DB.prepare(
          `INSERT INTO webhook_deliveries (
             id, endpoint_id, event_type, entity_type, entity_id,
             idempotency_key, request_hash, payload_json, status
           ) VALUES (?, ?, 'retention.follow_up', 'event', ?, ?,
                     '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
                     '{"maintenance":true}', 'delivered')`,
        ).bind(
          id("post-retention-webhook-delivery"),
          operationalWebhookId,
          seeded.eventId,
          id("post-retention-webhook-key"),
        ),
        seeded.testEnv.DB.prepare(
          `UPDATE communication_deliveries SET status = 'delivered'
            WHERE id = ?`,
        ).bind(seeded.deliveryId),
        seeded.testEnv.DB.prepare(
          `UPDATE sessions SET title = 'Corrected retained programme fact'
            WHERE event_id = ?`,
        ).bind(seeded.eventId),
      ]),
    ).resolves.toBeDefined();
    await expect(service.preview(seeded.owner)).resolves.toMatchObject({
      completed: true,
      integrityViolations: [],
    });
  });

  it("fails a rerun when the completion tombstone and immutable audit disagree", async () => {
    const seeded = await seedExpiredRetentionEvent();
    const service = new ParticipantRetentionService(seeded.testEnv);
    await seeded.testEnv.DB.prepare(
      `UPDATE events SET participant_retention_completed_at = unixepoch()
        WHERE id = ?`,
    )
      .bind(seeded.eventId)
      .run();

    const preview = await service.preview(seeded.owner);
    expect(preview.completed).toBe(true);
    expect(preview.integrityViolations).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/participant identity or credential record/u),
      ]),
    );
    expect(preview.integrityViolations).toContain(
      "The completion tombstone exists without its immutable completion audit.",
    );
    await expect(
      service.anonymiseExpiredParticipants(seeded.owner, {
        confirmation: "Expired privacy event",
        acknowledged: true,
      }),
    ).rejects.toThrow("integrity check failed");

    const auditOnly = await seedExpiredRetentionEvent();
    const auditOnlyService = new ParticipantRetentionService(auditOnly.testEnv);
    await auditOnly.testEnv.DB.prepare(
      `INSERT INTO audit_events (
         id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action, entity_type,
         entity_id, metadata_json
       ) VALUES (?, 'person', 'internal', 1, ?, ?, 'person-demo-owner',
                 'participant.retention.completed', 'event', ?, ?)`,
    )
      .bind(
        `participant-retention-complete:${auditOnly.eventId}`,
        organisationId,
        auditOnly.eventId,
        auditOnly.eventId,
        JSON.stringify({
          version: 1,
          scope: "local_event_data",
          repositoryProvider: "d1",
          externalProviderErasureRequired: false,
          immutableAuditRecords: 0,
          sharedIdentityAuditLinks: 0,
          retainedProgrammeRecords: 0,
          unscopedStoresNotAutomaticallyRedacted: [
            "webhook_receipts",
            "abuse_rate_limits",
          ],
        }),
      )
      .run();
    const auditOnlyPreview = await auditOnlyService.preview(auditOnly.owner);
    expect(auditOnlyPreview.integrityViolations).toContain(
      "The immutable completion audit exists without the event completion tombstone.",
    );
    await expect(
      auditOnlyService.anonymiseExpiredParticipants(auditOnly.owner, {
        confirmation: "Expired privacy event",
        acknowledged: true,
      }),
    ).rejects.toThrow("integrity check failed");
  });

  it("fails closed for non-owners, legal holds, published forms, and incorrect confirmation", async () => {
    const seeded = await seedExpiredRetentionEvent();
    const service = new ParticipantRetentionService(seeded.testEnv);
    await expect(
      service.preview({ ...seeded.owner, role: "administrator" }),
    ).rejects.toBeInstanceOf(ParticipantRetentionAccessError);
    await expect(
      service.preview({
        ...seeded.owner,
        organisationId: "org-outside-retention-scope",
      }),
    ).rejects.toBeInstanceOf(ParticipantRetentionAccessError);
    await expect(
      service.anonymiseExpiredParticipants(seeded.owner, {
        confirmation: "wrong event",
        acknowledged: true,
      }),
    ).rejects.toBeInstanceOf(ParticipantRetentionConfirmationError);

    await seeded.testEnv.DB.prepare(
      "UPDATE events SET file_retention_hold_at = unixepoch() WHERE id = ?",
    )
      .bind(seeded.eventId)
      .run();
    await expect(
      service.anonymiseExpiredParticipants(seeded.owner, {
        confirmation: "Expired privacy event",
        acknowledged: true,
      }),
    ).rejects.toThrow("retention hold");

    await seeded.testEnv.DB.batch([
      seeded.testEnv.DB.prepare(
        "UPDATE events SET file_retention_hold_at = NULL WHERE id = ?",
      ).bind(seeded.eventId),
      seeded.testEnv.DB.prepare(
        "UPDATE form_definitions SET status = 'published' WHERE id = ?",
      ).bind(seeded.formId),
    ]);
    await expect(
      service.anonymiseExpiredParticipants(seeded.owner, {
        confirmation: "Expired privacy event",
        acknowledged: true,
      }),
    ).rejects.toBeInstanceOf(ParticipantRetentionStateError);
  });

  it("requires featured speakers to be removed from the published event site", async () => {
    const seeded = await seedExpiredRetentionEvent();
    const service = new ParticipantRetentionService(seeded.testEnv);
    await seeded.testEnv.DB.batch([
      seeded.testEnv.DB.prepare(
        `INSERT INTO event_public_sites (
           event_id, organisation_id, draft_json, published_json,
           published_revision, published_at, last_updated_by_person_id,
           last_operation_id
         ) VALUES (?, ?, '{}', '{}', 1, unixepoch(), 'person-demo-owner', ?)`,
      ).bind(
        seeded.eventId,
        organisationId,
        id("privacy-public-site-operation"),
      ),
      seeded.testEnv.DB.prepare(
        `INSERT INTO event_public_site_references (
           event_id, organisation_id, kind, record_id, site_revision
         ) VALUES (?, ?, 'speaker', ?, 1)`,
      ).bind(seeded.eventId, organisationId, seeded.exclusiveId),
    ]);

    const preview = await service.preview(seeded.owner);
    expect(preview.canRun).toBe(false);
    expect(preview.blockers).toContain(
      "1 featured speaker remains on the published event site. Remove that speaker before anonymising participant data.",
    );
    await expect(
      service.anonymiseExpiredParticipants(seeded.owner, {
        confirmation: "Expired privacy event",
        acknowledged: true,
      }),
    ).rejects.toBeInstanceOf(ParticipantRetentionStateError);
  });

  it("serialises concurrent confirmations into one completion without duplicate subjects", async () => {
    const seeded = await seedExpiredRetentionEvent();
    const service = new ParticipantRetentionService(seeded.testEnv);
    const results = await Promise.all([
      service.anonymiseExpiredParticipants(seeded.owner, {
        confirmation: "Expired privacy event",
        acknowledged: true,
      }),
      service.anonymiseExpiredParticipants(seeded.owner, {
        confirmation: "Expired privacy event",
        acknowledged: true,
      }),
    ]);
    expect(results.every((result) => result.complete)).toBe(true);
    expect(
      await seeded.testEnv.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM audit_events
             WHERE id = ?) AS completions,
           (SELECT COUNT(*) FROM audit_events
             WHERE event_id = ?
               AND action = 'participant.retention.subject_anonymised') AS subjects,
           (SELECT COUNT(*) FROM audit_events subject
             WHERE subject.event_id = ?
               AND subject.action = 'participant.retention.subject_anonymised'
               AND (
                 EXISTS (SELECT 1 FROM memberships membership
                   WHERE membership.event_id = ?
                     AND membership.person_id = subject.entity_id)
                 OR EXISTS (SELECT 1 FROM submissions submission
                   WHERE submission.event_id = ?
                     AND submission.submitter_person_id = subject.entity_id)
                 OR EXISTS (SELECT 1 FROM session_speakers speaker
                   WHERE speaker.event_id = ?
                     AND speaker.person_id = subject.entity_id)
               )) AS linkedSubjects`,
      )
        .bind(
          `participant-retention-complete:${seeded.eventId}`,
          seeded.eventId,
          seeded.eventId,
          seeded.eventId,
          seeded.eventId,
          seeded.eventId,
        )
        .first(),
    ).toEqual({ completions: 1, subjects: 3, linkedSubjects: 3 });
  });
});
