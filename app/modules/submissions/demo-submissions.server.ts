import type { Viewer } from "~/platform/auth/authorize.server";
import { DEMO_IDENTITY, ensureDemoData } from "~/platform/demo/seed.server";
import { SubmissionService } from "./submission-service.server";

const DEMO_VIEWER: Viewer = {
  ...DEMO_IDENTITY,
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};
const DEMO_TIMESTAMP = Math.floor(Date.parse("2025-05-01T12:00:00Z") / 1_000);

export async function ensureDemoSubmissionForm(env: CloudflareEnvironment) {
  if (String(env.DEMO_MODE) !== "true") return;
  await ensureDemoData(env);
  const existing = await env.DB.prepare(
    "SELECT id FROM form_definitions WHERE event_id = ? AND public_slug = 'form' LIMIT 1",
  )
    .bind(DEMO_VIEWER.eventId)
    .first<{ id: string }>();
  if (existing) return;

  const service = new SubmissionService(env);
  const input = service.defaultFormInput("email_verified");
  const formId = await service.saveForm(DEMO_VIEWER, {
    ...input,
    publicSlug: "form",
  });
  const workspace = await service.getAdminWorkspace(DEMO_VIEWER, formId);
  if (!workspace) throw new Error("The demo submission form was not created.");
  await service.publishForm(
    DEMO_VIEWER,
    formId,
    workspace.revision,
    workspace.draftVersion.revision,
  );

  await env.DB.batch([
    env.DB.prepare(
      `
      UPDATE form_definitions SET created_at = ?, updated_at = ?
       WHERE id = ? AND event_id = ? AND public_slug = 'form'
    `,
    ).bind(DEMO_TIMESTAMP, DEMO_TIMESTAMP, formId, DEMO_VIEWER.eventId),
    env.DB.prepare(
      `
      UPDATE form_versions SET created_at = ?, updated_at = ?,
             published_at = CASE WHEN status = 'published' THEN ? ELSE published_at END
       WHERE form_id = ? AND event_id = ?
    `,
    ).bind(
      DEMO_TIMESTAMP,
      DEMO_TIMESTAMP,
      DEMO_TIMESTAMP,
      formId,
      DEMO_VIEWER.eventId,
    ),
  ]);
}
