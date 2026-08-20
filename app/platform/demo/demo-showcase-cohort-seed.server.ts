import { prepareDecisionNotificationIntent } from "~/modules/communications/decision-notification-intent.server";
import {
  DEMO_EVENT_ID,
  DEMO_IDENTITIES,
  DEMO_ORGANISATION_ID,
} from "~/platform/demo/demo-identities";
import { ensureDemoPublicSite } from "~/platform/demo/demo-public-site-seed.server";
import {
  DEMO_SHOWCASE_CHAIR_ASSIGNMENT_ID,
  DEMO_SHOWCASE_CRITICAL_REVIEW_ID,
  DEMO_SHOWCASE_DECISION_ID,
  DEMO_SHOWCASE_DISCUSSION_ID,
  DEMO_SHOWCASE_EMBED_CONFIGURATION,
  DEMO_SHOWCASE_EMBED_ID,
  DEMO_SHOWCASE_POSITIVE_REVIEW_ID,
  DEMO_SHOWCASE_PROFILE_REVISION_ID,
  DEMO_SHOWCASE_REVIEWER_ASSIGNMENT_ID,
  DEMO_SHOWCASE_ROUND_ID,
  DEMO_SHOWCASE_SUBMISSION_ID,
  DEMO_SHOWCASE_TIMESTAMP,
} from "~/platform/demo/demo-reset-fixtures";

