export async function ensureEvaluationDecisionTemplateFixture(
  database: D1Database,
  eventId: string,
  personId: string,
) {
  await database.batch([
    database
      .prepare(
        `INSERT OR IGNORE INTO sender_profiles (
           id, event_id, name, from_name, from_email, provider, status,
           created_at, updated_at
         ) VALUES (?, ?, 'Evaluation test decision sender', 'Program Cue',
                   'decisions@example.com', 'resend', 'verified',
                   unixepoch(), unixepoch())`,
      )
      .bind(`evaluation-test-decision-sender:${eventId}`, eventId),
    database
      .prepare(
        `INSERT OR IGNORE INTO communication_templates (
           id, event_id, name, category, status, created_by_person_id,
           created_at, updated_at
         ) VALUES ('evaluation-test-decision-template', ?,
                   'Evaluation decision', 'decision', 'active', ?,
                   unixepoch(), unixepoch())`,
      )
      .bind(eventId, personId),
    database
      .prepare(
        `INSERT OR IGNORE INTO communication_template_versions (
           id, event_id, template_id, version_number, name, category, channel,
           subject_template, content_json, status, created_by_person_id,
           created_at, published_at
         ) VALUES ('evaluation-test-decision-template-v1', ?,
                   'evaluation-test-decision-template', 1,
                   'Evaluation decision', 'decision', 'email',
                   'Decision for {{submission.title}}', ?, 'published', ?,
                   unixepoch(), unixepoch())`,
      )
      .bind(
        eventId,
        JSON.stringify({
          body: "Hi {{recipient.firstName}}, {{submission.title}} was {{decision.outcome}}. {{decision.rationale}} {{decision.feedback}}",
          physicalAddress: "100 Programme Way, Toronto",
        }),
        personId,
      ),
    database
      .prepare(
        `UPDATE sender_profiles
            SET provider = 'resend', status = 'verified',
                updated_at = unixepoch()
          WHERE id = ? AND event_id = ?`,
      )
      .bind(`evaluation-test-decision-sender:${eventId}`, eventId),
    database
      .prepare(
        `UPDATE communication_templates
            SET status = 'active', category = 'decision',
                updated_at = unixepoch()
          WHERE id = 'evaluation-test-decision-template' AND event_id = ?`,
      )
      .bind(eventId),
    database
      .prepare(
        `UPDATE communication_template_versions
            SET status = 'published', category = 'decision', channel = 'email',
                published_at = COALESCE(published_at, unixepoch())
          WHERE id = 'evaluation-test-decision-template-v1' AND event_id = ?`,
      )
      .bind(eventId),
  ]);
}
