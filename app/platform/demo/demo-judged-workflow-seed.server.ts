import { requireEmailProviderConfiguration } from "~/modules/communications/email-provider.server";
import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import { ensureDemoSubmissionForm } from "~/modules/submissions/demo-submissions.server";
import {
  DEMO_EVENT_ID,
  DEMO_IDENTITIES,
} from "~/platform/demo/demo-identities";
import {
  DEMO_COMMUNICATION_TEMPLATE_TIMESTAMP,
  DEMO_DECISION_SENDER_ID,
  DEMO_DECISION_TEMPLATE_ID,
  DEMO_DECISION_VERSION_ID,
  DEMO_PARTICIPANT_REMINDER_TEMPLATE_ID,
  DEMO_PARTICIPANT_REMINDER_VERSION_ID,
  DEMO_REMINDER_TEMPLATE_ID,
  DEMO_REMINDER_VERSION_ID,
  DEMO_REVIEWER_REMINDER_TEMPLATE_ID,
  DEMO_REVIEWER_REMINDER_VERSION_ID,
  DEMO_SPEAKER_WELCOME_TEMPLATE_ID,
  DEMO_SPEAKER_WELCOME_VERSION_ID,
  DEMO_SUBMISSION_CONFIRMATION_TEMPLATE_ID,
  DEMO_SUBMISSION_CONFIRMATION_VERSION_ID,
} from "~/platform/demo/demo-reset-fixtures";
import { seedShowcaseCohort } from "~/platform/demo/demo-showcase-cohort-seed.server";
import {
  ensureDemoData,
  ensureDemoProgramme,
} from "~/platform/demo/seed.server";