export async function seedShowcaseCohort(env: CloudflareEnvironment) {
  // Edited sites stay untouched. Completeness is reported by baselineEvidence,
  // not by the showcase incomplete-sentinel below.
  await ensureDemoPublicSite(env);
  const notificationOperationId =
    "demo-showcase-decision-notification-operation";
  const showcaseRationale =
    "Waitlisted after committee moderation because the reviewers disagreed on evidence and delivery scope.";
  const notificationContext = await env.DB.prepare(
    `SELECT submission.title, submission.submitter_person_id AS recipientPersonId,
            COALESCE(person.email, submission.submitter_email) AS recipientAddress,
            COALESCE(person.display_name, submission.submitter_email) AS recipientName,
            event.name AS eventName, event.brand_accent AS brandAccent,
            event.starts_at AS startsAt, event.ends_at AS endsAt
       FROM submissions submission
       JOIN events event
         ON event.id = submission.event_id AND event.organisation_id = ?
       LEFT JOIN people person ON person.id = submission.submitter_person_id
      WHERE submission.id = ? AND submission.event_id = ?`,
  )
    .bind(DEMO_ORGANISATION_ID, DEMO_SHOWCASE_SUBMISSION_ID, DEMO_EVENT_ID)
    .first<{
      title: string;
      recipientPersonId: string | null;
      recipientAddress: string | null;
      recipientName: string | null;
      eventName: string;
      brandAccent: string;
      startsAt: number;
      endsAt: number;
    }>();
  if (!notificationContext) {
    throw new Error("The showcase notification context is unavailable.");
  }
  const preparedNotification = await prepareDecisionNotificationIntent(env, {
    viewer: {
      organisationId: DEMO_ORGANISATION_ID,
      eventId: DEMO_EVENT_ID,
    },
    decisionId: DEMO_SHOWCASE_DECISION_ID,
    operationId: notificationOperationId,
    submissionId: DEMO_SHOWCASE_SUBMISSION_ID,
    submissionTitle: notificationContext.title,
    decision: "waitlisted",
    rationale: showcaseRationale,
    feedback: [],
    recipientPersonId: notificationContext.recipientPersonId,
    recipientAddress: notificationContext.recipientAddress,
    recipientName: notificationContext.recipientName,
    event: {
      name: notificationContext.eventName,
      brandAccent: notificationContext.brandAccent,
      startsAt: notificationContext.startsAt,
      endsAt: notificationContext.endsAt,
    },
  });
  if (!preparedNotification.intent) {
    throw new Error(preparedNotification.error);
  }
  const notificationIntent = {
    ...preparedNotification.intent,
    correlationId: "demo-showcase-decision-notification-correlation",
  };
  const positiveScores = JSON.stringify({
    "demo-evaluation-criterion-relevance": 5,
    "demo-evaluation-criterion-substance": 5,
    "demo-evaluation-criterion-practicality": 4,
    "demo-evaluation-criterion-delivery": 4,
  });
  const criticalScores = JSON.stringify({
    "demo-evaluation-criterion-relevance": 2,
    "demo-evaluation-criterion-substance": 2,
    "demo-evaluation-criterion-practicality": 3,
    "demo-evaluation-criterion-delivery": 2,
  });
  const criteriaSnapshotSql = `COALESCE((
    SELECT json_group_array(json(ordered.snapshot))
      FROM (
        SELECT json_object(
                 'id', criterion.id,
                 'name', criterion.name,
                 'description', criterion.description,
                 'inputType', criterion.input_type,
                 'options', json(criterion.options_json),
                 'weightPercent', criterion.weight_percent,
                 'required', json(CASE WHEN criterion.required = 1
                                      THEN 'true' ELSE 'false' END),
                 'position', criterion.position
               ) AS snapshot
          FROM evaluation_criteria criterion
         WHERE criterion.event_id = round.event_id
           AND criterion.round_id = round.id
         ORDER BY criterion.position
      ) ordered
  ), '[]')`;
  const reviewRevision = (input: {
    id: string;
    reviewId: string;
    scores: string;
    recommendation: "accept" | "reject";
    submitterFeedback: string;
    privateNotes: string;
    personId: string;
    timestamp: number;
  }) =>
    env.DB.prepare(
      `INSERT OR IGNORE INTO review_revisions (
         id, event_id, review_id, revision_number, scores_json, content_json,
         save_kind, saved_by_person_id, idempotency_key, scorecard_id,
         scorecard_version, criteria_snapshot_json, created_at
       )
       SELECT ?, review.event_id, review.id, 1, ?, ?, 'submitted', ?, ?,
              round.scorecard_id, round.scorecard_version,
              ${criteriaSnapshotSql}, ?
         FROM reviews review
         JOIN evaluator_assignments assignment
           ON assignment.id = review.assignment_id
          AND assignment.event_id = review.event_id
         JOIN evaluation_rounds round
           ON round.id = assignment.round_id
          AND round.event_id = assignment.event_id
        WHERE review.id = ? AND review.event_id = ?`,
    ).bind(
      input.id,
      input.scores,
      JSON.stringify({
        recommendation: input.recommendation,
        confidence: 4,
        submitterFeedback: input.submitterFeedback,
        privateNotes: input.privateNotes,
      }),
      input.personId,
      `demo-showcase:${input.reviewId}`,
      input.timestamp,
      input.reviewId,
      DEMO_EVENT_ID,
    );

  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO evaluation_round_reviewers (
         id, event_id, round_id, person_id, added_by_person_id,
         revision, created_at, updated_at
       )
       SELECT 'demo-showcase-round-reviewer-chair', round.event_id, round.id,
              membership.person_id, ?, 1, ?, ?
         FROM evaluation_rounds round
         JOIN memberships membership
           ON membership.event_id = round.event_id
          AND membership.person_id = ?
          AND membership.role = 'committee_chair'
          AND membership.accepted_at IS NOT NULL
          AND membership.revoked_at IS NULL
        WHERE round.id = ? AND round.event_id = ?`,
    ).bind(
      DEMO_IDENTITIES.owner.personId,
      DEMO_SHOWCASE_TIMESTAMP - 500,
      DEMO_SHOWCASE_TIMESTAMP - 500,
      DEMO_IDENTITIES.committee_chair.personId,
      DEMO_SHOWCASE_ROUND_ID,
      DEMO_EVENT_ID,
    ),
    env.DB.prepare(
      `UPDATE evaluator_assignments
          SET status = 'submitted', revision = 2,
              last_operation_id = 'demo-showcase:positive-review',
              submitted_at = ?, assigned_at = ?
        WHERE id = ? AND event_id = ? AND round_id = ?
          AND submission_id = ? AND evaluator_person_id = ?`,
    ).bind(
      DEMO_SHOWCASE_TIMESTAMP - 300,
      DEMO_SHOWCASE_TIMESTAMP - 900,
      DEMO_SHOWCASE_REVIEWER_ASSIGNMENT_ID,
      DEMO_EVENT_ID,
      DEMO_SHOWCASE_ROUND_ID,
      DEMO_SHOWCASE_SUBMISSION_ID,
      DEMO_IDENTITIES.evaluator.personId,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO evaluator_assignments (
         id, event_id, round_id, submission_id, evaluator_person_id,
         status, revision, last_operation_id, assigned_at, submitted_at
       )
       SELECT ?, round.event_id, round.id, submission.id, pool.person_id,
              'submitted', 2, 'demo-showcase:critical-review', ?, ?
         FROM evaluation_rounds round
         JOIN submissions submission
           ON submission.event_id = round.event_id AND submission.id = ?
         JOIN evaluation_round_reviewers pool
           ON pool.event_id = round.event_id AND pool.round_id = round.id
          AND pool.person_id = ?
        WHERE round.id = ? AND round.event_id = ?`,
    ).bind(
      DEMO_SHOWCASE_CHAIR_ASSIGNMENT_ID,
      DEMO_SHOWCASE_TIMESTAMP - 800,
      DEMO_SHOWCASE_TIMESTAMP - 200,
      DEMO_SHOWCASE_SUBMISSION_ID,
      DEMO_IDENTITIES.committee_chair.personId,
      DEMO_SHOWCASE_ROUND_ID,
      DEMO_EVENT_ID,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO reviews (
         id, event_id, assignment_id, status, scores_json, weighted_score,
         recommendation, confidence, submitter_feedback, private_notes,
         revision, last_operation_id, created_at, updated_at,
         submitted_at, locked_at
       ) VALUES (?, ?, ?, 'submitted', ?, 4.55, 'accept', 4, ?, ?,
                 1, 'demo-showcase:positive-review', ?, ?, ?, ?)`,
    ).bind(
      DEMO_SHOWCASE_POSITIVE_REVIEW_ID,
      DEMO_EVENT_ID,
      DEMO_SHOWCASE_REVIEWER_ASSIGNMENT_ID,
      positiveScores,
      "The operating rhythm is practical and immediately useful for event teams.",
      "Strong evidence and a clear facilitation plan.",
      DEMO_SHOWCASE_TIMESTAMP - 600,
      DEMO_SHOWCASE_TIMESTAMP - 300,
      DEMO_SHOWCASE_TIMESTAMP - 300,
      DEMO_SHOWCASE_TIMESTAMP - 300,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO reviews (
         id, event_id, assignment_id, status, scores_json, weighted_score,
         recommendation, confidence, submitter_feedback, private_notes,
         revision, last_operation_id, created_at, updated_at,
         submitted_at, locked_at
       ) VALUES (?, ?, ?, 'submitted', ?, 2.25, 'reject', 4, ?, ?,
                 1, 'demo-showcase:critical-review', ?, ?, ?, ?)`,
    ).bind(
      DEMO_SHOWCASE_CRITICAL_REVIEW_ID,
      DEMO_EVENT_ID,
      DEMO_SHOWCASE_CHAIR_ASSIGNMENT_ID,
      criticalScores,
      "The proposal needs clearer evidence and a more specific participant outcome.",
      "Useful topic, but the current scope is too broad for the promised workshop.",
      DEMO_SHOWCASE_TIMESTAMP - 550,
      DEMO_SHOWCASE_TIMESTAMP - 200,
      DEMO_SHOWCASE_TIMESTAMP - 200,
      DEMO_SHOWCASE_TIMESTAMP - 200,
    ),
    reviewRevision({
      id: "demo-showcase-review-positive-r1",
      reviewId: DEMO_SHOWCASE_POSITIVE_REVIEW_ID,
      scores: positiveScores,
      recommendation: "accept",
      submitterFeedback:
        "The operating rhythm is practical and immediately useful for event teams.",
      privateNotes: "Strong evidence and a clear facilitation plan.",
      personId: DEMO_IDENTITIES.evaluator.personId,
      timestamp: DEMO_SHOWCASE_TIMESTAMP - 300,
    }),
    reviewRevision({
      id: "demo-showcase-review-critical-r1",
      reviewId: DEMO_SHOWCASE_CRITICAL_REVIEW_ID,
      scores: criticalScores,
      recommendation: "reject",
      submitterFeedback:
        "The proposal needs clearer evidence and a more specific participant outcome.",
      privateNotes:
        "Useful topic, but the current scope is too broad for the promised workshop.",
      personId: DEMO_IDENTITIES.committee_chair.personId,
      timestamp: DEMO_SHOWCASE_TIMESTAMP - 200,
    }),
    env.DB.prepare(
      `INSERT OR IGNORE INTO evaluation_discussion_messages (
         id, event_id, round_id, submission_id, session_id,
         author_person_id, body, idempotency_key, created_at
       ) VALUES (?, ?, ?, ?, NULL, ?, ?, 'demo-showcase:discussion', ?)`,
    ).bind(
      DEMO_SHOWCASE_DISCUSSION_ID,
      DEMO_EVENT_ID,
      DEMO_SHOWCASE_ROUND_ID,
      DEMO_SHOWCASE_SUBMISSION_ID,
      DEMO_IDENTITIES.committee_chair.personId,
      "The reviews diverge on evidence and workshop scope. Keep this proposal visible for committee moderation before a final accept or reject decision.",
      DEMO_SHOWCASE_TIMESTAMP - 100,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO operation_jobs (
         id, organisation_id, event_id, requested_by_person_id, type,
         idempotency_key, correlation_id, status, payload_json,
         progress_completed, progress_total, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'decision.notification', ?, ?, 'queued', ?, 0, 1,
                 ?, ?)`,
    ).bind(
      notificationIntent.operationId,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.owner.personId,
      notificationIntent.operationIdempotencyKey,
      notificationIntent.correlationId,
      notificationIntent.queuePayloadJson,
      DEMO_SHOWCASE_TIMESTAMP,
      DEMO_SHOWCASE_TIMESTAMP,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO submission_decisions (
         id, event_id, submission_id, round_id, revision_number, status,
         decision, decided_by_person_id, rationale,
         notification_feedback_json, effect_preview_json, idempotency_key,
         notification_operation_id, decided_at, published_at
       ) VALUES (?, ?, ?, ?, 1, 'published', 'waitlisted', ?, ?, '[]', ?,
                 'demo-showcase:decision', ?, ?, ?)`,
    ).bind(
      DEMO_SHOWCASE_DECISION_ID,
      DEMO_EVENT_ID,
      DEMO_SHOWCASE_SUBMISSION_ID,
      DEMO_SHOWCASE_ROUND_ID,
      DEMO_IDENTITIES.owner.personId,
      showcaseRationale,
      JSON.stringify({
        submissionId: DEMO_SHOWCASE_SUBMISSION_ID,
        fromStatus: "in_review",
        toStatus: "waitlisted",
        notificationReleased: false,
      }),
      notificationIntent.operationId,
      DEMO_SHOWCASE_TIMESTAMP,
      DEMO_SHOWCASE_TIMESTAMP,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO communications (
         id, event_id, template_version_id, sender_profile_id, operation_id,
         idempotency_key, kind, channel, status, audience_json,
         content_snapshot_json, recipient_count, queued_at,
         created_by_person_id, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, 'transactional', 'email', 'queued', ?, ?, 1,
                 ?, ?, ?, ?)`,
    ).bind(
      notificationIntent.communicationId,
      DEMO_EVENT_ID,
      notificationIntent.templateVersionId,
      notificationIntent.senderProfileId,
      notificationIntent.operationId,
      notificationIntent.operationIdempotencyKey,
      notificationIntent.audienceJson,
      notificationIntent.contentSnapshotJson,
      DEMO_SHOWCASE_TIMESTAMP,
      DEMO_IDENTITIES.owner.personId,
      DEMO_SHOWCASE_TIMESTAMP,
      DEMO_SHOWCASE_TIMESTAMP,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO communication_deliveries (
         id, event_id, communication_id, person_id, recipient_address,
         recipient_name, source_id, source_values_json, channel, provider,
         idempotency_key, status, rendered_subject, rendered_body_sha256,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'email', ?, ?, 'queued', ?, ?, ?, ?)`,
    ).bind(
      notificationIntent.deliveryId,
      DEMO_EVENT_ID,
      notificationIntent.communicationId,
      notificationIntent.recipientPersonId,
      notificationIntent.recipientAddress,
      notificationIntent.recipientName,
      DEMO_SHOWCASE_SUBMISSION_ID,
      notificationIntent.sourceValuesJson,
      notificationIntent.senderProvider,
      notificationIntent.deliveryIdempotencyKey,
      notificationIntent.renderedSubject,
      notificationIntent.renderedBodySha256,
      DEMO_SHOWCASE_TIMESTAMP,
      DEMO_SHOWCASE_TIMESTAMP,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO operation_items (
         id, operation_id, item_key, entity_type, entity_id, status,
         result_json, updated_at
       ) VALUES (?, ?, ?, 'communication_delivery', ?, 'pending', ?, ?)`,
    ).bind(
      notificationIntent.operationItemId,
      notificationIntent.operationId,
      notificationIntent.deliveryIdempotencyKey,
      notificationIntent.deliveryId,
      JSON.stringify({ sourceId: DEMO_SHOWCASE_SUBMISSION_ID }),
      DEMO_SHOWCASE_TIMESTAMP,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO audit_events (
         id, actor_kind, origin, metadata_version, organisation_id, event_id,
         actor_person_id, action, entity_type, entity_id, correlation_id,
         metadata_json, created_at
       ) VALUES (?, 'person', 'internal', 1, ?, ?, ?,
                 'decision.notification.prepared', 'communication', ?, ?, ?, ?)`,
    ).bind(
      `decision-notification-prepared:${notificationIntent.operationId}`,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.owner.personId,
      notificationIntent.communicationId,
      notificationIntent.operationId,
      JSON.stringify({
        decisionId: DEMO_SHOWCASE_DECISION_ID,
        operationId: notificationIntent.operationId,
        templateVersionId: notificationIntent.templateVersionId,
        deliveryId: notificationIntent.deliveryId,
        renderedSubject: notificationIntent.renderedSubject,
        renderedBodySha256: notificationIntent.renderedBodySha256,
      }),
      DEMO_SHOWCASE_TIMESTAMP,
    ),
    env.DB.prepare(
      `INSERT INTO event_changes (
         event_id, entity_type, entity_id, change_type, correlation_id, created_at
       ) SELECT ?, 'communication', ?, 'created', ?, ?
          WHERE NOT EXISTS (
            SELECT 1 FROM event_changes existing
             WHERE existing.event_id = ?
               AND existing.entity_type = 'communication'
               AND existing.entity_id = ?
               AND existing.change_type = 'created'
               AND existing.correlation_id = ?
          )`,
    ).bind(
      DEMO_EVENT_ID,
      notificationIntent.communicationId,
      notificationIntent.correlationId,
      DEMO_SHOWCASE_TIMESTAMP,
      DEMO_EVENT_ID,
      notificationIntent.communicationId,
      notificationIntent.correlationId,
    ),
    env.DB.prepare(
      `UPDATE submissions
          SET status = 'waitlisted', revision = 3,
              last_operation_id = ?, updated_at = ?
        WHERE id = ? AND event_id = ?`,
    ).bind(
      DEMO_SHOWCASE_DECISION_ID,
      DEMO_SHOWCASE_TIMESTAMP,
      DEMO_SHOWCASE_SUBMISSION_ID,
      DEMO_EVENT_ID,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO speaker_profile_revisions (
         id, organisation_id, event_id, person_id, source, profile_revision,
         display_name, biography, pronunciation, organisation_name, job_title,
         publication_status, headshot_file_version_id, recorded_by_person_id,
         correlation_id, created_at
       ) VALUES (?, ?, ?, ?, 'canonical_person', 1, 'Priya Shah', ?,
                 'PREE-yah SHAH', 'EventLab', 'Director of Experience Design',
                 'published', NULL, ?, 'demo-showcase:profile-revision', ?)`,
    ).bind(
      DEMO_SHOWCASE_PROFILE_REVISION_ID,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.speaker.personId,
      "Priya helps event teams design useful, inclusive technology experiences.",
      DEMO_IDENTITIES.owner.personId,
      DEMO_SHOWCASE_TIMESTAMP - 1_000,
    ),
    env.DB.prepare(
      `UPDATE people
          SET profile_revision = 2, updated_at = ?
        WHERE id = ? AND profile_status = 'published'`,
    ).bind(DEMO_SHOWCASE_TIMESTAMP - 900, DEMO_IDENTITIES.speaker.personId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO programme_embeds (
         id, event_id, organisation_id, name, slug, status,
         configuration_json, installation_note, revision,
         created_by_person_id, updated_by_person_id, created_at, updated_at
       ) VALUES (?, ?, ?, 'Main website agenda', 'main-agenda', 'active', ?, ?, 2,
                 ?, ?, ?, ?)`,
    ).bind(
      DEMO_SHOWCASE_EMBED_ID,
      DEMO_EVENT_ID,
      DEMO_ORGANISATION_ID,
      JSON.stringify(DEMO_SHOWCASE_EMBED_CONFIGURATION),
      "Primary schedule embed for the conference website agenda page.",
      DEMO_IDENTITIES.owner.personId,
      DEMO_IDENTITIES.owner.personId,
      DEMO_SHOWCASE_TIMESTAMP - 700,
      DEMO_SHOWCASE_TIMESTAMP - 650,
    ),
    ...[
      {
        id: "audit-demo-showcase-review-positive",
        actor: DEMO_IDENTITIES.evaluator.personId,
        action: "review.submitted",
        table: "reviews",
        entityType: "review",
        entityId: DEMO_SHOWCASE_POSITIVE_REVIEW_ID,
        metadata: { revision: 1 },
        timestamp: DEMO_SHOWCASE_TIMESTAMP - 300,
      },
      {
        id: "audit-demo-showcase-review-critical",
        actor: DEMO_IDENTITIES.committee_chair.personId,
        action: "review.submitted",
        table: "reviews",
        entityType: "review",
        entityId: DEMO_SHOWCASE_CRITICAL_REVIEW_ID,
        metadata: { revision: 1 },
        timestamp: DEMO_SHOWCASE_TIMESTAMP - 200,
      },
      {
        id: "audit-demo-showcase-discussion",
        actor: DEMO_IDENTITIES.committee_chair.personId,
        action: "evaluation.discussion.message.added",
        table: "evaluation_discussion_messages",
        entityType: "evaluation_discussion_message",
        entityId: DEMO_SHOWCASE_DISCUSSION_ID,
        metadata: {
          roundId: DEMO_SHOWCASE_ROUND_ID,
          targetType: "submission",
          targetId: DEMO_SHOWCASE_SUBMISSION_ID,
        },
        timestamp: DEMO_SHOWCASE_TIMESTAMP - 100,
      },
      {
        id: "audit-demo-showcase-profile-revision",
        actor: DEMO_IDENTITIES.owner.personId,
        action: "speaker.admin.profile.updated",
        table: "people",
        entityType: "person",
        entityId: DEMO_IDENTITIES.speaker.personId,
        metadata: { profileStatus: "published", revision: 2 },
        timestamp: DEMO_SHOWCASE_TIMESTAMP - 900,
      },
      {
        id: "audit-demo-showcase-embed-created",
        actor: DEMO_IDENTITIES.owner.personId,
        action: "programme_embed.created",
        table: "programme_embeds",
        entityType: "programme_embed",
        entityId: DEMO_SHOWCASE_EMBED_ID,
        metadata: { status: "draft", revision: 1 },
        timestamp: DEMO_SHOWCASE_TIMESTAMP - 700,
      },
      {
        id: "audit-demo-showcase-embed-activated",
        actor: DEMO_IDENTITIES.owner.personId,
        action: "programme_embed.activated",
        table: "programme_embeds",
        entityType: "programme_embed",
        entityId: DEMO_SHOWCASE_EMBED_ID,
        metadata: { status: "active", revision: 2 },
        timestamp: DEMO_SHOWCASE_TIMESTAMP - 650,
      },
    ].map((audit) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id,
           actor_person_id, action, entity_type, entity_id, metadata_json,
           created_at
         )
         SELECT ?, 'person', 'internal', 1, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM ${audit.table} entity WHERE entity.id = ?)`,
      ).bind(
        audit.id,
        DEMO_ORGANISATION_ID,
        DEMO_EVENT_ID,
        audit.actor,
        audit.action,
        audit.entityType,
        audit.entityId,
        JSON.stringify(audit.metadata),
        audit.timestamp,
        audit.entityId,
      ),
    ),
    env.DB.prepare(
      `INSERT INTO audit_events (
         id, actor_kind, origin, metadata_version, organisation_id, event_id,
         actor_person_id, action, entity_type, entity_id, metadata_json,
         created_at
       ) SELECT 'audit-demo-showcase-decision', 'person', 'internal', 1,
                ?, ?, ?, 'decision.published', 'submission_decision', ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM submission_decisions decision
             WHERE decision.id = ? AND decision.event_id = ?
               AND decision.status = 'published'
               AND decision.notification_operation_id = ?
          )
            AND NOT EXISTS (
              SELECT 1 FROM audit_events existing
               WHERE existing.id = 'audit-demo-showcase-decision'
            )`,
    ).bind(
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.owner.personId,
      DEMO_SHOWCASE_DECISION_ID,
      JSON.stringify({
        decision: "waitlisted",
        notificationOperationId: notificationIntent.operationId,
        demonstrationOnly: true,
      }),
      DEMO_SHOWCASE_TIMESTAMP,
      DEMO_SHOWCASE_DECISION_ID,
      DEMO_EVENT_ID,
      notificationIntent.operationId,
    ),
    env.DB.prepare(
      `UPDATE communication_deliveries
          SET status = 'cancelled',
              failure_code = 'DEMO_FIXTURE_NOT_DISPATCHED',
              failure_message =
                'Demonstration fixture only; no provider request was made.',
              updated_at = ?
        WHERE id = ? AND event_id = ? AND communication_id = ?
          AND status = 'queued'
          AND EXISTS (
            SELECT 1 FROM audit_events audit
             WHERE audit.id = 'audit-demo-showcase-decision'
               AND audit.action = 'decision.published'
          )`,
    ).bind(
      DEMO_SHOWCASE_TIMESTAMP,
      notificationIntent.deliveryId,
      DEMO_EVENT_ID,
      notificationIntent.communicationId,
    ),
    env.DB.prepare(
      `UPDATE operation_items
          SET status = 'skipped', error_code = 'DEMO_FIXTURE_NOT_DISPATCHED',
              error_message =
                'Demonstration fixture only; no provider request was made.',
              completed_at = ?, updated_at = ?
        WHERE id = ? AND operation_id = ? AND status = 'pending'
          AND EXISTS (
            SELECT 1 FROM communication_deliveries delivery
             WHERE delivery.id = operation_items.entity_id
               AND delivery.status = 'cancelled'
          )`,
    ).bind(
      DEMO_SHOWCASE_TIMESTAMP,
      DEMO_SHOWCASE_TIMESTAMP,
      notificationIntent.operationItemId,
      notificationIntent.operationId,
    ),
    env.DB.prepare(
      `UPDATE communications
          SET status = 'cancelled', cancelled_at = ?, updated_at = ?
        WHERE id = ? AND event_id = ? AND operation_id = ?
          AND status = 'queued'
          AND EXISTS (
            SELECT 1 FROM communication_deliveries delivery
             WHERE delivery.communication_id = communications.id
               AND delivery.status = 'cancelled'
          )`,
    ).bind(
      DEMO_SHOWCASE_TIMESTAMP,
      DEMO_SHOWCASE_TIMESTAMP,
      notificationIntent.communicationId,
      DEMO_EVENT_ID,
      notificationIntent.operationId,
    ),
    env.DB.prepare(
      `UPDATE operation_jobs
          SET status = 'cancelled', completed_at = ?, updated_at = ?
        WHERE id = ? AND event_id = ? AND organisation_id = ?
          AND type = 'decision.notification' AND status = 'queued'
          AND EXISTS (
            SELECT 1 FROM communications communication
             WHERE communication.operation_id = operation_jobs.id
               AND communication.status = 'cancelled'
          )`,
    ).bind(
      DEMO_SHOWCASE_TIMESTAMP,
      DEMO_SHOWCASE_TIMESTAMP,
      notificationIntent.operationId,
      DEMO_EVENT_ID,
      DEMO_ORGANISATION_ID,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO audit_events (
         id, actor_kind, origin, metadata_version, organisation_id, event_id,
         action, entity_type, entity_id, correlation_id, metadata_json,
         created_at
       ) SELECT 'decision-notification-demo-not-dispatched:' || ?,
                'system', 'internal', 1, ?, ?,
                'decision.notification.demo_not_dispatched', 'communication',
                ?, ?, ?, ?
          WHERE EXISTS (
            SELECT 1 FROM operation_jobs operation
             WHERE operation.id = ? AND operation.event_id = ?
               AND operation.status = 'cancelled'
          )`,
    ).bind(
      notificationIntent.operationId,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      notificationIntent.communicationId,
      notificationIntent.operationId,
      JSON.stringify({
        decisionId: DEMO_SHOWCASE_DECISION_ID,
        reason: "demonstration fixture; no provider request was made",
      }),
      DEMO_SHOWCASE_TIMESTAMP,
      notificationIntent.operationId,
      DEMO_EVENT_ID,
    ),
    env.DB.prepare(
      `INSERT INTO people (id, email, display_name, profile_status)
       SELECT 'demo-showcase-incomplete-sentinel', NULL, 'Invalid fixture', 'draft'
        WHERE (SELECT COUNT(*) FROM reviews
                WHERE id IN (?, ?) AND event_id = ? AND status = 'submitted') <> 2
           OR NOT EXISTS (
                SELECT 1 FROM evaluator_assignments
                 WHERE id = ? AND event_id = ? AND round_id = ?
                   AND submission_id = ? AND evaluator_person_id = ?
                   AND status = 'submitted' AND revision = 2
                   AND last_operation_id = 'demo-showcase:critical-review'
              )
           OR (SELECT COUNT(*)
                 FROM review_revisions revision
                 JOIN reviews review
                   ON review.id = revision.review_id
                  AND review.event_id = revision.event_id
                WHERE revision.review_id IN (?, ?) AND revision.event_id = ?
                  AND revision.save_kind = 'submitted'
                  AND json_array_length(revision.criteria_snapshot_json) = 4
                  AND revision.scores_json = review.scores_json
                  AND json_extract(revision.content_json, '$.recommendation') = review.recommendation) <> 2
           OR NOT EXISTS (
                SELECT 1 FROM evaluation_discussion_messages WHERE id = ? AND event_id = ?
              )
           OR NOT EXISTS (
                SELECT 1 FROM submission_decisions
                 WHERE id = ? AND event_id = ? AND status = 'published'
              )
           OR NOT EXISTS (
                SELECT 1 FROM speaker_profile_revisions WHERE id = ? AND event_id = ?
              )
           OR NOT EXISTS (
                SELECT 1 FROM programme_embeds
                 WHERE id = ? AND event_id = ? AND status = 'active'
              )
           OR (SELECT COUNT(*) FROM audit_events
                WHERE id IN (
                  'audit-demo-showcase-review-positive',
                  'audit-demo-showcase-review-critical',
                  'audit-demo-showcase-discussion',
                  'audit-demo-showcase-decision',
                  'audit-demo-showcase-profile-revision',
                  'audit-demo-showcase-embed-created',
                  'audit-demo-showcase-embed-activated'
                ) AND event_id = ?) <> 7`,
    ).bind(
      DEMO_SHOWCASE_POSITIVE_REVIEW_ID,
      DEMO_SHOWCASE_CRITICAL_REVIEW_ID,
      DEMO_EVENT_ID,
      DEMO_SHOWCASE_CHAIR_ASSIGNMENT_ID,
      DEMO_EVENT_ID,
      DEMO_SHOWCASE_ROUND_ID,
      DEMO_SHOWCASE_SUBMISSION_ID,
      DEMO_IDENTITIES.committee_chair.personId,
      DEMO_SHOWCASE_POSITIVE_REVIEW_ID,
      DEMO_SHOWCASE_CRITICAL_REVIEW_ID,
      DEMO_EVENT_ID,
      DEMO_SHOWCASE_DISCUSSION_ID,
      DEMO_EVENT_ID,
      DEMO_SHOWCASE_DECISION_ID,
      DEMO_EVENT_ID,
      DEMO_SHOWCASE_PROFILE_REVISION_ID,
      DEMO_EVENT_ID,
      DEMO_SHOWCASE_EMBED_ID,
      DEMO_EVENT_ID,
      DEMO_EVENT_ID,
    ),
  ]);
}
