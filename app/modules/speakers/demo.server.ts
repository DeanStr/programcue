import {
  requireEventRole,
  type Viewer,
} from "~/platform/auth/authorize.server";
import { DEMO_IDENTITIES, ensureDemoData } from "~/platform/demo/seed.server";

const EVENT_ID = "evt-foe-2025";
const DEMO_ORGANISATION_ID = "org-future-events";
const SPEAKER_ID = "person-demo-speaker";
const ADMIN_ID = "person-demo-admin";

const handbookDocument = {
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "Before the event" }],
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Publish your speaker profile and confirm pronunciation details.",
                },
              ],
            },
          ],
        },
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Upload slides in PDF or PPTX format before the due date.",
                },
              ],
            },
          ],
        },
        {
          type: "listItem",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "Review your room, arrival time and A/V requirements.",
                },
              ],
            },
          ],
        },
      ],
    },
    {
      type: "heading",
      attrs: { level: 2 },
      content: [{ type: "text", text: "On-site arrival" }],
    },
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "Arrive at speaker check-in 45 minutes before your session and bring your event badge.",
        },
      ],
    },
  ],
};

export async function ensureDemoSpeakerData(env: CloudflareEnvironment) {
  if (String(env.DEMO_MODE) !== "true") return;
  await ensureDemoData(env);
  await env.DB.batch([
    env.DB.prepare(
      `
      UPDATE people
         SET biography = COALESCE(biography, 'Priya helps event teams design useful, inclusive technology experiences.'),
             pronunciation = COALESCE(pronunciation, 'PREE-yah SHAH'),
             organisation_name = COALESCE(organisation_name, 'EventLab'),
             job_title = COALESCE(job_title, 'Director of Experience Design')
       WHERE id = ?
    `,
    ).bind(SPEAKER_ID),
    env.DB.prepare(
      `
      INSERT OR IGNORE INTO sessions (
        id, event_id, title, slug, description, format, duration_minutes, status, visibility, created_at, updated_at
      ) VALUES (
        'session-demo-speaker', ?, 'Designing inclusive event technology', 'designing-inclusive-event-technology',
        'Practical patterns for accessible, calm and effective attendee experiences.', 'presentation', 45,
        'scheduled', 'public', unixepoch(), unixepoch()
      )
    `,
    ).bind(EVENT_ID),
    env.DB.prepare(
      `
      INSERT OR IGNORE INTO session_speakers (session_id, event_id, person_id, position, role_label, visibility)
      VALUES ('session-demo-speaker', ?, ?, 0, 'Speaker', 'public')
    `,
    ).bind(EVENT_ID, SPEAKER_ID),
    env.DB.prepare(
      `
      INSERT OR IGNORE INTO task_templates (
        id, event_id, name, description, target_type, task_type, impact, evidence_mode,
        due_anchor, due_offset_minutes, configuration_json, status, created_at, updated_at
      ) VALUES (
        'task-template-profile', ?, 'Complete your speaker profile', 'Confirm your biography, role and pronunciation.',
        'speaker', 'short_form', 'high', 'checkbox', 'none', NULL, '{}', 'active', unixepoch(), unixepoch()
      )
    `,
    ).bind(EVENT_ID),
    env.DB.prepare(
      `
      INSERT OR IGNORE INTO task_templates (
        id, event_id, name, description, target_type, task_type, impact, evidence_mode,
        due_anchor, due_offset_minutes, configuration_json, status, created_at, updated_at
      ) VALUES (
        'task-template-slides', ?, 'Upload presentation slides', 'Upload the final PDF, PPT or PPTX deck.',
        'speaker', 'file_upload', 'critical', 'file', 'fixed', NULL, '{}', 'active', unixepoch(), unixepoch()
      )
    `,
    ).bind(EVENT_ID),
    env.DB.prepare(
      `
      INSERT OR IGNORE INTO task_templates (
        id, event_id, name, description, target_type, task_type, impact, evidence_mode,
        due_anchor, due_offset_minutes, configuration_json, status, created_at, updated_at
      ) VALUES (
        'task-template-handbook', ?, 'Read the speaker handbook', 'Read and acknowledge the current handbook.',
        'speaker', 'acknowledgement', 'medium', 'checkbox', 'none', NULL,
        '{"resourcePageId":"resource-speaker-handbook"}', 'active', unixepoch(), unixepoch()
      )
    `,
    ).bind(EVENT_ID),
    env.DB.prepare(`
      INSERT OR IGNORE INTO task_template_dependencies (template_id, depends_on_template_id, created_at)
      VALUES ('task-template-slides', 'task-template-profile', unixepoch())
    `),
    env.DB.prepare(
      `
      INSERT OR IGNORE INTO task_instances (
        id, event_id, template_id, target_type, target_id, owner_person_id, title, description,
        task_type, impact, status, readiness_state, readiness_percent, revision, due_at,
        evidence_json, completed_at, completed_by_person_id, created_at, updated_at
      ) VALUES (
        'task-demo-profile', ?, 'task-template-profile', 'speaker', ?, ?, 'Complete your speaker profile',
        'Confirm your biography, role and pronunciation.', 'short_form', 'high', 'completed', 'on_track', 100, 1,
        unixepoch('2025-05-10T16:00:00Z'), '{"confirmed":true}', unixepoch(), ?, unixepoch(), unixepoch()
      )
    `,
    ).bind(EVENT_ID, SPEAKER_ID, SPEAKER_ID, SPEAKER_ID),
    env.DB.prepare(
      `
      INSERT OR IGNORE INTO task_instances (
        id, event_id, template_id, target_type, target_id, owner_person_id, title, description,
        task_type, impact, status, readiness_state, readiness_percent, revision, due_at, created_at, updated_at
      ) VALUES (
        'task-demo-slides', ?, 'task-template-slides', 'speaker', ?, ?, 'Upload presentation slides',
        'Upload the final PDF, PPT or PPTX deck.', 'file_upload', 'critical', 'not_started', 'at_risk', 0, 1,
        unixepoch('2025-05-16T16:00:00Z'), unixepoch(), unixepoch()
      )
    `,
    ).bind(EVENT_ID, SPEAKER_ID, SPEAKER_ID),
    env.DB.prepare(`
      INSERT OR IGNORE INTO task_instance_dependencies (task_id, depends_on_task_id, created_at)
      VALUES ('task-demo-slides', 'task-demo-profile', unixepoch())
    `),
    env.DB.prepare(
      `
      INSERT OR IGNORE INTO resource_pages (
        id, event_id, title, slug, category, status, audience_scope, acknowledgement_required,
        revision, created_by_person_id, created_at, updated_at
      ) VALUES (
        'resource-speaker-handbook', ?, 'Speaker handbook', 'speaker-handbook', 'Getting ready',
        'published', 'all_speakers', 1, 1, ?,
        unixepoch('2025-05-01T12:00:00Z'), unixepoch('2025-05-01T12:00:00Z')
      )
    `,
    ).bind(EVENT_ID, ADMIN_ID),
    env.DB.prepare(
      `
      INSERT OR IGNORE INTO resource_page_versions (
        id, event_id, resource_page_id, version_number, title, slug, category,
        audience_scope, acknowledgement_required, document_json, rendered_html, status,
        created_by_person_id, created_at, published_at
      ) VALUES (
        'resource-version-handbook-1', ?, 'resource-speaker-handbook', 1,
        'Speaker handbook', 'speaker-handbook', 'Getting ready', 'all_speakers', 1, ?,
        '<h2>Before the event</h2><ul><li>Publish your speaker profile and confirm pronunciation details.</li><li>Upload slides in PDF or PPTX format before the due date.</li><li>Review your room, arrival time and A/V requirements.</li></ul><h2>On-site arrival</h2><p>Arrive at speaker check-in 45 minutes before your session and bring your event badge.</p>',
        'published', ?, unixepoch('2025-05-01T12:00:00Z'), unixepoch('2025-05-01T12:00:00Z')
      )
    `,
    ).bind(EVENT_ID, JSON.stringify(handbookDocument), ADMIN_ID),
    env.DB.prepare(
      `
      INSERT OR IGNORE INTO task_instances (
        id, event_id, template_id, target_type, target_id, owner_person_id, title, description,
        task_type, impact, status, readiness_state, readiness_percent, revision, created_at, updated_at
      ) VALUES (
        'task-demo-handbook', ?, 'task-template-handbook', 'speaker', ?, ?, 'Read the speaker handbook',
        'Read and acknowledge the current handbook.', 'acknowledgement', 'medium', 'not_started', 'on_track', 0, 1,
        unixepoch(), unixepoch()
      )
    `,
    ).bind(EVENT_ID, SPEAKER_ID, SPEAKER_ID),
  ]);
}

export async function requireSpeakerViewer(
  request: Request,
  env: CloudflareEnvironment,
  eventId: string,
): Promise<Viewer> {
  if (String(env.DEMO_MODE) === "true") {
    const cookie = request.headers.get("cookie") ?? "";
    const selected = cookie.match(
      /(?:^|;\s*)program_cue_demo_role=([^;]+)/,
    )?.[1];
    if (!selected || selected === "speaker") {
      const identity = DEMO_IDENTITIES.speaker;
      return {
        ...identity,
        role: "speaker",
        organisationId: DEMO_ORGANISATION_ID,
        eventId,
        demo: true,
      };
    }
  }
  return requireEventRole(request, env, eventId, ["speaker"]);
}