export async function seedJudgedDemoWorkflow(env: CloudflareEnvironment) {
  const emailProvider = requireEmailProviderConfiguration(env);
  await ensureDemoData(env);
  await ensureDemoSubmissionForm(env);
  await ensureDemoEvaluationData(env);
  await ensureDemoSpeakerData(env);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO sender_profiles (
         id, event_id, name, from_name, from_email, reply_to_email,
         provider, status, created_at, updated_at
       ) VALUES (?, ?, 'Demo decision notifications', 'Program Cue Demo',
                 'notifications@example.invalid', 'notifications@example.invalid',
                 ?, 'verified', unixepoch(), unixepoch())`,
    ).bind(DEMO_DECISION_SENDER_ID, DEMO_EVENT_ID, emailProvider.provider),
    env.DB.prepare(
      `INSERT OR IGNORE INTO communication_templates (
         id, event_id, name, category, status, created_by_person_id,
         created_at, updated_at
       ) VALUES (?, ?, 'Speaker task reminder', 'task_reminder', 'active', ?,
                 ?, ?)`,
    ).bind(
      DEMO_REMINDER_TEMPLATE_ID,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.administrator.personId,
      DEMO_COMMUNICATION_TEMPLATE_TIMESTAMP,
      DEMO_COMMUNICATION_TEMPLATE_TIMESTAMP + 1,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO communication_template_versions (
         id, event_id, template_id, version_number, name, category, channel,
         subject_template, content_json, rendered_preview_html, status,
         created_by_person_id, created_at, published_at
       ) VALUES (
         ?, ?, ?, 1, 'Speaker task reminder', 'task_reminder', 'email',
         'Reminder: {{task.title}} is due {{task.dueDate}}', ?, NULL, 'published', ?,
         unixepoch(), unixepoch()
       )`,
    ).bind(
      DEMO_REMINDER_VERSION_ID,
      DEMO_EVENT_ID,
      DEMO_REMINDER_TEMPLATE_ID,
      JSON.stringify({
        body: "Hi {{recipient.firstName}},\n\nPlease complete {{task.title}} for {{event.name}} by {{task.dueDate}}.",
        physicalAddress: "255 Front Street West, Toronto, ON",
      }),
      DEMO_IDENTITIES.administrator.personId,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO communication_templates (
         id, event_id, name, category, status, created_by_person_id,
         created_at, updated_at
       ) VALUES (?, ?, 'Participant action reminder', 'task_reminder', 'active', ?,
                 ?, ?)`,
    ).bind(
      DEMO_PARTICIPANT_REMINDER_TEMPLATE_ID,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.administrator.personId,
      DEMO_COMMUNICATION_TEMPLATE_TIMESTAMP,
      DEMO_COMMUNICATION_TEMPLATE_TIMESTAMP + 3,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO communication_template_versions (
         id, event_id, template_id, version_number, name, category, channel,
         subject_template, content_json, rendered_preview_html, status,
         created_by_person_id, created_at, published_at
       ) VALUES (
         ?, ?, ?, 1, 'Participant action reminder', 'task_reminder', 'email',
         'Action needed for {{event.name}}', ?, NULL, 'published', ?,
         unixepoch(), unixepoch()
       )`,
    ).bind(
      DEMO_PARTICIPANT_REMINDER_VERSION_ID,
      DEMO_EVENT_ID,
      DEMO_PARTICIPANT_REMINDER_TEMPLATE_ID,
      JSON.stringify({
        body: "Hi {{recipient.firstName}},\n\nYou have an action waiting for you in {{event.name}}. Please return to your participant workspace to complete it.",
        physicalAddress: "255 Front Street West, Toronto, ON",
      }),
      DEMO_IDENTITIES.administrator.personId,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO communication_templates (
         id, event_id, name, category, status, created_by_person_id,
         created_at, updated_at
       ) VALUES (?, ?, 'Reviewer reminder', 'ad_hoc', 'active', ?,
                 ?, ?)`,
    ).bind(
      DEMO_REVIEWER_REMINDER_TEMPLATE_ID,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.administrator.personId,
      DEMO_COMMUNICATION_TEMPLATE_TIMESTAMP,
      DEMO_COMMUNICATION_TEMPLATE_TIMESTAMP,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO communication_template_versions (
         id, event_id, template_id, version_number, name, category, channel,
         subject_template, content_json, rendered_preview_html, status,
         created_by_person_id, created_at, published_at
       ) VALUES (
         ?, ?, ?, 1, 'Reviewer reminder', 'ad_hoc', 'email',
         'Reviews awaiting your attention for {{event.name}}', ?, NULL,
         'published', ?, unixepoch(), unixepoch()
       )`,
    ).bind(
      DEMO_REVIEWER_REMINDER_VERSION_ID,
      DEMO_EVENT_ID,
      DEMO_REVIEWER_REMINDER_TEMPLATE_ID,
      JSON.stringify({
        body: "Hi {{recipient.firstName}},\n\nYou have outstanding review assignments for {{event.name}}. Please return to your reviewer workspace to complete them.",
        physicalAddress: "255 Front Street West, Toronto, ON",
      }),
      DEMO_IDENTITIES.administrator.personId,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO communication_templates (
         id, event_id, name, category, status, created_by_person_id,
         created_at, updated_at
       ) VALUES (?, ?, 'Speaker welcome', 'ad_hoc', 'active', ?, ?, ?)`,
    ).bind(
      DEMO_SPEAKER_WELCOME_TEMPLATE_ID,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.administrator.personId,
      DEMO_COMMUNICATION_TEMPLATE_TIMESTAMP,
      DEMO_COMMUNICATION_TEMPLATE_TIMESTAMP + 2,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO communication_template_versions (
         id, event_id, template_id, version_number, name, category, channel,
         subject_template, content_json, rendered_preview_html, status,
         created_by_person_id, created_at, published_at
       ) VALUES (
         ?, ?, ?, 1, 'Speaker welcome', 'ad_hoc', 'email',
         'Welcome to {{event.name}} speakers', ?, NULL, 'published', ?,
         unixepoch(), unixepoch()
       )`,
    ).bind(
      DEMO_SPEAKER_WELCOME_VERSION_ID,
      DEMO_EVENT_ID,
      DEMO_SPEAKER_WELCOME_TEMPLATE_ID,
      JSON.stringify({
        body: "Hi {{recipient.firstName}},\n\nWelcome to {{event.name}}. Your speaker workspace is ready.",
        physicalAddress: "255 Front Street West, Toronto, ON",
      }),
      DEMO_IDENTITIES.administrator.personId,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO communication_templates (
         id, event_id, name, category, status, created_by_person_id,
         created_at, updated_at
       ) VALUES (?, ?, 'Submission confirmation', 'submission_confirmation',
                 'active', ?, ?, ?)`,
    ).bind(
      DEMO_SUBMISSION_CONFIRMATION_TEMPLATE_ID,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.administrator.personId,
      DEMO_COMMUNICATION_TEMPLATE_TIMESTAMP,
      DEMO_COMMUNICATION_TEMPLATE_TIMESTAMP,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO communication_template_versions (
         id, event_id, template_id, version_number, name, category, channel,
         subject_template, content_json, rendered_preview_html, status,
         created_by_person_id, created_at, published_at
       ) VALUES (
         ?, ?, ?, 1, 'Submission confirmation', 'submission_confirmation',
         'email', 'We received {{submission.title}}', ?, NULL, 'published', ?,
         unixepoch(), unixepoch()
       )`,
    ).bind(
      DEMO_SUBMISSION_CONFIRMATION_VERSION_ID,
      DEMO_EVENT_ID,
      DEMO_SUBMISSION_CONFIRMATION_TEMPLATE_ID,
      JSON.stringify({
        body: "Hi {{recipient.firstName}},\n\nWe received {{submission.title}} for {{event.name}}. You can return to your application workspace at any time to review its status.",
        physicalAddress: "255 Front Street West, Toronto, ON",
      }),
      DEMO_IDENTITIES.administrator.personId,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO communication_templates (
         id, event_id, name, category, status, created_by_person_id,
         created_at, updated_at
       ) VALUES (?, ?, 'Proposal decision', 'decision', 'active', ?, ?, ?)`,
    ).bind(
      DEMO_DECISION_TEMPLATE_ID,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.administrator.personId,
      DEMO_COMMUNICATION_TEMPLATE_TIMESTAMP,
      DEMO_COMMUNICATION_TEMPLATE_TIMESTAMP,
    ),
    env.DB.prepare(
      `INSERT OR IGNORE INTO communication_template_versions (
         id, event_id, template_id, version_number, name, category, channel,
         subject_template, content_json, rendered_preview_html, status,
         created_by_person_id, created_at, published_at
       ) VALUES (
         ?, ?, ?, 1, 'Proposal decision', 'decision', 'email',
         'Decision for {{submission.title}}', ?, NULL, 'published', ?,
         unixepoch(), unixepoch()
       )`,
    ).bind(
      DEMO_DECISION_VERSION_ID,
      DEMO_EVENT_ID,
      DEMO_DECISION_TEMPLATE_ID,
      JSON.stringify({
        body: "Hi {{recipient.firstName}},\n\nThe decision for {{submission.title}} is {{decision.outcome}}.\n\n{{decision.rationale}}\n\n{{decision.feedback}}",
        physicalAddress: "255 Front Street West, Toronto, ON",
      }),
      DEMO_IDENTITIES.administrator.personId,
    ),
  ]);
  await ensureDemoProgramme(env);
  await seedShowcaseCohort(env);
}
